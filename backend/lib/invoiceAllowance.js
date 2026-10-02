// lib/invoiceAllowance.js — 折讓單紀錄（ezPay 折讓成功即寫入）、員工查詢範圍與列印 payload
// 抬頭＝原發票營業人快照；分店範圍＝原發票 EInvoice.branchId（與門市發票對帳一致）
import prisma from './prisma.js';
import { sellerHeaderOf } from './legalEntity.js';
import { isCrossBranchUser, staffBranchIds, canAccessBranch } from './staffAccess.js';
import { parseReconRange } from './salesReconciliation.js';
import { clientIp } from './memberDeviceAudit.js';

/**
 * TOPUP_VOID 儲值原單取消｜SUB_ORDER_REFUND 子單退費｜SUB_CANCEL 月卡／訂閱｜GROUP_REFUND 團課｜MANUAL
 * （REFUND／CANCEL_SALE／CANCEL_PT 為舊端點歷史紀錄）
 */
export const ALLOWANCE_SOURCES = [
  'TOPUP_VOID',
  'SUB_ORDER_REFUND',
  'REFUND',
  'CANCEL_SALE',
  'CANCEL_PT',
  'SUB_CANCEL',
  'GROUP_REFUND',
  'MANUAL',
];

const LIST_DEFAULT_TAKE = 30;
const LIST_MAX_TAKE = 500;
const FALLBACK_SELLER_NAME = '體育客';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function generateAllowanceRecordId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `IAL${dateStr}${randomStr}`;
}

export function normalizeBuyerEmail(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().slice(0, 50);
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw httpError('消費者 Email 格式無效');
  return s;
}

export function normalizeInvoiceNumberInput(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[A-Z]{2}\d{8}$/.test(s)) {
    throw httpError('發票號碼格式無效（須為 2 碼英文＋8 碼數字，如 AB12345678）');
  }
  return s;
}

function normalizeSource(raw) {
  const s = String(raw || '').toUpperCase();
  return ALLOWANCE_SOURCES.includes(s) ? s : 'REFUND';
}

const RECORD_INCLUDE = {
  legalEntity: { select: { name: true, ubn: true, address: true, ezpayMerchantId: true } },
  einvoice: { select: { branchId: true } },
};

/**
 * ezPay 折讓成功後寫入折讓單（由 einvoice.allowanceEInvoice 唯一呼叫）；同折讓號只寫一次。
 * 單據關聯優先取呼叫端 context（舊合併發票 CHECKOUT 無法由發票反推子單），否則依發票 refType。
 * @param {{ einvoice: object, result: object, parts: { untaxed: number, tax: number, total: number },
 *   itemDesc?: string|null, buyerEmail?: string|null, items?: Array<object>|null,
 *   context?: { source?: string, staffId?: number|null, orderId?: string|null, saleOrderId?: string|null, memberId?: number|null,
 *     refundId?: string|null, subOrderId?: string|null, reason?: string|null } }} input
 */
