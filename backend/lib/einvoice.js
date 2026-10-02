// lib/einvoice.js — 電子發票閘道（唯一開立／作廢／折讓入口）
// 開立營業人＝提供服務／出貨分店之 LegalEntity；金額明細由 einvoiceRules 計算
// 一律於收款交易提交後呼叫；失敗寫 FAILED 並由佇列重試，禁止因開票失敗沖回已收款
import prisma from './prisma.js';
import {
  issueInvoice,
  voidInvoice,
  issueAllowance,
  searchInvoiceByNumber,
  searchInvoiceByOrderNo,
  normalizeInvoiceOptions,
  sanitizeInvalidReason,
  EZPAY_NON_RETRYABLE_STATUSES,
  EZPAY_DUPLICATE_ORDER_STATUS,
} from './ezpay.js';
import {
  buildAllowanceLines,
  computeInvoiceDrafts,
  singleLine,
  splitAllowanceAmount,
  invoicePeriodKey,
} from './einvoiceRules.js';
import { resolveMerchant } from './legalEntity.js';
import { recordInvoiceAllowance, toPrintableAllowance } from './invoiceAllowance.js';

const MAX_AUTO_RETRY = 8;
const RETRY_BASE_MS = 30_000;
const STALE_ISSUING_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export const OPEN_STATUSES = ['PENDING', 'ISSUING', 'ISSUED', 'FAILED'];
const CLOSED_STATUSES = ['VOIDED', 'CANCELLED'];

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function genEInvoiceId() {
  const d = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  return `EIV${d}${Math.floor(100000 + Math.random() * 900000)}${Math.floor(Math.random() * 10)}`;
}

function buildMerchantOrderNo(refId, suffix, seq) {
  const base = String(refId || '').replace(/[^A-Za-z0-9_]/g, '');
  const tail = `${suffix ? 'F' : ''}${seq > 1 ? `R${seq}` : ''}`;
  return `${base.slice(0, 20 - tail.length)}${tail}`;
}

// ─────────────────────────────────────────────────────────────
// 買受人選項（交易當下保存；CHK 子單繼承 CHK）
// ─────────────────────────────────────────────────────────────

/**
 * 保存開票請求（已正規化之 carrierNum／buyerUbn／loveCode）；全空則不寫
 */
export async function saveInvoiceRequest(db, { refType, refId, buyerName, buyerEmail, carrierNum, buyerUbn, loveCode }) {
  const id = String(refId || '').trim();
  if (!id) return null;
  if (!carrierNum && !buyerUbn && !loveCode && !buyerEmail && !buyerName) return null;
  const data = {
    refType: String(refType || 'ORDER').toUpperCase(),
    buyerName: buyerName ? String(buyerName).slice(0, 60) : null,
    buyerEmail: buyerEmail ? String(buyerEmail).slice(0, 50) : null,
    carrierNum: carrierNum || null,
    buyerUbn: buyerUbn || null,
    loveCode: loveCode || null,
  };
  return (db || prisma).invoiceRequest.upsert({
    where: { refId: id },
    create: { refId: id, ...data },
    update: data,
  });
}

export async function getInvoiceRequest(refId, db = prisma) {
  if (!refId) return null;
  return db.invoiceRequest.findUnique({ where: { refId: String(refId) } });
}

/** 已保存之買受人選項（供回應顯示） */
export async function invoiceRequestFor(refId, checkoutSessionId = null, db = prisma) {
  return (await getInvoiceRequest(refId, db)) || (checkoutSessionId ? await getInvoiceRequest(checkoutSessionId, db) : null);
}

// ─────────────────────────────────────────────────────────────
// 開立
// ─────────────────────────────────────────────────────────────

const timers = new Map();

export function scheduleEInvoice(id, delayMs = 1500) {
  if (!id || timers.has(id)) return;
  const t = setTimeout(() => {
    timers.delete(id);
    processEInvoice(id).catch((err) => console.error('[einvoice]', id, err.message));
  }, Math.max(0, delayMs));
  t.unref?.();
  timers.set(id, t);
}

// ─────────────────────────────────────────────────────────────
// ezPay 呼叫紀錄（總部查錯用；寫入失敗不得影響開票流程）
// ─────────────────────────────────────────────────────────────

/** 重送不會成功、需人工處理者：不自動重試 */
const NON_RETRYABLE_CODES = new Set([
  'EZPAY_MERCHANT_NOT_CONFIGURED',
  'EZPAY_MERCHANT_KEY_INVALID',
  'EZPAY_CHECKCODE_MISMATCH',
  'EINVOICE_AMOUNT_INVALID',
  'EZPAY_REMOTE_VOIDED',
  'LEGAL_ENTITY_INACTIVE',
]);

function isRetryable(err) {
  if (NON_RETRYABLE_CODES.has(err?.code)) return false;
  return !(err?.ezpayStatus && EZPAY_NON_RETRYABLE_STATUSES.has(err.ezpayStatus));
}

export async function writeEInvoiceLog(entry) {
  try {
    await prisma.eInvoiceLog.create({
      data: {
        einvoiceId: entry.einvoiceId ?? null,
        refId: entry.refId ?? null,
        legalEntityId: entry.legalEntityId ?? null,
        merchantId: entry.merchantId ?? null,
        action: entry.action,
        result: entry.result,
        attempt: entry.attempt ?? null,
        manual: Boolean(entry.manual),
        staffId: entry.staffId ?? null,
        errorCode: entry.errorCode ? String(entry.errorCode).slice(0, 60) : null,
        ezpayStatus: entry.ezpayStatus ? String(entry.ezpayStatus).slice(0, 30) : null,
        message: entry.message ? String(entry.message).slice(0, 500) : null,
        invoiceNumber: entry.invoiceNumber ?? null,
        durationMs: Number.isFinite(entry.durationMs) ? Math.round(entry.durationMs) : null,
      },
    });
  } catch (e) {
    console.error('[einvoice] 寫入呼叫紀錄失敗:', e.message);
  }
}

