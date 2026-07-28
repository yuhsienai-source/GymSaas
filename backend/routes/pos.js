// routes/pos.js — 櫃檯購物結帳（進銷存銷貨；與 Promotion 儲值分離）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission } from '../middleware/jwtAuth.js';
import { assertBranchAccess, branchListWhere } from '../lib/staffAccess.js';
import { buildUPPPayload, parseCardPayOptions, PAYUNI_UPP_URL } from '../lib/payuni.js';
import { normalizeInvoiceOptions } from '../lib/ezpay.js';
import { coercePaymentsFromBody, POS_PAY_METHODS } from '../lib/compositePay.js';
import {
  buildPosLines,
  deductSaleStock,
  generateSaleId,
  tryIssueSaleInvoice,
} from '../lib/inventory.js';
import { staffBranchLabel } from '../lib/branchLabel.js';

const router = express.Router();
router.use(verifyStaff, requirePermission('ops'));

// GET /api/ops/branches
router.get('/branches', async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where: branchListWhere(req),
      select: { id: true, name: true, code: true },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: branches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取分店失敗' });
  }
});

// GET /api/ops/products?branchId=
router.get('/products', async (req, res) => {
  try {
    if (req.query.branchId === undefined) {
      return res.status(400).json({ status: 'error', message: '請提供 branchId' });
    }
    const branchId = parseInt(req.query.branchId, 10);
    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({ status: 'error', message: 'branchId 無效' });
    }

    assertBranchAccess(req, branchId);

    const products = await prisma.product.findMany({
      where: { branchId, isActive: true },
      select: {
        id: true,
        sku: true,
        name: true,
        price: true,
        stockQty: true,
        productKind: true,
        branchId: true,
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: products });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取可售商品失敗' });
  }
});

// GET /api/ops/course-plans?branchId=  （臨櫃購物車：客製化私教）
router.get('/course-plans', async (req, res) => {
  try {
    const { coursePlanSellablePrismaWhere } = await import('../lib/coursePlan.js');
    const whereBase = { planType: 'CUSTOM_PT' };
    if (req.query.branchId !== undefined && req.query.branchId !== '') {
      const branchId = parseInt(req.query.branchId, 10);
      if (!Number.isInteger(branchId) || branchId <= 0) {
        return res.status(400).json({ status: 'error', message: 'branchId 無效' });
      }
      assertBranchAccess(req, branchId);
      whereBase.branchId = branchId;
    }

    const plans = await prisma.coursePlan.findMany({
      where: coursePlanSellablePrismaWhere(whereBase),
      include: { branch: { select: { id: true, name: true, code: true } } },
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });

    const data = plans
      .filter((p) => Number.isInteger(p.sessions) && p.sessions > 0)
      .map((p) => ({
        id: p.id,
        branchId: p.branchId,
        branchName: staffBranchLabel(p.branch),
        name: p.name,
        planType: p.planType,
        planMode: p.planMode,
        price: p.price,
        sessions: p.sessions,
        capacity: p.capacity,
        description: p.description,
        requiresMemberContract: p.requiresMemberContract,
        enableCardRecurring: p.enableCardRecurring,
        isActive: p.isActive,
      }));

    res.json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取課程方案失敗' });
  }
});

