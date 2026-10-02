// lib/staffScheduleService.js — 總部班表總覽：彙整四週排班／週班表（教練＋管理職）／總部臨時排班
import prisma from './prisma.js';
import { addDaysKey, dbDateKey, diffDaysKey, isDateKey, taipeiDateKey } from './laborLaw.js';
import { COACH_PLAN_STATUSES, weekPlanRoleOf } from './coachSchedule.js';
import { canonicalRole } from './orgStructure.js';
import { OFF_CODES, ROSTER_ROLE_LABELS, ROSTER_SHIFTS, isRosterEligible, rosterRoleOf } from './shiftRoster.js';

/** ROSTER＝四週排班（僅能於分店班表編修）；FREE＝週班表（轉正教練 → FM／店長核准；店長／GM／FM → ADMIN 核准）；MANUAL＝總部臨時指派 */
export const SCHEDULE_SOURCES = {
  ROSTER: '四週排班',
  FREE: '週班表',
  MANUAL: '總部臨時排班',
};

export const OVERVIEW_DEFAULT_DAYS = 14;
export const OVERVIEW_MAX_DAYS = 62;
export const MANUAL_SLOT_MAX_HOURS = 12;
const OVERVIEW_MAX_ROWS = 1000;
const OFF_SLOT_TYPES = Object.keys(OFF_CODES);
const WORK_SLOT_TYPES = ['SHIFT', 'FREE'];

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const staffSelect = {
  id: true,
  name: true,
  displayName: true,
  role: true,
  employmentType: true,
  branchId: true,
  isActive: true,
};

const scheduleInclude = {
  staff: { select: staffSelect },
  rosterPeriod: { select: { id: true, status: true, startDate: true } },
  coachPlan: { select: { id: true, status: true } },
};

export function scheduleSourceOf(row) {
  if (row.rosterPeriodId) return 'ROSTER';
  if (row.coachPlanId || row.slotType === 'FREE') return 'FREE';
  return 'MANUAL';
}

function slotLabel(row, source) {
  if (OFF_CODES[row.slotType]) return OFF_CODES[row.slotType].label;
  if (source === 'ROSTER') return ROSTER_SHIFTS[row.shiftCode]?.label || '出勤';
  return source === 'FREE' ? '週班表' : '臨時排班';
}

/** 考勤／請假比對用之班次摘要 */
export function scheduleBrief(row) {
  const source = scheduleSourceOf(row);
  return {
    id: row.id,
    branchId: row.branchId,
    startAt: row.startAt,
    endAt: row.endAt,
    label: slotLabel(row, source),
    source,
  };
}

/** 已生效之班表列：已發布四週排班、已核准週班表、總部臨時排班（舊版自排列無 coachPlanId 仍計） */
export const EFFECTIVE_SCHEDULE_OR = [
  { rosterPeriodId: null, coachPlanId: null },
  { rosterPeriod: { status: 'PUBLISHED' } },
  { coachPlan: { status: 'APPROVED' } },
];

/** 已生效之出勤班次（不含草稿／待審與例休格） */
export const EFFECTIVE_WORK_SLOT_WHERE = {
  slotType: { in: WORK_SLOT_TYPES },
  OR: EFFECTIVE_SCHEDULE_OR,
};

function serializeSchedule(row) {
  const source = scheduleSourceOf(row);
  const rosterRole = rosterRoleOf(row.staff);
  return {
    id: row.id,
    staffId: row.staffId,
    staff: row.staff
      ? {
          id: row.staff.id,
          name: row.staff.name,
          displayName: row.staff.displayName,
          role: row.staff.role,
          employmentType: row.staff.employmentType,
          rosterRoleLabel: rosterRole ? ROSTER_ROLE_LABELS[rosterRole] : null,
        }
      : null,
    branchId: row.branchId,
    dateKey: row.workDate ? dbDateKey(row.workDate) : taipeiDateKey(row.startAt),
    startAt: row.startAt,
    endAt: row.endAt,
    slotType: row.slotType,
    shiftCode: row.shiftCode,
    isOff: OFF_SLOT_TYPES.includes(row.slotType),
    label: slotLabel(row, source),
    note: row.note,
    source,
    sourceLabel: SCHEDULE_SOURCES[source],
    rosterPeriodId: row.rosterPeriodId,
    rosterStatus: row.rosterPeriod?.status ?? null,
    coachPlanId: row.coachPlanId ?? null,
    coachPlanStatus: row.coachPlan?.status ?? null,
    coachPlanStatusLabel: row.coachPlan ? COACH_PLAN_STATUSES[row.coachPlan.status] : null,
    editable: source === 'MANUAL',
    deletable: source === 'MANUAL',
  };
}

function sourceWhere(source) {
  if (source === 'ROSTER') return { rosterPeriodId: { not: null } };
  if (source === 'FREE') return { rosterPeriodId: null, OR: [{ coachPlanId: { not: null } }, { slotType: 'FREE' }] };
  if (source === 'MANUAL') return { rosterPeriodId: null, coachPlanId: null, slotType: { not: 'FREE' } };
  return {};
}

/**
 * 區間內班表（台北日期，含首尾）。預設今日起 14 日、隱藏例假／休息日／排休格。
 */
