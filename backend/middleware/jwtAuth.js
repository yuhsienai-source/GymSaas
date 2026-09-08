// middleware/jwtAuth.js
import jwt from 'jsonwebtoken';
import { hasPermission, isAdminUser, hasDutyRankOrAbove } from '../lib/staffAccess.js';
import {
  assertRequestMatchesBoundDevice,
  readRequestDeviceId,
} from '../lib/memberDevice.js';

// 【會員端海關】
export const verifyMember = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      code: 'AUTH_REQUIRED',
      message: '⛔ 拒絕存取：缺少或無效的登入憑證',
    });
  }
  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🚨 拒絕員工 JWT 混入會員 API；舊 token 若無 type 亦擋下，強制重新 LINE 登入
    if (decoded.type !== 'member') {
      return res.status(403).json({
        status: 'error',
        code: 'AUTH_EXPIRED',
        message: '⛔ 權限不足：非會員憑證，請重新以 LINE 登入',
      });
    }

    if (!decoded.memberId) {
      return res.status(403).json({
        status: 'error',
        code: 'AUTH_EXPIRED',
        message: '⛔ 憑證異常：缺少 memberId',
      });
    }

    req.user = decoded;
    next();
  } catch (_error) {
    return res.status(403).json({
      status: 'error',
      code: 'AUTH_EXPIRED',
      message: '⛔ 登入憑證已過期或遭竄改',
    });
  }
};

/**
 * 接在 verifyMember 之後：已綁定裝置時強制本機 deviceId 吻合（改綁後舊機失效）
 * JWT 必須內嵌相同 deviceId 與 deviceAuthVersion（dav）
 */
export async function verifyMemberDevice(req, res, next) {
  try {
    const memberId = req.user?.memberId;
    if (!memberId) {
      return res.status(403).json({ status: 'error', message: '⛔ 憑證異常：缺少 memberId' });
    }

    const requestDeviceId = readRequestDeviceId(req);
    const { deviceId: bound, deviceAuthVersion } = await assertRequestMatchesBoundDevice(
      memberId,
      requestDeviceId,
    );

    // 世代不符（含舊票無 dav）：改綁／解除後舊 JWT 立即失效
    const tokenDav = req.user?.dav;
    const tokenDavNum = tokenDav === undefined || tokenDav === null ? null : Number(tokenDav);
    if (tokenDavNum === null || tokenDavNum !== deviceAuthVersion) {
      return res.status(403).json({
        status: 'error',
        code: 'DEVICE_MISMATCH',
        message: '⛔ 登入狀態已失效（裝置已改綁或需重新登入），請以本機重新登入',
      });
    }

    if (bound) {
      const tokenDevice =
        req.user?.deviceId != null ? String(req.user.deviceId).trim() : '';
      if (!tokenDevice || tokenDevice !== bound) {
        return res.status(403).json({
          status: 'error',
          code: 'DEVICE_MISMATCH',
          message: '⛔ 此帳號已改綁其他裝置或登入票已失效，請重新以本機完成登入',
        });
      }
    }

    next();
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      status: 'error',
      code: error.code || undefined,
      message: error.statusCode
        ? error.message
        : '裝置驗證失敗',
    });
  }
}

// 【廠館服務端 / 員工海關】
export const verifyStaff = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'error',
      code: 'AUTH_REQUIRED',
      message: '⛔ 拒絕存取：系統缺少員工憑證',
    });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🚨 第一道鎖：嚴格檢查憑證種類，拒絕一般會員的 JWT
    if (decoded.type !== 'staff') {
      return res.status(403).json({
        status: 'error',
        code: 'AUTH_EXPIRED',
        message: '⛔ 權限不足：非員工憑證，禁止存取後台',
      });
    }

    // 🚨 第二道鎖：檢查角色（含 DUTY 值星）
    if (
      decoded.role !== 'STAFF' &&
      decoded.role !== 'DUTY' &&
      decoded.role !== 'MANAGER' &&
      decoded.role !== 'ADMIN'
    ) {
      return res.status(403).json({
        status: 'error',
        code: 'AUTH_EXPIRED',
        message: '⛔ 權限異常：未知的員工角色',
      });
    }

    req.user = decoded; // 統一掛載為 req.user
    next();
  } catch (_error) {
    return res.status(403).json({
      status: 'error',
      code: 'AUTH_EXPIRED',
      message: '⛔ 員工憑證已過期或遭竄改',
    });
  }
};

/** 模組權限海關（須接在 verifyStaff 之後） */
export const requirePermission = (perm) => (req, res, next) => {
  if (!hasPermission(req.user, perm)) {
    return res.status(403).json({
      status: 'error',
      message: `⛔ 權限不足：需要「${perm}」模組權限`,
    });
  }
  next();
};

/** 任一模組權限即可（跨模組功能） */
export const requireAnyPermission = (...perms) => (req, res, next) => {
  if (isAdminUser(req.user) || perms.some((p) => hasPermission(req.user, p))) {
    return next();
  }
  return res.status(403).json({
    status: 'error',
    message: `⛔ 權限不足：需要以下模組之一：${perms.join('／')}`,
  });
};

/** DUTY（值星）以上職權（交易異動） */
export const requireDutyOrAbove = (req, res, next) => {
  if (!hasDutyRankOrAbove(req.user)) {
    return res.status(403).json({
      status: 'error',
      message: '⛔ 權限不足：交易異動僅限 DUTY（值星）以上職權',
    });
  }
  next();
};

/** 櫃檯 ops 或 DUTY 以上（訂單查詢）；教練僅 trainer 不可 */
export const requireOpsOrDuty = (req, res, next) => {
  if (
    isAdminUser(req.user) ||
    hasDutyRankOrAbove(req.user) ||
    hasPermission(req.user, 'ops')
  ) {
    return next();
  }
  return res.status(403).json({
    status: 'error',
    message: '⛔ 權限不足：訂單查詢僅限櫃檯（ops）或 DUTY 以上',
  });
};

// 【廠館維運端 / 店長專屬海關】
export const requireAdmin = (req, res, next) => {
  // 必須接在 verifyStaff 之後執行，此時 req.user 已經有資料
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ status: 'error', message: '⛔ 權限不足：限管理員操作' });
  }
  next();
};