export async function recordInvoiceAllowance(db, { einvoice, result, parts, itemDesc, buyerEmail, items = null, context = {} }) {
  const existing = await db.invoiceAllowance.findUnique({
    where: { allowanceNo: result.allowanceNo },
    include: RECORD_INCLUDE,
  });
  if (existing) return existing;

  const memberId = context.memberId ?? einvoice.memberId ?? null;
  const member = memberId
    ? await db.member.findUnique({ where: { id: memberId }, select: { name: true } })
    : null;
  const header = sellerHeaderOf(einvoice.legalEntity) || {};
  const b2b = einvoice.category === 'B2B';
  const lines = items?.length
    ? items
    : [
        {
          name: itemDesc || '折讓',
          qty: 1,
          unit: '式',
          unitPrice: parts.untaxed,
          amount: parts.untaxed,
          taxAmt: parts.tax,
          grossAmount: parts.total,
          taxType: einvoice.taxType,
        },
      ];

  return db.invoiceAllowance.create({
    data: {
      id: generateAllowanceRecordId(),
      allowanceNo: result.allowanceNo,
      einvoiceId: einvoice.id,
      legalEntityId: einvoice.legalEntityId ?? null,
      invoiceNumber: result.invoiceNumber || einvoice.invoiceNumber,
      merchantOrderNo: String(result.merchantOrderNo || einvoice.merchantOrderNo || ''),
      orderId: context.orderId ?? (einvoice.refType === 'ORDER' ? einvoice.refId : null),
      saleOrderId: context.saleOrderId ?? (einvoice.refType === 'SALE' ? einvoice.refId : null),
      memberId,
      memberName: member?.name || null,
      itemDesc: itemDesc ? String(itemDesc).slice(0, 500) : null,
      untaxedAmt: parts.untaxed,
      taxAmt: parts.tax,
      totalAmt: parts.total,
      remainAmt: result.remainAmt != null ? Math.round(result.remainAmt) : null,
      buyerEmail: buyerEmail || null,
      source: normalizeSource(context.source),
      staffId: context.staffId ?? null,
      sellerName: header.sellerName || null,
      sellerUbn: header.sellerUbn || null,
      sellerAddress: header.sellerAddress || null,
      refundId: context.refundId ?? null,
      subOrderId: context.subOrderId ?? context.saleOrderId ?? context.orderId ?? einvoice.refId ?? null,
      branchId: einvoice.branchId ?? null,
      invoiceIssuedAt: einvoice.issuedAt ?? null,
      invoicePeriodKey: einvoice.periodKey ?? null,
      category: einvoice.category || null,
      buyerUbn: b2b ? einvoice.buyerUbn || null : null,
      buyerName: b2b ? einvoice.buyerName || null : null,
      reason: context.reason ? String(context.reason).slice(0, 200) : null,
      items: {
        create: lines.map((it, i) => ({
          lineNo: i + 1,
          name: String(it.name || '折讓').slice(0, 60),
          qty: it.qty,
          unit: it.unit || '式',
          unitPrice: it.unitPrice,
          amount: it.amount,
          taxAmt: it.taxAmt,
          grossAmount: it.grossAmount ?? it.amount + it.taxAmt,
          taxType: String(it.taxType || einvoice.taxType || '1'),
          einvoiceItemId: it.einvoiceItemId ?? null,
          saleItemId: it.saleItemId ?? null,
        })),
      },
    },
    include: RECORD_INCLUDE,
  });
}

/** 列印／列表 payload（含開立分店與狀態） */
export function toPrintableAllowance(row, { branchNames } = {}) {
  if (!row) return null;
  const branchId = row.einvoice?.branchId ?? null;
  return {
    id: row.id || null,
    allowanceNo: row.allowanceNo,
    status: row.status || 'ISSUED',
    invoiceNumber: row.invoiceNumber,
    merchantOrderNo: row.merchantOrderNo,
    orderId: row.orderId || null,
    saleOrderId: row.saleOrderId || null,
    memberId: row.memberId ?? null,
    memberName: row.memberName || null,
    itemDesc: row.itemDesc || null,
    untaxedAmt: row.untaxedAmt,
    taxAmt: row.taxAmt,
    totalAmt: row.totalAmt,
    remainAmt: row.remainAmt ?? null,
    buyerEmail: row.buyerEmail || null,
    source: row.source || 'REFUND',
    staffId: row.staffId ?? null,
    branchId,
    branchName: branchId != null ? branchNames?.get(branchId) || null : null,
    issuedAt: new Date(row.createdAt || Date.now()).toISOString(),
    sellerName: row.sellerName || row.legalEntity?.name || FALLBACK_SELLER_NAME,
    sellerUbn: row.sellerUbn || row.legalEntity?.ubn || null,
    sellerAddress: row.sellerAddress || row.legalEntity?.address || null,
    merchantId: row.legalEntity?.ezpayMerchantId || null,
    refundId: row.refundId || null,
    subOrderId: row.subOrderId || row.saleOrderId || row.orderId || null,
    category: row.category || null,
    buyerUbn: row.buyerUbn || null,
    buyerName: row.buyerName || null,
    invoiceIssuedAt: row.invoiceIssuedAt ? new Date(row.invoiceIssuedAt).toISOString() : null,
    reason: row.reason || null,
    signed: Boolean(row.signatureId),
    signatureRequired: row.category === 'B2B',
    printCount: row.printCount ?? 0,
    lastPrintedAt: row.lastPrintedAt ? new Date(row.lastPrintedAt).toISOString() : null,
    exportedToAcctAt: row.exportedToAcctAt ? new Date(row.exportedToAcctAt).toISOString() : null,
  };
}

