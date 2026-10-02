// lib/walletMutation.js — 會員雙錢包唯一異動入口（其他檔案禁止寫 Member.cashWallet／bonusWallet）
// 同一交易內：SELECT … FOR UPDATE 鎖會員列 → 條件式 UPDATE … RETURNING（SQL 端 ROUND 2 位，禁止 Node 覆寫餘額）→ 寫 WalletLedger（雙錢包前後水位）
// 金額以元計、至多 2 位小數（門禁 1.3 元／分）；DB CHECK：Member 錢包 ≥ 0、流水 before＋delta＝after（容差 < 0.005）。

export const WALLET_TX = Object.freeze({
  /** 儲值入帳（本金＋贈送運動金） */
  TOPUP_GRANT: 'TOPUP_GRANT',
  /** 零錢包付款（POS／合併結帳／臨櫃購案折抵；僅本金，運動金不可折抵） */
  WALLET_PAY: 'WALLET_PAY',
  /** 待付款（乙禾／PayUNi／LINE Pay）失敗或作廢，退回預扣零錢包 */
  POS_PENDING_ABORT_RESTORE: 'POS_PENDING_ABORT_RESTORE',
  /** 門禁出場計時扣款（先運動金後本金） */
  GATE_CHECKOUT: 'GATE_CHECKOUT',
  /** 門禁紀錄取消退回出場費 */
  GATE_FEE_REFUND: 'GATE_FEE_REFUND',
  /** 計時儲值原單取消扣回 */
  TOPUP_VOID: 'TOPUP_VOID',
  /** 子單退費回收儲值本金／運動金 */
  REFUND_REVERSE: 'REFUND_REVERSE',
  /** 退費退回零錢包 */
  REFUND_CREDIT: 'REFUND_CREDIT',
  /** 退費中止沖回 */
  REFUND_ABORT: 'REFUND_ABORT',
  /** 團課退費退回零錢包 */
  GROUP_REFUND: 'GROUP_REFUND',
  /** 總部客訴補償（運動金） */
  HQ_COMPENSATION: 'HQ_COMPENSATION',
  /** 禮物卡兌換（本金） */
  GIFT_CARD_REDEEM: 'GIFT_CARD_REDEEM',
});

/** 舊版待付款回補類別（僅讀取流水時相容） */
const LEGACY_RESTORE_CODES = ['WALLET_PAY_RESTORE'];

export const WALLET_MODE = Object.freeze({
  /** 門禁出場專用：先扣運動金，不足才扣本金；總額不足整筆拒絕（不部分扣款） */
  WATERFALL_DEDUCT: 'WATERFALL_DEDUCT',
  /** 零錢包付款：僅扣本金，嚴禁動用運動金 */
  CASH_ONLY_DEDUCT: 'CASH_ONLY_DEDUCT',
  /** 指定兩錢包各扣定額（儲值取消、退費回收、中止沖回）；任一不足即拒絕 */
  EXACT_BUCKETS_DEDUCT: 'EXACT_BUCKETS_DEDUCT',
  /** 入帳：cashDelta ≥ 0、bonusDelta ≥ 0 */
  CREDIT_BUCKETS: 'CREDIT_BUCKETS',
});

const TX_TYPES = new Set(Object.values(WALLET_TX));
const MODES = new Set(Object.values(WALLET_MODE));

const DEFAULT_INSUFFICIENT = {
  WATERFALL_DEDUCT: { statusCode: 409, code: 'WALLET_INSUFFICIENT' },
  CASH_ONLY_DEDUCT: { statusCode: 400, code: 'WALLET_CASH_INSUFFICIENT' },
  EXACT_BUCKETS_DEDUCT: { statusCode: 409, code: 'WALLET_INSUFFICIENT_FOR_VOID' },
  CREDIT_BUCKETS: { statusCode: 409, code: 'WALLET_INSUFFICIENT' },
};

function walletError(statusCode, code, message, data = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (data) err.data = data;
  return err;
}

export const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

