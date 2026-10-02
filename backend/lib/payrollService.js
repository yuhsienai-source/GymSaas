// lib/payrollService.js — 薪資結算：薪資設定、費率、月批次、加班核定、手動項、結算／撤銷、員工薪資單
/**
 * - 每月一批（全公司）；僅有薪資設定（StaffPayProfile）者產生薪資單。
 * - 有出勤／請假但無薪資設定者列批次警示並阻擋結算。
 * - 加班建議（延後下班、休息日／國定假日／例假出勤）須總部逐筆核定 approvedMinutes（0＝不計）才計入。
 * - 教練業績獎金由 lib/coachPerformance.js 依當月已執行課程自動計算並分列；底薪僅以薪資設定為準（教練須月薪 ≥ 基本工資或時薪 ≥ 基本時薪）。
 * - 金額一律由 lib/payrollRules.js 計算；前端僅顯示。
 * - 結算須月份已結束、加班全數核定、無未打下班卡／上班中紀錄；結算後通知員工（不含金額）。
 */
import { randomUUID } from 'node:crypto';
import prisma from './prisma.js';
import { lockPayrollRun } from './dbLocks.js';
import { EMPLOYMENT_TYPES, FULL_TIME_WEEKLY_HOURS, LEAVE_TYPES, dbDateKey, taipeiDateKey } from './laborLaw.js';
import { canonicalRole, positionLabel } from './orgStructure.js';
import { coachPerformanceBetween, performanceLines } from './coachPerformance.js';
import { collectPayrollFacts, monthRange, overMinutesOf } from './payrollExport.js';
import {
  ADJUSTMENT_TYPES,
  OVERTIME_KINDS,
  PAYROLL_CONFIG_META,
  PAYROLL_DEFAULT_CONFIG,
  PAY_TYPES,
  computePayslip,
  fixedAllowanceTotal,
  mergePayrollConfig,
} from './payrollRules.js';
import { notifyPayslipReady, notifyPayslipReopened } from './staffNotifyEvents.js';

const MAX_ADJUSTMENTS = 30;
const MAX_MONEY = 10_000_000;
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

function httpError(message, statusCode = 400, code, data) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function intOrNull(value, field, { min = 0, max = MAX_MONEY } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(`${field} 須為 ${min}～${max} 之整數`);
  return n;
}

function text(value, field, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s.length > max) throw httpError(`${field} 最多 ${max} 字`);
  return s || null;
}

// ── 費率設定 ──────────────────────────────────────

export async function getPayrollConfig() {
  const row = await prisma.payrollConfig.findUnique({ where: { id: 1 } });
  return {
    rates: mergePayrollConfig(row?.rates),
    defaults: PAYROLL_DEFAULT_CONFIG,
    meta: PAYROLL_CONFIG_META,
    updatedAt: row?.updatedAt ?? null,
    updatedByStaffId: row?.updatedByStaffId ?? null,
  };
}

export async function updatePayrollConfig(body, actorStaffId) {
  const rates = {};
  for (const [key, meta] of Object.entries(PAYROLL_CONFIG_META)) {
    const raw = body?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < meta.min || v > meta.max) throw httpError(`${meta.label} 須介於 ${meta.min}～${meta.max}`);
    rates[key] = v;
  }
  await prisma.payrollConfig.upsert({
    where: { id: 1 },
    create: { id: 1, rates, updatedByStaffId: actorStaffId },
    update: { rates, updatedByStaffId: actorStaffId },
  });
  return getPayrollConfig();
}

// ── 薪資設定 ──────────────────────────────────────

const PROFILE_FIELDS = [
  'payType',
  'monthlySalary',
  'hourlyWage',
  'allowances',
  'laborInsuredSalary',
  'healthInsuredSalary',
  'healthDependents',
  'pensionWage',
  'pensionSelfRate',
];

function profileSnapshot(p) {
  return Object.fromEntries(PROFILE_FIELDS.map((k) => [k, p[k] ?? null]));
}

