// lib/salesReconciliation.js — 門市銷貨對帳＋門市全部發票（會計師沖帳／申報）；金額唯一由此計算，前端只負責組 Excel／CSV
import prisma from './prisma.js';
import { allocateInteger, normalizeTaxType, TAX_RATE, TAX_TYPE, EZPAY_TAX_TYPE } from './einvoiceRules.js';
import { staffBranchLabel } from './branchLabel.js';

export const RECON_MAX_DAYS = 366;
export const RECON_MAX_LINES = 50000;

const TW_OFFSET_MS = 8 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SALE_STATUS_LABEL = { PAID: '已收款', CANCELLED: '已取消' };
const TAX_TYPE_LABEL = { TAXABLE: '應稅', TAX_FREE: '免稅' };
const INVOICE_STATUS_LABEL = {
  ISSUED: '已開立',
  VOIDED: '已作廢',
  FAILED: '開立失敗',
  PENDING: '待開立',
  ISSUING: '開立中',
  CANCELLED: '未開立已取消',
};
const UNISSUED_STATUSES = ['FAILED', 'PENDING', 'ISSUING'];
const ALLOWANCE_STATUS_LABEL = { ISSUED: '已開立', VOIDED: '已作廢' };
const ALLOWANCE_SOURCE_LABEL = { REFUND: '退費', CANCEL_SALE: '銷貨取消', SUB_CANCEL: '訂閱取消', MANUAL: '手動折讓' };
const CARRIER_LABEL = { 0: '手機條碼', 1: '自然人憑證', 2: 'ezPay 載具' };

/** 發票來源類別（依單據前綴／分腿），順序即彙總顯示順序 */
export const INVOICE_SOURCES = [
  { code: 'RETAIL', label: '商品銷售' },
  { code: 'MEMBERSHIP', label: '會籍／儲值購案' },
  { code: 'SUBSCRIPTION', label: '月卡／定期定額' },
  { code: 'PT', label: '私教課程' },
  { code: 'GROUP', label: '團課報名' },
  { code: 'CHECKOUT', label: '合併結帳（舊制）' },
];
const SOURCE_LABEL = Object.fromEntries(INVOICE_SOURCES.map((s) => [s.code, s.label]));

const PAY_METHOD_LABEL = {
  CASH: '現金',
  YIPAY: '刷卡（乙禾）',
  CARD: '信用卡（PayUNi）',
  LINEPAY: 'LINE Pay',
  WALLET_CASH: '儲值金',
  WALLET_BONUS: '運動金',
  VOUCHER: '抵用券',
};

/** 付款方式中文＋各方式金額（複合支付 CASH+VOUCHER 等） */
export function payMethodText(payMethod, payBreakdown) {
  const methods = String(payMethod || '').split('+').map((m) => m.trim()).filter(Boolean);
  const bd = payBreakdown && typeof payBreakdown === 'object' ? payBreakdown : {};
  if (!methods.length) return '';
  return methods
    .map((m) => {
      const label = PAY_METHOD_LABEL[m] || m;
      return methods.length > 1 && Number.isFinite(Number(bd[m])) ? `${label} ${Number(bd[m])}` : label;
    })
    .join('＋');
}

const INVOICE_PREFERENCE = ['ISSUED', 'ISSUING', 'PENDING', 'FAILED', 'VOIDED', 'CANCELLED'];

function badRequest(message, code) {
  const err = new Error(message);
  err.statusCode = 400;
  if (code) err.code = code;
  return err;
}

/** YYYY-MM-DD（台灣日）→ 當日 00:00 台灣時間之 UTC Date */
function twDayStart(ymd, field) {
  if (!DATE_RE.test(String(ymd || ''))) throw badRequest(`${field} 須為 YYYY-MM-DD`, 'DATE_INVALID');
  const d = new Date(`${ymd}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} 日期無效`, 'DATE_INVALID');
  return d;
}

export function twDate(value) {
  if (!value) return null;
  return new Date(new Date(value).getTime() + TW_OFFSET_MS).toISOString().slice(0, 10);
}

export function twTime(value) {
  if (!value) return null;
  return new Date(new Date(value).getTime() + TW_OFFSET_MS).toISOString().slice(11, 19);
}

