// lib/staffLeaveBalance.js — 員工特休／國休額度（DB 查詢層；計算規則見 laborLaw.js）
import prisma from './prisma.js';
import {
  DAILY_HOURS,
  LEAVE_TYPE_KEYS,
  QUOTA_LEAVE_TYPES,
  addMonthsKey,
  computeLeaveBalances,
  dbDateKey,
  taipeiDateKey,
} from './laborLaw.js';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/** 以 staff 查詢時需帶出之勞動條件欄位 */
export const employmentSelect = {
  employmentType: true,
  hireDate: true,
  weeklyHours: true,
  laborActApplies: true,
};

async function holidayKeysForYears(years) {
  const ranges = years.map((y) => ({
    date: { gte: new Date(`${y}-01-01T00:00:00Z`), lte: new Date(`${y}-12-31T00:00:00Z`) },
  }));
  const rows = await prisma.publicHoliday.findMany({ where: { OR: ranges }, select: { date: true } });
  return rows.map((r) => dbDateKey(r.date));
}

async function quotaLeaves(staffIds, fromKey) {
  const rows = await prisma.staffLeave.findMany({
    where: {
      staffId: { in: staffIds },
      status: 'APPROVED',
      leaveType: { in: QUOTA_LEAVE_TYPES },
      startAt: { gte: new Date(`${fromKey}T00:00:00+08:00`) },
    },
    select: { id: true, staffId: true, leaveType: true, startAt: true, hours: true },
  });
  return rows.map((r) => ({ ...r, dateKey: taipeiDateKey(r.startAt) }));
}

/**
 * 批次計算員工假勤額度
 * @param {Array<{ id: number } & Record<string, unknown>>} staffRows 需含 employmentSelect 欄位
 * @returns {Promise<Map<number, ReturnType<typeof computeLeaveBalances>>>}
 */
export async function leaveBalancesFor(staffRows, todayKey = taipeiDateKey()) {
  const result = new Map();
  if (!staffRows.length) return result;
  const fromKey = `${addMonthsKey(todayKey, -13).slice(0, 4)}-01-01`;
  const [holidayKeys, leaves] = await Promise.all([
    holidayKeysForYears([todayKey.slice(0, 4)]),
    quotaLeaves(staffRows.map((s) => s.id), fromKey),
  ]);
  const byStaff = new Map();
  for (const l of leaves) {
    if (!byStaff.has(l.staffId)) byStaff.set(l.staffId, []);
    byStaff.get(l.staffId).push(l);
  }
  for (const s of staffRows) {
    result.set(s.id, computeLeaveBalances(s, { todayKey, holidayKeys, leaves: byStaff.get(s.id) || [] }));
  }
  return result;
}

export function normalizeLeaveType(raw) {
  const t = String(raw || 'OTHER').trim().toUpperCase();
  if (!LEAVE_TYPE_KEYS.includes(t)) throw httpError('假別無效');
  return t;
}

/** 請假時數：未填時同日取實際時數（上限 8），跨日以日曆天 × 8 */
export function resolveLeaveHours(startAt, endAt, rawHours) {
  if (rawHours !== undefined && rawHours !== null && rawHours !== '') {
    const h = Number(rawHours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 31) throw httpError('請假時數無效');
    return Math.round(h * 2) / 2;
  }
  const startKey = taipeiDateKey(startAt);
  const endKey = taipeiDateKey(new Date(endAt.getTime() - 1));
  if (startKey === endKey) {
    return Math.min(DAILY_HOURS, Math.round(((endAt - startAt) / 3600000) * 2) / 2);
  }
  const days = Math.round((Date.parse(`${endKey}T00:00:00Z`) - Date.parse(`${startKey}T00:00:00Z`)) / 86400000) + 1;
  return days * DAILY_HOURS;
}

/**
 * 核准／建立特休、國休前檢查額度（以請假起日所屬之特休年度／曆年計）
 * @param {{ staffId: number, leaveType: string, startAt: Date, hours: number, excludeLeaveId?: number }} opts
 */
export async function assertLeaveQuota({ staffId, leaveType, startAt, hours, excludeLeaveId }) {
  if (!QUOTA_LEAVE_TYPES.includes(leaveType)) return;
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, ...employmentSelect } });
  if (!staff) throw httpError('找不到此員工', 404);
  if (!staff.hireDate) throw httpError('此員工尚未設定到職日，無法計算特休／國休額度', 400, 'HIRE_DATE_REQUIRED');

  const onKey = taipeiDateKey(startAt);
  const fromKey = `${addMonthsKey(onKey, -13).slice(0, 4)}-01-01`;
  const [holidayKeys, leaves] = await Promise.all([
    holidayKeysForYears([onKey.slice(0, 4)]),
    quotaLeaves([staffId], fromKey),
  ]);
  const balance = computeLeaveBalances(staff, {
    todayKey: onKey,
    holidayKeys,
    leaves: leaves.filter((l) => l.id !== excludeLeaveId),
  });
  if (!balance.laborActApplies) {
    throw httpError('此實習員工無勞雇關係，不適用特休／國定假日', 400, 'LEAVE_NOT_APPLICABLE');
  }

  if (leaveType === 'ANNUAL') {
    const a = balance.annualLeave;
    if (!a?.eligible) {
      throw httpError(`到職未滿 6 個月，${a?.nextGrantDate ?? ''} 起始有特休`, 400, 'LEAVE_QUOTA_EXCEEDED');
    }
    const remain = a.entitledHours - a.usedHours;
    if (hours > remain + 1e-9) {
      throw httpError(`特休不足：本年度（${a.periodStart}～${a.periodEnd}）剩餘 ${remain} 小時`, 400, 'LEAVE_QUOTA_EXCEEDED');
    }
    return;
  }

  const n = balance.nationalHoliday;
  if (n?.entitledDays === null) return;
  const remainDays = (n?.entitledDays ?? 0) - (n?.usedDays ?? 0);
  if (hours / DAILY_HOURS > remainDays + 1e-9) {
    throw httpError(`國定假日排休不足：${n?.year} 年剩餘 ${remainDays} 日`, 400, 'LEAVE_QUOTA_EXCEEDED');
  }
}
