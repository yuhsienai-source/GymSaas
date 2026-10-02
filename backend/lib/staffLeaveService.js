// lib/staffLeaveService.js — 請假流程：申請／總部代登、狀態機、重疊與班表衝突、審核留痕
import prisma from './prisma.js';
import { LEAVE_TYPES, isDateKey, taipeiDateKey, addDaysKey } from './laborLaw.js';
import { assertLeaveQuota, employmentSelect, leaveBalancesFor, normalizeLeaveType, resolveLeaveHours } from './staffLeaveBalance.js';
import { EFFECTIVE_WORK_SLOT_WHERE, scheduleBrief } from './staffScheduleService.js';
import { notifyLeaveRequested, notifyLeaveReviewed } from './staffNotifyEvents.js';

export const LEAVE_STATUSES = {
  PENDING: '待審',
  APPROVED: '已核准',
  REJECTED: '已拒絕',
  CANCELLED: '已撤銷',
};
const ACTIVE_STATUSES = ['PENDING', 'APPROVED'];
const LEAVE_MAX_DAYS = 31;
const LIST_MAX_ROWS = 300;
const SELF_HISTORY_DAYS = 180;

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const staffSelect = { id: true, name: true, displayName: true, role: true, branchId: true };

function trimText(value, max = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function serializeLeave(row, conflicts = []) {
  return {
    id: row.id,
    staffId: row.staffId,
    staff: row.staff ?? null,
    leaveType: row.leaveType,
    leaveTypeLabel: LEAVE_TYPES[row.leaveType] ?? row.leaveType,
    startAt: row.startAt,
    endAt: row.endAt,
    hours: row.hours,
    reason: row.reason,
    status: row.status,
    statusLabel: LEAVE_STATUSES[row.status] ?? row.status,
    createdAt: row.createdAt,
    requestedBySelf: !row.createdByStaffId,
    review: row.reviewedAt
      ? { at: row.reviewedAt, byStaffId: row.reviewedByStaffId, note: row.reviewNote }
      : null,
    conflicts,
  };
}

/** 與請假時段重疊之已生效出勤班次（核准後須由店長撤回班表調整） */
async function conflictsFor(rows) {
  const targets = rows.filter((r) => ACTIVE_STATUSES.includes(r.status));
  const result = new Map();
  if (!targets.length) return result;
  const minStart = new Date(Math.min(...targets.map((r) => r.startAt.getTime())));
  const maxEnd = new Date(Math.max(...targets.map((r) => r.endAt.getTime())));
  const schedules = await prisma.staffSchedule.findMany({
    where: {
      AND: [
        EFFECTIVE_WORK_SLOT_WHERE,
        { staffId: { in: [...new Set(targets.map((r) => r.staffId))] }, startAt: { lt: maxEnd }, endAt: { gt: minStart } },
      ],
    },
    include: { rosterPeriod: { select: { status: true } } },
    orderBy: { startAt: 'asc' },
  });
  for (const r of targets) {
    result.set(
      r.id,
      schedules.filter((s) => s.staffId === r.staffId && s.startAt < r.endAt && s.endAt > r.startAt).map(scheduleBrief),
    );
  }
  return result;
}

function assertLeaveRange(startAt, endAt) {
  if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');
  if (endAt - startAt > LEAVE_MAX_DAYS * 86400000) throw httpError(`單筆請假最長 ${LEAVE_MAX_DAYS} 日，請分筆申請`);
}

async function assertNoLeaveOverlap(staffId, startAt, endAt, excludeId = null) {
  const overlap = await prisma.staffLeave.findFirst({
    where: {
      staffId,
      status: { in: ACTIVE_STATUSES },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, status: true },
  });
  if (overlap) {
    throw httpError(`與既有${LEAVE_STATUSES[overlap.status]}之請假時段重疊`, 409, 'LEAVE_OVERLAP');
  }
}

async function prepareLeave(staffId, input) {
  const startAt = input.startAt;
  const endAt = input.endAt;
  assertLeaveRange(startAt, endAt);
  const leaveType = normalizeLeaveType(input.leaveType);
  const hours = resolveLeaveHours(startAt, endAt, input.hours);
  await assertNoLeaveOverlap(staffId, startAt, endAt);
  await assertLeaveQuota({ staffId, leaveType, startAt, hours });
  return { startAt, endAt, leaveType, hours, reason: trimText(input.reason), proofUrl: trimText(input.proofUrl, 500) };
}

async function withConflicts(row) {
  const conflicts = await conflictsFor([row]);
  return serializeLeave(row, conflicts.get(row.id) ?? []);
}

/**
 * 總部請假清單：待審優先、其後依起日新到舊；附各狀態筆數與班表衝突
 */
export async function listLeaves({ status, staffId, branchId, from, to } = {}) {
  if (status && !LEAVE_STATUSES[status]) throw httpError('status 無效');
  const base = {};
  if (staffId) base.staffId = staffId;
  if (branchId) base.staff = { branchId };
  if (isDateKey(from)) base.endAt = { gt: new Date(`${from}T00:00:00+08:00`) };
  if (isDateKey(to)) base.startAt = { lt: new Date(`${addDaysKey(to, 1)}T00:00:00+08:00`) };

  const [rows, grouped] = await Promise.all([
    prisma.staffLeave.findMany({
      where: { ...base, ...(status ? { status } : {}) },
      include: { staff: { select: staffSelect } },
      orderBy: { startAt: 'desc' },
      take: LIST_MAX_ROWS,
    }),
    prisma.staffLeave.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(Object.keys(LEAVE_STATUSES).map((k) => [k, 0]));
  for (const g of grouped) counts[g.status] = g._count._all;

  const conflicts = await conflictsFor(rows);
  const sorted = [...rows].sort((a, b) => {
    const pa = a.status === 'PENDING' ? 0 : 1;
    const pb = b.status === 'PENDING' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return pa === 0 ? a.startAt - b.startAt : b.startAt - a.startAt;
  });
  return {
    counts,
    truncated: rows.length >= LIST_MAX_ROWS,
    rows: sorted.map((r) => serializeLeave(r, conflicts.get(r.id) ?? [])),
  };
}

/** 總部代登：直接核准並記錄經辦人 */
export async function createLeaveByHq(staffId, input, actorStaffId) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true } });
  if (!staff) throw httpError('找不到員工', 404);
  const data = await prepareLeave(staffId, input);
  const now = new Date();
  const row = await prisma.staffLeave.create({
    data: {
      staffId,
      ...data,
      status: 'APPROVED',
      createdByStaffId: actorStaffId ?? null,
      reviewedByStaffId: actorStaffId ?? null,
      reviewedAt: now,
      reviewNote: '總部代登',
    },
    include: { staff: { select: staffSelect } },
  });
  const leave = await withConflicts(row);
  void notifyLeaveReviewed(leave);
  return leave;
}

