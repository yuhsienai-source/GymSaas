// lib/rosterService.js — 四週變形排班 DB 層（規則見 shiftRoster.js）
import prisma from './prisma.js';
import { normalizeBranchType } from './orgStructure.js';
import { addDaysKey, dbDateKey, isDateKey, taipeiDateKey } from './laborLaw.js';
import { weekPlanRoleOf } from './coachSchedule.js';
import {
  CELL_CODES,
  MAX_SHIFT_HEADCOUNT,
  MIN_SHIFT_HEADCOUNT,
  OFF_CODES,
  ROSTER_CYCLE_DAYS,
  ROSTER_ROLE_LABELS,
  ROSTER_SHIFTS,
  SHIFT_CODES,
  cycleDays,
  cycleShiftCapacity,
  cycleStartFor,
  evaluateCoverage,
  evaluateStaffCycle,
  generateRoster,
  OFF_REQUEST_DEADLINE_DAYS,
  ROSTER_ACK_HOURS,
  ROSTER_ACK_STATUSES,
  isRosterEligible,
  maxOffRequestDays,
  offRequestDeadlineKey,
  rosterAckDeadline,
  rosterRoleOf,
  shiftTimeRange,
} from './shiftRoster.js';
import {
  notifyOffRequestClosed,
  notifyOffRequestReminder,
  notifyOffRequestSubmitted,
  notifyRosterAckReminder,
  notifyRosterAckSummary,
  notifyRosterAutoConfirmed,
  notifyRosterDisputed,
  notifyRosterPublished,
  notifyRosterUnpublished,
} from './staffNotifyEvents.js';

function httpError(message, statusCode = 400, code, data) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data) err.data = data;
  return err;
}

const dateOf = (key) => new Date(`${key}T00:00:00Z`);

const rosterStaffSelect = {
  id: true,
  name: true,
  displayName: true,
  role: true,
  branchId: true,
  isActive: true,
  employmentType: true,
  weeklyHours: true,
  laborActApplies: true,
};

async function loadGymBranch(branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: Number(branchId) },
    select: { id: true, name: true, code: true, type: true, isActive: true, rosterConfig: true },
  });
  if (!branch) throw httpError('找不到分店', 404);
  if (normalizeBranchType(branch.type) !== 'GYM') throw httpError('僅健身房（GYM）分店設有場務排班', 400);
  return branch;
}

function serializeConfig(cfg) {
  if (!cfg) return null;
  return {
    cycleAnchorDate: dbDateKey(cfg.cycleAnchorDate),
    requirement: { MORNING: cfg.morningHeadcount, EVENING: cfg.eveningHeadcount },
  };
}

/** 啟用中 GYM 分店與排班設定；branchIds＝null 表示不限（跨店職位） */
export async function listRosterConfigs(branchIds = null) {
  const branches = await prisma.branch.findMany({
    where: { isActive: true, ...(branchIds ? { id: { in: branchIds } } : {}) },
    select: { id: true, name: true, code: true, type: true, rosterConfig: true },
    orderBy: { id: 'asc' },
  });
  return branches
    .filter((b) => normalizeBranchType(b.type) === 'GYM')
    .map((b) => ({ branchId: b.id, name: b.name, code: b.code, config: serializeConfig(b.rosterConfig) }));
}

function parseHeadcount(raw, label) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_SHIFT_HEADCOUNT || n > MAX_SHIFT_HEADCOUNT) {
    throw httpError(`${label}人力須為 ${MIN_SHIFT_HEADCOUNT}～${MAX_SHIFT_HEADCOUNT} 人`);
  }
  return n;
}

export async function upsertRosterConfig(branchId, input) {
  const branch = await loadGymBranch(branchId);
  const anchor = String(input?.cycleAnchorDate || '').trim();
  if (!isDateKey(anchor)) throw httpError('週期起算日格式須為 YYYY-MM-DD');
  const data = {
    cycleAnchorDate: dateOf(anchor),
    morningHeadcount: parseHeadcount(input?.morningHeadcount ?? MIN_SHIFT_HEADCOUNT, '早班'),
    eveningHeadcount: parseHeadcount(input?.eveningHeadcount ?? MIN_SHIFT_HEADCOUNT, '晚班'),
  };
  if (branch.rosterConfig && dbDateKey(branch.rosterConfig.cycleAnchorDate) !== anchor) {
    const existing = await prisma.rosterPeriod.count({ where: { branchId: branch.id } });
    if (existing > 0) throw httpError('已有排班期，不可變更週期起算日（四週變形週期須固定）', 409);
  }
  const cfg = await prisma.branchRosterConfig.upsert({
    where: { branchId: branch.id },
    create: { branchId: branch.id, ...data },
    update: data,
  });
  return serializeConfig(cfg);
}

function leaveDateKeys(leave) {
  const out = [];
  const endKey = taipeiDateKey(new Date(leave.endAt.getTime() - 1));
  for (let k = taipeiDateKey(leave.startAt); k <= endKey; k = addDaysKey(k, 1)) out.push(k);
  return out;
}

function cellOf(entry) {
  return entry.slotType === 'SHIFT' ? entry.shiftCode : entry.slotType;
}

