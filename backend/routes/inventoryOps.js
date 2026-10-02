// routes/inventoryOps.js — 門市進銷存作業（DUTY 以上、限可操作分店）：庫存查詢、盤點／盤損、依採購單驗收、同營業人調撥
// 商品主檔、採購單建立、應付／付款在 HQ（/api/hq，ADMIN）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { assertBranchAccess, branchScopedWhere, isCrossBranchUser, staffBranchIds } from '../lib/staffAccess.js';
import { adjustBranchStock, transferStock } from '../lib/inventory.js';
import { listBranchStocks } from '../lib/productCatalog.js';
import { receivePurchase, PO_INCLUDE } from '../lib/purchasing.js';

const router = express.Router();
router.use(verifyStaff, requireDutyOrAbove);

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
    console.error(error);
    return res.status(500).json({ status: 'error', message: fallbackMessage });
  }
};

/** 指定分店須在權限內；未指定時回傳可操作分店清單（跨店＝null 不限） */
function resolveBranchScope(req) {
  if (req.query.branchId !== undefined && req.query.branchId !== '') {
    const branchId = posInt(req.query.branchId, 'branchId');
    assertBranchAccess(req, branchId);
    return { branchId, branchIds: null };
  }
  return { branchId: null, branchIds: isCrossBranchUser(req.user) ? null : staffBranchIds(req.user) };
}

const REASON_LABEL = { LOSS: '盤損', GAIN: '盤盈', STOCKTAKE: '盤點校正' };

// GET /api/ops/inventory/stocks?branchId=&q=
router.get(
  '/stocks',
  handle(async (req, res) => {
    const scope = resolveBranchScope(req);
    const rows = await listBranchStocks({ ...scope, q: req.query.q });
    res.json({ status: 'success', message: 'OK', data: rows });
  }, '讀取分店庫存失敗'),
);

// POST /api/ops/inventory/stock-adjustments  { branchId, productId, reason: LOSS|GAIN|COUNT, qty, note? }
router.post(
  '/stock-adjustments',
  handle(async (req, res) => {
    const { branchId, productId, reason, qty, note, ...rest } = req.body || {};
    if (Object.keys(rest).length) throw httpError(400, `⛔ 非法參數：${Object.keys(rest).join(', ')}`);
    const bid = posInt(branchId, 'branchId');
    assertBranchAccess(req, bid);
    const result = await prisma.$transaction((tx) =>
      adjustBranchStock(tx, {
        branchId: bid,
        productId: posInt(productId, 'productId'),
        qty,
        reason,
        note,
        staffId: req.user?.id ?? null,
      }),
    );
    res.status(201).json({
      status: 'success',
      message: `商品 [${result.product.name}] 已${REASON_LABEL[result.reason] || '調整'}（${result.previousQty} → ${result.onHand}）`,
      data: {
        productId: result.product.id,
        onHand: result.onHand,
        previousQty: result.previousQty,
        reason: result.reason,
        movement: result.movement,
      },
    });
  }, '庫存調整失敗'),
);

// GET /api/ops/inventory/stock-movements?branchId=&productId=&refType=
router.get(
  '/stock-movements',
  handle(async (req, res) => {
    const scope = resolveBranchScope(req);
    const where = scope.branchId ? { branchId: scope.branchId } : branchScopedWhere(req);
    if (req.query.productId) where.productId = posInt(req.query.productId, 'productId');
    if (req.query.refType) {
      const rt = String(req.query.refType).toUpperCase();
      where.refType = rt === 'ADJUSTMENT' ? { in: ['LOSS', 'GAIN', 'STOCKTAKE'] } : rt;
    }
    const rows = await prisma.stockMovement.findMany({
      where,
      include: {
        product: { select: { id: true, sku: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      status: 'success',
      message: 'OK',
      data: rows.map((m) => ({ ...m, unitCost: m.unitCost == null ? null : Number(m.unitCost) })),
    });
  }, '讀取庫存流水失敗'),
);

// GET /api/ops/inventory/purchase-orders?branchId=  待驗收採購單（ORDERED／PARTIAL）
router.get(
  '/purchase-orders',
  handle(async (req, res) => {
    const scope = resolveBranchScope(req);
    const rows = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ['ORDERED', 'PARTIAL'] },
        ...(scope.branchId ? { branchId: scope.branchId } : branchScopedWhere(req)),
      },
      include: PO_INCLUDE,
      orderBy: { orderedAt: 'asc' },
      take: 100,
    });
    res.json({
      status: 'success',
      message: 'OK',
      data: rows.map((po) => ({
        ...po,
        items: po.items.map((i) => ({ ...i, unitCost: Number(i.unitCost) })),
      })),
    });
  }, '讀取待驗收採購單失敗'),
);

