// lib/refundSignature.js — 折讓單客顯預覽＋顧客親簽（客顯 SignaturePad Blob → multipart → 私有儲存；DB 只存 storageKey＋SHA-256）
// B2B 折讓必須簽名才可結案；B2C 選簽。影像禁止公開路徑，列印時以短效 Base64 回傳。
// 客顯所見金額一律來自 buildSignPreview；previewToken（HMAC）綁 requestId＋經辦＋折讓內容摘要，送簽時重算摘要，內容變動即拒收。
import crypto from 'node:crypto';
import sharp from 'sharp';
import prisma from './prisma.js';
import { deleteIdPhotoObject, getIdPhotoObject, putIdPhotoObject } from './idPhotoStorage.js';
import { readToken, signToken } from './signedToken.js';
import { clientIp, clientUserAgent } from './memberDeviceAudit.js';
import { hasPendingYipayTerminal } from './refundRules.js';
import { finalizeRefund, loadRefundForStaff, serializeRefund, withRefundLock, writeAudit } from './refundService.js';

export const MAX_SIGNATURE_BYTES = 512 * 1024;
/** 與客顯 SignaturePad 送出門檻一致；後端另以近黑像素把關，不採信此數字當筆跡證明 */
export const MIN_SIGNATURE_POINTS = 25;
export const MIN_SIGNATURE_STROKES = 1;
/** CSS px；與客顯路徑長度門檻一致 */
export const MIN_SIGNATURE_PATH_PX = 60;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * 近黑才算筆跡（簽名板 #0f172a：通道最大值 < 128 且非偏青）。
 * 深青防偽底欄 #083D4F（綠／藍明显高于紅）與淺色斜向浮水印不計入，空白畫布壓了底欄仍須拒絕。
 */
const INK_THRESHOLD = 128;
const MIN_INK_PIXELS = 120;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const TAX_TYPE_LABEL = { 1: '應稅', 2: '零稅率', 3: '免稅' };
const SIGN_STATEMENT = '本人確認收到上列電子發票銷貨退回／折讓，並同意以本簽名作為折讓證明單之買受人簽收。';

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const PREVIEW_TOKEN_PURPOSE = 'allowance-sign-preview';

function verifyPreviewToken(token) {
  const read = readToken(PREVIEW_TOKEN_PURPOSE, token);
  if (!read) throw httpError(400, 'PREVIEW_TOKEN_INVALID', '簽署憑證無效，請重新推送客顯');
  if (read.expired) throw httpError(409, 'PREVIEW_EXPIRED', '客顯簽署已逾時，請重新推送客顯');
  return read.payload;
}