async function buildContext(branch, startKey) {
  const cfg = branch.rosterConfig;
  const days = cycleDays(startKey);
  const endKey = days[days.length - 1];
  const period = await prisma.rosterPeriod.findUnique({
    where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
    include: { entries: { select: { staffId: true, workDate: true, slotType: true, shiftCode: true } } },
  });

  const eligible = (
    await prisma.staff.findMany({ where: { branchId: branch.id, isActive: true }, select: rosterStaffSelect, orderBy: { id: 'asc' } })
  ).filter(isRosterEligible);
  const extraIds = [...new Set((period?.entries || []).map((e) => e.staffId))].filter((id) => !eligible.some((s) => s.id === id));
  const extra = extraIds.length
    ? await prisma.staff.findMany({ where: { id: { in: extraIds } }, select: rosterStaffSelect })
    : [];
  const staff = [...eligible, ...extra];
  const staffIds = staff.map((s) => s.id);

  const [leaves, holidays, prevEntries, requests, ackRows] = await Promise.all([
    prisma.staffLeave.findMany({
      where: {
        staffId: { in: staffIds },
        status: 'APPROVED',
        startAt: { lt: new Date(`${addDaysKey(endKey, 1)}T00:00:00+08:00`) },
        endAt: { gt: new Date(`${startKey}T00:00:00+08:00`) },
      },
      select: { staffId: true, startAt: true, endAt: true },
    }),
    prisma.publicHoliday.findMany({
      where: { date: { gte: dateOf(startKey), lte: dateOf(endKey) } },
      select: { date: true, name: true },
    }),
    prisma.staffSchedule.findMany({
      where: { staffId: { in: staffIds }, workDate: dateOf(addDaysKey(startKey, -1)) },
      select: { staffId: true, slotType: true, shiftCode: true },
    }),
    prisma.rosterOffRequest.findMany({
      where: { branchId: branch.id, cycleStartDate: dateOf(startKey) },
      select: { staffId: true, dates: true, note: true, submittedAt: true, updatedAt: true },
    }),
    period?.status === 'PUBLISHED' && period.publishedAt
      ? prisma.rosterAcknowledgement.findMany({
          where: { rosterPeriodId: period.id, periodPublishedAt: period.publishedAt },
          select: { staffId: true, status: true, message: true, respondedAt: true, autoConfirmed: true },
        })
      : [],
  ]);

  const leaveDays = new Map(staffIds.map((id) => [id, new Set()]));
  for (const l of leaves) for (const k of leaveDateKeys(l)) if (k >= startKey && k <= endKey) leaveDays.get(l.staffId).add(k);
  const cells = new Map(staffIds.map((id) => [id, new Map()]));
  for (const e of period?.entries || []) cells.get(e.staffId)?.set(dbDateKey(e.workDate), cellOf(e));
  const prevCells = new Map(prevEntries.map((e) => [e.staffId, cellOf(e)]));
  const holidayNames = new Map(holidays.map((h) => [dbDateKey(h.date), h.name]));
  const requirement = { MORNING: cfg.morningHeadcount, EVENING: cfg.eveningHeadcount };
  const offRequests = new Map(
    requests.map((r) => [r.staffId, { ...r, dates: new Set(r.dates.map(dbDateKey).filter((k) => k >= startKey && k <= endKey)) }]),
  );

  const ackDeadline = period?.status === 'PUBLISHED' ? rosterAckDeadline(period.publishedAt) : null;
  const acks = new Map(ackRows.map((a) => [a.staffId, { ...a, late: ackDeadline ? a.respondedAt > ackDeadline : false }]));

  return {
    branch,
    cfg,
    days,
    period,
    staff,
    eligible,
    leaveDays,
    cells,
    prevCells,
    holidayNames,
    requirement,
    offRequests,
    acks,
    ackDeadline,
  };
}

function evaluate(ctx) {
  const holidayKeys = new Set(ctx.holidayNames.keys());
  const eligibleIds = new Set(ctx.eligible.map((s) => s.id));
  const staffRows = ctx.staff.map((s) => {
    const cells = ctx.cells.get(s.id);
    const { stats, issues } = evaluateStaffCycle({
      staff: s,
      days: ctx.days,
      cells,
      leaveDays: ctx.leaveDays.get(s.id),
      holidayKeys,
      prevCell: ctx.prevCells.get(s.id) ?? null,
      requestedOff: ctx.offRequests.get(s.id)?.dates,
    });
    const rosterRole = rosterRoleOf(s);
    if (!eligibleIds.has(s.id)) {
      issues.unshift({
        level: 'WARNING',
        code: 'NOT_IN_ROSTER',
        message: rosterRole === 'FREE_TRAINER' ? '已轉正教練：改為本人提報週班表，請移除本期排班' : '已非本店排班編制，請移除本期排班',
      });
    }
    return { s, rosterRole, cells, stats, issues };
  });
  const eligibleCells = staffRows.filter((r) => eligibleIds.has(r.s.id)).map((r) => r.cells);
  const coverage = evaluateCoverage({ days: ctx.days, staffCells: eligibleCells, requirement: ctx.requirement });
  return { staffRows, coverage };
}

