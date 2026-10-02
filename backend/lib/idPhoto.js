// lib/idPhoto.js — 會員證件正／反面：版本、保留期、刪除申請、稽核
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import prisma from './prisma.js';
import { getRequestClientMeta } from './contractAudit.js';
import {
  putIdPhotoObject,
  getIdPhotoObject,
  deleteIdPhotoObject,
  idPhotoStorageDriver,
  createIdPhotoPresignedGetUrl,
  idPhotoPresignTtlSec,
} from './idPhotoStorage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_UPLOAD_ROOT = path.resolve(__dirname, '../uploads/id-photos');

export const ID_PHOTO_SIDES = ['front', 'back'];
/** 會籍結束後保存年數 */
export const ID_PHOTO_RETENTION_YEARS = 3;
/** 被覆蓋的歷史版保存年數 */
export const ID_PHOTO_VERSION_YEARS = 1;

export function normalizeIdPhotoSide(raw) {
  const side = String(raw || 'front').trim().toLowerCase();
  if (!ID_PHOTO_SIDES.includes(side)) {
    const err = new Error('side 須為 front（正面）或 back（反面）');
    err.statusCode = 400;
    throw err;
  }
  return side;
}

export function normalizeIdPhotoDeleteSide(raw) {
  const side = String(raw || '').trim().toLowerCase();
  if (side === 'both' || side === 'all') return 'both';
  return normalizeIdPhotoSide(side || 'front');
}

export function idPhotoPublicPath(side = 'front') {
  const s = normalizeIdPhotoSide(side);
  return `/api/member/id-photo?side=${s}`;
}

function newId(prefix) {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const randomStr = crypto.randomBytes(4).toString('hex');
  return `${prefix}${dateStr}${randomStr}`;
}

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

/** 現行檔保留至會籍到期日 + 3 年；無到期日則暫以 now+3 年（效期更新後應重算） */
export function computeRetentionUntil(expireDate) {
  const now = new Date();
  if (expireDate instanceof Date && !Number.isNaN(expireDate.getTime())) {
    return addYears(expireDate, ID_PHOTO_RETENTION_YEARS);
  }
  return addYears(now, ID_PHOTO_RETENTION_YEARS);
}

async function writeAccessLog({
  memberId,
  photoId = null,
  side = null,
  action,
  actorType,
  actorStaffId = null,
  actorMemberId = null,
  detail = null,
  req = null,
}) {
  const meta = req ? getRequestClientMeta(req) : { ipAddress: null, userAgent: null };
  await prisma.idPhotoAccessLog.create({
    data: {
      id: newId('IPAL'),
      memberId,
      photoId,
      side,
      action,
      actorType,
      actorStaffId,
      actorMemberId,
      detail: detail || undefined,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });
}

/**
 * 轉 JPEG、剝 EXIF／GPS、限制長邊；驗證 Magic Bytes；補壓防偽浮水印
 * @param {string} dataUrlOrBase64
 * @param {{ watermarkText?: string|null }} [opts]
 * @returns {Promise<{ buf: Buffer, mime: string, hash: string, watermarkHash: string|null }>}
 */
export async function normalizeIdPhotoBuffer(dataUrlOrBase64, opts = {}) {
  const raw = String(dataUrlOrBase64 || '').trim();
  if (!raw) {
    const err = new Error('缺少證件影像');
    err.statusCode = 400;
    throw err;
  }

  let b64 = raw;
  const m = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if (m) b64 = m[2];

  const input = Buffer.from(b64, 'base64');
  if (!input.length || input.length > 5 * 1024 * 1024) {
    const err = new Error('證件影像須為 5MB 以內');
    err.statusCode = 400;
    throw err;
  }

  assertImageMagicBytes(input);

  let buf;
  try {
    let pipeline = sharp(input)
      .rotate() // 依 EXIF orientation 轉正後丟棄 metadata
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });

    const wm = String(opts.watermarkText || '').trim();
    if (wm) {
      const meta = await pipeline.metadata();
      const w = meta.width || 1200;
      const h = meta.height || 800;
      const svg = buildWatermarkSvg(wm, w, h);
      pipeline = sharp(input)
        .rotate()
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .composite([{ input: Buffer.from(svg), gravity: 'centre' }]);
    }

    buf = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } catch (e) {
    if (e.statusCode) throw e;
    const err = new Error('無法解析影像，請改用 JPG／PNG');
    err.statusCode = 400;
    throw err;
  }

  if (!buf.length || buf.length > 5 * 1024 * 1024) {
    const err = new Error('證件影像處理後仍超過 5MB');
    err.statusCode = 400;
    throw err;
  }

  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const watermarkHash = opts.watermarkText
    ? crypto.createHash('sha256').update(String(opts.watermarkText)).digest('hex').slice(0, 32)
    : null;

  return {
    buf,
    mime: 'image/jpeg',
    hash,
    watermarkHash,
  };
}

