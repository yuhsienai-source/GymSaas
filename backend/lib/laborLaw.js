// lib/laborLaw.js — 台灣勞動基準法：工作型態、年資、特別休假（§38）、國定假日（§37）
// 純函式；日期一律以 Asia/Taipei 之 'YYYY-MM-DD' 字串比較

export const EMPLOYMENT_TYPES = {
  FULL_TIME: { label: '正職' },
  PART_TIME: { label: '兼職（部分工時）' },
  INTERN: { label: '實習' },
};
export const EMPLOYMENT_TYPE_KEYS = Object.keys(EMPLOYMENT_TYPES);

/** §30 每週正常工時上限；部分工時比例以此為分母 */
export const FULL_TIME_WEEKLY_HOURS = 40;
export const DAILY_HOURS = 8;

/** 請假假別（勞基法、勞工請假規則、性別平等工作法）；僅 ANNUAL／NATIONAL_HOLIDAY 扣抵額度 */
export const LEAVE_TYPES = {
  ANNUAL: '特別休假',
  NATIONAL_HOLIDAY: '國定假日排休',
  PERSONAL: '事假',
  SICK: '普通傷病假',
  MENSTRUAL: '生理假',
  MARRIAGE: '婚假',
  FUNERAL: '喪假',
  OCCUPATIONAL: '公傷病假',
  OFFICIAL: '公假',
  MATERNITY: '產假',
  PATERNITY: '陪產檢及陪產假',
  FAMILY_CARE: '家庭照顧假',
  COMPENSATORY: '補休',
  OTHER: '其他',
};
export const LEAVE_TYPE_KEYS = Object.keys(LEAVE_TYPES);
export const QUOTA_LEAVE_TYPES = ['ANNUAL', 'NATIONAL_HOLIDAY'];

/**
 * 勞工國定假日預設曆（紀念日及節日實施條例＋勞基法施行細則 §23-1，勞動節）；
 * 農曆節日每年不同，HQ 可於 /api/hq/hr/holidays 增修
 */
export const DEFAULT_PUBLIC_HOLIDAYS = [
  ['2026-01-01', '開國紀念日'],
  ['2026-02-15', '除夕前一日'],
  ['2026-02-16', '農曆除夕'],
  ['2026-02-17', '春節（初一）'],
  ['2026-02-18', '春節（初二）'],
  ['2026-02-19', '春節（初三）'],
  ['2026-02-28', '和平紀念日'],
  ['2026-04-04', '兒童節'],
  ['2026-04-05', '民族掃墓節'],
  ['2026-05-01', '勞動節'],
  ['2026-06-19', '端午節'],
  ['2026-09-25', '中秋節'],
  ['2026-09-28', '孔子誕辰紀念日'],
  ['2026-10-10', '國慶日'],
  ['2026-10-25', '臺灣光復暨金門古寧頭大捷紀念日'],
  ['2026-12-25', '行憲紀念日'],
];

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 任意時間點 → 台北日期 'YYYY-MM-DD' */
export function taipeiDateKey(value = new Date()) {
  return taipeiFormatter.format(value instanceof Date ? value : new Date(value));
}

