// lib/staffConsent.js — 員工生物辨識電子同意書（與會員合約分離，避免混入會員簽署看板）
import sharp from 'sharp';
import prisma from './prisma.js';
import { hashContractBody } from './contractAudit.js';

export const STAFF_CONSENT_KIND = { BIOMETRICS: 'BIOMETRICS' };

/** 條文異動必須升 version；bodyHash 不符者須重簽 */
const BIOMETRICS_TEMPLATE = {
  kind: STAFF_CONSENT_KIND.BIOMETRICS,
  version: 'S1',
  title: '員工生物特徵（人臉）辨識同意書',
  body: `【員工生物特徵（人臉）辨識同意書】

立同意書人（員工，以下稱「本人」）同意體育客連鎖健身事業（以下稱「公司」）基於下列目的，蒐集、處理及利用本人之生物特徵資料：

一、目的
1. 員工進出場館門禁與後場區域管制
2. 出勤打卡身分核實
3. 防止他人冒用員工身分，維護場館與會員安全

二、蒐集項目
本人正面臉部照片，及由人臉辨識系統產生之特徵代碼。照片同時作為內部系統員工頭像顯示。

三、利用期間、地區、對象與方式
1. 期間：自簽署日起至僱傭關係終止，或本人撤回同意並完成刪除為止（法令另有保存義務者從其規定）。
2. 地區：中華民國境內（含公司指定之雲端服務處理地）。
3. 對象：公司內部經授權之管理人員，及受託處理門禁／人臉辨識之服務供應商。
4. 方式：以自動化設備比對辨識，特徵資料與會員資料分開存放，並保存必要操作軌跡；不用於前述目的以外之用途。

四、自願性與不利益禁止
1. 本同意完全出於本人自由意願。本人拒絕或撤回同意，公司不得因此予以解僱、降調、減薪或其他不利對待。
2. 本人不同意或撤回同意時，公司應提供其他出勤及門禁方式（如員工帳號、動態 QR 或人工登記）。

五、權利與撤回
1. 本人得查詢、閱覽、請求製給複製本、補充更正、請求停止蒐集／處理／利用或刪除（法令允許範圍內）。
2. 本人得隨時向公司表示撤回同意；公司應於撤回後刪除人臉辨識特徵資料。

六、電子簽署
本人瞭解以電子簽名簽署本同意書，效力同親筆簽名；公司將保存簽署時間、條文版本雜湊、經辦人員及必要稽核資訊。

本人已閱讀、瞭解並同意以上內容。`,
};

const BIOMETRICS_HASH = hashContractBody(BIOMETRICS_TEMPLATE.body);
const MAX_SIGNATURE_BYTES = 512 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export function getStaffBiometricsConsentTemplate() {
  return { ...BIOMETRICS_TEMPLATE, bodyHash: BIOMETRICS_HASH };
}

/** 簽名須為 PNG data URL 且非空白 */
async function normalizeSignature(raw) {
  const m = String(raw || '').trim().match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError('缺少簽名或格式錯誤', 400, 'SIGNATURE_REQUIRED');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > MAX_SIGNATURE_BYTES) throw httpError('簽名影像過大', 400, 'SIGNATURE_REQUIRED');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw httpError('簽名影像格式錯誤', 400, 'SIGNATURE_REQUIRED');
  try {
    const { channels } = await sharp(buf).flatten({ background: '#ffffff' }).stats();
    if (Math.min(...channels.slice(0, 3).map((c) => c.min)) > 200) {
      throw httpError('簽名為空白，請員工本人親簽', 400, 'SIGNATURE_REQUIRED');
    }
  } catch (e) {
    if (e.statusCode) throw e;
    throw httpError('無法解析簽名影像', 400, 'SIGNATURE_REQUIRED');
  }
  return `data:image/png;base64,${m[1]}`;
}

function activeBiometricsWhere(staffId) {
  return { staffId: Number(staffId), kind: STAFF_CONSENT_KIND.BIOMETRICS, revokedAt: null };
}

/** 最近一次未撤回之生物辨識簽署；current=false 表示條文已升版須重簽 */
export async function getStaffBiometricsConsent(staffId, { withSignature = false } = {}) {
  const row = await prisma.staffConsentSignature.findFirst({
    where: activeBiometricsWhere(staffId),
    orderBy: { signedAt: 'desc' },
    select: {
      id: true,
      version: true,
      bodyHash: true,
      signerName: true,
      signedAt: true,
      witnessStaffId: true,
      signatureData: withSignature,
    },
  });
  if (!row) return null;
  return { ...row, current: row.bodyHash === BIOMETRICS_HASH };
}

export async function assertStaffBiometricsConsent(staffId) {
  const consent = await getStaffBiometricsConsent(staffId);
  if (!consent) {
    throw httpError('請先由員工本人簽署「員工生物辨識同意書」，始可註冊人臉辨識', 403, 'FACE_CONSENT_REQUIRED');
  }
  if (!consent.current) {
    throw httpError('生物辨識同意書條文已更新，請員工重新簽署後再註冊人臉', 403, 'FACE_CONSENT_REQUIRED');
  }
  return consent;
}

/**
 * 員工親簽生物辨識同意書（經辦人由 JWT 帶入）
 * @param {{ staffId: number, signatureData: string, bodyHash: string, actorStaffId: number, clientMeta: { ipAddress?: string|null, userAgent?: string|null } }} opts
 */
export async function signStaffBiometricsConsent({ staffId, signatureData, bodyHash, actorStaffId, clientMeta }) {
  if (String(bodyHash || '') !== BIOMETRICS_HASH) {
    throw httpError('同意書條文已更新，請重新閱讀後再簽署', 409, 'CONSENT_VERSION_CHANGED');
  }
  const signature = await normalizeSignature(signatureData);
  const staff = await prisma.staff.findUnique({
    where: { id: Number(staffId) },
    select: { id: true, name: true, isActive: true },
  });
  if (!staff) throw httpError('找不到此員工', 404);
  if (!staff.isActive) throw httpError('停權帳號不可簽署同意書', 400);

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const row = await tx.staffConsentSignature.create({
      data: {
        staffId: staff.id,
        kind: STAFF_CONSENT_KIND.BIOMETRICS,
        version: BIOMETRICS_TEMPLATE.version,
        bodyHash: BIOMETRICS_HASH,
        signerName: staff.name,
        signatureData: signature,
        witnessStaffId: actorStaffId,
        ipAddress: clientMeta?.ipAddress || null,
        userAgent: clientMeta?.userAgent || null,
        signedAt: now,
      },
      select: { id: true, version: true, signerName: true, signedAt: true },
    });
    await tx.staff.update({
      where: { id: staff.id },
      data: { faceConsentAt: now, faceConsentByStaffId: actorStaffId },
    });
    return row;
  });
}

/** 撤回：標記所有未撤回簽署，並清空 Staff 同意欄位（Face8 刪除由呼叫端處理） */
export async function revokeStaffBiometricsConsent(tx, staffId, actorStaffId) {
  await tx.staffConsentSignature.updateMany({
    where: activeBiometricsWhere(staffId),
    data: { revokedAt: new Date(), revokedByStaffId: actorStaffId ?? null },
  });
}
