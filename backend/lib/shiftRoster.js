// lib/shiftRoster.js — 分店場務排班：勞基法四週變形工時（§30-1、§36、§34）規則與自動排班（純函式）
import { canonicalRole } from './orgStructure.js';
import { FULL_TIME_WEEKLY_HOURS, addDaysKey, diffDaysKey } from './laborLaw.js';

export const ROSTER_CYCLE_DAYS = 28;
/** 每班場務最低人力（和平／輔大店規定；分店設定不得低於此） */
export const MIN_SHIFT_HEADCOUNT = 2;
export const MAX_SHIFT_HEADCOUNT = 10;

/** 與交班早／晚班一致；各含 30 分鐘休息（§35），正常工時 8 小時 */
export const ROSTER_SHIFTS = {
  MORNING: { label: '早班', short: '早', start: '07:00', minutes: 510, breakMinutes: 30 },
  EVENING: { label: '晚班', short: '晚', start: '15:30', minutes: 510, breakMinutes: 30 },
};
export const SHIFT_CODES = Object.keys(ROSTER_SHIFTS);

/** 非出勤格：例假（§36 不得出勤）、休息日、排休（超出法定之空班） */
export const OFF_CODES = {
  REGULAR_OFF: { label: '例假', short: '例' },
  REST_DAY: { label: '休息日', short: '休' },
  OFF: { label: '排休', short: '排' },
};
export const CELL_CODES = [...SHIFT_CODES, ...Object.keys(OFF_CODES)];

/** 四週變形工時法定界線 */
export const FOUR_WEEK_RULES = {
  maxDailyNormalHours: 10,
  maxCycleNormalHours: 160,
  minRegularOffPerTwoWeeks: 2,
  minRestDays: 4,
  minDaysOff: 8,
  minRestBetweenShiftsHours: 11,
  /** 保守上限：二週 2 例假下之連續出勤警示 */
  warnConsecutiveWorkDays: 12,
};

const PREFERRED_MAX_CONSECUTIVE = 5;