/** 執行一次 ezPay 呼叫並記錄結果；失敗原樣拋出（err.logged=true） */
async function loggedCall(ctx, action, fn, { describe } = {}) {
  const started = Date.now();
  try {
    const out = await fn();
    const d = describe ? describe(out) : {};
    await writeEInvoiceLog({ ...ctx, action, durationMs: Date.now() - started, result: 'SUCCESS', ...d });
    return out;
  } catch (err) {
    await writeEInvoiceLog({
      ...ctx,
      action,
      result: 'FAILED',
      durationMs: Date.now() - started,
      errorCode: err.code || null,
      ezpayStatus: err.ezpayStatus || null,
      message: err.message,
    });
    err.logged = true;
    throw err;
  }
}

async function resolveRowEntity(row) {
  let entity = row.legalEntity;
  if (!entity && row.branchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: row.branchId },
      select: { legalEntity: true },
    });
    entity = branch?.legalEntity || null;
    if (entity) {
      await prisma.eInvoice.update({ where: { id: row.id }, data: { legalEntityId: entity.id } });
    }
  }
  if (!entity) {
    throw httpError(409, 'LEGAL_ENTITY_REQUIRED', '提供服務分店尚未綁定營業人（統編），請總部設定後重試');
  }
  if (!entity.isActive) {
    throw httpError(409, 'LEGAL_ENTITY_INACTIVE', `營業人「${entity.name}」已停用`);
  }
  return entity;
}

/**
 * 查詢 ezPay 是否已以本張自訂編號開立（逾時／中斷／自訂編號重覆後補登）
 * @returns {Promise<object|null>} 已開立結果；查無回 null
 */
async function recoverIssued(row, merchant, ctx) {
  const found = await loggedCall(
    ctx,
    'RECOVER',
    () => searchInvoiceByOrderNo(merchant, { merchantOrderNo: row.merchantOrderNo, totalAmount: row.totalAmount }),
    {
      describe: (r) =>
        r
          ? { invoiceNumber: r.invoiceNumber, ezpayStatus: r.ezpayStatus, message: r.warning || '查得已開立發票，補登號碼' }
          : { result: 'NOT_FOUND', message: 'ezPay 查無此自訂編號，將重新開立' },
    },
  );
  if (found && found.invoiceStatus === '2') {
    throw httpError(
      409,
      'EZPAY_REMOTE_VOIDED',
      `ezPay 顯示自訂編號 ${row.merchantOrderNo} 之發票 ${found.invoiceNumber} 已作廢，請人工確認後處理`,
    );
  }
  return found;
}

/**
 * 處理一張待開／失敗發票（搶占 ISSUING 防重送）
 * 流程：解析營業人商店 →（重試時先查詢補登）→ 開立 → 寫回發票號碼／隨機碼；每次 ezPay 呼叫寫 EInvoiceLog
 * @returns {Promise<object|null>} 最新 EInvoice
 */
export async function processEInvoice(id, { manual = false, staffId = null } = {}) {
  const claimed = await prisma.eInvoice.updateMany({
    where: { id, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'ISSUING', retryCount: { increment: 1 }, nextRetryAt: null },
  });
  if (!claimed.count) {
    return prisma.eInvoice.findUnique({ where: { id } });
  }
  const row = await prisma.eInvoice.findUnique({
    where: { id },
    include: { items: { orderBy: { lineNo: 'asc' } }, legalEntity: true },
  });
  const attempt = row.retryCount;
  const ctx = { einvoiceId: row.id, refId: row.refId, legalEntityId: row.legalEntityId, attempt, manual, staffId };

  try {
    const entity = await resolveRowEntity(row);
    const merchant = resolveMerchant(entity);
    Object.assign(ctx, { legalEntityId: entity.id, merchantId: merchant.merchantId || null });

    let result = attempt > 1 ? await recoverIssued(row, merchant, ctx) : null;
    if (!result) {
      try {
        result = await loggedCall(ctx, 'ISSUE', () => issueInvoice(merchant, row), {
          describe: (r) => ({ invoiceNumber: r.invoiceNumber, ezpayStatus: r.ezpayStatus, message: r.warning || r.ezpayMessage }),
        });
      } catch (err) {
        if (err.ezpayStatus !== EZPAY_DUPLICATE_ORDER_STATUS) throw err;
        result = await recoverIssued(row, merchant, ctx);
        if (!result) throw err;
      }
    }

    const issuedAt = new Date();
    const updated = await prisma.eInvoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        invoiceNumber: result.invoiceNumber,
        randomNum: result.randomNum,
        ezpayTransNo: result.transNo,
        issuedAt,
        periodKey: invoicePeriodKey(issuedAt),
        lastError: null,
        nextRetryAt: null,
      },
    });
    console.log(`🧾 [${entity.code}] ${row.refId}/${row.leg} → ${result.invoiceNumber} $${row.totalAmount}`);
    return updated;
  } catch (err) {
    if (!err.logged) {
      await writeEInvoiceLog({
        ...ctx,
        action: 'ISSUE',
        result: 'FAILED',
        errorCode: err.code || null,
        ezpayStatus: err.ezpayStatus || null,
        message: err.message,
      });
    }
    const auto = attempt < MAX_AUTO_RETRY && isRetryable(err);
    const delay = RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 6);
    const updated = await prisma.eInvoice.update({
      where: { id },
      data: {
        status: 'FAILED',
        lastError: String(err.message || err).slice(0, 500),
        nextRetryAt: auto ? new Date(Date.now() + delay) : null,
      },
    });
    console.error(
      `❌ 發票 ${row.refId}/${row.leg} 開立失敗（第 ${attempt} 次${manual ? '／手動' : ''}${auto ? '' : '／不自動重試'}）：${err.message}`,
    );
    if (auto) scheduleEInvoice(id, delay);
    return updated;
  }
}

/**
 * 對單據一腿開立發票（應稅／免稅自動分張）；從不拋錯（呼叫端已收款）
 * @param {{
 *   refType: 'ORDER'|'SALE'|'CHECKOUT', refId: string, leg?: string, branchId: number|null,
 *   checkoutSessionId?: string|null, memberId?: number|null,
 *   lines: Array<{ name, qty, unitPrice, taxType?, productId?, unit? }>,
 *   buyer?: { buyerName?, buyerEmail?, carrierNum?, buyerUbn?, loveCode? }|null,
 *   buyerName?: string|null,
 * }} input
 * @returns {Promise<{ ok: boolean, partial: boolean, code: 'OK'|'PARTIAL_INVOICE'|'SKIPPED', invoiceNumber: string|null, invoices: object[], message?: string }>}
 */
