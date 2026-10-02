// lib/attendanceService.js — 員工考勤：班表值勤判定、打卡（列鎖、綁定值勤班次）、與已生效班表比對（遲到／早退／未打下班卡／曠職）、總部補登與更正
import prisma from './prisma.js';
import { lockStaffRow } from './dbLocks.js';
import { addDaysKey, diffDaysKey, isDateKey, taipeiDateKey } from './laborLaw.js';
import { canAccessBranch, isAdminUser } from './staffAccess.js';
import { EFFECTIVE_WORK_SLOT_WHERE, scheduleBrief } from './staffScheduleService.js';

/** 遲到／早退寬限（分鐘） */
export const ATTENDANCE_GRACE_MINUTES = 5;
/** 上班卡逾此時數未下班視為「未打下班卡」 */
export const MAX_SHIFT_HOURS = 16;
/** 值勤窗：班次開始前 N 分鐘起 ～ 班次結束（自助上班打卡、業務模組存取皆以此判定） */
export const DUTY_EARLY_MINUTES = 30;
const DUTY_EARLY_MS = DUTY_EARLY_MINUTES * 60000;
const DUTY_CACHE_TTL_MS = 30000;
/** 舊打卡（未綁班次）就近配對：班前 3 小時起算 */
const MATCH_BEFORE_MS = 3 * 3600000;
const LIST_DEFAULT_DAYS = 7;
const LIST_MAX_DAYS = 62;
const LIST_MAX_ROWS = 2000;
const SELF_RECENT_DAYS = 30;

export const ATTENDANCE_FLAGS = {
  LATE: '遲到',
  EARLY_LEAVE: '早退',
  MISSED_PUNCH_OUT: '未打下班卡',
  OPEN: '上班中',
  UNSCHEDULED: '未排班出勤',
  CORRECTED: '已更正',
  BACKFILLED: '總部補登',
};

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const staffSelect = { id: true, name: true, displayName: true, role: true };
const scheduleInclude = { rosterPeriod: { select: { status: true } }, staff: { select: staffSelect } };

function isStale(row, now) {
  return !row.punchOut && now - row.punchIn > MAX_SHIFT_HOURS * 3600000;
}

function resolveRange(from, to, defaultDays) {
  const today = taipeiDateKey();
  const toKey = isDateKey(to) ? to : today;
  const fromKey = isDateKey(from) ? from : addDaysKey(toKey, -(defaultDays - 1));
  const span = diffDaysKey(fromKey, toKey);
  if (span < 0) throw httpError('迄日不得早於起日');
  if (span >= LIST_MAX_DAYS) throw httpError(`查詢區間最多 ${LIST_MAX_DAYS} 日`);
  return {
    fromKey,
    toKey,
    start: new Date(`${fromKey}T00:00:00+08:00`),
    end: new Date(`${addDaysKey(toKey, 1)}T00:00:00+08:00`),
  };
}

/**
 * 打卡配對班次：已綁定 scheduleId 者直接歸屬（同班次可多段，如外出後再上班）；
 * 未綁定之舊紀錄依打卡時間就近配對未使用班次。回傳各班次之首／末段供遲到／早退判定。
 */
function matchSchedules(attendance, schedules) {
  const byId = new Map(schedules.map((s) => [s.id, s]));
  const byStaff = new Map();
  for (const s of schedules) {
    if (!byStaff.has(s.staffId)) byStaff.set(s.staffId, []);
    byStaff.get(s.staffId).push(s);
  }
  const used = new Set();
  const matched = new Map();
  const segments = new Map();
  const assign = (a, s) => {
    used.add(s.id);
    matched.set(a.id, s);
    const seg = segments.get(s.id);
    if (!seg) segments.set(s.id, { first: a.id, last: a.id });
    else seg.last = a.id;
  };
  const ordered = [...attendance].sort((a, b) => a.punchIn - b.punchIn);
  const bound = new Set();
  for (const a of ordered) {
    const s = a.scheduleId != null ? byId.get(a.scheduleId) : null;
    if (s && s.staffId === a.staffId) bound.add(a.id);
  }
  for (const a of ordered) {
    if (bound.has(a.id)) {
      assign(a, byId.get(a.scheduleId));
      continue;
    }
    let best = null;
    for (const s of byStaff.get(a.staffId) || []) {
      if (used.has(s.id)) continue;
      if (a.punchIn < s.startAt.getTime() - MATCH_BEFORE_MS || a.punchIn >= s.endAt) continue;
      if (!best || Math.abs(a.punchIn - s.startAt) < Math.abs(a.punchIn - best.startAt)) best = s;
    }
    if (best) assign(a, best);
  }
  return { matched, used, segments };
}