// POST /api/ops/inventory/receipts  { purchaseOrderId, items:[{poItemId|productId, qty}], supplierInvoiceNo?, note? }
// 門市只可依採購單驗收，進價取採購單（不得自填），無單進貨由總部登錄
router.post(
  '/receipts',
  handle(async (req, res) => {
    const { purchaseOrderId, items, supplierInvoiceNo, supplierInvoiceDate, note, ...rest } = req.body || {};
    if (Object.keys(rest).length) {
      throw httpError(400, `⛔ 非法參數：${Object.keys(rest).join(', ')}（門市驗收不可指定進價／分店／供應商）`);
    }
    if (!purchaseOrderId) throw httpError(400, '門市驗收須依採購單（purchaseOrderId）', 'PO_REQUIRED');
    const po = await prisma.purchaseOrder.findUnique({ where: { id: String(purchaseOrderId) }, select: { branchId: true } });
    if (!po) throw httpError(404, '採購單不存在');
    assertBranchAccess(req, po.branchId);
    const list = Array.isArray(items) ? items : [];
    const extra = [...new Set(list.flatMap((i) => Object.keys(i || {}).filter((k) => !['poItemId', 'productId', 'qty'].includes(k))))];
    if (extra.length) throw httpError(400, `⛔ 驗收明細只允許 poItemId／productId／qty，已拒絕 [${extra.join(', ')}]（進價以採購單為準）`);
    const cleanItems = list.map((i) => ({
      poItemId: i.poItemId,
      productId: i.productId,
      qty: i.qty,
    }));
    const { receipt, payable } = await receivePurchase({
      purchaseOrderId: String(purchaseOrderId),
      items: cleanItems,
      supplierInvoiceNo,
      supplierInvoiceDate,
      note,
      staffId: req.user?.id ?? null,
    });
    res.status(201).json({
      status: 'success',
      message: `驗收 ${receipt.id} 完成，已入庫`,
      data: { receiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId, payableId: payable.id, items: receipt.items.length },
    });
  }, '驗收入庫失敗'),
);

// GET /api/ops/inventory/receipts?branchId=
router.get(
  '/receipts',
  handle(async (req, res) => {
    const scope = resolveBranchScope(req);
    const rows = await prisma.purchaseReceipt.findMany({
      where: scope.branchId ? { branchId: scope.branchId } : branchScopedWhere(req),
      include: {
        items: { include: { product: { select: { id: true, sku: true, name: true } } } },
        supplier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    });
    res.json({
      status: 'success',
      message: 'OK',
      data: rows.map((r) => ({
        id: r.id,
        purchaseOrderId: r.purchaseOrderId,
        branch: r.branch,
        supplier: r.supplier,
        supplierInvoiceNo: r.supplierInvoiceNo,
        receivedAt: r.receivedAt,
        note: r.note,
        items: r.items.map((i) => ({ productId: i.productId, product: i.product, qty: i.qty })),
      })),
    });
  }, '讀取驗收紀錄失敗'),
);

// POST /api/ops/inventory/transfers  { fromBranchId, toBranchId, items:[{productId, qty}], note? }
// 兩店皆須在權限內且屬同一營業人（跨統編 409 CROSS_ENTITY_TRANSFER）
router.post(
  '/transfers',
  handle(async (req, res) => {
    const { fromBranchId, toBranchId, items, note, ...rest } = req.body || {};
    if (Object.keys(rest).length) throw httpError(400, `⛔ 非法參數：${Object.keys(rest).join(', ')}`);
    const from = posInt(fromBranchId, 'fromBranchId');
    const to = posInt(toBranchId, 'toBranchId');
    assertBranchAccess(req, from);
    assertBranchAccess(req, to);
    const result = await prisma.$transaction((tx) =>
      transferStock(tx, {
        fromBranchId: from,
        toBranchId: to,
        items: Array.isArray(items) ? items : [],
        staffId: req.user?.id ?? null,
        note,
      }),
    );
    res.status(201).json({ status: 'success', message: `調撥 ${result.transferId} 完成`, data: result });
  }, '庫存調撥失敗'),
);

export default router;
