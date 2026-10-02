// routes/hqInventory.js — 總部進銷存與電子發票（ADMIN）：營業人、商品主檔、分店上架、供應商、採購、驗收、應付、付款、發票監控
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import {
  normalizeLegalEntityInput,
  serializeLegalEntity,
} from '../lib/legalEntity.js';
import {
  createProduct,
  updateProduct,
  listProducts,
  listBranchStocks,
  upsertBranchStockSettings,
} from '../lib/productCatalog.js';
import {
  normalizeSupplierInput,
  createPurchaseOrder,
  updatePurchaseOrderDraft,
  transitionPurchaseOrder,
  receivePurchase,
  setReceiptSupplierInvoice,
  createSupplierPayment,
  voidPayable,
  payableAging,
  PO_INCLUDE,
} from '../lib/purchasing.js';
import { transferStock } from '../lib/inventory.js';
import { retryEInvoice, toJobShape, listEInvoiceLogs } from '../lib/einvoice.js';

const router = express.Router();
router.use(verifyStaff, requireAdmin);

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function posInt(v, label) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `${label} 必須為正整數`);
  return n;
}

function optInt(v, label) {
  if (v === undefined || v === null || v === '') return null;
  return posInt(v, label);
}

function dateRange(query, field = 'createdAt') {
  const r = {};
  if (query.from) {
    const d = new Date(query.from);
    if (Number.isNaN(d.getTime())) throw httpError(400, 'from 日期格式無效');
    r.gte = d;
  }
  if (query.to) {
    const d = new Date(query.to);
    if (Number.isNaN(d.getTime())) throw httpError(400, 'to 日期格式無效');
    d.setHours(23, 59, 59, 999);
    r.lte = d;
  }
  return Object.keys(r).length ? { [field]: r } : {};
}

/** 統一錯誤出口：業務錯誤帶 code；Prisma 唯一鍵衝突轉 409 */
const handle = (fn, fallbackMessage) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }
    if (error.code === 'P2002') {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(',') : String(error.meta?.target || '');
      return res.status(409).json({ status: 'error', code: 'DUPLICATE', message: `資料重複（${target}）` });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到資料' });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: fallbackMessage });
  }
};

const ok = (res, data, message = 'OK', statusCode = 200) =>
  res.status(statusCode).json({ status: 'success', message, data });

// ─────────────────────────────────────────────────────────────
// 營業人（獨立統編／ezPay 商店）
// ─────────────────────────────────────────────────────────────

router.get(
  '/legal-entities',
  handle(async (req, res) => {
    const rows = await prisma.legalEntity.findMany({
      include: { branches: { select: { id: true, name: true, code: true, type: true, isActive: true } } },
      orderBy: { id: 'asc' },
    });
    ok(res, rows.map((e) => serializeLegalEntity(e, { branches: e.branches })));
  }, '讀取營業人失敗'),
);

router.post(
  '/legal-entities',
  handle(async (req, res) => {
    const data = normalizeLegalEntityInput(req.body || {});
    const row = await prisma.legalEntity.create({ data });
    ok(res, serializeLegalEntity(row, { branches: [] }), `營業人「${row.name}」已建立`, 201);
  }, '建立營業人失敗'),
);

router.patch(
  '/legal-entities/:id',
  handle(async (req, res) => {
    const id = posInt(req.params.id, 'id');
    const data = normalizeLegalEntityInput(req.body || {}, { partial: true });
    if (!Object.keys(data).length) throw httpError(400, '沒有可更新的欄位');
    const current = await prisma.legalEntity.findUnique({ where: { id }, select: { code: true, ubn: true } });
    if (!current) throw httpError(404, '營業人不存在');
    if ((data.code !== undefined && data.code !== current.code) || (data.ubn !== undefined && data.ubn !== current.ubn)) {
      const issued = await prisma.eInvoice.count({ where: { legalEntityId: id, status: { in: ['ISSUED', 'VOIDED'] } } });
      if (issued > 0) throw httpError(409, '已開立過發票之營業人不可改代碼或統編（請另建營業人）', 'LEGAL_ENTITY_LOCKED');
    }
    const row = await prisma.legalEntity.update({
      where: { id },
      data,
      include: { branches: { select: { id: true, name: true, code: true, type: true, isActive: true } } },
    });
    ok(res, serializeLegalEntity(row, { branches: row.branches }), `營業人「${row.name}」已更新`);
  }, '更新營業人失敗'),
);

