// lib/promotion.js — 儲值方案類型／模式與檔期判斷、購案入帳

export const UNLIMITED_MEMBER_PLAN = '無限會員';

/** SALE＝可售｜COMPENSATION＝客訴補償專案（禁銷售通路） */
export const PROMOTION_KINDS = ['SALE', 'COMPENSATION'];

export function normalizePromotionKind(value) {
  const raw = String(value || 'SALE').trim().toUpperCase();
  if (raw === 'COMPENSATION' || raw === 'TYPE_COMPENSATION' || raw === 'COMP') {
    return 'COMPENSATION';
  }
  return 'SALE';
}

export function isCompensationPromotion(promotion) {
  return normalizePromotionKind(promotion?.kind) === 'COMPENSATION';
}

export function normalizeUsageType(value) {
  return value === 'UNLIMITED' ? 'UNLIMITED' : 'TIMED';
}

export function isUnlimitedPromotion(promotion) {
  return normalizeUsageType(promotion?.usageType) === 'UNLIMITED';
}

/** STANDING=長註（無檔期下架） · CAMPAIGN=活動（可設上下架時間） */
export function normalizePlanMode(value) {
  return value === 'CAMPAIGN' ? 'CAMPAIGN' : 'STANDING';
}

export function parseOptionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`${fieldName} 格式無效`);
    err.statusCode = 400;
    throw err;
  }
  return d;
}