export async function issueForRef(input) {
  const refId = String(input.refId || '').trim();
  const leg = String(input.leg || 'ALL').toUpperCase();
  const refType = String(input.refType || 'ORDER').toUpperCase();
  try {
    const req = input.buyer || (await invoiceRequestFor(refId, input.checkoutSessionId));
    const opts = normalizeInvoiceOptions({
      carrierNum: req?.carrierNum,
      buyerUbn: req?.buyerUbn,
      loveCode: req?.loveCode,
    });
    const buyerName = req?.buyerName || input.buyerName || null;
    const buyerEmail = req?.buyerEmail || null;
    const drafts = computeInvoiceDrafts({ lines: input.lines, buyer: opts });
    if (!drafts.length) {
      return { ok: true, partial: false, code: 'SKIPPED', invoiceNumber: null, invoices: [] };
    }

    let entityId = null;
    if (input.branchId) {
      const branch = await prisma.branch.findUnique({
        where: { id: Number(input.branchId) },
        select: { legalEntityId: true },
      });
      entityId = branch?.legalEntityId ?? null;
    }

    const results = [];
    for (const d of drafts) {
      const legKey = d.suffix ? `${leg}_${d.suffix}` : leg;
      let row = await prisma.eInvoice.findFirst({
        where: { refType, refId, leg: legKey, status: { in: OPEN_STATUSES } },
      });
      if (!row) {
        const seq =
          (await prisma.eInvoice.count({ where: { refType, refId, leg: legKey } })) + 1;
        try {
          row = await prisma.eInvoice.create({
            data: {
              id: genEInvoiceId(),
              legalEntityId: entityId,
              branchId: input.branchId ? Number(input.branchId) : null,
              refType,
              refId,
              leg: legKey,
              seq,
              checkoutSessionId: input.checkoutSessionId || null,
              memberId: input.memberId ?? null,
              merchantOrderNo: buildMerchantOrderNo(refId, d.suffix, seq),
              category: d.category,
              buyerName: buyerName ? String(buyerName).slice(0, 60) : null,
              buyerUbn: d.category === 'B2B' ? opts.buyerUbn : null,
              buyerEmail,
              carrierType: d.carrierType,
              carrierNum: d.carrierNum,
              loveCode: d.loveCode,
              printFlag: d.printFlag,
              taxType: d.taxType,
              taxRate: d.taxRate,
              salesAmount: d.salesAmount,
              taxAmount: d.taxAmount,
              totalAmount: d.totalAmount,
              itemDesc: d.itemDesc,
              status: 'PENDING',
              items: {
                create: d.items.map((it, i) => ({
                  lineNo: i + 1,
                  name: it.name,
                  qty: it.qty,
                  unit: it.unit,
                  unitPrice: it.unitPrice,
                  amount: it.amount,
                  taxType: it.taxType,
                  productId: it.productId,
                  saleItemId: it.saleItemId ?? null,
                })),
              },
            },
          });
        } catch (e) {
          if (e.code !== 'P2002') throw e;
          row = await prisma.eInvoice.findFirst({
            where: { refType, refId, leg: legKey, status: { in: OPEN_STATUSES } },
          });
          if (!row) throw e;
        }
      }
      if (row.status === 'PENDING' || row.status === 'FAILED') {
        row = (await processEInvoice(row.id)) || row;
      }
      results.push(row);
    }

    const partial = results.some((r) => r.status !== 'ISSUED');
    return {
      ok: !partial,
      partial,
      code: partial ? 'PARTIAL_INVOICE' : 'OK',
      invoiceNumber: results.find((r) => r.invoiceNumber)?.invoiceNumber || null,
      invoices: results.map(serializeEInvoiceBrief),
      message: partial ? results.find((r) => r.lastError)?.lastError || '發票開立中' : undefined,
    };
  } catch (err) {
    console.error(`❌ 發票草稿建立失敗 ${refType} ${refId}/${leg}:`, err.message);
    await writeEInvoiceLog({
      refId,
      action: 'ISSUE',
      result: 'FAILED',
      errorCode: err.code && !String(err.code).startsWith('P') ? err.code : 'EINVOICE_DRAFT_FAILED',
      message: `發票草稿建立失敗（${leg}）：${err.message}`,
    });
    return {
      ok: false,
      partial: true,
      code: 'PARTIAL_INVOICE',
      invoiceNumber: null,
      invoices: [],
      message: err.message,
    };
  }
}

/** 銷貨單開票（明細＝SaleItem；CHK 子單 leg=SALE） */
export async function issueSaleInvoice(saleId, { buyerName = null } = {}) {
  const sale = await prisma.saleOrder.findUnique({
    where: { id: String(saleId) },
    include: {
      items: { include: { product: { select: { invoiceName: true, unit: true } } } },
      member: { select: { name: true } },
    },
  });
  if (!sale || sale.status !== 'PAID') {
    return { ok: false, partial: false, code: 'SKIPPED', invoiceNumber: null, invoices: [] };
  }
  return issueForRef({
    refType: 'SALE',
    refId: sale.id,
    leg: sale.checkoutSessionId ? 'SALE' : 'ALL',
    branchId: sale.branchId,
    checkoutSessionId: sale.checkoutSessionId,
    memberId: sale.memberId,
    buyerName: buyerName || sale.member?.name || null,
    lines: sale.items.map((it) => ({
      name: it.product?.invoiceName || it.name,
      qty: it.qty,
      unitPrice: it.unitPrice,
      taxType: it.taxType,
      productId: it.productId,
      saleItemId: it.id,
      unit: it.product?.unit || '個',
    })),
  });
}

/** CHK 子單之腿名 */
export function orderLegOf(order, session = null) {
  if (!order.checkoutSessionId) return 'ALL';
  if (String(order.id).startsWith('GRP')) return 'GROUP';
  if (session?.orderId && session.orderId === order.id) return 'PROMO';
  if (String(order.itemDesc || '').includes('私教')) return 'PT';
  return 'PROMO';
}