async function loadSignable(user, refundId) {
  const refund = await loadRefundForStaff(user, refundId);
  if (refund.status === 'ABORTED') throw httpError(409, 'REFUND_NOT_SIGNABLE', '已中止之退費單不可簽名');
  if (hasPendingYipayTerminal(refund.payments)) {
    throw httpError(409, 'YIPAY_TERMINAL_VOUCHER_REQUIRED', '乙禾端末尚未刷退回填 RRN／授權碼，請先完成刷退再請顧客簽署折讓');
  }
  if (refund.signatureId) throw httpError(409, 'SIGNATURE_EXISTS', '此退費單已完成簽名');
  const allowances = await prisma.invoiceAllowance.findMany({
    where: { refundId: refund.id, status: 'ISSUED' },
    include: {
      items: { orderBy: { lineNo: 'asc' } },
      legalEntity: { select: { name: true } },
      einvoice: { select: { issuedAt: true, taxType: true, category: true, buyerUbn: true, buyerName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!allowances.length) throw httpError(409, 'NO_ALLOWANCE', '此退費單尚無已開立之折讓單，無須簽名');
  return { refund, allowances };
}

/**
 * 單次簽署綁定雜湊：折讓單號｜原發票號碼｜該張含稅額（多張以分號串接）。
 * 與 contentDigest 一併寫入 preview；上傳時重算，客顯回傳值不符即拒（防 A 單簽名貼到 B 單）。
 */
export function allowancePayloadHash(allowances) {
  const canon = allowances.map((a) => `${a.allowanceNo}|${a.invoiceNumber}|${a.totalAmt}`).join(';');
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function hashesEqual(claimed, expected) {
  const left = Buffer.from(String(claimed || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (left.length !== 64 || right.length !== 64 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parsePointCount(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_SIGNATURE_POINTS || n > 200_000) {
    throw httpError(400, 'SIGNATURE_REQUIRED', '簽名筆跡不足，請顧客完整親簽');
  }
  return n;
}

/** 客顯申報的筆畫數與路徑長度。空白與否仍以近黑像素為準，此處只擋明顯未簽。 */
function parseStrokeStats(strokeCount, pathLength) {
  const strokes = Number(strokeCount);
  const length = Number(pathLength);
  if (!Number.isInteger(strokes) || strokes < MIN_SIGNATURE_STROKES || strokes > 10_000) {
    throw httpError(400, 'SIGNATURE_STROKE_TOO_SHORT', '消費者親簽筆跡過短或為空白，請重新簽署');
  }
  if (!Number.isFinite(length) || length < MIN_SIGNATURE_PATH_PX || length > 1_000_000) {
    throw httpError(400, 'SIGNATURE_STROKE_TOO_SHORT', '消費者親簽筆跡過短或為空白，請重新簽署');
  }
  return { strokeCount: strokes, pathLength: length };
}

/** 顧客所見內容之摘要（折讓單號、原發票、品項、金額、實退）；任一變動即使 previewToken 失效 */
function contentDigest(refund, allowances) {
  const canon = JSON.stringify({
    r: refund.id,
    p: refund.payoutAmount,
    a: allowances.map((a) => [
      a.id,
      a.allowanceNo,
      a.invoiceNumber,
      a.untaxedAmt,
      a.taxAmt,
      a.totalAmt,
      a.items.map((i) => [i.name, i.qty, i.amount, i.taxAmt]),
    ]),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function toDoc(a) {
  const invoiceNumber = String(a.invoiceNumber || '');
  const category = a.category || a.einvoice?.category || 'B2C';
  const taxType = a.items[0]?.taxType || a.einvoice?.taxType || '1';
  const buyerName = a.buyerName || a.einvoice?.buyerName;
  const buyerUbn = a.buyerUbn || a.einvoice?.buyerUbn;
  const items = a.items.length
    ? a.items.map((it) => ({ name: it.name, qty: it.qty, unit: it.unit, amount: it.amount, taxAmt: it.taxAmt }))
    : [{ name: a.itemDesc || '折讓', qty: 1, unit: '式', amount: a.untaxedAmt, taxAmt: a.taxAmt }];
  return {
    allowanceNo: a.allowanceNo,
    invoiceNumber,
    invoiceTrack: invoiceNumber.slice(0, 2),
    invoiceNo: invoiceNumber.slice(2),
    invoiceDate: (a.invoiceIssuedAt || a.einvoice?.issuedAt || null)?.toISOString?.() ?? null,
    sellerName: a.sellerName || a.legalEntity?.name || '體育客',
    buyerLabel: category === 'B2B' ? `${buyerName || '—'}（${buyerUbn || '—'}）` : null,
    taxTypeLabel: TAX_TYPE_LABEL[taxType] || '應稅',
    items,
    untaxed: a.untaxedAmt,
    tax: a.taxAmt,
    total: a.totalAmt,
  };
}

/**
 * POST /api/ops/refunds/:id/signature-preview — 客顯折讓預覽（金額／稅額全由後端產生）＋previewToken
 * 每次呼叫產生新 requestId；token 10 分鐘有效
 */
export async function buildSignPreview(user, refundId, req = null) {
  const { refund, allowances } = await loadSignable(user, refundId);
  const [branch, member] = await Promise.all([
    refund.branchId != null
      ? prisma.branch.findUnique({ where: { id: refund.branchId }, select: { name: true, code: true } })
      : null,
    refund.memberId != null ? prisma.member.findUnique({ where: { id: refund.memberId }, select: { name: true } }) : null,
  ]);
  const docs = allowances.map(toDoc);
  const digest = contentDigest(refund, allowances);
  const payloadHash = allowancePayloadHash(allowances);
  const requestId = `ASR${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const exp = Date.now() + PREVIEW_TTL_MS;
  const previewToken = signToken(PREVIEW_TOKEN_PURPOSE, { v: 1, rid: refund.id, req: requestId, sid: user.id, dg: digest, exp });
  const wallet = {
    bonusReversed: Math.round(refund.walletBonusReversed || 0),
    cashReversed: Math.round(refund.walletCashReversed || 0),
    cashCredited: Math.round(refund.walletCashCredited || 0),
  };

  await writeAudit(prisma, {
    action: 'REFUND_SIGNATURE_PREVIEW',
    refund,
    user,
    req,
    after: { requestId, digest, payloadHash, allowances: docs.map((d) => d.allowanceNo) },
  }).catch((e) => console.error('客顯簽署預覽稽核寫入失敗:', e.message));

  return {
    requestId,
    previewToken,
    expiresAt: new Date(exp).toISOString(),
    refundId: refund.id,
    subOrderId: refund.refId,
    subOrderType: String(refund.refId || '').slice(0, 3),
    branch: { name: branch?.name || null, code: branch?.code || null },
    memberName: member?.name || null,
    signatureRequired: refund.signatureRequired,
    statement: SIGN_STATEMENT,
    payloadHash,
    docs,
    totals: {
      untaxed: docs.reduce((s, d) => s + d.untaxed, 0),
      tax: docs.reduce((s, d) => s + d.tax, 0),
      total: docs.reduce((s, d) => s + d.total, 0),
    },
    refund: { grossAmount: refund.grossAmount, feeAmount: refund.feeAmount, payoutAmount: refund.payoutAmount },
    wallet: wallet.bonusReversed || wallet.cashReversed || wallet.cashCredited ? wallet : null,
  };
}

/** 近黑筆跡；深青底欄與白字、淺色浮水印回 false */
function isInkPixel(r, g, b) {
  if (Math.max(r, g, b) >= INK_THRESHOLD) return false;
  if (g - r > 25 || b - r > 40) return false;
  return true;
}

/** multipart 上傳之 PNG：magic bytes、大小、尺寸、近黑筆跡（深青防偽底欄不計入） */
export async function validateSignaturePng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'SIGNATURE_REQUIRED', '缺少簽名影像');
  if (buf.length > MAX_SIGNATURE_BYTES) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像過大');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像格式錯誤（須為 PNG）');
  let ink = 0;
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 4096 * 4096 })
      .flatten({ background: '#ffffff' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width < 200 || info.height < 80) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像尺寸過小');
    const channels = info.channels || 3;
    for (let i = 0; i < data.length; i += channels) {
      if (isInkPixel(data[i], data[i + 1], data[i + 2])) ink += 1;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    throw httpError(400, 'SIGNATURE_REQUIRED', '無法解析簽名影像');
  }
  if (ink < MIN_INK_PIXELS) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名為空白，請顧客親簽');
}

/**
 * POST /api/ops/refunds/:id/signature（multipart：previewToken、requestId、signature＝PNG Blob）
 * 驗 token（HMAC／效期／退費單／經辦／requestId）→ 重算內容摘要 → 驗影像 → 私有儲存 → 歸檔；SIGNATURE_PENDING 者簽後自動結案
 */
export async function attachRefundSignature(user, refundId, { previewToken, requestId, payloadHash, pointCount, strokeCount, pathLength, signature } = {}, req = null) {
  const claims = verifyPreviewToken(previewToken);
  const { refund, allowances } = await loadSignable(user, refundId);
  if (claims.rid !== refund.id || claims.sid !== user.id || claims.req !== String(requestId || '')) {
    throw httpError(400, 'PREVIEW_TOKEN_INVALID', '簽署憑證與退費單／經辦不符，請重新推送客顯');
  }
  if (claims.dg !== contentDigest(refund, allowances)) {
    throw httpError(409, 'PREVIEW_STALE', '折讓內容已變動，顧客所簽版本失效，請重新推送客顯');
  }
  if (!payloadHash) throw httpError(400, 'PAYLOAD_HASH_REQUIRED', '缺少折讓簽署摘要，請重新推送客顯');
  if (!hashesEqual(payloadHash, allowancePayloadHash(allowances))) {
    throw httpError(409, 'PAYLOAD_HASH_MISMATCH', '簽名與折讓單號或金額不符，請重新推送客顯');
  }
  parsePointCount(pointCount);
  parseStrokeStats(strokeCount, pathLength);
  await validateSignaturePng(signature);

  const sha256 = crypto.createHash('sha256').update(signature).digest('hex');
  const id = `RSG${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const storageKey = `allowance-signatures/${refund.id}/${id}.png`;
  await putIdPhotoObject(storageKey, signature, 'image/png');

  let committed = false;
  try {
    return await withRefundLock(refund.id, async () => {
      await recordSignature();
      committed = true;
      const fresh = await loadRefundForStaff(user, refund.id);
      if (fresh.status === 'SIGNATURE_PENDING') return serializeRefund(await finalizeRefund(fresh, { user, req }));
      return serializeRefund(fresh);
    });
  } catch (err) {
    // 未歸檔之簽名影像屬無 DB 指向之個資，必須刪除；刪除失敗只記錄，不掩蓋原例外
    if (!committed) {
      await deleteIdPhotoObject(storageKey).catch((e) =>
        console.error(`折讓簽名孤兒檔 ${storageKey} 刪除失敗:`, e.message),
      );
    }
    throw err;
  }

  async function recordSignature() {
    await prisma.$transaction(async (tx) => {
      const ok = await tx.refundRequest.updateMany({
        where: { id: refund.id, signatureId: null, status: { not: 'ABORTED' } },
        data: { signatureId: id },
      });
      if (!ok.count) throw httpError(409, 'SIGNATURE_EXISTS', '此退費單已完成簽名');
      await tx.refundSignature.create({
        data: {
          id,
          refundId: refund.id,
          storageKey,
          sha256,
          requestId: claims.req,
          previewDigest: claims.dg,
          staffId: user.id,
          ipAddress: req ? clientIp(req) : null,
          userAgent: req ? String(clientUserAgent(req) || '').slice(0, 200) || null : null,
        },
      });
      await tx.invoiceAllowance.updateMany({ where: { refundId: refund.id }, data: { signatureId: id } });
      await writeAudit(tx, {
        action: 'REFUND_SIGNATURE',
        refund,
        user,
        req,
        after: { signatureId: id, requestId: claims.req, digest: claims.dg, sha256 },
      });
    });
  }
}

/** 列印用：短效 Base64（不落公開 URL）；查無影像回 null */
export async function loadSignatureDataUrl(signatureId) {
  if (!signatureId) return null;
  const sig = await prisma.refundSignature.findUnique({ where: { id: signatureId } });
  if (!sig) return null;
  try {
    const { buf } = await getIdPhotoObject(sig.storageKey);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    return {
      signatureId: sig.id,
      signedAt: sig.signedAt,
      sha256: sig.sha256,
      intact: sha === sig.sha256,
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    };
  } catch (e) {
    console.error(`折讓簽名 ${signatureId} 讀取失敗:`, e.message);
    return { signatureId: sig.id, signedAt: sig.signedAt, sha256: sig.sha256, intact: false, dataUrl: null };
  }
}
