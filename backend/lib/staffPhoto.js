// lib/staffPhoto.js — 員工照片：私有儲存（原圖供人臉辨識、縮圖供頭像）＋ Face8 員工群組
import crypto from 'crypto';
import sharp from 'sharp';
import prisma from './prisma.js';
import { assertImageMagicBytes } from './idPhoto.js';
import { putIdPhotoObject, getIdPhotoObject, deleteIdPhotoObject } from './idPhotoStorage.js';
import { registerFace, removeFace, staffFaceGroupId } from './papago.js';
import { assertStaffBiometricsConsent, revokeStaffBiometricsConsent } from './staffConsent.js';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PHOTO_MAX_EDGE = 1024;
const THUMB_EDGE = 256;

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/** 員工列表／登入可安全外露之照片狀態（不含 storage key 與 faceId） */
export const staffPhotoSelect = {
  photoUpdatedAt: true,
  faceEnrolledAt: true,
  faceConsentAt: true,
};

async function normalizeStaffPhoto(dataUrlOrBase64) {
  const raw = String(dataUrlOrBase64 || '').trim();
  if (!raw) throw httpError('缺少員工照片');
  const m = raw.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/i);
  const input = Buffer.from(m ? m[1] : raw, 'base64');
  if (!input.length || input.length > MAX_INPUT_BYTES) throw httpError('員工照片須為 8MB 以內');
  assertImageMagicBytes(input, '員工照片');

  try {
    const base = () => sharp(input).rotate();
    const meta = await base().metadata();
    if ((meta.width || 0) < 160 || (meta.height || 0) < 160) {
      throw httpError('照片解析度過低（至少 160×160），請改拍清晰正面照');
    }
    const [photo, thumb] = await Promise.all([
      base()
        .resize({ width: PHOTO_MAX_EDGE, height: PHOTO_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer(),
      base()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'cover', position: 'attention' })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer(),
    ]);
    return { photo, thumb };
  } catch (e) {
    if (e.statusCode) throw e;
    throw httpError('無法解析影像，請改用 JPG／PNG');
  }
}

async function loadStaff(staffId) {
  const staff = await prisma.staff.findUnique({ where: { id: Number(staffId) } });
  if (!staff) throw httpError('找不到此員工', 404);
  return staff;
}

async function deleteObjects(...keys) {
  for (const key of keys) if (key) await deleteIdPhotoObject(key);
}

/** 刪除 Face8 特徵；失敗不阻擋本地清除，回傳警示訊息 */
async function tryRemoveFace(faceId) {
  if (!faceId) return null;
  try {
    await removeFace({ faceId, groupId: staffFaceGroupId() });
    return null;
  } catch (e) {
    console.error('[staffPhoto] Face8 刪除人臉失敗:', e instanceof Error ? e.message : e);
    return 'Face8 人臉特徵刪除失敗，已解除本地綁定，請至 Face8 後台確認移除';
  }
}

/**
 * 上傳（覆蓋）員工照片；enrollFace=true 時須已有有效電子同意書，並同步註冊 Face8 員工群組
 * @param {{ staffId: number, image: string, enrollFace: boolean }} opts
 */
export async function uploadStaffPhoto({ staffId, image, enrollFace }) {
  const staff = await loadStaff(staffId);
  if (enrollFace) await assertStaffBiometricsConsent(staff.id);
  const { photo, thumb } = await normalizeStaffPhoto(image);

  const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const photoKey = `staff-photos/${staff.id}/${stamp}.jpg`;
  const photoThumbKey = `staff-photos/${staff.id}/${stamp}_thumb.jpg`;
  await putIdPhotoObject(photoKey, photo, 'image/jpeg');
  await putIdPhotoObject(photoThumbKey, thumb, 'image/jpeg');

  const now = new Date();
  let face = { papagoFaceId: null, faceEnrolledAt: null };
  let warning = null;
  if (enrollFace) {
    try {
      const reg = await registerFace({
        imageBase64: photo.toString('base64'),
        externalId: `STAFF-${staff.id}`,
        displayName: staff.name,
        groupId: staffFaceGroupId(),
      });
      face = { papagoFaceId: reg.faceId, faceEnrolledAt: now };
    } catch (e) {
      await deleteObjects(photoKey, photoThumbKey);
      const msg = e instanceof Error ? e.message : '人臉辨識服務異常';
      throw httpError(`人臉註冊失敗：${msg}（照片未更新，請改拍正面清晰照）`, 502, 'FACE_ENROLL_FAILED');
    }
  } else if (staff.papagoFaceId) {
    warning = await tryRemoveFace(staff.papagoFaceId);
  }

  let updated;
  try {
    updated = await prisma.staff.update({
      where: { id: staff.id },
      data: { photoKey, photoThumbKey, photoUpdatedAt: now, ...face },
      select: { id: true, ...staffPhotoSelect },
    });
  } catch (e) {
    await deleteObjects(photoKey, photoThumbKey);
    if (e.code === 'P2002') throw httpError('此人臉已綁定其他員工', 409);
    throw e;
  }
  await deleteObjects(staff.photoKey, staff.photoThumbKey);
  return { ...updated, warning };
}

/** 刪除照片與人臉特徵（同意書仍有效，重拍可直接註冊） */
export async function deleteStaffPhoto(staffId) {
  const staff = await loadStaff(staffId);
  const warning = await tryRemoveFace(staff.papagoFaceId);
  const updated = await prisma.staff.update({
    where: { id: staff.id },
    data: {
      photoKey: null,
      photoThumbKey: null,
      photoUpdatedAt: null,
      papagoFaceId: null,
      faceEnrolledAt: null,
    },
    select: { id: true, ...staffPhotoSelect },
  });
  await deleteObjects(staff.photoKey, staff.photoThumbKey);
  return { ...updated, warning };
}

/** 撤回生物辨識同意：標記簽署撤回、刪 Face8 特徵，保留頭像 */
export async function revokeStaffFace(staffId, actorStaffId) {
  const staff = await loadStaff(staffId);
  const warning = await tryRemoveFace(staff.papagoFaceId);
  const updated = await prisma.$transaction(async (tx) => {
    await revokeStaffBiometricsConsent(tx, staff.id, actorStaffId);
    return tx.staff.update({
      where: { id: staff.id },
      data: { papagoFaceId: null, faceEnrolledAt: null, faceConsentAt: null, faceConsentByStaffId: null },
      select: { id: true, ...staffPhotoSelect },
    });
  });
  return { ...updated, warning };
}

/** 頭像縮圖（data URL）；無照片回 null */
export async function readStaffAvatar(staffId) {
  const staff = await prisma.staff.findUnique({
    where: { id: Number(staffId) },
    select: { photoThumbKey: true, photoUpdatedAt: true },
  });
  if (!staff?.photoThumbKey) return null;
  try {
    const { buf } = await getIdPhotoObject(staff.photoThumbKey);
    return {
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      photoUpdatedAt: staff.photoUpdatedAt,
    };
  } catch {
    return null;
  }
}