// ─────────────────────────────────────────────────────────────
// 商品主檔＋分店上架
// ─────────────────────────────────────────────────────────────

router.get(
  '/products',
  handle(async (req, res) => {
    ok(res, await listProducts({ q: req.query.q, includeInactive: req.query.active !== '1' }));
  }, '讀取商品失敗'),
);

router.post(
  '/products',
  handle(async (req, res) => {
    const p = await createProduct(req.body || {});
    ok(res, p, `商品 [${p.name}] 已建立（各分店庫存 0，請進貨後上架）`, 201);
  }, '建立商品失敗'),
);

router.patch(
  '/products/:id',
  handle(async (req, res) => {
    const p = await updateProduct(posInt(req.params.id, 'id'), req.body || {});
    ok(res, p, `商品 [${p.name}] 已更新`);
  }, '更新商品失敗'),
);

router.get(
  '/branch-stocks',
  handle(async (req, res) => {
    ok(
      res,
      await listBranchStocks({
        branchId: optInt(req.query.branchId, 'branchId'),
        productId: optInt(req.query.productId, 'productId'),
        q: req.query.q,
      }),
    );
  }, '讀取分店庫存失敗'),
);

// PUT /api/hq/branch-stocks  { branchId, productId, salePrice?, safetyStock?, isListed? }（禁改 onHand）
router.put(
  '/branch-stocks',
  handle(async (req, res) => {
    const { branchId, productId, salePrice, safetyStock, isListed, ...rest } = req.body || {};
    if (Object.keys(rest).length) {
      throw httpError(400, `⛔ 非法參數：${Object.keys(rest).join(', ')}（庫存數量只能經進貨／盤點／調撥）`);
    }
    const row = await upsertBranchStockSettings({
      branchId: posInt(branchId, 'branchId'),
      productId: posInt(productId, 'productId'),
      salePrice,
      safetyStock,
      isListed,
    });
    ok(res, row, '分店上架設定已更新');
  }, '更新分店上架設定失敗'),
);

router.get(
  '/stock-movements',
  handle(async (req, res) => {
    const take = Math.min(500, parseInt(req.query.take, 10) || 200);
    const rows = await prisma.stockMovement.findMany({
      where: {
        ...(optInt(req.query.branchId, 'branchId') ? { branchId: Number(req.query.branchId) } : {}),
        ...(optInt(req.query.productId, 'productId') ? { productId: Number(req.query.productId) } : {}),
        ...(req.query.refType ? { refType: String(req.query.refType).toUpperCase() } : {}),
        ...dateRange(req.query),
      },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    ok(res, rows.map((m) => ({ ...m, unitCost: m.unitCost == null ? null : Number(m.unitCost) })));
  }, '讀取庫存異動失敗'),
);

// POST /api/hq/stock-transfers  { fromBranchId, toBranchId, items:[{productId, qty}], note? }（跨營業人 409）
router.post(
  '/stock-transfers',
  handle(async (req, res) => {
    const { fromBranchId, toBranchId, items, note } = req.body || {};
    const result = await prisma.$transaction((tx) =>
      transferStock(tx, {
        fromBranchId: posInt(fromBranchId, 'fromBranchId'),
        toBranchId: posInt(toBranchId, 'toBranchId'),
        items: Array.isArray(items) ? items : [],
        staffId: req.user?.id ?? null,
        note,
      }),
    );
    ok(res, result, `調撥 ${result.transferId} 完成`, 201);
  }, '庫存調撥失敗'),
);

// ─────────────────────────────────────────────────────────────
// 供應商
// ─────────────────────────────────────────────────────────────

router.get(
  '/suppliers',
  handle(async (req, res) => {
    const rows = await prisma.supplier.findMany({
      where: req.query.active === '1' ? { isActive: true } : {},
      orderBy: { id: 'asc' },
    });
    ok(res, rows);
  }, '讀取供應商失敗'),
);

router.post(
  '/suppliers',
  handle(async (req, res) => {
    const row = await prisma.supplier.create({ data: normalizeSupplierInput(req.body || {}) });
    ok(res, row, `供應商「${row.name}」已建立`, 201);
  }, '建立供應商失敗'),
);

router.patch(
  '/suppliers/:id',
  handle(async (req, res) => {
    const data = normalizeSupplierInput(req.body || {}, { partial: true });
    if (!Object.keys(data).length) throw httpError(400, '沒有可更新的欄位');
    const row = await prisma.supplier.update({ where: { id: posInt(req.params.id, 'id') }, data });
    ok(res, row, `供應商「${row.name}」已更新`);
  }, '更新供應商失敗'),
);

// ─────────────────────────────────────────────────────────────
// 採購單
// ─────────────────────────────────────────────────────────────

function serializePo(po) {
  return {
    ...po,
    items: (po.items || []).map((i) => ({ ...i, unitCost: Number(i.unitCost) })),
  };
}

router.get(
  '/purchase-orders',
  handle(async (req, res) => {
    const rows = await prisma.purchaseOrder.findMany({
      where: {
        ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}),
        ...(optInt(req.query.branchId, 'branchId') ? { branchId: Number(req.query.branchId) } : {}),
        ...(optInt(req.query.supplierId, 'supplierId') ? { supplierId: Number(req.query.supplierId) } : {}),
        ...(optInt(req.query.legalEntityId, 'legalEntityId') ? { legalEntityId: Number(req.query.legalEntityId) } : {}),
        ...dateRange(req.query),
      },
      include: PO_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    ok(res, rows.map(serializePo));
  }, '讀取採購單失敗'),
);

router.get(
  '/purchase-orders/:id',
  handle(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: String(req.params.id) }, include: PO_INCLUDE });
    if (!po) throw httpError(404, '採購單不存在');
    ok(res, serializePo(po));
  }, '讀取採購單失敗'),
);

