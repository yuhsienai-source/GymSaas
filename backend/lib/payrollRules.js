// lib/payrollRules.js — 薪資計算純函式（無 DB）；勞基法口徑見各常數註解
/**
 * 口徑（對外契約，改動須同步文件）：
 * - 時薪基準（請假／遲到扣薪）：月薪制＝月薪 ÷ 30 ÷ 8（勞動部解釋）；時薪制＝約定時薪。
 * - 加班費時薪基準（平日每小時工資額）：另計入固定津貼與教練業績獎金等正常工時內之經常性給與
 *   （月薪制 ÷240；時薪制按正常工時攤提）。
 * - 教練業績獎金（lib/coachPerformance.js）為工資，分列於應發；底薪以薪資設定為準，不得以獎金替代。
 * - 月薪制：本薪依在職日數（到職當月按日 ÷30）；事假／家庭照顧假全扣、病假／生理假半扣；
 *   遲到早退分鐘、曠職排定工時依時薪比例扣除（不另罰款，勞基法 §26）。
 * - 時薪制：正常工時＝已配對班次之實際工時（不含延後下班、上限為班次長度）＋未排班出勤；
 *   帶薪假依假別給付比例計入。
 * - 加班（皆須總部逐筆核定 approvedMinutes 才計）：
 *   延長工時 §24-1：前 2h ×4/3、再 2h ×5/3
 *   休息日 §24-2：前 2h ×4/3、2～8h ×5/3、逾 8h ×8/3
 *   國定假日 §39／例假 §40：8h 內加發 1 倍（時薪制 2 倍）、逾 8h 前 2h ×4/3、其後 ×5/3
 * - 勞健保／勞退：依投保薪資與可調費率計算員工自付與雇主負擔；勞保、勞退依在職日數 ÷30，健保以月底在職者整月計。
 * - 所得稅由總部以手動項 INCOME_TAX 輸入。金額逐項四捨五入至元。
 */

import { LEAVE_TYPES } from './laborLaw.js';

/** 預設費率（勞保局／健保署／勞動部公告會調整，總部須於「費率設定」核對） */
export const PAYROLL_DEFAULT_CONFIG = {
  /** 勞保普通事故保險費率 */
  laborOrdinaryRate: 0.115,
  /** 就業保險費率 */
  employmentInsuranceRate: 0.01,
  /** 勞保（含就保）員工負擔比例 */
  laborEmployeeShare: 0.2,
  /** 勞保（含就保）雇主負擔比例 */
  laborEmployerShare: 0.7,
  /** 職災保險費率（雇主全額，依行業別） */
  occupationalRate: 0.0021,
  /** 健保費率 */
  healthRate: 0.0517,
  healthEmployeeShare: 0.3,
  healthEmployerShare: 0.6,
  /** 健保平均眷口數（雇主負擔用） */
  healthAvgDependents: 0.56,
  /** 雇主勞退提繳率（勞退條例 §14，至少 6%） */
  pensionEmployerRate: 0.06,
  /** 基本工資（月／時） */
  minMonthlyWage: 29500,
  minHourlyWage: 196,
  /** 勞保投保薪資分級表最高級 */
  laborInsuredMax: 45800,
  /** 勞退月提繳工資分級表最高級 */
  pensionWageMax: 150000,
};

export const PAYROLL_CONFIG_META = {
  laborOrdinaryRate: { label: '勞保普通事故費率', min: 0, max: 0.2 },
  employmentInsuranceRate: { label: '就業保險費率', min: 0, max: 0.05 },
  laborEmployeeShare: { label: '勞保員工負擔比例', min: 0, max: 1 },
  laborEmployerShare: { label: '勞保雇主負擔比例', min: 0, max: 1 },
  occupationalRate: { label: '職災保險費率', min: 0, max: 0.05 },
  healthRate: { label: '健保費率', min: 0, max: 0.2 },
  healthEmployeeShare: { label: '健保員工負擔比例', min: 0, max: 1 },
  healthEmployerShare: { label: '健保雇主負擔比例', min: 0, max: 1 },
  healthAvgDependents: { label: '健保平均眷口數', min: 0, max: 3 },
  pensionEmployerRate: { label: '雇主勞退提繳率', min: 0.06, max: 0.2 },
  minMonthlyWage: { label: '基本工資（月）', min: 0, max: 200000 },
  minHourlyWage: { label: '基本工資（時）', min: 0, max: 2000 },
  laborInsuredMax: { label: '勞保投保薪資上限', min: 0, max: 500000 },
  pensionWageMax: { label: '勞退提繳工資上限', min: 0, max: 1000000 },
};