/** Order 之提供服務分店：order.branchId → CHK 分店 → 會員所屬第一間分店 */
export async function resolveOrderBranchId(order, db = prisma) {
  if (order.branchId) return order.branchId;
  if (order.checkoutSessionId) {
    const s = await db.checkoutSession.findUnique({
      where: { id: order.checkoutSessionId },
      select: { branchId: true },
    });
    if (s?.branchId) return s.branchId;
  }
  const mb = await db.memberBranch.findFirst({
    where: { memberId: order.memberId },
    orderBy: { branchId: 'asc' },
    select: { branchId: true },
  });
  return mb?.branchId ?? null;
}

/** 購案／私教／團課／訂閱 Order 開票（單行明細） */
export async function issueOrderInvoice(orderId, { buyerName = null, leg = null, itemName = null } = {}) {
  const order = await prisma.order.findUnique({
    where: { id: String(orderId) },
    include: { member: { select: { name: true } } },
  });
  if (!order || order.status !== 'PAID') {
    return { ok: false, partial: false, code: 'SKIPPED', invoiceNumber: null, invoices: [] };
  }
  const session = order.checkoutSessionId
    ? await prisma.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } })
    : null;
  return issueForRef({
    refType: 'ORDER',
    refId: order.id,
    leg: leg || orderLegOf(order, session),
    branchId: await resolveOrderBranchId(order),
    checkoutSessionId: order.checkoutSessionId,
    memberId: order.memberId,
    buyerName: buyerName || order.member?.name || null,
    lines: singleLine(itemName || order.itemDesc, order.amount),
  });
}

/**
 * 合併結帳：各子單分腿開立（SAL／購案／私教／團課各自營業人）
 * @returns {{ invoices, invoiceNumber, invoiceJobs, partial, code }}
 */