/** 區間含頭含尾（台灣日），最長 RECON_MAX_DAYS 日 */
export function parseReconRange(fromRaw, toRaw) {
  const gte = twDayStart(fromRaw, 'from');
  const toStart = twDayStart(toRaw, 'to');
  const lt = new Date(toStart.getTime() + 24 * 3600 * 1000);
  if (lt <= gte) throw badRequest('from 不可晚於 to', 'DATE_RANGE_INVALID');
  const days = Math.round((lt - gte) / (24 * 3600 * 1000));
  if (days > RECON_MAX_DAYS) throw badRequest(`查詢區間最長 ${RECON_MAX_DAYS} 日`, 'DATE_RANGE_TOO_LONG');
  return { gte, lt, from: fromRaw, to: toRaw, days };
}

function inRange(value, range) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= range.gte.getTime() && t < range.lt.getTime();
}

/**
 * 同一銷貨單同課稅別之明細拆未稅／稅額：稅額依發票（或同公式）整張計算後按含稅小計最大餘數分攤，
 * 確保明細加總＝發票銷售額／稅額。
 * @param {Array<{ lineTotal: number }>} lines
 * @param {'TAXABLE'|'TAX_FREE'} taxType
 * @param {{ salesAmount: number, taxAmount: number, totalAmount: number } | null} invoice
 */
export function splitGroupTax(lines, taxType, invoice = null) {
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  let tax;
  if (taxType !== TAX_TYPE.TAXABLE) tax = 0;
  else if (invoice && invoice.totalAmount === total) tax = invoice.taxAmount;
  else tax = total - Math.round(total / (1 + TAX_RATE / 100));
  const taxes = allocateInteger(tax, lines.map((l) => l.lineTotal));
  return lines.map((l, i) => ({ salesAmount: l.lineTotal - taxes[i], taxAmount: taxes[i], totalAmount: l.lineTotal }));
}

/**
 * 發票品項拆未稅／稅額：整張稅額按品項金額最大餘數分攤（B2C 品項含稅、B2B 品項未稅，與送 ezPay 一致），
 * 品項加總恆等於發票銷售額／稅額／總計。無品項之歷史發票以品名摘要列一行。
 */
export function splitInvoiceItems(inv) {
  const b2b = inv.category === 'B2B';
  const items = inv.items?.length
    ? inv.items
    : [{ lineNo: 1, name: inv.itemDesc, qty: 1, unit: '式', unitPrice: b2b ? inv.salesAmount : inv.totalAmount, amount: b2b ? inv.salesAmount : inv.totalAmount }];
  const taxes = allocateInteger(inv.taxAmount, items.map((it) => Math.max(0, it.amount)));
  return items.map((it, i) => ({
    lineNo: it.lineNo ?? i + 1,
    name: it.name,
    qty: it.qty,
    unit: it.unit || '',
    unitPrice: it.unitPrice,
    salesAmount: b2b ? it.amount : it.amount - taxes[i],
    taxAmount: taxes[i],
    totalAmount: b2b ? it.amount + taxes[i] : it.amount,
  }));
}

/** 發票來源類別：SAL 商品、GRP 團課、CRS 月卡訂閱、私教分腿、其餘 TYK 購案；CHK 舊制合併 */
export function invoiceSourceOf(inv) {
  if (inv.refType === 'SALE') return 'RETAIL';
  if (inv.refType === 'CHECKOUT') return 'CHECKOUT';
  const ref = String(inv.refId || '');
  if (ref.startsWith('GRP') || String(inv.leg || '').startsWith('GROUP')) return 'GROUP';
  if (ref.startsWith('CRS')) return 'SUBSCRIPTION';
  if (String(inv.leg || '').startsWith('PT') || String(inv.itemDesc || '').includes('私教')) return 'PT';
  return 'MEMBERSHIP';
}

function issueModeOf(inv) {
  if (inv.category === 'B2B') return '三聯式（統編）';
  if (inv.carrierType != null && CARRIER_LABEL[inv.carrierType]) return CARRIER_LABEL[inv.carrierType];
  if (inv.loveCode) return `捐贈（${inv.loveCode}）`;
  if (inv.printFlag === 'Y') return '紙本';
  return '—';
}

