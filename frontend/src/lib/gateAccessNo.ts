/** 進出場單號：ACC + 台北日期時間（yyyyMMddHHmmss） */
const TZ = 'Asia/Taipei';

export function formatGateAccessNo(
  checkInAt?: string | Date | null,
  fallbackLogId?: number | string | null,
): string {
  if (checkInAt == null || checkInAt === '') {
    return fallbackLogId != null && fallbackLogId !== '' ? String(fallbackLogId) : '—';
  }
  const d = checkInAt instanceof Date ? checkInAt : new Date(checkInAt);
  if (Number.isNaN(d.getTime())) {
    return fallbackLogId != null && fallbackLogId !== '' ? String(fallbackLogId) : '—';
  }

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

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || '';
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  const h = get('hour');
  const mi = get('minute');
  const s = get('second');
  if (!y || !mo || !da || !h || !mi || !s) {
    return fallbackLogId != null && fallbackLogId !== '' ? String(fallbackLogId) : '—';
  }
  return `ACC${y}${mo}${da}${h}${mi}${s}`;
}
