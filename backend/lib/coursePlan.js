// lib/coursePlan.js — 課程方案類型／模式
import {
  normalizePlanMode,
  parseBooleanFlag,
  parseOptionalDate,
  parsePositiveInt,
  resolvePromotionSchedule,
} from './promotion.js';

export function normalizeCoursePlanType(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'GROUP') return 'GROUP';
  if (v === 'CUSTOM_PT' || v === 'PRIVATE' || v === 'PT') return 'CUSTOM_PT';
  const err = new Error('planType 必須為 CUSTOM_PT（客製化私教）或 GROUP（團體課程）');
  err.statusCode = 400;
  throw err;
}

export function resolveCoursePlanFields(body, { partial = false, current = null } = {}) {
  const planType = normalizeCoursePlanType(
    body.planType !== undefined ? body.planType : current?.planType,
  );

  const priceRaw = body.price !== undefined ? body.price : current?.price;
  const parsedPrice = parseFloat(priceRaw);
  if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
    const err = new Error('price 必須為非負數');
    err.statusCode = 400;
    throw err;
  }

  let sessions = current?.sessions ?? null;
  if (body.sessions !== undefined) {
    if (body.sessions === null || body.sessions === '') {
      sessions = null;
    } else {
      sessions = parsePositiveInt(body.sessions, 'sessions');
    }
  }

  let capacity = current?.capacity ?? null;
  if (body.capacity !== undefined) {
    if (body.capacity === null || body.capacity === '') {
      capacity = null;
    } else {
      capacity = parsePositiveInt(body.capacity, 'capacity');
    }
  }

  if (!partial) {
    if (planType === 'CUSTOM_PT' && !sessions) {
      const err = new Error('客製化私教必須設定堂數 sessions');
      err.statusCode = 400;
      throw err;
    }
    if (planType === 'GROUP') {
      if (!sessions) {
        const err = new Error('團體課程必須設定期班堂數 sessions');
        err.statusCode = 400;
        throw err;
      }
      if (!capacity) {
        const err = new Error('團體課程必須設定人數上限 capacity');
        err.statusCode = 400;
        throw err;
      }
    }
  } else {
    if (planType === 'CUSTOM_PT' && !sessions) {
      const err = new Error('客製化私教必須設定堂數 sessions');
      err.statusCode = 400;
      throw err;
    }
    if (planType === 'GROUP') {
      if (!sessions) {
        const err = new Error('團體課程必須設定期班堂數 sessions');
        err.statusCode = 400;
        throw err;
      }
      if (!capacity) {
        const err = new Error('團體課程必須設定人數上限 capacity');
        err.statusCode = 400;
        throw err;
      }
    }
  }

  const descriptionRaw =
    body.description !== undefined ? body.description : current?.description;
  const description =
    descriptionRaw === undefined || descriptionRaw === null
      ? null
      : String(descriptionRaw).trim() || null;

  const enableCardRecurring = parseBooleanFlag(
    body.enableCardRecurring !== undefined
      ? body.enableCardRecurring
      : current?.enableCardRecurring,
    false,
  );

  const requiresMemberContract = parseBooleanFlag(
    body.requiresMemberContract !== undefined
      ? body.requiresMemberContract
      : current?.requiresMemberContract,
    false,
  );

  const enableSecondPerson = parseBooleanFlag(
    body.enableSecondPerson !== undefined
      ? body.enableSecondPerson
      : current?.enableSecondPerson,
    false,
  );

  const giftRaw = body.giftLabel !== undefined ? body.giftLabel : current?.giftLabel;
  const giftLabel =
    giftRaw === undefined || giftRaw === null
      ? null
      : String(giftRaw).trim().slice(0, 80) || null;

  return {
    planType,
    price: parsedPrice,
    sessions,
    capacity,
    description,
    enableCardRecurring,
    requiresMemberContract,
    enableSecondPerson,
    giftLabel,
  };
}

/** 第二人現場加購（不計入結帳應付） */
export const SECOND_PERSON_ON_SITE_LABEL = '課程第二人+$500(課程當日現場支付)';
export const SECOND_PERSON_ON_SITE_FEE = 500;

export { normalizePlanMode, resolvePromotionSchedule as resolveCoursePlanSchedule, parseOptionalDate };

export function isCoursePlanSellable(plan, now = new Date()) {
  if (!plan || !plan.isActive) return false;
  if (plan.planMode !== 'CAMPAIGN') return true;
  const start = plan.saleStartAt ? new Date(plan.saleStartAt) : null;
  const end = plan.saleEndAt ? new Date(plan.saleEndAt) : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export function assertCoursePlanSellable(plan) {
  if (!plan) {
    const err = new Error('找不到此課程方案');
    err.statusCode = 404;
    throw err;
  }
  if (!isCoursePlanSellable(plan)) {
    const err = new Error(`⛔ 課程方案 [${plan.name}] 目前不在可購買檔期`);
    err.statusCode = 400;
    throw err;
  }
}

/** 私教／櫃檯：只顯示當下可購買的課程方案 */
export function coursePlanSellablePrismaWhere(base = {}) {
  const now = new Date();
  return {
    ...base,
    isActive: true,
    OR: [
      { planMode: 'STANDING' },
      {
        planMode: 'CAMPAIGN',
        AND: [
          { OR: [{ saleStartAt: null }, { saleStartAt: { lte: now } }] },
          { OR: [{ saleEndAt: null }, { saleEndAt: { gte: now } }] },
        ],
      },
    ],
  };
}