function serializeAttendance(row, schedule, now, segment = null) {
  const graceMs = ATTENDANCE_GRACE_MINUTES * 60000;
  const flags = [];
  let lateMinutes = 0;
  let earlyMinutes = 0;
  const missed = row.missedPunchOut || isStale(row, now);
  if (missed) flags.push('MISSED_PUNCH_OUT');
  else if (!row.punchOut) flags.push('OPEN');
  const isFirst = !segment || segment.first === row.id;
  const isLast = !segment || segment.last === row.id;
  if (schedule) {
    if (isFirst && row.punchIn - schedule.startAt > graceMs) {
      lateMinutes = Math.round((row.punchIn - schedule.startAt) / 60000);
      flags.push('LATE');
    }
    if (isLast && row.punchOut && schedule.endAt - row.punchOut > graceMs) {
      earlyMinutes = Math.round((schedule.endAt - row.punchOut) / 60000);
      flags.push('EARLY_LEAVE');
    }
  } else {
    flags.push('UNSCHEDULED');
  }
  if (row.correctedAt) flags.push('CORRECTED');
  if (row.source === 'HQ') flags.push('BACKFILLED');
  return {
    id: row.id,
    staffId: row.staffId,
    staff: row.staff ?? null,
    branchId: row.branchId,
    dateKey: taipeiDateKey(row.punchIn),
    punchIn: row.punchIn,
    punchOut: row.punchOut,
    workedMinutes: row.punchOut ? Math.round((row.punchOut - row.punchIn) / 60000) : null,
    source: row.source,
    note: row.note,
    missedPunchOut: missed,
    correction: row.correctedAt
      ? { at: row.correctedAt, byStaffId: row.correctedByStaffId, reason: row.correctionReason }
      : null,
    schedule: schedule ? scheduleBrief(schedule) : null,
    scheduleBound: row.scheduleId != null && schedule?.id === row.scheduleId,
    flags,
    lateMinutes,
    earlyMinutes,
  };
}

function coveredByLeave(schedule, leaves) {
  return leaves.some((l) => l.staffId === schedule.staffId && l.startAt < schedule.endAt && l.endAt > schedule.startAt);
}

function emptyTally() {
  return {
    records: 0,
    workedMinutes: 0,
    late: 0,
    lateMinutes: 0,
    earlyLeave: 0,
    earlyMinutes: 0,
    missedPunchOut: 0,
    open: 0,
    unscheduled: 0,
    unscheduledMinutes: 0,
    absent: 0,
    absentMinutes: 0,
    scheduled: 0,
    scheduledMinutes: 0,
  };
}

const slotMinutes = (s) => Math.round((s.endAt - s.startAt) / 60000);

function tally(t, row) {
  t.records += 1;
  t.workedMinutes += row.workedMinutes ?? 0;
  if (row.flags.includes('LATE')) {
    t.late += 1;
    t.lateMinutes += row.lateMinutes;
  }
  if (row.flags.includes('EARLY_LEAVE')) {
    t.earlyLeave += 1;
    t.earlyMinutes += row.earlyMinutes;
  }
  if (row.flags.includes('MISSED_PUNCH_OUT')) t.missedPunchOut += 1;
  if (row.flags.includes('OPEN')) t.open += 1;
  if (row.flags.includes('UNSCHEDULED')) {
    t.unscheduled += 1;
    t.unscheduledMinutes += row.workedMinutes ?? 0;
  }
}