// POST /api/hq/purchase-orders  { branchId, supplierId, items:[{productId, qty, unitCost, taxType?}], expectedAt?, note? }
router.post(
  '/purchase-orders',
  handle(async (req, res) => {
    const { branchId, supplierId, items, expectedAt, note } = req.body || {};
    const po = await createPurchaseOrder({
      branchId: posInt(branchId, 'branchId'),
      supplierId: posInt(supplierId, 'supplierId'),
      items,
      expectedAt,
      note,
      staffId: req.user?.id ?? null,
    });
    ok(res, serializePo(po), `採購單 ${po.id} 已建立（草稿）`, 201);
  }, '建立採購單失敗'),
);

router.patch(
  '/purchase-orders/:id',
  handle(async (req, res) => {
    const { items, expectedAt, note, supplierId } = req.body || {};
    const po = await updatePurchaseOrderDraft(String(req.params.id), { items, expectedAt, note, supplierId });
    ok(res, serializePo(po), `採購單 ${po.id} 已更新`);
  }, '更新採購單失敗'),
);

for (const [action, label] of [
  ['order', '已送出採購'],
  ['cancel', '已取消'],
  ['close', '已結案（短交）'],
]) {
  router.post(
    `/purchase-orders/:id/${action}`,
    handle(async (req, res) => {
      const po = await transitionPurchaseOrder(String(req.params.id), action, { reason: req.body?.reason });
      ok(res, serializePo(po), `採購單 ${po.id} ${label}`);
    }, '採購單狀態變更失敗'),
  );
}

// ─────────────────────────────────────────────────────────────
// 驗收入庫
// ─────────────────────────────────────────────────────────────

const RECEIPT_INCLUDE = {
  items: { include: { product: { select: { id: true, sku: true, name: true, unit: true } } } },
  supplier: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true, code: true } },
  legalEntity: { select: { id: true, code: true, name: true } },
  payable: { select: { id: true, status: true, amount: true, paidAmount: true, dueDate: true } },
};

function serializeReceipt(r) {
  return { ...r, items: (r.items || []).map((i) => ({ ...i, unitCost: Number(i.unitCost) })) };
}

