// lib/coachScheduleService.js — 週班表（轉正教練＋店長／GM／FM）：本人提報／送審／撤回；審核者核准／退回／撤回核准
/**
 * - 對象見 weekPlanRoleOf：轉正教練（COACH）、店長／GM／FM（MANAGER）；場務與實習教練走四週排班，ADMIN 免排班。
 * - 班表列存於 StaffSchedule（出勤 FREE、例假 REGULAR_OFF、休息日 REST_DAY，coachPlanId 關聯），僅 APPROVED 生效。
 * - 送審與核准皆以 lib/coachSchedule.js 重新檢查，有 ERROR 一律拒絕（409 COACH_PLAN_INVALID）。
 * - 審核鏈：教練 → FM 或督導該分店之店長（ADMIN 可代審）；店長／GM／FM → ADMIN；不得審核本人。
 * - 已核准班表須由審核者撤回（附原因）才可修改；已結束之週次不可撤回。
 */
import prisma from './prisma.js';
import { lockStaffRow } from './dbLocks.js';
import { addDaysKey, dbDateKey, taipeiDateKey } from './laborLaw.js';
import { canonicalRole } from './orgStructure.js';
import { canAccessBranch, isAdminUser, staffBranchIds } from './staffAccess.js';
import { evictDutyCache } from './attendanceService.js';
import {
  COACH_PLAN_STATUSES,
  COACH_WEEK_RULES,
  MANAGER_PLAN_POSITIONS,
  WEEK_PLAN_ROLES,
  assertWeekStart,
  evaluateCoachWeek,
  normalizeCoachWeekInput,
  slotFromRange,
  slotRange,
  weekDays,
  weekPlanRoleOf,
  weekStartOf,
} from './coachSchedule.js';
import { notifyCoachPlanReviewed, notifyCoachPlanSubmitted } from './staffNotifyEvents.js';

const TX_OPTS = { timeout: 20_000, maxWait: 10_000 };
const REVIEW_LIST_MAX = 200;

function httpError(message, statusCode = 400, code, data) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

const dateOf = (key) => new Date(`${key}T00:00:00Z`);
const dayStartAt = (key) => new Date(`${key}T00:00:00+08:00`);

const coachSelect = {
  id: true,
  name: true,
  displayName: true,
  role: true,
  branchId: true,
  isActive: true,
  employmentType: true,
  weeklyHours: true,
  laborActApplies: true,
  trainerProfile: { select: { id: true, branches: { select: { branchId: true } } } },
};

async function loadPlanner(staffId, db = prisma) {
  const staff = await db.staff.findUnique({ where: { id: staffId }, select: coachSelect });
  if (!staff?.isActive) throw httpError('帳號已停用', 403);
  const planRole = weekPlanRoleOf(staff);
  if (!planRole) {
    throw httpError(
      canonicalRole(staff.role) === 'ADMIN'
        ? '總公司帳號免排班'
        : '週班表僅適用轉正教練與店長／GM／FM；場務與實習教練依分店四週排班',
      403,
      'COACH_PLAN_NOT_ALLOWED',
    );
  }
  return { ...staff, planRole };
}

/**
 * 可排出勤之分店：教練＝所屬＋授課分店；店長＝本店＋啟用中隸屬分店；GM／FM＝全部啟用分店（亦可不指定分店＝總部）
 */
async function allowedBranchIds(staff, db = prisma) {
  const role = canonicalRole(staff.role);
  if (staff.planRole === 'COACH') {
    return new Set([staff.branchId, ...(staff.trainerProfile?.branches ?? []).map((b) => b.branchId)].filter(Boolean));
  }
  if (role === 'GM' || role === 'FM') {
    const rows = await db.branch.findMany({ where: { isActive: true }, select: { id: true } });
    return new Set(rows.map((b) => b.id));
  }
  if (!staff.branchId) return new Set();
  const children = await db.branch.findMany({ where: { parentId: staff.branchId, isActive: true }, select: { id: true } });
  return new Set([staff.branchId, ...children.map((b) => b.id)]);
}