export function parsePositiveInt(value, fieldName) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${fieldName} 必須為正整數`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

export function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return Boolean(value);
}

export function resolvePromotionSchedule({ planMode, saleStartAt, saleEndAt }) {
  const mode = normalizePlanMode(planMode);
  if (mode === 'STANDING') {
    return { saleStartAt: null, saleEndAt: null };
  }

  const start = parseOptionalDate(saleStartAt, 'saleStartAt');
  const end = parseOptionalDate(saleEndAt, 'saleEndAt');

  if (start && end && end <= start) {
    const err = new Error('活動下架時間必須晚於上架時間');
    err.statusCode = 400;
    throw err;
  }

  return { saleStartAt: start, saleEndAt: end };
}

/**
 * 驗證並正規化 HQ 建立／更新方案欄位
 */
export function resolvePromotionFields(body, { partial = false, current = null } = {}) {
  const kind = normalizePromotionKind(
    body.kind !== undefined ? body.kind : body.type !== undefined ? body.type : current?.kind,
  );
  const usageType = normalizeUsageType(
    body.usageType !== undefined ? body.usageType : current?.usageType,
  );

  if (kind === 'COMPENSATION') {
    if (usageType === 'UNLIMITED') {
      const err = new Error('客訴補償專案僅限分鐘計費（TIMED），不可為無限使用');
      err.statusCode = 400;
      throw err;
    }
    const priceRaw = body.price !== undefined ? body.price : current?.price;
    const parsedPrice = parseFloat(priceRaw);
    if (Number.isNaN(parsedPrice) || parsedPrice !== 0) {
      const err = new Error('客訴補償專案 price 必須為 0（禁止自填補償現金）');
      err.statusCode = 400;
      throw err;
    }
    const bonusRaw = body.bonusGiven !== undefined ? body.bonusGiven : current?.bonusGiven;
    const parsedBonus = parseFloat(bonusRaw);
    if (Number.isNaN(parsedBonus) || parsedBonus <= 0) {
      const err = new Error('客訴補償專案必須設定 bonusGiven（運動金）且大於 0');
      err.statusCode = 400;
      throw err;
    }
    for (const key of ['durationDays', 'unitDays', 'periodCount']) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
        const err = new Error(`客訴補償專案不可設定 ${key}`);
        err.statusCode = 400;
        throw err;
      }
    }
    if (
      parseBooleanFlag(
        body.enableCardRecurring !== undefined
          ? body.enableCardRecurring
          : current?.enableCardRecurring,
        false,
      )
    ) {
      const err = new Error('客訴補償專案不可啟用定期定額');
      err.statusCode = 400;
      throw err;
    }
    return {
      kind,
      usageType: 'TIMED',
      price: 0,
      bonusGiven: parsedBonus,
      unitDays: null,
      periodCount: null,
      durationDays: null,
      requiresMemberContract: false,
      enableCardRecurring: false,
      recurringAmount: null,
      payuniPeriodHash: null,
      payuniPeriodHashOnline: null,
    };
  }

  const priceRaw = body.price !== undefined ? body.price : current?.price;
  const parsedPrice = parseFloat(priceRaw);
  if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
    const err = new Error('price 必須為非負數');
    err.statusCode = 400;
    throw err;
  }

  let unitDays = null;
  let periodCount = null;
  let durationDays = null;
  let bonusGiven = 0;
  let requiresMemberContract = parseBooleanFlag(
    body.requiresMemberContract !== undefined
      ? body.requiresMemberContract
      : current?.requiresMemberContract,
    false,
  );
  let enableCardRecurring = parseBooleanFlag(
    body.enableCardRecurring !== undefined ? body.enableCardRecurring : current?.enableCardRecurring,
    false,
  );

  if (usageType === 'UNLIMITED') {
    const unitRaw = body.unitDays !== undefined ? body.unitDays : current?.unitDays;
    const periodRaw = body.periodCount !== undefined ? body.periodCount : current?.periodCount;
    const unitMissing = unitRaw === undefined || unitRaw === null || unitRaw === '';
    const periodMissing = periodRaw === undefined || periodRaw === null || periodRaw === '';

    if (unitMissing && periodMissing) {
      // 相容舊 payload／舊資料：只給 durationDays → 視為「天數 × 1 期」
      const daysRaw =
        body.durationDays !== undefined ? body.durationDays : current?.durationDays;
      if (daysRaw === undefined || daysRaw === null || daysRaw === '') {
        const err = new Error('無限使用方案必須設定天數 unitDays 與期數 periodCount');
        err.statusCode = 400;
        throw err;
      }
      unitDays = parsePositiveInt(daysRaw, 'durationDays');
      periodCount = 1;
    } else {
      if (unitMissing) {
        const err = new Error('無限使用方案必須設定每期天數 unitDays');
        err.statusCode = 400;
        throw err;
      }
      if (periodMissing) {
        const err = new Error('無限使用方案必須設定期數 periodCount');
        err.statusCode = 400;
        throw err;
      }
      unitDays = parsePositiveInt(unitRaw, 'unitDays');
      periodCount = parsePositiveInt(periodRaw, 'periodCount');
    }
    durationDays = unitDays * periodCount;
    bonusGiven = 0;
  } else {
    for (const key of ['durationDays', 'unitDays', 'periodCount']) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
        const err = new Error(`分鐘計費方案不可設定 ${key}`);
        err.statusCode = 400;
        throw err;
      }
    }
    const bonusRaw = body.bonusGiven !== undefined ? body.bonusGiven : current?.bonusGiven;
    if (bonusRaw === undefined || bonusRaw === null) {
      if (!partial) {
        const err = new Error('分鐘計費方案必須提供 bonusGiven');
        err.statusCode = 400;
        throw err;
      }
    } else {
      const parsedBonus = parseFloat(bonusRaw);
      if (Number.isNaN(parsedBonus) || parsedBonus < 0) {
        const err = new Error('bonusGiven 必須為非負數');
        err.statusCode = 400;
        throw err;
      }
      bonusGiven = parsedBonus;
    }
  }

  // 儲值定期定額：首期＝price；後續扣款＝recurringAmount（可與首期不同）；總期數＝periodCount
  let recurringAmount = null;
  if (enableCardRecurring) {
    if (usageType !== 'UNLIMITED' || !periodCount || periodCount <= 0) {
      const err = new Error('啟用定期定額僅限「無限使用」方案，且必須設定有效期期數（periodCount）');
      err.statusCode = 400;
      throw err;
    }
    const raw =
      body.recurringAmount !== undefined ? body.recurringAmount : current?.recurringAmount;
    if (raw === undefined || raw === null || raw === '') {
      const err = new Error(
        '啟用定期定額時必須填寫後續扣款金額 recurringAmount（可與首期方案費用不同）',
      );
      err.statusCode = 400;
      throw err;
    }
    const parsedRecurring = parseFloat(raw);
    if (!Number.isFinite(parsedRecurring) || parsedRecurring <= 0) {
      const err = new Error('定期定額扣款金額必須為正數');
      err.statusCode = 400;
      throw err;
    }
    recurringAmount = Math.round(parsedRecurring * 100) / 100;
  }

  return {
    kind,
    usageType,
    price: parsedPrice,
    bonusGiven,
    unitDays,
    periodCount,
    durationDays,
    requiresMemberContract,
    enableCardRecurring,
    recurringAmount,
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
  };
}

/**
 * 儲值定期定額後續扣款金額：方案設定優先；舊資料未填則回退首期 price
 * @returns {number|null}
 */
export function resolvePromotionRecurringAmount(promotion) {
  const stored = Number(promotion?.recurringAmount);
  if (Number.isFinite(stored) && stored > 0) {
    return Math.round(stored * 100) / 100;
  }
  const price = Number(promotion?.price);
  if (Number.isFinite(price) && price > 0) {
    return Math.round(price * 100) / 100;
  }
  return null;
}

export function isPromotionSellable(promotion, now = new Date()) {
  if (!promotion?.isActive) return false;
  if (isCompensationPromotion(promotion)) return false;

  if (normalizePlanMode(promotion.planMode) === 'STANDING') {
    return true;
  }

  const start = promotion.saleStartAt ? new Date(promotion.saleStartAt) : null;
  const end = promotion.saleEndAt ? new Date(promotion.saleEndAt) : null;

  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

export function assertPromotionSellable(promotion) {
  if (!promotion) {
    const err = new Error('找不到此促銷方案');
    err.statusCode = 404;
    throw err;
  }
  if (!isPromotionSellable(promotion)) {
    const err = new Error(`⛔ 方案 [${promotion.name}] 目前不在可購買檔期`);
    err.statusCode = 400;
    throw err;
  }
}

/** 櫃檯／會員端：只顯示當下可購買的方案（排除客訴補償專案） */
export function promotionSellablePrismaWhere(base = {}) {
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

export function computeMemberExpireDate(currentExpireDate, durationDays, now = new Date()) {
  const days = parsePositiveInt(durationDays, 'durationDays');
  const base =
    currentExpireDate && new Date(currentExpireDate) > now
      ? new Date(currentExpireDate)
      : new Date(now);
  // 起始日算第 1 天：以 base 當日 00:00 起算，第 days 天 23:59:59.999 截止
  // 例：9/7 買 30 天 → 效期至 10/6 結束（含購日共 30 個日曆日）
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const expire = new Date(start);
  expire.setDate(expire.getDate() + days - 1);
  expire.setHours(23, 59, 59, 999);
  return expire;
}

/** 自某日起算，效期還剩幾整天（已過期回 0） */
export function remainingExpireDays(expireDate, now = new Date()) {
  if (!expireDate) return 0;
  const end = new Date(expireDate);
  const diffMs = end.getTime() - new Date(now).getTime();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/** 將 Date 加減整天數（回傳新 Date） */
export function shiftDateByDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

/**
 * 截斷效期至 now；若已無剩餘無限天數則降為計時會員
 * @returns {{ expireDate: Date|null, plan: string, unusedDays: number }}
 */
export function buildCutExpireNow(member, now = new Date()) {
  const unusedDays = remainingExpireDays(member?.expireDate, now);
  return {
    expireDate: null,
    plan: '計時會員',
    unusedDays,
  };
}

export function buildTopupItemDesc(promotion, channel = '臨櫃', qty = 1) {
  const units = Math.max(1, parseInt(qty, 10) || 1);
  if (isUnlimitedPromotion(promotion)) {
    return `${channel}購案 | ${promotion.name} | UNLIMITED | 天數+${promotion.durationDays} | 方案費$${promotion.price} | 商品#${promotion.id}`;
  }
  const cashTotal = promotion.price * units;
  const bonusTotal = promotion.bonusGiven * units;
  const qtyPart = units > 1 ? ` ×${units}` : '';
  return `${channel}儲值 | ${promotion.name}${qtyPart} | TIMED | 現金+${cashTotal} / 運動金+${bonusTotal} | 商品#${promotion.id}`;
}