function serializeView(ctx, result) {
  const count = (level) =>
    result.coverage.issues.filter((i) => i.level === level).length +
    result.staffRows.reduce((n, r) => n + r.issues.filter((i) => i.level === level).length, 0);
  return {
    branch: { id: ctx.branch.id, name: ctx.branch.name, code: ctx.branch.code },
    config: serializeConfig(ctx.cfg),
    cycle: {
      startDate: ctx.days[0],
      endDate: ctx.days[ctx.days.length - 1],
      offRequestDeadline: offRequestDeadlineKey(ctx.days[0]),
      prevStartDate: addDaysKey(ctx.days[0], -ROSTER_CYCLE_DAYS),
      nextStartDate: addDaysKey(ctx.days[0], ROSTER_CYCLE_DAYS),
      days: ctx.days.map((d) => ({
        date: d,
        weekday: new Date(`${d}T00:00:00Z`).getUTCDay(),
        holiday: ctx.holidayNames.get(d) ?? null,
      })),
    },
    period: ctx.period
      ? { id: ctx.period.id, status: ctx.period.status, publishedAt: ctx.period.publishedAt, note: ctx.period.note }
      : null,
    requirement: ctx.requirement,
    staff: result.staffRows.map((r) => ({
      id: r.s.id,
      name: r.s.name,
      displayName: r.s.displayName,
      role: r.s.role,
      rosterRole: r.rosterRole,
      rosterRoleLabel: ROSTER_ROLE_LABELS[r.rosterRole] ?? '—',
      employmentType: r.s.employmentType,
      weeklyHours: r.s.weeklyHours,
      laborActApplies: r.s.laborActApplies,
      capacity: cycleShiftCapacity(r.s),
      cells: Object.fromEntries(r.cells),
      leaveDays: [...ctx.leaveDays.get(r.s.id)],
      offRequest: serializeOffRequest(ctx.offRequests.get(r.s.id)),
      ack: serializeAck(ctx.acks.get(r.s.id)),
      stats: r.stats,
      issues: r.issues,
    })),
    coverage: result.coverage.coverage,
    issues: result.coverage.issues,
    summary: {
      errors: count('ERROR'),
      warnings: count('WARNING'),
      offRequests: {
        submitted: ctx.eligible.filter((s) => ctx.offRequests.has(s.id)).length,
        total: ctx.eligible.length,
      },
      acks: summarizeAcks(ctx),
    },
  };
}

/** 須確認者＝本期有排班格之編制員工 */
function ackRequiredIds(ctx) {
  return ctx.eligible.filter((s) => ctx.cells.get(s.id)?.size > 0).map((s) => s.id);
}

function summarizeAcks(ctx) {
  if (!ctx.ackDeadline) return null;
  const ids = ackRequiredIds(ctx);
  const confirmed = ids.filter((id) => ctx.acks.get(id)?.status === 'CONFIRMED').length;
  const disputed = ids.filter((id) => ctx.acks.get(id)?.status === 'DISPUTED').length;
  const pending = ids.length - confirmed - disputed;
  return {
    deadline: ctx.ackDeadline,
    hours: ROSTER_ACK_HOURS,
    total: ids.length,
    confirmed,
    autoConfirmed: ids.filter((id) => ctx.acks.get(id)?.autoConfirmed).length,
    disputed,
    pending,
    overdue: pending > 0 && Date.now() > ctx.ackDeadline.getTime(),
  };
}

function serializeAck(ack) {
  if (!ack) return null;
  return {
    status: ack.status,
    message: ack.message,
    respondedAt: ack.respondedAt,
    late: ack.late,
    autoConfirmed: ack.autoConfirmed,
  };
}

function serializeOffRequest(req) {
  if (!req) return null;
  return { dates: [...req.dates].sort(), note: req.note, submittedAt: req.submittedAt, updatedAt: req.updatedAt };
}

async function contextForPeriod(periodId) {
  const period = await prisma.rosterPeriod.findUnique({ where: { id: Number(periodId) }, select: { id: true, branchId: true, startDate: true, status: true } });
  if (!period) throw httpError('找不到排班期', 404);
  const branch = await loadGymBranch(period.branchId);
  return { period, ctx: await buildContext(branch, dbDateKey(period.startDate)) };
}

