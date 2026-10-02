// routes/pos.js — 櫃檯購物結帳（進銷存銷貨；與 Promotion 儲值分離）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission } from '../middleware/jwtAuth.js';
import { assertBranchAccess, branchListWhere } from '../lib/staffAccess.js';
import { coercePaymentsFromBody, POS_PAY_METHODS } from '../lib/compositePay.js';
import { normalizeInvoiceOptions } from '../lib/ezpay.js';
import { buildPosLines, deductSaleStock, generateSaleId, effectivePrice } from '../lib/inventory.js';
import { issueSaleInvoice, saveInvoiceRequest } from '../lib/einvoice.js';
import { resolveBranchLegalEntity } from '../lib/legalEntity.js';
import { staffBranchLabel } from '../lib/branchLabel.js';
import { lockOpenShiftForSale } from '../lib/shiftHandover.js';
import { payWithCashWallet } from '../lib/walletMutation.js';

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

    const stocks = await prisma.branchStock.findMany({
      where: { branchId, isListed: true, product: { isActive: true } },
      include: { product: true },
      orderBy: { productId: 'asc' },
    });
    res.json({
      status: 'success',
      data: stocks.map((s) => ({
        id: s.product.id,
        sku: s.product.sku,
        barcode: s.product.barcode,
        name: s.product.name,
        price: effectivePrice(s, s.product),
        stockQty: s.onHand,
        productKind: s.product.productKind,
        taxType: s.product.taxType,
        branchId: s.branchId,
      })),
    });
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
        recurringPeriods: p.recurringPeriods,
        recurringAmount: p.recurringAmount,
        recurringAmount4: p.recurringAmount4,
        recurringAmountFinal: p.recurringAmountFinal,
        enableSecondPerson: p.enableSecondPerson,
        giftLabel: p.giftLabel,
        giftQty: p.giftQty,
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

    if (pay.needsCard) {
      return res.status(400).json({
        status: 'error',
        message:
          '臨櫃商品結帳請使用「乙禾現場刷卡」（YIPAY）；PayUNi（CARD）僅用於合併結帳之定期定額',
      });
    }

    if (pay.walletAmount > 0 && (memberId === undefined || memberId === null || memberId === '')) {
      return res.status(400).json({
        status: 'error',
        message: '零錢包付款必須指定會員 memberId',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockOpenShiftForSale(tx, parsedBranchId);
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

      const saleId = generateSaleId();
      if (pay.walletAmount > 0) {
        if (!member) {
          const err = new Error('零錢包付款必須指定會員');
          err.statusCode = 400;
          throw err;
        }
        await payWithCashWallet(tx, {
          memberId: member.id,
          amount: pay.walletAmount,
          refType: 'SALE',
          refId: saleId,
          staffId,
          branchId: parsedBranchId,
        });
      }

      const status = pay.needsOnlinePay ? 'PENDING' : 'PAID';
      const entity = await resolveBranchLegalEntity(parsedBranchId, tx);
      const sale = await tx.saleOrder.create({
        data: {
          id: saleId,
          branchId: parsedBranchId,
          memberId: parsedMemberId,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: pay.yipayAmount || pay.cardAmount || 0,
          cardMode: 'LUMP',
          cardInst: null,
          periodType: null,
          periodTimes: null,
          status,
          amount: built.amount,
          itemDesc: built.itemDesc,
          legalEntityId: entity.id,
          staffId,
          items: {
            create: built.lines.map((l) => ({
              productId: l.productId,
              name: l.name,
              unitPrice: l.unitPrice,
              qty: l.qty,
              lineTotal: l.lineTotal,
              taxType: l.taxType,
            })),
          },
        },
        include: {
          items: true,
          member: { select: { id: true, name: true, cashWallet: true } },
        },
      });

      await saveInvoiceRequest(tx, {
        refType: 'SALE',
        refId: saleId,
        buyerName: member?.name || null,
        ...invoiceOpts,
      });

      // 含乙禾／線上待付時庫存等確認；純現金／錢包／抵用券當場扣庫
      if (!pay.needsOnlinePay) {
        await deductSaleStock(tx, sale, staffId);
      }

      return sale;
    });

    if (pay.needsYipay) {
      return res.json({
        status: 'success',
        message: `請於乙禾／凱基固定式刷卡機完成收款 $${pay.yipayAmount}，完成後按「確認刷卡成功」`,
        data: {
          saleId: result.id,
          amount: result.amount,
          yipayAmount: pay.yipayAmount,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          channel: 'YIPAY',
          terminalHint: '乙禾凱基固定式刷卡機',
          member: result.member,
          items: result.items,
        },
      });
    }

    if (pay.needsLinePay) {
      return res.status(400).json({
        status: 'error',
        message: '獨立 POS 結帳暫不支援 LinePay；請改用合併結帳（/ops/checkout）',
      });
    }

    // 已收款：開票失敗只入佇列，不沖回
    const inv = await issueSaleInvoice(result.id);
    const invoiceNumber = inv.invoiceNumber;

    res.json({
      status: 'success',
      ...(inv.code === 'PARTIAL_INVOICE' ? { code: 'PARTIAL_INVOICE' } : {}),
      message:
        inv.code === 'PARTIAL_INVOICE'
          ? `結帳成功（${pay.payMethodLabel}），但電子發票開立失敗，已排入自動補開：${inv.message || ''}`
          : `結帳成功（${pay.payMethodLabel}）`,
      data: {
        invoiceOutcome: inv.code,
        invoices: inv.invoices,
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
      return res.status(error.statusCode).json({
        status: 'error',
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: error.message || '結帳失敗' });
  }
});

export default router;