export async function listPayProfiles() {
  const [staff, branches] = await Promise.all([
    prisma.staff.findMany({
      where: { OR: [{ isActive: true, role: { not: 'ADMIN' } }, { payProfile: { isNot: null } }] },
      select: {
        id: true,
        account: true,
        name: true,
        role: true,
        branchId: true,
        employmentType: true,
        weeklyHours: true,
        hireDate: true,
        laborActApplies: true,
        isActive: true,
        payProfile: true,
      },
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    }),
    prisma.branch.findMany({ select: { id: true, name: true } }),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  return {
    payTypes: PAY_TYPES,
    items: staff.map((s) => ({
      staffId: s.id,
      account: s.account,
      name: s.name,
      role: s.role,
      position: positionLabel(s.role),
      branchId: s.branchId,
      branchName: s.branchId ? branchName.get(s.branchId) ?? null : null,
      employmentType: s.employmentType,
      employmentLabel: EMPLOYMENT_TYPES[s.employmentType]?.label ?? s.employmentType,
      weeklyHours: s.weeklyHours,
      hireDate: s.hireDate ? dbDateKey(s.hireDate) : null,
      laborActApplies: s.laborActApplies,
      isActive: s.isActive,
      profile: s.payProfile
        ? { ...profileSnapshot(s.payProfile), note: s.payProfile.note, updatedAt: s.payProfile.updatedAt }
        : null,
    })),
  };
}

function parseAllowances(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw httpError('allowances 須為陣列');
  if (raw.length > 10) throw httpError('固定津貼最多 10 項');
  return raw.map((a, i) => {
    const label = text(a?.label, `津貼 #${i + 1} 名稱`, 30);
    if (!label) throw httpError(`津貼 #${i + 1} 須填名稱`);
    const amount = intOrNull(a?.amount, `津貼 #${i + 1} 金額`, { min: 1, max: 1_000_000 });
    if (amount == null) throw httpError(`津貼 #${i + 1} 須填金額`);
    return { label, amount };
  });
}

/**
 * 教練底薪（僱傭關係）：正職須月薪制且本薪 ≥ 基本工資；兼職／實習月薪 ≥ 基本工資 × 約定週工時／40，或時薪 ≥ 基本時薪。
 * 業績獎金另計，不得以抽成替代底薪。
 */
function assertCoachBasePay(staff, payType, monthlySalary, hourlyWage, cfg) {
  if (canonicalRole(staff.role) !== 'TRAINER' || staff.laborActApplies === false) return;
  const fail = (msg) => {
    throw httpError(`教練須有底薪且不得低於基本工資：${msg}（業績獎金另計，不得替代底薪）`, 400, 'COACH_BASE_PAY');
  };
  if (staff.employmentType === 'FULL_TIME') {
    if (payType !== 'MONTHLY') fail('正職教練須為月薪制');
    if (monthlySalary < cfg.minMonthlyWage) fail(`月薪不得低於 ${cfg.minMonthlyWage}`);
    return;
  }
  if (payType === 'HOURLY') {
    if (hourlyWage < cfg.minHourlyWage) fail(`時薪不得低於 ${cfg.minHourlyWage}`);
    return;
  }
  const ratio = Math.min(1, (Number(staff.weeklyHours) || FULL_TIME_WEEKLY_HOURS) / FULL_TIME_WEEKLY_HOURS);
  const floor = Math.ceil(cfg.minMonthlyWage * ratio);
  if (monthlySalary < floor) fail(`依約定週工時月薪不得低於 ${floor}`);
}

export async function upsertPayProfile(staffId, body, actorStaffId) {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { id: true, role: true, employmentType: true, weeklyHours: true, laborActApplies: true },
  });
  if (!staff) throw httpError('查無此員工', 404);
  const payType = String(body?.payType || 'MONTHLY').toUpperCase();
  if (!PAY_TYPES[payType]) throw httpError('payType 須為 MONTHLY 或 HOURLY');
  const monthlySalary = intOrNull(body?.monthlySalary, '月薪', { min: 1 });
  const hourlyWage = intOrNull(body?.hourlyWage, '時薪', { min: 1, max: 100_000 });
  if (payType === 'MONTHLY' && monthlySalary == null) throw httpError('月薪制須填月薪');
  if (payType === 'HOURLY' && hourlyWage == null) throw httpError('時薪制須填時薪');
  assertCoachBasePay(staff, payType, monthlySalary, hourlyWage, (await getPayrollConfig()).rates);
  const pensionSelfRate = body?.pensionSelfRate === undefined || body?.pensionSelfRate === '' ? 0 : Number(body.pensionSelfRate);
  if (!Number.isFinite(pensionSelfRate) || pensionSelfRate < 0 || pensionSelfRate > 0.06) {
    throw httpError('勞退自提比例須介於 0～6%');
  }
  const data = {
    payType,
    monthlySalary: payType === 'MONTHLY' ? monthlySalary : null,
    hourlyWage: payType === 'HOURLY' ? hourlyWage : null,
    allowances: parseAllowances(body?.allowances),
    laborInsuredSalary: intOrNull(body?.laborInsuredSalary, '勞保投保薪資', { min: 1 }),
    healthInsuredSalary: intOrNull(body?.healthInsuredSalary, '健保投保金額', { min: 1 }),
    healthDependents: intOrNull(body?.healthDependents, '健保眷屬人數', { min: 0, max: 10 }) ?? 0,
    pensionWage: intOrNull(body?.pensionWage, '勞退提繳工資', { min: 1 }),
    pensionSelfRate,
    note: text(body?.note, '備註', 200),
    updatedByStaffId: actorStaffId,
  };
  const row = await prisma.staffPayProfile.upsert({
    where: { staffId },
    create: { staffId, ...data },
    update: data,
  });
  return { staffId, ...profileSnapshot(row), note: row.note, updatedAt: row.updatedAt };
}

export async function deletePayProfile(staffId) {
  const { count } = await prisma.staffPayProfile.deleteMany({ where: { staffId } });
  if (!count) throw httpError('此員工尚無薪資設定', 404);
  return { staffId };
}

// ── 計算 ──────────────────────────────────────────