/** 員工本人申請（待審） */
export async function requestLeave(staffId, input) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { isActive: true } });
  if (!staff?.isActive) throw httpError('帳號已停用', 403);
  const data = await prepareLeave(staffId, input);
  const row = await prisma.staffLeave.create({
    data: { staffId, ...data, status: 'PENDING' },
    include: { staff: { select: staffSelect } },
  });
  const leave = await withConflicts(row);
  void notifyLeaveRequested(leave);
  return leave;
}

/**
 * 審核狀態機：PENDING → APPROVED｜REJECTED；APPROVED → CANCELLED（撤銷後額度回補）
 * 拒絕與撤銷必填原因；以條件式更新防並發重複審核
 */
export async function reviewLeave(id, { status, note, actorStaffId }) {
  const existing = await prisma.staffLeave.findUnique({ where: { id } });
  if (!existing) throw httpError('找不到請假紀錄', 404);
  const allowed = { PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['CANCELLED'] }[existing.status] ?? [];
  if (!allowed.includes(status)) {
    throw httpError(
      `${LEAVE_STATUSES[existing.status] ?? existing.status}之請假不可改為${LEAVE_STATUSES[status] ?? status}`,
      409,
      'LEAVE_STATE',
    );
  }
  const reviewNote = trimText(note);
  if (status !== 'APPROVED' && (!reviewNote || reviewNote.length < 2)) {
    throw httpError(status === 'REJECTED' ? '請填寫拒絕原因' : '請填寫撤銷原因', 400, 'REASON_REQUIRED');
  }
  if (status === 'APPROVED') {
    await assertNoLeaveOverlap(existing.staffId, existing.startAt, existing.endAt, existing.id);
    await assertLeaveQuota({
      staffId: existing.staffId,
      leaveType: existing.leaveType,
      startAt: existing.startAt,
      hours: existing.hours ?? resolveLeaveHours(existing.startAt, existing.endAt),
      excludeLeaveId: existing.id,
    });
  }
  const result = await prisma.staffLeave.updateMany({
    where: { id, status: existing.status },
    data: { status, reviewedByStaffId: actorStaffId ?? null, reviewedAt: new Date(), reviewNote },
  });
  if (!result.count) throw httpError('此請假已被他人處理，請重新整理', 409, 'LEAVE_STATE');
  const row = await prisma.staffLeave.findUnique({ where: { id }, include: { staff: { select: staffSelect } } });
  const leave = await withConflicts(row);
  void notifyLeaveReviewed(leave);
  return leave;
}

/** 我的請假：額度＋近 180 日與未來之申請 */
export async function getMyLeaves(staffId) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, ...employmentSelect } });
  if (!staff) throw httpError('找不到員工', 404);
  const since = new Date(`${addDaysKey(taipeiDateKey(), -SELF_HISTORY_DAYS)}T00:00:00+08:00`);
  const [balances, rows] = await Promise.all([
    leaveBalancesFor([staff]),
    prisma.staffLeave.findMany({
      where: { staffId, endAt: { gt: since } },
      orderBy: { startAt: 'desc' },
      take: 100,
    }),
  ]);
  const conflicts = await conflictsFor(rows);
  return {
    balance: balances.get(staffId) ?? null,
    leaveTypes: Object.entries(LEAVE_TYPES).map(([value, label]) => ({ value, label })),
    rows: rows.map((r) => serializeLeave(r, conflicts.get(r.id) ?? [])),
  };
}

/** 員工撤回：僅限本人待審中之申請 */
export async function cancelMyLeave(staffId, id) {
  const result = await prisma.staffLeave.updateMany({
    where: { id, staffId, status: 'PENDING' },
    data: { status: 'CANCELLED', reviewedAt: new Date(), reviewNote: '員工本人撤回' },
  });
  if (!result.count) throw httpError('僅能撤回本人待審中之請假', 409, 'LEAVE_STATE');
}

/** 月報（台北時間）：與該月重疊之已核准／待審請假 */
export async function leaveMonthReport(month) {
  const key = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : taipeiDateKey().slice(0, 7);
  const [y, m] = key.split('-').map(Number);
  const start = new Date(`${key}-01T00:00:00+08:00`);
  const nextKey = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const end = new Date(`${nextKey}-01T00:00:00+08:00`);
  const rows = await prisma.staffLeave.findMany({
    where: { startAt: { lt: end }, endAt: { gt: start }, status: { in: ACTIVE_STATUSES } },
    include: { staff: { select: staffSelect } },
    orderBy: { startAt: 'asc' },
  });
  return { month: key, items: rows.map((r) => serializeLeave(r)) };
}