const allowsHqSlot = (staff) => ['GM', 'FM'].includes(canonicalRole(staff.role));

const planRoleMeta = (planRole) => ({
  planRole,
  planRoleLabel: WEEK_PLAN_ROLES[planRole]?.label ?? null,
  approverLabel: WEEK_PLAN_ROLES[planRole]?.approverLabel ?? null,
});

const COACH_STAFF_ROLES = ['TRAINER'];
const MANAGER_STAFF_ROLES = [...MANAGER_PLAN_POSITIONS, 'MANAGER'];
const planRoleOfStaffRole = (role) =>
  canonicalRole(role) === 'TRAINER' ? 'COACH' : MANAGER_PLAN_POSITIONS.includes(canonicalRole(role)) ? 'MANAGER' : null;

/**
 * 審核權限（純判斷）：教練 → FM、督導該分店之店長或 ADMIN；管理職 → 僅 ADMIN；一律不得審本人
 * @param {{ id:number, role:string, branchId?:number, branchIds?:number[] }} reviewer 員工 JWT
 * @param {{ staffId:number, planRole:'COACH'|'MANAGER'|null, branchId:number|null }} plan
 */
export function canReviewWeekPlan(reviewer, plan) {
  if (!reviewer || !plan?.planRole || plan.staffId === reviewer.id) return false;
  if (isAdminUser(reviewer)) return true;
  if (plan.planRole !== 'COACH') return false;
  const role = canonicalRole(reviewer.role);
  if (role === 'FM') return true;
  if (role === 'STORE_MANAGER') return plan.branchId != null && canAccessBranch(reviewer, plan.branchId);
  return false;
}

/** 審核者可見範圍：null＝無審核權 */
function reviewScope(reviewer) {
  if (isAdminUser(reviewer)) return { kinds: ['COACH', 'MANAGER'], branchIds: null };
  const role = canonicalRole(reviewer?.role);
  if (role === 'FM') return { kinds: ['COACH'], branchIds: null };
  if (role === 'STORE_MANAGER') return { kinds: ['COACH'], branchIds: staffBranchIds(reviewer) };
  return null;
}

export function canReviewAnyWeekPlan(reviewer) {
  return reviewScope(reviewer) !== null;
}

function planWindow(todayKey = taipeiDateKey()) {
  const first = weekStartOf(todayKey);
  return { first, last: addDaysKey(first, (COACH_WEEK_RULES.planAheadWeeks - 1) * 7), todayKey };
}

function assertEditableWeek(weekStart, todayKey) {
  const { first, last } = planWindow(todayKey);
  if (weekStart < first) throw httpError('已結束之週次不可修改', 409, 'COACH_PLAN_PAST');
  if (weekStart > last) throw httpError(`僅可提報 ${COACH_WEEK_RULES.planAheadWeeks} 週內之班表`);
}

const isCountableSlot = (r) =>
  (r.coachPlanId == null && r.rosterPeriodId == null) ||
  r.rosterPeriod?.status === 'PUBLISHED' ||
  ['SUBMITTED', 'APPROVED'].includes(r.coachPlan?.status);