/**
 * 區間考勤（台北日期，預設近 7 日）：每筆打卡附配對班次與異常旗標，另列曠職（已結束班次無打卡且無核准請假）
 * maxRows 僅供內部彙整（工資匯出）放寬上限
 */
export async function listAttendance({
  from,
  to,
  branchId,
  staffId,
  flag,
  defaultDays = LIST_DEFAULT_DAYS,
  maxRows = LIST_MAX_ROWS,
} = {}) {
  if (flag && flag !== 'ABSENT' && !ATTENDANCE_FLAGS[flag]) throw httpError('flag 無效');
  const { fromKey, toKey, start, end } = resolveRange(from, to, defaultDays);
  const now = new Date();

  const attendanceWhere = { punchIn: { gte: start, lt: end } };
  if (branchId) attendanceWhere.branchId = branchId;
  if (staffId) attendanceWhere.staffId = staffId;
  const attendance = await prisma.staffAttendance.findMany({
    where: attendanceWhere,
    include: { staff: { select: staffSelect } },
    orderBy: { punchIn: 'desc' },
    take: maxRows + 1,
  });
  const truncated = attendance.length > maxRows;
  const records = attendance.slice(0, maxRows);

  const staffIds = [...new Set(records.map((a) => a.staffId))];
  let scope = null;
  if (staffId) scope = { staffId };
  else if (branchId) scope = staffIds.length ? { OR: [{ staffId: { in: staffIds } }, { branchId }] } : { branchId };
  const schedules = await prisma.staffSchedule.findMany({
    where: {
      AND: [
        EFFECTIVE_WORK_SLOT_WHERE,
        { startAt: { gte: new Date(start.getTime() - MATCH_BEFORE_MS), lt: end } },
        ...(scope ? [scope] : []),
      ],
    },
    include: scheduleInclude,
    orderBy: { startAt: 'asc' },
  });
  const scheduleStaffIds = [...new Set(schedules.map((s) => s.staffId))];
  const leaves = scheduleStaffIds.length
    ? await prisma.staffLeave.findMany({
        where: { staffId: { in: scheduleStaffIds }, status: 'APPROVED', startAt: { lt: end }, endAt: { gt: start } },
        select: { staffId: true, startAt: true, endAt: true },
      })
    : [];

  const { matched, used, segments } = matchSchedules(records, schedules);
  const rows = records.map((a) => {
    const s = matched.get(a.id);
    return serializeAttendance(a, s, now, s ? segments.get(s.id) : null);
  });

  const inRange = (s) => s.startAt >= start && s.startAt < end && (!branchId || s.branchId === branchId);
  const absences = schedules
    .filter((s) => inRange(s) && s.endAt < now && !used.has(s.id) && !coveredByLeave(s, leaves))
    .map((s) => ({ ...scheduleBrief(s), staffId: s.staffId, staff: s.staff, dateKey: taipeiDateKey(s.startAt) }))
    .reverse();

  const summary = emptyTally();
  const byStaffMap = new Map();
  const staffTally = (id, staff) => {
    if (!byStaffMap.has(id)) byStaffMap.set(id, { staffId: id, staff, ...emptyTally() });
    return byStaffMap.get(id);
  };
  for (const r of rows) {
    tally(summary, r);
    tally(staffTally(r.staffId, r.staff), r);
  }
  for (const s of schedules) {
    if (!inRange(s) || coveredByLeave(s, leaves)) continue;
    const st = staffTally(s.staffId, s.staff);
    summary.scheduled += 1;
    st.scheduled += 1;
    summary.scheduledMinutes += slotMinutes(s);
    st.scheduledMinutes += slotMinutes(s);
  }
  for (const a of absences) {
    const st = staffTally(a.staffId, a.staff);
    summary.absent += 1;
    st.absent += 1;
    summary.absentMinutes += slotMinutes(a);
    st.absentMinutes += slotMinutes(a);
  }

  const filtered = !flag ? rows : flag === 'ABSENT' ? [] : rows.filter((r) => r.flags.includes(flag));
  return {
    from: fromKey,
    to: toKey,
    graceMinutes: ATTENDANCE_GRACE_MINUTES,
    truncated,
    summary,
    rows: filtered,
    absences: !flag || flag === 'ABSENT' ? absences : [],
    byStaff: [...byStaffMap.values()].sort((a, b) => b.absent + b.late - (a.absent + a.late)),
  };
}