function pickInvoice(candidates) {
  if (!candidates?.length) return null;
  return [...candidates].sort(
    (a, b) => INVOICE_PREFERENCE.indexOf(a.status) - INVOICE_PREFERENCE.indexOf(b.status) || b.seq - a.seq,
  )[0];
}

function emptyTotals() {
  return { salesAmount: 0, taxAmount: 0, totalAmount: 0, qty: 0, lines: 0 };
}

function addTotals(acc, row) {
  acc.salesAmount += row.salesAmount;
  acc.taxAmount += row.taxAmount;
  acc.totalAmount += row.totalAmount;
  acc.qty += row.qty;
  acc.lines += 1;
}

function emptyAmounts() {
  return { count: 0, salesAmount: 0, taxAmount: 0, totalAmount: 0 };
}

function addAmounts(acc, salesAmount, taxAmount, totalAmount) {
  acc.count += 1;
  acc.salesAmount += salesAmount;
  acc.taxAmount += taxAmount;
  acc.totalAmount += totalAmount;
}

function periodLabel(periodKey) {
  if (!periodKey || !/^\d{6}$/.test(periodKey)) return '';
  const y = Number(periodKey.slice(0, 4));
  const m = Number(periodKey.slice(4));
  return `${y - 1911}年${String(m).padStart(2, '0')}-${String(m + 1).padStart(2, '0')}月`;
}

export const LINE_COLUMNS = [
  { key: 'saleDate', label: '銷貨日期', type: 'text' },
  { key: 'saleTime', label: '時間', type: 'text' },
  { key: 'branchName', label: '門市', type: 'text' },
  { key: 'saleId', label: '銷貨單號', type: 'text' },
  { key: 'saleStatusLabel', label: '單據狀態', type: 'text' },
  { key: 'sku', label: '商品編號', type: 'text' },
  { key: 'productName', label: '品名', type: 'text' },
  { key: 'qty', label: '數量', type: 'int' },
  { key: 'unitPrice', label: '含稅單價', type: 'money' },
  { key: 'taxTypeLabel', label: '課稅別', type: 'text' },
  { key: 'salesAmount', label: '未稅金額', type: 'money' },
  { key: 'taxAmount', label: '稅額', type: 'money' },
  { key: 'totalAmount', label: '總金額', type: 'money' },
  { key: 'invoiceNumber', label: '發票號碼', type: 'text' },
  { key: 'invoiceDate', label: '發票日期', type: 'text' },
  { key: 'invoiceStatusLabel', label: '發票狀態', type: 'text' },
  { key: 'buyerUbn', label: '買受人統編', type: 'text' },
  { key: 'payMethod', label: '付款方式', type: 'text' },
];

export const INVOICE_COLUMNS = [
  { key: 'invoiceNumber', label: '發票號碼', type: 'text' },
  { key: 'invoiceDate', label: '開立日期', type: 'text' },
  { key: 'periodLabel', label: '期別', type: 'text' },
  { key: 'statusLabel', label: '狀態', type: 'text' },
  { key: 'voidedDate', label: '作廢日期', type: 'text' },
  { key: 'sourceLabel', label: '來源類別', type: 'text' },
  { key: 'refId', label: '來源單號', type: 'text' },
  { key: 'branchName', label: '門市', type: 'text' },
  { key: 'sellerUbn', label: '賣方統編', type: 'text' },
  { key: 'issueMode', label: '開立方式', type: 'text' },
  { key: 'buyerUbn', label: '買受人統編', type: 'text' },
  { key: 'buyerName', label: '買受人名稱', type: 'text' },
  { key: 'taxTypeLabel', label: '課稅別', type: 'text' },
  { key: 'salesAmount', label: '銷售額（未稅）', type: 'money' },
  { key: 'taxAmount', label: '稅額', type: 'money' },
  { key: 'totalAmount', label: '總計', type: 'money' },
  { key: 'allowanceTotal', label: '已折讓', type: 'money' },
  { key: 'itemDesc', label: '品名摘要', type: 'text' },
  { key: 'voidReason', label: '作廢原因', type: 'text' },
];