/** 檢查所需事實：國定假日、核准請假、教練課程、前後週出勤 */
async function loadContext(staff, fromKey, toKey) {
  const start = dayStartAt(addDaysKey(fromKey, -7));
  const end = dayStartAt(addDaysKey(toKey, 15));
  const [holidays, leaves, classes, workRows] = await Promise.all([
    prisma.publicHoliday.findMany({
      where: { date: { gte: dateOf(fromKey), lte: dateOf(addDaysKey(toKey, 6)) } },
      select: { date: true, name: true },
    }),
    prisma.staffLeave.findMany({
      where: { staffId: staff.id, status: 'APPROVED', startAt: { lt: end }, endAt: { gt: start } },
      select: { startAt: true, endAt: true },
    }),
    staff.trainerProfile
      ? prisma.class.findMany({
          where: { trainerId: staff.trainerProfile.id, startAt: { gte: start, lt: end } },
          select: { id: true, title: true, type: true, startAt: true, endAt: true },
          orderBy: { startAt: 'asc' },
        })
      : [],
    prisma.staffSchedule.findMany({
      where: { staffId: staff.id, slotType: { in: ['SHIFT', 'FREE'] }, startAt: { gte: start, lt: end } },
      select: {
        startAt: true,
        endAt: true,
        coachPlanId: true,
        rosterPeriodId: true,
        coachPlan: { select: { status: true } },
        rosterPeriod: { select: { status: true } },
      },
    }),
  ]);
  return {
    holidayNames: new Map(holidays.map((h) => [dbDateKey(h.date), h.name])),
    leaves,
    classes,
    workRows,
  };
}

function evaluateWeek(staff, weekStart, plan, ctx) {
  const weekFrom = dayStartAt(weekStart);
  const weekTo = dayStartAt(addDaysKey(weekStart, 7));
  const others = ctx.workRows.filter((r) => (plan.id ? r.coachPlanId !== plan.id : true) && isCountableSlot(r));
  const prevKey = addDaysKey(weekStart, -1);
  const nextKey = addDaysKey(weekStart, 7);
  let prevDayLastEnd = null;
  let nextDayFirstStart = null;
  const neighborWorkDates = new Set();
  for (const r of others) {
    const key = taipeiDateKey(r.startAt);
    neighborWorkDates.add(key);
    if (key === prevKey && (!prevDayLastEnd || r.endAt > prevDayLastEnd)) prevDayLastEnd = r.endAt;
    if (key === nextKey && (!nextDayFirstStart || r.startAt < nextDayFirstStart)) nextDayFirstStart = r.startAt;
  }
  return evaluateCoachWeek({
    staff,
    weekStart,
    regularOffDate: plan.regularOffDate,
    restDayDate: plan.restDayDate,
    slots: plan.slots,
    holidayNames: ctx.holidayNames,
    leaves: ctx.leaves.filter((l) => l.startAt < weekTo && l.endAt > weekFrom),
    classes: ctx.classes.filter((c) => c.startAt < weekTo && c.endAt > weekFrom),
    neighborWorkDates,
    prevDayLastEnd,
    nextDayFirstStart,
  });
}

const planInclude = {
  staff: { select: { id: true, name: true, displayName: true, employmentType: true, role: true } },
  slots: { orderBy: { startAt: 'asc' }, select: { id: true, slotType: true, startAt: true, endAt: true, branchId: true } },
};

function planShape(row) {
  return {
    id: row.id,
    regularOffDate: row.regularOffDate ? dbDateKey(row.regularOffDate) : null,
    restDayDate: row.restDayDate ? dbDateKey(row.restDayDate) : null,
    slots: row.slots
      .filter((s) => s.slotType === 'FREE')
      .map((s) => ({ ...slotFromRange(s.startAt, s.endAt), branchId: s.branchId })),
  };
}