function assertPunchRange(punchIn, punchOut, now) {
  if (punchIn > new Date(now.getTime() + 5 * 60000)) throw httpError('上班時間不得晚於現在');
  if (!punchOut) return;
  if (punchOut <= punchIn) throw httpError('下班時間須晚於上班時間');
  if (punchOut > new Date(now.getTime() + 5 * 60000)) throw httpError('下班時間不得晚於現在');
  if (punchOut - punchIn > MAX_SHIFT_HOURS * 3600000) throw httpError(`單筆出勤不得超過 ${MAX_SHIFT_HOURS} 小時`);
}

async function assertNoAttendanceOverlap({ staffId, punchIn, punchOut, excludeId = null, now }) {
  const end = punchOut ?? now;
  const overlap = await prisma.staffAttendance.findFirst({
    where: {
      staffId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      punchIn: { lt: end },
      OR: [{ punchOut: { gt: punchIn } }, { punchOut: null, missedPunchOut: false }],
    },
    select: { id: true },
  });
  if (overlap) throw httpError('與該員工既有打卡紀錄時段重疊', 409, 'ATTENDANCE_OVERLAP');
}

function requireReason(reason) {
  const text = String(reason ?? '').trim();
  if (text.length < 2) throw httpError('請填寫補登／更正原因', 400, 'REASON_REQUIRED');
  return text.slice(0, 200);
}

/** 總部補登：必填原因；未填下班時間＝上班中（同員工不得有其他未結案卡）；可選填綁定該員工之已生效班次 */
export async function backfillAttendance({ staffId, branchId, scheduleId, punchIn, punchOut, reason, actorStaffId }) {
  const note = requireReason(reason);
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, branchId: true, isActive: true } });
  if (!staff) throw httpError('找不到員工', 404);
  let slot = null;
  if (scheduleId) {
    slot = await prisma.staffSchedule.findFirst({ where: { AND: [EFFECTIVE_WORK_SLOT_WHERE, { id: scheduleId, staffId }] } });
    if (!slot) throw httpError('班次不存在、未生效或非該員工班次', 400, 'SCHEDULE_INVALID');
  }
  const now = new Date();
  assertPunchRange(punchIn, punchOut, now);
  await assertNoAttendanceOverlap({ staffId, punchIn, punchOut, now });
  const row = await prisma.staffAttendance.create({
    data: {
      staffId,
      branchId: branchId ?? slot?.branchId ?? staff.branchId ?? null,
      scheduleId: slot?.id ?? null,
      punchIn,
      punchOut: punchOut ?? null,
      source: 'HQ',
      note,
      createdByStaffId: actorStaffId ?? null,
    },
    include: { staff: { select: staffSelect } },
  });
  evictDutyCache(staffId);
  return serializeAttendance(row, slot, now);
}

/** 總部更正（必填原因，保留更正者／時間）；補上下班時間即解除「未打下班卡」 */
export async function correctAttendance(id, { punchIn, punchOut, reason, actorStaffId }) {
  const correctionReason = requireReason(reason);
  const row = await prisma.staffAttendance.findUnique({ where: { id } });
  if (!row) throw httpError('找不到打卡紀錄', 404);
  const nextIn = punchIn ?? row.punchIn;
  const nextOut = punchOut === undefined ? row.punchOut : punchOut;
  const now = new Date();
  assertPunchRange(nextIn, nextOut, now);
  await assertNoAttendanceOverlap({ staffId: row.staffId, punchIn: nextIn, punchOut: nextOut, excludeId: id, now });
  const updated = await prisma.staffAttendance.update({
    where: { id },
    data: {
      punchIn: nextIn,
      punchOut: nextOut,
      missedPunchOut: nextOut ? false : row.missedPunchOut,
      correctedByStaffId: actorStaffId ?? null,
      correctedAt: now,
      correctionReason,
    },
    include: { staff: { select: staffSelect } },
  });
  evictDutyCache(row.staffId);
  return serializeAttendance(updated, null, now);
}

