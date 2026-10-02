// lib/coursePlan.js — 課程方案類型／模式
import {
  normalizePlanMode,
  parseBooleanFlag,
  parseOptionalDate,
  parsePositiveInt,
  resolvePromotionSchedule,
} from './promotion.js';

export const COURSE_PLAN_KINDS = ['SALE', 'COMPENSATION'];
export const PT_CONTRACT_SOURCES = ['PURCHASE', 'COMPENSATION'];

export function normalizeCoursePlanKind(value) {
  const raw = String(value || 'SALE').trim().toUpperCase();
  if (raw === 'COMPENSATION' || raw === 'COMP' || raw === 'TYPE_COMPENSATION') {
    return 'COMPENSATION';
  }
  return 'SALE';
}

export function isCompensationCoursePlan(plan) {
  return normalizeCoursePlanKind(plan?.kind) === 'COMPENSATION';
}

export function normalizeCoursePlanType(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'GROUP') return 'GROUP';
  if (v === 'CUSTOM_PT' || v === 'PRIVATE' || v === 'PT') return 'CUSTOM_PT';
  const err = new Error('planType 必須為 CUSTOM_PT（客製化私教）或 GROUP（團體課程）');
  err.statusCode = 400;
  throw err;
}

/** bitmask：2＝可選2期、4＝可選4期、6＝兩者皆可 */
export function encodeRecurringPeriodsMask({ allow2, allow4 }) {
  let mask = 0;
  if (allow2) mask |= 2;
  if (allow4) mask |= 4;
  return mask > 0 ? mask : null;
}

export function decodeRecurringPeriodsMask(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return { allow2: false, allow4: false, mask: null };
  return {
    allow2: (n & 2) !== 0,
    allow4: (n & 4) !== 0,
    mask: (n & 6) || null,
  };
}

/**
 * 解析可選期數：支援 bitmask（2|4|6）、單一 2/4、或陣列 [2]、[4]、[2,4]
 */
export function parseRecurringPeriodsInput(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '' || raw === 0) return null;
  if (Array.isArray(raw)) {
    const allow2 = raw.some((x) => Number(x) === 2);
    const allow4 = raw.some((x) => Number(x) === 4);
    return encodeRecurringPeriodsMask({ allow2, allow4 });
  }
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (n === 2 || n === 4 || n === 6) return n;
  const decoded = decodeRecurringPeriodsMask(n);
  return decoded.mask;
}