function monthsBetween(fromKey, toKey) {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/** 教練業績獎金：staffId → 業績（含薪資單分列明細） */
async function performanceByStaff(trainerIdByStaff, start, end) {
  const perf = await coachPerformanceBetween({ trainerIds: [...new Set(trainerIdByStaff.values())], start, end });
  const out = new Map();
  for (const [staffId, trainerId] of trainerIdByStaff) {
    const p = perf.get(trainerId);
    if (p) out.set(staffId, { ...p, trainerId, lines: performanceLines(p) });
  }
  return out;
}

/** 投保薪資／提繳工資低於當月經常性工資（本薪＋固定津貼＋業績獎金，封頂分級上限） */
function insuredSalaryNotes(staff, profile, facts, cfg) {
  if (!staff.laborActApplies) return [];
  const monthlyWage =
    (profile.payType === 'HOURLY' ? (Number(profile.hourlyWage) || 0) * (facts.regularMinutes / 60) : Number(profile.monthlySalary) || 0) +
    fixedAllowanceTotal(profile) +
    (Number(facts.performance?.total) || 0);
  const notes = [];
  const labor = Number(profile.laborInsuredSalary) || 0;
  if (labor && labor < Math.min(cfg.laborInsuredMax, monthlyWage)) {
    notes.push({ code: 'INSURED_SALARY_LOW', message: `勞保投保薪資 ${labor} 低於本月經常性工資 ${Math.round(monthlyWage)}，請依勞保條例 §14 調整（業績獎金以前 3 個月平均）` });
  }
  const pension = Number(profile.pensionWage) || 0;
  if (pension && pension < Math.min(cfg.pensionWageMax, monthlyWage)) {
    notes.push({ code: 'PENSION_WAGE_LOW', message: `勞退提繳工資 ${pension} 低於本月經常性工資 ${Math.round(monthlyWage)}，請依勞退條例 §15 調整` });
  }
  return notes;
}

/** 依已存事實＋核定／手動項計價（重算與逐筆核定共用） */
function priceItem({ profile, facts, overtime, adjustments }, cfg) {
  const result = computePayslip({ profile, cfg, facts, overtime, adjustments, performance: facts.performance });
  const warnings = [...(facts.notes || [])];
  const pending = overtime.filter((o) => o.approvedMinutes === null || o.approvedMinutes === undefined).length;
  if (pending) warnings.push({ code: 'OT_PENDING', message: `${pending} 筆加班建議待核定`, blocking: true });
  if (result.netPay < 0) warnings.push({ code: 'NEGATIVE_NET', message: '實發金額為負，請檢查扣款項目' });
  return { ...result, warnings };
}

function buildStaffFacts({ staff, profile, cfg, facts, performance }) {
  const { fromKey, toKey } = facts;
  const daysInMonth = Number(toKey.slice(8));
  const hireKey = staff.hireDate ? dbDateKey(staff.hireDate) : null;
  const employedDays = !hireKey || hireKey <= fromKey ? daysInMonth : daysInMonth - Number(hireKey.slice(8)) + 1;
  const records = facts.attendance.rows.filter((r) => r.staffId === staff.id);
  const tally = facts.attendance.byStaff.find((b) => b.staffId === staff.id) ?? {};

  let regularMinutes = 0;
  let unscheduledRecords = 0;
  const overtime = [];
  for (const r of records) {
    if (r.workedMinutes == null) continue;
    const dayKind = facts.dayKindOf(staff.id, r.dateKey);
    if (dayKind !== 'WORKDAY') {
      overtime.push({ key: `${r.id}:${dayKind}`, attendanceId: r.id, date: r.dateKey, kind: dayKind, suggestedMinutes: r.workedMinutes });
      continue;
    }
    const over = overMinutesOf(r);
    if (over > 0) overtime.push({ key: `${r.id}:WEEKDAY`, attendanceId: r.id, date: r.dateKey, kind: 'WEEKDAY', suggestedMinutes: over });
    if (r.schedule) {
      const slot = Math.round((new Date(r.schedule.endAt) - new Date(r.schedule.startAt)) / 60000);
      regularMinutes += Math.max(0, Math.min(r.workedMinutes - over, slot));
    } else {
      regularMinutes += r.workedMinutes;
      unscheduledRecords += 1;
    }
  }

  const leaveHours = facts.leaveHours.get(staff.id) ?? {};
  const missed = tally.missedPunchOut ?? 0;
  const open = tally.open ?? 0;
  const notes = [];
  if (missed + open > 0) {
    notes.push({ code: 'ATTENDANCE_REVIEW', message: `${missed + open} 筆未打下班卡／上班中，工時未計入，請先至「考勤」更正`, blocking: true });
  }
  if (profile.payType === 'MONTHLY' && staff.employmentType === 'FULL_TIME' && (profile.monthlySalary ?? 0) < cfg.minMonthlyWage) {
    notes.push({ code: 'BELOW_MIN_WAGE', message: `月薪低於基本工資 ${cfg.minMonthlyWage}` });
  }
  if (profile.payType === 'HOURLY' && (profile.hourlyWage ?? 0) < cfg.minHourlyWage) {
    notes.push({ code: 'BELOW_MIN_WAGE', message: `時薪低於基本工資 ${cfg.minHourlyWage}` });
  }
  if (staff.laborActApplies && !profile.laborInsuredSalary) notes.push({ code: 'NO_LABOR_INS', message: '未設定勞保投保薪資' });
  if (staff.laborActApplies && !profile.pensionWage) notes.push({ code: 'NO_PENSION', message: '未設定勞退提繳工資' });
  if (staff.employmentType === 'FULL_TIME' && !profile.healthInsuredSalary) notes.push({ code: 'NO_HEALTH_INS', message: '未設定健保投保金額' });
  if (!staff.isActive) notes.push({ code: 'INACTIVE', message: '員工已停用，本薪仍按在職日計，請確認離職日並以手動扣款調整' });
  if (!hireKey) notes.push({ code: 'NO_HIRE_DATE', message: '未設定到職日，視為整月在職' });
  if ((leaveHours.OTHER ?? 0) > 0) notes.push({ code: 'LEAVE_OTHER', message: '含「其他」假別，已按全薪計，請確認' });
  if (profile.payType === 'MONTHLY' && unscheduledRecords) {
    notes.push({ code: 'UNSCHEDULED', message: `${unscheduledRecords} 筆未排班出勤未列加班建議，如屬加班請以手動加項處理` });
  }
  const pendingLeaves = facts.pendingByStaff.get(staff.id) ?? 0;
  if (pendingLeaves) notes.push({ code: 'LEAVE_PENDING', message: `${pendingLeaves} 筆請假待審核，未計入` });
  const isCoach = canonicalRole(staff.role) === 'TRAINER';
  if (isCoach && staff.laborActApplies) {
    const lowMonthly = profile.payType === 'MONTHLY' && (profile.monthlySalary ?? 0) < cfg.minMonthlyWage && staff.employmentType === 'FULL_TIME';
    if (lowMonthly || (profile.payType === 'HOURLY' && staff.employmentType === 'FULL_TIME')) {
      notes.push({ code: 'COACH_BASE_PAY', message: '正職教練須為月薪制且本薪不得低於基本工資，請至薪資設定修正', blocking: true });
    }
  }
  if (isCoach && !staff.trainerProfile) notes.push({ code: 'NO_TRAINER_PROFILE', message: '未綁定教練檔案，無業績獎金' });
  notes.push(...insuredSalaryNotes(staff, profile, { regularMinutes, performance }, cfg));

  return {
    overtime,
    facts: {
      payType: profile.payType,
      employmentType: staff.employmentType,
      hireDate: hireKey,
      daysInMonth,
      employedDays,
      insuredDays: employedDays >= daysInMonth ? 30 : employedDays,
      healthCharged: true,
      laborActApplies: staff.laborActApplies,
      tenureMonths: hireKey ? monthsBetween(hireKey, toKey) : 999,
      workedMinutes: tally.workedMinutes ?? 0,
      regularMinutes,
      scheduledShifts: tally.scheduled ?? 0,
      scheduledMinutes: tally.scheduledMinutes ?? 0,
      lateCount: tally.late ?? 0,
      lateMinutes: tally.lateMinutes ?? 0,
      earlyCount: tally.earlyLeave ?? 0,
      earlyMinutes: tally.earlyMinutes ?? 0,
      absentShifts: tally.absent ?? 0,
      absentMinutes: tally.absentMinutes ?? 0,
      missedPunchOut: missed,
      open,
      unscheduledRecords,
      leaveHours,
      pendingLeaves,
      performance: performance ?? null,
      isActive: staff.isActive,
      notes,
    },
  };
}

/** 計算整月事實（不寫入） */
async function computeRunDraft(month) {
  const { start, end } = monthRange(month);
  const [profiles, config] = await Promise.all([prisma.staffPayProfile.findMany(), getPayrollConfig()]);
  const cfg = config.rates;
  const profileById = new Map(profiles.map((p) => [p.staffId, p]));
  const facts = await collectPayrollFacts({ month, extraStaffIds: [...profileById.keys()] });

  const active = new Set([
    ...facts.attendance.rows.map((r) => r.staffId),
    ...facts.attendance.absences.map((a) => a.staffId),
    ...facts.leaveHours.keys(),
  ]);
  const trainerIdByStaff = new Map(
    facts.staffRows.filter((s) => s.trainerProfile && profileById.has(s.id)).map((s) => [s.id, s.trainerProfile.id]),
  );
  const performances = await performanceByStaff(trainerIdByStaff, start, end);

  const items = [];
  const missingProfiles = [];
  for (const staff of facts.staffRows) {
    const profile = profileById.get(staff.id);
    if (!profile) {
      if (active.has(staff.id) && staff.role !== 'ADMIN') missingProfiles.push({ staffId: staff.id, name: staff.name });
      continue;
    }
    const hireKey = staff.hireDate ? dbDateKey(staff.hireDate) : null;
    if (hireKey && hireKey > facts.toKey) continue;
    if (!staff.isActive && !active.has(staff.id)) continue;
    const built = buildStaffFacts({ staff, profile: profileSnapshot(profile), cfg, facts, performance: performances.get(staff.id) });
    items.push({ staffId: staff.id, profile: profileSnapshot(profile), ...built });
  }

  const warnings = [];
  if (facts.attendance.truncated) warnings.push({ code: 'TRUNCATED', message: '打卡筆數過多已截斷，請聯絡系統管理員', blocking: true });
  if (facts.toKey >= facts.todayKey) warnings.push({ code: 'MONTH_OPEN', message: '本月尚未結束，僅可試算、不可結算', blocking: true });
  if (missingProfiles.length) {
    warnings.push({
      code: 'MISSING_PROFILE',
      message: `${missingProfiles.length} 位有出勤／請假之員工未設定薪資：${missingProfiles.map((m) => m.name).join('、')}`,
      staffIds: missingProfiles.map((m) => m.staffId),
      blocking: true,
    });
  }
  if (facts.draftPeriods.length) {
    const names = [...new Set(facts.draftPeriods.map((p) => facts.branchName.get(p.branchId) ?? `#${p.branchId}`))];
    warnings.push({ code: 'DRAFT_ROSTER', message: `${names.join('、')} 有未發布之四週排班期，相關日期不列排定班次、曠職與休息日` });
  }
  if (facts.pendingLeaveCount) warnings.push({ code: 'LEAVE_PENDING', message: `${facts.pendingLeaveCount} 筆請假待審核，未計入` });
  if (facts.pendingCoachPlans) {
    warnings.push({ code: 'COACH_PLAN_PENDING', message: `${facts.pendingCoachPlans} 份週班表待核准，相關日期不列排定班次與例休` });
  }
  return { cfg, items, warnings };
}

// ── 批次 ──────────────────────────────────────────

const RUN_TABLE_COLUMNS = [
  { key: 'staffId', label: '員工ID' },
  { key: 'account', label: '帳號' },
  { key: 'name', label: '姓名' },
  { key: 'branch', label: '所屬分店' },
  { key: 'payType', label: '計薪方式' },
  { key: 'base', label: '本薪／工時薪資', numeric: true },
  { key: 'paidLeave', label: '帶薪假', numeric: true },
  { key: 'allowance', label: '津貼', numeric: true },
  { key: 'overtime', label: '加班費', numeric: true },
  { key: 'performance', label: '教練業績獎金', numeric: true },
  { key: 'otherEarning', label: '獎金／其他加項', numeric: true },
  { key: 'grossPay', label: '應發合計', numeric: true },
  { key: 'leaveDeduction', label: '請假扣薪', numeric: true },
  { key: 'attendanceDeduction', label: '遲到早退／曠職扣薪', numeric: true },
  { key: 'laborIns', label: '勞保自付', numeric: true },
  { key: 'healthIns', label: '健保自付', numeric: true },
  { key: 'pensionSelf', label: '勞退自提', numeric: true },
  { key: 'incomeTax', label: '所得稅', numeric: true },
  { key: 'otherDeduction', label: '其他扣款', numeric: true },
  { key: 'deductionTotal', label: '應扣合計', numeric: true },
  { key: 'netPay', label: '實發金額', numeric: true },
  { key: 'laborInsEr', label: '勞保雇主', numeric: true },
  { key: 'healthInsEr', label: '健保雇主', numeric: true },
  { key: 'pensionEr', label: '勞退提繳', numeric: true },
  { key: 'employerCost', label: '雇主總成本', numeric: true },
];

function bucketOf(line) {
  const c = line.code;
  if (c === 'BASE') return 'base';
  if (c.startsWith('LEAVE_PAID_')) return 'paidLeave';
  if (c === 'ALLOWANCE_FIXED' || c === 'ADJ_ALLOWANCE') return 'allowance';
  if (c.startsWith('OT_')) return 'overtime';
  if (c === 'COMMISSION' || c.startsWith('PERF_')) return 'performance';
  if (c.startsWith('LEAVE_UNPAID_')) return 'leaveDeduction';
  if (c === 'TARDY' || c === 'ABSENT') return 'attendanceDeduction';
  if (c === 'LABOR_INS') return 'laborIns';
  if (c === 'HEALTH_INS') return 'healthIns';
  if (c === 'PENSION_SELF') return 'pensionSelf';
  if (c === 'ADJ_INCOME_TAX') return 'incomeTax';
  if (c === 'LABOR_INS_ER') return 'laborInsEr';
  if (c === 'HEALTH_INS_ER') return 'healthInsEr';
  if (c === 'PENSION_ER') return 'pensionEr';
  return line.kind === 'EARNING' ? 'otherEarning' : line.kind === 'DEDUCTION' ? 'otherDeduction' : null;
}

function tableRow(item, staff, branchName) {
  const row = Object.fromEntries(RUN_TABLE_COLUMNS.filter((c) => c.numeric).map((c) => [c.key, 0]));
  for (const l of item.lines || []) {
    const b = bucketOf(l);
    if (b) row[b] += l.amount;
  }
  return {
    ...row,
    staffId: item.staffId,
    account: staff?.account ?? '',
    name: staff?.name ?? '',
    branch: staff?.branchId ? branchName.get(staff.branchId) ?? '' : '跨店',
    payType: PAY_TYPES[item.profile?.payType] ?? '',
    grossPay: item.grossPay,
    deductionTotal: item.deductionTotal,
    netPay: item.netPay,
    employerCost: item.employerCost,
  };
}

function runSummary(run, items) {
  const sum = (k) => items.reduce((n, i) => n + (i[k] || 0), 0);
  return {
    id: run.id,
    month: run.month,
    status: run.status,
    calculatedAt: run.calculatedAt,
    finalizedAt: run.finalizedAt,
    finalizedByStaffId: run.finalizedByStaffId,
    itemCount: items.length,
    grossPay: sum('grossPay'),
    deductionTotal: sum('deductionTotal'),
    netPay: sum('netPay'),
    employerCost: sum('employerCost'),
  };
}

export async function listPayrollRuns() {
  const runs = await prisma.payrollRun.findMany({
    orderBy: { month: 'desc' },
    take: 36,
    include: { items: { select: { grossPay: true, deductionTotal: true, netPay: true, employerCost: true } } },
  });
  return { items: runs.map((r) => runSummary(r, r.items)) };
}

export async function getPayrollRun(runId) {
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: {
      items: {
        orderBy: { staffId: 'asc' },
        include: { staff: { select: { id: true, account: true, name: true, role: true, branchId: true } } },
      },
    },
  });
  if (!run) throw httpError('查無此薪資批次', 404);
  const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const items = run.items.map((i) => ({
    id: i.id,
    staffId: i.staffId,
    name: i.staff?.name ?? '',
    account: i.staff?.account ?? '',
    position: positionLabel(i.staff?.role),
    branchName: i.staff?.branchId ? branchName.get(i.staff.branchId) ?? null : null,
    profile: i.profile,
    facts: i.facts,
    overtime: i.overtime,
    adjustments: i.adjustments,
    lines: i.lines,
    grossPay: i.grossPay,
    deductionTotal: i.deductionTotal,
    netPay: i.netPay,
    employerCost: i.employerCost,
    warnings: i.warnings ?? [],
  }));
  return {
    run: { ...runSummary(run, run.items), config: run.config, warnings: run.warnings ?? [], history: run.history ?? [] },
    items,
    table: { columns: RUN_TABLE_COLUMNS, rows: run.items.map((i) => tableRow(i, i.staff, branchName)) },
    meta: { overtimeKinds: OVERTIME_KINDS, adjustmentTypes: ADJUSTMENT_TYPES, leaveTypes: LEAVE_TYPES, payTypes: PAY_TYPES },
  };
}

