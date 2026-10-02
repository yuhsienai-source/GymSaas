// lib/einvoiceRules.js — 電子發票金額／明細計算（純函式，唯一定義）
// 輸入一律為「含稅成交價」整數元；B2C 明細送含稅、B2B 明細送未稅（ezPay Category 規則）
// 應稅與免稅混合時拆成兩張（避免 TaxType=9 需另行申請）

export const TAX_RATE = 5;
export const TAX_TYPE = { TAXABLE: 'TAXABLE', TAX_FREE: 'TAX_FREE' };
/** ezPay TaxType：1 應稅、3 免稅 */
export const EZPAY_TAX_TYPE = { TAXABLE: '1', TAX_FREE: '3' };

const MOBILE_CARRIER_RE = /^\/[A-Z0-9.\-+]{7}$/;

export function normalizeTaxType(raw) {
  const s = String(raw || TAX_TYPE.TAXABLE).toUpperCase();
  if (s === 'TAX_FREE' || s === 'FREE' || s === '3') return TAX_TYPE.TAX_FREE;
  return TAX_TYPE.TAXABLE;
}

function truncateChars(str, max) {
  return Array.from(String(str || '')).slice(0, max).join('');
}

export function sanitizeInvoiceItemName(raw) {
  const flat = String(raw || '商品').replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();
  return truncateChars(flat || '商品', 30);
}

/** 依權重分配整數（最大餘數法），總和恆等於 total */
export function allocateInteger(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (total * w) / sum);
  const base = raw.map((x) => Math.floor(x));
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k += 1, rest -= 1) base[order[k % order.length].i] += 1;
  return base;
}

/** 雙月期別起月 YYYYMM（台灣時間） */
export function invoicePeriodKey(date = new Date()) {
  const tw = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  const m = tw.getUTCMonth() + 1;
  const start = m % 2 === 0 ? m - 1 : m;
  return `${tw.getUTCFullYear()}${String(start).padStart(2, '0')}`;
}

/**
 * 依買受人選項判定 B2B／B2C、列印與載具
 * @param {{ buyerUbn?, carrierNum?, loveCode? }} buyer 已正規化
 */
export function resolveBuyerMode(buyer = {}) {
  const isB2B = Boolean(buyer.buyerUbn);
  const carrierNum = isB2B ? null : buyer.carrierNum || null;
  const loveCode = isB2B ? null : buyer.loveCode || null;
  return {
    category: isB2B ? 'B2B' : 'B2C',
    carrierNum,
    carrierType: carrierNum ? (MOBILE_CARRIER_RE.test(carrierNum) ? '0' : '1') : null,
    loveCode,
    printFlag: isB2B || (!carrierNum && !loveCode) ? 'Y' : 'N',
  };
}

/**
 * 單一稅別一張發票的金額與 ezPay 明細
 * @param {Array<{ name, qty, unitPrice, productId?, unit? }>} lines 含稅成交
 */
function buildOne(lines, taxType, category) {
  const totalAmount = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const taxable = taxType === TAX_TYPE.TAXABLE;
  const salesAmount = taxable ? Math.round(totalAmount / (1 + TAX_RATE / 100)) : totalAmount;
  const taxAmount = totalAmount - salesAmount;

  let items;
  if (category === 'B2B' && taxable) {
    const untaxed = allocateInteger(
      salesAmount,
      lines.map((l) => l.unitPrice * l.qty),
    );
    items = lines.map((l, i) => {
      const amt = untaxed[i];
      const divisible = l.qty > 0 && amt % l.qty === 0;
      return {
        name: sanitizeInvoiceItemName(divisible ? l.name : `${l.name}x${l.qty}`),
        qty: divisible ? l.qty : 1,
        unit: divisible ? l.unit || '個' : '式',
        unitPrice: divisible ? amt / l.qty : amt,
        amount: amt,
        productId: l.productId ?? null,
        saleItemId: l.saleItemId ?? null,
      };
    });
  } else {
    items = lines.map((l) => ({
      name: sanitizeInvoiceItemName(l.name),
      qty: l.qty,
      unit: l.unit || '個',
      unitPrice: l.unitPrice,
      amount: l.unitPrice * l.qty,
      productId: l.productId ?? null,
      saleItemId: l.saleItemId ?? null,
    }));
  }

  return {
    taxType: EZPAY_TAX_TYPE[taxType],
    taxRate: taxable ? TAX_RATE : 0,
    salesAmount,
    taxAmount,
    totalAmount,
    items: items.map((it) => ({ ...it, taxType: EZPAY_TAX_TYPE[taxType] })),
  };
}

