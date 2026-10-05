// lib/leaveProof.js — 會籍請假證明圖（沿用證件物件儲存）
import crypto from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { deleteIdPhotoObject, putIdPhotoObject } from './idPhotoStorage.js';

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

const leaveProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '')) {
      cb(null, true);
      return;
    }
    cb(Object.assign(new Error('請假證明須為 JPG／PNG／WebP'), { statusCode: 400 }));
  },
});

/** multipart 時解析欄位 proof；JSON 直接放行 */
export function maybeLeaveProofUpload(req, res, next) {
  if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
    next();
    return;
  }
  leaveProofUpload.single('proof')(req, res, (err) => {
    if (err) {
      res.status(err.statusCode || 400).json({ status: 'error', message: err.message || '上傳請假證明失敗' });
      return;
    }
    next();
  });
}

/** 請求是否帶證明（multipart 欄位 proof，或 JSON proofImage／proofDataUrl） */
export function requestHasLeaveProof(req) {
  return Boolean(req.file?.buffer || req.body?.proofImage || req.body?.proofDataUrl);
}

/** 存證明後執行 fn；fn 失敗即刪檔，不留無 DB 指向之個資 */
export async function withStoredLeaveProof(memberId, req, fn) {
  let proof = null;
  if (req.file?.buffer) {
    proof = await storeLeaveProof(memberId, req.file.buffer, req.file.originalname);
  } else if (req.body?.proofImage || req.body?.proofDataUrl) {
    proof = await storeLeaveProof(memberId, req.body.proofImage || req.body.proofDataUrl, req.body.proofFileName);
  }
  try {
    return await fn(proof);
  } catch (e) {
    if (proof?.storageKey) {
      await deleteIdPhotoObject(proof.storageKey).catch((err) =>
        console.warn('[請假證明] 刪除未歸檔檔案失敗', err.message),
      );
    }
    throw e;
  }
}