router.get(
  '/purchase-receipts',
  handle(async (req, res) => {
    const rows = await prisma.purchaseReceipt.findMany({
      where: {
        ...(optInt(req.query.branchId, 'branchId') ? { branchId: Number(req.query.branchId) } : {}),
        ...(optInt(req.query.supplierId, 'supplierId') ? { supplierId: Number(req.query.supplierId) } : {}),
        ...(req.query.purchaseOrderId ? { purchaseOrderId: String(req.query.purchaseOrderId) } : {}),
        ...dateRange(req.query, 'receivedAt'),
      },
      include: RECEIPT_INCLUDE,
      orderBy: { receivedAt: 'desc' },
      take: 300,
    });
    ok(res, rows.map(serializeReceipt));
  }, '讀取驗收單失敗'),
);

// POST /api/hq/purchase-receipts  { purchaseOrderId? | (branchId, supplierId), items, supplierInvoiceNo?, supplierInvoiceDate?, note? }
router.post(
  '/purchase-receipts',
  handle(async (req, res) => {
    const { purchaseOrderId, branchId, supplierId, items, supplierInvoiceNo, supplierInvoiceDate, note } = req.body || {};
    const { receipt, payable } = await receivePurchase({
      purchaseOrderId,
      branchId,
      supplierId,
      items,
      supplierInvoiceNo,
      supplierInvoiceDate,
      note,
      staffId: req.user?.id ?? null,
    });
    ok(res, { receipt: serializeReceipt(receipt), payable }, `驗收 ${receipt.id} 完成，已入庫並立應付 ${payable.id}`, 201);
  }, '驗收入庫失敗'),
);

router.patch(
  '/purchase-receipts/:id/supplier-invoice',
  handle(async (req, res) => {
    const r = await setReceiptSupplierInvoice(String(req.params.id), req.body || {});
    ok(res, r, '供應商發票已登錄');
  }, '登錄供應商發票失敗'),
);

// ─────────────────────────────────────────────────────────────
// 應付帳款／付款
// ─────────────────────────────────────────────────────────────

router.get(
  '/payables',
  handle(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const rows = await prisma.supplierPayable.findMany({
      where: {
        ...(status === 'UNPAID' ? { status: { in: ['OPEN', 'PARTIAL'] } } : status ? { status } : {}),
        ...(optInt(req.query.legalEntityId, 'legalEntityId') ? { legalEntityId: Number(req.query.legalEntityId) } : {}),
        ...(optInt(req.query.supplierId, 'supplierId') ? { supplierId: Number(req.query.supplierId) } : {}),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        legalEntity: { select: { id: true, code: true, name: true } },
        receipt: { select: { id: true, receivedAt: true, purchaseOrderId: true, branchId: true } },
      },
      orderBy: [{ dueDate: 'asc' }],
      take: 500,
    });
    const now = Date.now();
    ok(
      res,
      rows.map((p) => ({
        ...p,
        openAmount: p.amount - p.paidAmount,
        overdueDays:
          ['OPEN', 'PARTIAL'].includes(p.status) ? Math.max(0, Math.floor((now - new Date(p.dueDate).getTime()) / 86400000)) : 0,
      })),
    );
  }, '讀取應付帳款失敗'),
);

router.get(
  '/payables/aging',
  handle(async (req, res) => {
    ok(res, await payableAging({ legalEntityId: optInt(req.query.legalEntityId, 'legalEntityId') }));
  }, '讀取應付帳齡失敗'),
);

router.post(
  '/payables/:id/void',
  handle(async (req, res) => {
    const p = await voidPayable(String(req.params.id), req.body?.reason);
    ok(res, p, `應付 ${p.id} 已作廢`);
  }, '作廢應付失敗'),
);

router.get(
  '/supplier-payments',
  handle(async (req, res) => {
    const rows = await prisma.supplierPayment.findMany({
      where: {
        ...(optInt(req.query.legalEntityId, 'legalEntityId') ? { legalEntityId: Number(req.query.legalEntityId) } : {}),
        ...(optInt(req.query.supplierId, 'supplierId') ? { supplierId: Number(req.query.supplierId) } : {}),
        ...dateRange(req.query, 'paidAt'),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        legalEntity: { select: { id: true, code: true, name: true } },
        allocations: { select: { payableId: true, amount: true } },
      },
      orderBy: { paidAt: 'desc' },
      take: 300,
    });
    ok(res, rows);
  }, '讀取付款紀錄失敗'),
);