/** Prisma @db.Date（UTC 午夜）→ 'YYYY-MM-DD' */
export function dbDateKey(value) {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

export function isDateKey(value) {
  if (!DATE_KEY_RE.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 加月（月底夾擠：8/31 + 6 個月 → 2/28） */
export function addMonthsKey(key, months) {
  const { y, m, d } = parts(key);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export function addDaysKey(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function diffDaysKey(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / 86400000);
}

/** 已滿之月數 */
function completedMonths(fromKey, toKey) {
  if (toKey < fromKey) return 0;
  const a = parts(fromKey);
  const b = parts(toKey);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (addMonthsKey(fromKey, months) > toKey) months -= 1;
  return Math.max(0, months);
}

/** 年資（到職日起至 today，含未滿月之日數） */
export function seniorityOf(hireKey, todayKey) {
  if (!hireKey || todayKey < hireKey) return { years: 0, months: 0, days: 0, totalMonths: 0, started: false };
  const totalMonths = completedMonths(hireKey, todayKey);
  const anchor = addMonthsKey(hireKey, totalMonths);
  const days = Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86400000);
  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12, days, totalMonths, started: true };
}

/** §38：滿 n 年（n≥1）之該年度特休日數 */
export function annualLeaveDaysForYears(n) {
  if (n < 1) return 0;
  if (n === 1) return 7;
  if (n === 2) return 10;
  if (n < 5) return 14;
  if (n < 10) return 15;
  return Math.min(30, n + 6);
}

/**
 * 週年制特休年度：滿 6 個月 3 日（至滿 1 年止）；之後每滿週年起算一年度
 * @returns {{ eligible: boolean, periodStart: string|null, periodEnd: string|null, days: number, nextGrantDate: string, nextGrantDays: number }}
 */
export function annualLeavePeriod(hireKey, onKey) {
  const months = completedMonths(hireKey, onKey);
  if (onKey < hireKey || months < 6) {
    return { eligible: false, periodStart: null, periodEnd: null, days: 0, nextGrantDate: addMonthsKey(hireKey, 6), nextGrantDays: 3 };
  }
  if (months < 12) {
    return {
      eligible: true,
      periodStart: addMonthsKey(hireKey, 6),
      periodEnd: addMonthsKey(hireKey, 12),
      days: 3,
      nextGrantDate: addMonthsKey(hireKey, 12),
      nextGrantDays: annualLeaveDaysForYears(1),
    };
  }
  const n = Math.floor(months / 12);
  return {
    eligible: true,
    periodStart: addMonthsKey(hireKey, n * 12),
    periodEnd: addMonthsKey(hireKey, (n + 1) * 12),
    days: annualLeaveDaysForYears(n),
    nextGrantDate: addMonthsKey(hireKey, (n + 1) * 12),
    nextGrantDays: annualLeaveDaysForYears(n + 1),
  };
}

/**
 * 工時比例：正職 1；兼職＝約定週工時／40；實習依是否具勞雇關係
 * 無勞雇關係之實習（學校課程實習／建教生）不適用勞基法假別，回 0
 */
export function employmentRatio({ employmentType, weeklyHours, laborActApplies }) {
  if (employmentType === 'INTERN' && laborActApplies === false) return 0;
  if (employmentType === 'FULL_TIME') return 1;
  const hours = Number(weeklyHours) || (employmentType === 'INTERN' ? FULL_TIME_WEEKLY_HOURS : 0);
  return Math.min(1, Math.max(0, hours / FULL_TIME_WEEKLY_HOURS));
}

/** 部分工時特休按工時比例計給（時數，無條件進位至 0.5 小時，不低於法定） */
export function annualLeaveHours(days, ratio) {
  if (ratio >= 1) return days * DAILY_HOURS;
  return Math.ceil(days * DAILY_HOURS * ratio * 2) / 2;
}

function sumHours(rows) {
  return Math.round(rows.reduce((acc, r) => acc + (Number(r.hours) || 0), 0) * 100) / 100;
}

/**
 * 員工假勤額度
 * @param {{ employmentType: string, hireDate: Date|string|null, weeklyHours: number|null, laborActApplies: boolean }} staff
 * @param {{ todayKey: string, holidayKeys: string[], leaves: { leaveType: string, dateKey: string, hours: number }[] }} ctx
 *   leaves 僅傳該員工已核准之 ANNUAL／NATIONAL_HOLIDAY
 */
export function computeLeaveBalances(staff, { todayKey, holidayKeys, leaves }) {
  const hireKey = staff.hireDate ? (typeof staff.hireDate === 'string' ? staff.hireDate : dbDateKey(staff.hireDate)) : null;
  const ratio = employmentRatio(staff);
  const applicable = ratio > 0;
  const base = {
    employmentType: staff.employmentType,
    hireDate: hireKey,
    ratio,
    laborActApplies: applicable,
    seniority: hireKey ? seniorityOf(hireKey, todayKey) : null,
  };
  if (!hireKey || !applicable) return { ...base, annualLeave: null, nationalHoliday: null };

  const period = annualLeavePeriod(hireKey, todayKey);
  const annualUsed = period.eligible
    ? sumHours(leaves.filter((l) => l.leaveType === 'ANNUAL' && l.dateKey >= period.periodStart && l.dateKey < period.periodEnd))
    : 0;
  const annualLeave = {
    ...period,
    entitledHours: annualLeaveHours(period.days, ratio),
    usedHours: annualUsed,
    unit: ratio >= 1 ? 'DAY' : 'HOUR',
  };

  const year = todayKey.slice(0, 4);
  const fullSchedule = ratio >= 1;
  const entitledDays = fullSchedule
    ? holidayKeys.filter((k) => k.startsWith(year) && k >= hireKey).length
    : null;
  const usedDays =
    sumHours(leaves.filter((l) => l.leaveType === 'NATIONAL_HOLIDAY' && l.dateKey.startsWith(year))) / DAILY_HOURS;
  const nationalHoliday = {
    year: Number(year),
    entitledDays,
    usedDays: Math.round(usedDays * 100) / 100,
    basis: fullSchedule ? 'CALENDAR' : 'SCHEDULED_WORKDAY',
  };

  return { ...base, annualLeave, nationalHoliday };
}

/**
 * 驗證並正規化工作型態欄位
 * @returns {{ data: object, errors: string[] }}
 */
export function normalizeEmploymentInput(input, { requireHireDate = false, current = null, role = null } = {}) {
  const errors = [];
  const data = {};
  const type = String(input.employmentType ?? current?.employmentType ?? 'FULL_TIME').trim().toUpperCase();
  if (!EMPLOYMENT_TYPE_KEYS.includes(type)) errors.push('工作型態須為 FULL_TIME、PART_TIME 或 INTERN');
  data.employmentType = type;

  if (input.hireDate !== undefined) {
    if (input.hireDate === null || input.hireDate === '') {
      if (requireHireDate) errors.push('請填寫到職日');
      data.hireDate = null;
    } else if (!isDateKey(input.hireDate)) {
      errors.push('到職日格式須為 YYYY-MM-DD');
    } else if (input.hireDate < '1970-01-01') {
      errors.push('到職日無效');
    } else {
      data.hireDate = new Date(`${input.hireDate}T00:00:00Z`);
    }
  } else if (requireHireDate) {
    errors.push('請填寫到職日');
  }

  const rawHours = input.weeklyHours !== undefined ? input.weeklyHours : current?.weeklyHours;
  const hours = rawHours === null || rawHours === '' || rawHours === undefined ? null : Number(rawHours);
  if (type === 'FULL_TIME') {
    data.weeklyHours = null;
  } else if (hours === null) {
    if (type === 'PART_TIME') errors.push('兼職須填寫約定每週工時');
    data.weeklyHours = null;
  } else if (!Number.isFinite(hours) || hours <= 0) {
    errors.push('約定每週工時須大於 0');
  } else if (type === 'PART_TIME' && hours >= FULL_TIME_WEEKLY_HOURS) {
    errors.push(`部分工時之約定週工時須少於 ${FULL_TIME_WEEKLY_HOURS} 小時；達全時請改為正職`);
  } else if (hours > FULL_TIME_WEEKLY_HOURS) {
    errors.push(`約定週工時不得超過 ${FULL_TIME_WEEKLY_HOURS} 小時（勞基法 §30）`);
  } else {
    data.weeklyHours = Math.round(hours * 10) / 10;
  }

  const rawApplies = input.laborActApplies !== undefined ? input.laborActApplies : current?.laborActApplies;
  if (coachRequiresLaborAct(role) && rawApplies === false && input.laborActApplies !== undefined) {
    errors.push('教練為僱傭關係，一律適用勞基法（實習教練亦同）');
  }
  data.laborActApplies = coachRequiresLaborAct(role) ? true : type === 'INTERN' ? rawApplies !== false : true;

  return { data, errors };
}

/** 教練（含實習教練）受僱提供勞務，不得設為不適用勞基法 */
export function coachRequiresLaborAct(role) {
  return String(role || '').toUpperCase() === 'TRAINER';
}