export const INVOICE_ITEM_COLUMNS = [
  { key: 'invoiceNumber', label: '發票號碼', type: 'text' },
  { key: 'invoiceDate', label: '開立日期', type: 'text' },
  { key: 'statusLabel', label: '發票狀態', type: 'text' },
  { key: 'sourceLabel', label: '來源類別', type: 'text' },
  { key: 'refId', label: '來源單號', type: 'text' },
  { key: 'lineNo', label: '序', type: 'int' },
  { key: 'name', label: '品名', type: 'text' },
  { key: 'qty', label: '數量', type: 'int' },
  { key: 'unit', label: '單位', type: 'text' },
  { key: 'unitPrice', label: '發票單價（B2C 含稅／B2B 未稅）', type: 'money' },
  { key: 'taxTypeLabel', label: '課稅別', type: 'text' },
  { key: 'salesAmount', label: '未稅金額', type: 'money' },
  { key: 'taxAmount', label: '稅額', type: 'money' },
  { key: 'totalAmount', label: '含稅金額', type: 'money' },
];

export const ALLOWANCE_COLUMNS = [
  { key: 'allowanceDate', label: '折讓日期', type: 'text' },
  { key: 'allowanceNo', label: '折讓單號', type: 'text' },
  { key: 'statusLabel', label: '狀態', type: 'text' },
  { key: 'reasonLabel', label: '折讓原因', type: 'text' },
  { key: 'invoiceNumber', label: '原發票號碼', type: 'text' },
  { key: 'invoiceDate', label: '原發票日期', type: 'text' },
  { key: 'sourceLabel', label: '來源類別', type: 'text' },
  { key: 'refId', label: '來源單號', type: 'text' },
  { key: 'branchName', label: '門市', type: 'text' },
  { key: 'sellerUbn', label: '賣方統編', type: 'text' },
  { key: 'buyerUbn', label: '買受人統編', type: 'text' },
  { key: 'salesAmount', label: '折讓未稅', type: 'money' },
  { key: 'taxAmount', label: '折讓稅額', type: 'money' },
  { key: 'totalAmount', label: '折讓總額', type: 'money' },
];