export const PAY_TYPES = { MONTHLY: '月薪', HOURLY: '時薪' };

/** 假別給付比例（1＝照給、0.5＝半薪、0＝不給）；產假到職未滿 6 個月者半薪（勞基法 §50） */
export const LEAVE_PAY_RATIO = {
  ANNUAL: 1,
  NATIONAL_HOLIDAY: 1,
  PERSONAL: 0,
  SICK: 0.5,
  MENSTRUAL: 0.5,
  MARRIAGE: 1,
  FUNERAL: 1,
  OCCUPATIONAL: 1,
  OFFICIAL: 1,
  MATERNITY: 1,
  PATERNITY: 1,
  FAMILY_CARE: 0,
  COMPENSATORY: 1,
  OTHER: 1,
};

export const OVERTIME_KINDS = {
  WEEKDAY: '延長工時',
  REST_DAY: '休息日出勤',
  HOLIDAY: '國定假日出勤',
  REGULAR_OFF: '例假出勤',
};

/** 手動項：EARNING 加項／DEDUCTION 減項 */
export const ADJUSTMENT_TYPES = {
  BONUS: { label: '獎金', kind: 'EARNING' },
  ALLOWANCE: { label: '津貼', kind: 'EARNING' },
  OTHER_EARNING: { label: '其他加項', kind: 'EARNING' },
  INCOME_TAX: { label: '所得稅扣繳', kind: 'DEDUCTION' },
  OTHER_DEDUCTION: { label: '其他扣款', kind: 'DEDUCTION' },
};

const r0 = (n) => Math.round(Number(n) || 0);