async function branchNameMap(rows) {
  const ids = [...new Set(rows.map((r) => r.einvoice?.branchId).filter((v) => v != null))];
  if (!ids.length) return new Map();
  const branches = await prisma.branch.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(branches.map((b) => [b.id, b.name]));
}

/**
 * 員工可見範圍：跨店職位全部；其餘僅限 JWT 可操作分店之發票折讓（無原發票之舊紀錄不可見）
 */
export function allowanceScopeWhere(user, branchId = null) {
  if (branchId != null) {
    if (!canAccessBranch(user, branchId)) throw httpError('⛔ 無權查詢其他分店折讓單', 403);
    return { einvoice: { branchId } };
  }
  if (isCrossBranchUser(user)) return {};
  const ids = staffBranchIds(user);
  if (!ids.length) throw httpError('⛔ 帳號未綁定分店，請洽管理員', 403);
  return { einvoice: { branchId: { in: ids } } };
}

function parseListBranchId(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const bid = parseInt(raw, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw httpError('branchId 無效');
  return bid;
}

/**
 * 折讓單一覽（查詢／CSV／Excel 匯出共用；匯出由前端依回傳 rows 排版）
 * @param {object} user 員工 JWT
 * @param {{ from?: string, to?: string, q?: string, branchId?: string|number, source?: string,
 *   orderId?: string, subOrderId?: string, refundId?: string, allowanceNo?: string, invoiceNumber?: string,
 *   memberId?: string|number, member?: string, take?: string|number }} query
 */
export async function listAllowancesForStaff(user, query = {}) {
  const where = { ...allowanceScopeWhere(user, parseListBranchId(query.branchId)) };

  if (query.from || query.to) {
    if (!query.from || !query.to) throw httpError('from 與 to 須同時提供（YYYY-MM-DD）');
    const range = parseReconRange(String(query.from), String(query.to));
    where.createdAt = { gte: range.gte, lt: range.lt };
  }
  if (query.source) where.source = normalizeSource(query.source);
  if (query.orderId) where.orderId = String(query.orderId).trim();
  if (query.subOrderId) where.subOrderId = String(query.subOrderId).trim().toUpperCase();
  if (query.refundId) where.refundId = String(query.refundId).trim().toUpperCase();
  if (query.allowanceNo) where.allowanceNo = String(query.allowanceNo).trim().slice(0, 40);
  if (query.invoiceNumber) where.invoiceNumber = normalizeInvoiceNumberInput(query.invoiceNumber);
  if (query.memberId) {
    const mid = parseInt(query.memberId, 10);
    if (!Number.isInteger(mid) || mid <= 0) throw httpError('memberId 無效');
    where.memberId = mid;
  } else if (query.member) {
    where.memberName = { contains: String(query.member).trim().slice(0, 40) };
  }
  applyExportState(where, query.exportState);

  const q = String(query.q || '').trim().slice(0, 40);
  if (q) {
    where.OR = [
      { allowanceNo: { contains: q, mode: 'insensitive' } },
      { invoiceNumber: { contains: q.toUpperCase() } },
      { orderId: { contains: q, mode: 'insensitive' } },
      { saleOrderId: { contains: q, mode: 'insensitive' } },
      { subOrderId: { contains: q.toUpperCase() } },
      { refundId: { contains: q.toUpperCase() } },
      { memberName: { contains: q } },
    ];
  }

  const take = Math.min(LIST_MAX_TAKE, Math.max(1, parseInt(query.take, 10) || LIST_DEFAULT_TAKE));
  const rows = await prisma.invoiceAllowance.findMany({
    where,
    include: RECORD_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take,
  });
  const branchNames = await branchNameMap(rows);
  return rows.map((r) => toPrintableAllowance(r, { branchNames }));
}

/** 折讓單匯出欄位（前端依此排版 CSV／Excel，禁止自算金額） */
export const ALLOWANCE_EXPORT_COLUMNS = [
  { key: 'issuedAt', label: '折讓日期', type: 'text' },
  { key: 'allowanceNo', label: '折讓單號', type: 'text' },
  { key: 'status', label: '狀態', type: 'text' },
  { key: 'branchName', label: '門市', type: 'text' },
  { key: 'sellerName', label: '營業人', type: 'text' },
  { key: 'sellerUbn', label: '營業人統編', type: 'text' },
  { key: 'invoiceNumber', label: '原發票號碼', type: 'text' },
  { key: 'invoiceIssuedAt', label: '原發票日期', type: 'text' },
  { key: 'category', label: '類別', type: 'text' },
  { key: 'buyerUbn', label: '買受人統編', type: 'text' },
  { key: 'buyerName', label: '買受人名稱', type: 'text' },
  { key: 'memberName', label: '會員', type: 'text' },
  { key: 'subOrderId', label: '子單號', type: 'text' },
  { key: 'refundId', label: '退費單號', type: 'text' },
  { key: 'untaxedAmt', label: '折讓未稅', type: 'money' },
  { key: 'taxAmt', label: '折讓稅額', type: 'money' },
  { key: 'totalAmt', label: '折讓含稅', type: 'money' },
  { key: 'signed', label: '顧客簽名', type: 'text' },
  { key: 'reason', label: '原因', type: 'text' },
  { key: 'printCount', label: '列印次數', type: 'int' },
  { key: 'exportedToAcctAt', label: '首次會計匯出', type: 'text' },
];

const TW_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });

/** @param {ReturnType<typeof toPrintableAllowance>[]} list */
export function allowanceExportRows(list) {
  return list.map((a) => ({
    issuedAt: a.issuedAt ? TW_DATE.format(new Date(a.issuedAt)) : '',
    allowanceNo: a.allowanceNo,
    status: a.status === 'ISSUED' ? '已開立' : a.status,
    branchName: a.branchName || '',
    sellerName: a.sellerName || '',
    sellerUbn: a.sellerUbn || '',
    invoiceNumber: a.invoiceNumber || '',
    invoiceIssuedAt: a.invoiceIssuedAt ? TW_DATE.format(new Date(a.invoiceIssuedAt)) : '',
    category: a.category || '',
    buyerUbn: a.buyerUbn || '',
    buyerName: a.buyerName || '',
    memberName: a.memberName || '',
    subOrderId: a.subOrderId || '',
    refundId: a.refundId || '',
    untaxedAmt: a.untaxedAmt,
    taxAmt: a.taxAmt,
    totalAmt: a.totalAmt,
    signed: a.signatureRequired ? (a.signed ? '已簽' : '待簽') : a.signed ? '已簽' : '免簽',
    reason: a.reason || '',
    printCount: a.printCount ?? 0,
    exportedToAcctAt: a.exportedToAcctAt ? TW_DATE.format(new Date(a.exportedToAcctAt)) : '',
  }));
}

