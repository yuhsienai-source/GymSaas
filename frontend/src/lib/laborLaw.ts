// 勞動條件顯示用鏡像（計算與驗證唯一真相在 backend/lib/laborLaw.js）

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'INTERN';

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: '正職',
  PART_TIME: '兼職（部分工時）',
  INTERN: '實習',
};

export const EMPLOYMENT_TYPE_SHORT: Record<EmploymentType, string> = {
  FULL_TIME: '正職',
  PART_TIME: '兼職',
  INTERN: '實習',
};

export const ALL_EMPLOYMENT_TYPES = Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[];

export const FULL_TIME_WEEKLY_HOURS = 40;
export const DAILY_HOURS = 8;

export type LeaveType =
  | 'ANNUAL'
  | 'NATIONAL_HOLIDAY'
  | 'PERSONAL'
  | 'SICK'
  | 'MENSTRUAL'
  | 'MARRIAGE'
  | 'FUNERAL'
  | 'OCCUPATIONAL'
  | 'OFFICIAL'
  | 'MATERNITY'
  | 'PATERNITY'
  | 'FAMILY_CARE'
  | 'COMPENSATORY'
  | 'OTHER';

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
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

export const ALL_LEAVE_TYPES = Object.keys(LEAVE_TYPE_LABELS) as LeaveType[];

/** 台北今日 YYYY-MM-DD */
export function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function employmentTypeOf(raw: string | null | undefined): EmploymentType {
  return raw && raw in EMPLOYMENT_TYPE_LABELS ? (raw as EmploymentType) : 'FULL_TIME';
}

export function formatSeniority(s: { years: number; months: number; started: boolean } | null | undefined) {
  if (!s) return '—';
  if (!s.started) return '尚未到職';
  if (s.years === 0 && s.months === 0) return '未滿 1 個月';
  return [s.years ? `${s.years} 年` : '', s.months ? `${s.months} 個月` : ''].filter(Boolean).join(' ');
}

function trimNumber(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/** 特休：正職以日顯示（8 小時＝1 日），部分工時以小時顯示 */
export function formatLeaveQuota(used: number, total: number, unit: 'DAY' | 'HOUR') {
  if (unit === 'HOUR') return `${trimNumber(used)}／${trimNumber(total)} 時`;
  return `${trimNumber(used / DAILY_HOURS)}／${trimNumber(total / DAILY_HOURS)} 日`;
}

export function formatDays(used: number, total: number | null) {
  return total === null ? `${trimNumber(used)} 日／依排班` : `${trimNumber(used)}／${trimNumber(total)} 日`;
}