function itemData(runId, it, cfg) {
  const priced = priceItem(it, cfg);
  return {
    runId,
    staffId: it.staffId,
    profile: it.profile,
    facts: it.facts,
    overtime: it.overtime,
    adjustments: it.adjustments,
    lines: priced.lines,
    grossPay: priced.grossPay,
    deductionTotal: priced.deductionTotal,
    netPay: priced.netPay,
    employerCost: priced.employerCost,
    warnings: priced.warnings,
  };
}

/** 重算：沿用既有加班核定（依 key）與手動項（依 staffId） */
async function writeRecalc(tx, run, draft, actorStaffId) {
  const prev = await tx.payrollItem.findMany({ where: { runId: run.id } });
  const prevByStaff = new Map(prev.map((p) => [p.staffId, p]));
  const keep = new Set(draft.items.map((i) => i.staffId));
  const removed = prev.filter((p) => !keep.has(p.staffId));
  const orphanAdjustments = removed.filter((p) => (p.adjustments || []).length).map((p) => p.staffId);
  if (removed.length) await tx.payrollItem.deleteMany({ where: { id: { in: removed.map((p) => p.id) } } });
  const rows = draft.items.map((it) => {
    const old = prevByStaff.get(it.staffId);
    const decided = new Map((old?.overtime || []).map((o) => [o.key, o]));
    const overtime = it.overtime.map((o) => {
      const d = decided.get(o.key);
      if (!d || d.approvedMinutes === null || d.approvedMinutes === undefined) {
        return { ...o, approvedMinutes: null, decidedByStaffId: null, decidedAt: null };
      }
      return { ...o, approvedMinutes: Math.min(d.approvedMinutes, o.suggestedMinutes), decidedByStaffId: d.decidedByStaffId, decidedAt: d.decidedAt };
    });
    return itemData(run.id, { ...it, overtime, adjustments: old?.adjustments || [] }, draft.cfg);
  });
  const fresh = [];
  for (const row of rows) {
    const old = prevByStaff.get(row.staffId);
    if (!old) {
      fresh.push(row);
      continue;
    }
    const { runId: _r, staffId: _s, ...data } = row;
    await tx.payrollItem.update({ where: { id: old.id }, data });
  }
  if (fresh.length) await tx.payrollItem.createMany({ data: fresh });
  const warnings = [...draft.warnings];
  if (orphanAdjustments.length) {
    warnings.push({ code: 'ORPHAN_ADJUSTMENT', message: `${orphanAdjustments.length} 位員工已不在本批次，其手動項已移除`, staffIds: orphanAdjustments });
  }
  await tx.payrollRun.update({
    where: { id: run.id },
    data: { config: draft.cfg, warnings, calculatedAt: new Date(), history: [...(run.history || []), { action: 'RECALCULATE', at: new Date().toISOString(), byStaffId: actorStaffId }] },
  });
}