function serializePlan(row, weekStart, evaluation, { reviewerNames = new Map(), classes = [] } = {}) {
  const shape = row ? planShape(row) : { id: null, regularOffDate: null, restDayDate: null, slots: [] };
  const status = row?.status ?? null;
  const weekTo = dayStartAt(addDaysKey(weekStart, 7));
  const weekFrom = dayStartAt(weekStart);
  return {
    id: row?.id ?? null,
    staffId: row?.staffId ?? null,
    staff: row?.staff ? { id: row.staff.id, name: row.staff.name, displayName: row.staff.displayName } : null,
    staffRole: row?.staff?.role ? canonicalRole(row.staff.role) : null,
    planRole: row?.staff?.role ? planRoleOfStaffRole(row.staff.role) : null,
    branchId: row?.branchId ?? null,
    weekStart,
    weekEnd: addDaysKey(weekStart, 6),
    status,
    statusLabel: status ? COACH_PLAN_STATUSES[status] : '未提報',
    regularOffDate: shape.regularOffDate,
    restDayDate: shape.restDayDate,
    slots: shape.slots,
    note: row?.note ?? null,
    submittedAt: row?.submittedAt ?? null,
    reviewedAt: row?.reviewedAt ?? null,
    reviewedBy: row?.reviewedByStaffId ? { id: row.reviewedByStaffId, name: reviewerNames.get(row.reviewedByStaffId) ?? null } : null,
    reviewNote: row?.reviewNote ?? null,
    history: Array.isArray(row?.history) ? row.history : [],
    editable: !status || status === 'DRAFT' || status === 'REJECTED',
    classes: classes
      .filter((c) => c.startAt < weekTo && c.endAt > weekFrom)
      .map((c) => ({ id: c.id, title: c.title, type: c.type, ...slotFromRange(c.startAt, c.endAt) })),
    evaluation,
  };
}

async function reviewerNameMap(rows) {
  const ids = [...new Set(rows.map((r) => r?.reviewedByStaffId).filter(Boolean))];
  if (!ids.length) return new Map();
  const staff = await prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(staff.map((s) => [s.id, s.name]));
}

function pushHistory(row, entry) {
  const list = Array.isArray(row?.history) ? row.history : [];
  return [...list, { at: new Date().toISOString(), ...entry }].slice(-50);
}

// ── 本人（教練／管理職）──────────────────────────────

export const COACH_PLAN_META = {
  rules: COACH_WEEK_RULES,
  statuses: COACH_PLAN_STATUSES,
  planRoles: WEEK_PLAN_ROLES,
};

export async function getMyCoachPlans(staffId) {
  const staff = await loadPlanner(staffId);
  const { first, last, todayKey } = planWindow();
  const allowed = await allowedBranchIds(staff);
  const [rows, ctx, branches] = await Promise.all([
    prisma.coachWeekPlan.findMany({
      where: { staffId, weekStart: { gte: dateOf(first), lte: dateOf(last) } },
      include: planInclude,
    }),
    loadContext(staff, first, last),
    prisma.branch.findMany({ where: { id: { in: [...allowed] } }, select: { id: true, name: true }, orderBy: { id: 'asc' } }),
  ]);
  const byWeek = new Map(rows.map((r) => [dbDateKey(r.weekStart), r]));
  const reviewerNames = await reviewerNameMap(rows);
  const weeks = [];
  for (let key = first; key <= last; key = addDaysKey(key, 7)) {
    const row = byWeek.get(key) ?? null;
    const evaluation = row ? evaluateWeek(staff, key, planShape(row), ctx) : null;
    weeks.push({
      ...serializePlan(row, key, evaluation, { reviewerNames, classes: ctx.classes }),
      holidays: weekDays(key)
        .filter((d) => ctx.holidayNames.has(d))
        .map((d) => ({ date: d, name: ctx.holidayNames.get(d) })),
    });
  }
  return {
    ...COACH_PLAN_META,
    ...planRoleMeta(staff.planRole),
    today: todayKey,
    staff: {
      id: staff.id,
      name: staff.name,
      role: canonicalRole(staff.role),
      employmentType: staff.employmentType,
      weeklyHours: staff.weeklyHours,
    },
    branches,
    defaultBranchId: staff.branchId,
    allowNoBranch: allowsHqSlot(staff),
    weeks,
  };
}

