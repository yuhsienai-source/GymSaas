// lib/leaveProof.js — 會籍請假證明圖（沿用證件物件儲存）
import crypto from 'crypto';
import sharp from 'sharp';
import { putIdPhotoObject } from './idPhotoStorage.js';

const MAX_BYTES = 5 * 1024 * 1024;

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * @param {string|Buffer} imageOrBuf data URL / base64 / Buffer
 * @returns {Promise<Buffer>}
 */
async function toJpegBuffer(imageOrBuf) {
  let raw;
  if (Buffer.isBuffer(imageOrBuf)) {
    raw = imageOrBuf;
  } else {
    const s = String(imageOrBuf || '');
    const m = s.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    const b64 = m ? m[1] : s.replace(/\s/g, '');
    if (!b64) throw httpError('請提供請假證明圖');
    raw = Buffer.from(b64, 'base64');
  }
  if (!raw.length) throw httpError('請假證明圖為空');
  if (raw.length > MAX_BYTES * 1.5) throw httpError('請假證明圖過大（上限約 5MB）');
  const jpeg = await sharp(raw)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  if (jpeg.length > MAX_BYTES) throw httpError('請假證明圖壓縮後仍過大');
  return jpeg;
}

/**
 * 存請假證明，回傳 storageKey
 * @param {number} memberId
 * @param {string|Buffer} imageOrBuf
 * @param {string} [originalName]
 */
export async function storeLeaveProof(memberId, imageOrBuf, originalName) {
  const mid = Number(memberId);
  if (!Number.isInteger(mid) || mid <= 0) throw httpError('無效的會員');
  const jpeg = await toJpegBuffer(imageOrBuf);
  const photoId = crypto.randomBytes(12).toString('hex');
  const storageKey = `leave-proofs/${mid}/${photoId}.jpg`;
  await putIdPhotoObject(storageKey, jpeg, 'image/jpeg');
  const fileName = originalName
    ? String(originalName).trim().slice(0, 120)
    : `leave-proof-${photoId}.jpg`;
  return { storageKey, fileName, bytes: jpeg.length };
}

/**
 * 由起迄日計算含頭尾天數
 */
export function inclusiveLeaveDays(startDate, endDate) {
  const start = new Date(`${String(startDate).trim()}T00:00:00`);
  const end = new Date(`${String(endDate).trim()}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw httpError('請假起迄日無效');
  }
  if (end < start) throw httpError('結束日不可早於起始日');
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}