async function lockDraftRun(tx, runId) {
  const locked = await lockPayrollRun(tx, runId);
  if (!locked) throw httpError('查無此薪資批次', 404);
  if (locked.status !== 'DRAFT') throw httpError('薪資批次已結算，須先撤銷結算才可修改', 409, 'PAYROLL_FINALIZED');
  return tx.payrollRun.findUnique({ where: { id: runId } });
}

export async function createPayrollRun(month, actorStaffId) {
  const { fromKey } = monthRange(month);
  if (fromKey > taipeiDateKey()) throw httpError('不可建立未來月份之薪資批次');
  const existing = await prisma.payrollRun.findUnique({ where: { month }, select: { id: true } });
  if (existing) throw httpError(`${month} 已有薪資批次`, 409, 'PAYROLL_RUN_EXISTS', { id: existing.id });
  const draft = await computeRunDraft(month);
  let runId;
  try {
    runId = await prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.create({ data: { month, config: draft.cfg, createdByStaffId: actorStaffId, history: [] } });
      await writeRecalc(tx, run, draft, actorStaffId);
      return run.id;
    }, TX_OPTS);
  } catch (err) {
    if (err?.code === 'P2002') throw httpError(`${month} 已有薪資批次`, 409, 'PAYROLL_RUN_EXISTS');
    throw err;
  }
  return getPayrollRun(runId);
}

