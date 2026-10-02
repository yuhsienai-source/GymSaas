// lib/coachSchedule.js — 週班表（轉正教練＋管理職：店長／GM／FM）：勞基法一般工時（§30、§32、§34、§35、§36）檢查（純函式）
/**
 * - 適用對象見 weekPlanRoleOf；場務與實習教練走四週排班、ADMIN 免排班
 * - 每週（週一～週日）須指定例假＋休息日各 1 日，當日不得排出勤（§36）
 * - 每日正常工時 ≤ 8 小時、每週 ≤ 40 小時（§30）；班表僅排正常工時，延長工時一律走薪資加班核定
 * - 連續工作 4 小時應有 30 分鐘休息（§35）：間隔 < 30 分鐘之時段視為連續，超過 4 小時自動扣 30 分鐘休息
 * - 前後工作日間隔 ≥ 11 小時（§34）；連續出勤 ≤ 6 日（非經指定行業不得調移例假）
 * - 與已核准請假重疊、已排課程未落在班表內 → 禁止
 */
import { FULL_TIME_WEEKLY_HOURS, addDaysKey, diffDaysKey, isDateKey } from './laborLaw.js';
import { canonicalRole } from './orgStructure.js';

/** 週班表對象：COACH 轉正教練、MANAGER 店長／店務部主管 GM／教練部主管 FM */
export const WEEK_PLAN_ROLES = {
  COACH: { label: '教練', approverLabel: '所屬店長或教練部主管（FM）' },
  MANAGER: { label: '管理職', approverLabel: '總公司（ADMIN）' },
};
export const MANAGER_PLAN_POSITIONS = ['STORE_MANAGER', 'GM', 'FM'];

/** @returns {'COACH'|'MANAGER'|null} */
export function weekPlanRoleOf(staff) {
  const role = canonicalRole(staff?.role);
  if (role === 'TRAINER') return staff?.employmentType === 'INTERN' ? null : 'COACH';
  if (MANAGER_PLAN_POSITIONS.includes(role)) return 'MANAGER';
  return null;
}

export const COACH_WEEK_RULES = {
  maxDailyNormalMinutes: 480,
  maxWeeklyNormalMinutes: FULL_TIME_WEEKLY_HOURS * 60,
  continuousLimitMinutes: 240,
  breakMinutes: 30,
  minRestBetweenDaysHours: 11,
  maxConsecutiveWorkDays: 6,
  minSlotMinutes: 30,
  maxSlotsPerDay: 4,
  /** 可提報之週數（含本週） */
  planAheadWeeks: 8,
};

export const COACH_PLAN_STATUSES = {
  DRAFT: '草稿',
  SUBMITTED: '待審核',
  APPROVED: '已核准',
  REJECTED: '已退回',
};

