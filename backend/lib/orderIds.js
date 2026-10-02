// lib/orderIds.js — 儲值／購案訂單單號前綴
import { isUnlimitedPromotion } from './promotion.js';

function buildTradeNo(prefix) {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `${prefix}${dateStr}${randomStr}`;
}

/** 一般儲值／訂單：TYK… */
export function generateTopupOrderId() {
  return buildTradeNo('TYK');
}

/** 團課期班／單堂報名：GRP…（一筆報名一張訂單、一張發票） */
export function generateGroupOrderId() {
  return buildTradeNo('GRP');
}

/** 訂閱制月卡／定期定額：CRS… */
export function generateSubscriptionOrderId() {
  return buildTradeNo('CRS');
}

/**
 * 依方案／刷卡模式選單號：
 * - 一般儲值（TIMED）→ TYK…
 * - 訂閱制月卡（UNLIMITED）或定期定額（RECURRING）→ CRS…
 */
export function resolveTopupOrderId({ cardMode, promotion } = {}) {
  const recurring = String(cardMode || '').toUpperCase() === 'RECURRING';
  if (recurring || isUnlimitedPromotion(promotion)) {
    return generateSubscriptionOrderId();
  }
  return generateTopupOrderId();
}