export async function recalculatePayrollRun(runId, actorStaffId) {
  const head = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { month: true, status: true } });
  if (!head) throw httpError('查無此薪資批次', 404);
  if (head.status !== 'DRAFT') throw httpError('薪資批次已結算，須先撤銷結算才可重算', 409, 'PAYROLL_FINALIZED');
  const draft = await computeRunDraft(head.month);
  await prisma.$transaction(async (tx) => {
    const run = await lockDraftRun(tx, runId);
    await writeRecalc(tx, run, draft, actorStaffId);
  }, TX_OPTS);
  return getPayrollRun(runId);
}

async function mutateItem(runId, itemId, mutate) {
  await prisma.$transaction(async (tx) => {
    const run = await lockDraftRun(tx, runId);
    const item = await tx.payrollItem.findFirst({ where: { id: itemId, runId } });
    if (!item) throw httpError('查無此薪資單', 404);
    const next = mutate({ overtime: item.overtime || [], adjustments: item.adjustments || [] });
    const data = itemData(runId, { ...item, ...next }, mergePayrollConfig(run.config));
    delete data.runId;
    delete data.staffId;
    await tx.payrollItem.update({ where: { id: itemId }, data });
  });
}

function applyDecision(o, approvedMinutes, actorStaffId, at) {
  if (approvedMinutes === null) return { ...o, approvedMinutes: null, decidedByStaffId: null, decidedAt: null };
  return { ...o, approvedMinutes, decidedByStaffId: actorStaffId, decidedAt: at.toISOString() };
}