/** 儲存草稿（新建／草稿／已退回可改）；過去日期之出勤不得增刪 */
export async function saveMyCoachPlan(staffId, weekStartRaw, body) {
  const weekStart = assertWeekStart(weekStartRaw);
  const todayKey = taipeiDateKey();
  assertEditableWeek(weekStart, todayKey);
  const input = normalizeCoachWeekInput(weekStart, body || {});
  const note = body?.note ? String(body.note).trim().slice(0, 200) || null : null;

  await prisma.$transaction(async (tx) => {
    await lockStaffRow(tx, staffId);
    const staff = await loadPlanner(staffId, tx);
    const allowed = await allowedBranchIds(staff, tx);
    for (const s of input.slots) {
      if (s.branchId && !allowed.has(s.branchId)) {
        throw httpError(staff.planRole === 'COACH' ? '出勤分店須為所屬或授課分店' : '出勤分店須為本店或督導分店', 403);
      }
    }
    const existing = await tx.coachWeekPlan.findUnique({
      where: { staffId_weekStart: { staffId, weekStart: dateOf(weekStart) } },
      include: planInclude,
    });
    if (existing && !['DRAFT', 'REJECTED'].includes(existing.status)) {
      throw httpError(
        existing.status === 'SUBMITTED' ? '班表審核中，請先撤回送審再修改' : '班表已核准，需由審核主管撤回核准後才可修改',
        409,
        'COACH_PLAN_LOCKED',
      );
    }
    const sig = (list) => list.filter((s) => s.date < todayKey).map((s) => `${s.date} ${s.start}-${s.end}`).sort().join('|');
    if (sig(input.slots) !== sig(existing ? planShape(existing).slots : [])) {
      throw httpError('不可增刪或修改已過日期之出勤時段', 409, 'COACH_PLAN_PAST');
    }

    const plan = existing
      ? await tx.coachWeekPlan.update({
          where: { id: existing.id },
          data: {
            status: 'DRAFT',
            branchId: staff.branchId,
            regularOffDate: input.regularOffDate ? dateOf(input.regularOffDate) : null,
            restDayDate: input.restDayDate ? dateOf(input.restDayDate) : null,
            note,
          },
        })
      : await tx.coachWeekPlan.create({
          data: {
            staffId,
            branchId: staff.branchId,
            weekStart: dateOf(weekStart),
            regularOffDate: input.regularOffDate ? dateOf(input.regularOffDate) : null,
            restDayDate: input.restDayDate ? dateOf(input.restDayDate) : null,
            note,
          },
        });
    await tx.staffSchedule.deleteMany({ where: { coachPlanId: plan.id } });
    const rows = input.slots.map((s) => ({
      staffId,
      branchId: s.branchId ?? staff.branchId ?? null,
      ...slotRange(s.date, s.start, s.end),
      slotType: 'FREE',
      workDate: dateOf(s.date),
      coachPlanId: plan.id,
    }));
    const offDays = [['REGULAR_OFF', input.regularOffDate]];
    if (input.restDayDate !== input.regularOffDate) offDays.push(['REST_DAY', input.restDayDate]);
    for (const [code, key] of offDays) {
      if (!key) continue;
      rows.push({
        staffId,
        branchId: staff.branchId ?? null,
        startAt: dayStartAt(key),
        endAt: dayStartAt(addDaysKey(key, 1)),
        slotType: code,
        workDate: dateOf(key),
        coachPlanId: plan.id,
      });
    }
    if (rows.length) await tx.staffSchedule.createMany({ data: rows });
  }, TX_OPTS);

  return getMyCoachPlanWeek(staffId, weekStart);
}

async function getMyCoachPlanWeek(staffId, weekStart) {
  const staff = await loadPlanner(staffId);
  const row = await prisma.coachWeekPlan.findUnique({
    where: { staffId_weekStart: { staffId, weekStart: dateOf(weekStart) } },
    include: planInclude,
  });
  const ctx = await loadContext(staff, weekStart, weekStart);
  const evaluation = row ? evaluateWeek(staff, weekStart, planShape(row), ctx) : null;
  return serializePlan(row, weekStart, evaluation, { reviewerNames: await reviewerNameMap([row]), classes: ctx.classes });
}

