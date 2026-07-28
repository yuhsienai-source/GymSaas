export type PromotionUsageType = 'TIMED' | 'UNLIMITED';
export type PromotionPlanMode = 'STANDING' | 'CAMPAIGN';

export const USAGE_TYPE_LABELS: Record<PromotionUsageType, string> = {
  TIMED: '計時',
  UNLIMITED: '月卡',
};

export const PLAN_MODE_LABELS: Record<PromotionPlanMode, string> = {
  STANDING: '長註',
  CAMPAIGN: '活動',
};

export function toDatetimeLocalValue(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPromotionSchedule(
  planMode?: PromotionPlanMode | string | null,
  saleStartAt?: string | null,
  saleEndAt?: string | null,
) {
  if (planMode !== 'CAMPAIGN') return '長註';
  const start = saleStartAt ? new Date(saleStartAt).toLocaleString('zh-TW') : '—';
  const end = saleEndAt ? new Date(saleEndAt).toLocaleString('zh-TW') : '—';
  return `${start} ~ ${end}`;
}

export function formatPromotionDuration(promotion: {
  usageType?: string | null;
  unitDays?: number | null;
  periodCount?: number | null;
  durationDays?: number | null;
}) {
  if (promotion.usageType !== 'UNLIMITED') return '—';
  const unit = promotion.unitDays;
  const periods = promotion.periodCount;
  const total = promotion.durationDays;
  if (unit && periods) {
    return `${unit} 天 × ${periods} 期＝${unit * periods} 天`;
  }
  if (total) return `${total} 天`;
  return '—';
}

/** 方案文案用：運動金顯示為 SC（會員頁面仍用「運動金」） */
export function formatScAmount(amount: number) {
  const n = Number(amount) || 0;
  return `SC $${n}`;
}

export function formatPromotionValue(promotion: {
  usageType?: string | null;
  price: number;
  bonusGiven: number;
  durationDays?: number | null;
}) {
  if (promotion.usageType === 'UNLIMITED') {
    return `$${promotion.price}`;
  }
  return `$${promotion.price} + ${formatScAmount(promotion.bonusGiven)}`;
}

export function formatPromotionOptionLabel(promotion: {
  name: string;
  usageType?: string | null;
  price: number;
  bonusGiven: number;
  unitDays?: number | null;
  periodCount?: number | null;
  durationDays?: number | null;
}) {
  if (promotion.usageType === 'UNLIMITED') {
    const dur = formatPromotionDuration(promotion);
    return `${promotion.name} — $${promotion.price} · ${dur}無限`;
  }
  return `${promotion.name} — $${promotion.price} + ${formatScAmount(promotion.bonusGiven)}`;
}

export function getCampaignStatus(
  planMode?: PromotionPlanMode | string | null,
  saleStartAt?: string | null,
  saleEndAt?: string | null,
  isActive?: boolean,
) {
  if (!isActive) return '已下架';
  if (planMode !== 'CAMPAIGN') return '長註';
  const now = Date.now();
  const start = saleStartAt ? new Date(saleStartAt).getTime() : null;
  const end = saleEndAt ? new Date(saleEndAt).getTime() : null;
  if (start && now < start) return '未開始';
  if (end && now > end) return '已結束';
  return '進行中';
}