/**
 * 加班核定
 * @param {{ mode?: 'SUGGESTED'|'REJECT', decisions?: { key: string, approvedMinutes: number|null }[] }} body
 */
export async function decideOvertime(runId, itemId, body, actorStaffId) {
  const at = new Date();
  const mode = body?.mode ? String(body.mode).toUpperCase() : null;
  if (mode && !['SUGGESTED', 'REJECT'].includes(mode)) throw httpError('mode 須為 SUGGESTED 或 REJECT');
  const decisions = Array.isArray(body?.decisions) ? body.decisions : [];
  if (!mode && !decisions.length) throw httpError('請提供 decisions 或 mode');
  await mutateItem(runId, itemId, ({ overtime, adjustments }) => {
    const byKey = new Map(overtime.map((o) => [o.key, o]));
    const set = new Map();
    for (const d of decisions) {
      const o = byKey.get(String(d?.key));
      if (!o) throw httpError(`查無加班建議 ${d?.key}`, 404);
      if (d.approvedMinutes === null) {
        set.set(o.key, null);
        continue;
      }
      const m = Number(d.approvedMinutes);
      if (!Number.isInteger(m) || m < 0 || m > o.suggestedMinutes) throw httpError(`核定分鐘須介於 0～${o.suggestedMinutes}`);
      set.set(o.key, m);
    }
    return {
      adjustments,
      overtime: overtime.map((o) => {
        if (set.has(o.key)) return applyDecision(o, set.get(o.key), actorStaffId, at);
        if (mode && (o.approvedMinutes === null || o.approvedMinutes === undefined)) {
          return applyDecision(o, mode === 'SUGGESTED' ? o.suggestedMinutes : 0, actorStaffId, at);
        }
        return o;
      }),
    };
  });
  return getPayrollRun(runId);
}

/** 整批：尚未核定之加班一律依建議核定或不計 */
export async function decideRunOvertime(runId, mode, actorStaffId) {
  const m = String(mode || '').toUpperCase();
  if (!['SUGGESTED', 'REJECT'].includes(m)) throw httpError('mode 須為 SUGGESTED 或 REJECT');
  const at = new Date();
  await prisma.$transaction(async (tx) => {
    const run = await lockDraftRun(tx, runId);
    const cfg = mergePayrollConfig(run.config);
    const items = await tx.payrollItem.findMany({ where: { runId } });
    for (const item of items) {
      const overtime = item.overtime || [];
      if (!overtime.some((o) => o.approvedMinutes === null || o.approvedMinutes === undefined)) continue;
      const next = overtime.map((o) =>
        o.approvedMinutes === null || o.approvedMinutes === undefined
          ? applyDecision(o, m === 'SUGGESTED' ? o.suggestedMinutes : 0, actorStaffId, at)
          : o,
      );
      const data = itemData(runId, { ...item, overtime: next }, cfg);
      delete data.runId;
      delete data.staffId;
      await tx.payrollItem.update({ where: { id: item.id }, data });
    }
  }, TX_OPTS);
  return getPayrollRun(runId);
}

export async function addAdjustment(runId, itemId, body, actorStaffId) {
  const type = String(body?.type || '').toUpperCase();
  if (!ADJUSTMENT_TYPES[type]) throw httpError('type 無效');
  const amount = intOrNull(body?.amount, '金額', { min: 1 });
  if (amount == null) throw httpError('請填金額');
  const label = text(body?.label, '項目名稱', 30) || ADJUSTMENT_TYPES[type].label;
  const note = text(body?.note, '備註', 200);
  await mutateItem(runId, itemId, ({ overtime, adjustments }) => {
    if (adjustments.length >= MAX_ADJUSTMENTS) throw httpError(`手動項最多 ${MAX_ADJUSTMENTS} 筆`);
    return {
      overtime,
      adjustments: [...adjustments, { id: randomUUID().slice(0, 8), type, label, amount, note, byStaffId: actorStaffId, at: new Date().toISOString() }],
    };
  });
  return getPayrollRun(runId);
}

export async function removeAdjustment(runId, itemId, adjId) {
  await mutateItem(runId, itemId, ({ overtime, adjustments }) => {
    if (!adjustments.some((a) => a.id === adjId)) throw httpError('查無此手動項', 404);
    return { overtime, adjustments: adjustments.filter((a) => a.id !== adjId) };
  });
  return getPayrollRun(runId);
}

