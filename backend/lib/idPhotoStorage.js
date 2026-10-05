// lib/idPhotoStorage.js — 證件物件儲存（開發本機；正式 Cloudflare R2）
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.resolve(__dirname, '../uploads');

let s3Client = null;

export function idPhotoStorageDriver() {
  const driver = String(process.env.ID_PHOTO_STORAGE || 'local').trim().toLowerCase();
  return driver === 'r2' ? 'r2' : 'local';
}

/** Presigned GET TTL（秒）；Master：3～5 分 */
export function idPhotoPresignTtlSec() {
  const raw = Number(process.env.ID_PHOTO_PRESIGN_TTL_SEC || 240);
  if (!Number.isFinite(raw)) return 240;
  return Math.min(300, Math.max(180, Math.floor(raw)));
}

function getR2Client() {
  if (s3Client) return s3Client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    const err = new Error('R2 未設定：需 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY');
    err.statusCode = 500;
    throw err;
  }
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return s3Client;
}

function r2Bucket() {
  const bucket = String(process.env.R2_BUCKET_ID_PHOTOS || process.env.R2_BUCKET || '').trim();
  if (!bucket) {
    const err = new Error('R2 未設定：需 R2_BUCKET_ID_PHOTOS 或 R2_BUCKET');
    err.statusCode = 500;
    throw err;
  }
  return bucket;
}

function localAbs(storageKey) {
  const safe = String(storageKey || '').replace(/^\/+/, '');
  if (!safe || safe.includes('..')) {
    const err = new Error('無效的 storageKey');
    err.statusCode = 400;
    throw err;
  }
  return path.join(LOCAL_ROOT, safe);
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** @param {string} storageKey @param {Buffer} buf @param {string} contentType */
export async function putIdPhotoObject(storageKey, buf, contentType = 'image/jpeg') {
  const driver = idPhotoStorageDriver();
  if (driver === 'r2') {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: r2Bucket(),
        Key: storageKey,
        Body: buf,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    return { driver, storageKey };
  }
  const abs = localAbs(storageKey);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return { driver, storageKey };
}

/** @param {string} storageKey */
export async function getIdPhotoObject(storageKey) {
  const driver = idPhotoStorageDriver();
  if (driver === 'r2') {
    const out = await getR2Client().send(
      new GetObjectCommand({ Bucket: r2Bucket(), Key: storageKey }),
    );
    const buf = await streamToBuffer(out.Body);
    return { buf, contentType: out.ContentType || 'image/jpeg', driver };
  }
  const abs = localAbs(storageKey);
  const buf = await fs.readFile(abs);
  return { buf, contentType: 'image/jpeg', driver };
}

/**
 * R2 Presigned GET；local 回 null（改走短效 HMAC token URL）。
 * @param {string} storageKey
 * @param {number} [expiresIn]
 * @returns {Promise<{ url: string, expiresIn: number, driver: 'r2' } | null>}
 */
export async function createIdPhotoPresignedGetUrl(storageKey, expiresIn = idPhotoPresignTtlSec()) {
  if (idPhotoStorageDriver() !== 'r2') return null;
  const ttl = Math.min(300, Math.max(180, Math.floor(Number(expiresIn) || 240)));
  const url = await getSignedUrl(
    getR2Client(),
    new GetObjectCommand({
      Bucket: r2Bucket(),
      Key: storageKey,
      ResponseContentDisposition: 'inline',
      ResponseContentType: 'image/jpeg',
    }),
    { expiresIn: ttl },
  );
  return { url, expiresIn: ttl, driver: 'r2' };
}

/** @param {string} storageKey */
export async function deleteIdPhotoObject(storageKey) {
  const driver = idPhotoStorageDriver();
  if (driver === 'r2') {
    try {
      await getR2Client().send(
        new DeleteObjectCommand({ Bucket: r2Bucket(), Key: storageKey }),
      );
    } catch {
      /* ignore missing */
    }
    return;
  }
  try {
    await fs.unlink(localAbs(storageKey));
  } catch {
    /* ignore */
  }
}
