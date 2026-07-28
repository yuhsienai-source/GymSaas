// lib/gateDevice.js — 進出場閘機裝置綁定與金鑰驗證
import crypto from 'crypto';
import prisma from './prisma.js';
import { staffBranchLabel } from './branchLabel.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function normalizeDeviceCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

export function generateDeviceKey() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashDeviceKey(plainKey) {
  return crypto.createHash('sha256').update(String(plainKey || ''), 'utf8').digest('hex');
}

export function serializeGateDevice(row, { includePlainKey = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    branchId: row.branchId,
    branch: row.branch
      ? {
          id: row.branch.id,
          name: row.branch.name,
          code: row.branch.code || null,
        }
      : null,
    branchLabel: staffBranchLabel(row.branch) || row.branch?.name || `#${row.branchId}`,
    keyPrefix: row.keyPrefix || null,
    isActive: row.isActive,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(includePlainKey
      ? {
          deviceKey: includePlainKey,
          keyNote: '請立即複製裝置金鑰；離開後無法再查看完整金鑰',
        }
      : {}),
  };
}

/**
 * 以裝置代碼＋明文金鑰驗證；成功回傳裝置（含 branch）並更新 lastSeenAt
 */
export async function authenticateGateDevice({ deviceCode, deviceKey }, db = prisma) {
  const code = normalizeDeviceCode(deviceCode);
  const key = String(deviceKey || '').trim();
  if (!code || !key) {
    throw httpError('需提供 deviceCode 與 deviceKey', 400);
  }

  const device = await db.gateDevice.findUnique({
    where: { code },
    include: { branch: { select: { id: true, name: true, code: true, isActive: true } } },
  });
  if (!device || !device.isActive) {
    throw httpError('⛔ 閘機裝置不存在或已停用', 403);
  }
  if (!device.branch?.isActive) {
    throw httpError('⛔ 裝置所屬分店已停用', 403);
  }

  const expected = device.keyHash;
  const actual = hashDeviceKey(key);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError('⛔ 閘機裝置金鑰錯誤', 403);
  }

  const updated = await db.gateDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
    include: { branch: { select: { id: true, name: true, code: true, isActive: true } } },
  });

  return updated;
}

/**
 * 解析閘機請求的分店／裝置：
 * 優先 deviceCode+deviceKey；其次相容 body.branchId／GATE_BRANCH_ID
 * @returns {{ branchId: number, gateDeviceId: number|null, device: object|null }}
 */
export async function resolveGateContext(reqBody = {}, db = prisma) {
  const { deviceCode, deviceKey, branchId } = reqBody || {};

  if (deviceCode || deviceKey) {
    const device = await authenticateGateDevice({ deviceCode, deviceKey }, db);
    return {
      branchId: device.branchId,
      gateDeviceId: device.id,
      device,
    };
  }

  const fromBody =
    branchId !== undefined && branchId !== null && branchId !== ''
      ? Number(branchId)
      : null;
  const fromEnv = process.env.GATE_BRANCH_ID
    ? Number(process.env.GATE_BRANCH_ID)
    : null;
  const candidate =
    Number.isInteger(fromBody) && fromBody > 0
      ? fromBody
      : Number.isInteger(fromEnv) && fromEnv > 0
        ? fromEnv
        : null;

  if (!candidate) {
    throw httpError(
      '請使用已配對的閘機裝置（deviceCode＋deviceKey），或設定 branchId／GATE_BRANCH_ID',
      400,
    );
  }

  const branch = await db.branch.findFirst({
    where: { id: candidate, isActive: true },
    select: { id: true },
  });
  if (!branch) {
    throw httpError('閘機分店無效或已停用', 400);
  }

  return { branchId: branch.id, gateDeviceId: null, device: null };
}