/**
 * 依成交明細產生發票草稿（應稅／免稅各一張；金額為 0 者略過）
 * @param {{ lines: Array<{ name, qty, unitPrice, taxType?, productId?, unit? }>, buyer }} input
 * @returns {Array<{ suffix: ''|'FREE', category, carrierType, carrierNum, loveCode, printFlag, taxType, taxRate, salesAmount, taxAmount, totalAmount, items, itemDesc }>}
 */
export function computeInvoiceDrafts({ lines, buyer }) {
  const clean = (lines || [])
    .map((l) => ({
      name: String(l.name || '商品'),
      qty: Math.max(1, parseInt(l.qty, 10) || 1),
      unitPrice: Math.round(Number(l.unitPrice) || 0),
      taxType: normalizeTaxType(l.taxType),
      productId: l.productId ?? null,
      saleItemId: l.saleItemId ?? null,
      unit: l.unit || null,
    }))
    .filter((l) => l.unitPrice > 0);
  if (clean.some((l) => !Number.isInteger(l.unitPrice) || l.unitPrice < 0)) {
    const err = new Error('發票明細金額必須為正整數');
    err.statusCode = 400;
    throw err;
  }
  const mode = resolveBuyerMode(buyer);
  const groups = [
    { suffix: '', taxType: TAX_TYPE.TAXABLE },
    { suffix: 'FREE', taxType: TAX_TYPE.TAX_FREE },
  ];
  const drafts = [];
  for (const g of groups) {
    const ls = clean.filter((l) => l.taxType === g.taxType);
    if (!ls.length) continue;
    const one = buildOne(ls, g.taxType, mode.category);
    if (one.totalAmount <= 0) continue;
    drafts.push({
      suffix: g.suffix,
      ...mode,
      ...one,
      itemDesc: truncateChars(ls.map((l) => `${l.name}x${l.qty}`).join(', '), 200),
    });
  }
  return drafts;
}

/** 單一金額（購案／課程／訂閱）→ 單行含稅明細 */
export function singleLine(itemDesc, amount, taxType = TAX_TYPE.TAXABLE) {
  return [{ name: itemDesc || '服務', qty: 1, unitPrice: Math.round(Number(amount) || 0), taxType, unit: '式' }];
}

function ruleError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * 多品項折讓明細（ezPay allowance_issue：ItemPrice／ItemAmt 未稅、ItemTaxAmt 稅額）
 * 以含稅退貨金額為基準：未稅 = round(總額 / 1.05)、稅額 = 總額 − 未稅，再依各行含稅金額最大餘數分攤稅額；
 * 本次折讓用盡發票剩餘額時，改以發票剩餘未稅／稅額精準收尾（加總恆等於原發票）。
 * @param {{
 *   invoice: { taxType: string, salesAmount: number, taxAmount: number, totalAmount: number, allowanceTotal: number },
 *   prior?: { untaxed: number, tax: number },
 *   lines: Array<{ name: string, qty: number, unit?: string, gross: number, einvoiceItemId?: number|null, saleItemId?: number|null }>,
 * }} input
 */