/** 從訂單 itemDesc 還原購買份數（刷卡 Webhook 入帳用） */
export function parseTopupQtyFromItemDesc(itemDesc) {
  const qtyMatch = String(itemDesc || '').match(/×(\d+)/);
  if (qtyMatch) {
    const n = parseInt(qtyMatch[1], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 1;
}

export function computeTopupAmount(promotion, qty = 1) {
  if (isUnlimitedPromotion(promotion)) return promotion.price;
  const units = Math.max(1, parseInt(qty, 10) || 1);
  return promotion.price * units;
}

export function isUnlimitedTopupOrder(itemDesc) {
  return String(itemDesc || '').includes('| UNLIMITED |');
}

/**
 * 購案入帳（須在 transaction 內）
 * - TIMED：本金＋運動金進錢包（qty 倍）
 * - UNLIMITED：不入錢包，延長 expireDate 並設 plan（qty 固定 1）
 */
export async function fulfillPromotionPurchase(
  tx,
  memberId,
  promotion,
  { qty = 1, durationDaysOverride } = {},
) {
  const member = await tx.member.findUnique({ where: { id: memberId } });
  if (!member) {
    const err = new Error('找不到會員');
    err.statusCode = 404;
    throw err;
  }

  if (isUnlimitedPromotion(promotion)) {
    if (qty !== undefined && qty !== null && Number(qty) !== 1) {
      const err = new Error('無限使用方案不支援數量，每次僅能購買 1 份');
      err.statusCode = 400;
      throw err;
    }
    const daysToAdd =
      durationDaysOverride != null && durationDaysOverride !== ''
        ? parsePositiveInt(durationDaysOverride, 'durationDaysOverride')
        : promotion.durationDays;
    if (!daysToAdd || daysToAdd <= 0) {
      const err = new Error('無限使用方案未設定有效天數');
      err.statusCode = 500;
      throw err;
    }

    const expireDate = computeMemberExpireDate(member.expireDate, daysToAdd);
    const updatedMember = await tx.member.update({
      where: { id: memberId },
      data: {
        plan: UNLIMITED_MEMBER_PLAN,
        expireDate,
      },
    });

    return {
      updatedMember,
      fulfillment: {
        type: 'UNLIMITED',
        durationDays: daysToAdd,
        expireDate,
        plan: UNLIMITED_MEMBER_PLAN,
        qty: 1,
        amount: promotion.price,
      },
    };
  }

  const units = parseInt(qty, 10);
  if (!Number.isInteger(units) || units <= 0) {
    const err = new Error('數量 qty 必須為正整數');
    err.statusCode = 400;
    throw err;
  }

  const cashAdded = promotion.price * units;
  const bonusAdded = promotion.bonusGiven * units;

  const updatedMember = await tx.member.update({
    where: { id: memberId },
    data: {
      cashWallet: { increment: cashAdded },
      bonusWallet: { increment: bonusAdded },
    },
  });

  return {
    updatedMember,
    fulfillment: {
      type: 'TIMED',
      cashAdded,
      bonusAdded,
      qty: units,
      amount: cashAdded,
    },
  };
}

/** 定期定額電子發票品名：含「代為處理折讓」字樣（開票 ItemName 上限約 30 字） */
export function buildRecurringInvoiceItemDesc(promotionName, { periodIndex } = {}) {
  const name = String(promotionName || '月卡').replace(/\|/g, '／').trim() || '月卡';
  const period =
    periodIndex != null && Number(periodIndex) > 1 ? `續扣第${periodIndex}期` : '定期定額';
  // 法律／商務慣用字樣置前，避免被截斷時丟失
  return `代為處理折讓｜${period}｜${name}`;
}
export function resolveRecurringPeriodDays(promotion) {
  if (!isUnlimitedPromotion(promotion)) return null;
  if (promotion.unitDays && promotion.unitDays > 0) return promotion.unitDays;
  if (promotion.durationDays && promotion.durationDays > 0) return promotion.durationDays;
  return null;
}
