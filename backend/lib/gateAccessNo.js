// lib/gateAccessNo.js — 進出場單號顯示：ACC + 台北日期時間（yyyyMMddHHmmss）
const TZ = 'Asia/Taipei';

/**
 * @param {Date|string|number|null|undefined} checkInAt
 * @returns {string|null} e.g. ACC20260728215430
 */
export function formatGateAccessNo(checkInAt) {
  const d = checkInAt instanceof Date ? checkInAt : new Date(checkInAt);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  const h = get('hour');
  const mi = get('minute');
  const s = get('second');
  if (!y || !mo || !da || !h || !mi || !s) return null;
  return `ACC${y}${mo}${da}${h}${mi}${s}`;
}

/**
 * 解析進出場單號：數字 id，或 ACC+日期時間（可選 -id 後綴）
 * @returns {Promise<number|null>}
 */
export async function resolveGateLogId(raw, db) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) {
    const id = Number.parseInt(s, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  const m = /^ACC(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[-_#]?(\d+))?$/i.exec(s);
  if (!m) return null;

  if (m[7]) {
    const id = Number.parseInt(m[7], 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  const isoLocal = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  const start = new Date(isoLocal);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 1000);

  const rows = await db.checkInLog.findMany({
    where: { checkInAt: { gte: start, lt: end } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 5,
  });

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;

  const err = new Error(
    `該秒有多筆進出場紀錄，請改貼 ACC…-${rows.map((r) => r.id).join(' 或 ACC…-')}`,
  );
  err.statusCode = 400;
  throw err;
}