export function buildAllowanceLines({ invoice, prior = { untaxed: 0, tax: 0 }, lines }) {
  const clean = (lines || []).map((l) => ({
    ...l,
    qty: Math.max(1, parseInt(l.qty, 10) || 1),
    gross: Math.round(Number(l.gross) || 0),
  }));
  if (!clean.length || clean.some((l) => !(l.gross > 0))) {
    throw ruleError(400, 'ALLOWANCE_AMOUNT_INVALID', '折讓品項金額必須為正整數');
  }
  const total = clean.reduce((s, l) => s + l.gross, 0);
  const remain = invoice.totalAmount - (invoice.allowanceTotal || 0);
  if (total > remain) {
    throw ruleError(409, 'ALLOWANCE_EXCEEDS_INVOICE', `折讓金額 $${total} 超過發票剩餘可折讓額 $${remain}`);
  }

  let untaxed;
  let tax;
  if (String(invoice.taxType) === EZPAY_TAX_TYPE.TAX_FREE) {
    untaxed = total;
    tax = 0;
  } else {
    untaxed = Math.round(total / (1 + TAX_RATE / 100));
    tax = total - untaxed;
    if (total === remain) {
      const restUntaxed = invoice.salesAmount - (prior.untaxed || 0);
      const restTax = invoice.taxAmount - (prior.tax || 0);
      if (restUntaxed >= 0 && restTax >= 0 && restUntaxed + restTax === total) {
        untaxed = restUntaxed;
        tax = restTax;
      }
    }
  }

  const taxes = allocateInteger(tax, clean.map((l) => l.gross));
  const items = clean.map((l, i) => {
    const amount = l.gross - taxes[i];
    const divisible = amount % l.qty === 0;
    return {
      name: sanitizeInvoiceItemName(divisible ? l.name : `${l.name}x${l.qty}`),
      qty: divisible ? l.qty : 1,
      unit: divisible ? l.unit || '個' : '式',
      unitPrice: divisible ? amount / l.qty : amount,
      amount,
      taxAmt: taxes[i],
      grossAmount: l.gross,
      taxType: String(invoice.taxType || EZPAY_TAX_TYPE.TAXABLE),
      einvoiceItemId: l.einvoiceItemId ?? null,
      saleItemId: l.saleItemId ?? null,
      returnQty: l.qty,
    };
  });
  return { items, untaxed, tax, total };
}

/**
 * 退費之發票處理方式（執行當下判定）
 * - 有開立中 → 409 INVOICE_ISSUING
 * - 全未開立：全額退 → CANCEL_UNISSUED；部分退 → 409 INVOICE_NOT_ISSUED
 * - 已開立：全額退＋全部為當期＋未曾折讓＋非舊制合併發票 → VOID（含免稅分張）；否則逐張 ALLOWANCE
 * - 部分已開立、部分未開立：部分退 → 409；全額退 → 已開立依上列判定、未開立取消
 * @param {{ invoices: Array<{ id, status, periodKey, allowanceTotal, totalAmount }>, fullRefund: boolean, sharedInvoice?: boolean, now?: Date }} input
 * @returns {{ action: 'NONE'|'CANCEL_UNISSUED'|'VOID'|'ALLOWANCE', perInvoice: Array<{ id: string, action: 'VOID'|'ALLOWANCE'|'CANCEL' }> }}
 */
export function decideInvoiceActions({ invoices, fullRefund, sharedInvoice = false, now = new Date() }) {
  const rows = (invoices || []).filter((r) => !['VOIDED', 'CANCELLED'].includes(r.status));
  if (!rows.length) return { action: 'NONE', perInvoice: [] };
  if (rows.some((r) => r.status === 'ISSUING')) {
    throw ruleError(409, 'INVOICE_ISSUING', '發票開立中，請稍候再辦理退費');
  }
  const issued = rows.filter((r) => r.status === 'ISSUED');
  const unissued = rows.filter((r) => r.status === 'PENDING' || r.status === 'FAILED');
  if (unissued.length && !fullRefund) {
    throw ruleError(409, 'INVOICE_NOT_ISSUED', '發票尚未開立，不得部分退費（請先補開發票）');
  }
  const cancels = unissued.map((r) => ({ id: r.id, action: 'CANCEL' }));
  if (!issued.length) return { action: 'CANCEL_UNISSUED', perInvoice: cancels };

  const period = invoicePeriodKey(now);
  const canVoid =
    fullRefund && !sharedInvoice && issued.every((r) => r.periodKey === period && !(r.allowanceTotal > 0));
  const action = canVoid ? 'VOID' : 'ALLOWANCE';
  return { action, perInvoice: [...issued.map((r) => ({ id: r.id, action })), ...cancels] };
}

/** 折讓金額拆未稅／稅額（依原發票稅別） */
export function splitAllowanceAmount(totalRaw, taxType = '1') {
  const total = Math.round(Number(totalRaw));
  if (!Number.isFinite(total) || total <= 0) {
    const err = new Error('折讓金額必須為正整數');
    err.statusCode = 400;
    throw err;
  }
  if (String(taxType) === '3') return { total, untaxed: total, tax: 0 };
  const untaxed = Math.round(total / (1 + TAX_RATE / 100));
  return { total, untaxed, tax: total - untaxed };
}
