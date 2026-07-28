// lib/compositePay.js — 複合付款：多選方式 + 金額分攤 + 抵用券條碼

export const POS_PAY_METHODS = ['CASH', 'CARD', 'WALLET_CASH', 'VOUCHER'];
export const TOPUP_PAY_METHODS = ['CASH', 'CARD', 'WALLET_CASH', 'VOUCHER'];
export const CHECKOUT_PAY_METHODS = ['CASH', 'CARD', 'WALLET_CASH', 'VOUCHER'];

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * 解析並驗證複合付款
 * @param {unknown} payments - [{ method, amount, voucherCode? }]
 * @param {number} totalAmount - 後端權威應付總額
 * @param {{ allowed: string[], requireMember?: boolean }} opts
 */
export function parseCompositePayments(payments, totalAmount, opts = {}) {
  const allowed = opts.allowed || POS_PAY_METHODS;
  const expected = roundMoney(totalAmount);

  if (!Array.isArray(payments) || payments.length === 0) {
    const err = new Error('請至少選擇一種付款方式（payments）');
    err.statusCode = 400;
    throw err;
  }

  const seen = new Set();
  const lines = [];

  for (const row of payments) {
    const method = String(row?.method || '').toUpperCase();
    if (!allowed.includes(method)) {
      const err = new Error(`不支援的付款方式：${method}`);
      err.statusCode = 400;
      throw err;
    }
    if (seen.has(method)) {
      const err = new Error(`付款方式 ${method} 不可重複`);
      err.statusCode = 400;
      throw err;
    }
    seen.add(method);

    const amount = roundMoney(row?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error(`${method} 分攤金額必須為正數`);
      err.statusCode = 400;
      throw err;
    }

    let voucherCode = null;
    if (method === 'VOUCHER') {
      const raw = String(row?.voucherCode || '').trim();
      if (!raw) {
        const err = new Error('抵用券必須提供條碼 voucherCode');
        err.statusCode = 400;
        throw err;
      }
      voucherCode = raw.toUpperCase();
    }

    lines.push({ method, amount, voucherCode });
  }

  const sum = roundMoney(lines.reduce((s, l) => s + l.amount, 0));
  if (Math.abs(sum - expected) > 0.009) {
    const err = new Error(`付款分攤合計 $${sum} 必須等於應付 $${expected}`);
    err.statusCode = 400;
    throw err;
  }

  const methods = lines.map((l) => l.method);
  const breakdown = {};
  for (const l of lines) breakdown[l.method] = l.amount;

  const voucherLine = lines.find((l) => l.method === 'VOUCHER');
  const walletAmount = breakdown.WALLET_CASH || 0;
  const cardAmount = breakdown.CARD || 0;
  const needsMember = walletAmount > 0 || Boolean(opts.requireMember);

  return {
    methods,
    payMethodLabel: methods.join('+'),
    breakdown,
    lines,
    voucherCode: voucherLine?.voucherCode || null,
    voucherAmount: voucherLine?.amount || 0,
    walletAmount,
    cardAmount,
    cashAmount: breakdown.CASH || 0,
    needsCard: cardAmount > 0,
    needsMember,
  };
}

/** 相容舊版單一 payMethod */
export function coercePaymentsFromBody(body, totalAmount, allowed) {
  if (Array.isArray(body.payments) && body.payments.length > 0) {
    return parseCompositePayments(body.payments, totalAmount, { allowed });
  }

  // 舊版：單一 payMethod → 全額該方式
  const method = String(body.payMethod || '').toUpperCase();
  if (!method) {
    const err = new Error('請提供 payments（複合付款）或 payMethod');
    err.statusCode = 400;
    throw err;
  }
  return parseCompositePayments(
    [{ method, amount: totalAmount, voucherCode: body.voucherCode }],
    totalAmount,
    { allowed },
  );
}