// GET /api/ops/trainers — 臨櫃選教練
router.get('/trainers', async (req, res) => {
  try {
    const trainers = await prisma.trainer.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        role: true,
        branches: { select: { branchId: true, branch: { select: { id: true, name: true, code: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: trainers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取教練失敗' });
  }
});

// POST /api/ops/pos/checkout
// Body: { branchId, memberId?, items, payments:[{method,amount,voucherCode?}], carrierNum?, buyerUbn?, loveCode?, cardMode?, cardInst? }
// 複合付款至少一種；金額分攤合計須等於後端查價總額
router.post('/pos/checkout', async (req, res) => {
  const {
    branchId,
    memberId,
    items,
    payments,
    payMethod,
    voucherCode,
    carrierNum,
    buyerUbn,
    loveCode,
    cardMode,
    cardInst,
    periodType,
    periodTimes,
    amount,
    ...rest
  } = req.body || {};

  if (amount !== undefined || Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message:
        '⛔ 非法參數：結帳只允許 branchId、memberId、items、payments、payMethod、voucherCode、carrierNum、buyerUbn、loveCode、cardMode、cardInst；金額由後端查價',
    });
  }

  if (periodType !== undefined || periodTimes !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: 'POS 購物不支援定期定額',
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: 'error', message: '購物車不可為空' });
  }

  const parsedBranchId = parseInt(branchId, 10);
  if (!Number.isInteger(parsedBranchId) || parsedBranchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'branchId 無效' });
  }

  let invoiceOpts;
  try {
    invoiceOpts = normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }

  try {
    assertBranchAccess(req, parsedBranchId);
  } catch (error) {
    return res.status(error.statusCode || 403).json({ status: 'error', message: error.message });
  }

  try {
    const staffId = req.user?.id || null;
    const lineDraft = [];
    for (const row of items) {
      const productId = parseInt(row.productId, 10);
      const qty = parseInt(row.qty, 10);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ status: 'error', message: 'productId 無效' });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', message: 'qty 必須為正整數' });
      }
      lineDraft.push({ productId, qty });
    }

    // 先查價再驗證付款分攤
    const priced = await prisma.$transaction(async (tx) => buildPosLines(tx, parsedBranchId, lineDraft));

    let pay;
    try {
      pay = coercePaymentsFromBody(
        { payments, payMethod, voucherCode },
        priced.amount,
        POS_PAY_METHODS,
      );
    } catch (error) {
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    }

    let cardOpts = { cardMode: 'LUMP', cardInst: null, periodType: null, periodTimes: null };
    if (pay.needsCard) {
      try {
        cardOpts = parseCardPayOptions(
          { cardMode, cardInst },
          { allowRecurring: false },
        );
      } catch (error) {
        return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
      }
    }

    if (pay.walletAmount > 0 && (memberId === undefined || memberId === null || memberId === '')) {
      return res.status(400).json({
        status: 'error',
        message: '零錢包付款必須指定會員 memberId',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const built = await buildPosLines(tx, parsedBranchId, lineDraft);
      let parsedMemberId = null;
      let member = null;

      if (memberId !== undefined && memberId !== null && memberId !== '') {
        parsedMemberId = parseInt(memberId, 10);
        if (!Number.isInteger(parsedMemberId)) {
          const err = new Error('memberId 無效');
          err.statusCode = 400;
          throw err;
        }
        member = await tx.member.findUnique({ where: { id: parsedMemberId } });
        if (!member) {
          const err = new Error('找不到會員');
          err.statusCode = 404;
          throw err;
        }
      }

      if (pay.walletAmount > 0) {
        if (!member) {
          const err = new Error('零錢包付款必須指定會員');
          err.statusCode = 400;
          throw err;
        }
        if (member.cashWallet < pay.walletAmount) {
          const err = new Error(
            `零錢包（本金）不足（餘額 $${member.cashWallet}，應付 $${pay.walletAmount}）；運動金不可折抵`,
          );
          err.statusCode = 400;
          throw err;
        }
        await tx.member.update({
          where: { id: member.id },
          data: { cashWallet: { decrement: pay.walletAmount } },
        });
      }

      const status = pay.needsCard ? 'PENDING' : 'PAID';
      const saleId = generateSaleId();
      const sale = await tx.saleOrder.create({
        data: {
          id: saleId,
          branchId: parsedBranchId,
          memberId: parsedMemberId,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: pay.cardAmount,
          cardMode: pay.needsCard ? cardOpts.cardMode : 'LUMP',
          cardInst: pay.needsCard ? cardOpts.cardInst : null,
          periodType: null,
          periodTimes: null,
          status,
          amount: built.amount,
          itemDesc: built.itemDesc,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          staffId,
          items: {
            create: built.lines.map((l) => ({
              productId: l.productId,
              name: l.name,
              unitPrice: l.unitPrice,
              qty: l.qty,
              lineTotal: l.lineTotal,
            })),
          },
        },
        include: {
          items: true,
          member: { select: { id: true, name: true, cashWallet: true } },
        },
      });

      // 含刷卡時庫存等 Webhook；純現金／錢包／抵用券當場扣庫
      if (!pay.needsCard) {
        await deductSaleStock(tx, sale, staffId);
      }

      return sale;
    });

    if (pay.needsCard) {
      const payuniPayload = buildUPPPayload({
        id: result.id,
        amount: pay.cardAmount,
        itemDesc: result.itemDesc,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
      });

      return res.json({
        status: 'success',
        message: `銷貨單已建立（${pay.payMethodLabel}），請完成刷卡 $${pay.cardAmount}`,
        data: {
          saleId: result.id,
          amount: result.amount,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          cardAmount: pay.cardAmount,
          cardMode: cardOpts.cardMode,
          cardInst: cardOpts.cardInst,
          voucherCode: pay.voucherCode,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          actionUrl: PAYUNI_UPP_URL,
          payload: payuniPayload,
        },
      });
    }

    const invoiceNumber = await tryIssueSaleInvoice(result, result.member?.name);

    res.json({
      status: 'success',
      message: `結帳成功（${pay.payMethodLabel}）`,
      data: {
        saleId: result.id,
        amount: result.amount,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        invoiceNumber,
        carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
        member: result.member,
        items: result.items,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: error.message || '結帳失敗' });
  }
});

export default router;