export const COACH_DAY_KINDS = {
  WORK: '出勤',
  REGULAR_OFF: '例假',
  REST_DAY: '休息日',
  NONE: '未排班',
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/** 0＝週日 … 6＝週六 */
export function weekdayOf(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

/** 所在週之週一 */
export function weekStartOf(key) {
  return addDaysKey(key, -((weekdayOf(key) + 6) % 7));
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDaysKey(weekStart, i));
}

export function assertWeekStart(key) {
  if (!isDateKey(key)) throw httpError('週次格式須為 YYYY-MM-DD');
  if (weekdayOf(key) !== 1) throw httpError('週次須以週一為起日');
  return key;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function slotRange(date, start, end) {
  const dayStart = new Date(`${date}T00:00:00+08:00`).getTime();
  return { startAt: new Date(dayStart + toMinutes(start) * 60000), endAt: new Date(dayStart + toMinutes(end) * 60000) };
}

/** 資料列 → { date, start, end }（台北時間；結束於午夜顯示 24:00） */
export function slotFromRange(startAt, endAt) {
  const shift = 8 * 3600000;
  const s = new Date(new Date(startAt).getTime() + shift);
  const date = s.toISOString().slice(0, 10);
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const startMin = Math.round((s.getTime() - dayStart) / 60000);
  const endMin = Math.round((new Date(endAt).getTime() + shift - dayStart) / 60000);
  return { date, start: fromMinutes(startMin), end: fromMinutes(Math.min(endMin, 1440)) };
}

/**
 * 驗證並正規化提報內容（格式層）；法定檢查見 evaluateCoachWeek
 * @returns {{ regularOffDate: string|null, restDayDate: string|null, slots: { date, start, end, branchId: number|null }[] }}
 */
export function normalizeCoachWeekInput(weekStart, body) {
  const days = new Set(weekDays(weekStart));
  const offKey = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return null;
    if (!isDateKey(raw) || !days.has(raw)) throw httpError(`${label}須為本週日期`);
    return raw;
  };
  const regularOffDate = offKey(body?.regularOffDate, '例假');
  const restDayDate = offKey(body?.restDayDate, '休息日');
  if (!Array.isArray(body?.slots ?? [])) throw httpError('slots 須為陣列');
  const raw = body?.slots ?? [];
  if (raw.length > 7 * COACH_WEEK_RULES.maxSlotsPerDay) throw httpError('出勤時段過多');
  const slots = raw.map((s, i) => {
    const label = `時段 #${i + 1}`;
    if (!isDateKey(s?.date) || !days.has(s.date)) throw httpError(`${label} 日期須在本週內`);
    if (!TIME_RE.test(String(s?.start)) || !TIME_RE.test(String(s?.end))) throw httpError(`${label} 時間格式須為 HH:mm`);
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    if (start % 5 || end % 5) throw httpError(`${label} 時間須為 5 分鐘刻度`);
    if (end <= start) throw httpError(`${label} 結束須晚於開始（跨午夜請拆成兩段）`);
    if (end - start < COACH_WEEK_RULES.minSlotMinutes) throw httpError(`${label} 至少 ${COACH_WEEK_RULES.minSlotMinutes} 分鐘`);
    const branchId = s?.branchId === undefined || s?.branchId === null || s?.branchId === '' ? null : Number(s.branchId);
    if (branchId !== null && (!Number.isInteger(branchId) || branchId <= 0)) throw httpError(`${label} 分店無效`);
    return { date: s.date, start: fromMinutes(start), end: fromMinutes(end), branchId };
  });
  slots.sort((a, b) => (a.date === b.date ? toMinutes(a.start) - toMinutes(b.start) : a.date < b.date ? -1 : 1));
  const perDay = new Map();
  for (const s of slots) perDay.set(s.date, (perDay.get(s.date) ?? 0) + 1);
  for (const [date, n] of perDay) {
    if (n > COACH_WEEK_RULES.maxSlotsPerDay) throw httpError(`${date} 最多 ${COACH_WEEK_RULES.maxSlotsPerDay} 段`);
  }
  return { regularOffDate, restDayDate, slots };
}

function issue(level, code, message, date) {
  return date ? { level, code, message, date } : { level, code, message };
}

/** 當日出勤：合併間隔 < 30 分之時段為連續區塊，逾 4 小時扣 30 分休息 */
function dayWork(daySlots) {
  const blocks = [];
  for (const s of daySlots) {
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    const last = blocks[blocks.length - 1];
    if (last && start - last.end < COACH_WEEK_RULES.breakMinutes) last.end = Math.max(last.end, end);
    else blocks.push({ start, end });
  }
  let spanMinutes = 0;
  let breakMinutes = 0;
  for (const b of blocks) {
    const len = b.end - b.start;
    spanMinutes += len;
    if (len > COACH_WEEK_RULES.continuousLimitMinutes) breakMinutes += COACH_WEEK_RULES.breakMinutes;
  }
  return { spanMinutes, breakMinutes, workMinutes: spanMinutes - breakMinutes };
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, (Math.min(aEnd, bEnd) - Math.max(aStart, bStart)) / 60000);
}

function covered(ranges, startAt, endAt) {
  let cursor = startAt.getTime();
  for (const r of [...ranges].sort((a, b) => a.startAt - b.startAt)) {
    if (r.startAt.getTime() > cursor) break;
    cursor = Math.max(cursor, r.endAt.getTime());
    if (cursor >= endAt.getTime()) return true;
  }
  return cursor >= endAt.getTime();
}

/** 約定週工時（分鐘）：正職 40h；兼職／實習依約定 */
export function agreedWeeklyMinutes(staff) {
  if (staff.employmentType === 'FULL_TIME') return COACH_WEEK_RULES.maxWeeklyNormalMinutes;
  const h = Number(staff.weeklyHours);
  return Math.min(COACH_WEEK_RULES.maxWeeklyNormalMinutes, (Number.isFinite(h) && h > 0 ? h : FULL_TIME_WEEKLY_HOURS) * 60);
}

