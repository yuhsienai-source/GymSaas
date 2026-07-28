// routes/inventoryOps.js — 進銷存作業（DUTY 以上；新品建立仍在 HQ）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { assertBranchAccess } from '../lib/staffAccess.js';
import { adjustProductStock, generatePurchaseId } from '../lib/inventory.js';
import { assertTracksInventory } from '../lib/productKind.js';

const router = express.Router();

router.use(verifyStaff, requireDutyOrAbove);

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

function parsePositiveInt(value, fieldName) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    httpError(`${fieldName} 必須為正整數`, 400);
  }
  return n;
}

function productScopeWhere(req) {
  if (req.user?.role === 'ADMIN') return {};
  if (!req.user?.branchId) return { branchId: -1 };
  return { branchId: req.user.branchId };
}

// GET /api/ops/inventory/products?branchId=
router.get('/products', async (req, res) => {
  try {
    const where = { ...productScopeWhere(req) };
    if (req.query.branchId !== undefined) {
      const branchId = parsePositiveInt(req.query.branchId, 'branchId');
      assertBranchAccess(req, branchId);
      where.branchId = branchId;
    }
    const products = await prisma.product.findMany({
      where,
      include: { branch: { select: { id: true, name: true, code: true } } },
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });
    res.json({ status: 'success', data: products });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取商品失敗' });
  }
});

// POST /api/ops/inventory/purchases
router.post('/purchases', async (req, res) => {
  const { branchId, supplier, note, items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: 'error', message: 'items 不可為空' });
  }

  try {
    const parsedBranchId = parsePositiveInt(branchId, 'branchId');
    assertBranchAccess(req, parsedBranchId);

    const result = await prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: parsedBranchId } });
      if (!branch || !branch.isActive) {
        httpError('分店不存在或已停用', 404);
      }

      const normalized = [];
      let totalCost = 0;

      for (const row of items) {
        const productId = parsePositiveInt(row.productId, 'productId');
        const qty = parseInt(row.qty, 10);
        const unitCost = Number(row.unitCost);
        if (!Number.isInteger(qty) || qty <= 0) {
          httpError('進貨數量必須為正整數', 400);
        }
        if (!Number.isFinite(unitCost) || unitCost < 0) {
          httpError('unitCost 必須為非負數字', 400);
        }

        const product = await tx.product.findUnique({ where: { id: productId } });
        if (!product || product.branchId !== parsedBranchId) {
          httpError(`商品 #${productId} 不屬於此分店`, 400);
        }
        assertTracksInventory(product, '進貨入庫');

        const lineCost = qty * unitCost;
        totalCost += lineCost;
        normalized.push({ productId, qty, unitCost, lineCost, product });
      }

      const purchaseId = generatePurchaseId();
      const purchase = await tx.purchaseOrder.create({
        data: {
          id: purchaseId,
          branchId: parsedBranchId,
          supplier: supplier ? String(supplier).trim() : null,
          note: note ? String(note).trim() : null,
          status: 'RECEIVED',
          totalCost,
          staffId: req.user?.id || null,
          items: {
            create: normalized.map((n) => ({
              productId: n.productId,
              qty: n.qty,
              unitCost: n.unitCost,
              lineCost: n.lineCost,
            })),
          },
        },
        include: {
          items: { include: { product: { select: { id: true, name: true, sku: true } } } },
        },
      });

      for (const n of normalized) {
        await tx.product.update({
          where: { id: n.productId },
          data: {
            stockQty: { increment: n.qty },
            cost: n.unitCost,
          },
        });
        await tx.stockMovement.create({
          data: {
            productId: n.productId,
            type: 'IN',
            qty: n.qty,
            unitCost: n.unitCost,
            refType: 'PURCHASE',
            refId: purchaseId,
            note: `進貨 ${purchaseId}`,
            staffId: req.user?.id || null,
          },
        });
      }

      return purchase;
    });

    res.status(201).json({
      status: 'success',
      message: `進貨單 ${result.id} 已入庫`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '進貨失敗' });
  }
});

// GET /api/ops/inventory/purchases?branchId=
router.get('/purchases', async (req, res) => {
  try {
    const where = { ...productScopeWhere(req) };
    if (req.query.branchId !== undefined) {
      const branchId = parsePositiveInt(req.query.branchId, 'branchId');
      assertBranchAccess(req, branchId);
      where.branchId = branchId;
    }
    const purchases = await prisma.purchaseOrder.findMany({
      where,
      include: {
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ status: 'success', data: purchases });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取進貨單失敗' });
  }
});

// POST /api/ops/inventory/stock-adjustments
router.post('/stock-adjustments', async (req, res) => {
  const { productId, reason, qty, note } = req.body || {};

  try {
    const parsedProductId = parsePositiveInt(productId, 'productId');
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: parsedProductId } });
      if (!product) {
        httpError('找不到此商品', 404);
      }
      assertBranchAccess(req, product.branchId);
      return adjustProductStock(tx, {
        productId: parsedProductId,
        qty,
        reason,
        note,
        staffId: req.user?.id || null,
        unitCost: product.cost,
      });
    });

    const reasonLabel =
      result.reason === 'LOSS'
        ? '盤損'
        : result.reason === 'GAIN'
          ? '盤盈'
          : '盤點校正';

    res.status(201).json({
      status: 'success',
      message: `商品 [${result.product.name}] 已${reasonLabel}（${result.previousQty} → ${result.product.stockQty}）`,
      data: {
        product: result.product,
        movement: result.movement,
        previousQty: result.previousQty,
        reason: result.reason,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '庫存調整失敗' });
  }
});

// GET /api/ops/inventory/stock-movements?branchId=&productId=&refType=
router.get('/stock-movements', async (req, res) => {
  try {
    const where = {};
    if (req.query.productId !== undefined) {
      const productId = parsePositiveInt(req.query.productId, 'productId');
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { branchId: true },
      });
      if (!product) {
        return res.status(404).json({ status: 'error', message: '找不到此商品' });
      }
      assertBranchAccess(req, product.branchId);
      where.productId = productId;
    }
    if (req.query.branchId !== undefined) {
      const branchId = parsePositiveInt(req.query.branchId, 'branchId');
      assertBranchAccess(req, branchId);
      where.product = { branchId };
    } else if (!where.productId) {
      where.product = productScopeWhere(req);
    }
    if (req.query.refType) {
      const rt = String(req.query.refType).toUpperCase();
      if (rt === 'ADJUSTMENT' || rt === 'STOCK') {
        where.refType = { in: ['LOSS', 'GAIN', 'STOCKTAKE', 'ADJUST'] };
      } else {
        where.refType = rt;
      }
    }

    const movements = await prisma.stockMovement.findMany({
      where,
      include: {
        product: { select: { id: true, sku: true, name: true, branchId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ status: 'success', data: movements });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取庫存流水失敗' });
  }
});

export default router;