/** 結算：先以最新考勤重算，再檢查阻擋條件 */
export async function finalizePayrollRun(runId, actorStaffId) {
  const head = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { month: true, status: true } });
  if (!head) throw httpError('查無此薪資批次', 404);
  if (head.status !== 'DRAFT') throw httpError('薪資批次已結算', 409, 'PAYROLL_FINALIZED');
  const { toKey } = monthRange(head.month);
  if (toKey >= taipeiDateKey()) throw httpError('月份尚未結束，不可結算', 409, 'PAYROLL_MONTH_OPEN');
  await recalculatePayrollRun(runId, actorStaffId);

  const finalizedAt = new Date();
  const staffIds = await prisma.$transaction(async (tx) => {
    const run = await lockDraftRun(tx, runId);
    const blocking = (run.warnings || []).filter((w) => w.blocking);
    if (blocking.length) throw httpError(blocking.map((w) => w.message).join('；'), 409, 'PAYROLL_BLOCKED');
    const items = await tx.payrollItem.findMany({ where: { runId }, select: { staffId: true, warnings: true } });
    if (!items.length) throw httpError('本批次沒有任何薪資單', 409, 'PAYROLL_EMPTY');
    const codes = (code) => items.filter((i) => (i.warnings || []).some((w) => w.code === code)).length;
    if (codes('OT_PENDING')) throw httpError(`${codes('OT_PENDING')} 位員工有加班建議尚未核定`, 409, 'PAYROLL_UNREVIEWED');
    if (codes('ATTENDANCE_REVIEW')) {
      throw httpError(`${codes('ATTENDANCE_REVIEW')} 位員工有未打下班卡／上班中紀錄，請先更正考勤`, 409, 'PAYROLL_ATTENDANCE_REVIEW');
    }
    const { count } = await tx.payrollRun.updateMany({
      where: { id: runId, status: 'DRAFT' },
      data: {
        status: 'FINALIZED',
        finalizedAt,
        finalizedByStaffId: actorStaffId,
        history: [...(run.history || []), { action: 'FINALIZE', at: finalizedAt.toISOString(), byStaffId: actorStaffId }],
      },
    });
    if (!count) throw httpError('薪資批次狀態已變更，請重新整理', 409, 'PAYROLL_FINALIZED');
    return items.map((i) => i.staffId);
  });
  void notifyPayslipReady({ runId, month: head.month, finalizedAt, staffIds });
  return getPayrollRun(runId);
}

export async function reopenPayrollRun(runId, reason, actorStaffId) {
  const why = text(reason, '撤銷原因', 200);
  if (!why) throw httpError('撤銷結算須填寫原因');
  const at = new Date();
  const { month, staffIds } = await prisma.$transaction(async (tx) => {
    const locked = await lockPayrollRun(tx, runId);
    if (!locked) throw httpError('查無此薪資批次', 404);
    if (locked.status !== 'FINALIZED') throw httpError('薪資批次尚未結算', 409, 'PAYROLL_NOT_FINALIZED');
    const run = await tx.payrollRun.findUnique({ where: { id: runId }, include: { items: { select: { staffId: true } } } });
    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        status: 'DRAFT',
        finalizedAt: null,
        finalizedByStaffId: null,
        history: [...(run.history || []), { action: 'REOPEN', at: at.toISOString(), byStaffId: actorStaffId, reason: why }],
      },
    });
    return { month: run.month, staffIds: run.items.map((i) => i.staffId) };
  });
  void notifyPayslipReopened({ runId, month, at, staffIds });
  return getPayrollRun(runId);
}

export async function deletePayrollRun(runId) {
  const { count } = await prisma.payrollRun.deleteMany({ where: { id: runId, status: 'DRAFT' } });
  if (!count) throw httpError('僅可刪除未結算之薪資批次', 409, 'PAYROLL_FINALIZED');
  return { id: runId };
}

// ── 員工本人薪資單 ────────────────────────────────

export async function listMyPayslips(staffId) {
  const items = await prisma.payrollItem.findMany({
    where: { staffId, run: { status: 'FINALIZED' } },
    select: { grossPay: true, deductionTotal: true, netPay: true, run: { select: { month: true, finalizedAt: true } } },
    orderBy: { run: { month: 'desc' } },
    take: 24,
  });
  return {
    items: items.map((i) => ({
      month: i.run.month,
      finalizedAt: i.run.finalizedAt,
      grossPay: i.grossPay,
      deductionTotal: i.deductionTotal,
      netPay: i.netPay,
    })),
  };
}

export async function getMyPayslip(staffId, month) {
  monthRange(month);
  const item = await prisma.payrollItem.findFirst({
    where: { staffId, run: { month, status: 'FINALIZED' } },
    include: { run: { select: { month: true, finalizedAt: true } } },
  });
  if (!item) throw httpError('查無此月份薪資單', 404);
  const f = item.facts || {};
  return {
    month: item.run.month,
    finalizedAt: item.run.finalizedAt,
    payType: item.profile?.payType,
    payTypeLabel: PAY_TYPES[item.profile?.payType] ?? '',
    lines: item.lines,
    grossPay: item.grossPay,
    deductionTotal: item.deductionTotal,
    netPay: item.netPay,
    attendance: {
      employedDays: f.employedDays,
      daysInMonth: f.daysInMonth,
      workedMinutes: f.workedMinutes,
      scheduledShifts: f.scheduledShifts,
      lateCount: f.lateCount,
      lateMinutes: f.lateMinutes,
      earlyCount: f.earlyCount,
      earlyMinutes: f.earlyMinutes,
      absentShifts: f.absentShifts,
      absentMinutes: f.absentMinutes,
      leaveHours: Object.fromEntries(
        Object.entries(f.leaveHours || {})
          .filter(([, h]) => h > 0)
          .map(([k, h]) => [LEAVE_TYPES[k] ?? k, h]),
      ),
    },
    overtime: (item.overtime || [])
      .filter((o) => o.approvedMinutes > 0)
      .map((o) => ({ date: o.date, kind: o.kind, kindLabel: OVERTIME_KINDS[o.kind] ?? o.kind, approvedMinutes: o.approvedMinutes })),
  };
}