/**
 * 單週合規檢查
 * @param {{
 *   staff: { employmentType: string, weeklyHours: number|null, laborActApplies: boolean },
 *   weekStart: string, regularOffDate: string|null, restDayDate: string|null,
 *   slots: { date: string, start: string, end: string }[],
 *   holidayNames: Map<string,string>,
 *   leaves: { startAt: Date, endAt: Date }[],
 *   classes: { id: number, title: string, startAt: Date, endAt: Date }[],
 *   neighborWorkDates: Set<string>, prevDayLastEnd: Date|null, nextDayFirstStart: Date|null,
 * }} input
 */
export function evaluateCoachWeek(input) {
  const { staff, weekStart, regularOffDate, restDayDate, slots, holidayNames, leaves, classes } = input;
  const hard = staff.laborActApplies === false ? 'WARNING' : 'ERROR';
  const issues = [];
  const keys = weekDays(weekStart);
  const byDay = new Map(keys.map((k) => [k, []]));
  for (const s of slots) byDay.get(s.date)?.push(s);

  if (!regularOffDate) issues.push(issue(hard, 'REGULAR_OFF_REQUIRED', '每 7 日須指定 1 日例假（§36）'));
  if (!restDayDate) issues.push(issue(hard, 'REST_DAY_REQUIRED', '每 7 日須指定 1 日休息日（§36）'));
  if (regularOffDate && regularOffDate === restDayDate) issues.push(issue(hard, 'OFF_DAY_DUPLICATE', '例假與休息日須為不同日'));

  const ranges = slots.map((s) => ({ ...slotRange(s.date, s.start, s.end), date: s.date }));
  const days = [];
  let weekWorkMinutes = 0;
  let leaveMinutes = 0;
  let holidayOffDays = 0;

  for (const date of keys) {
    const daySlots = byDay.get(date);
    const kind = date === regularOffDate ? 'REGULAR_OFF' : date === restDayDate ? 'REST_DAY' : daySlots.length ? 'WORK' : 'NONE';
    const holiday = holidayNames.get(date) ?? null;
    const work = dayWork(daySlots);
    const dayStart = new Date(`${date}T00:00:00+08:00`).getTime();
    const dayLeave = Math.min(
      COACH_WEEK_RULES.maxDailyNormalMinutes,
      leaves.reduce((n, l) => n + overlapMinutes(l.startAt.getTime(), l.endAt.getTime(), dayStart, dayStart + 86400000), 0),
    );

    if (daySlots.length && (kind === 'REGULAR_OFF' || kind === 'REST_DAY')) {
      issues.push(issue(hard, 'WORK_ON_OFF_DAY', `${COACH_DAY_KINDS[kind]}不得排出勤（加班請走薪資加班核定）`, date));
    }
    for (let i = 1; i < daySlots.length; i += 1) {
      if (toMinutes(daySlots[i].start) < toMinutes(daySlots[i - 1].end)) {
        issues.push(issue(hard, 'SLOT_OVERLAP', '同日時段重疊', date));
        break;
      }
    }
    if (work.workMinutes > COACH_WEEK_RULES.maxDailyNormalMinutes) {
      issues.push(issue(hard, 'DAILY_OVER', `單日正常工時 ${(work.workMinutes / 60).toFixed(1)}h 超過 8 小時（§30）`, date));
    }
    if (holiday && daySlots.length) {
      issues.push(issue('WARNING', 'HOLIDAY_WORK', `國定假日（${holiday}）出勤須經本人同意，工資加倍發給（§39），由薪資加班核定`, date));
    }
    if (holiday && !daySlots.length && kind !== 'REGULAR_OFF' && kind !== 'REST_DAY') holidayOffDays += 1;
    for (const l of leaves) {
      if (daySlots.some((s) => {
        const r = slotRange(date, s.start, s.end);
        return overlapMinutes(r.startAt.getTime(), r.endAt.getTime(), l.startAt.getTime(), l.endAt.getTime()) > 0;
      })) {
        issues.push(issue(hard, 'LEAVE_OVERLAP', '出勤時段與已核准請假重疊', date));
        break;
      }
    }

    weekWorkMinutes += work.workMinutes;
    leaveMinutes += dayLeave;
    days.push({
      date,
      weekday: weekdayOf(date),
      kind,
      kindLabel: COACH_DAY_KINDS[kind],
      holiday,
      slots: daySlots.map((s) => ({ start: s.start, end: s.end })),
      workMinutes: work.workMinutes,
      breakMinutes: work.breakMinutes,
      leaveMinutes: Math.round(dayLeave),
    });
  }

  if (weekWorkMinutes > COACH_WEEK_RULES.maxWeeklyNormalMinutes) {
    issues.push(issue(hard, 'WEEKLY_OVER', `每週正常工時 ${(weekWorkMinutes / 60).toFixed(1)}h 超過 40 小時（§30）`));
  }
  const agreed = agreedWeeklyMinutes(staff);
  const target = Math.max(0, agreed - holidayOffDays * COACH_WEEK_RULES.maxDailyNormalMinutes * Math.min(1, agreed / COACH_WEEK_RULES.maxWeeklyNormalMinutes));
  if (staff.employmentType !== 'FULL_TIME' && weekWorkMinutes > agreed) {
    issues.push(issue('WARNING', 'OVER_AGREED', `超過約定週工時 ${agreed / 60}h，須經本人同意`));
  }
  if (weekWorkMinutes + leaveMinutes < target) {
    issues.push(issue('WARNING', 'UNDER_AGREED', `排定工時＋請假 ${((weekWorkMinutes + leaveMinutes) / 60).toFixed(1)}h 低於約定 ${(target / 60).toFixed(1)}h；未出勤時數請以請假處理`));
  }

  // §34：前後工作日間隔
  const lastEndOf = (date) => {
    if (date === addDaysKey(weekStart, -1)) return input.prevDayLastEnd;
    const r = ranges.filter((x) => x.date === date);
    return r.length ? new Date(Math.max(...r.map((x) => x.endAt.getTime()))) : null;
  };
  const firstStartOf = (date) => {
    if (date === addDaysKey(weekStart, 7)) return input.nextDayFirstStart;
    const r = ranges.filter((x) => x.date === date);
    return r.length ? new Date(Math.min(...r.map((x) => x.startAt.getTime()))) : null;
  };
  for (let i = -1; i < 7; i += 1) {
    const d1 = addDaysKey(weekStart, i);
    const d2 = addDaysKey(weekStart, i + 1);
    const end = lastEndOf(d1);
    const start = firstStartOf(d2);
    if (end && start) {
      const gap = (start - end) / 3600000;
      if (gap < COACH_WEEK_RULES.minRestBetweenDaysHours) {
        issues.push(issue(hard, 'REST_GAP', `與前一工作日間隔僅 ${gap.toFixed(1)}h，未達 11 小時（§34）`, d2));
      }
    }
  }

  // 七休一：跨前後週連續出勤
  const worked = (key) => (diffDaysKey(weekStart, key) >= 0 && diffDaysKey(weekStart, key) < 7 ? byDay.get(key).length > 0 : input.neighborWorkDates.has(key));
  let run = 0;
  let maxRun = 0;
  let runTouchesWeek = false;
  let flagged = false;
  for (let i = -6; i < 14; i += 1) {
    const key = addDaysKey(weekStart, i);
    if (worked(key)) {
      run += 1;
      if (i >= 0 && i < 7) runTouchesWeek = true;
    } else {
      run = 0;
      runTouchesWeek = false;
    }
    if (runTouchesWeek && run > COACH_WEEK_RULES.maxConsecutiveWorkDays && !flagged) {
      issues.push(issue(hard, 'CONSECUTIVE', `連續出勤 ${run} 日，超過 6 日（§36 七休一）`, key));
      flagged = true;
    }
    maxRun = Math.max(maxRun, runTouchesWeek ? run : 0);
  }

  for (const c of classes) {
    if (!covered(ranges, c.startAt, c.endAt)) {
      const { date, start, end } = slotFromRange(c.startAt, c.endAt);
      issues.push(issue(hard, 'CLASS_UNCOVERED', `已排課程「${c.title}」${start}–${end} 不在出勤時段內`, date));
    }
  }

  return {
    issues,
    hasError: issues.some((i) => i.level === 'ERROR'),
    stats: {
      days,
      weekWorkMinutes,
      leaveMinutes: Math.round(leaveMinutes),
      agreedMinutes: agreed,
      targetMinutes: Math.round(target),
      maxConsecutiveDays: maxRun,
    },
  };
}
