// lib/payrollExport.js — 工資核算匯出：月度考勤標記／總數＋請假時數（僅彙整事實，不計算薪資金額）
/**
 * 口徑：
 * - 月份以台北日期切分；打卡依「上班打卡日」歸月。
 * - 考勤旗標與曠職沿用 attendanceService（寬限 ATTENDANCE_GRACE_MINUTES、僅已生效班表）。
 * - 實際工時僅計已打下班卡者；未打下班卡／上班中列「需人工確認」，應先更正再核薪。
 * - 請假時數＝已核准請假，跨月者依時段重疊比例分攤。
 * - 國定假日／休息日／例假出勤另列時數（加班費認定由薪資端依勞基法 §24／§39／§40 處理）。
 * - 分店篩選以員工所屬分店（Staff.branchId）為準。
 * 後端僅回 JSON 列資料；CSV 由前端依 columns 組檔。
 */
import prisma from './prisma.js';
import { EMPLOYMENT_TYPES, LEAVE_TYPES, addDaysKey, dbDateKey, taipeiDateKey } from './laborLaw.js';
import { positionLabel } from './orgStructure.js';
import { resolveLeaveHours } from './staffLeaveBalance.js';
import { ATTENDANCE_FLAGS, ATTENDANCE_GRACE_MINUTES, listAttendance } from './attendanceService.js';

const MAX_ROWS = 50000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const hours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