// ── 班表值勤判定 ──

async function findOpenAttendance(db, staffId) {
  return db.staffAttendance.findFirst({
    where: { staffId, punchOut: null, missedPunchOut: false },
    orderBy: { punchIn: 'desc' },
  });
}

/** 值勤窗內之已生效出勤班次（開始前 30 分 ～ 結束） */
async function findDutySlots(db, staffId, now) {
  return db.staffSchedule.findMany({
    where: {
      AND: [
        EFFECTIVE_WORK_SLOT_WHERE,
        { staffId, startAt: { lte: new Date(now.getTime() + DUTY_EARLY_MS) }, endAt: { gt: now } },
      ],
    },
    orderBy: { startAt: 'asc' },
  });
}

/** 已開始之班次取最晚開始者；皆未開始取最早者 */
function pickDutySlot(slots, now) {
  const started = slots.filter((s) => s.startAt <= now);
  return started.length ? started[started.length - 1] : slots[0] ?? null;
}

const slotInUserScope = (user, slot) => slot.branchId == null || canAccessBranch(user, slot.branchId);

async function findActiveLeave(db, staffId, now) {
  return db.staffLeave.findFirst({
    where: { staffId, status: 'APPROVED', startAt: { lte: now }, endAt: { gt: now } },
    select: { id: true, startAt: true, endAt: true },
  });
}

async function findNextShift(db, staffId, now, excludeId = null) {
  return db.staffSchedule.findFirst({
    where: {
      AND: [
        EFFECTIVE_WORK_SLOT_WHERE,
        { staffId, startAt: { gt: now } },
        ...(excludeId ? [{ id: { not: excludeId } }] : []),
      ],
    },
    orderBy: { startAt: 'asc' },
  });
}

async function briefWithBranch(slots) {
  const list = slots.filter(Boolean);
  const ids = [...new Set(list.map((s) => s.branchId).filter((id) => id != null))];
  const branches = ids.length
    ? await prisma.branch.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const names = new Map(branches.map((b) => [b.id, b.name]));
  return (slot) =>
    slot
      ? {
          ...scheduleBrief(slot),
          branchName: slot.branchId != null ? names.get(slot.branchId) ?? null : null,
          punchInOpensAt: new Date(slot.startAt.getTime() - DUTY_EARLY_MS),
        }
      : null;
}

const DUTY_MESSAGES = {
  EXEMPT: '管理員免班表值勤判定',
  CLOCKED_IN: '上班中（已打上班卡）',
  IN_WINDOW: '班表值勤時段，請打上班卡',
  ON_LEAVE: '請假中（已核准），非值勤人員',
  BRANCH_SCOPE: '值勤班次分店不在本次登入權限內，請重新登入',
  OFF_SHIFT: '目前非班表值勤時段',
};