export async function listScheduleOverview({ from, to, branchId, staffId, source, includeOff = false } = {}) {
  const fromKey = isDateKey(from) ? from : taipeiDateKey();
  const toKey = isDateKey(to) ? to : addDaysKey(fromKey, OVERVIEW_DEFAULT_DAYS - 1);
  const span = diffDaysKey(fromKey, toKey);
  if (span < 0) throw httpError('迄日不得早於起日');
  if (span >= OVERVIEW_MAX_DAYS) throw httpError(`查詢區間最多 ${OVERVIEW_MAX_DAYS} 日`);
  if (source && !SCHEDULE_SOURCES[source]) throw httpError('source 無效');

  const where = {
    startAt: {
      gte: new Date(`${fromKey}T00:00:00+08:00`),
      lt: new Date(`${addDaysKey(toKey, 1)}T00:00:00+08:00`),
    },
    ...sourceWhere(source),
  };
  if (branchId) where.branchId = branchId;
  if (staffId) where.staffId = staffId;
  if (!includeOff) {
    where.AND = [{ slotType: { notIn: OFF_SLOT_TYPES } }];
  }

  const rows = await prisma.staffSchedule.findMany({
    where,
    include: scheduleInclude,
    orderBy: [{ startAt: 'asc' }, { staffId: 'asc' }],
    take: OVERVIEW_MAX_ROWS + 1,
  });
  const truncated = rows.length > OVERVIEW_MAX_ROWS;
  return {
    from: fromKey,
    to: toKey,
    truncated,
    rows: rows.slice(0, OVERVIEW_MAX_ROWS).map(serializeSchedule),
  };
}

async function assertSlotAvailable({ staffId, startAt, endAt, excludeId = null }) {
  const overlap = await prisma.staffSchedule.findFirst({
    where: {
      staffId,
      slotType: { in: WORK_SLOT_TYPES },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (overlap) throw httpError('與該員工既有排班時段重疊', 409, 'SCHEDULE_OVERLAP');

  const leave = await prisma.staffLeave.findFirst({
    where: { staffId, status: 'APPROVED', startAt: { lt: endAt }, endAt: { gt: startAt } },
    select: { id: true },
  });
  if (leave) throw httpError('該時段員工已有核准之請假', 409, 'LEAVE_CONFLICT');
}

function assertSlotRange(startAt, endAt) {
  if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');
  if (endAt - startAt > MANUAL_SLOT_MAX_HOURS * 3600000) {
    throw httpError(`單次排班不得超過 ${MANUAL_SLOT_MAX_HOURS} 小時（含延長工時，§32）`);
  }
}

async function resolveBranchId(branchId, fallback) {
  const id = branchId ?? fallback ?? null;
  if (!id) return null;
  const branch = await prisma.branch.findUnique({ where: { id }, select: { id: true } });
  if (!branch) throw httpError('分店不存在', 404);
  return id;
}

/** 總部臨時指派：場務／實習教練走分店四週排班、轉正教練與店長／GM／FM 走週班表、ADMIN 免排班，現無適用對象（僅留防線；既有臨時班次可改／刪） */
export async function createManualSchedule({ staffId, branchId, startAt, endAt, note, actorStaffId }) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: staffSelect });
  if (!staff) throw httpError('找不到員工', 404);
  if (!staff.isActive) throw httpError('員工已停用', 409);
  if (isRosterEligible(staff)) {
    throw httpError('場務與實習教練須於「四週排班」安排，不得臨時指派', 409, 'USE_ROSTER');
  }
  const planRole = weekPlanRoleOf(staff);
  if (planRole === 'COACH') {
    throw httpError('轉正教練須由本人提報週班表、經 FM 或店長核准，不得臨時指派', 409, 'USE_COACH_PLAN');
  }
  if (planRole === 'MANAGER') {
    throw httpError('店長／GM／FM 須由本人提報週班表、經總公司核准，不得臨時指派', 409, 'USE_WEEK_PLAN');
  }
  if (canonicalRole(staff.role) === 'ADMIN') {
    throw httpError('總公司帳號免排班', 409, 'SCHEDULE_EXEMPT');
  }
  assertSlotRange(startAt, endAt);
  await assertSlotAvailable({ staffId, startAt, endAt });
  const row = await prisma.staffSchedule.create({
    data: {
      staffId,
      branchId: await resolveBranchId(branchId, staff.branchId),
      startAt,
      endAt,
      slotType: 'SHIFT',
      note: note ? String(note).slice(0, 200) : null,
      createdByStaffId: actorStaffId ?? null,
    },
    include: scheduleInclude,
  });
  return serializeSchedule(row);
}

async function loadMutable(id) {
  const row = await prisma.staffSchedule.findUnique({ where: { id }, include: scheduleInclude });
  if (!row) throw httpError('找不到排班', 404);
  if (row.rosterPeriodId) {
    throw httpError('四週排班之班次請至「場務排班」編修（已發布須先撤回）', 409, 'ROSTER_MANAGED');
  }
  if (row.coachPlanId || row.slotType === 'FREE') {
    throw httpError('週班表由本人提報、審核主管核准；如需調整請由審核主管撤回核准', 409, 'COACH_PLAN_MANAGED');
  }
  return row;
}

export async function updateManualSchedule(id, { startAt, endAt, branchId, note }) {
  const row = await loadMutable(id);
  const nextStart = startAt ?? row.startAt;
  const nextEnd = endAt ?? row.endAt;
  assertSlotRange(nextStart, nextEnd);
  if (startAt || endAt) {
    await assertSlotAvailable({ staffId: row.staffId, startAt: nextStart, endAt: nextEnd, excludeId: id });
  }
  const data = { startAt: nextStart, endAt: nextEnd };
  if (branchId !== undefined) data.branchId = await resolveBranchId(branchId, null);
  if (note !== undefined) data.note = note ? String(note).slice(0, 200) : null;
  const updated = await prisma.staffSchedule.update({ where: { id }, data, include: scheduleInclude });
  return serializeSchedule(updated);
}

export async function deleteManualSchedule(id) {
  await loadMutable(id);
  await prisma.staffSchedule.delete({ where: { id } });
}
