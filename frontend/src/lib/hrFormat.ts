// 員工 HR 顯示用格式化（台北時間）；考勤旗標、額度與狀態一律由後端計算，此處僅對應標籤
import type {
  AttendanceFlag,
  LeaveStatus,
  ScheduleSource,
  StaffDutyShift,
  StaffDutyState,
  StaffLeaveBalance,
} from '../types/api';
import { formatDays, formatLeaveQuota } from './laborLaw';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const TZ = 'Asia/Taipei';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function addDaysKey(key: string, days: number) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function weekdayLabel(dateKeyOrIndex: string | number) {
  const idx = typeof dateKeyOrIndex === 'number' ? dateKeyOrIndex : new Date(`${dateKeyOrIndex}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[idx];
}

export function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** MM/DD HH:mm */
export function shortDateTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', {
    timeZone: TZ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** ISO → 台北 { date: YYYY-MM-DD, time: HH:mm }（表單預填） */
export function taipeiParts(iso: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { date, time: hhmm(iso) };
}

/** 台北日期＋時間 → ISO；`endTime` 早於等於 `startTime` 視為跨夜 */
export function taipeiRangeIso(date: string, startTime: string, endTime?: string) {
  const startAt = new Date(`${date}T${startTime}:00+08:00`).toISOString();
  if (!endTime) return { startAt, endAt: undefined };
  const endDate = endTime <= startTime ? addDaysKey(date, 1) : date;
  return { startAt, endAt: new Date(`${endDate}T${endTime}:00+08:00`).toISOString() };
}

export function formatMinutes(min: number | null | undefined) {
  if (min === null || min === undefined) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} 分`;
  return m ? `${h} 時 ${m} 分` : `${h} 時`;
}

/** 金額顯示（後端已四捨五入至元） */
export function formatMoney(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString('zh-TW')}`;
}

export const ATTENDANCE_FLAG_META: Record<AttendanceFlag, { label: string; tone: BadgeTone }> = {
  LATE: { label: '遲到', tone: 'warning' },
  EARLY_LEAVE: { label: '早退', tone: 'warning' },
  MISSED_PUNCH_OUT: { label: '未打下班卡', tone: 'danger' },
  OPEN: { label: '上班中', tone: 'info' },
  UNSCHEDULED: { label: '未排班出勤', tone: 'neutral' },
  CORRECTED: { label: '已更正', tone: 'neutral' },
  BACKFILLED: { label: '總部補登', tone: 'neutral' },
};

export const LEAVE_STATUS_TONE: Record<LeaveStatus, BadgeTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export const SCHEDULE_SOURCE_LABELS: Record<ScheduleSource, string> = {
  ROSTER: '四週排班',
  FREE: '週班表',
  MANUAL: '總部臨時排班',
};

export function shiftRangeLabel(s: { label: string; startAt: string; endAt: string }) {
  return `${s.label} ${hhmm(s.startAt)}–${hhmm(s.endAt)}`;
}

export const DUTY_STATE_META: Record<StaffDutyState, { label: string; tone: BadgeTone }> = {
  EXEMPT: { label: '免判定', tone: 'neutral' },
  CLOCKED_IN: { label: '值勤中', tone: 'success' },
  IN_WINDOW: { label: '值勤・未打卡', tone: 'info' },
  ON_LEAVE: { label: '請假中', tone: 'warning' },
  BRANCH_SCOPE: { label: '分店不符', tone: 'danger' },
  OFF_SHIFT: { label: '非值勤', tone: 'neutral' },
};

/** MM/DD（週X）早班 07:00–15:30 · 分店 */
export function dutyShiftLabel(s: StaffDutyShift) {
  const date = taipeiParts(s.startAt).date;
  return `${date.slice(5).replace('-', '/')}（${weekdayLabel(date)}）${shiftRangeLabel(s)}${s.branchName ? ` · ${s.branchName}` : ''}`;
}

/** 特休／國休一行摘要（數值取自後端 leaveBalance） */
export function leaveBalanceSummary(balance: StaffLeaveBalance | null | undefined) {
  if (!balance) return null;
  if (!balance.laborActApplies) return '無勞雇關係，不適用特休／國休';
  const a = balance.annualLeave;
  const n = balance.nationalHoliday;
  const annual = a?.eligible
    ? `特休 ${formatLeaveQuota(a.usedHours, a.entitledHours, a.unit)}（${a.periodStart}～${a.periodEnd}）`
    : '尚未取得特休';
  const national = n ? `國休 ${formatDays(n.usedDays, n.entitledDays)}` : '不適用國休';
  return `${annual}｜${national}`;
}
