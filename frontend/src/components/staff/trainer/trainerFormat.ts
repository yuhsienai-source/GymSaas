import type { TrainerDashboardClass, TrainerInboxItem } from '../../../types/api';

export function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTimeRange(startIso: string, endIso: string) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '—';
  const day = s.toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const t0 = s.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const t1 = e.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${t0}–${t1}`;
}

export function sessionMinutes(startIso: string, endIso: string) {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.round((e - s) / 60000);
}

export function typeLabel(type?: string) {
  if (type === 'PRIVATE') return '私教';
  if (type === 'CONSULT') return '諮詢';
  return '團課';
}

export function formatExpire(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-TW');
}

export function money(n: number | null | undefined) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

export function inboxTone(severity?: string): 'danger' | 'warning' | 'info' | 'neutral' {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  if (severity === 'low') return 'info';
  return 'neutral';
}

export function inboxTypeLabel(type?: string) {
  switch (type) {
    case 'UNPAID':
      return '未付款';
    case 'ALERT':
      return '警示';
    case 'LOW_SESSIONS':
      return '堂數';
    case 'EXPIRING':
      return '到期';
    case 'NO_LINE':
      return 'LINE';
    default:
      return '訊息';
  }
}

export function isTodayClass(c: TrainerDashboardClass, now = new Date()) {
  const start = new Date(c.startAt);
  if (Number.isNaN(start.getTime())) return false;
  return (
    start.getFullYear() === now.getFullYear() &&
    start.getMonth() === now.getMonth() &&
    start.getDate() === now.getDate()
  );
}

export function sortInbox(items: TrainerInboxItem[]) {
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return [...items].sort((a, b) => {
    const sa = rank[a.severity] ?? 9;
    const sb = rank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
}
