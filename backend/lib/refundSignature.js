// lib/refundSignature.js — 折讓單客顯預覽＋顧客親簽（客顯 SignaturePad Blob → multipart → 私有儲存；DB 只存 storageKey＋SHA-256）
// B2B 折讓必須簽名才可結案；B2C 選簽。影像禁止公開路徑，列印時以短效 Base64 回傳。
// 客顯所見金額一律來自 buildSignPreview；previewToken（HMAC）綁 requestId＋經辦＋折讓內容摘要，送簽時重算摘要，內容變動即拒收。
import crypto from 'node:crypto';
import sharp from 'sharp';
import prisma from './prisma.js';
import { deleteIdPhotoObject, getIdPhotoObject, putIdPhotoObject } from './idPhotoStorage.js';
import { readToken, signToken } from './signedToken.js';
import { clientIp, clientUserAgent } from './memberDeviceAudit.js';
import { finalizeRefund, loadRefundForStaff, serializeRefund, withRefundLock, writeAudit } from './refundService.js';

export const MAX_SIGNATURE_BYTES = 512 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 灰階 < 128 視為筆跡；客顯浮水印須淺於此值，才不會讓空白簽名通過 */
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
    after: { requestId, digest, allowances: docs.map((d) => d.allowanceNo) },
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

/** multipart 上傳之 PNG：magic bytes、大小、尺寸、筆跡像素（浮水印不計入） */
export async function validateSignaturePng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'SIGNATURE_REQUIRED', '缺少簽名影像');
  if (buf.length > MAX_SIGNATURE_BYTES) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像過大');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像格式錯誤（須為 PNG）');
  let ink = 0;
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: 4096 * 4096 })
      .flatten({ background: '#ffffff' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width < 200 || info.height < 80) throw httpError(400, 'SIGNATURE_REQUIRED', '簽名影像尺寸過小');
    for (let i = 0; i < data.length; i += 1) if (data[i] < INK_THRESHOLD) ink += 1;
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
export async function attachRefundSignature(user, refundId, { previewToken, requestId, signature } = {}, req = null) {
  const claims = verifyPreviewToken(previewToken);
  const { refund, allowances } = await loadSignable(user, refundId);
  if (claims.rid !== refund.id || claims.sid !== user.id || claims.req !== String(requestId || '')) {
    throw httpError(400, 'PREVIEW_TOKEN_INVALID', '簽署憑證與退費單／經辦不符，請重新推送客顯');
  }
  if (claims.dg !== contentDigest(refund, allowances)) {
    throw httpError(409, 'PREVIEW_STALE', '折讓內容已變動，顧客所簽版本失效，請重新推送客顯');
  }
  await validateSignaturePng(signature);

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
          sha256: crypto.createHash('sha256').update(signature).digest('hex'),
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
        after: { signatureId: id, requestId: claims.req, digest: claims.dg },
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