async function evaluateRow(row, db = prisma) {
  const weekStart = dbDateKey(row.weekStart);
  const staff = await db.staff.findUnique({ where: { id: row.staffId }, select: coachSelect });
  const ctx = await loadContext(staff, weekStart, weekStart);
  return { staff, weekStart, evaluation: evaluateWeek(staff, weekStart, planShape(row), ctx) };
}

export async function submitMyCoachPlan(staffId, weekStartRaw) {
  const weekStart = assertWeekStart(weekStartRaw);
  assertEditableWeek(weekStart, taipeiDateKey());
  let planRole = null;
  const plan = await prisma.$transaction(async (tx) => {
    await lockStaffRow(tx, staffId);
    ({ planRole } = await loadPlanner(staffId, tx));
    const row = await tx.coachWeekPlan.findUnique({
      where: { staffId_weekStart: { staffId, weekStart: dateOf(weekStart) } },
      include: planInclude,
    });
    if (!row) throw httpError('請先儲存班表', 404);
    if (!['DRAFT', 'REJECTED'].includes(row.status)) throw httpError(`班表${COACH_PLAN_STATUSES[row.status]}，不可重複送審`, 409, 'COACH_PLAN_LOCKED');
    const { evaluation } = await evaluateRow(row, tx);
    if (evaluation.hasError) {
      throw httpError('班表未符合勞基法工時規定，請依檢查結果修正', 409, 'COACH_PLAN_INVALID', { issues: evaluation.issues });
    }
    const now = new Date();
    return tx.coachWeekPlan.update({
      where: { id: row.id },
      data: {
        status: 'SUBMITTED',
        submittedAt: now,
        reviewNote: null,
        history: pushHistory(row, { action: 'SUBMIT', actorStaffId: staffId }),
      },
      include: planInclude,
    });
  }, TX_OPTS);
  const shape = planShape(plan);
  await notifyCoachPlanSubmitted({
    planId: plan.id,
    staffId,
    planRole,
    branchId: plan.branchId,
    weekStart,
    weekEnd: addDaysKey(weekStart, 6),
    workDays: new Set(shape.slots.map((s) => s.date)).size,
    submittedAt: plan.submittedAt,
  });
  return getMyCoachPlanWeek(staffId, weekStart);
}

export async function withdrawMyCoachPlan(staffId, weekStartRaw) {
  const weekStart = assertWeekStart(weekStartRaw);
  await prisma.$transaction(async (tx) => {
    await lockStaffRow(tx, staffId);
    const row = await tx.coachWeekPlan.findUnique({ where: { staffId_weekStart: { staffId, weekStart: dateOf(weekStart) } } });
    if (!row || row.status !== 'SUBMITTED') throw httpError('僅待審核之班表可撤回送審', 409, 'COACH_PLAN_LOCKED');
    await tx.coachWeekPlan.update({
      where: { id: row.id },
      data: { status: 'DRAFT', history: pushHistory(row, { action: 'WITHDRAW', actorStaffId: staffId }) },
    });
  }, TX_OPTS);
  return getMyCoachPlanWeek(staffId, weekStart);
}

// ── 審核（教練 → FM／店長；管理職 → ADMIN）─────────────

/**
 * 依審核者權限列出週班表
 * @param {object} reviewer 員工 JWT
 * @param {{ status?: string|null, from?: string|null, kind?: 'COACH'|'MANAGER'|null, branchId?: number|null }} opts
 */