const staffIdOfUser = (user) => {
  const n = parseInt(user?.staffId ?? user?.id, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * 班表值勤判定（登入、業務模組存取、自助上班打卡共用）
 * 值勤＝已打上班卡（未逾時），或現在落在已生效出勤班次之值勤窗內且無核准請假；ADMIN 免判定
 */
export async function resolveDutyStatus(user, { now = new Date() } = {}) {
  const staffId = staffIdOfUser(user);
  if (!staffId) throw httpError('⛔ 憑證缺少員工 id', 403);
  const base = { checkedAt: now, earlyMinutes: DUTY_EARLY_MINUTES };
  if (isAdminUser(user)) {
    return {
      ...base,
      exempt: true,
      onDuty: true,
      state: 'EXEMPT',
      message: DUTY_MESSAGES.EXEMPT,
      shift: null,
      nextShift: null,
      open: null,
      staleOpen: false,
      canPunchIn: true,
      canPunchOut: false,
      leave: null,
    };
  }
  const [slots, leave, openRow] = await Promise.all([
    findDutySlots(prisma, staffId, now),
    findActiveLeave(prisma, staffId, now),
    findOpenAttendance(prisma, staffId),
  ]);
  const open = openRow && !isStale(openRow, now) ? openRow : null;
  const scoped = slots.filter((s) => slotInUserScope(user, s));
  const slot = pickDutySlot(scoped, now);
  const openSlot = open?.scheduleId
    ? slots.find((s) => s.id === open.scheduleId) ??
      (await prisma.staffSchedule.findUnique({ where: { id: open.scheduleId } }))
    : null;

  let state;
  if (open) state = 'CLOCKED_IN';
  else if (slot && leave) state = 'ON_LEAVE';
  else if (slot) state = 'IN_WINDOW';
  else if (slots.length) state = 'BRANCH_SCOPE';
  else state = 'OFF_SHIFT';

  const shiftRow = open ? openSlot : slot;
  const nextRow = await findNextShift(prisma, staffId, now, shiftRow?.id ?? null);
  const brief = await briefWithBranch([shiftRow, nextRow]);
  return {
    ...base,
    exempt: false,
    onDuty: state === 'CLOCKED_IN' || state === 'IN_WINDOW',
    state,
    message: DUTY_MESSAGES[state],
    shift: brief(shiftRow),
    nextShift: brief(nextRow),
    open: open ? { id: open.id, punchIn: open.punchIn, branchId: open.branchId, scheduleId: open.scheduleId } : null,
    staleOpen: Boolean(openRow && !open),
    canPunchIn: state === 'IN_WINDOW',
    canPunchOut: Boolean(open),
    leave: state === 'ON_LEAVE' ? { startAt: leave.startAt, endAt: leave.endAt } : null,
  };
}

const dutyCache = new Map();

/** 業務模組海關用：短 TTL 快取（打卡／補登／更正即 evict；班表發布／請假審核至多延遲 TTL） */
export async function getDutyStatusCached(user) {
  const staffId = staffIdOfUser(user);
  const key = `${user?.role}|${(user?.branchIds ?? []).join(',')}|${user?.branchId ?? ''}`;
  const hit = dutyCache.get(staffId);
  const nowMs = Date.now();
  if (hit && hit.key === key && nowMs - hit.at < DUTY_CACHE_TTL_MS) return hit.value;
  const value = await resolveDutyStatus(user);
  dutyCache.set(staffId, { key, at: nowMs, value });
  return value;
}

export function evictDutyCache(staffId) {
  dutyCache.delete(Number(staffId));
}

// ── 員工自助 ──

/**
 * 上班打卡：非 ADMIN 須落在已生效出勤班次之值勤窗（開始前 30 分 ～ 結束）且未請假，打卡綁定該班次與班次分店；
 * 班外打卡一律拒絕（由總部補登）。逾 16 小時之舊上班卡自動標記未打下班卡後放行。
 */
export async function punchIn(user, staffId, requestedBranchId) {
  if (requestedBranchId && !canAccessBranch(user, requestedBranchId)) {
    throw httpError('⛔ 無權於此分店打卡', 403);
  }
  const exempt = isAdminUser(user);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockStaffRow(tx, staffId);
    if (!locked) throw httpError('找不到員工', 404);
    const open = await findOpenAttendance(tx, staffId);
    if (open && !isStale(open, now)) {
      throw httpError('已在上班中，請先下班打卡', 409, 'ALREADY_PUNCHED_IN');
    }

    let slot = null;
    let branchId = requestedBranchId ?? (user?.branchId ? Number(user.branchId) : null);
    if (!exempt) {
      const slots = await findDutySlots(tx, staffId, now);
      slot = pickDutySlot(slots.filter((s) => slotInUserScope(user, s)), now);
      if (!slot) {
        if (slots.length) throw httpError(DUTY_MESSAGES.BRANCH_SCOPE, 409, 'BRANCH_NOT_SCHEDULED');
        const next = await findNextShift(tx, staffId, now);
        const err = httpError(
          `目前非班表值勤時段，無法打上班卡（可於班次開始前 ${DUTY_EARLY_MINUTES} 分鐘起打卡；班外出勤請洽總部補登）`,
          409,
          'NOT_ON_DUTY',
        );
        err.data = { nextShift: next ? scheduleBrief(next) : null };
        throw err;
      }
      if (await findActiveLeave(tx, staffId, now)) {
        throw httpError('請假中（已核准），無法打上班卡；如需銷假請洽主管', 409, 'ON_LEAVE');
      }
      if (slot.branchId != null) {
        if (requestedBranchId && requestedBranchId !== slot.branchId) {
          throw httpError('打卡分店與值勤班次分店不符', 409, 'BRANCH_NOT_SCHEDULED');
        }
        branchId = slot.branchId;
      }
    }

    let staleClosedId = null;
    if (open) {
      await tx.staffAttendance.update({ where: { id: open.id }, data: { missedPunchOut: true } });
      staleClosedId = open.id;
    }
    const row = await tx.staffAttendance.create({
      data: { staffId, branchId, scheduleId: slot?.id ?? null, punchIn: now, source: 'SELF' },
    });
    return { row, staleClosedId, shift: slot ? scheduleBrief(slot) : null };
  });
  evictDutyCache(staffId);
  return result;
}