export function assertImageMagicBytes(buf, label = '證件影像') {
  if (!buf || buf.length < 12) {
    const err = new Error(`${label}格式無效（檔頭過短）`);
    err.statusCode = 400;
    err.code = 'INVALID_IMAGE_MAGIC';
    throw err;
  }
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  const isWebp =
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) {
    const err = new Error(`${label}須為 JPG／PNG／WebP（拒絕可執行檔偽裝）`);
    err.statusCode = 400;
    err.code = 'INVALID_IMAGE_MAGIC';
    throw err;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWatermarkSvg(text, width, height) {
  const w = Math.max(400, width || 1200);
  const h = Math.max(300, height || 800);
  const lines = String(text)
    .split(/\n|｜/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 4);
  const fontSize = Math.max(18, Math.min(36, Math.floor(w / 28)));
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="50%" dy="${i === 0 ? 0 : fontSize * 1.35}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <text x="50%" y="50%" fill="rgba(8,61,79,0.28)" font-size="${fontSize}"
    font-family="sans-serif" text-anchor="middle" dominant-baseline="middle"
    transform="rotate(-28 ${w / 2} ${h / 2})">${tspans}</text>
</svg>`;
}

function legacyPaths(memberId, side) {
  const id = Number(memberId);
  const paths = [path.join(LEGACY_UPLOAD_ROOT, `${id}-${side}.jpg`)];
  if (side === 'front') paths.push(path.join(LEGACY_UPLOAD_ROOT, `${id}.jpg`));
  return paths;
}

async function readLegacyFile(memberId, side) {
  for (const abs of legacyPaths(memberId, side)) {
    try {
      const buf = await fs.readFile(abs);
      return { buf, contentType: 'image/jpeg', storageKey: null, legacy: true };
    } catch {
      /* next */
    }
  }
  return null;
}

async function deleteLegacyFiles(memberId, side) {
  for (const abs of legacyPaths(memberId, side)) {
    try {
      await fs.unlink(abs);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 上傳並建立版本；覆蓋舊現行版 → 歷史保留 1 年
 * @param {number} memberId
 * @param {string} dataUrlOrBase64
 * @param {string} [side]
 * @param {import('express').Request|null} [req]
 * @param {{
 *   watermarkText?: string|null,
 *   uploadedByStaffId?: number|null,
 *   uploadBranchId?: number|null,
 *   uploadSource?: string|null,
 *   consentSignatureId?: string|null,
 * }} [extra]
 */
export async function uploadMemberIdPhoto(
  memberId,
  dataUrlOrBase64,
  side = 'front',
  req = null,
  extra = {},
) {
  const s = normalizeIdPhotoSide(side);
  const mid = Number(memberId);
  const defaultWm = `僅供體育客會籍查驗｜他用無效｜日期：${new Date().toISOString().slice(0, 10)}｜會員：${mid}`;
  const { buf, mime, hash, watermarkHash } = await normalizeIdPhotoBuffer(dataUrlOrBase64, {
    watermarkText: extra.watermarkText || defaultWm,
  });

  const member = await prisma.member.findUnique({
    where: { id: mid },
    select: { id: true, expireDate: true },
  });
  if (!member) {
    const err = new Error('找不到會員');
    err.statusCode = 404;
    throw err;
  }

  const photoId = newId('MIDP');
  const storageKey = `id-photos/${mid}/${s}/${photoId}.jpg`;
  await putIdPhotoObject(storageKey, buf, mime);

  const now = new Date();
  const retentionUntil = computeRetentionUntil(member.expireDate);
  const versionPurgeAt = addYears(now, ID_PHOTO_VERSION_YEARS);
  const uploadSource =
    extra.uploadSource ||
    (extra.uploadedByStaffId ? 'STAFF_USB_SCANNER' : req?.onboardingMemberId ? 'ONBOARDING' : 'MEMBER_SELF');

  const result = await prisma.$transaction(async (tx) => {
    const prev = await tx.memberIdPhoto.findMany({
      where: { memberId: mid, side: s, isCurrent: true, deletedAt: null },
    });
    for (const p of prev) {
      await tx.memberIdPhoto.update({
        where: { id: p.id },
        data: {
          isCurrent: false,
          supersededAt: now,
          versionPurgeAt,
        },
      });
    }

    const row = await tx.memberIdPhoto.create({
      data: {
        id: photoId,
        memberId: mid,
        side: s,
        storageKey,
        contentHash: hash,
        byteSize: buf.length,
        mimeType: mime,
        isCurrent: true,
        retentionUntil,
        uploadedByStaffId: extra.uploadedByStaffId ?? null,
        uploadBranchId: extra.uploadBranchId ?? null,
        uploadSource,
        consentSignatureId: extra.consentSignatureId ?? null,
        watermarkHash: watermarkHash || null,
      },
    });

    const marker = idPhotoPublicPath(s);
    await tx.member.update({
      where: { id: mid },
      data: s === 'back' ? { idPhotoBackUrl: marker } : { idPhotoUrl: marker },
    });

    return { row, supersededIds: prev.map((p) => p.id) };
  });

  await deleteLegacyFiles(mid, s);

  for (const id of result.supersededIds) {
    await writeAccessLog({
      memberId: mid,
      photoId: id,
      side: s,
      action: 'SUPERSEDE',
      actorType: extra.uploadedByStaffId ? 'STAFF' : 'MEMBER',
      actorStaffId: extra.uploadedByStaffId ?? null,
      actorMemberId: extra.uploadedByStaffId ? null : mid,
      req,
    });
  }

  await writeAccessLog({
    memberId: mid,
    photoId: result.row.id,
    side: s,
    action: 'UPLOAD',
    actorType: extra.uploadedByStaffId ? 'STAFF' : 'MEMBER',
    actorStaffId: extra.uploadedByStaffId ?? null,
    actorMemberId: extra.uploadedByStaffId ? null : mid,
    detail: {
      uploadSource,
      consentSignatureId: extra.consentSignatureId || null,
      watermarkHash: watermarkHash || null,
      bytes: buf.length,
      hash,
      retentionUntil,
      storage: idPhotoStorageDriver(),
    },
    req,
  });

  return {
    relativeUrl: idPhotoPublicPath(s),
    bytes: buf.length,
    side: s,
    mime,
    photoId: result.row.id,
    retentionUntil,
    watermarkHash: watermarkHash || null,
  };
}

/** @deprecated 相容舊呼叫名稱 */
export async function saveMemberIdPhoto(memberId, dataUrlOrBase64, side = 'front', req = null) {
  return uploadMemberIdPhoto(memberId, dataUrlOrBase64, side, req);
}

export async function readCurrentIdPhoto(memberId, side = 'front') {
  const s = normalizeIdPhotoSide(side);
  const mid = Number(memberId);
  const row = await prisma.memberIdPhoto.findFirst({
    where: { memberId: mid, side: s, isCurrent: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (row) {
    try {
      const obj = await getIdPhotoObject(row.storageKey);
      return {
        buf: obj.buf,
        contentType: row.mimeType || obj.contentType,
        side: s,
        photoId: row.id,
        retentionUntil: row.retentionUntil,
      };
    } catch {
      /* fall through legacy */
    }
  }
  const legacy = await readLegacyFile(mid, s);
  if (legacy) return { ...legacy, side: s, photoId: null, retentionUntil: null };
  return null;
}

/** @deprecated */
export async function readMemberIdPhoto(memberId, side = 'front') {
  return readCurrentIdPhoto(memberId, side);
}

export async function getIdPhotoMetaForMember(memberId) {
  const mid = Number(memberId);
  const currents = await prisma.memberIdPhoto.findMany({
    where: { memberId: mid, isCurrent: true, deletedAt: null },
    select: {
      id: true,
      side: true,
      byteSize: true,
      createdAt: true,
      retentionUntil: true,
    },
  });
  const pending = await prisma.idPhotoDeleteRequest.findMany({
    where: { memberId: mid, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });

  const bySide = { front: null, back: null };
  for (const c of currents) {
    bySide[c.side] = c;
  }
  // legacy fallback markers
  if (!bySide.front) {
    const leg = await readLegacyFile(mid, 'front');
    if (leg) bySide.front = { id: null, side: 'front', legacy: true, createdAt: null };
  }
  if (!bySide.back) {
    const leg = await readLegacyFile(mid, 'back');
    if (leg) bySide.back = { id: null, side: 'back', legacy: true, createdAt: null };
  }

  return { sides: bySide, pendingDeletes: pending };
}

/**
 * 會員申請清除（不立刻刪檔）
 */
export async function requestIdPhotoDelete(memberId, sideRaw, reason, req = null) {
  const mid = Number(memberId);
  const side = normalizeIdPhotoDeleteSide(sideRaw);
  const existing = await prisma.idPhotoDeleteRequest.findFirst({
    where: { memberId: mid, side, status: 'PENDING' },
  });
  if (existing) {
    const err = new Error('已有待核准的清除申請，請等候櫃檯處理');
    err.statusCode = 409;
    throw err;
  }

  const row = await prisma.idPhotoDeleteRequest.create({
    data: {
      id: newId('IPDR'),
      memberId: mid,
      side,
      reason: reason ? String(reason).trim().slice(0, 500) : null,
      status: 'PENDING',
    },
  });

  await writeAccessLog({
    memberId: mid,
    side: side === 'both' ? 'both' : side,
    action: 'DELETE_REQUEST',
    actorType: 'MEMBER',
    actorMemberId: mid,
    detail: { requestId: row.id, reason: row.reason },
    req,
  });

  return row;
}

export async function cancelIdPhotoDeleteRequest(memberId, requestId, req = null) {
  const mid = Number(memberId);
  const row = await prisma.idPhotoDeleteRequest.findFirst({
    where: { id: String(requestId), memberId: mid, status: 'PENDING' },
  });
  if (!row) {
    const err = new Error('找不到待處理的清除申請');
    err.statusCode = 404;
    throw err;
  }
  const updated = await prisma.idPhotoDeleteRequest.update({
    where: { id: row.id },
    data: { status: 'CANCELLED', resolvedAt: new Date(), resolveNote: '會員取消' },
  });
  await writeAccessLog({
    memberId: mid,
    side: row.side,
    action: 'DELETE_CANCEL',
    actorType: 'MEMBER',
    actorMemberId: mid,
    detail: { requestId: row.id },
    req,
  });
  return updated;
}

async function hardDeleteSidePhotos(memberId, side, { forceAllVersions = true } = {}) {
  const mid = Number(memberId);
  const where = {
    memberId: mid,
    side,
    deletedAt: null,
    ...(forceAllVersions ? {} : { isCurrent: true }),
  };
  const rows = await prisma.memberIdPhoto.findMany({ where });
  const now = new Date();
  for (const row of rows) {
    if (!row.legalHold) {
      await deleteIdPhotoObject(row.storageKey);
    }
    await prisma.memberIdPhoto.update({
      where: { id: row.id },
      data: {
        deletedAt: now,
        isCurrent: false,
        storageKey: row.legalHold ? row.storageKey : `deleted:${row.id}`,
      },
    });
  }
  await deleteLegacyFiles(mid, side);
  const markerNull = side === 'back' ? { idPhotoBackUrl: null } : { idPhotoUrl: null };
  await prisma.member.update({ where: { id: mid }, data: markerNull });
}

export async function resolveIdPhotoDeleteRequest(
  requestId,
  { approve, staffId, note, req = null },
) {
  const row = await prisma.idPhotoDeleteRequest.findUnique({ where: { id: String(requestId) } });
  if (!row || row.status !== 'PENDING') {
    const err = new Error('找不到待處理的清除申請');
    err.statusCode = 404;
    throw err;
  }

  if (!approve) {
    const updated = await prisma.idPhotoDeleteRequest.update({
      where: { id: row.id },
      data: {
        status: 'REJECTED',
        resolvedAt: new Date(),
        resolverStaffId: staffId || null,
        resolveNote: note ? String(note).trim().slice(0, 500) : null,
      },
    });
    await writeAccessLog({
      memberId: row.memberId,
      side: row.side,
      action: 'DELETE_REJECT',
      actorType: 'STAFF',
      actorStaffId: staffId || null,
      detail: { requestId: row.id, note: updated.resolveNote },
      req,
    });
    return updated;
  }

  const sides = row.side === 'both' ? ['front', 'back'] : [normalizeIdPhotoSide(row.side)];
  for (const s of sides) {
    await hardDeleteSidePhotos(row.memberId, s, { forceAllVersions: true });
  }

  const updated = await prisma.idPhotoDeleteRequest.update({
    where: { id: row.id },
    data: {
      status: 'APPROVED',
      resolvedAt: new Date(),
      resolverStaffId: staffId || null,
      resolveNote: note ? String(note).trim().slice(0, 500) : null,
    },
  });

  await writeAccessLog({
    memberId: row.memberId,
    side: row.side,
    action: 'DELETE_APPROVE',
    actorType: 'STAFF',
    actorStaffId: staffId || null,
    detail: { requestId: row.id, sides, note: updated.resolveNote },
    req,
  });

  return updated;
}

/** 員工螢幕預覽（禁止當下載端點使用；呼叫端須設 Content-Disposition: inline） */
export async function readIdPhotoForStaffPreview(memberId, side = 'front', req = null, staffId = null) {
  const file = await readCurrentIdPhoto(memberId, side);
  if (!file) return null;
  await writeAccessLog({
    memberId: Number(memberId),
    photoId: file.photoId,
    side: normalizeIdPhotoSide(side),
    action: 'VIEW_STAFF',
    actorType: 'STAFF',
    actorStaffId: staffId || null,
    detail: { mode: 'preview_stream' },
    req,
  });
  return file;
}

function idPhotoAccessSecret() {
  return (
    process.env.ID_PHOTO_ACCESS_SECRET ||
    process.env.JWT_STAFF_SECRET ||
    process.env.JWT_SECRET ||
    'gymsaas-id-photo-access-dev'
  );
}

/**
 * 簽發短效調閱 URL（DUTY+）：R2 → Presigned GET；local → HMAC token。
 * @param {{ memberId: number, side?: string, staffId?: number|null, reason: string, req?: object|null }} opts
 */
export async function issueStaffIdPhotoAccess({
  memberId,
  side = 'front',
  staffId = null,
  reason,
  req = null,
}) {
  const reasonTrim = String(reason || '').trim();
  if (reasonTrim.length < 4) {
    const err = new Error('調閱原因必填（至少 4 字，例：主管機關查驗）');
    err.statusCode = 400;
    err.code = 'REASON_REQUIRED';
    throw err;
  }

  const s = normalizeIdPhotoSide(side);
  const mid = Number(memberId);
  const row = await prisma.memberIdPhoto.findFirst({
    where: { memberId: mid, side: s, isCurrent: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const ttl = idPhotoPresignTtlSec();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  let url = null;
  let mode = null;
  let photoId = row?.id || null;

  if (row?.storageKey) {
    const signed = await createIdPhotoPresignedGetUrl(row.storageKey, ttl);
    if (signed?.url) {
      url = signed.url;
      mode = 'r2_presign';
    }
  }

  if (!url) {
    // local／無 R2／legacy：確認檔案存在後簽 token
    const file = await readCurrentIdPhoto(mid, s);
    if (!file) return null;
    photoId = file.photoId || photoId;
    const payload = {
      v: 1,
      mid,
      side: s,
      photoId,
      staffId: staffId || null,
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', idPhotoAccessSecret()).update(body).digest('base64url');
    url = `/api/ops/id-photo-access/${body}.${sig}`;
    mode = 'local_token';
  }

  await writeAccessLog({
    memberId: mid,
    photoId,
    side: s,
    action: 'VIEW_STAFF',
    actorType: 'STAFF',
    actorStaffId: staffId || null,
    detail: {
      mode: 'presign_issue',
      accessMode: mode,
      reason: reasonTrim.slice(0, 500),
      expiresAt: expiresAt.toISOString(),
      ttlSec: ttl,
    },
    req,
  });

  return {
    url,
    expiresAt: expiresAt.toISOString(),
    expiresIn: ttl,
    mode,
    side: s,
    photoId,
    driver: idPhotoStorageDriver(),
  };
}

/** 兌換 local_token 短效調閱（無 Staff JWT；token 即憑證） */
export async function redeemLocalIdPhotoAccessToken(tokenRaw, req = null) {
  const token = String(tokenRaw || '').trim();
  const parts = token.split('.');
  if (parts.length !== 2) {
    const err = new Error('調閱憑證無效');
    err.statusCode = 403;
    err.code = 'ACCESS_TOKEN_INVALID';
    throw err;
  }
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', idPhotoAccessSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('調閱憑證無效');
    err.statusCode = 403;
    err.code = 'ACCESS_TOKEN_INVALID';
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    const err = new Error('調閱憑證無效');
    err.statusCode = 403;
    err.code = 'ACCESS_TOKEN_INVALID';
    throw err;
  }
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    const err = new Error('調閱憑證已過期，請重新申請');
    err.statusCode = 403;
    err.code = 'ACCESS_TOKEN_EXPIRED';
    throw err;
  }
  const mid = Number(payload.mid);
  const side = normalizeIdPhotoSide(payload.side);
  const file = await readCurrentIdPhoto(mid, side);
  if (!file) {
    const err = new Error('證件檔不存在');
    err.statusCode = 404;
    throw err;
  }
  await writeAccessLog({
    memberId: mid,
    photoId: file.photoId || payload.photoId || null,
    side,
    action: 'VIEW_STAFF',
    actorType: 'STAFF',
    actorStaffId: payload.staffId || null,
    detail: { mode: 'local_token_redeem' },
    req,
  });
  return file;
}

export async function logMemberView(memberId, side, photoId, req = null) {
  await writeAccessLog({
    memberId: Number(memberId),
    photoId,
    side: normalizeIdPhotoSide(side),
    action: 'VIEW_MEMBER',
    actorType: 'MEMBER',
    actorMemberId: Number(memberId),
    req,
  });
}

/**
 * 清除到期歷史版與超保存年限現行檔（legalHold 略過）
 * @returns {{ purged: number }}
 */
export async function purgeExpiredIdPhotos() {
  const now = new Date();
  let purged = 0;

  const versionDue = await prisma.memberIdPhoto.findMany({
    where: {
      deletedAt: null,
      isCurrent: false,
      legalHold: false,
      versionPurgeAt: { lte: now },
    },
    take: 200,
  });
  for (const row of versionDue) {
    await deleteIdPhotoObject(row.storageKey);
    await prisma.memberIdPhoto.update({
      where: { id: row.id },
      data: { deletedAt: now, storageKey: `deleted:${row.id}` },
    });
    await writeAccessLog({
      memberId: row.memberId,
      photoId: row.id,
      side: row.side,
      action: 'PURGE',
      actorType: 'SYSTEM',
      detail: { reason: 'version_expired' },
    });
    purged += 1;
  }

  const retentionDue = await prisma.memberIdPhoto.findMany({
    where: {
      deletedAt: null,
      legalHold: false,
      retentionUntil: { lte: now },
    },
    take: 200,
  });
  for (const row of retentionDue) {
    await deleteIdPhotoObject(row.storageKey);
    await prisma.memberIdPhoto.update({
      where: { id: row.id },
      data: { deletedAt: now, isCurrent: false, storageKey: `deleted:${row.id}` },
    });
    if (row.isCurrent) {
      const markerNull =
        row.side === 'back' ? { idPhotoBackUrl: null } : { idPhotoUrl: null };
      await prisma.member.update({ where: { id: row.memberId }, data: markerNull });
    }
    await writeAccessLog({
      memberId: row.memberId,
      photoId: row.id,
      side: row.side,
      action: 'PURGE',
      actorType: 'SYSTEM',
      detail: { reason: 'retention_expired' },
    });
    purged += 1;
  }

  return { purged };
}

/** 舊版立即刪檔 API 已廢止；保留函式名以免誤用時明確失敗 */
export async function deleteMemberIdPhoto() {
  const err = new Error('證件清除須經櫃檯核准，請改送清除申請');
  err.statusCode = 400;
  throw err;
}