/** 排班期所屬分店（路由層分店範圍檢查用） */
export async function rosterPeriodBranchId(periodId) {
  const id = Number(periodId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('排班期 ID 無效');
  const period = await prisma.rosterPeriod.findUnique({ where: { id }, select: { branchId: true } });
  if (!period) throw httpError('找不到排班期', 404);
  return period.branchId;
}

/** 取得含 dateKey 之四週排班檢視（未建立時 period=null） */
export async function getRosterView(branchId, dateKey = taipeiDateKey()) {
  if (!isDateKey(dateKey)) throw httpError('日期格式須為 YYYY-MM-DD');
  const branch = await loadGymBranch(branchId);
  if (!branch.rosterConfig) throw httpError('此分店尚未設定排班週期', 400, 'ROSTER_NOT_CONFIGURED');
  const startKey = cycleStartFor(dbDateKey(branch.rosterConfig.cycleAnchorDate), dateKey);
  const ctx = await buildContext(branch, startKey);
  return serializeView(ctx, evaluate(ctx));
}

export async function createRosterPeriod(branchId, startKey, actorStaffId) {
  if (!isDateKey(startKey)) throw httpError('起始日格式須為 YYYY-MM-DD');
  const branch = await loadGymBranch(branchId);
  if (!branch.rosterConfig) throw httpError('此分店尚未設定排班週期', 400, 'ROSTER_NOT_CONFIGURED');
  const aligned = cycleStartFor(dbDateKey(branch.rosterConfig.cycleAnchorDate), startKey);
  if (aligned !== startKey) throw httpError(`起始日須對齊四週週期（最近為 ${aligned}）`, 400, 'CYCLE_MISALIGNED');
  await prisma.rosterPeriod.upsert({
    where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
    create: { branchId: branch.id, startDate: dateOf(startKey), createdByStaffId: actorStaffId },
    update: {},
  });
  return getRosterView(branch.id, startKey);
}

function assertDraft(period) {
  if (period.status !== 'DRAFT') throw httpError('已發布之排班不可直接修改，請先撤回發布', 409, 'ROSTER_PUBLISHED');
}

function entryData(periodId, branchId, staffId, dateKey, code) {
  const shift = SHIFT_CODES.includes(code);
  const { startAt, endAt } = shiftTimeRange(dateKey, shift ? code : null);
  return {
    rosterPeriodId: periodId,
    branchId,
    staffId,
    workDate: dateOf(dateKey),
    slotType: shift ? 'SHIFT' : code,
    shiftCode: shift ? code : null,
    startAt,
    endAt,
  };
}

/** 自動排班：覆蓋本期草稿 */
export async function generateRosterPeriod(periodId) {
  const { period, ctx } = await contextForPeriod(periodId);
  assertDraft(period);
  const generated = generateRoster({
    days: ctx.days,
    staff: ctx.eligible,
    requirement: ctx.requirement,
    leaveDays: ctx.leaveDays,
    prevCells: ctx.prevCells,
    offRequests: new Map([...ctx.offRequests].map(([id, r]) => [id, r.dates])),
  });
  const rows = [];
  for (const [staffId, cells] of generated) {
    for (const [dateKey, code] of cells) rows.push(entryData(period.id, ctx.branch.id, staffId, dateKey, code));
  }
  await prisma.$transaction([
    prisma.staffSchedule.deleteMany({ where: { rosterPeriodId: period.id } }),
    prisma.staffSchedule.createMany({ data: rows }),
  ]);
  return getRosterView(ctx.branch.id, ctx.days[0]);
}

/** 單格編修：value＝MORNING｜EVENING｜REGULAR_OFF｜REST_DAY｜OFF｜null（清除） */
export async function setRosterCell(periodId, { staffId, date, value }) {
  const { period, ctx } = await contextForPeriod(periodId);
  assertDraft(period);
  const sid = Number(staffId);
  if (!ctx.days.includes(date)) throw httpError('日期不在本排班期內');
  const inPool = ctx.eligible.some((s) => s.id === sid);
  const code = value === null || value === '' ? null : String(value).toUpperCase();
  if (code !== null && !CELL_CODES.includes(code)) throw httpError('班別無效');
  if (code !== null && !inPool) throw httpError('此員工不在本店排班編制（場務／實習教練）', 400, 'NOT_IN_ROSTER');
  const where = { rosterPeriodId_staffId_workDate: { rosterPeriodId: period.id, staffId: sid, workDate: dateOf(date) } };
  if (code === null) {
    await prisma.staffSchedule.deleteMany({ where: { rosterPeriodId: period.id, staffId: sid, workDate: dateOf(date) } });
  } else {
    const data = entryData(period.id, ctx.branch.id, sid, date, code);
    await prisma.staffSchedule.upsert({ where, create: data, update: data });
  }
  return getRosterView(ctx.branch.id, ctx.days[0]);
}

/** 發布：存在 ERROR（人力不足、違反四週變形／輪班間隔）時拒絕 */
export async function publishRosterPeriod(periodId, actorStaffId) {
  const { period, ctx } = await contextForPeriod(periodId);
  assertDraft(period);
  const view = serializeView(ctx, evaluate(ctx));
  if (view.summary.errors > 0) {
    throw httpError(`尚有 ${view.summary.errors} 項違規或人力不足，無法發布`, 409, 'ROSTER_VIOLATIONS', view);
  }
  const publishedAt = new Date();
  await prisma.rosterPeriod.update({
    where: { id: period.id },
    data: { status: 'PUBLISHED', publishedAt, publishedByStaffId: actorStaffId },
  });
  const staffIds = ackRequiredIds(ctx);
  const unmetOff = new Map(
    staffIds.map((id) => [
      id,
      [...(ctx.offRequests.get(id)?.dates ?? [])].filter((d) => SHIFT_CODES.includes(ctx.cells.get(id)?.get(d))).sort(),
    ]),
  );
  void notifyRosterPublished({
    periodId: period.id,
    publishedAt,
    ackDeadline: rosterAckDeadline(publishedAt),
    branchName: ctx.branch.name,
    startKey: ctx.days[0],
    endKey: ctx.days[ctx.days.length - 1],
    staffIds,
    unmetOff,
  });
  return getRosterView(ctx.branch.id, ctx.days[0]);
}

export async function unpublishRosterPeriod(periodId, actorStaffId, reason) {
  const note = String(reason || '').trim().slice(0, 200);
  if (!note) throw httpError('撤回發布須填寫原因');
  const { period, ctx } = await contextForPeriod(periodId);
  if (period.status !== 'PUBLISHED') throw httpError('此排班期尚未發布', 409);
  await prisma.rosterPeriod.update({
    where: { id: period.id },
    data: { status: 'DRAFT', note: `撤回（staff#${actorStaffId}）：${note}` },
  });
  void notifyRosterUnpublished({
    branchName: ctx.branch.name,
    startKey: ctx.days[0],
    endKey: ctx.days[ctx.days.length - 1],
    staffIds: ackRequiredIds(ctx),
    reason: note,
  });
  return getRosterView(ctx.branch.id, ctx.days[0]);
}

// ── 員工排假申請（本人；分店＝員工所屬分店） ──

/** 本期（查看／確認）＋下一期＋下下期（排假截止為開始前 14 日，通常只剩下下期開放） */
const OFF_REQUEST_CYCLES_AHEAD = 3;

async function loadSelfRosterContext(staffId) {
  const staff = await prisma.staff.findUnique({ where: { id: Number(staffId) }, select: rosterStaffSelect });
  if (!staff || !staff.isActive) throw httpError('找不到員工', 404);
  const branch = staff.branchId
    ? await prisma.branch.findUnique({
        where: { id: staff.branchId },
        select: { id: true, name: true, code: true, type: true, rosterConfig: true },
      })
    : null;
  const configured = Boolean(branch && normalizeBranchType(branch.type) === 'GYM' && branch.rosterConfig);
  return { staff, branch, configured };
}

async function selfCycleView(staff, branch, startKey, todayKey) {
  const days = cycleDays(startKey);
  const endKey = days[days.length - 1];
  const [period, request, holidays, leaves] = await Promise.all([
    prisma.rosterPeriod.findUnique({
      where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
      select: { id: true, status: true, publishedAt: true },
    }),
    prisma.rosterOffRequest.findUnique({
      where: { branchId_staffId_cycleStartDate: { branchId: branch.id, staffId: staff.id, cycleStartDate: dateOf(startKey) } },
      select: { dates: true, note: true, submittedAt: true, updatedAt: true },
    }),
    prisma.publicHoliday.findMany({
      where: { date: { gte: dateOf(startKey), lte: dateOf(endKey) } },
      select: { date: true, name: true },
    }),
    prisma.staffLeave.findMany({
      where: {
        staffId: staff.id,
        status: 'APPROVED',
        startAt: { lt: new Date(`${addDaysKey(endKey, 1)}T00:00:00+08:00`) },
        endAt: { gt: new Date(`${startKey}T00:00:00+08:00`) },
      },
      select: { startAt: true, endAt: true },
    }),
  ]);
  const published = period?.status === 'PUBLISHED';
  const [entries, ackRow] = published
    ? await Promise.all([
        prisma.staffSchedule.findMany({
          where: { rosterPeriodId: period.id, staffId: staff.id },
          select: { workDate: true, slotType: true, shiftCode: true },
        }),
        prisma.rosterAcknowledgement.findUnique({
          where: {
            rosterPeriodId_staffId_periodPublishedAt: {
              rosterPeriodId: period.id,
              staffId: staff.id,
              periodPublishedAt: period.publishedAt,
            },
          },
          select: { status: true, message: true, respondedAt: true, autoConfirmed: true },
        }),
      ])
    : [[], null];
  const deadlineKey = offRequestDeadlineKey(startKey);
  const offRequestOpen = !published && todayKey <= deadlineKey;
  const ackDeadline = published ? rosterAckDeadline(period.publishedAt) : null;
  const holidayNames = new Map(holidays.map((h) => [dbDateKey(h.date), h.name]));
  const leaveDays = new Set();
  for (const l of leaves) for (const k of leaveDateKeys(l)) if (k >= startKey && k <= endKey) leaveDays.add(k);
  return {
    startDate: startKey,
    endDate: endKey,
    days: days.map((d) => ({ date: d, weekday: new Date(`${d}T00:00:00Z`).getUTCDay(), holiday: holidayNames.get(d) ?? null })),
    period: period ? { status: period.status, publishedAt: period.publishedAt } : null,
    offRequestDeadline: deadlineKey,
    locked: !offRequestOpen,
    ack:
      published && entries.length > 0
        ? {
            deadline: ackDeadline,
            status: ackRow?.status ?? 'PENDING',
            message: ackRow?.message ?? null,
            respondedAt: ackRow?.respondedAt ?? null,
            overdue: !ackRow && Date.now() > ackDeadline.getTime(),
            late: Boolean(ackRow && ackRow.respondedAt > ackDeadline),
            autoConfirmed: Boolean(ackRow?.autoConfirmed),
          }
        : null,
    request: request
      ? { dates: request.dates.map(dbDateKey).sort(), note: request.note, submittedAt: request.submittedAt, updatedAt: request.updatedAt }
      : null,
    cells: Object.fromEntries(entries.map((e) => [dbDateKey(e.workDate), cellOf(e)])),
    leaveDays: [...leaveDays],
  };
}

/** 本人排班總覽：本期起三期（已發布才回班表與確認狀態，草稿不外露） */
export async function getMyRosterOverview(staffId) {
  const { staff, branch, configured } = await loadSelfRosterContext(staffId);
  const rosterRole = rosterRoleOf(staff);
  const base = {
    rosterRole,
    rosterRoleLabel: ROSTER_ROLE_LABELS[rosterRole] ?? null,
    weekPlanRole: weekPlanRoleOf(staff),
    eligible: isRosterEligible(staff),
    maxOffDays: maxOffRequestDays(staff),
    offRequestDeadlineDays: OFF_REQUEST_DEADLINE_DAYS,
    ackHours: ROSTER_ACK_HOURS,
    branch: branch ? { id: branch.id, name: branch.name, code: branch.code } : null,
    configured,
    cycles: [],
  };
  if (!configured || !base.eligible) return base;
  const todayKey = taipeiDateKey();
  const current = cycleStartFor(dbDateKey(branch.rosterConfig.cycleAnchorDate), todayKey);
  const starts = Array.from({ length: OFF_REQUEST_CYCLES_AHEAD }, (_, i) => addDaysKey(current, i * ROSTER_CYCLE_DAYS));
  base.cycles = await Promise.all(starts.map((k) => selfCycleView(staff, branch, k, todayKey)));
  return base;
}

/** 員工確認回覆已發布班表：CONFIRMED 確認／DISPUTED 提出異議（須附說明）；逾 72 小時仍可回覆但標記逾期 */
export async function respondRosterAck(staffId, input) {
  const { staff, branch, configured } = await loadSelfRosterContext(staffId);
  if (!configured) throw httpError('所屬分店尚未設定排班週期', 400, 'ROSTER_NOT_CONFIGURED');
  const startKey = String(input?.cycleStartDate || '');
  if (!isDateKey(startKey)) throw httpError('週期起日格式須為 YYYY-MM-DD');
  const status = String(input?.status || '').toUpperCase();
  if (!ROSTER_ACK_STATUSES.includes(status)) throw httpError('回覆須為 CONFIRMED 或 DISPUTED');
  const message = input?.message ? String(input.message).trim().slice(0, 300) || null : null;
  if (status === 'DISPUTED' && !message) throw httpError('提出異議須填寫說明');

  const period = await prisma.rosterPeriod.findUnique({
    where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
    select: { id: true, status: true, publishedAt: true },
  });
  if (period?.status !== 'PUBLISHED' || !period.publishedAt) {
    throw httpError('本期班表尚未發布', 409, 'ROSTER_NOT_PUBLISHED');
  }
  const assigned = await prisma.staffSchedule.count({ where: { rosterPeriodId: period.id, staffId: staff.id } });
  if (assigned === 0) throw httpError('本期班表未排入您的班次，無需確認', 403, 'NOT_IN_ROSTER');

  const key = { rosterPeriodId: period.id, staffId: staff.id, periodPublishedAt: period.publishedAt };
  const respondedAt = new Date();
  await prisma.rosterAcknowledgement.upsert({
    where: { rosterPeriodId_staffId_periodPublishedAt: key },
    create: { ...key, status, message, respondedAt },
    update: { status, message, respondedAt, autoConfirmed: false },
  });
  const endKey = addDaysKey(startKey, ROSTER_CYCLE_DAYS - 1);
  if (status === 'DISPUTED') {
    void notifyRosterDisputed({
      branchId: branch.id,
      branchName: branch.name,
      periodId: period.id,
      publishedAt: period.publishedAt,
      staffId: staff.id,
      message,
      late: respondedAt > rosterAckDeadline(period.publishedAt),
      respondedAt,
      startKey,
      endKey,
    });
  }
  void maybeNotifyAckSummary({ ...period, branchId: branch.id, branchName: branch.name, startKey, endKey });
  return getMyRosterOverview(staff.id);
}

/** 本期須回覆者（有排班格）皆已回覆 → 通知分店督導（每次發布僅一次） */
async function maybeNotifyAckSummary(p) {
  try {
    const [entries, acks] = await Promise.all([
      prisma.staffSchedule.findMany({ where: { rosterPeriodId: p.id }, select: { staffId: true }, distinct: ['staffId'] }),
      prisma.rosterAcknowledgement.findMany({
        where: { rosterPeriodId: p.id, periodPublishedAt: p.publishedAt },
        select: { staffId: true, status: true, autoConfirmed: true },
      }),
    ]);
    const required = new Set(entries.map((e) => e.staffId));
    const answered = acks.filter((a) => required.has(a.staffId));
    if (!required.size || answered.length < required.size) return;
    await notifyRosterAckSummary({
      branchId: p.branchId,
      branchName: p.branchName,
      periodId: p.id,
      publishedAt: p.publishedAt,
      startKey: p.startKey,
      endKey: p.endKey,
      total: required.size,
      confirmed: answered.filter((a) => a.status === 'CONFIRMED').length,
      autoConfirmed: answered.filter((a) => a.autoConfirmed).length,
      disputed: answered.filter((a) => a.status === 'DISPUTED').length,
    });
  } catch (err) {
    console.error('[排班確認] 彙整通知失敗:', err.message);
  }
}

/** 只掃近 90 日發布之期別（涵蓋停機補跑，避免每輪掃全部歷史） */
const AUTO_CONFIRM_LOOKBACK_DAYS = 90;

/**
 * 逾期未回覆自動視為同意：已發布超過 72 小時之期別，為有排班格但無回覆者補寫
 * CONFIRMED（autoConfirmed=true、respondedAt＝期限）；已回覆者不覆寫
 */
export async function autoConfirmOverdueAcks(now = new Date()) {
  const cutoff = new Date(now.getTime() - ROSTER_ACK_HOURS * 3600000);
  const horizon = new Date(now.getTime() - AUTO_CONFIRM_LOOKBACK_DAYS * 86400000);
  const periods = await prisma.rosterPeriod.findMany({
    where: { status: 'PUBLISHED', publishedAt: { lte: cutoff, gte: horizon } },
    select: {
      id: true,
      publishedAt: true,
      startDate: true,
      branchId: true,
      branch: { select: { name: true } },
      entries: { select: { staffId: true }, distinct: ['staffId'] },
      acks: { select: { staffId: true, periodPublishedAt: true } },
    },
  });
  let created = 0;
  for (const p of periods) {
    const answered = new Set(
      p.acks.filter((a) => a.periodPublishedAt.getTime() === p.publishedAt.getTime()).map((a) => a.staffId),
    );
    const missing = p.entries.map((e) => e.staffId).filter((id) => !answered.has(id));
    if (missing.length === 0) continue;
    const deadline = rosterAckDeadline(p.publishedAt);
    const { count } = await prisma.rosterAcknowledgement.createMany({
      data: missing.map((staffId) => ({
        rosterPeriodId: p.id,
        staffId,
        periodPublishedAt: p.publishedAt,
        status: 'CONFIRMED',
        autoConfirmed: true,
        respondedAt: deadline,
      })),
      skipDuplicates: true,
    });
    created += count;
    if (count > 0) {
      const startKey = dbDateKey(p.startDate);
      const info = {
        periodId: p.id,
        publishedAt: p.publishedAt,
        branchName: p.branch?.name ?? '',
        startKey,
        endKey: addDaysKey(startKey, ROSTER_CYCLE_DAYS - 1),
      };
      await notifyRosterAutoConfirmed({ ...info, staffIds: missing });
      await maybeNotifyAckSummary({ ...info, id: p.id, branchId: p.branchId });
    }
  }
  return { created };
}

let ackSchedulerTimer = null;

/** 排程：預設每 5 分鐘補寫逾期自動同意（ROSTER_ACK_TICK_MS 可調） */
export function startRosterAckScheduler(intervalMs) {
  if (ackSchedulerTimer) return;
  const ms = Number(intervalMs) || Number(process.env.ROSTER_ACK_TICK_MS) || 5 * 60 * 1000;
  const tick = async () => {
    try {
      const { created } = await autoConfirmOverdueAcks();
      if (created > 0) console.log(`[排班確認] 逾期未回覆自動視為同意 ${created} 筆`);
    } catch (error) {
      console.error('[排班確認] 自動同意排程例外:', error.message);
    }
  };
  void tick();
  ackSchedulerTimer = setInterval(() => void tick(), ms);
  if (typeof ackSchedulerTimer.unref === 'function') ackSchedulerTimer.unref();
}

/** 遞交／修改排假申請；dates 為空＝撤回。每期開始前 14 日截止，班表發布後亦截止 */
export async function submitOffRequest(staffId, input) {
  const { staff, branch, configured } = await loadSelfRosterContext(staffId);
  if (!isRosterEligible(staff)) {
    throw httpError('僅排班編制（場務／實習教練）需遞交排假；轉正教練請使用自由排班', 403, 'OFF_REQUEST_NOT_ALLOWED');
  }
  if (!configured) throw httpError('所屬分店尚未設定排班週期', 400, 'ROSTER_NOT_CONFIGURED');
  const startKey = String(input?.cycleStartDate || '');
  if (!isDateKey(startKey)) throw httpError('週期起日格式須為 YYYY-MM-DD');
  if (cycleStartFor(dbDateKey(branch.rosterConfig.cycleAnchorDate), startKey) !== startKey) {
    throw httpError('週期起日未對齊四週週期', 400, 'CYCLE_MISALIGNED');
  }
  const days = cycleDays(startKey);
  const deadlineKey = offRequestDeadlineKey(startKey);
  if (taipeiDateKey() > deadlineKey) {
    throw httpError(`本期排假已於 ${deadlineKey} 截止（每期開始前 14 日），請洽店長`, 409, 'OFF_REQUEST_CLOSED');
  }
  const period = await prisma.rosterPeriod.findUnique({
    where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
    select: { status: true },
  });
  if (period?.status === 'PUBLISHED') {
    throw httpError('本期班表已發布，排假申請已截止，請洽店長', 409, 'ROSTER_PUBLISHED');
  }

  const raw = Array.isArray(input?.dates) ? input.dates.map(String) : [];
  const dates = [...new Set(raw)].sort();
  if (dates.some((d) => !days.includes(d))) throw httpError('排假日期須在本週期內');
  const maxDays = maxOffRequestDays(staff);
  if (dates.length > maxDays) {
    throw httpError(`本期最多可申請 ${maxDays} 日排休`, 400, 'OFF_REQUEST_LIMIT');
  }
  const note = input?.note ? String(input.note).trim().slice(0, 200) || null : null;
  const where = { branchId_staffId_cycleStartDate: { branchId: branch.id, staffId: staff.id, cycleStartDate: dateOf(startKey) } };

  let changed = true;
  if (dates.length === 0) {
    const { count } = await prisma.rosterOffRequest.deleteMany({
      where: { branchId: branch.id, staffId: staff.id, cycleStartDate: dateOf(startKey) },
    });
    changed = count > 0;
  } else {
    const data = { dates: dates.map(dateOf), note };
    await prisma.rosterOffRequest.upsert({
      where,
      create: { branchId: branch.id, staffId: staff.id, cycleStartDate: dateOf(startKey), ...data },
      update: data,
    });
  }
  if (changed) {
    void notifyOffRequestSubmitted({
      branchId: branch.id,
      branchName: branch.name,
      staffId: staff.id,
      startKey,
      endKey: days[days.length - 1],
      dates,
      deadlineKey,
    });
  }
  return getMyRosterOverview(staff.id);
}

/** 排假截止前 N 日提醒未遞交者 */
export const OFF_REQUEST_REMIND_DAYS = 3;
/** 確認期限前 N 小時提醒未回覆者 */
export const ROSTER_ACK_REMIND_HOURS = 24;

/**
 * 通知排程（staffNotificationScheduler）：確認期限前 24h 提醒、排假截止前 3 日提醒、排假截止後彙整給督導。
 * 皆以 dedupeKey 保證每期只發一次。
 */
export async function runRosterReminders(now = new Date()) {
  const result = { ackReminders: 0, offReminders: 0, offClosed: 0 };

  const remindFrom = new Date(now.getTime() - ROSTER_ACK_HOURS * 3600000);
  const remindTo = new Date(now.getTime() - (ROSTER_ACK_HOURS - ROSTER_ACK_REMIND_HOURS) * 3600000);
  const periods = await prisma.rosterPeriod.findMany({
    where: { status: 'PUBLISHED', publishedAt: { gt: remindFrom, lte: remindTo } },
    select: {
      id: true,
      publishedAt: true,
      startDate: true,
      branch: { select: { name: true } },
      entries: { select: { staffId: true }, distinct: ['staffId'] },
      acks: { select: { staffId: true, periodPublishedAt: true } },
    },
  });
  for (const p of periods) {
    const answered = new Set(
      p.acks.filter((a) => a.periodPublishedAt.getTime() === p.publishedAt.getTime()).map((a) => a.staffId),
    );
    const missing = p.entries.map((e) => e.staffId).filter((id) => !answered.has(id));
    if (!missing.length) continue;
    const startKey = dbDateKey(p.startDate);
    result.ackReminders += await notifyRosterAckReminder({
      periodId: p.id,
      publishedAt: p.publishedAt,
      ackDeadline: rosterAckDeadline(p.publishedAt),
      branchName: p.branch?.name ?? '',
      startKey,
      endKey: addDaysKey(startKey, ROSTER_CYCLE_DAYS - 1),
      staffIds: missing,
    });
  }

  const todayKey = taipeiDateKey(now);
  const branches = await prisma.branch.findMany({
    where: { isActive: true, rosterConfig: { isNot: null } },
    select: { id: true, name: true, type: true, rosterConfig: true },
  });
  for (const branch of branches) {
    if (normalizeBranchType(branch.type) !== 'GYM') continue;
    const current = cycleStartFor(dbDateKey(branch.rosterConfig.cycleAnchorDate), todayKey);
    for (let i = 1; i < OFF_REQUEST_CYCLES_AHEAD; i += 1) {
      const startKey = addDaysKey(current, i * ROSTER_CYCLE_DAYS);
      const endKey = addDaysKey(startKey, ROSTER_CYCLE_DAYS - 1);
      const deadlineKey = offRequestDeadlineKey(startKey);
      const remindable = todayKey >= addDaysKey(deadlineKey, -OFF_REQUEST_REMIND_DAYS) && todayKey <= deadlineKey;
      const closed = todayKey > deadlineKey && todayKey < startKey;
      if (!remindable && !closed) continue;
      const period = await prisma.rosterPeriod.findUnique({
        where: { branchId_startDate: { branchId: branch.id, startDate: dateOf(startKey) } },
        select: { status: true },
      });
      if (period?.status === 'PUBLISHED') continue;
      const [staff, requests] = await Promise.all([
        prisma.staff.findMany({ where: { branchId: branch.id, isActive: true }, select: rosterStaffSelect }),
        prisma.rosterOffRequest.findMany({
          where: { branchId: branch.id, cycleStartDate: dateOf(startKey) },
          select: { staffId: true },
        }),
      ]);
      const eligible = staff.filter(isRosterEligible);
      const submitted = new Set(requests.map((r) => r.staffId));
      const info = { branchId: branch.id, branchName: branch.name, startKey, endKey, deadlineKey };
      if (remindable) {
        const pending = eligible.filter((s) => !submitted.has(s.id)).map((s) => s.id);
        if (pending.length) result.offReminders += await notifyOffRequestReminder({ ...info, staffIds: pending });
      } else {
        result.offClosed += await notifyOffRequestClosed({
          ...info,
          submitted: eligible.filter((s) => submitted.has(s.id)).length,
          total: eligible.length,
        });
      }
    }
  }
  return result;
}

export const ROSTER_META = {
  shifts: ROSTER_SHIFTS,
  offCodes: OFF_CODES,
  minHeadcount: MIN_SHIFT_HEADCOUNT,
  cycleDays: ROSTER_CYCLE_DAYS,
  offRequestDeadlineDays: OFF_REQUEST_DEADLINE_DAYS,
  ackHours: ROSTER_ACK_HOURS,
};