// POST /api/hq/supplier-payments  { legalEntityId, supplierId, amount, method, paidAt?, reference?, note?, allocations:[{payableId, amount}] }
router.post(
  '/supplier-payments',
  handle(async (req, res) => {
    const payment = await createSupplierPayment({ ...(req.body || {}), staffId: req.user?.id ?? null });
    ok(res, payment, `付款 ${payment.id} 已登錄並沖銷 ${payment.allocations.length} 筆應付`, 201);
  }, '登錄付款失敗'),
);

// ─────────────────────────────────────────────────────────────
// 電子發票監控（跨營業人）
// ─────────────────────────────────────────────────────────────

router.get(
  '/einvoices',
  handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const rows = await prisma.eInvoice.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(optInt(req.query.legalEntityId, 'legalEntityId') ? { legalEntityId: Number(req.query.legalEntityId) } : {}),
        ...(optInt(req.query.branchId, 'branchId') ? { branchId: Number(req.query.branchId) } : {}),
        ...(req.query.category ? { category: String(req.query.category).toUpperCase() } : {}),
        ...dateRange(req.query),
        ...(q
          ? {
              OR: [
                { invoiceNumber: { contains: q.toUpperCase() } },
                { refId: { contains: q, mode: 'insensitive' } },
                { merchantOrderNo: { contains: q, mode: 'insensitive' } },
                { buyerUbn: { contains: q } },
              ],
            }
          : {}),
      },
      include: { legalEntity: { select: { id: true, code: true, name: true, ubn: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, parseInt(req.query.take, 10) || 200),
    });
    ok(
      res,
      rows.map((r) => ({
        ...toJobShape(r),
        merchantOrderNo: r.merchantOrderNo,
        buyerUbn: r.buyerUbn,
        buyerName: r.buyerName,
        carrierType: r.carrierType,
        printFlag: r.printFlag,
        taxType: r.taxType,
        salesAmount: r.salesAmount,
        taxAmount: r.taxAmount,
        allowanceTotal: r.allowanceTotal,
        issuedAt: r.issuedAt,
        periodKey: r.periodKey,
        voidReason: r.voidReason,
      })),
    );
  }, '讀取電子發票失敗'),
);

router.post(
  '/einvoices/:id/retry',
  handle(async (req, res) => {
    const job = await retryEInvoice(String(req.params.id), { staffId: req.user?.id ?? null });
    ok(res, job, job.status === 'SUCCESS' ? `發票 ${job.invoiceNumber} 已開立` : '已重新送出開立');
  }, '補開發票失敗'),
);

const LOG_RESULTS = new Set(['SUCCESS', 'FAILED', 'NOT_FOUND']);
const LOG_ACTIONS = new Set(['ISSUE', 'RECOVER', 'VOID', 'ALLOWANCE']);

/** 單張發票之 ezPay 呼叫紀錄 */
router.get(
  '/einvoices/:id/logs',
  handle(async (req, res) => {
    const id = String(req.params.id);
    const exists = await prisma.eInvoice.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw httpError(404, '找不到發票', 'INVOICE_NOT_FOUND');
    ok(res, await listEInvoiceLogs({ einvoiceId: id, take: 200 }));
  }, '讀取發票呼叫紀錄失敗'),
);

/** 跨營業人 ezPay 呼叫紀錄（預設只看失敗） */
router.get(
  '/einvoice-logs',
  handle(async (req, res) => {
    const result = req.query.result === undefined ? 'FAILED' : String(req.query.result).toUpperCase();
    if (result && !LOG_RESULTS.has(result)) throw httpError(400, 'result 須為 SUCCESS／FAILED／NOT_FOUND');
    const action = req.query.action ? String(req.query.action).toUpperCase() : null;
    if (action && !LOG_ACTIONS.has(action)) throw httpError(400, 'action 須為 ISSUE／RECOVER／VOID／ALLOWANCE');
    const range = dateRange(req.query).createdAt || {};
    ok(
      res,
      await listEInvoiceLogs({
        result: result || null,
        action,
        legalEntityId: optInt(req.query.legalEntityId, 'legalEntityId'),
        from: range.gte || null,
        to: range.lte || null,
        take: parseInt(req.query.take, 10) || 200,
      }),
    );
  }, '讀取 ezPay 呼叫紀錄失敗'),
);

export default router;
