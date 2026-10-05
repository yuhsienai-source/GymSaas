// lib/memberLeaveRules.js — 定型化契約第十二條「會員權暫停」純函式規則（不碰 DB）
// 日期一律以台灣日計：startAt＝起日 00:00（+08:00），endAt＝迄日次日 00:00（不含），days＝含頭尾天數

/** 第一項各款：出國逾一個月／傷病／懷孕育嬰侍親／服兵役／職務異動或遷居／其他；EPIDEMIC＝疫情準用第一項 */
export const LEAVE_CATEGORIES = Object.freeze([
  'OVERSEAS',
  'MEDICAL',
  'FAMILY_CARE',
  'MILITARY',
  'RELOCATION',
  'OTHER',
  'EPIDEMIC',
]);

export const LEAVE_CATEGORY_LABELS = Object.freeze({
  OVERSEAS: '出國逾一個月',
  MEDICAL: '傷害、疾病或身體不適',
  FAMILY_CARE: '懷孕、育嬰、侍親',
  MILITARY: '服兵役',
  RELOCATION: '職務異動或遷居',
  OTHER: '其他事由',
  EPIDEMIC: '疫情一級開設（準用）',
});

export const LEAVE_MAX_DAYS = 365;
/** 第一款「逾一個月」 */
export const OVERSEAS_MIN_DAYS = 31;
/** 傷病（未能事先提出診斷證明）與疫情準用：得於事由發生後一個月內補辦 */
export const LEAVE_BACKDATE_MAX_DAYS = 30;
export const LEAVE_PROOF_GRACE_DAYS = 30;
/** 乙方應於七工作日內辦理 */
export const LEAVE_REVIEW_WORKING_DAYS = 7;
/** 第二款暫停滿六個月得依第九點終止、免手續費 */
export const MEDICAL_EXEMPT_FROZEN_DAYS = 180;

const DEFERRABLE = new Set(['MEDICAL', 'EPIDEMIC']);
const DAY_MS = 24 * 3600 * 1000;
const TW_OFFSET_MS = 8 * 3600 * 1000;

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const twDayIndex = (d) => Math.floor((new Date(d).getTime() + TW_OFFSET_MS) / DAY_MS);
const dayIndexToTwMidnight = (idx) => new Date(idx * DAY_MS - TW_OFFSET_MS);

function parseYmd(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return Math.floor(t / DAY_MS);
}

/** 可事後補辦（回溯起算）且可先送件後補證明之事由 */
export function isDeferrableCategory(category) {
  return DEFERRABLE.has(category);
}

/**
 * 驗證暫停申請並換算起迄時刻
 * @returns {{ category: string, days: number, startAt: Date, endAt: Date, backdated: boolean, proofDueAt: Date|null }}
 */
export function validateLeaveApplication({ category, startDate, endDate, hasProof = false, now = new Date() }) {
  const cat = String(category ?? '').trim().toUpperCase();
  if (!LEAVE_CATEGORIES.includes(cat)) {
    throw httpError(400, 'LEAVE_CATEGORY_INVALID', '請選擇第十二條所列暫停事由');
  }
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (start == null || end == null || end < start) {
    throw httpError(400, 'LEAVE_DATES_INVALID', '暫停起迄日無效（結束日不可早於起始日）');
  }
  const days = end - start + 1;
  if (days > LEAVE_MAX_DAYS) {
    throw httpError(400, 'LEAVE_DAYS_OUT_OF_RANGE', `單次暫停最長 ${LEAVE_MAX_DAYS} 日`);
  }
  if (cat === 'OVERSEAS' && days < OVERSEAS_MIN_DAYS) {
    throw httpError(400, 'LEAVE_OVERSEAS_MIN_DAYS', `出國事由須逾一個月（至少 ${OVERSEAS_MIN_DAYS} 日）`);
  }
  const today = twDayIndex(now);
  const backdated = start < today;
  if (backdated && !DEFERRABLE.has(cat)) {
    throw httpError(400, 'LEAVE_BACKDATE_NOT_ALLOWED', '此事由須事先申請，起始日不可早於今日');
  }
  if (backdated && today - start > LEAVE_BACKDATE_MAX_DAYS) {
    throw httpError(400, 'LEAVE_BACKDATE_TOO_FAR', `事後補辦限事由發生後 ${LEAVE_BACKDATE_MAX_DAYS} 日內`);
  }
  if (!hasProof && !DEFERRABLE.has(cat)) {
    throw httpError(400, 'LEAVE_PROOF_REQUIRED', '請檢附事由證明或釋明文件');
  }
  return {
    category: cat,
    days,
    startAt: dayIndexToTwMidnight(start),
    endAt: dayIndexToTwMidnight(end + 1),
    backdated,
    proofDueAt: hasProof ? null : dayIndexToTwMidnight(today + LEAVE_PROOF_GRACE_DAYS + 1),
  };
}

/** 審核期限計算所需之國定假日查詢區間（台灣日 YYYY-MM-DD；涵蓋春節等連假） */
export function reviewHolidayWindow(from) {
  const idx = twDayIndex(from);
  const key = (i) => new Date(i * DAY_MS).toISOString().slice(0, 10);
  return { fromKey: key(idx), toKey: key(idx + 45) };
}

/**
 * 自 from（台灣日）起算第 n 個工作日之當日結束；不含 from 當日。
 * 工作日＝週一～五且非國定假日（holidayKeys 來自 laborLaw／HQ 假日曆）
 * @param {Set<string>} holidayKeys 'YYYY-MM-DD'
 */
export function addWorkingDays(from, n = LEAVE_REVIEW_WORKING_DAYS, holidayKeys = new Set()) {
  let idx = twDayIndex(from);
  let left = n;
  while (left > 0) {
    idx += 1;
    const day = new Date(idx * DAY_MS);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidayKeys.has(day.toISOString().slice(0, 10))) left -= 1;
  }
  return new Date(dayIndexToTwMidnight(idx + 1).getTime() - 1);
}

/** 該筆暫停已實際凍結之天數：已結束取 frozenDays（舊資料回退 days）；進行中取已經過天數 */
export function frozenDaysOf(leave, now = new Date()) {
  if (!leave) return 0;
  const elapsedUntil = (t) => {
    const elapsed = Math.ceil((new Date(t).getTime() - new Date(leave.startAt).getTime()) / DAY_MS);
    return Math.max(0, Math.min(leave.days ?? 0, elapsed));
  };
  if (leave.status === 'ENDED') {
    if (leave.frozenDays != null) return Math.max(0, leave.frozenDays);
    // 退費／取消截斷時只寫 endedAt
    return leave.endedAt ? elapsedUntil(leave.endedAt) : Math.max(0, leave.days ?? 0);
  }
  if (leave.status === 'ACTIVE') return elapsedUntil(now);
  return 0;
}

/** 傷病（第二款）累計凍結天數與是否達免手續費終止門檻 */
export function medicalSuspensionSummary(leaves, now = new Date()) {
  const days = (leaves || [])
    .filter((l) => l.category === 'MEDICAL')
    .reduce((sum, l) => sum + frozenDaysOf(l, now), 0);
  return { days, exemptEligible: days >= MEDICAL_EXEMPT_FROZEN_DAYS };
}