/** 商品銷貨明細（依銷貨日期）；稅額依該單同課稅別發票分攤 */
async function buildRetailSales({ range, branchId, includeCancelled }) {
  const where = {
    createdAt: { gte: range.gte, lt: range.lt },
    status: { in: includeCancelled ? ['PAID', 'CANCELLED'] : ['PAID'] },
    ...(branchId ? { branchId } : {}),
  };
  const lineCount = await prisma.saleItem.count({ where: { saleOrder: where } });
  if (lineCount > RECON_MAX_LINES) {
    throw badRequest(`銷貨明細 ${lineCount} 筆超過上限 ${RECON_MAX_LINES}，請縮短區間或指定門市`, 'REPORT_TOO_LARGE');
  }

  const sales = await prisma.saleOrder.findMany({
    where,
    select: {
      id: true,
      branchId: true,
      status: true,
      amount: true,
      payMethod: true,
      payBreakdown: true,
      checkoutSessionId: true,
      createdAt: true,
      branch: { select: { id: true, name: true, code: true } },
      legalEntity: { select: { id: true, code: true, name: true, ubn: true } },
      items: {
        select: { id: true, name: true, qty: true, unitPrice: true, lineTotal: true, taxType: true, product: { select: { sku: true } } },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const saleIds = sales.map((s) => s.id);
  const sessionIds = [...new Set(sales.map((s) => s.checkoutSessionId).filter(Boolean))];
  const [invoices, requests] = saleIds.length
    ? await Promise.all([
        prisma.eInvoice.findMany({
          where: {
            OR: [
              { refType: 'SALE', refId: { in: saleIds } },
              ...(sessionIds.length ? [{ refType: 'CHECKOUT', refId: { in: sessionIds } }] : []),
            ],
          },
          orderBy: [{ refId: 'asc' }, { seq: 'asc' }],
        }),
        prisma.invoiceRequest.findMany({ where: { refId: { in: [...saleIds, ...sessionIds] } } }),
      ])
    : [[], []];
  const reqMap = new Map(requests.map((r) => [r.refId, r]));
  const invBySale = new Map();
  const legacyBySession = new Map();
  for (const inv of invoices) {
    const map = inv.refType === 'SALE' ? invBySale : legacyBySession;
    if (!map.has(inv.refId)) map.set(inv.refId, []);
    map.get(inv.refId).push(inv);
  }

  const rows = [];
  const byTaxType = { TAXABLE: emptyTotals(), TAX_FREE: emptyTotals() };
  const valid = emptyTotals();
  const cancelled = emptyTotals();
  const uninvoiced = { count: 0, totalAmount: 0, saleIds: [] };
  let orderAmountMismatch = 0;

  for (const sale of sales) {
    const branchName = staffBranchLabel(sale.branch);
    const req = reqMap.get(sale.id) || (sale.checkoutSessionId ? reqMap.get(sale.checkoutSessionId) : null);
    const ownInvoices = invBySale.get(sale.id) || [];
    const legacy = sale.checkoutSessionId ? pickInvoice(legacyBySession.get(sale.checkoutSessionId)) : null;

    const groups = new Map();
    for (const it of sale.items) {
      const taxType = normalizeTaxType(it.taxType);
      if (!groups.has(taxType)) groups.set(taxType, []);
      groups.get(taxType).push({ ...it, taxType, lineTotal: it.unitPrice * it.qty });
    }

    const lineSum = sale.items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
    if (sale.status === 'PAID' && lineSum !== sale.amount) orderAmountMismatch += 1;
    let saleUninvoiced = false;

    for (const [taxType, groupLines] of groups) {
      const inv = pickInvoice(ownInvoices.filter((i) => i.taxType === EZPAY_TAX_TYPE[taxType])) || legacy;
      const isLegacy = Boolean(inv && inv === legacy);
      const split = splitGroupTax(groupLines, taxType, isLegacy ? null : inv);
      if (sale.status === 'PAID' && inv?.status !== 'ISSUED') saleUninvoiced = true;

      groupLines.forEach((it, i) => {
        const row = {
          lineId: it.id,
          saleDate: twDate(sale.createdAt),
          saleTime: twTime(sale.createdAt),
          branchId: sale.branchId,
          branchName,
          saleId: sale.id,
          saleStatus: sale.status,
          saleStatusLabel: SALE_STATUS_LABEL[sale.status] || sale.status,
          sku: it.product?.sku || '',
          productName: it.name,
          qty: it.qty,
          unitPrice: it.unitPrice,
          taxType,
          taxTypeLabel: TAX_TYPE_LABEL[taxType],
          ...split[i],
          invoiceNumber: inv?.invoiceNumber || '',
          invoiceDate: twDate(inv?.issuedAt) || '',
          invoiceStatus: inv?.status || 'NONE',
          invoiceStatusLabel: inv ? `${INVOICE_STATUS_LABEL[inv.status] || inv.status}${isLegacy ? '（合併發票）' : ''}` : '未建立',
          buyerUbn: inv?.buyerUbn || req?.buyerUbn || '',
          payMethod: payMethodText(sale.payMethod, sale.payBreakdown),
        };
        rows.push(row);
        if (sale.status === 'PAID') {
          addTotals(valid, row);
          addTotals(byTaxType[taxType], row);
        } else {
          addTotals(cancelled, row);
        }
      });
    }

    if (saleUninvoiced) {
      uninvoiced.count += 1;
      uninvoiced.totalAmount += lineSum;
      uninvoiced.saleIds.push(sale.id);
    }
  }

  return {
    rows,
    entities: sales.map((s) => s.legalEntity).filter(Boolean),
    summary: {
      orderCount: sales.filter((s) => s.status === 'PAID').length,
      cancelledOrderCount: sales.filter((s) => s.status === 'CANCELLED').length,
      valid,
      cancelled,
      byTaxType,
      uninvoiced,
      orderAmountMismatch,
    },
  };
}

/**
 * 門市全部發票（所有來源，依開立日期）：本期開立、本期作廢（含前期開立）、尚未開立（依建立日）；
 * 另列本期折讓單。門市＝發票之提供服務分店（EInvoice.branchId）。
 */
async function buildBranchInvoices({ range, branchId, branchNames }) {
  const period = { gte: range.gte, lt: range.lt };
  const where = {
    ...(branchId ? { branchId } : {}),
    OR: [
      { issuedAt: period },
      { voidedAt: period },
      { issuedAt: null, status: { in: UNISSUED_STATUSES }, createdAt: period },
    ],
  };
  const count = await prisma.eInvoice.count({ where });
  if (count > RECON_MAX_LINES) {
    throw badRequest(`發票 ${count} 張超過上限 ${RECON_MAX_LINES}，請縮短區間或指定門市`, 'REPORT_TOO_LARGE');
  }
  const [invoices, allowances] = await Promise.all([
    prisma.eInvoice.findMany({
      where,
      include: {
        legalEntity: { select: { id: true, code: true, name: true, ubn: true } },
        items: { orderBy: { lineNo: 'asc' } },
      },
      orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.invoiceAllowance.findMany({
      where: { createdAt: period, ...(branchId ? { einvoice: { branchId } } : {}) },
      include: {
        einvoice: {
          select: { refType: true, refId: true, leg: true, itemDesc: true, issuedAt: true, branchId: true, buyerUbn: true, taxType: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const invoiceRows = [];
  const itemRows = [];
  const issuedAll = emptyAmounts();
  const effective = emptyAmounts();
  const voided = emptyAmounts();
  const pending = emptyAmounts();
  const byTaxType = { TAXABLE: emptyAmounts(), TAX_FREE: emptyAmounts() };
  const bySource = Object.fromEntries(INVOICE_SOURCES.map((s) => [s.code, emptyAmounts()]));

  for (const inv of invoices) {
    const source = invoiceSourceOf(inv);
    const taxType = inv.taxType === EZPAY_TAX_TYPE.TAX_FREE ? TAX_TYPE.TAX_FREE : TAX_TYPE.TAXABLE;
    const issuedInPeriod = inRange(inv.issuedAt, range);
    const base = {
      einvoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber || '',
      invoiceDate: twDate(inv.issuedAt) || '',
      status: inv.status,
      statusLabel: INVOICE_STATUS_LABEL[inv.status] || inv.status,
      source,
      sourceLabel: SOURCE_LABEL[source],
      refId: inv.refId,
      taxType,
      taxTypeLabel: TAX_TYPE_LABEL[taxType],
    };
    invoiceRows.push({
      ...base,
      periodKey: inv.periodKey || '',
      periodLabel: periodLabel(inv.periodKey),
      voidedDate: twDate(inv.voidedAt) || '',
      issuedInPeriod,
      voidedInPeriod: inRange(inv.voidedAt, range),
      branchId: inv.branchId,
      branchName: branchNames.get(inv.branchId) || '',
      legalEntityId: inv.legalEntityId,
      sellerUbn: inv.legalEntity?.ubn || '',
      category: inv.category,
      issueMode: issueModeOf(inv),
      buyerUbn: inv.buyerUbn || '',
      buyerName: inv.category === 'B2B' ? inv.buyerName || '' : '',
      salesAmount: inv.salesAmount,
      taxAmount: inv.taxAmount,
      totalAmount: inv.totalAmount,
      allowanceTotal: inv.allowanceTotal,
      itemDesc: inv.itemDesc,
      voidReason: inv.voidReason || '',
    });
    for (const it of splitInvoiceItems(inv)) itemRows.push({ ...base, ...it, rowKey: `${inv.id}-${it.lineNo}` });

    if (issuedInPeriod) {
      addAmounts(issuedAll, inv.salesAmount, inv.taxAmount, inv.totalAmount);
      if (inv.status === 'ISSUED') {
        addAmounts(effective, inv.salesAmount, inv.taxAmount, inv.totalAmount);
        addAmounts(byTaxType[taxType], inv.salesAmount, inv.taxAmount, inv.totalAmount);
        addAmounts(bySource[source], inv.salesAmount, inv.taxAmount, inv.totalAmount);
      }
    }
    if (inv.status === 'VOIDED' && inRange(inv.voidedAt, range)) {
      addAmounts(voided, inv.salesAmount, inv.taxAmount, inv.totalAmount);
    }
    if (UNISSUED_STATUSES.includes(inv.status)) addAmounts(pending, inv.salesAmount, inv.taxAmount, inv.totalAmount);
  }
  invoiceRows.sort(
    (a, b) => (a.invoiceNumber || '~').localeCompare(b.invoiceNumber || '~') || a.refId.localeCompare(b.refId),
  );
  itemRows.sort(
    (a, b) => (a.invoiceNumber || '~').localeCompare(b.invoiceNumber || '~') || a.refId.localeCompare(b.refId) || a.lineNo - b.lineNo,
  );

  const allowanceTotals = emptyAmounts();
  const allowanceRows = allowances.map((a) => {
    const source = a.einvoice ? invoiceSourceOf(a.einvoice) : a.saleOrderId ? 'RETAIL' : 'MEMBERSHIP';
    if (a.status === 'ISSUED') addAmounts(allowanceTotals, a.untaxedAmt, a.taxAmt, a.totalAmt);
    return {
      allowanceId: a.id,
      allowanceDate: twDate(a.createdAt),
      allowanceNo: a.allowanceNo,
      status: a.status,
      statusLabel: ALLOWANCE_STATUS_LABEL[a.status] || a.status,
      reasonLabel: ALLOWANCE_SOURCE_LABEL[a.source] || a.source,
      invoiceNumber: a.invoiceNumber,
      invoiceDate: twDate(a.einvoice?.issuedAt) || '',
      source,
      sourceLabel: SOURCE_LABEL[source],
      refId: a.einvoice?.refId || a.saleOrderId || a.orderId || '',
      branchName: branchNames.get(a.einvoice?.branchId) || '',
      sellerUbn: a.sellerUbn || '',
      buyerUbn: a.einvoice?.buyerUbn || '',
      salesAmount: a.untaxedAmt,
      taxAmount: a.taxAmt,
      totalAmount: a.totalAmt,
    };
  });

  return {
    invoices: invoiceRows,
    invoiceItems: itemRows,
    allowances: allowanceRows,
    entities: invoices.map((i) => i.legalEntity).filter(Boolean),
    summary: {
      issuedAll,
      effective,
      voided,
      pending,
      allowance: allowanceTotals,
      net: {
        salesAmount: effective.salesAmount - allowanceTotals.salesAmount,
        taxAmount: effective.taxAmount - allowanceTotals.taxAmount,
        totalAmount: effective.totalAmount - allowanceTotals.totalAmount,
      },
      byTaxType,
      bySource: INVOICE_SOURCES.map((s) => ({ ...s, ...bySource[s.code] })).filter((s) => s.count > 0),
    },
  };
}

/**
 * @param {{ from: string, to: string, branchId?: number|null, includeCancelled?: boolean }} input
 */
export async function buildSalesReconciliation({ from, to, branchId = null, includeCancelled = true }) {
  const range = parseReconRange(from, to);
  const branch = branchId
    ? await prisma.branch.findUnique({
        where: { id: branchId },
        select: { id: true, name: true, code: true, legalEntity: { select: { id: true, code: true, name: true, ubn: true } } },
      })
    : null;
  if (branchId && !branch) {
    const err = new Error('門市不存在');
    err.statusCode = 404;
    throw err;
  }
  const branchList = await prisma.branch.findMany({ select: { id: true, name: true, code: true } });
  const branchNames = new Map(branchList.map((b) => [b.id, staffBranchLabel(b)]));

  const retail = await buildRetailSales({ range, branchId, includeCancelled });
  const inv = await buildBranchInvoices({ range, branchId, branchNames });

  const entities = new Map();
  if (branch?.legalEntity) entities.set(branch.legalEntity.id, branch.legalEntity);
  for (const e of [...retail.entities, ...inv.entities]) if (!entities.has(e.id)) entities.set(e.id, e);

  return {
    range: { from: range.from, to: range.to, days: range.days },
    branch: branch ? { id: branch.id, name: staffBranchLabel(branch), code: branch.code } : null,
    legalEntities: [...entities.values()],
    generatedAt: new Date().toISOString(),
    columns: LINE_COLUMNS,
    rows: retail.rows,
    invoiceColumns: INVOICE_COLUMNS,
    invoices: inv.invoices,
    invoiceItemColumns: INVOICE_ITEM_COLUMNS,
    invoiceItems: inv.invoiceItems,
    allowanceColumns: ALLOWANCE_COLUMNS,
    allowances: inv.allowances,
    summary: {
      ...retail.summary,
      invoices: inv.summary,
    },
  };
}