export function mergePayrollConfig(stored) {
  const out = { ...PAYROLL_DEFAULT_CONFIG };
  for (const key of Object.keys(PAYROLL_DEFAULT_CONFIG)) {
    const v = Number(stored?.[key]);
    if (stored && stored[key] !== undefined && stored[key] !== null && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** 時薪基準（元／小時，保留小數） */
export function hourlyBase(profile) {
  if (profile.payType === 'HOURLY') return Number(profile.hourlyWage) || 0;
  return (Number(profile.monthlySalary) || 0) / 30 / 8;
}

export function fixedAllowanceTotal(profile) {
  return (Array.isArray(profile.allowances) ? profile.allowances : []).reduce((n, a) => n + (Number(a.amount) || 0), 0);
}

/** 加班費時薪基準：本薪／時薪＋固定津貼＋業績獎金（正常工時內之經常性給與） */
export function overtimeHourlyBase(profile, { regularMinutes = 0, performanceTotal = 0 } = {}) {
  const extra = fixedAllowanceTotal(profile) + (Number(performanceTotal) || 0);
  if (profile.payType === 'HOURLY') {
    const hours = regularMinutes / 60;
    return hourlyBase(profile) + (hours > 0 ? extra / hours : 0);
  }
  return ((Number(profile.monthlySalary) || 0) + extra) / 30 / 8;
}

function tiers(kind, payType) {
  const holidayBase = payType === 'HOURLY' ? 2 : 1;
  switch (kind) {
    case 'WEEKDAY':
      return [
        [120, 4 / 3],
        [Infinity, 5 / 3],
      ];
    case 'REST_DAY':
      return [
        [120, 4 / 3],
        [360, 5 / 3],
        [Infinity, 8 / 3],
      ];
    case 'HOLIDAY':
    case 'REGULAR_OFF':
      return [
        [480, holidayBase],
        [120, 4 / 3],
        [Infinity, 5 / 3],
      ];
    default:
      return [];
  }
}

/** 單筆加班費：依分段倍率 */
export function overtimePay(kind, minutes, hourly, payType) {
  let left = Math.max(0, Number(minutes) || 0);
  let amount = 0;
  const breakdown = [];
  for (const [size, multiplier] of tiers(kind, payType)) {
    if (left <= 0) break;
    const m = Math.min(left, size);
    amount += (m / 60) * hourly * multiplier;
    breakdown.push({ minutes: m, multiplier: Math.round(multiplier * 100) / 100 });
    left -= m;
  }
  return { amount, breakdown };
}

/**
 * 勞健保／勞退
 * @param {object} profile
 * @param {object} cfg
 * @param {{ insuredDays: number, healthCharged: boolean, laborActApplies: boolean }} ctx
 */
export function insuranceAmounts(profile, cfg, { insuredDays, healthCharged, laborActApplies }) {
  const dayRatio = Math.min(30, Math.max(0, insuredDays)) / 30;
  const out = { employee: [], employer: [] };
  const labor = Number(profile.laborInsuredSalary) || 0;
  if (labor > 0 && laborActApplies) {
    const rate = cfg.laborOrdinaryRate + cfg.employmentInsuranceRate;
    out.employee.push({ code: 'LABOR_INS', label: '勞保費（含就保）', amount: r0(labor * rate * cfg.laborEmployeeShare * dayRatio) });
    out.employer.push({
      code: 'LABOR_INS_ER',
      label: '勞保費（含就保、職災）雇主負擔',
      amount: r0(labor * (rate * cfg.laborEmployerShare + cfg.occupationalRate) * dayRatio),
    });
  }
  const health = Number(profile.healthInsuredSalary) || 0;
  if (health > 0 && healthCharged) {
    const heads = 1 + Math.min(3, Math.max(0, Number(profile.healthDependents) || 0));
    out.employee.push({ code: 'HEALTH_INS', label: `健保費（${heads} 口）`, amount: r0(health * cfg.healthRate * cfg.healthEmployeeShare * heads) });
    out.employer.push({
      code: 'HEALTH_INS_ER',
      label: '健保費雇主負擔',
      amount: r0(health * cfg.healthRate * cfg.healthEmployerShare * (1 + cfg.healthAvgDependents)),
    });
  }
  const pension = Number(profile.pensionWage) || 0;
  if (pension > 0 && laborActApplies) {
    out.employer.push({ code: 'PENSION_ER', label: `勞退提繳（${Math.round(cfg.pensionEmployerRate * 100)}%）`, amount: r0(pension * cfg.pensionEmployerRate * dayRatio) });
    const self = Math.min(0.06, Math.max(0, Number(profile.pensionSelfRate) || 0));
    if (self > 0) {
      out.employee.push({ code: 'PENSION_SELF', label: `勞退自提（${Math.round(self * 1000) / 10}%）`, amount: r0(pension * self * dayRatio) });
    }
  }
  return out;
}

function leaveRatio(type, tenureMonths) {
  if (type === 'MATERNITY' && tenureMonths < 6) return 0.5;
  return LEAVE_PAY_RATIO[type] ?? 1;
}

/**
 * 計算個人薪資單
 * @param {{
 *   profile: object, cfg: object,
 *   facts: { employedDays: number, daysInMonth: number, insuredDays: number, healthCharged: boolean,
 *     laborActApplies: boolean, tenureMonths: number, regularMinutes: number, lateMinutes: number,
 *     earlyMinutes: number, absentMinutes: number, leaveHours: Record<string, number> },
 *   overtime: { kind: string, approvedMinutes: number|null }[],
 *   adjustments: { type: string, label?: string, amount: number }[],
 *   performance: { total: number, lines: { code: string, label: string, amount: number }[] } | null,
 * }} input
 */
export function computePayslip({ profile, cfg, facts, overtime, adjustments, performance }) {
  const lines = [];
  const add = (kind, code, label, amount, detail) => {
    const value = r0(amount);
    if (value !== 0) lines.push({ kind, code, label, amount: value, ...(detail ? { detail } : {}) });
  };
  const hourly = hourlyBase(profile);
  const otHourly = overtimeHourlyBase(profile, { regularMinutes: facts.regularMinutes, performanceTotal: performance?.total });
  const monthly = profile.payType !== 'HOURLY';
  const leaveTypes = Object.keys(LEAVE_PAY_RATIO);

  if (monthly) {
    const salary = Number(profile.monthlySalary) || 0;
    const full = facts.employedDays >= facts.daysInMonth;
    const base = full ? salary : Math.min(salary, (salary / 30) * facts.employedDays);
    add('EARNING', 'BASE', full ? '本薪' : `本薪（在職 ${facts.employedDays} 日）`, base);
  } else {
    const h = facts.regularMinutes / 60;
    add('EARNING', 'BASE', `工時薪資（${Math.round(h * 100) / 100}h × ${hourly}）`, h * hourly);
    for (const t of leaveTypes) {
      const hours = facts.leaveHours[t] || 0;
      const ratio = leaveRatio(t, facts.tenureMonths);
      if (hours > 0 && ratio > 0) add('EARNING', `LEAVE_PAID_${t}`, `${LEAVE_TYPES[t] ?? t} ${hours}h${ratio < 1 ? '（半薪）' : ''}`, hours * hourly * ratio);
    }
  }

  for (const a of Array.isArray(profile.allowances) ? profile.allowances : []) {
    add('EARNING', 'ALLOWANCE_FIXED', a.label || '固定津貼', a.amount);
  }

  const otByKind = {};
  for (const o of overtime) {
    if (!(o.approvedMinutes > 0)) continue;
    const { amount } = overtimePay(o.kind, o.approvedMinutes, otHourly, profile.payType);
    otByKind[o.kind] = otByKind[o.kind] || { minutes: 0, amount: 0 };
    otByKind[o.kind].minutes += o.approvedMinutes;
    otByKind[o.kind].amount += amount;
  }
  for (const [kind, v] of Object.entries(otByKind)) {
    add('EARNING', `OT_${kind}`, `${OVERTIME_KINDS[kind]}加班費（${Math.round((v.minutes / 60) * 100) / 100}h）`, v.amount);
  }

  for (const l of performance?.lines ?? []) add('EARNING', l.code, l.label, l.amount);

  if (monthly) {
    for (const t of leaveTypes) {
      const hours = facts.leaveHours[t] || 0;
      const ratio = leaveRatio(t, facts.tenureMonths);
      if (hours > 0 && ratio < 1) {
        add('DEDUCTION', `LEAVE_UNPAID_${t}`, `${LEAVE_TYPES[t] ?? t}扣薪 ${hours}h${ratio > 0 ? '（半薪）' : ''}`, hours * hourly * (1 - ratio));
      }
    }
    const tardy = facts.lateMinutes + facts.earlyMinutes;
    if (tardy > 0) add('DEDUCTION', 'TARDY', `遲到早退（${tardy} 分）`, (tardy / 60) * hourly);
    if (facts.absentMinutes > 0) {
      add('DEDUCTION', 'ABSENT', `曠職（${Math.round((facts.absentMinutes / 60) * 100) / 100}h）`, (facts.absentMinutes / 60) * hourly);
    }
  }

  const ins = insuranceAmounts(profile, cfg, facts);
  for (const l of ins.employee) add('DEDUCTION', l.code, l.label, l.amount);
  for (const l of ins.employer) add('EMPLOYER', l.code, l.label, l.amount);

  for (const adj of adjustments) {
    const meta = ADJUSTMENT_TYPES[adj.type];
    if (!meta) continue;
    add(meta.kind, `ADJ_${adj.type}`, adj.label || meta.label, adj.amount);
  }

  const sum = (kind) => lines.filter((l) => l.kind === kind).reduce((n, l) => n + l.amount, 0);
  const grossPay = sum('EARNING');
  const deductionTotal = sum('DEDUCTION');
  const employer = sum('EMPLOYER');
  return {
    lines,
    hourlyBase: Math.round(hourly * 100) / 100,
    overtimeHourlyBase: Math.round(otHourly * 100) / 100,
    grossPay,
    deductionTotal,
    netPay: grossPay - deductionTotal,
    employerCost: grossPay + employer,
  };
}
