// lib/memberDevice.js — 會員一機一帳：改綁後舊裝置 JWT 立即失效
import prisma from './prisma.js';

/**
 * 自請求取出裝置碼（優先 X-Device-Id）
 * @param {import('express').Request} req
 */
export function readRequestDeviceId(req) {
  const raw =
    req.headers['x-device-id'] ||
    req.body?.deviceId ||
    req.query?.deviceId ||
    '';
  return String(raw).trim();
}

/**
 * 寫入／清除裝置綁定時遞增 deviceAuthVersion（使舊 JWT 立即失效）
 * @param {{ deviceId: string|null }} patch
 */
export function deviceBindUpdateData(patch) {
  return {
    deviceId: patch.deviceId,
    deviceAuthVersion: { increment: 1 },
  };
}

/**
 * 正規化 deviceId（空字串視為未綁定）
 * @param {string|null|undefined} deviceId
 */
export function normalizeDeviceId(deviceId) {
  const s = deviceId == null ? '' : String(deviceId).trim();
  return s || null;
}

/**
 * 僅在裝置碼實際變更時回傳 update data（同碼重綁不遞增 dav，避免自登出）
 * @param {string|null|undefined} currentDeviceId
 * @param {string|null} nextDeviceId
 * @returns {{ deviceId: string|null, deviceAuthVersion: { increment: number } }|null}
 */
export function deviceBindUpdateIfChanged(currentDeviceId, nextDeviceId) {
  const cur = normalizeDeviceId(currentDeviceId);
  const next = normalizeDeviceId(nextDeviceId);
  if (cur === next) return null;
  return deviceBindUpdateData({ deviceId: next });
}

/** 發會員 JWT 用的裝置欄位 */
export function memberTokenDeviceOpts(member) {
  return {
    deviceId: member?.deviceId || null,
    deviceAuthVersion: Number(member?.deviceAuthVersion) || 0,
  };
}

/**
 * 會員已綁定裝置時：請求裝置碼必須吻合，否則拒絕（防改綁後舊機繼續用介面）
 * @returns {Promise<{ deviceId: string|null, deviceAuthVersion: number }>}
 */
export async function assertRequestMatchesBoundDevice(memberId, requestDeviceId) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, deviceId: true, deviceAuthVersion: true },
  });
  if (!member) {
    const err = new Error('找不到會員');
    err.statusCode = 404;
    throw err;
  }

  const bound = member.deviceId ? String(member.deviceId).trim() : '';
  const deviceAuthVersion = Number(member.deviceAuthVersion) || 0;
  if (!bound) {
    return { deviceId: null, deviceAuthVersion };
  }

  const did = String(requestDeviceId || '').trim();
  if (!did || did.length < 8) {
    const err = new Error('⛔ 請使用已綁定的裝置登入（缺少裝置識別）');
    err.statusCode = 403;
    err.code = 'DEVICE_REQUIRED';
    throw err;
  }
  if (did !== bound) {
    const err = new Error(
      '⛔ 此帳號已改綁其他裝置，舊裝置登入已失效，請重新以本機完成登入',
    );
    err.statusCode = 403;
    err.code = 'DEVICE_MISMATCH';
    throw err;
  }

  return { deviceId: bound, deviceAuthVersion };
}
