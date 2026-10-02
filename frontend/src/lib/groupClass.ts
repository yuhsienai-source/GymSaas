// 團課（付費期班）顯示用標籤；報價、名額、退費金額一律由後端計算，此處僅對應文字
import type { BadgeTone } from './hrFormat';
import type { GroupEnrollKind } from '../types/api';

const TZ = 'Asia/Taipei';

export const ENROLL_KIND_LABEL: Record<string, string> = {
  TERM: '整期',
  DROP_IN: '單堂',
};

export const ENROLL_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: '待付款', tone: 'warning' },
  ACTIVE: { label: '已報名', tone: 'success' },
  EXPIRED: { label: '保留逾時', tone: 'neutral' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
  REFUNDED: { label: '已退費', tone: 'neutral' },
};

export const WAITLIST_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  WAITING: { label: '候補中', tone: 'info' },
  OFFERED: { label: '已遞補・限時報名', tone: 'warning' },
  ENROLLED: { label: '已報名', tone: 'success' },
  EXPIRED: { label: '遞補逾時', tone: 'neutral' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
};

export const REFUND_KIND_LABEL: Record<string, string> = {
  COOLING_OFF: '7 日猶豫期全額退',
  STANDARD: '依消保公式退費',
  SERIES_CANCELLED: '期班取消・未履約全退',
  DROP_IN: '單堂 24 小時前全額退',
};

export const RESERVATION_STATUS_LABEL: Record<string, string> = {
  PENDING: '待付款',
  CONFIRMED: '已預約',
  CANCELLED: '已請假／取消',
  COMPLETED: '已上課',
  NO_SHOW: '未到',
};

export function seriesStatusMeta(status: string): { label: string; tone: BadgeTone } {
  return status === 'CANCELLED' ? { label: '已取消', tone: 'danger' } : { label: '開放中', tone: 'success' };
}

/** YYYY-MM-DD（台北） */
export function dateKey(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

/** M/D（週） HH:mm */
export function classWhen(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', {
    timeZone: TZ,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function seriesScheduleLabel(s: {
  startDate: string;
  endDate: string;
  weekdaysLabel?: string;
  startTime: string;
  endTime: string;
}) {
  return `${dateKey(s.startDate)}～${dateKey(s.endDate)} · ${s.weekdaysLabel || ''} ${s.startTime}–${s.endTime}`.trim();
}

/** 加入 POS 購物車之團課草稿；price 僅供顯示，結帳金額由後端重新計價 */
export type GroupCartDraft = {
  seriesId: number;
  kind: GroupEnrollKind;
  classId?: number;
  name: string;
  price: number;
  sessions: number;
  detail: string;
};

export function groupCartKey(g: { seriesId: number; kind: GroupEnrollKind; classId?: number }) {
  return `${g.seriesId}:${g.kind}:${g.classId ?? ''}`;
}