function nonNegativeAmount(raw, label) {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) throw walletError(400, 'WALLET_AMOUNT_INVALID', `${label}金額無效`);
  return roundMoney(n);
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx 必須為 prisma.$transaction 之交易 client
 * @param {object} p
 * @param {number} p.memberId
 * @param {string} p.txType WALLET_TX.*
 * @param {string} p.mode WALLET_MODE.*
 *   WATERFALL_DEDUCT { amount }｜CASH_ONLY_DEDUCT { amount }｜EXACT_BUCKETS_DEDUCT { cashDeduct, bonusDeduct }｜CREDIT_BUCKETS { cashDelta, bonusDelta }
 * @param {string} p.reason 必填
 * @param {{ statusCode?: number, code?: string, message?: string | ((avail: {cash:number,bonus:number}) => string) }} [p.insufficient]
 * @returns {Promise<{ changed: boolean, before: {cash:number,bonus:number}, after: {cash:number,bonus:number}, delta: {cash:number,bonus:number}, ledgerId: number|null }>}
 */
export async function mutateMemberWallet(tx, p) {
  if (!tx || typeof tx.$connect === 'function') {
    throw new Error('mutateMemberWallet 必須在 prisma.$transaction 內呼叫');
  }
  const memberId = Number(p.memberId);
  if (!Number.isInteger(memberId) || memberId <= 0) throw walletError(400, 'MEMBER_REQUIRED', '錢包異動缺少會員');
  if (!TX_TYPES.has(p.txType)) throw new Error(`未知的錢包異動類別：${p.txType}`);
  if (!MODES.has(p.mode)) throw new Error(`未知的錢包異動模式：${p.mode}`);
  const reason = String(p.reason || '').trim().slice(0, 200);
  if (!reason) throw new Error('錢包異動必須填寫 reason');

  const locked = await tx.$queryRaw`
    SELECT ROUND("cashWallet"::numeric, 2)::float8 AS cash, ROUND("bonusWallet"::numeric, 2)::float8 AS bonus
    FROM "Member" WHERE id = ${memberId} FOR UPDATE
  `;
  if (!locked.length) throw walletError(404, 'MEMBER_NOT_FOUND', '找不到會員');
  const availCash = Number(locked[0].cash) || 0;
  const availBonus = Number(locked[0].bonus) || 0;

  const insufficient = (data) => {
    const def = DEFAULT_INSUFFICIENT[p.mode];
    const msg = p.insufficient?.message;
    return walletError(
      p.insufficient?.statusCode ?? def.statusCode,
      p.insufficient?.code ?? def.code,
      typeof msg === 'function'
        ? msg({ cash: availCash, bonus: availBonus })
        : msg ?? `錢包餘額不足（本金 $${availCash}／運動金 $${availBonus}）`,
      data,
    );
  };

  let dCash;
  let dBonus;
  if (p.mode === WALLET_MODE.CREDIT_BUCKETS) {
    dCash = nonNegativeAmount(p.cashDelta, '入帳本金');
    dBonus = nonNegativeAmount(p.bonusDelta, '入帳運動金');
  } else if (p.mode === WALLET_MODE.EXACT_BUCKETS_DEDUCT) {
    const cash = nonNegativeAmount(p.cashDeduct, '扣回本金');
    const bonus = nonNegativeAmount(p.bonusDeduct, '扣回運動金');
    if (cash > availCash || bonus > availBonus) {
      throw insufficient({ cash: availCash, bonus: availBonus, cashDeduct: cash, bonusDeduct: bonus });
    }
    dCash = -cash;
    dBonus = -bonus;
  } else if (p.mode === WALLET_MODE.CASH_ONLY_DEDUCT) {
    const amount = nonNegativeAmount(p.amount, '扣款');
    if (amount > availCash) throw insufficient({ cash: availCash, bonus: availBonus, amount });
    dCash = -amount;
    dBonus = 0;
  } else {
    const amount = nonNegativeAmount(p.amount, '扣款');
    if (amount > roundMoney(availCash + availBonus)) {
      throw insufficient({ cash: availCash, bonus: availBonus, amount, shortfall: roundMoney(amount - availCash - availBonus) });
    }
    const fromBonus = Math.min(availBonus, amount);
    dBonus = -fromBonus;
    dCash = -roundMoney(amount - fromBonus);
  }
  dCash = roundMoney(dCash) || 0;
  dBonus = roundMoney(dBonus) || 0;

  const before = { cash: availCash, bonus: availBonus };
  if (dCash === 0 && dBonus === 0) {
    return { changed: false, before, after: before, delta: { cash: 0, bonus: 0 }, ledgerId: null };
  }

  const cashDeduct = Math.max(0, -dCash);
  const bonusDeduct = Math.max(0, -dBonus);
  const rows = await tx.$queryRaw`
    UPDATE "Member"
    SET "cashWallet" = ROUND(("cashWallet" + ${dCash}::float8)::numeric, 2)::double precision,
        "bonusWallet" = ROUND(("bonusWallet" + ${dBonus}::float8)::numeric, 2)::double precision
    WHERE id = ${memberId}
      AND ROUND("cashWallet"::numeric, 2) >= ${cashDeduct}::numeric
      AND ROUND("bonusWallet"::numeric, 2) >= ${bonusDeduct}::numeric
    RETURNING "cashWallet", "bonusWallet"
  `;
  if (!rows.length) throw insufficient({ cash: availCash, bonus: availBonus });
  const after = { cash: Number(rows[0].cashWallet), bonus: Number(rows[0].bonusWallet) };

  const ledger = await tx.walletLedger.create({
    data: {
      memberId,
      reasonCode: p.txType,
      branchId: Number.isInteger(p.branchId) ? p.branchId : null,
      cashBefore: availCash,
      cashDelta: dCash,
      cashAfter: after.cash,
      bonusBefore: availBonus,
      bonusDelta: dBonus,
      bonusAfter: after.bonus,
      reason,
      refType: p.refType ?? null,
      refId: p.refId != null ? String(p.refId) : null,
      refundId: p.refundId ?? null,
      staffId: Number.isInteger(p.staffId) ? p.staffId : null,
    },
    select: { id: true },
  });

  return { changed: true, before, after, delta: { cash: dCash, bonus: dBonus }, ledgerId: ledger.id };
}