export function monthRange(month) {
  const m = MONTH_RE.exec(String(month || ''));
  if (!m) throw httpError('month 格式須為 YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const fromKey = `${month}-01`;
  const nextKey = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  const toKey = addDaysKey(nextKey, -1);
  return {
    fromKey,
    toKey,
    start: new Date(`${fromKey}T00:00:00+08:00`),
    end: new Date(`${nextKey}T00:00:00+08:00`),
  };
}

function tpeDateTime(d) {
  if (!d) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(d))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

const LEAVE_COLUMNS = Object.entries(LEAVE_TYPES).map(([key, label]) => ({
  key: `leave_${key}`,
  label: `請假－${label}(h)`,
  numeric: true,
}));

export const PAYROLL_SUMMARY_COLUMNS = [
  { key: 'staffId', label: '員工ID' },
  { key: 'account', label: '帳號' },
  { key: 'name', label: '姓名' },
  { key: 'branch', label: '所屬分店' },
  { key: 'position', label: '職位' },
  { key: 'employmentType', label: '工作型態' },
  { key: 'weeklyHours', label: '約定週工時' },
  { key: 'scheduledShifts', label: '排定班次', numeric: true },
  { key: 'scheduledHours', label: '排定工時(h)', numeric: true },
  { key: 'records', label: '打卡筆數', numeric: true },
  { key: 'workedHours', label: '實際工時(h)', numeric: true },
  { key: 'lateCount', label: '遲到次數', numeric: true },
  { key: 'lateMinutes', label: '遲到分鐘', numeric: true },
  { key: 'earlyCount', label: '早退次數', numeric: true },
  { key: 'earlyMinutes', label: '早退分鐘', numeric: true },
  { key: 'overMinutes', label: '延後下班分鐘', numeric: true },
  { key: 'missedPunchOut', label: '未打下班卡', numeric: true },
  { key: 'open', label: '上班中', numeric: true },
  { key: 'absentShifts', label: '曠職班次', numeric: true },
  { key: 'absentHours', label: '曠職工時(h)', numeric: true },
  { key: 'unscheduledRecords', label: '未排班出勤筆數', numeric: true },
  { key: 'unscheduledHours', label: '未排班出勤工時(h)', numeric: true },
  { key: 'holidayWorkedHours', label: '國定假日出勤(h)', numeric: true },
  { key: 'restDayWorkedHours', label: '休息日出勤(h)', numeric: true },
  { key: 'regularOffWorkedHours', label: '例假出勤(h)', numeric: true },
  ...LEAVE_COLUMNS,
  { key: 'leaveHours', label: '請假合計(h)', numeric: true },
  { key: 'needsReview', label: '需人工確認' },
];

export const PAYROLL_DETAIL_COLUMNS = [
  { key: 'date', label: '日期' },
  { key: 'staffId', label: '員工ID' },
  { key: 'account', label: '帳號' },
  { key: 'name', label: '姓名' },
  { key: 'kind', label: '類別' },
  { key: 'dayType', label: '日別' },
  { key: 'branch', label: '打卡／班次分店' },
  { key: 'schedule', label: '班次' },
  { key: 'scheduleStart', label: '班表起' },
  { key: 'scheduleEnd', label: '班表迄' },
  { key: 'punchIn', label: '上班打卡' },
  { key: 'punchOut', label: '下班打卡' },
  { key: 'workedMinutes', label: '工時(分)', numeric: true },
  { key: 'lateMinutes', label: '遲到(分)', numeric: true },
  { key: 'earlyMinutes', label: '早退(分)', numeric: true },
  { key: 'overMinutes', label: '延後下班(分)', numeric: true },
  { key: 'flags', label: '標記' },
];

/** 下班晚於班表迄時超過寬限之分鐘數（加班與否由主管認定） */
export function overMinutesOf(row) {
  if (!row.schedule || !row.punchOut) return 0;
  const diff = (new Date(row.punchOut) - new Date(row.schedule.endAt)) / 60000;
  return diff > ATTENDANCE_GRACE_MINUTES ? Math.round(diff) : 0;
}

function emptyAgg() {
  return {
    overMinutes: 0,
    holidayMinutes: 0,
    restDayMinutes: 0,
    regularOffMinutes: 0,
    leave: Object.fromEntries(Object.keys(LEAVE_TYPES).map((k) => [k, 0])),
  };
}

/**
 * 月度考勤／假期事實（工資匯出與薪資結算共用；不含金額）
 * @param {{ month: string, branchId?: number|null, extraStaffIds?: number[] }} opts
 */
export async function collectPayrollFacts({ month, branchId = null, extraStaffIds = [] }) {
  const { fromKey, toKey, start, end } = monthRange(month);
  const todayKey = taipeiDateKey();
  if (fromKey > todayKey) throw httpError('不可匯出未來月份');

  const [attendance, branches, holidays, offSlots, leaves, pendingLeaves, draftPeriods, pendingCoachPlans] = await Promise.all([
    listAttendance({ from: fromKey, to: toKey, maxRows: MAX_ROWS }),
    prisma.branch.findMany({ select: { id: true, name: true, code: true } }),
    prisma.publicHoliday.findMany({ where: { date: { gte: new Date(`${fromKey}T00:00:00Z`), lte: new Date(`${toKey}T00:00:00Z`) } }, select: { date: true, name: true } }),
    prisma.staffSchedule.findMany({
      where: {
        slotType: { in: ['REGULAR_OFF', 'REST_DAY'] },
        OR: [{ rosterPeriod: { status: 'PUBLISHED' } }, { coachPlan: { status: 'APPROVED' } }],
        workDate: { gte: new Date(`${fromKey}T00:00:00Z`), lte: new Date(`${toKey}T00:00:00Z`) },
      },
      select: { staffId: true, workDate: true, slotType: true },
    }),
    prisma.staffLeave.findMany({
      where: { status: 'APPROVED', startAt: { lt: end }, endAt: { gt: start } },
      select: { staffId: true, leaveType: true, startAt: true, endAt: true, hours: true },
    }),
    prisma.staffLeave.findMany({ where: { status: 'PENDING', startAt: { lt: end }, endAt: { gt: start } }, select: { staffId: true } }),
    prisma.rosterPeriod.findMany({
      where: {
        status: 'DRAFT',
        startDate: { lte: new Date(`${toKey}T00:00:00Z`), gte: new Date(`${addDaysKey(fromKey, -27)}T00:00:00Z`) },
        ...(branchId ? { branchId } : {}),
      },
      select: { branchId: true, startDate: true },
    }),
    prisma.coachWeekPlan.count({
      where: {
        status: 'SUBMITTED',
        weekStart: { gte: new Date(`${addDaysKey(fromKey, -6)}T00:00:00Z`), lte: new Date(`${toKey}T00:00:00Z`) },
        ...(branchId ? { branchId } : {}),
      },
    }),
  ]);

  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const holidayName = new Map(holidays.map((h) => [dbDateKey(h.date), h.name]));
  const offDay = new Map(offSlots.map((s) => [`${s.staffId}:${dbDateKey(s.workDate)}`, s.slotType]));

  const involvedIds = new Set([
    ...attendance.rows.map((r) => r.staffId),
    ...attendance.absences.map((a) => a.staffId),
    ...attendance.byStaff.map((b) => b.staffId),
    ...leaves.map((l) => l.staffId),
    ...extraStaffIds,
  ]);
  const staffRows = await prisma.staff.findMany({
    where: {
      OR: [{ id: { in: [...involvedIds] } }, { isActive: true, role: { not: 'ADMIN' } }],
      ...(branchId ? { branchId } : {}),
    },
    select: {
      id: true,
      account: true,
      name: true,
      role: true,
      branchId: true,
      employmentType: true,
      weeklyHours: true,
      isActive: true,
      hireDate: true,
      laborActApplies: true,
      trainerProfile: { select: { id: true } },
    },
    orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
  });
  const staffById = new Map(staffRows.map((s) => [s.id, s]));

  /** HOLIDAY／REST_DAY／REGULAR_OFF／WORKDAY（互斥，國定假日優先） */
  const dayKindOf = (staffId, dateKey) => {
    if (holidayName.has(dateKey)) return 'HOLIDAY';
    const off = offDay.get(`${staffId}:${dateKey}`);
    if (off === 'REST_DAY' || off === 'REGULAR_OFF') return off;
    return 'WORKDAY';
  };

  const leaveHours = new Map();
  for (const l of leaves) {
    if (!staffById.has(l.staffId)) continue;
    const total = l.endAt - l.startAt;
    if (total <= 0) continue;
    const overlap = Math.min(l.endAt, end) - Math.max(l.startAt, start);
    const h = resolveLeaveHours(l.startAt, l.endAt, l.hours) * (overlap / total);
    const key = LEAVE_TYPES[l.leaveType] ? l.leaveType : 'OTHER';
    const m = leaveHours.get(l.staffId) ?? Object.fromEntries(Object.keys(LEAVE_TYPES).map((k) => [k, 0]));
    m[key] += h;
    leaveHours.set(l.staffId, m);
  }
  for (const m of leaveHours.values()) for (const k of Object.keys(m)) m[k] = round2(m[k]);

  const pendingByStaff = new Map();
  for (const p of pendingLeaves) pendingByStaff.set(p.staffId, (pendingByStaff.get(p.staffId) ?? 0) + 1);

  return {
    month,
    fromKey,
    toKey,
    start,
    end,
    todayKey,
    attendance,
    branchName,
    holidayName,
    staffRows,
    staffById,
    dayKindOf,
    leaveHours,
    pendingByStaff,
    pendingLeaveCount: pendingLeaves.length,
    draftPeriods,
    pendingCoachPlans,
  };
}

/**
 * @param {{ month: string, branchId?: number|null }} opts
 */
export async function buildPayrollExport({ month, branchId = null }) {
  const facts = await collectPayrollFacts({ month, branchId });
  const { fromKey, toKey, todayKey, attendance, branchName, holidayName, staffRows, staffById, dayKindOf, leaveHours, draftPeriods } = facts;
  const pendingLeaves = facts.pendingLeaveCount;
  const inScope = (id) => staffById.has(id);

  const agg = new Map(staffRows.map((s) => [s.id, emptyAgg()]));
  const dayTypeOf = (staffId, dateKey) => {
    const kind = dayKindOf(staffId, dateKey);
    if (kind === 'HOLIDAY') return `國定假日（${holidayName.get(dateKey)}）`;
    if (kind === 'REST_DAY') return '休息日';
    if (kind === 'REGULAR_OFF') return '例假';
    return '';
  };

  const detail = [];
  for (const r of attendance.rows) {
    if (!inScope(r.staffId)) continue;
    const s = staffById.get(r.staffId);
    const a = agg.get(r.staffId);
    const over = overMinutesOf(r);
    const worked = r.workedMinutes ?? 0;
    a.overMinutes += over;
    const kind = dayKindOf(r.staffId, r.dateKey);
    if (kind === 'HOLIDAY') a.holidayMinutes += worked;
    else if (kind === 'REST_DAY') a.restDayMinutes += worked;
    else if (kind === 'REGULAR_OFF') a.regularOffMinutes += worked;
    detail.push({
      date: r.dateKey,
      staffId: s.id,
      account: s.account,
      name: s.name,
      kind: '出勤',
      dayType: dayTypeOf(r.staffId, r.dateKey),
      branch: branchName.get(r.branchId) ?? '',
      schedule: r.schedule?.label ?? '',
      scheduleStart: tpeDateTime(r.schedule?.startAt),
      scheduleEnd: tpeDateTime(r.schedule?.endAt),
      punchIn: tpeDateTime(r.punchIn),
      punchOut: tpeDateTime(r.punchOut),
      workedMinutes: r.workedMinutes,
      lateMinutes: r.lateMinutes,
      earlyMinutes: r.earlyMinutes,
      overMinutes: over,
      flags: r.flags.map((f) => ATTENDANCE_FLAGS[f] ?? f).join('／'),
      _sort: new Date(r.punchIn).getTime(),
    });
  }
  for (const ab of attendance.absences) {
    if (!inScope(ab.staffId)) continue;
    const s = staffById.get(ab.staffId);
    detail.push({
      date: ab.dateKey,
      staffId: s.id,
      account: s.account,
      name: s.name,
      kind: '曠職',
      dayType: dayTypeOf(ab.staffId, ab.dateKey),
      branch: branchName.get(ab.branchId) ?? '',
      schedule: ab.label,
      scheduleStart: tpeDateTime(ab.startAt),
      scheduleEnd: tpeDateTime(ab.endAt),
      punchIn: '',
      punchOut: '',
      workedMinutes: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      overMinutes: 0,
      flags: '曠職（無打卡、無核准請假）',
      _sort: new Date(ab.startAt).getTime(),
    });
  }
  detail.sort((x, y) => x.staffId - y.staffId || x._sort - y._sort);
  for (const d of detail) delete d._sort;

  for (const [id, m] of leaveHours) {
    const a = agg.get(id);
    if (a) Object.assign(a.leave, m);
  }

  const tallies = new Map(attendance.byStaff.map((b) => [b.staffId, b]));
  const summaryRows = staffRows.map((s) => {
    const t = tallies.get(s.id) ?? {};
    const a = agg.get(s.id);
    const leaveCols = Object.fromEntries(Object.keys(LEAVE_TYPES).map((k) => [`leave_${k}`, round2(a.leave[k])]));
    const leaveHours = round2(Object.values(a.leave).reduce((n, v) => n + v, 0));
    const missed = t.missedPunchOut ?? 0;
    const open = t.open ?? 0;
    return {
      staffId: s.id,
      account: s.account,
      name: s.name,
      branch: s.branchId ? branchName.get(s.branchId) ?? '' : '跨店',
      position: positionLabel(s.role),
      employmentType: EMPLOYMENT_TYPES[s.employmentType]?.label ?? s.employmentType,
      weeklyHours: s.weeklyHours ?? (s.employmentType === 'FULL_TIME' ? 40 : ''),
      scheduledShifts: t.scheduled ?? 0,
      scheduledHours: hours(t.scheduledMinutes ?? 0),
      records: t.records ?? 0,
      workedHours: hours(t.workedMinutes ?? 0),
      lateCount: t.late ?? 0,
      lateMinutes: t.lateMinutes ?? 0,
      earlyCount: t.earlyLeave ?? 0,
      earlyMinutes: t.earlyMinutes ?? 0,
      overMinutes: a.overMinutes,
      missedPunchOut: missed,
      open,
      absentShifts: t.absent ?? 0,
      absentHours: hours(t.absentMinutes ?? 0),
      unscheduledRecords: t.unscheduled ?? 0,
      unscheduledHours: hours(t.unscheduledMinutes ?? 0),
      holidayWorkedHours: hours(a.holidayMinutes),
      restDayWorkedHours: hours(a.restDayMinutes),
      regularOffWorkedHours: hours(a.regularOffMinutes),
      ...leaveCols,
      leaveHours,
      needsReview: missed + open > 0 ? '是' : '',
    };
  });

  const totals = Object.fromEntries(
    PAYROLL_SUMMARY_COLUMNS.filter((c) => c.numeric).map((c) => [
      c.key,
      round2(summaryRows.reduce((n, r) => n + (Number(r[c.key]) || 0), 0)),
    ]),
  );

  const warnings = [];
  if (attendance.truncated) warnings.push(`打卡筆數超過 ${MAX_ROWS} 筆，資料已截斷，請改依分店分批匯出`);
  if (toKey >= todayKey) warnings.push('本月尚未結束，數字僅統計至今日');
  const review = summaryRows.filter((r) => r.needsReview).length;
  if (review) warnings.push(`${review} 位員工有未打下班卡／上班中紀錄，工時未計入，請先至「考勤」更正`);
  if (pendingLeaves) warnings.push(`有 ${pendingLeaves} 筆與本月重疊之請假尚待審核，未計入請假時數`);
  if (draftPeriods.length) {
    const names = [...new Set(draftPeriods.map((p) => branchName.get(p.branchId) ?? `#${p.branchId}`))];
    warnings.push(`${names.join('、')} 有未發布之四週排班期，相關日期不列排定班次與曠職`);
  }
  if (facts.pendingCoachPlans) warnings.push(`有 ${facts.pendingCoachPlans} 份週班表待核准，相關日期不列排定班次與例休`);

  return {
    month,
    from: fromKey,
    to: toKey,
    branchId,
    branchName: branchId ? branchName.get(branchId) ?? null : null,
    graceMinutes: ATTENDANCE_GRACE_MINUTES,
    generatedAt: new Date(),
    warnings,
    totals,
    summary: { columns: PAYROLL_SUMMARY_COLUMNS, rows: summaryRows },
    detail: { columns: PAYROLL_DETAIL_COLUMNS, rows: detail },
  };
}
