// lib/groupClassSeries.js — 團課期班：開始～結束日 × 每週幾 × 時段 → 展開單堂
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
export const MAX_SERIES_SESSIONS = 80;

/**
 * @param {string} time HH:mm
 * @returns {{ h: number, m: number }}
 */
export function parseHm(time, label = '時刻') {
  const parts = String(time || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!parts) {
    const err = new Error(`${label}須為 HH:mm`);
    err.statusCode = 400;
    throw err;
  }
  const h = Number(parts[1]);
  const m = Number(parts[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    const err = new Error(`${label}無效`);
    err.statusCode = 400;
    throw err;
  }
  return { h, m };
}

/**
 * @param {unknown} raw
 * @returns {number[]} unique weekdays 0–6 sorted
 */
export function normalizeWeekdays(raw) {
  const arr = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const set = new Set();
  for (const item of arr) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      const err = new Error('每週幾無效（0=日 … 6=六）');
      err.statusCode = 400;
      throw err;
    }
    set.add(n);
  }
  if (set.size === 0) {
    const err = new Error('請至少選擇一個上課日（每週幾）');
    err.statusCode = 400;
    throw err;
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
export function assertDateOnly(dateStr, label) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error(`${label}須為 YYYY-MM-DD`);
    err.statusCode = 400;
    throw err;
  }
  const [y, m, d] = s.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    const err = new Error(`${label}無效`);
    err.statusCode = 400;
    throw err;
  }
  return s;
}

function ymdParts(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}

/** 日曆日的星期（與時區無關；ymd 視為台北日曆日） */
function ymdWeekday(ymd) {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

function nextYmd(ymd) {
  const { y, m, d } = ymdParts(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 展開期班時段（Asia/Taipei 牆上時間）
 * @returns {{ startAt: Date, endAt: Date, date: string }[]}
 */
export function expandSeriesSessions({
  startDate,
  endDate,
  weekdays,
  startTime,
  endTime,
  now = new Date(),
}) {
  const start = assertDateOnly(startDate, '開始日期');
  const end = assertDateOnly(endDate, '結束日期');
  const wds = normalizeWeekdays(weekdays);
  const st = parseHm(startTime, '開始於');
  const et = parseHm(endTime, '結束於');
  if (et.h * 60 + et.m <= st.h * 60 + st.m) {
    const err = new Error('結束於必須晚於開始於（同日）');
    err.statusCode = 400;
    throw err;
  }
  if (end < start) {
    const err = new Error('結束日期不可早於開始日期');
    err.statusCode = 400;
    throw err;
  }

  const sessions = [];
  let cursor = start;
  const nowMs = now.getTime();
  let guard = 0;

  while (cursor <= end) {
    if (wds.includes(ymdWeekday(cursor))) {
      const startAt = new Date(
        `${cursor}T${String(st.h).padStart(2, '0')}:${String(st.m).padStart(2, '0')}:00+08:00`,
      );
      const endAt = new Date(
        `${cursor}T${String(et.h).padStart(2, '0')}:${String(et.m).padStart(2, '0')}:00+08:00`,
      );
      if (!Number.isNaN(startAt.getTime()) && endAt > startAt && startAt.getTime() > nowMs) {
        sessions.push({ startAt, endAt, date: cursor });
      }
    }
    cursor = nextYmd(cursor);
    guard += 1;
    if (guard > 400 || sessions.length > MAX_SERIES_SESSIONS) {
      const err = new Error(`期班最多 ${MAX_SERIES_SESSIONS} 堂，請縮短日期區間或減少每週上課日`);
      err.statusCode = 400;
      throw err;
    }
  }

  if (sessions.length === 0) {
    const err = new Error('此區間內沒有可排的未來堂次（請檢查開始／結束日期與每週幾）');
    err.statusCode = 400;
    throw err;
  }

  return sessions;
}

export function formatWeekdaysLabel(weekdays) {
  return normalizeWeekdays(weekdays)
    .map((w) => `週${WEEKDAY_LABELS[w]}`)
    .join('、');
}