export const ALLOWANCE_EXPORT_FILTERS = ['from', 'to', 'branchId', 'allowanceNo', 'invoiceNumber', 'member', 'subOrderId', 'q', 'exportState', 'markExported'];

const EXPORT_STATES = new Set(['ALL', 'EXPORTED', 'UNEXPORTED']);

function applyExportState(where, raw) {
  const exportState = String(raw || 'ALL').trim().toUpperCase();
  if (!EXPORT_STATES.has(exportState)) {
    throw httpError('exportState 須為 ALL、EXPORTED 或 UNEXPORTED', 400, 'EXPORT_STATE_INVALID');
  }
  if (exportState === 'UNEXPORTED') where.exportedToAcctAt = null;
  else if (exportState === 'EXPORTED') where.exportedToAcctAt = { not: null };
}

/**
 * 會計匯出（DUTY+）：條件同一覽但必帶日期區間；首次匯出者寫入 exportedToAcctAt（不覆寫），並留 ALLOWANCE_EXPORT 稽核
 * @returns {{ items, columns, rows, exported: { total, firstTime, exportedAt, truncated } }}
 */
export async function exportAllowancesForAccounting(user, filters = {}, req = null) {
  if (!filters.from || !filters.to) throw httpError('會計匯出須指定起訖日期（YYYY-MM-DD）', 400, 'DATE_RANGE_REQUIRED');
  const markExported = filters.markExported === true;
  const query = {};
  for (const k of ALLOWANCE_EXPORT_FILTERS) {
    if (k === 'markExported') continue;
    if (filters[k] != null && filters[k] !== '') query[k] = filters[k];
  }
  const items = await listAllowancesForStaff(user, { ...query, take: LIST_MAX_TAKE });
  const now = new Date();
  const freshIds = markExported ? items.filter((a) => a.id && !a.exportedToAcctAt).map((a) => a.id) : [];
  let firstTime = 0;
  if (freshIds.length) {
    const out = await prisma.invoiceAllowance.updateMany({
      where: { id: { in: freshIds }, exportedToAcctAt: null },
      data: { exportedToAcctAt: now, exportedByStaffId: user?.id ?? null },
    });
    firstTime = out.count;
  }
  const stamped = new Set(freshIds);
  const exportedItems = items.map((a) =>
    stamped.has(a.id) && !a.exportedToAcctAt ? { ...a, exportedToAcctAt: now.toISOString() } : a,
  );

  await prisma.transactionAuditLog
    .create({
      data: {
        action: 'ALLOWANCE_EXPORT',
        refType: 'ALLOWANCE',
        staffId: user?.id ?? null,
        staffRole: user?.role ?? null,
        branchId: query.branchId != null && query.branchId !== 'all' ? parseInt(query.branchId, 10) || null : null,
        clientIp: req ? clientIp(req) : null,
        after: { filters: query, total: items.length, firstTime, marked: markExported },
      },
    })
    .catch((e) => console.error('折讓單匯出紀錄寫入失敗:', e.message));

  return {
    items: exportedItems,
    columns: ALLOWANCE_EXPORT_COLUMNS,
    rows: allowanceExportRows(exportedItems),
    exported: {
      total: items.length,
      firstTime,
      exportedAt: markExported ? now.toISOString() : null,
      truncated: items.length >= LIST_MAX_TAKE,
      marked: markExported,
    },
  };
}

/** 單據相關折讓單（退費查詢帶出） */
export async function listAllowancesForRef({ orderId, invoiceNumbers = [] }, { take = 5 } = {}) {
  const rows = await prisma.invoiceAllowance.findMany({
    where: {
      OR: [
        { orderId },
        ...(invoiceNumbers.length ? [{ invoiceNumber: { in: invoiceNumbers } }] : []),
      ],
    },
    include: RECORD_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take,
  });
  const branchNames = await branchNameMap(rows);
  return rows.map((r) => toPrintableAllowance(r, { branchNames }));
}