export async function listWeekPlansForReview(reviewer, { status = 'SUBMITTED', from = null, kind = null, branchId = null } = {}) {
  const scope = reviewScope(reviewer);
  if (!scope) throw httpError('無週班表審核權限', 403, 'WEEK_PLAN_REVIEW_FORBIDDEN');
  if (status && !COACH_PLAN_STATUSES[status]) throw httpError('status 無效');
  if (kind && !WEEK_PLAN_ROLES[kind]) throw httpError('kind 無效');
  if (kind && !scope.kinds.includes(kind)) throw httpError('無此類班表審核權限', 403, 'WEEK_PLAN_REVIEW_FORBIDDEN');
  if (branchId && scope.branchIds && !scope.branchIds.includes(branchId)) throw httpError('無此分店權限', 403);
  const kinds = kind ? [kind] : scope.kinds;
  const staffRoles = [...(kinds.includes('COACH') ? COACH_STAFF_ROLES : []), ...(kinds.includes('MANAGER') ? MANAGER_STAFF_ROLES : [])];
  const branchIds = branchId ? [branchId] : scope.branchIds;
  const fromKey = from ? assertWeekStart(from) : addDaysKey(weekStartOf(taipeiDateKey()), -7);
  const rows = await prisma.coachWeekPlan.findMany({
    where: {
      staff: { role: { in: staffRoles } },
      staffId: { not: reviewer.id },
      ...(branchIds ? { branchId: { in: branchIds.length ? branchIds : [-1] } } : {}),
      ...(status ? { status } : { status: { not: 'DRAFT' } }),
      weekStart: { gte: dateOf(fromKey) },
    },
    include: planInclude,
    orderBy: [{ weekStart: 'asc' }, { staffId: 'asc' }],
    take: REVIEW_LIST_MAX,
  });
  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const reviewerNames = await reviewerNameMap(rows);
  const byStaff = new Map();
  for (const r of rows) byStaff.set(r.staffId, [...(byStaff.get(r.staffId) ?? []), r]);
  const out = [];
  for (const [sid, list] of byStaff) {
    const staff = await prisma.staff.findUnique({ where: { id: sid }, select: coachSelect });
    const keys = list.map((r) => dbDateKey(r.weekStart)).sort();
    const ctx = await loadContext(staff, keys[0], keys[keys.length - 1]);
    for (const r of list) {
      const key = dbDateKey(r.weekStart);
      const planRole = planRoleOfStaffRole(staff.role);
      out.push({
        ...serializePlan(r, key, evaluateWeek(staff, key, planShape(r), ctx), { reviewerNames, classes: ctx.classes }),
        branchName: r.branchId ? branchName.get(r.branchId) ?? null : null,
        employmentType: staff.employmentType,
        planRoleLabel: WEEK_PLAN_ROLES[planRole]?.label ?? null,
        canReview: canReviewWeekPlan(reviewer, { staffId: r.staffId, planRole, branchId: r.branchId }),
      });
    }
  }
  out.sort((a, b) => (a.weekStart === b.weekStart ? a.staffId - b.staffId : a.weekStart < b.weekStart ? -1 : 1));
  return { ...COACH_PLAN_META, from: fromKey, kinds: scope.kinds, items: out };
}

async function reviewTx(planId, reviewer, fn) {
  return prisma.$transaction(async (tx) => {
    const head = await tx.coachWeekPlan.findUnique({ where: { id: planId }, select: { staffId: true } });
    if (!head) throw httpError('找不到班表', 404);
    await lockStaffRow(tx, head.staffId);
    const row = await tx.coachWeekPlan.findUnique({ where: { id: planId }, include: planInclude });
    if (row.staffId === reviewer.id) throw httpError('不得審核本人班表', 403, 'WEEK_PLAN_SELF_REVIEW');
    const planRole = planRoleOfStaffRole(row.staff?.role);
    if (!canReviewWeekPlan(reviewer, { staffId: row.staffId, planRole, branchId: row.branchId })) {
      throw httpError(
        planRole === 'MANAGER' ? '店長／GM／FM 週班表僅限總公司（ADMIN）審核' : '僅教練部主管（FM）或該分店店長可審核教練週班表',
        403,
        'WEEK_PLAN_REVIEW_FORBIDDEN',
      );
    }
    return fn(tx, row, planRole);
  }, TX_OPTS);
}

function requireReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text) throw httpError('請填寫原因');
  if (text.length > 200) throw httpError('原因最多 200 字');
  return text;
}

export async function approveCoachPlan(planId, reviewer) {
  const actorStaffId = reviewer.id;
  const plan = await reviewTx(planId, reviewer, async (tx, row) => {
    if (row.status !== 'SUBMITTED') throw httpError(`班表${COACH_PLAN_STATUSES[row.status]}，僅待審核可核准`, 409, 'COACH_PLAN_LOCKED');
    const { evaluation } = await evaluateRow(row, tx);
    if (evaluation.hasError) {
      throw httpError('班表未符合勞基法工時規定，不得核准，請退回', 409, 'COACH_PLAN_INVALID', { issues: evaluation.issues });
    }
    return tx.coachWeekPlan.update({
      where: { id: row.id },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedByStaffId: actorStaffId,
        reviewNote: null,
        history: pushHistory(row, { action: 'APPROVE', actorStaffId }),
      },
    });
  });
  await notifyReview(plan, 'APPROVED', reviewer);
  return plan;
}

export async function rejectCoachPlan(planId, reviewer, reason) {
  const actorStaffId = reviewer.id;
  const text = requireReason(reason);
  const plan = await reviewTx(planId, reviewer, async (tx, row) => {
    if (row.status !== 'SUBMITTED') throw httpError('僅待審核之班表可退回', 409, 'COACH_PLAN_LOCKED');
    return tx.coachWeekPlan.update({
      where: { id: row.id },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        reviewedByStaffId: actorStaffId,
        reviewNote: text,
        history: pushHistory(row, { action: 'REJECT', actorStaffId, reason: text }),
      },
    });
  });
  await notifyReview(plan, 'REJECTED', reviewer);
  return plan;
}

export async function reopenCoachPlan(planId, reviewer, reason) {
  const actorStaffId = reviewer.id;
  const text = requireReason(reason);
  const plan = await reviewTx(planId, reviewer, async (tx, row) => {
    if (row.status !== 'APPROVED') throw httpError('僅已核准之班表可撤回核准', 409, 'COACH_PLAN_LOCKED');
    if (addDaysKey(dbDateKey(row.weekStart), 6) < taipeiDateKey()) {
      throw httpError('已結束之週次不可撤回（出勤與薪資已依此班表計算）', 409, 'COACH_PLAN_PAST');
    }
    return tx.coachWeekPlan.update({
      where: { id: row.id },
      data: {
        status: 'DRAFT',
        reviewedAt: new Date(),
        reviewedByStaffId: actorStaffId,
        reviewNote: text,
        history: pushHistory(row, { action: 'REOPEN', actorStaffId, reason: text }),
      },
    });
  });
  await notifyReview(plan, 'REOPENED', reviewer);
  return plan;
}

function notifyReview(plan, action, reviewer) {
  evictDutyCache(plan.staffId);
  const weekStart = dbDateKey(plan.weekStart);
  return notifyCoachPlanReviewed({
    planId: plan.id,
    staffId: plan.staffId,
    weekStart,
    weekEnd: addDaysKey(weekStart, 6),
    action,
    reviewerRole: canonicalRole(reviewer?.role),
    reason: plan.reviewNote,
    at: plan.reviewedAt ?? new Date(),
  });
}

/** 薪資／工資匯出：月內待審核之週班表數（未核准不列排定班次與例休） */
export async function countPendingCoachPlans(fromKey, toKey) {
  return prisma.coachWeekPlan.count({
    where: {
      status: 'SUBMITTED',
      weekStart: { gte: dateOf(addDaysKey(fromKey, -6)), lte: dateOf(toKey) },
    },
  });
}