export function shiftWorkHours(code) {
  const s = ROSTER_SHIFTS[code];
  return s ? (s.minutes - s.breakMinutes) / 60 : 0;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 前一日班別結束 → 當日班別開始之間隔（小時） */
export function restHoursBetween(prevCode, nextCode) {
  const prev = ROSTER_SHIFTS[prevCode];
  const next = ROSTER_SHIFTS[nextCode];
  if (!prev || !next) return Infinity;
  const prevEnd = minutesOf(prev.start) + prev.minutes;
  return (24 * 60 + minutesOf(next.start) - prevEnd) / 60;
}

/** 班別起訖（台北時間） */
export function shiftTimeRange(dateKey, code) {
  const s = ROSTER_SHIFTS[code];
  if (!s) {
    const startAt = new Date(`${dateKey}T00:00:00+08:00`);
    return { startAt, endAt: new Date(startAt.getTime() + 86400000) };
  }
  const startAt = new Date(`${dateKey}T${s.start}:00+08:00`);
  return { startAt, endAt: new Date(startAt.getTime() + s.minutes * 60000) };
}

/**
 * 排班編制角色：場務（STAFF／DUTY）與實習教練（TRAINER＋INTERN）進入排班；
 * 轉正（非實習）之教練自由排班，不納入人力編制
 * @returns {'STORE'|'INTERN_TRAINER'|'FREE_TRAINER'|null}
 */
export function rosterRoleOf(staff) {
  const role = canonicalRole(staff?.role);
  if (role === 'STAFF' || role === 'DUTY') return 'STORE';
  if (role === 'TRAINER') return staff.employmentType === 'INTERN' ? 'INTERN_TRAINER' : 'FREE_TRAINER';
  return null;
}

export const ROSTER_ROLE_LABELS = {
  STORE: '場務',
  INTERN_TRAINER: '實習教練',
  FREE_TRAINER: '教練（自由排班）',
};

export function isRosterEligible(staff) {
  const r = rosterRoleOf(staff);
  return r === 'STORE' || r === 'INTERN_TRAINER';
}

/** 本期可排班數上限：依約定週工時 × 4 週，且不超過 160 小時 */
export function cycleShiftCapacity(staff) {
  const weekly = staff.employmentType === 'FULL_TIME' ? FULL_TIME_WEEKLY_HOURS : Number(staff.weeklyHours) || FULL_TIME_WEEKLY_HOURS;
  const hours = Math.min(FOUR_WEEK_RULES.maxCycleNormalHours, Math.min(weekly, FULL_TIME_WEEKLY_HOURS) * 4);
  return Math.floor(hours / shiftWorkHours('MORNING'));
}

/** 排假截止：每期開始前 14 日（當日 23:59 台北時間前仍可遞交） */
export const OFF_REQUEST_DEADLINE_DAYS = 14;
/** 班表發布後員工須於 72 小時（3 日）內確認回覆 */
export const ROSTER_ACK_HOURS = 72;
export const ROSTER_ACK_STATUSES = ['CONFIRMED', 'DISPUTED'];

export function offRequestDeadlineKey(startKey) {
  return addDaysKey(startKey, -OFF_REQUEST_DEADLINE_DAYS);
}

export function rosterAckDeadline(publishedAt) {
  return publishedAt ? new Date(new Date(publishedAt).getTime() + ROSTER_ACK_HOURS * 3600000) : null;
}

/** 每期可申請排休日數上限＝28 日 − 約定班數（正職 8 日） */
export function maxOffRequestDays(staff) {
  return ROSTER_CYCLE_DAYS - cycleShiftCapacity(staff);
}

/** 週期起日：錨點 + 28k（週期固定，不得任意位移） */
export function cycleStartFor(anchorKey, dateKey) {
  const offset = diffDaysKey(anchorKey, dateKey);
  return addDaysKey(anchorKey, Math.floor(offset / ROSTER_CYCLE_DAYS) * ROSTER_CYCLE_DAYS);
}

export function cycleDays(startKey) {
  return Array.from({ length: ROSTER_CYCLE_DAYS }, (_, i) => addDaysKey(startKey, i));
}

function issue(level, code, message, date) {
  return date ? { level, code, message, date } : { level, code, message };
}

/**
 * 單一員工四週期合規檢查
 * @param {{ staff: object, days: string[], cells: Map<string,string>, leaveDays: Set<string>, holidayKeys: Set<string>, prevCell?: string|null }} input
 */
export function evaluateStaffCycle({ staff, days, cells, leaveDays, holidayKeys, prevCell = null, requestedOff = new Set() }) {
  const lsa = staff.laborActApplies !== false;
  const hard = lsa ? 'ERROR' : 'WARNING';
  const issues = [];
  const stats = {
    workDays: 0,
    workHours: 0,
    regularOff: [0, 0],
    restDays: 0,
    offDays: 0,
    leaveDays: 0,
    unassigned: 0,
    holidaysWorked: 0,
    requestedOff: requestedOff.size,
    requestedOffUnmet: 0,
    maxConsecutive: 0,
    capacity: cycleShiftCapacity(staff),
  };

  let consecutive = 0;
  let prev = prevCell;
  days.forEach((day, idx) => {
    const cell = cells.get(day) ?? null;
    const block = idx < 14 ? 0 : 1;
    const onLeave = leaveDays.has(day);
    if (SHIFT_CODES.includes(cell)) {
      stats.workDays += 1;
      stats.workHours += shiftWorkHours(cell);
      consecutive += 1;
      stats.maxConsecutive = Math.max(stats.maxConsecutive, consecutive);
      if (holidayKeys.has(day)) stats.holidaysWorked += 1;
      if (requestedOff.has(day)) {
        stats.requestedOffUnmet += 1;
        issues.push(issue('WARNING', 'OFF_REQUEST_UNMET', `${day} 員工已申請排休，仍被排班`, day));
      }
      if (onLeave) issues.push(issue('WARNING', 'LEAVE_CONFLICT', `${day} 已核准請假卻排班`, day));
      if (shiftWorkHours(cell) > FOUR_WEEK_RULES.maxDailyNormalHours) {
        issues.push(issue(hard, 'DAILY_HOURS', `${day} 正常工時超過 10 小時（§30-1）`, day));
      }
      const gap = restHoursBetween(prev, cell);
      if (gap < FOUR_WEEK_RULES.minRestBetweenShiftsHours) {
        issues.push(issue(hard, 'REST_INTERVAL', `${day} 晚班接早班僅間隔 ${gap} 小時，輪班間隔須 ≥ 11 小時（§34）`, day));
      }
    } else {
      consecutive = 0;
      if (onLeave) stats.leaveDays += 1;
      else if (cell === 'REGULAR_OFF') stats.regularOff[block] += 1;
      else if (cell === 'REST_DAY') stats.restDays += 1;
      else if (cell === null) stats.unassigned += 1;
      if (!onLeave) stats.offDays += 1;
    }
    prev = cell;
  });

  stats.workHours = Math.round(stats.workHours * 10) / 10;
  if (stats.workHours > FOUR_WEEK_RULES.maxCycleNormalHours) {
    issues.push(issue(hard, 'CYCLE_HOURS', `四週正常工時 ${stats.workHours} 小時，超過 160 小時（§30-1）`));
  } else if (stats.workDays > stats.capacity) {
    issues.push(issue('WARNING', 'CONTRACT_HOURS', `排班 ${stats.workDays} 班超過約定工時上限 ${stats.capacity} 班，超出部分屬延長工時`));
  }
  stats.regularOff.forEach((n, i) => {
    if (n < FOUR_WEEK_RULES.minRegularOffPerTwoWeeks) {
      issues.push(issue(hard, 'REGULAR_OFF_SHORT', `第 ${i + 1} 個二週僅 ${n} 日例假，每二週至少 2 日（§36）`));
    }
  });
  if (stats.offDays + stats.leaveDays < FOUR_WEEK_RULES.minDaysOff) {
    issues.push(issue(hard, 'DAYS_OFF_SHORT', `四週休假僅 ${stats.offDays + stats.leaveDays} 日，例假＋休息日至少 8 日（§36）`));
  } else if (stats.restDays < FOUR_WEEK_RULES.minRestDays) {
    issues.push(issue('WARNING', 'REST_DAY_UNMARKED', `休息日僅標示 ${stats.restDays} 日，請再指定 ${FOUR_WEEK_RULES.minRestDays - stats.restDays} 日（四週至少 4 日）`));
  }
  if (stats.maxConsecutive > FOUR_WEEK_RULES.warnConsecutiveWorkDays) {
    issues.push(issue('WARNING', 'CONSECUTIVE_DAYS', `連續出勤 ${stats.maxConsecutive} 日，建議不超過 12 日`));
  }
  if (stats.unassigned > 0) {
    issues.push(issue('WARNING', 'UNASSIGNED', `尚有 ${stats.unassigned} 日未排定（出勤／例假／休息日）`));
  }
  if (stats.holidaysWorked > 0) {
    issues.push(issue('INFO', 'HOLIDAY_WORK', `國定假日出勤 ${stats.holidaysWorked} 日：須加倍發給工資或經同意與工作日對調（§37、§39）`));
  }
  if (!lsa) {
    issues.push(issue('INFO', 'NO_LABOR_RELATION', '無勞雇關係之實習：勞基法工時規定不適用，仍應符合實習計畫與安全休息'));
  }
  return { stats, issues };
}

/** 各日各班人力覆蓋 */
export function evaluateCoverage({ days, staffCells, requirement }) {
  const coverage = days.map((day) => {
    const row = { date: day };
    for (const code of SHIFT_CODES) {
      row[code] = staffCells.reduce((n, cells) => n + (cells.get(day) === code ? 1 : 0), 0);
    }
    return row;
  });
  const issues = [];
  for (const row of coverage) {
    for (const code of SHIFT_CODES) {
      if (row[code] < requirement[code]) {
        issues.push(issue('ERROR', 'SHORTAGE', `${row.date} ${ROSTER_SHIFTS[code].label}人力 ${row[code]}／${requirement[code]}`, row.date));
      }
    }
  }
  return { coverage, issues };
}

/**
 * 自動排班（貪婪法）：先滿足每日早／晚班人力，同時守住
 * 每二週 ≤12 班（保留 2 日例假）、本期班數上限、晚接早禁排、連續出勤偏好 ≤5 日；
 * 排假申請日最後才補位（人力不足時才動用），並優先標為例假／休息日
 * @param {{ days: string[], staff: object[], requirement: Record<string, number>, leaveDays: Map<number, Set<string>>, prevCells?: Map<number, string|null> }} input
 * @returns {Map<number, Map<string, string>>}
 */
export function generateRoster({ days, staff, requirement, leaveDays, prevCells = new Map(), offRequests = new Map() }) {
  const state = new Map(
    staff.map((s) => [
      s.id,
      {
        s,
        cap: cycleShiftCapacity(s),
        count: 0,
        block: [0, 0],
        consecutive: 0,
        last: prevCells.get(s.id) ?? null,
        cells: new Map(),
      },
    ]),
  );
  const maxPerBlock = 14 - FOUR_WEEK_RULES.minRegularOffPerTwoWeeks;

  days.forEach((day, idx) => {
    const block = idx < 14 ? 0 : 1;
    const assignedToday = new Set();
    for (const code of ['EVENING', 'MORNING']) {
      const candidates = [...state.values()].filter((st) => {
        if (assignedToday.has(st.s.id)) return false;
        if (leaveDays.get(st.s.id)?.has(day)) return false;
        if (st.count >= st.cap || st.block[block] >= maxPerBlock) return false;
        if (restHoursBetween(st.last, code) < FOUR_WEEK_RULES.minRestBetweenShiftsHours) return false;
        return st.consecutive < FOUR_WEEK_RULES.warnConsecutiveWorkDays;
      });
      const score = (st) =>
        (st.count / st.cap) * 10 +
        Math.max(0, st.consecutive - (PREFERRED_MAX_CONSECUTIVE - 1)) * 6 +
        (st.last === code ? -1.5 : SHIFT_CODES.includes(st.last) ? 1 : 0);
      const byScore = (a, b) => score(a) - score(b) || a.s.id - b.s.id;
      const requested = (st) => offRequests.get(st.s.id)?.has(day);
      const picks = [
        ...candidates.filter((st) => !requested(st)).sort(byScore),
        ...candidates.filter(requested).sort(byScore),
      ];
      for (const st of picks.slice(0, requirement[code])) {
        st.cells.set(day, code);
        assignedToday.add(st.s.id);
      }
    }
    for (const st of state.values()) {
      const cell = st.cells.get(day);
      if (cell) {
        st.count += 1;
        st.block[block] += 1;
        st.consecutive += 1;
      } else {
        st.consecutive = 0;
      }
      st.last = cell ?? null;
    }
  });

  for (const st of state.values()) {
    classifyOffDays(days, st.cells, leaveDays.get(st.s.id) || new Set(), offRequests.get(st.s.id) || new Set());
  }
  return new Map([...state.values()].map((st) => [st.s.id, st.cells]));
}

/** 未出勤日分類：每二週 2 日例假（每週各取 1 日為先）、再 4 日休息日，其餘排休 */
export function classifyOffDays(days, cells, leaveDays, preferred = new Set()) {
  const offIdx = days
    .map((d, i) => i)
    .filter((i) => !cells.get(days[i]) && !leaveDays.has(days[i]))
    .sort((a, b) => Number(preferred.has(days[b])) - Number(preferred.has(days[a])) || a - b);
  const taken = new Set();
  const pick = (range, limit, code) => {
    let n = 0;
    for (const i of offIdx) {
      if (n >= limit) break;
      if (i >= range[0] && i <= range[1] && !taken.has(i)) {
        cells.set(days[i], code);
        taken.add(i);
        n += 1;
      }
    }
    return n;
  };
  for (const [b0, b1] of [[0, 13], [14, 27]]) {
    let got = pick([b0, b0 + 6], 1, 'REGULAR_OFF');
    got += pick([b0 + 7, b1], 1, 'REGULAR_OFF');
    if (got < 2) pick([b0, b1], 2 - got, 'REGULAR_OFF');
  }
  let rest = 0;
  for (const w of [0, 1, 2, 3]) rest += pick([w * 7, w * 7 + 6], 1, 'REST_DAY');
  if (rest < FOUR_WEEK_RULES.minRestDays) pick([0, 27], FOUR_WEEK_RULES.minRestDays - rest, 'REST_DAY');
  for (const i of offIdx) if (!taken.has(i)) cells.set(days[i], 'OFF');
  return cells;
}