export async function issueCheckoutInvoices(checkoutId) {
  const session = await prisma.checkoutSession.findUnique({ where: { id: String(checkoutId || '') } });
  if (!session) {
    return { invoices: [], invoiceNumber: null, invoiceJobs: [], partial: false, code: null };
  }
  const results = [];
  const push = (leg, id, r) => {
    for (const inv of r.invoices) results.push({ leg, id, ...inv, ok: inv.status === 'ISSUED' });
    if (!r.invoices.length && r.code === 'PARTIAL_INVOICE') {
      results.push({ leg, id, ok: false, status: 'FAILED', invoiceNumber: null, message: r.message });
    }
  };

  if (session.saleOrderId) {
    push('SALE', session.saleOrderId, await issueSaleInvoice(session.saleOrderId));
  }
  const orders = await prisma.order.findMany({
    where: {
      status: 'PAID',
      OR: [{ checkoutSessionId: session.id }, ...(session.orderId ? [{ id: session.orderId }] : [])],
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const o of orders) {
    const leg = orderLegOf({ ...o, checkoutSessionId: o.checkoutSessionId || session.id }, session);
    push(leg, o.id, await issueOrderInvoice(o.id, { leg }));
  }

  const partial = results.some((r) => !r.ok);
  return {
    invoices: results,
    invoiceNumber: results.find((r) => r.invoiceNumber)?.invoiceNumber || null,
    invoiceJobs: results.filter((r) => !r.ok),
    partial,
    code: partial ? 'PARTIAL_INVOICE' : results.length ? 'OK' : null,
  };
}

/** 交易取消且發票尚未開立：關閉草稿（不呼叫 ezPay） */
export async function cancelUnissuedInvoices(refId, reason = '交易取消', db = prisma) {
  return db.eInvoice.updateMany({
    where: { refId: String(refId), status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'CANCELLED', voidReason: String(reason).slice(0, 100), voidedAt: new Date(), nextRetryAt: null },
  });
}

// ─────────────────────────────────────────────────────────────
// 作廢／折讓（依發票號找營業人憑證）
// ─────────────────────────────────────────────────────────────

async function loadIssuedByNumber(invoiceNumber) {
  const inv = String(invoiceNumber || '').trim().toUpperCase();
  const row = await prisma.eInvoice.findUnique({
    where: { invoiceNumber: inv },
    include: { legalEntity: true },
  });
  if (!row) throw httpError(404, 'INVOICE_NOT_FOUND', `找不到發票 ${inv}`);
  if (row.status !== 'ISSUED') {
    throw httpError(409, 'INVOICE_NOT_ISSUED', `發票 ${inv} 狀態為 ${row.status}，無法作廢／折讓`);
  }
  if (!row.legalEntity) throw httpError(409, 'LEGAL_ENTITY_REQUIRED', `發票 ${inv} 缺少營業人`);
  return row;
}

const isAmbiguousEzpayError = (err) => err?.code === 'EZPAY_NETWORK' || err?.code === 'EZPAY_BAD_RESPONSE';

/** 作廢前對帳：有 4 碼隨機碼走 SearchType 0（發票號＋隨機碼），否則 SearchType 1（自訂編號＋金額） */
function searchRemoteForReversal(merchant, row) {
  const rnd = String(row.randomNum || '').trim();
  if (/^\d{4}$/.test(rnd)) {
    return searchInvoiceByNumber(merchant, {
      invoiceNumber: row.invoiceNumber,
      randomNum: rnd,
      merchantOrderNo: row.merchantOrderNo,
      totalAmount: row.totalAmount,
    });
  }
  return searchInvoiceByOrderNo(merchant, { merchantOrderNo: row.merchantOrderNo, totalAmount: row.totalAmount });
}

/**
 * 作廢已開立發票。連線逾時／回應異常標 err.ambiguous（ezPay 可能已作廢）；
 * checkRemoteFirst：上次結果不明時，先以 invoice_search 查詢，遠端已作廢（InvoiceStatus=2）即只同步本地、不再呼叫作廢
 */
export async function voidEInvoice(invoiceNumber, { reason, staffId = null, checkRemoteFirst = false } = {}) {
  const row = await loadIssuedByNumber(invoiceNumber);
  if (row.allowanceTotal > 0) {
    throw httpError(409, 'INVOICE_HAS_ALLOWANCE', `發票 ${row.invoiceNumber} 已有折讓，不可作廢`);
  }
  if (row.periodKey && row.periodKey !== invoicePeriodKey(new Date())) {
    throw httpError(409, 'INVOICE_CROSS_PERIOD', `發票 ${row.invoiceNumber} 非當期（${row.periodKey}），不可作廢，請改開折讓`);
  }
  const merchant = resolveMerchant(row.legalEntity);
  const ctx = { einvoiceId: row.id, refId: row.refId, legalEntityId: row.legalEntityId, merchantId: merchant.merchantId, staffId };
  let res = null;
  try {
    if (checkRemoteFirst) {
      const found = await loggedCall(
        ctx,
        'RECOVER',
        () => searchRemoteForReversal(merchant, row),
        { describe: (r) => ({ invoiceNumber: r?.invoiceNumber || row.invoiceNumber, message: `作廢前查詢：InvoiceStatus=${r?.invoiceStatus ?? '查無'}` }) },
      );
      if (found?.invoiceStatus === '2' && found.invoiceNumber === row.invoiceNumber) {
        res = { invoiceNumber: row.invoiceNumber, createTime: null, remoteAlreadyVoided: true, transNo: found.transNo || null };
      }
    }
    if (!res) {
      res = await loggedCall(
        ctx,
        'VOID',
        () => voidInvoice(merchant, { invoiceNumber: row.invoiceNumber, reason }),
        { describe: (r) => ({ invoiceNumber: r.invoiceNumber, message: sanitizeInvalidReason(reason, '交易取消') }) },
      );
    }
  } catch (err) {
    if (isAmbiguousEzpayError(err)) err.ambiguous = true;
    throw err;
  }
  await prisma.eInvoice.update({
    where: { id: row.id },
    data: {
      status: 'VOIDED',
      voidedAt: new Date(),
      voidReason: sanitizeInvalidReason(reason, '交易取消'),
      voidedByStaffId: staffId ?? null,
      ...(res.transNo ? { ezpayTransNo: res.transNo } : {}),
    },
  });
  return { ...res, einvoice: row };
}

/** 折讓成立後：累計發票明細已折數量／金額＋寫入 InvoiceAllowance（strict 時紀錄失敗即拋出） */
async function bookAllowance(row, res, parts, lines, { itemDesc, buyerEmail, staffId, context, strict = false }) {
  if (lines) {
    for (const it of lines) {
      if (!it.einvoiceItemId) continue;
      await prisma.eInvoiceItem
        .update({
          where: { id: it.einvoiceItemId },
          data: { allowedQty: { increment: it.returnQty || it.qty }, allowedAmount: { increment: it.grossAmount } },
        })
        .catch((e) => console.error(`發票明細 #${it.einvoiceItemId} 折讓累計失敗:`, e.message));
    }
  }
  try {
    return await recordInvoiceAllowance(prisma, {
      einvoice: row,
      result: res,
      parts,
      itemDesc,
      buyerEmail,
      items: lines,
      context: { ...context, staffId: context.staffId ?? staffId },
    });
  } catch (recErr) {
    if (strict) throw recErr;
    console.error(`折讓單 ${res.allowanceNo}（發票 ${row.invoiceNumber}）紀錄寫入失敗，請人工補登:`, recErr.message);
    return null;
  }
}

/**
 * 開立折讓；先以條件式遞增預占 allowanceTotal（防並發超折），ezPay 失敗即釋放；成功後寫入 InvoiceAllowance＋明細
 * items 有值時依 buildAllowanceLines 逐品項計算未稅／稅額；否則以 amount 單一品項（舊呼叫端相容）
 * 網路逾時／回應異常（ezPay 可能已開立）標記 err.ambiguous；holdOnAmbiguous 時**不釋放預占**，
 * 改以 err.heldAllowance 帶出預占內容，須經 settleHeldAllowance（已開立補登）或 releaseHeldAllowance（確認未開立）處置
 * @param {{ amount?, items?: Array<{ name, qty, unit?, gross, einvoiceItemId?, saleItemId? }>, itemDesc?, buyerEmail?, staffId?,
 *   holdOnAmbiguous?: boolean,
 *   context?: { source?, orderId?, saleOrderId?, memberId?, refundId?, subOrderId?, reason? } }} opts
 */
export async function allowanceEInvoice(
  invoiceNumber,
  { amount, items = null, itemDesc, buyerEmail, staffId = null, holdOnAmbiguous = false, context = {} } = {},
) {
  const row = await loadIssuedByNumber(invoiceNumber);
  let parts;
  let lines = null;
  if (items?.length) {
    const prior = await prisma.invoiceAllowance.aggregate({
      where: { einvoiceId: row.id, status: 'ISSUED' },
      _sum: { untaxedAmt: true, taxAmt: true },
    });
    const built = buildAllowanceLines({
      invoice: row,
      prior: { untaxed: prior._sum.untaxedAmt || 0, tax: prior._sum.taxAmt || 0 },
      lines: items,
    });
    parts = { total: built.total, untaxed: built.untaxed, tax: built.tax };
    lines = built.items;
  } else {
    parts = splitAllowanceAmount(amount, row.taxType);
  }

  const reserved = await prisma.eInvoice.updateMany({
    where: { id: row.id, status: 'ISSUED', allowanceTotal: { lte: row.totalAmount - parts.total } },
    data: { allowanceTotal: { increment: parts.total } },
  });
  if (!reserved.count) {
    const fresh = await prisma.eInvoice.findUnique({ where: { id: row.id }, select: { totalAmount: true, allowanceTotal: true } });
    throw httpError(
      409,
      'ALLOWANCE_EXCEEDS_INVOICE',
      `折讓金額超過發票剩餘可折讓額（剩 $${(fresh?.totalAmount ?? 0) - (fresh?.allowanceTotal ?? 0)}）`,
    );
  }

  const merchant = resolveMerchant(row.legalEntity);
  let res;
  try {
    res = await loggedCall(
      { einvoiceId: row.id, refId: row.refId, legalEntityId: row.legalEntityId, merchantId: merchant.merchantId, staffId },
      'ALLOWANCE',
      () =>
        issueAllowance(merchant, {
          invoiceNumber: row.invoiceNumber,
          merchantOrderNo: row.merchantOrderNo,
          itemDesc,
          untaxed: parts.untaxed,
          tax: parts.tax,
          total: parts.total,
          taxType: row.taxType,
          buyerEmail: buyerEmail || row.buyerEmail || undefined,
          items: lines,
        }),
      { describe: (r) => ({ invoiceNumber: r.invoiceNumber, message: `折讓 ${r.allowanceNo} $${parts.total}` }) },
    );
  } catch (err) {
    const email = buyerEmail || row.buyerEmail || null;
    if (isAmbiguousEzpayError(err)) {
      err.ambiguous = true;
      if (holdOnAmbiguous) {
        err.heldAllowance = { einvoiceId: row.id, invoiceNumber: row.invoiceNumber, ...parts, items: lines, itemDesc: itemDesc ?? null, buyerEmail: email };
        throw err;
      }
    }
    await prisma.eInvoice
      .update({ where: { id: row.id }, data: { allowanceTotal: { decrement: parts.total } } })
      .catch((e) => console.error(`發票 ${row.invoiceNumber} 折讓預占釋放失敗，請人工核對:`, e.message));
    throw err;
  }

  const record = await bookAllowance(row, res, parts, lines, {
    itemDesc,
    buyerEmail: buyerEmail || row.buyerEmail || null,
    staffId,
    context,
  });
  return { ...res, untaxed: parts.untaxed, tax: parts.tax, einvoice: row, record };
}

const ALLOWANCE_NO_RE = /^[A-Z0-9]{6,20}$/;

/**
 * 結果不明之折讓經人工核對 ezPay 後台「已開立」：以預占內容補登折讓號（預占即為此筆，不再遞增 allowanceTotal）
 * @param {{ einvoiceId, invoiceNumber, total, untaxed, tax, items, itemDesc, buyerEmail }} held  allowanceEInvoice 之 err.heldAllowance
 */
export async function settleHeldAllowance(held, { allowanceNo, staffId = null, context = {} } = {}) {
  const no = String(allowanceNo || '').trim().toUpperCase();
  if (!ALLOWANCE_NO_RE.test(no)) throw httpError(400, 'ALLOWANCE_NO_INVALID', '折讓號須為 6～20 碼英數字（依 ezPay 後台所示）');
  const row = await loadIssuedByNumber(held.invoiceNumber);
  if (row.id !== held.einvoiceId) throw httpError(409, 'INVOICE_MISMATCH', '發票與預占紀錄不符，請洽總部');
  const taken = await prisma.invoiceAllowance.findUnique({ where: { allowanceNo: no }, select: { id: true } });
  if (taken) throw httpError(409, 'ALLOWANCE_NO_TAKEN', `折讓號 ${no} 已登錄於其他折讓單`);

  const parts = { total: held.total, untaxed: held.untaxed, tax: held.tax };
  const res = { allowanceNo: no, allowanceAmt: held.total, remainAmt: null, invoiceNumber: row.invoiceNumber, merchantOrderNo: row.merchantOrderNo };
  const record = await bookAllowance(row, res, parts, held.items || null, {
    itemDesc: held.itemDesc,
    buyerEmail: held.buyerEmail,
    staffId,
    context,
    strict: true,
  });
  await writeEInvoiceLog({
    einvoiceId: row.id,
    refId: row.refId,
    legalEntityId: row.legalEntityId,
    action: 'ALLOWANCE',
    result: 'SUCCESS',
    manual: true,
    staffId,
    invoiceNumber: row.invoiceNumber,
    message: `人工補登折讓號 ${no} $${held.total}（原呼叫結果不明）`,
  });
  return { ...res, untaxed: parts.untaxed, tax: parts.tax, einvoice: row, record };
}

/**
 * 結果不明之折讓經人工核對「未開立」：條件式釋放預占（不得扣成負數）
 * 須與呼叫端清除預占紀錄同一交易（db＝tx），避免重送時重複釋放；呼叫紀錄由呼叫端提交後寫 writeEInvoiceLog
 */
export async function releaseHeldAllowance(db, held) {
  const out = await db.eInvoice.updateMany({
    where: { id: held.einvoiceId, allowanceTotal: { gte: held.total } },
    data: { allowanceTotal: { decrement: held.total } },
  });
  if (!out.count) throw httpError(409, 'ALLOWANCE_RESERVATION_MISSING', '找不到可釋放之折讓預占，請洽總部核對');
}

/**
 * 反向已開立發票：prefer='void' 先作廢、失敗改全額折讓；prefer='allowance' 直接折讓
 * 回傳形狀與舊 reverseIssuedInvoice 相容，另帶 einvoiceId／legalEntity；折讓另帶 slip（可列印折讓單）
 * @param {{ allowanceContext?: { source?, orderId?, saleOrderId?, memberId? } }} opts
 */
export async function reverseEInvoice({
  invoiceNumber,
  itemDesc,
  amount,
  reason,
  prefer = 'void',
  buyerEmail,
  staffId = null,
  allowanceContext = {},
} = {}) {
  const inv = String(invoiceNumber || '').trim();
  if (!inv) return { action: 'none', invoiceNumber: null };
  const email = buyerEmail ? String(buyerEmail).trim().slice(0, 50) : null;

  const allowance = async (voidError = null) => {
    const a = await allowanceEInvoice(inv, { amount, itemDesc, buyerEmail: email, staffId, context: allowanceContext });
    return {
      action: 'allowance',
      invoiceNumber: a.invoiceNumber,
      allowanceNo: a.allowanceNo,
      allowanceAmt: a.allowanceAmt,
      untaxedAmt: a.untaxed,
      taxAmt: a.tax,
      remainAmt: a.remainAmt,
      merchantOrderNo: a.merchantOrderNo,
      buyerEmail: email,
      itemDesc: itemDesc || null,
      reason: sanitizeInvalidReason(reason, voidError ? '交易取消' : '退費折讓'),
      einvoiceId: a.einvoice.id,
      legalEntity: a.einvoice.legalEntity,
      slip: toPrintableAllowance(a.record),
      ...(voidError ? { voidError } : {}),
    };
  };

  if (prefer === 'allowance') return allowance();

  try {
    const v = await voidEInvoice(inv, { reason, staffId });
    return {
      action: 'void',
      invoiceNumber: v.invoiceNumber,
      createTime: v.createTime,
      reason: sanitizeInvalidReason(reason, '交易取消'),
      einvoiceId: v.einvoice.id,
      legalEntity: v.einvoice.legalEntity,
    };
  } catch (voidErr) {
    if (voidErr.code === 'INVOICE_NOT_FOUND' || voidErr.code === 'INVOICE_NOT_ISSUED') throw voidErr;
    console.warn(`ezPay 作廢 ${inv} 失敗，改開立折讓：`, voidErr.message);
    return allowance(voidErr.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 查詢／顯示
// ─────────────────────────────────────────────────────────────

export function serializeEInvoiceBrief(row) {
  if (!row) return null;
  return {
    id: row.id,
    refType: row.refType,
    refId: row.refId,
    leg: row.leg,
    status: row.status,
    invoiceNumber: row.invoiceNumber || null,
    randomNum: row.randomNum || null,
    category: row.category,
    totalAmount: row.totalAmount,
    allowanceTotal: row.allowanceTotal ?? 0,
    issuedAt: row.issuedAt ?? null,
    legalEntityId: row.legalEntityId ?? null,
    lastError: row.lastError || null,
  };
}

/** 多張發票彙總成舊介面欄位（invoiceNumber 逗號串、invoiceStatus） */
export function summarizeInvoices(rows) {
  const list = rows || [];
  if (!list.length) return { invoiceNumber: null, invoiceStatus: null, invoices: [] };
  const open = list.filter((r) => !CLOSED_STATUSES.includes(r.status));
  let status;
  let numbers;
  if (!open.length) {
    status = list.some((r) => r.status === 'VOIDED') ? 'VOIDED' : 'CANCELLED';
    numbers = list.filter((r) => r.invoiceNumber).map((r) => r.invoiceNumber);
  } else {
    if (open.some((r) => r.status === 'FAILED')) status = 'FAILED';
    else if (open.some((r) => r.status === 'PENDING' || r.status === 'ISSUING')) status = 'PENDING';
    else status = 'ISSUED';
    numbers = open.filter((r) => r.invoiceNumber).map((r) => r.invoiceNumber);
  }
  return {
    invoiceNumber: numbers.length ? numbers.join(',') : null,
    invoiceStatus: status,
    invoices: list.map(serializeEInvoiceBrief),
  };
}

/** refId → 彙總（含 CHK：以 checkoutSessionId 彙總全部子腿） */
export async function invoiceSummaryMap(refIds, { bySession = false, db = prisma } = {}) {
  const ids = [...new Set((refIds || []).filter(Boolean).map(String))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = await db.eInvoice.findMany({
    where: bySession
      ? { OR: [{ checkoutSessionId: { in: ids } }, { refId: { in: ids } }] }
      : { refId: { in: ids } },
    orderBy: [{ createdAt: 'asc' }],
  });
  const groups = new Map();
  for (const r of rows) {
    const key = bySession ? r.checkoutSessionId || r.refId : r.refId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const id of ids) map.set(id, summarizeInvoices(groups.get(id) || []));
  return map;
}

/** 在列表資料上附加 invoiceNumber／invoiceStatus（不改 DB） */
export async function attachInvoiceSummary(rows, { key = 'id', bySession = false, db = prisma } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const map = await invoiceSummaryMap(
    list.map((r) => r?.[key]),
    { bySession, db },
  );
  const out = list.map((r) =>
    r ? { ...r, ...(map.get(String(r[key])) || { invoiceNumber: null, invoiceStatus: null, invoices: [] }) } : r,
  );
  return Array.isArray(rows) ? out : out[0];
}

/**
 * 報表／列表：附加發票摘要＋買受人選項（carrierNum／buyerUbn／loveCode，子單退回 CHK 請求）
 * @param {{ key?: string, sessionKey?: string|null, bySession?: boolean }} opts
 */
export async function attachInvoiceInfo(rows, { key = 'id', sessionKey = 'checkoutSessionId', bySession = false, db = prisma } = {}) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return Array.isArray(rows) ? [] : rows;
  const withSummary = await attachInvoiceSummary(list, { key, bySession, db });
  const reqIds = new Set();
  for (const r of list) {
    if (r[key]) reqIds.add(String(r[key]));
    if (sessionKey && r[sessionKey]) reqIds.add(String(r[sessionKey]));
  }
  const reqs = await db.invoiceRequest.findMany({ where: { refId: { in: [...reqIds] } } });
  const reqMap = new Map(reqs.map((q) => [q.refId, q]));
  const out = withSummary.map((r) => {
    const q = reqMap.get(String(r[key])) || (sessionKey && r[sessionKey] ? reqMap.get(String(r[sessionKey])) : null);
    return {
      ...r,
      carrierNum: q?.carrierNum || null,
      buyerUbn: q?.buyerUbn || null,
      loveCode: q?.loveCode || null,
    };
  });
  return Array.isArray(rows) ? out : out[0];
}

/** 發票號／載具關鍵字 → 相關單據 refId 與 CHK id（供列表搜尋） */
export async function refIdsMatchingInvoiceQuery(q, db = prisma) {
  const term = String(q || '').trim();
  if (!term) return [];
  const [invs, reqs] = await Promise.all([
    db.eInvoice.findMany({
      where: { invoiceNumber: { contains: term.toUpperCase() } },
      select: { refId: true, checkoutSessionId: true },
      take: 200,
    }),
    db.invoiceRequest.findMany({
      where: { carrierNum: { contains: term, mode: 'insensitive' } },
      select: { refId: true },
      take: 200,
    }),
  ]);
  const ids = new Set();
  for (const r of invs) {
    ids.add(r.refId);
    if (r.checkoutSessionId) ids.add(r.checkoutSessionId);
  }
  for (const r of reqs) ids.add(r.refId);
  return [...ids];
}

/** 單據目前有效（ISSUED）之發票；有多張時依 leg 篩 */
export async function issuedInvoiceFor(refId, { leg = null, db = prisma } = {}) {
  return db.eInvoice.findFirst({
    where: { refId: String(refId), status: 'ISSUED', ...(leg ? { leg } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

/** 依發票號找來源單據 */
export async function findInvoiceByNumber(invoiceNumber, db = prisma) {
  const inv = String(invoiceNumber || '').trim().toUpperCase();
  if (!inv) return null;
  return db.eInvoice.findUnique({ where: { invoiceNumber: inv }, include: { legalEntity: true } });
}

/** 失敗／待開清單（櫃檯補開／總部監控）；回傳與舊 InvoiceIssueJob 相容欄位 */
export async function listEInvoices({ status, branchIds = null, legalEntityId = null, checkoutId = null, take = 50 } = {}) {
  const s = status ? String(status).toUpperCase() : null;
  const statusWhere =
    s === 'SUCCESS' ? 'ISSUED' : s === 'PENDING' ? { in: ['PENDING', 'ISSUING'] } : s || undefined;
  const rows = await prisma.eInvoice.findMany({
    where: {
      ...(statusWhere ? { status: statusWhere } : {}),
      ...(Array.isArray(branchIds) ? { OR: [{ branchId: { in: branchIds } }, { branchId: null }] } : {}),
      ...(legalEntityId ? { legalEntityId: Number(legalEntityId) } : {}),
      ...(checkoutId ? { checkoutSessionId: String(checkoutId) } : {}),
    },
    include: { legalEntity: { select: { id: true, code: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(200, Number(take) || 50),
  });
  return rows.map(toJobShape);
}

export function toJobShape(r) {
  return {
    id: r.id,
    refType: r.refType,
    refId: r.refId,
    leg: r.leg,
    amount: r.totalAmount,
    itemDesc: r.itemDesc,
    category: r.category,
    status: r.status === 'ISSUED' ? 'SUCCESS' : r.status === 'ISSUING' ? 'PENDING' : r.status,
    einvoiceStatus: r.status,
    retryCount: r.retryCount,
    nextRetryAt: r.nextRetryAt,
    lastError: r.lastError,
    invoiceNumber: r.invoiceNumber,
    checkoutId: r.checkoutSessionId,
    branchId: r.branchId,
    legalEntity: r.legalEntity || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * ezPay 呼叫紀錄（總部查錯）
 * @param {{ einvoiceId?, result?, action?, legalEntityId?, from?: Date, to?: Date, take? }} q
 */
export async function listEInvoiceLogs({ einvoiceId = null, result = null, action = null, legalEntityId = null, from = null, to = null, take = 100 } = {}) {
  const rows = await prisma.eInvoiceLog.findMany({
    where: {
      ...(einvoiceId ? { einvoiceId: String(einvoiceId) } : {}),
      ...(result ? { result: String(result).toUpperCase() } : {}),
      ...(action ? { action: String(action).toUpperCase() } : {}),
      ...(legalEntityId ? { legalEntityId: Number(legalEntityId) } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    include: { einvoice: { select: { merchantOrderNo: true, leg: true, totalAmount: true, status: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, Number(take) || 100)),
  });
  return rows.map((r) => ({
    id: r.id,
    einvoiceId: r.einvoiceId,
    refId: r.refId,
    leg: r.einvoice?.leg ?? null,
    merchantOrderNo: r.einvoice?.merchantOrderNo ?? null,
    totalAmount: r.einvoice?.totalAmount ?? null,
    einvoiceStatus: r.einvoice?.status ?? null,
    legalEntityId: r.legalEntityId,
    merchantId: r.merchantId,
    action: r.action,
    result: r.result,
    attempt: r.attempt,
    manual: r.manual,
    staffId: r.staffId,
    errorCode: r.errorCode,
    ezpayStatus: r.ezpayStatus,
    message: r.message,
    invoiceNumber: r.invoiceNumber,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  }));
}

/** 手動補開（櫃檯／總部） */
export async function retryEInvoice(id, { staffId = null } = {}) {
  const row = await prisma.eInvoice.findUnique({ where: { id: String(id) } });
  if (!row) throw httpError(404, 'INVOICE_JOB_NOT_FOUND', '找不到發票任務');
  if (row.status === 'ISSUED') return toJobShape(row);
  if (row.status !== 'FAILED' && row.status !== 'PENDING') {
    throw httpError(409, 'INVOICE_NOT_RETRYABLE', `發票狀態 ${row.status} 不可重開`);
  }
  const updated = await processEInvoice(row.id, { manual: true, staffId });
  return toJobShape(updated || row);
}

// ─────────────────────────────────────────────────────────────
// 佇列：啟動補掃＋定期補掃（無 Redis）
// ─────────────────────────────────────────────────────────────

async function sweep() {
  const now = new Date();
  // ISSUING 逾時＝程序中斷，可能已在 ezPay 開立：改 FAILED 重排；重試時先以自訂編號查詢補登，不會重複開立
  await prisma.eInvoice.updateMany({
    where: { status: 'ISSUING', updatedAt: { lt: new Date(now.getTime() - STALE_ISSUING_MS) } },
    data: {
      status: 'FAILED',
      nextRetryAt: now,
      lastError: '開立中斷：重試時將先向 ezPay 查詢此自訂編號是否已開立',
    },
  });
  const due = await prisma.eInvoice.findMany({
    where: {
      OR: [
        { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 60_000) } },
        { status: 'FAILED', nextRetryAt: { lte: now } },
      ],
    },
    select: { id: true },
    take: 50,
    orderBy: { updatedAt: 'asc' },
  });
  for (const r of due) scheduleEInvoice(r.id, 100);
  return due.length;
}

let sweepTimer = null;
export async function bootEInvoiceQueue() {
  try {
    const n = await sweep();
    if (n) console.log(`[einvoice] resumed ${n} invoice(s)`);
  } catch (err) {
    console.warn('[einvoice] boot skip:', err.message);
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      sweep().catch((err) => console.warn('[einvoice] sweep:', err.message));
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
}