/** 下班打卡：上班卡逾 16 小時者標記未打下班卡並拒絕（須由總部更正）；班後延長工作照實記錄，加班另經核定 */
export async function punchOut(staffId) {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await lockStaffRow(tx, staffId);
    const open = await findOpenAttendance(tx, staffId);
    if (!open) return { error: 'NOT_PUNCHED_IN' };
    if (isStale(open, now)) {
      await tx.staffAttendance.update({ where: { id: open.id }, data: { missedPunchOut: true } });
      return { error: 'OPEN_SHIFT_STALE' };
    }
    return { row: await tx.staffAttendance.update({ where: { id: open.id }, data: { punchOut: now } }) };
  });
  evictDutyCache(staffId);
  if (result.error === 'NOT_PUNCHED_IN') throw httpError('目前沒有上班中的打卡紀錄', 409, 'NOT_PUNCHED_IN');
  if (result.error === 'OPEN_SHIFT_STALE') {
    throw httpError(`上班卡已逾 ${MAX_SHIFT_HOURS} 小時，已標記為未打下班卡，請洽主管更正`, 409, 'OPEN_SHIFT_STALE');
  }
  return result.row;
}

/** 我的出勤：目前打卡狀態、今日／下一個班次、近 30 日考勤與曠職 */
export async function getMyAttendance(staffId) {
  const now = new Date();
  const todayKey = taipeiDateKey(now);
  const [open, upcoming, recent] = await Promise.all([
    prisma.staffAttendance.findFirst({
      where: { staffId, punchOut: null, missedPunchOut: false },
      orderBy: { punchIn: 'desc' },
    }),
    prisma.staffSchedule.findMany({
      where: {
        AND: [
          EFFECTIVE_WORK_SLOT_WHERE,
          { staffId, endAt: { gt: new Date(`${todayKey}T00:00:00+08:00`) } },
          { startAt: { lt: new Date(`${addDaysKey(todayKey, 8)}T00:00:00+08:00`) } },
        ],
      },
      include: scheduleInclude,
      orderBy: { startAt: 'asc' },
      take: 20,
    }),
    listAttendance({ staffId, defaultDays: SELF_RECENT_DAYS }),
  ]);
  const todayShifts = upcoming.filter((s) => taipeiDateKey(s.startAt) === todayKey).map(scheduleBrief);
  const next = upcoming.find((s) => s.startAt > now);
  return {
    now,
    todayKey,
    graceMinutes: ATTENDANCE_GRACE_MINUTES,
    maxShiftHours: MAX_SHIFT_HOURS,
    open: open ? { id: open.id, punchIn: open.punchIn, branchId: open.branchId, stale: isStale(open, now) } : null,
    todayShifts,
    nextShift: next ? scheduleBrief(next) : null,
    summary: recent.summary,
    recent: recent.rows,
    absences: recent.absences,
  };
}