export function resolveCoursePlanFields(body, { partial = false, current = null } = {}) {
  const kind = normalizeCoursePlanKind(
    body.kind !== undefined ? body.kind : body.type !== undefined ? body.type : current?.kind,
  );
  const planType = normalizeCoursePlanType(
    body.planType !== undefined ? body.planType : current?.planType,
  );

  if (kind === 'COMPENSATION') {
    if (planType !== 'CUSTOM_PT') {
      const err = new Error('客訴補償課程僅限客製化私教（CUSTOM_PT）');
      err.statusCode = 400;
      throw err;
    }
    const priceRaw = body.price !== undefined ? body.price : current?.price;
    const parsedPrice = parseFloat(priceRaw);
    if (Number.isNaN(parsedPrice) || parsedPrice !== 0) {
      const err = new Error('客訴補償課程 price 必須為 0（禁止自填補償金額）');
      err.statusCode = 400;
      throw err;
    }
    const sessionsRaw = body.sessions !== undefined ? body.sessions : current?.sessions;
    const sessions = parsePositiveInt(sessionsRaw, 'sessions');
    if (
      parseBooleanFlag(
        body.enableCardRecurring !== undefined
          ? body.enableCardRecurring
          : current?.enableCardRecurring,
        false,
      )
    ) {
      const err = new Error('客訴補償課程不可啟用定期定額');
      err.statusCode = 400;
      throw err;
    }
    return {
      kind,
      planType: 'CUSTOM_PT',
      price: 0,
      sessions,
      capacity: null,
      dropInPrice: null,
      minEnrollment: null,
      description:
        body.description !== undefined
          ? body.description == null || body.description === ''
            ? null
            : String(body.description).trim()
          : current?.description ?? null,
      requiresMemberContract: false,
      enableCardRecurring: false,
      recurringPeriods: null,
      recurringAmount: null,
      recurringAmount4: null,
      recurringAmountFinal: null,
      payuniPeriodHash: null,
      payuniPeriodHashOnline: null,
      enableSecondPerson: false,
      giftLabel: null,
      giftQty: null,
    };
  }

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

  let recurringPeriods = current?.recurringPeriods ?? null;
  if (body.recurringPeriods !== undefined) {
    recurringPeriods = parseRecurringPeriodsInput(body.recurringPeriods);
  }
  if (!enableCardRecurring) recurringPeriods = null;

  const { allow2, allow4 } = decodeRecurringPeriodsMask(recurringPeriods);
  if (enableCardRecurring && !allow2 && !allow4) {
    const err = new Error('啟用定期定額時請至少勾選 2 期或 4 期');
    err.statusCode = 400;
    throw err;
  }

  let recurringAmount = current?.recurringAmount ?? null;
  if (body.recurringAmount !== undefined) {
    const v = parseFloat(body.recurringAmount);
    recurringAmount = Number.isFinite(v) && v > 0 ? v : null;
  }
  if (!enableCardRecurring || !allow2) recurringAmount = null;

  let recurringAmount4 = current?.recurringAmount4 ?? null;
  if (body.recurringAmount4 !== undefined) {
    const v = parseFloat(body.recurringAmount4);
    recurringAmount4 = Number.isFinite(v) && v > 0 ? v : null;
  } else if (
    enableCardRecurring &&
    allow4 &&
    !allow2 &&
    body.recurringAmount !== undefined &&
    (current?.recurringAmount4 == null)
  ) {
    // 相容舊客戶端：僅 4 期時仍把第1~3期金額放在 recurringAmount
    const v = parseFloat(body.recurringAmount);
    if (Number.isFinite(v) && v > 0) recurringAmount4 = v;
  }
  // 舊資料：僅 4 期時曾把第1~3期金額存在 recurringAmount
  if (
    enableCardRecurring &&
    allow4 &&
    recurringAmount4 == null &&
    Number.isFinite(Number(current?.recurringAmount4)) &&
    Number(current.recurringAmount4) > 0
  ) {
    recurringAmount4 = Number(current.recurringAmount4);
  } else if (
    enableCardRecurring &&
    allow4 &&
    !allow2 &&
    recurringAmount4 == null &&
    body.recurringAmount4 === undefined &&
    Number.isFinite(Number(current?.recurringAmount)) &&
    Number(current.recurringAmount) > 0
  ) {
    recurringAmount4 = Number(current.recurringAmount);
  }
  if (!enableCardRecurring || !allow4) recurringAmount4 = null;

  let recurringAmountFinal = current?.recurringAmountFinal ?? null;
  if (body.recurringAmountFinal !== undefined) {
    const v = parseFloat(body.recurringAmountFinal);
    recurringAmountFinal = Number.isFinite(v) && v > 0 ? v : null;
  }
  if (!enableCardRecurring || !allow4) recurringAmountFinal = null;

  if (enableCardRecurring && allow2 && (recurringAmount == null || recurringAmount <= 0)) {
    const err = new Error('勾選 2 期時請填寫第2期扣款金額（recurringAmount）');
    err.statusCode = 400;
    throw err;
  }
  if (enableCardRecurring && allow4) {
    if (recurringAmount4 == null || recurringAmount4 <= 0) {
      const err = new Error('勾選 4 期時請填寫第1~3期扣款金額（recurringAmount4）');
      err.statusCode = 400;
      throw err;
    }
    if (recurringAmountFinal == null || recurringAmountFinal <= 0) {
      const err = new Error('勾選 4 期時請填寫第4期扣款金額（recurringAmountFinal）');
      err.statusCode = 400;
      throw err;
    }
  }

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

  let giftQty = current?.giftQty ?? null;
  if (body.giftQty !== undefined) {
    if (body.giftQty === null || body.giftQty === '' || body.giftQty === 0) {
      giftQty = null;
    } else {
      const n = parseInt(body.giftQty, 10);
      giftQty = Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  if (!giftLabel) giftQty = null;

  let dropInPrice = current?.dropInPrice ?? null;
  if (body.dropInPrice !== undefined) {
    if (body.dropInPrice === null || body.dropInPrice === '' || Number(body.dropInPrice) === 0) {
      dropInPrice = null;
    } else {
      const v = parseFloat(body.dropInPrice);
      if (!Number.isFinite(v) || v < 0) {
        const err = new Error('dropInPrice（單堂價）必須為正數或留空');
        err.statusCode = 400;
        throw err;
      }
      dropInPrice = v;
    }
  }
  let minEnrollment = current?.minEnrollment ?? null;
  if (body.minEnrollment !== undefined) {
    if (body.minEnrollment === null || body.minEnrollment === '' || Number(body.minEnrollment) === 0) {
      minEnrollment = null;
    } else {
      minEnrollment = parsePositiveInt(body.minEnrollment, 'minEnrollment');
    }
  }
  if (planType === 'GROUP') {
    if (enableCardRecurring) {
      const err = new Error('團體課程（付費期班）不支援定期定額');
      err.statusCode = 400;
      throw err;
    }
    if (minEnrollment && capacity && minEnrollment > capacity) {
      const err = new Error('最低開班人數不可大於人數上限');
      err.statusCode = 400;
      throw err;
    }
  } else {
    dropInPrice = null;
    minEnrollment = null;
  }

  return {
    kind,
    planType,
    price: parsedPrice,
    sessions,
    capacity,
    dropInPrice,
    minEnrollment,
    description,
    enableCardRecurring,
    recurringPeriods,
    recurringAmount,
    recurringAmount4,
    recurringAmountFinal,
    payuniPeriodHash: (() => {
      if (!enableCardRecurring) return null;
      const raw =
        body.payuniPeriodHash !== undefined
          ? body.payuniPeriodHash
          : current?.payuniPeriodHash;
      const s = raw == null ? '' : String(raw).trim();
      return s || null;
    })(),
    payuniPeriodHashOnline: (() => {
      if (!enableCardRecurring) return null;
      const raw =
        body.payuniPeriodHashOnline !== undefined
          ? body.payuniPeriodHashOnline
          : current?.payuniPeriodHashOnline;
      const s = raw == null ? '' : String(raw).trim();
      return s || null;
    })(),
    requiresMemberContract,
    enableSecondPerson,
    giftLabel,
    giftQty,
  };
}

/** 第二人現場加購（不計入結帳應付） */
export const SECOND_PERSON_ON_SITE_LABEL = '課程第二人+$500(課程當日現場支付)';
export const SECOND_PERSON_ON_SITE_FEE = 500;

export { normalizePlanMode, resolvePromotionSchedule as resolveCoursePlanSchedule, parseOptionalDate };

export function isCoursePlanSellable(plan, now = new Date()) {
  if (!plan || !plan.isActive) return false;
  if (isCompensationCoursePlan(plan)) return false;
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

/**
 * 依方案可選期數與選定 periodTimes，算出首期／續扣／最末期金額
 * @returns {{ periodTimes: 2|4, firstAmount: number, recurringAmount: number, amountFinal: number|null }}
 */
export function resolveCourseRecurringSchedule(plan, periodTimesRaw) {
  if (!plan?.enableCardRecurring) {
    const err = new Error('此課程方案未啟用定期定額');
    err.statusCode = 400;
    throw err;
  }
  const { allow2, allow4 } = decodeRecurringPeriodsMask(plan.recurringPeriods);
  if (!allow2 && !allow4) {
    const err = new Error('此課程方案未設定可選期數（2／4）');
    err.statusCode = 400;
    throw err;
  }

  const price = Number(plan.price) || 0;
  const requested = parseInt(periodTimesRaw, 10);
  let periodTimes = requested;
  if (!Number.isInteger(periodTimes) || periodTimes <= 0) {
    periodTimes = allow2 ? 2 : 4;
  }
  if (periodTimes === 2 && !allow2) {
    const err = new Error('此課程方案未開放 2 期定期定額');
    err.statusCode = 400;
    throw err;
  }
  if (periodTimes === 4 && !allow4) {
    const err = new Error('此課程方案未開放 4 期定期定額');
    err.statusCode = 400;
    throw err;
  }
  if (periodTimes !== 2 && periodTimes !== 4) {
    const err = new Error('課程定期定額僅支援 2 或 4 期');
    err.statusCode = 400;
    throw err;
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  if (periodTimes === 2) {
    const second = Number(plan.recurringAmount);
    if (!Number.isFinite(second) || second <= 0) {
      const err = new Error('課程 2 期方案缺少第2期金額');
      err.statusCode = 400;
      throw err;
    }
    const first = round2(price - second);
    if (!(first > 0)) {
      const err = new Error('課程 2 期第1期金額無效（總售價須大於第2期）');
      err.statusCode = 400;
      throw err;
    }
    return {
      periodTimes: 2,
      firstAmount: first,
      recurringAmount: round2(second),
      amountFinal: null,
    };
  }

  const base =
    plan.recurringAmount4 != null && Number(plan.recurringAmount4) > 0
      ? Number(plan.recurringAmount4)
      : !allow2 && plan.recurringAmount != null
        ? Number(plan.recurringAmount)
        : NaN;
  const finalAmt = Number(plan.recurringAmountFinal);
  if (!Number.isFinite(base) || base <= 0) {
    const err = new Error('課程 4 期方案缺少第1~3期金額');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(finalAmt) || finalAmt <= 0) {
    const err = new Error('課程 4 期方案缺少第4期金額');
    err.statusCode = 400;
    throw err;
  }
  return {
    periodTimes: 4,
    firstAmount: round2(base),
    recurringAmount: round2(base),
    amountFinal: round2(finalAmt),
  };
}

/** 私教／櫃檯：只顯示當下可購買的課程方案（排除客訴補償） */
export function coursePlanSellablePrismaWhere(base = {}) {
  const now = new Date();
  return {
    ...base,
    isActive: true,
    kind: 'SALE',
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
