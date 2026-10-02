// middleware/staffDutyGate.js — 員工班表值勤海關：非值勤員工（ADMIN 除外）僅能使用自助路由，其餘業務 API 一律 403 OFF_DUTY
import jwt from 'jsonwebtoken';
import { getDutyStatusCached } from '../lib/attendanceService.js';
import { isKnownStaffRole } from '../lib/orgStructure.js';
import { isAdminUser } from '../lib/staffAccess.js';

/** 非值勤仍可用：登入／本人資訊、我的出勤（打卡／請假／班表／排假／薪資單）、通知，以及非員工路由 */
const OFF_DUTY_ALLOWED_PREFIXES = [
  '/api/admin/login',
  '/api/admin/me',
  '/api/staff/hr',
  '/api/staff/notifications',
  '/api/health',
  '/api/board',
  '/api/cms',
  '/api/gate',
  '/api/auth',
  '/api/onboarding',
  '/api/member',
];

const isAllowedPath = (path) => OFF_DUTY_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

/** 須掛在所有 API 路由之前；無員工憑證或憑證無效者放行，交由各路由 verifyStaff 處理 */
export async function staffDutyGate(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/api/') || isAllowedPath(path)) return next();
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return next();
  }
  if (decoded?.type !== 'staff' || !isKnownStaffRole(decoded.role) || isAdminUser(decoded)) return next();
  try {
    const duty = await getDutyStatusCached(decoded);
    if (duty.onDuty) return next();
    return res.status(403).json({
      status: 'error',
      code: 'OFF_DUTY',
      message: `⛔ 非班表值勤人員（${duty.message}）：僅可使用我的出勤／請假／班表／通知`,
      data: { duty },
    });
  } catch (error) {
    console.error('[staffDutyGate]', error.message);
    return res.status(503).json({ status: 'error', code: 'DUTY_CHECK_FAILED', message: '值勤狀態檢查失敗，請稍後再試' });
  }
}