/** 零錢包付款（僅本金）；不足 400 WALLET_CASH_INSUFFICIENT */
export function payWithCashWallet(tx, { memberId, amount, refType, refId, staffId, branchId, reason }) {
  return mutateMemberWallet(tx, {
    memberId,
    txType: WALLET_TX.WALLET_PAY,
    mode: WALLET_MODE.CASH_ONLY_DEDUCT,
    amount,
    reason: reason || `零錢包付款 ${refId ?? ''}`.trim(),
    refType,
    refId,
    staffId,
    branchId,
    insufficient: {
      message: ({ cash }) => `零錢包（本金）不足（餘額 $${cash}，應付 $${roundMoney(amount)}）；運動金不可折抵`,
    },
  });
}

/**
 * 待付款失敗／作廢：退回該單仍預扣之零錢包（冪等）。
 * 先鎖會員列，再以同 refType／refId 之 WALLET_PAY − 已退回 計算淨額；淨額 0 不寫流水。
 * 無任何付款流水之舊單才採 fallbackAmount（如 payBreakdown.WALLET_CASH）。
 * @returns {Promise<{ restored: number, after: {cash:number,bonus:number}|null }>}
 */
export async function restoreHeldCashWallet(tx, { memberId, refType, refId, fallbackAmount = 0, staffId, branchId, reason }) {
  const mid = Number(memberId);
  if (!Number.isInteger(mid) || mid <= 0) return { restored: 0, after: null };
  await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${mid} FOR UPDATE`;
  const rows = await tx.walletLedger.findMany({
    where: {
      memberId: mid,
      refType,
      refId: String(refId),
      reasonCode: { in: [WALLET_TX.WALLET_PAY, WALLET_TX.POS_PENDING_ABORT_RESTORE, ...LEGACY_RESTORE_CODES] },
      cashBefore: { not: null },
    },
    select: { cashDelta: true },
  });
  const held = rows.length
    ? roundMoney(-rows.reduce((s, r) => s + (Number(r.cashDelta) || 0), 0))
    : roundMoney(fallbackAmount);
  if (held <= 0) return { restored: 0, after: null };
  const r = await mutateMemberWallet(tx, {
    memberId: mid,
    txType: WALLET_TX.POS_PENDING_ABORT_RESTORE,
    mode: WALLET_MODE.CREDIT_BUCKETS,
    cashDelta: held,
    bonusDelta: 0,
    reason: reason || `待付款取消退回零錢包 ${refId}`,
    refType,
    refId,
    staffId,
    branchId,
  });
  return { restored: held, after: r.after };
}
