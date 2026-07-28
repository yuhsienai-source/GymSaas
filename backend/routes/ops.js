// routes/ops.js
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { assertBranchAccess, hasManagerRankOrAbove, promotionListWhere, isAdminUser, hasDutyRankOrAbove } from '../lib/staffAccess.js';
import { coercePaymentsFromBody, TOPUP_PAY_METHODS } from '../lib/compositePay.js';
import {
  assertPromotionSellable,
  promotionSellablePrismaWhere,
  fulfillPromotionPurchase,
  buildTopupItemDesc,
  isUnlimitedTopupOrder,
  parseTopupQtyFromItemDesc,
  computeTopupAmount,
  isUnlimitedPromotion,
  resolveRecurringPeriodDays,
  remainingExpireDays,
  buildRecurringInvoiceItemDesc,
} from '../lib/promotion.js';
import {
  assertMemberSignedPromotionContracts,
  assertMemberSignedBiometricsConsent,
  assertActiveContracts,
  buildMembersContractBoard,
  ensurePendingSignatures,
  findBiometricsConsentContract,
  getBiometricsSignedMemberIdSet,
  listMemberContractHistory,
  mapPromotionContracts,
  parseContractIds,
  serializeSignature,
  syncMemberAllowBiometrics,
} from '../lib/memberContract.js';
import { buildVersionLabel, DEFAULT_VERSION_BASE } from '../lib/contractVersionLabel.js';
import {
  getRequestClientMeta,
  hashContractBody,
  writeContractAudit,
} from '../lib/contractAudit.js';
import {
  buildUPPPayload,
  decryptInfo,
  verifyWebhookHash,
  parseCardPayOptions,
  extractCardTradeMeta,
  PAYUNI_UPP_URL,
} from '../lib/payuni.js';
import {
  createSubscriptionFromPaidOrder,
  processDueSubscriptions,
  cancelCardSubscription,
  pauseCardSubscription,
  resumeCardSubscription,
} from '../lib/cardSubscription.js';
import {
  settleCancelSubscription,
  settleCancelUnlimitedOrder,
  previewCancelUnlimitedOrder,
  EXPIRE_POLICIES,
  findLatestPaidOrderForSubscription,
  computeUnusedAllowanceAmount,
} from '../lib/subscriptionSettle.js';
import {
  startMemberLeave,
  endMemberLeaveEarly,
  completeMemberLeaveOnSchedule,
  listMemberLeaves,
  settleExpiredLeave,
} from '../lib/memberLeave.js';
import {
  buildShiftSummary,
  getOpenShift,
  openShift,
  closeShift,
  listShifts,
  getShiftOpenPreview,
  shiftSlotLabel,
  normalizePayMixColumns,
  PAY_METHOD_COLUMNS,
} from '../lib/shiftHandover.js';
import {
  buildAllowanceSlip,
  persistAllowanceSlip,
  savePrintableAllowanceSlip,
  toPrintableAllowance,
  normalizeBuyerEmail,
  normalizeInvoiceNumberInput,
  resolveInvoiceSellerHeader,
  resolveBranchIdForOrder,
} from '../lib/invoiceAllowance.js';
import { issueInvoice, normalizeInvoiceOptions } from '../lib/ezpay.js';
import {
  appendInvoiceReverseNote,
  executeInvoiceReverse,
  resolveOrderInvoiceReverse,
  resolveSaleInvoiceReverse,
  syncCheckoutInvoiceAfterReverse,
  reevaluateCheckoutSessionStatus,
  prorateCheckoutWalletCash,
} from '../lib/ezpayReverse.js';
import { allocateUniqueMemberNo } from '../lib/memberNo.js';
import { registerFace } from '../lib/papago.js';
import {
  identifyMember,
  lookupMemberByPhone,
  normalizePhone,
  toCounterMemberView,
} from '../lib/memberIdentify.js';
import { setMemberBranches, listMemberBranches } from '../lib/memberBranch.js';
import { deviceBindUpdateData, deviceBindUpdateIfChanged } from '../lib/memberDevice.js';
import { payReturnRedirect, posPayReturnRedirect, topupPayReturnRedirect, checkoutPayReturnRedirect } from '../lib/frontendUrl.js';
import { fulfillCardSaleOrder, restockSaleStock } from '../lib/inventory.js';
import { broadcastOccupancy } from '../lib/occupancy.js';
import {
  processCheckOut,
  broadcastCheckOut,
  checkOutSuccessPayload,
} from '../lib/gateCheckout.js';
import { fulfillCheckoutSession, runOpsCheckout } from '../lib/checkout.js';
import { resolveTopupOrderId } from '../lib/orderIds.js';
import { formatGateAccessNo, resolveGateLogId } from '../lib/gateAccessNo.js';
import { cancelPtPurchase } from '../lib/ptCancel.js';



const router = express.Router();

// ==========================================
// 🚨 【金流 Webhook 中樞】(必須放在 verifyStaff 上方)
// 網址：POST /api/ops/payuni/webhook
// ==========================================
router.post('/payuni/webhook', async (req, res) => {
  const { EncryptInfo, HashInfo } = req.body;

  if (!EncryptInfo || !HashInfo) {
    return res.status(400).send('缺少必要參數');
  }

  // 1. 資安防線：計算 HashInfo 是否吻合 (防偽造請求)
  if (!verifyWebhookHash(EncryptInfo, HashInfo)) {
    console.error("⛔ Webhook 簽章驗證失敗！有駭客試圖偽造交易");
    return res.status(403).send('Hash Signature Error');
  }

  try {
    // 2. 解密取得交易詳細資料
    const tradeData = decryptInfo(EncryptInfo);
    console.log("📥 收到統一金流 Webhook 解密資料:", tradeData);
    
    // Status="SUCCESS" 且 TradeStatus="1" 才代表真正付款成功
    if (tradeData.Status === 'SUCCESS' && tradeData.TradeStatus === '1') {
      const orderId = tradeData.MerTradeNo;

      // 3a. 合併結帳（CHK…）
      if (String(orderId || '').startsWith('CHK')) {
        const cardMeta = extractCardTradeMeta(tradeData);
        const fulfilled = await fulfillCheckoutSession(orderId, tradeData.TradeNo, cardMeta);
        if (fulfilled) {
          console.log(`✅ 合併結帳 ${orderId} 刷卡入帳成功`);
        }
        return res.status(200).send('OK');
      }

      // 3b. POS 銷貨（SAL…）
      if (String(orderId || '').startsWith('SAL')) {
        const cardMeta = extractCardTradeMeta(tradeData);
        const fulfilled = await fulfillCardSaleOrder(orderId, tradeData.TradeNo, null, cardMeta);
        if (fulfilled) {
          console.log(`✅ 銷貨 ${orderId} 刷卡入帳＋扣庫成功`);
        }
        return res.status(200).send('OK');
      }

      // 3c. 儲值 Order
      const order = await prisma.order.findUnique({ 
        where: { id: orderId },
        include: { member: true }
      });

      if (order && order.status === 'PENDING') {
        // 從 itemDesc 解析商品 ID（格式：... | 商品#123）
        const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
        const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
        const cardMeta = extractCardTradeMeta(tradeData);
        const isRecurring = String(order.cardMode || '').toUpperCase() === 'RECURRING';

        let promotionForSub = null;

        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: 'PAID',
              merchantNo: tradeData.TradeNo,
              ...(cardMeta.creditHash ? { creditHash: cardMeta.creditHash } : {}),
              ...(cardMeta.cardInst ? { cardInst: cardMeta.cardInst } : {}),
            },
          });

          // 線上付款成功 → 依 Promotion 入帳（TIMED 錢包／UNLIMITED 延長效期）
          if (promotionId) {
            const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
            if (promotion) {
              promotionForSub = promotion;
              const qty = parseTopupQtyFromItemDesc(order.itemDesc);
              // 定期定額：每期只延長 unitDays（非整段 durationDays）
              const durationDaysOverride =
                isRecurring && isUnlimitedPromotion(promotion)
                  ? resolveRecurringPeriodDays(promotion)
                  : undefined;
              await fulfillPromotionPurchase(tx, order.memberId, promotion, {
                qty,
                durationDaysOverride: durationDaysOverride ?? undefined,
              });
            }
          }
        });

        console.log(`✅ 訂單 ${orderId} 統一金流扣款成功！`);

        // 定期定額：首期綁 Token 成功 → 建立續扣訂閱
        if (isRecurring && promotionForSub) {
          try {
            const paidOrder = await prisma.order.findUnique({ where: { id: orderId } });
            await createSubscriptionFromPaidOrder(paidOrder, {
              promotion: promotionForSub,
              creditHash: cardMeta.creditHash || paidOrder?.creditHash,
            });
          } catch (subErr) {
            console.error(`❌ 訂單 ${orderId} 建立定期定額訂閱失敗:`, subErr.message);
          }
        }

        // 🚀 觸發 ezPay 開立電子發票（含刷卡時預存的手機載具）
        try {
          const isRecurringInvoice =
            String(order.cardMode || '').toUpperCase() === 'RECURRING';
          let invoiceItemDesc = order.itemDesc;
          if (isRecurringInvoice) {
            const promoMatch = String(order.itemDesc || '').match(/\| ([^|]+) \| UNLIMITED/);
            const promoName =
              promoMatch?.[1]?.trim() ||
              String(order.itemDesc || '')
                .split('|')[1]
                ?.trim() ||
              '月卡';
            invoiceItemDesc = buildRecurringInvoiceItemDesc(promoName, { periodIndex: 1 });
          }
          const invoiceResult = await issueInvoice({
            id: orderId,
            amount: order.amount,
            itemDesc: invoiceItemDesc,
            buyerName: order.member.name,
            carrierNum: order.carrierNum || null,
            buyerUbn: order.buyerUbn || null,
            loveCode: order.loveCode || null,
          });

          if (invoiceResult.Status === 'SUCCESS') {
            const invoiceData = JSON.parse(invoiceResult.Result);
            await prisma.order.update({
              where: { id: orderId },
              data: { invoiceNumber: invoiceData.InvoiceNumber },
            });
            console.log(`🧾 訂單 ${orderId} 發票開立成功：${invoiceData.InvoiceNumber}`);
          } else {
            console.error(`❌ 訂單 ${orderId} 發票開立失敗！ezPay 拒絕原因：`, invoiceResult.Message || invoiceResult);
          }
        } catch (invoiceError) {
          console.error(`❌ 訂單 ${orderId} 發票模組發生例外錯誤:`, invoiceError.message);
        }
      }
    }

    // 6. 必須回傳 HTTP 200 給統一金流，否則他們會一直 retry
    return res.status(200).send('OK');
  } catch (error) {
    console.error("Webhook 處理異常:", error);
    return res.status(500).send('Server Error');
  }
});

// ==========================================
// 🪃 【前端 ReturnURL 中繼站】(必須在 verifyStaff 上方)
// 網址：POST /api/ops/payuni/return
// 金流以瀏覽器 POST 打回後端 → 再 302 到獨立前端（本服務不託管 UI）
// ==========================================
router.post('/payuni/return', (req, res) => {
  try {
    // 嘗試從 EncryptInfo 取出 MerTradeNo，導向對應前端頁
    let saleId;
    let orderId;
    let checkoutId;
    try {
      if (req.body?.EncryptInfo && verifyWebhookHash(req.body.EncryptInfo, req.body.HashInfo)) {
        const tradeData = decryptInfo(req.body.EncryptInfo);
        const merTradeNo = String(tradeData.MerTradeNo || '');
        if (merTradeNo.startsWith('CHK')) {
          checkoutId = merTradeNo;
        } else if (merTradeNo.startsWith('SAL')) {
          saleId = merTradeNo;
        } else if (merTradeNo.startsWith('TYK') || merTradeNo.startsWith('CRS')) {
          orderId = merTradeNo;
        }
      }
    } catch {
      /* 解密失敗仍導向前端 */
    }

    console.log('🪃 消費者完成結帳，導向獨立前端。', checkoutId || saleId || orderId || '');
    if (checkoutId) {
      return res.redirect(checkoutPayReturnRedirect({ checkoutId }));
    }
    if (saleId) {
      return res.redirect(posPayReturnRedirect({ saleId }));
    }
    if (orderId) {
      return res.redirect(topupPayReturnRedirect({ orderId }));
    }
    res.redirect(payReturnRedirect());
  } catch (error) {
    console.error('PayUNi return 導向失敗:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || '無法導向前端付款結果頁',
    });
  }
});

// 所有 ops.js 內的路由，強制通過員工海關驗證
// 交易異動（退費／取消／訂閱請假）限 DUTY 以上；其餘限櫃檯模組
router.use(verifyStaff);
router.use((req, res, next) => {
  const txExact = new Set([
    '/refund',
    '/refund-lookup',
    '/cancel-sale',
    '/cancel-pt-purchase',
    '/allowances',
  ]);
  const isTxPath =
    txExact.has(req.path) ||
    req.path.startsWith('/allowances/') ||
    req.path.startsWith('/card-subscriptions') ||
    req.path.startsWith('/member-leaves');
  // cancel-gate：在場取消開放 ops；已出場退費仍於 handler 內要求 DUTY+
  if (req.path === '/cancel-gate') {
    return requirePermission('ops')(req, res, next);
  }
  if (isTxPath) {
    return requireDutyOrAbove(req, res, next);
  }
  return requirePermission('ops')(req, res, next);
});

/**
 * 從 Order 追溯當初儲值的本金 (price) 與贈送運動金 (bonusGiven)
 * 必須優先讀 itemDesc 當下快照（防 Promotion 事後改價導致退費算錯）
 */
async function resolveTopupMetaFromOrder(order, tx) {
  if (isUnlimitedTopupOrder(order.itemDesc)) {
    const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
    const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
    return {
      usageType: 'UNLIMITED',
      price: order.amount,
      bonusGiven: 0,
      promotionId,
      promotionName: order.itemDesc,
      source: 'itemDesc',
    };
  }

  const cashMatch = (order.itemDesc || '').match(/現金\+(\d+(?:\.\d+)?)/);
  const bonusMatch = (order.itemDesc || '').match(/運動金\+(\d+(?:\.\d+)?)/);
  const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
  const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;

  // ① 訂單寫入當下的配發快照（權威）
  if (cashMatch && bonusMatch) {
    return {
      price: parseFloat(cashMatch[1]),
      bonusGiven: parseFloat(bonusMatch[1]),
      promotionId,
      promotionName: order.itemDesc,
      source: 'itemDesc',
    };
  }

  // ② 備援：查 Promotion 表（舊訂單可能沒寫快照數字）
  if (promotionId) {
    const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
    if (promotion) {
      return {
        price: promotion.price,
        bonusGiven: promotion.bonusGiven,
        promotionId: promotion.id,
        promotionName: promotion.name,
        source: 'promotion',
      };
    }
  }

  return {
    price: order.amount,
    bonusGiven: 0,
    promotionId,
    promotionName: order.itemDesc,
    source: 'order.amount',
  };
}

function roundMoney(n) {
  return parseFloat(Number(n).toFixed(2));
}

/** 臨櫃回傳用的會員摘要（共用 lib） */
// toCounterMemberView / normalizePhone 自 memberIdentify 匯入


async function tryIssueOrderInvoice(order, buyerName) {
  try {
    const isRecurringInvoice = String(order.cardMode || '').toUpperCase() === 'RECURRING';
    let invoiceItemDesc = order.itemDesc;
    if (isRecurringInvoice) {
      const promoMatch = String(order.itemDesc || '').match(/\| ([^|]+) \| UNLIMITED/);
      const promoName =
        promoMatch?.[1]?.trim() ||
        String(order.itemDesc || '')
          .split('|')[1]
          ?.trim() ||
        '月卡';
      invoiceItemDesc = buildRecurringInvoiceItemDesc(promoName, { periodIndex: 1 });
    }
    const invoiceResult = await issueInvoice({
      id: order.id,
      amount: order.amount,
      itemDesc: invoiceItemDesc,
      buyerName: buyerName || '體育客顧客',
      carrierNum: order.carrierNum || null,
      buyerUbn: order.buyerUbn || null,
      loveCode: order.loveCode || null,
    });

    if (invoiceResult.Status === 'SUCCESS') {
      const invoiceData = JSON.parse(invoiceResult.Result);
      await prisma.order.update({
        where: { id: order.id },
        data: { invoiceNumber: invoiceData.InvoiceNumber },
      });
      console.log(`🧾 訂單 ${order.id} 發票：${invoiceData.InvoiceNumber}`);
      return invoiceData.InvoiceNumber;
    }
    console.error(`❌ 訂單 ${order.id} 發票失敗:`, invoiceResult.Message || invoiceResult);
    return null;
  } catch (error) {
    console.error(`❌ 訂單 ${order.id} 發票例外:`, error.message);
    return null;
  }
}

// ==========================================
// 信用卡定期定額訂閱管理
// ==========================================

/**
 * 以訂閱編號或訂單編號解析 CardSubscription
 * - CRS…：先當訂閱 id；找不到再當訂單號（originOrder／續扣 charge）
 * - TYK…：舊版訂單號反查
 */
async function resolveSubscriptionByRef(ref, { include } = {}) {
  const raw = String(ref || '').trim().toUpperCase();
  if (!raw) {
    return { sub: null, message: '請提供訂閱編號（CRS）或訂單編號（CRS／TYK）' };
  }

  const withInclude = include ? { include } : {};

  // 1) 直接用訂閱編號
  if (raw.startsWith('CRS')) {
    const byId = await prisma.cardSubscription.findUnique({
      where: { id: raw },
      ...withInclude,
    });
    if (byId) return { sub: byId, message: null };
  }

  // 2) 訂單編號 → originOrderId（首期）
  if (raw.startsWith('CRS') || raw.startsWith('TYK')) {
    const byOrigin = await prisma.cardSubscription.findFirst({
      where: { originOrderId: raw },
      ...withInclude,
    });
    if (byOrigin) return { sub: byOrigin, message: null };

    // 3) 續扣 charge.orderId
    const charge = await prisma.cardSubscriptionCharge.findFirst({
      where: { orderId: raw },
      orderBy: { periodIndex: 'desc' },
    });
    if (charge?.subscriptionId) {
      const byCharge = await prisma.cardSubscription.findUnique({
        where: { id: charge.subscriptionId },
        ...withInclude,
      });
      if (byCharge) return { sub: byCharge, message: null };
    }

    // 4) 訂單存在但無訂閱（一次付清／現金月卡）
    const order = await prisma.order.findUnique({
      where: { id: raw },
      select: {
        id: true,
        cardMode: true,
        itemDesc: true,
        status: true,
        memberId: true,
        amount: true,
        invoiceNumber: true,
        payMethod: true,
      },
    });
    if (order) {
      const isRecurring = String(order.cardMode || '').toUpperCase() === 'RECURRING';
      if (isUnlimitedTopupOrder(order.itemDesc) && !isRecurring) {
        return { sub: null, unlimitedOrder: order, message: null };
      }
      return {
        sub: null,
        unlimitedOrder: null,
        message: isRecurring
          ? '此定期定額訂單尚未建立訂閱（可能刷卡未完成或缺少 CreditHash），無法取消訂閱'
          : '這筆不是訂閱制月卡訂單，請改走退費折讓或取消交易',
      };
    }
  }

  return {
    sub: null,
    unlimitedOrder: null,
    message: raw.startsWith('CRS')
      ? '找不到訂閱（請確認 CRS 訂閱編號，或改貼對應訂單號）'
      : '找不到訂閱',
  };
}

router.get('/card-subscriptions', async (req, res) => {
  try {
    const memberIdRaw = req.query.memberId;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const where = {};
    if (memberIdRaw !== undefined && memberIdRaw !== '') {
      const memberId = parseInt(memberIdRaw, 10);
      if (!Number.isInteger(memberId)) {
        return res.status(400).json({ status: 'error', message: 'memberId 無效' });
      }
      where.memberId = memberId;
    }
    if (status) where.status = status;

    const rows = await prisma.cardSubscription.findMany({
      where,
      include: {
        member: {
          select: {
            id: true,
            name: true,
            memberNo: true,
            phone: true,
            plan: true,
            expireDate: true,
            leaveUntil: true,
          },
        },
        promotion: {
          select: {
            id: true,
            name: true,
            price: true,
            usageType: true,
            unitDays: true,
            periodCount: true,
            durationDays: true,
            branchId: true,
            branch: { select: { id: true, name: true, code: true } },
          },
        },
        charges: {
          orderBy: { periodIndex: 'desc' },
          take: 5,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    const filtered = rows.filter((r) => {
      try {
        assertBranchAccess(req, r.promotion.branchId);
        return true;
      } catch {
        return false;
      }
    });

    res.json({ status: 'success', data: filtered });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取訂閱失敗' });
  }
});

/** 手動觸發掃描到期續扣（除錯／值班）— 必須放在 /:id/* 之前 */
router.post('/card-subscriptions/run-due', async (req, res) => {
  try {
    const result = await processDueSubscriptions({
      limit: Math.min(50, parseInt(req.body?.limit, 10) || 20),
    });
    res.json({
      status: 'success',
      message: `已處理 ${result.processed} 筆到期訂閱`,
      data: result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: error.message || '執行續扣失敗' });
  }
});

router.post('/card-subscriptions/:id/cancel', async (req, res) => {
  try {
    const { sub, unlimitedOrder, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } } },
    });

    const expirePolicy = String(req.body?.expirePolicy || 'KEEP').toUpperCase();
    const hasSettleFields =
      req.body?.expirePolicy != null ||
      req.body?.doAllowance != null ||
      req.body?.settle === true;

    // 一次付清／現金月卡：無 CardSubscription，改走訂單結算
    if (!sub && unlimitedOrder) {
      const promoMatch = String(unlimitedOrder.itemDesc || '').match(/商品#(\d+)/);
      const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
      if (promotionId) {
        const promotion = await prisma.promotion.findUnique({
          where: { id: promotionId },
          select: { branchId: true },
        });
        if (promotion) assertBranchAccess(req, promotion.branchId);
      }

      const policy = hasSettleFields || expirePolicy !== 'KEEP' ? expirePolicy : 'KEEP';
      const result = await settleCancelUnlimitedOrder(unlimitedOrder.id, {
        reason: req.body?.reason,
        expirePolicy: policy,
        doAllowance: req.body?.doAllowance,
      });
      const inv =
        result.invoice?.action === 'allowance'
          ? `，發票折讓 ${result.invoice.allowanceNo}（$${result.invoice.allowanceAmt}）`
          : result.invoice?.action === 'void'
            ? `，發票已作廢 ${result.invoice.invoiceNumber}`
            : '';
      const exp =
        result.expirePolicy === 'KEEP'
          ? `效期保留（剩餘約 ${result.unusedDays} 天）`
          : `效期已截斷（原剩餘 ${result.unusedDays} 天）`;
      let allowanceSlip = null;
      if (result.invoice?.action === 'allowance') {
        const branchId =
          (await resolveBranchIdForOrder(unlimitedOrder)) || req.user?.branchId || null;
        const sellerHeader = await resolveInvoiceSellerHeader(branchId);
        allowanceSlip = await savePrintableAllowanceSlip({
          reverseResult: result.invoice,
          orderId: unlimitedOrder.id,
          memberId: unlimitedOrder.memberId,
          memberName: result.member?.name || unlimitedOrder.member?.name,
          itemDesc: unlimitedOrder.itemDesc,
          merchantOrderNo: result.invoice.merchantOrderNo || unlimitedOrder.id,
          amount: result.invoice.allowanceAmt || result.allowance?.allowanceAmt,
          source: 'SUB_CANCEL',
          staffId: req.user?.id ?? null,
          sellerHeader,
        });
      }
      return res.json({
        status: 'success',
        message: `月卡購案已取消；${exp}${inv}`,
        data: { ...result, orderId: unlimitedOrder.id, allowanceSlip },
      });
    }

    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertBranchAccess(req, sub.promotion.branchId);

    // 新結算流程：效期政策 + 可選折讓；舊呼叫（無參數）仍只停續扣
    if (hasSettleFields || expirePolicy !== 'KEEP') {
      const result = await settleCancelSubscription(sub.id, {
        reason: req.body?.reason,
        expirePolicy,
        doAllowance: req.body?.doAllowance,
      });
      const inv =
        result.invoice?.action === 'allowance'
          ? `，發票折讓 ${result.invoice.allowanceNo}（$${result.invoice.allowanceAmt}）`
          : result.invoice?.action === 'void'
            ? `，發票已作廢 ${result.invoice.invoiceNumber}`
            : '';
      const exp =
        result.expirePolicy === 'KEEP'
          ? `效期保留（剩餘約 ${result.unusedDays} 天）`
          : `效期已截斷（原剩餘 ${result.unusedDays} 天）`;
      let allowanceSlip = null;
      if (result.invoice?.action === 'allowance') {
        const order = result.order || (sub.originOrderId
          ? await prisma.order.findUnique({ where: { id: sub.originOrderId } })
          : null);
        const sellerHeader = await resolveInvoiceSellerHeader(sub.promotion.branchId);
        allowanceSlip = await savePrintableAllowanceSlip({
          reverseResult: result.invoice,
          orderId: order?.id || sub.originOrderId || null,
          memberId: sub.memberId,
          memberName: result.member?.name || null,
          itemDesc: order?.itemDesc || null,
          merchantOrderNo: result.invoice.merchantOrderNo || order?.id,
          amount: result.invoice.allowanceAmt || result.allowance?.allowanceAmt,
          source: 'SUB_CANCEL',
          staffId: req.user?.id ?? null,
          sellerHeader,
        });
      }
      return res.json({
        status: 'success',
        message: `訂閱已取消；${exp}${inv}`,
        data: { ...result, subscriptionId: sub.id, allowanceSlip },
      });
    }

    const updated = await cancelCardSubscription(sub.id, { reason: req.body?.reason });
    res.json({ status: 'success', message: '訂閱已取消（效期未變更）', data: updated });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '取消訂閱失敗' });
  }
});

/** 預覽取消訂閱結算（不寫入）：剩餘天數／預估折讓 */
router.get('/card-subscriptions/:id/cancel-preview', async (req, res) => {
  try {
    const { sub, unlimitedOrder, message } = await resolveSubscriptionByRef(req.params.id, {
      include: {
        promotion: true,
        member: {
          select: {
            id: true,
            name: true,
            memberNo: true,
            plan: true,
            expireDate: true,
            leaveUntil: true,
          },
        },
      },
    });

    if (!sub && unlimitedOrder) {
      const preview = await previewCancelUnlimitedOrder(unlimitedOrder.id);
      if (preview.promotion?.branchId != null) {
        assertBranchAccess(req, preview.promotion.branchId);
      }
      return res.json({
        status: 'success',
        data: {
          ...preview,
          subscription: {
            id: null,
            status: 'N/A',
            amount: unlimitedOrder.amount,
            periodType: null,
            chargedCount: 1,
            nextChargeAt: null,
            lastChargeAt: null,
            originOrderId: unlimitedOrder.id,
            note: '一次付清／現金月卡（無定期定額訂閱）',
          },
        },
      });
    }

    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertBranchAccess(req, sub.promotion.branchId);

    const now = new Date();
    const unusedDays = remainingExpireDays(sub.member?.expireDate, now);
    const periodDays =
      resolveRecurringPeriodDays(sub.promotion) ||
      sub.promotion?.unitDays ||
      sub.promotion?.durationDays ||
      30;
    const latest = await findLatestPaidOrderForSubscription(sub);
    const allowanceAmt = latest.order
      ? computeUnusedAllowanceAmount({
          orderAmount: latest.order.amount,
          unusedDays,
          periodDays,
        })
      : 0;

    res.json({
      status: 'success',
      data: {
        subscription: {
          id: sub.id,
          status: sub.status,
          amount: sub.amount,
          periodType: sub.periodType,
          chargedCount: sub.chargedCount,
          nextChargeAt: sub.nextChargeAt,
          lastChargeAt: sub.lastChargeAt,
          originOrderId: sub.originOrderId || null,
        },
        member: sub.member,
        promotion: {
          id: sub.promotion.id,
          name: sub.promotion.name,
          usageType: sub.promotion.usageType,
          unitDays: sub.promotion.unitDays,
          durationDays: sub.promotion.durationDays,
        },
        expirePolicies: EXPIRE_POLICIES,
        unusedDays,
        periodDays,
        latestOrder: latest.order
          ? {
              id: latest.order.id,
              amount: latest.order.amount,
              invoiceNumber: latest.order.invoiceNumber,
              status: latest.order.status,
              periodIndex: latest.periodIndex,
            }
          : null,
        estimatedAllowance: allowanceAmt,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '預覽失敗' });
  }
});

router.post('/card-subscriptions/:id/pause', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertBranchAccess(req, sub.promotion.branchId);
    const updated = await pauseCardSubscription(sub.id);
    res.json({
      status: 'success',
      message: '訂閱已暫停續扣（效期仍持續計算；請假請改用請假 API）',
      data: updated,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '暫停訂閱失敗' });
  }
});

router.post('/card-subscriptions/:id/resume', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertBranchAccess(req, sub.promotion.branchId);
    await settleExpiredLeave(sub.memberId);
    const updated = await resumeCardSubscription(sub.id);
    res.json({ status: 'success', message: '訂閱已恢復', data: updated });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '恢復訂閱失敗' });
  }
});

// ==========================================
// 無限使用請假
// ==========================================
router.get('/member-leaves', async (req, res) => {
  try {
    const memberId = req.query.memberId ? Number(req.query.memberId) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = await listMemberLeaves({ memberId, status });
    // 分店過濾：有訂閱則看方案分店；無則放行 ADMIN，DUTY 需 memberId
    const filtered = [];
    for (const row of rows) {
      if (row.subscriptionId) {
        const sub = await prisma.cardSubscription.findUnique({
          where: { id: row.subscriptionId },
          include: { promotion: { select: { branchId: true } } },
        });
        try {
          if (sub) assertBranchAccess(req, sub.promotion.branchId);
          filtered.push(row);
        } catch {
          /* skip */
        }
      } else {
        filtered.push(row);
      }
    }
    res.json({ status: 'success', data: filtered });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取請假失敗' });
  }
});

router.post('/member-leaves', async (req, res) => {
  try {
    const memberId = Number(req.body?.memberId);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return res.status(400).json({ status: 'error', message: '請提供 memberId' });
    }
    const subId = req.body?.subscriptionId ? String(req.body.subscriptionId).trim() : undefined;
    if (subId) {
      const sub = await prisma.cardSubscription.findUnique({
        where: { id: subId },
        include: { promotion: { select: { branchId: true } } },
      });
      if (!sub) return res.status(404).json({ status: 'error', message: '找不到訂閱' });
      assertBranchAccess(req, sub.promotion.branchId);
    }

    const result = await startMemberLeave({
      memberId,
      days: req.body?.days,
      reason: req.body?.reason,
      staffId: req.user?.id ?? null,
      subscriptionId: subId,
    });
    res.json({
      status: 'success',
      message: `已請假 ${result.leave.days} 天（至 ${new Date(result.leave.endAt).toLocaleDateString('zh-TW')}）；效期已順延，定期定額已暫停`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '請假失敗' });
  }
});

/** 提早銷假 */
router.post('/member-leaves/:id/end', async (req, res) => {
  try {
    const leave = await prisma.memberLeave.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!leave) return res.status(404).json({ status: 'error', message: '找不到請假紀錄' });
    if (leave.subscriptionId) {
      const sub = await prisma.cardSubscription.findUnique({
        where: { id: leave.subscriptionId },
        include: { promotion: { select: { branchId: true } } },
      });
      if (sub) assertBranchAccess(req, sub.promotion.branchId);
    }

    const result = await endMemberLeaveEarly({
      memberId: leave.memberId,
      leaveId: leave.id,
      reason: req.body?.reason,
      resumeSubscription: req.body?.resumeSubscription !== false,
    });
    res.json({
      status: 'success',
      message: `已提早銷假，收回未休 ${result.unusedLeaveDays} 天效期順延`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '銷假失敗' });
  }
});

/** 請假期滿結案（或手動標記到期） */
router.post('/member-leaves/:id/complete', async (req, res) => {
  try {
    const leave = await prisma.memberLeave.findUnique({
      where: { id: Number(req.params.id) },
    });
    if (!leave) return res.status(404).json({ status: 'error', message: '找不到請假紀錄' });
    if (leave.subscriptionId) {
      const sub = await prisma.cardSubscription.findUnique({
        where: { id: leave.subscriptionId },
        include: { promotion: { select: { branchId: true } } },
      });
      if (sub) assertBranchAccess(req, sub.promotion.branchId);
    }
    const result = await completeMemberLeaveOnSchedule(leave.id);
    res.json({ status: 'success', message: '請假已結案，訂閱已恢復續扣', data: result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '結案失敗' });
  }
});

// ==========================================
// 交接班結算
// ==========================================
function resolveOpsBranchId(req, raw) {
  const bid = parseInt(raw, 10);
  if (!Number.isInteger(bid) || bid <= 0) {
    const err = new Error('請提供有效的 branchId');
    err.statusCode = 400;
    throw err;
  }
  assertBranchAccess(req, bid);
  return bid;
}

router.get('/shift/current', async (req, res) => {
  try {
    const branchId = resolveOpsBranchId(req, req.query.branchId);
    const open = await getOpenShift(branchId);
    let liveSummary = null;
    if (open) {
      liveSummary = await buildShiftSummary({
        branchId,
        from: open.startedAt,
        to: new Date(),
      });
    }
    const preview = open ? null : await getShiftOpenPreview(branchId);
    res.json({
      status: 'success',
      data: {
        shift: open
          ? {
              ...open,
              slotLabel: shiftSlotLabel(open.slot),
            }
          : null,
        liveSummary,
        expectedCash: open
          ? Math.round(((open.openingFloat || 0) + (liveSummary?.cashIn || 0)) * 100) / 100
          : null,
        openPreview: preview,
        payMethodColumns: PAY_METHOD_COLUMNS,
        canAdjustVariance: hasManagerRankOrAbove(req.user),
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取班次失敗' });
  }
});

router.get('/shift/summary', async (req, res) => {
  try {
    const branchId = resolveOpsBranchId(req, req.query.branchId);
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (!from || Number.isNaN(from.getTime())) {
      return res.status(400).json({ status: 'error', message: '請提供 from（ISO 時間）' });
    }
    const summary = await buildShiftSummary({ branchId, from, to });
    res.json({ status: 'success', data: summary });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '彙總失敗' });
  }
});

router.get('/shift/history', async (req, res) => {
  try {
    const branchId = resolveOpsBranchId(req, req.query.branchId);
    const rows = await listShifts({
      branchId,
      take: parseInt(req.query.take, 10) || 20,
    });
    res.json({
      status: 'success',
      data: rows.map((r) => ({
        ...r,
        slotLabel: shiftSlotLabel(r.slot),
        payMixColumns: normalizePayMixColumns(r.payMixSnapshot),
      })),
      meta: { payMethodColumns: PAY_METHOD_COLUMNS },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取交班紀錄失敗' });
  }
});

router.post('/shift/open', async (req, res) => {
  try {
    const branchId = resolveOpsBranchId(req, req.body?.branchId);
    const staff = await prisma.staff.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, role: true },
    });
    const staffRole = staff?.role || req.user?.role;
    const shift = await openShift({
      branchId,
      staffId: req.user?.id,
      staffName: staff?.name || req.user?.name,
      staffRole,
      slot: req.body?.slot,
      note: req.body?.note,
    });
    res.json({
      status: 'success',
      message: `已開${shiftSlotLabel(shift.slot)} ${shift.id}（底金 $${shift.openingFloat}，沿用上一班實點）`,
      data: { ...shift, slotLabel: shiftSlotLabel(shift.slot) },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '開班失敗' });
  }
});

router.post('/shift/:id/close', async (req, res) => {
  try {
    const existing = await prisma.shiftHandover.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到班次' });
    }
    assertBranchAccess(req, existing.branchId);
    const staff = await prisma.staff.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, role: true },
    });
    const staffRole = staff?.role || req.user?.role;
    const matchExpected = req.body?.matchExpected === true || req.body?.matchExpected === 'true';
    const closed = await closeShift({
      shiftId: existing.id,
      staffId: req.user?.id,
      staffName: staff?.name || req.user?.name,
      staffRole,
      countedCash: req.body?.countedCash,
      matchExpected,
      note: req.body?.note,
      cashDenominations: req.body?.cashDenominations,
      closeChecklist: req.body?.closeChecklist,
      allowVariance: !matchExpected && hasManagerRankOrAbove({ role: staffRole }),
    });
    const varianceLabel =
      closed.variance === 0
        ? '帳款相符'
        : closed.variance > 0
          ? `溢收 $${closed.variance}`
          : `短缺 $${Math.abs(closed.variance)}`;
    res.json({
      status: 'success',
      message: `交班完成（${shiftSlotLabel(closed.slot)}）：應有 $${closed.expectedCash}／實點 $${closed.countedCash}（${varianceLabel}）`,
      data: { ...closed, slotLabel: shiftSlotLabel(closed.slot) },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '交班失敗' });
  }
});

// ==========================================
// 臨櫃合併結帳：商品 + 購案同一購物車
// POST /api/ops/checkout
// Body: { branchId?, memberId?, items?, promotionId?, qty?, payments, …, recurringAmount? }
// ==========================================
router.post('/checkout', async (req, res) => {
  try {
    const result = await runOpsCheckout(req, req.body || {});
    return res.json({
      status: 'success',
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: error.message || '合併結帳失敗' });
  }
});

// ==========================================
// 0. 【商品化防呆儲值】臨櫃加值（唯一合法儲值入口）
// 網址：POST /api/ops/topup
// Payload：{ memberId, promotionId, qty?, payments:[{method,amount,voucherCode?}], carrierNum?, buyerUbn?, loveCode? }
// 複合付款至少一種；含 CARD 時 PENDING→PayUNi（刷卡金額=cardAmount）；其餘當場入帳＋發票
// ==========================================
router.post(['/topup', '/deposit'], async (req, res) => {
  const {
    memberId,
    promotionId,
    qty,
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
    recurringAmount: recurringAmountRaw,
    ...illegalFields
  } = req.body;

  const forbiddenKeys = Object.keys(illegalFields);
  if (forbiddenKeys.length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：儲值 API 只允許 memberId、promotionId、qty、payments、payMethod、voucherCode、carrierNum、buyerUbn、loveCode、cardMode、cardInst、periodType、periodTimes、recurringAmount，已拒絕 [${forbiddenKeys.join(', ')}]`,
    });
  }

  if (memberId === undefined || promotionId === undefined) {
    return res.status(400).json({
      status: 'error',
      message: '參數錯誤：必須提供 memberId 與 promotionId',
    });
  }

  const parsedMemberId = parseInt(memberId, 10);
  const parsedPromotionId = parseInt(promotionId, 10);

  if (!Number.isInteger(parsedMemberId) || !Number.isInteger(parsedPromotionId)) {
    return res.status(400).json({
      status: 'error',
      message: '參數錯誤：memberId 與 promotionId 必須為整數',
    });
  }

  const parsedQty = qty === undefined || qty === null || qty === '' ? 1 : parseInt(qty, 10);
  if (!Number.isInteger(parsedQty) || parsedQty <= 0) {
    return res.status(400).json({
      status: 'error',
      message: 'qty 必須為正整數',
    });
  }

  let invoiceOpts;
  try {
    invoiceOpts = normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }

  try {
    const promotion = await prisma.promotion.findUnique({
      where: { id: parsedPromotionId },
    });

    if (!promotion) {
      return res.status(404).json({ status: 'error', message: '找不到此促銷商品' });
    }

    assertBranchAccess(req, promotion.branchId);
    assertPromotionSellable(promotion);

    if (isUnlimitedPromotion(promotion) && parsedQty !== 1) {
      return res.status(400).json({
        status: 'error',
        message: '無限使用方案不支援數量，每次僅能購買 1 份',
      });
    }

    const member = await prisma.member.findUnique({
      where: { id: parsedMemberId },
    });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }

    if (promotion.requiresMemberContract) {
      await assertMemberSignedPromotionContracts(parsedMemberId, parsedPromotionId);
    }

    const amount = computeTopupAmount(promotion, parsedQty);
    const itemDesc = buildTopupItemDesc(promotion, '臨櫃', parsedQty);

    let pay;
    try {
      pay = coercePaymentsFromBody(
        { payments, payMethod, voucherCode },
        amount,
        TOPUP_PAY_METHODS,
      );
    } catch (error) {
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    }

    let cardOpts = { cardMode: 'LUMP', cardInst: null, periodType: null, periodTimes: null };
    let recurringAmount = null;
    if (pay.needsCard) {
      try {
        cardOpts = parseCardPayOptions(
          { cardMode, cardInst, periodType, periodTimes },
          { allowRecurring: Boolean(promotion.enableCardRecurring) },
        );
      } catch (error) {
        return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
      }
      if (cardOpts.cardMode === 'RECURRING') {
        if (recurringAmountRaw === undefined || recurringAmountRaw === null || recurringAmountRaw === '') {
          recurringAmount = amount;
        } else {
          const n = typeof recurringAmountRaw === 'number'
            ? recurringAmountRaw
            : parseFloat(String(recurringAmountRaw));
          if (!Number.isFinite(n) || n <= 0) {
            return res.status(400).json({ status: 'error', message: '定期定額金額必須為正數' });
          }
          recurringAmount = Math.round(n * 100) / 100;
        }
      }
    }

    // 含刷卡：PENDING，刷卡成功後再入帳（避免未付完先配發）
    if (pay.needsCard) {
      const order = await prisma.$transaction(async (tx) => {
        if (pay.walletAmount > 0) {
          const m = await tx.member.findUnique({ where: { id: parsedMemberId } });
          if (!m || m.cashWallet < pay.walletAmount) {
            const err = new Error(
              `零錢包（本金）不足（餘額 $${m?.cashWallet ?? 0}，應付 $${pay.walletAmount}）；運動金不可折抵`,
            );
            err.statusCode = 400;
            throw err;
          }
          await tx.member.update({
            where: { id: parsedMemberId },
            data: { cashWallet: { decrement: pay.walletAmount } },
          });
        }

        return tx.order.create({
          data: {
            id: resolveTopupOrderId({
              cardMode: cardOpts.cardMode,
              promotion,
            }),
            memberId: parsedMemberId,
            amount,
            itemDesc,
            payMethod: pay.payMethodLabel,
            payBreakdown: pay.breakdown,
            voucherCode: pay.voucherCode,
            cardAmount: pay.cardAmount,
            cardMode: cardOpts.cardMode,
            cardInst: cardOpts.cardInst,
            periodType: cardOpts.periodType,
            periodTimes: cardOpts.periodTimes,
            recurringAmount,
            carrierNum: invoiceOpts.carrierNum,
            buyerUbn: invoiceOpts.buyerUbn,
            loveCode: invoiceOpts.loveCode,
            status: 'PENDING',
          },
        });
      });

      const payuniPayload = buildUPPPayload({
        id: order.id,
        amount: pay.cardAmount,
        itemDesc: order.itemDesc,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
      });

      return res.json({
        status: 'success',
        message: `訂單已建立（${pay.payMethodLabel}），請完成刷卡 $${pay.cardAmount}`,
        data: {
          orderId: order.id,
          amount: order.amount,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          cardAmount: pay.cardAmount,
          cardMode: cardOpts.cardMode,
          cardInst: cardOpts.cardInst,
          periodType: cardOpts.periodType,
          periodTimes: cardOpts.periodTimes,
          recurringAmount,
          voucherCode: pay.voucherCode,
          carrierNum: invoiceOpts.carrierNum,
            buyerUbn: invoiceOpts.buyerUbn,
            loveCode: invoiceOpts.loveCode,
          actionUrl: PAYUNI_UPP_URL,
          payload: payuniPayload,
        },
      });
    }

    // 無刷卡：當場入帳 + 開發票（可含零錢包折抵）
    const result = await prisma.$transaction(async (tx) => {
      if (pay.walletAmount > 0) {
        const m = await tx.member.findUnique({ where: { id: parsedMemberId } });
        if (!m || m.cashWallet < pay.walletAmount) {
          const err = new Error(
            `零錢包（本金）不足（餘額 $${m?.cashWallet ?? 0}，應付 $${pay.walletAmount}）；運動金不可折抵`,
          );
          err.statusCode = 400;
          throw err;
        }
        await tx.member.update({
          where: { id: parsedMemberId },
          data: { cashWallet: { decrement: pay.walletAmount } },
        });
      }

      const { updatedMember, fulfillment } = await fulfillPromotionPurchase(
        tx,
        parsedMemberId,
        promotion,
        { qty: parsedQty },
      );

      const order = await tx.order.create({
        data: {
          id: resolveTopupOrderId({ promotion }),
          memberId: parsedMemberId,
          amount: fulfillment.amount,
          itemDesc: buildTopupItemDesc(promotion, '臨櫃', fulfillment.qty),
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: 0,
          carrierNum: invoiceOpts.carrierNum,
            buyerUbn: invoiceOpts.buyerUbn,
            loveCode: invoiceOpts.loveCode,
          status: 'PAID',
        },
      });

      return { updatedMember, order, promotion, fulfillment };
    });

    const invoiceNumber = await tryIssueOrderInvoice(result.order, result.updatedMember.name);

    const successMessage =
      result.fulfillment.type === 'UNLIMITED'
        ? `【體育客】會員 [${result.updatedMember.name}] 購案成功：${result.promotion.name}（效期至 ${new Date(result.fulfillment.expireDate).toLocaleDateString('zh-TW')}）`
        : `【體育客】會員 [${result.updatedMember.name}] 儲值成功：${result.promotion.name} ×${result.fulfillment.qty}`;

    res.json({
      status: 'success',
      message: successMessage,
      data: {
        orderId: result.order.id,
        amount: result.order.amount,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        invoiceNumber,
        carrierNum: invoiceOpts.carrierNum,
            buyerUbn: invoiceOpts.buyerUbn,
            loveCode: invoiceOpts.loveCode,
        promotion: {
          id: result.promotion.id,
          name: result.promotion.name,
          usageType: result.promotion.usageType,
          qty: result.fulfillment.qty,
          cashAdded: result.fulfillment.type === 'TIMED' ? result.fulfillment.cashAdded : 0,
          bonusAdded: result.fulfillment.type === 'TIMED' ? result.fulfillment.bonusAdded : 0,
          durationDays:
            result.fulfillment.type === 'UNLIMITED' ? result.fulfillment.durationDays : null,
          expireDate:
            result.fulfillment.type === 'UNLIMITED' ? result.fulfillment.expireDate : null,
        },
        wallet: {
          cash: result.updatedMember.cashWallet,
          bonus: result.updatedMember.bonusWallet,
        },
        plan: result.updatedMember.plan,
        expireDate: result.updatedMember.expireDate,
      },
    });
  } catch (error) {
    console.error('儲值失敗:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '儲值失敗' });
  }
});

// ==========================================
// 0.02 【臨櫃開卡】綁電話＋綁定分店
// POST /api/ops/members
// Body: { name, phone, branchIds?: number[], faceEnabled?: boolean }
// 方案／效期禁止前端指定：未購方案一律分鐘計費、無效期
// faceEnabled=true 時建立後需簽署生物辨識同意書（allowBiometrics 仍由簽署同步）
// ==========================================
router.post('/members', async (req, res) => {
  const { name, phone, allowBiometrics, plan, expireDate, branchIds, faceEnabled, ...rest } =
    req.body || {};

  if (plan !== undefined || expireDate !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 開卡禁止指定方案或效期：未購買前固定為分鐘計費（無效期），購案後由系統寫入',
    });
  }

  if (allowBiometrics !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 生物辨識授權請改簽署「生物辨識同意書」合約，不可手動勾選',
    });
  }

  if (Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：開卡只允許 name、phone、branchIds、faceEnabled，已拒絕 [${Object.keys(rest).join(', ')}]`,
    });
  }

  if (!name || !phone) {
    return res.status(400).json({
      status: 'error',
      message: '開卡失敗：姓名與手機號碼為必填',
    });
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 8) {
    return res.status(400).json({ status: 'error', message: '手機號碼格式無效' });
  }

  const wantFace = Boolean(faceEnabled);
  if (wantFace) {
    const bio = await findBiometricsConsentContract();
    if (!bio?.versions?.[0]) {
      return res.status(400).json({
        status: 'error',
        message: '尚未設定啟用中的「生物辨識同意書」，無法開卡啟用人臉，請先至總部建立合約',
      });
    }
  }

  let resolvedBranchIds = Array.isArray(branchIds)
    ? branchIds.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!isAdminUser(req.user) && req.user?.branchId) {
    resolvedBranchIds = [req.user.branchId];
  }
  if (resolvedBranchIds.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: '開卡失敗：請至少綁定一間分店（branchIds）',
    });
  }
  for (const bid of resolvedBranchIds) {
    try {
      assertBranchAccess(req, bid);
    } catch (err) {
      return res.status(err.statusCode || 403).json({
        status: 'error',
        message: err.message || '無權綁定該分店',
      });
    }
  }

  try {
    const memberNo = await allocateUniqueMemberNo();
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          memberNo,
          name: String(name).trim(),
          phone: normalizedPhone,
          plan: '計時會員',
          expireDate: null,
          allowBiometrics: false,
          faceEnabled: wantFace,
          facePreferenceSet: true, // 開卡時已明確選擇是否用人臉
          role: 'MEMBER',
        },
      });
      await setMemberBranches(created.id, resolvedBranchIds, tx);
      if (wantFace) {
        const bio = await findBiometricsConsentContract(tx);
        if (bio?.id) {
          await ensurePendingSignatures(tx, created.id, [bio.id], {
            staffId: req.user?.id ?? null,
          });
        }
      }
      const branches = await listMemberBranches(created.id, tx);
      return { ...created, branches };
    });

    res.status(201).json({
      status: 'success',
      message: wantFace
        ? `會員 [${member.name}] 開卡成功（已啟用人臉，請完成生物辨識同意書簽署）`
        : `會員 [${member.name}] 開卡成功（分鐘計費／無效期）`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    if (error.code === 'P2002') {
      return res.status(400).json({
        status: 'error',
        message: '⛔ 此手機號碼已存在，請改用查詢或綁定既有帳號',
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '開卡失敗' });
  }
});

// ==========================================
// 0.03 【警示黑名單 / 欄位更新／分店綁定】
// PATCH /api/ops/members/:id
// Body: { isAlert?, faceEnabled?, name?, phone?, emergencyContact?, emergencyContactPhone?, branchIds? }
// 方案／效期唯讀：購案完成後由金流／商品流程寫入，禁止櫃檯手改
// allowBiometrics 改由生物辨識同意書簽署狀態同步，禁止手改
// faceEnabled：櫃檯勾選啟用人臉；為 true 時生物辨識同意書才標必簽
// ==========================================
router.patch('/members/:id', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }

  if (req.body?.plan !== undefined || req.body?.expireDate !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 方案與效期不可編輯：購買完成後由系統導入；分鐘計費固定無效期',
    });
  }

  // 禁止透過此 API 改錢包金額
  if (req.body.cashWallet !== undefined || req.body.bonusWallet !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 禁止直接修改錢包，請走儲值 / 退費 API',
    });
  }

  if (req.body?.lineId !== undefined || req.body?.deviceId !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ LINE／裝置綁定請走專用手動綁定 API，不可在一般更新夾帶',
    });
  }

  if (req.body?.allowBiometrics !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 生物辨識授權請改簽署「生物辨識同意書」合約，不可手動勾選',
    });
  }

  const allowed = [
    'isAlert',
    'faceEnabled',
    'name',
    'phone',
    'emergencyContact',
    'emergencyContactPhone',
  ];
  const data = {};
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;

    if (key === 'phone') {
      const phone = normalizePhone(req.body.phone);
      if (phone.length < 8) {
        return res.status(400).json({ status: 'error', message: '手機號碼格式無效' });
      }
      data.phone = phone;
      continue;
    }

    if (key === 'name') {
      const name = String(req.body.name || '').trim();
      if (!name) {
        return res.status(400).json({ status: 'error', message: '姓名不可為空' });
      }
      data.name = name;
      continue;
    }

    if (key === 'emergencyContact') {
      const value = String(req.body.emergencyContact || '').trim();
      data.emergencyContact = value || null;
      continue;
    }

    if (key === 'emergencyContactPhone') {
      const raw = String(req.body.emergencyContactPhone || '').trim();
      if (!raw) {
        data.emergencyContactPhone = null;
        continue;
      }
      const phone = normalizePhone(raw);
      if (phone.length < 8) {
        return res.status(400).json({ status: 'error', message: '緊急聯絡人電話格式無效' });
      }
      data.emergencyContactPhone = phone;
      continue;
    }

    if (key === 'isAlert' || key === 'faceEnabled') {
      data[key] = Boolean(req.body[key]);
      if (key === 'faceEnabled') {
        data.facePreferenceSet = true;
      }
      continue;
    }
  }

  const hasBranchIds = req.body?.branchIds !== undefined;
  let resolvedBranchIds = null;
  if (hasBranchIds) {
    resolvedBranchIds = Array.isArray(req.body.branchIds)
      ? req.body.branchIds.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!isAdminUser(req.user) && req.user?.branchId) {
      resolvedBranchIds = [req.user.branchId];
    }
    if (resolvedBranchIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: '請至少綁定一間分店',
      });
    }
    for (const bid of resolvedBranchIds) {
      try {
        assertBranchAccess(req, bid);
      } catch (err) {
        return res.status(err.statusCode || 403).json({
          status: 'error',
          message: err.message || '無權綁定該分店',
        });
      }
    }
  }

  if (Object.keys(data).length === 0 && !hasBranchIds) {
    return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
  }

  try {
    const member = await prisma.$transaction(async (tx) => {
      let updated;
      if (Object.keys(data).length > 0) {
        updated = await tx.member.update({
          where: { id: memberId },
          data,
        });
      } else {
        updated = await tx.member.findUnique({ where: { id: memberId } });
        if (!updated) {
          const err = new Error('找不到此會員');
          err.statusCode = 404;
          throw err;
        }
      }
      if (hasBranchIds) {
        await setMemberBranches(memberId, resolvedBranchIds, tx);
      }
      const branches = await listMemberBranches(memberId, tx);
      return { ...updated, branches };
    });

    res.json({
      status: 'success',
      message: `會員 [${member.name}] 資料已更新`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '此手機號碼已被其他會員使用' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新會員失敗' });
  }
});

// ==========================================
// 0.031 【手動綁定 LINE】
// POST /api/ops/members/:id/bind-line  Body: { lineId }
// POST /api/ops/members/:id/unbind-line
// ==========================================
router.post('/members/:id/bind-line', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const lineId = String(req.body?.lineId || '').trim();

  if (!Number.isInteger(memberId) || !lineId) {
    return res.status(400).json({ status: 'error', message: '需提供會員 ID 與 lineId' });
  }

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data: { lineId },
    });
    res.json({
      status: 'success',
      message: `會員 [${member.name}] 已手動綁定 LINE`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '此 LINE ID 已被其他會員綁定' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '綁定 LINE 失敗' });
  }
});

router.post('/members/:id/unbind-line', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data: { lineId: null },
    });
    res.json({
      status: 'success',
      message: `會員 [${member.name}] 已解除 LINE 綁定`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '解除 LINE 綁定失敗' });
  }
});

// ==========================================
// 0.032 【手動綁定裝置】
// POST /api/ops/members/:id/bind-device  Body: { deviceId }
// POST /api/ops/members/:id/unbind-device
// ==========================================
router.post('/members/:id/bind-device', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const deviceId = String(req.body?.deviceId || '').trim();

  if (!Number.isInteger(memberId) || !deviceId || deviceId.length < 8) {
    return res.status(400).json({
      status: 'error',
      message: '需提供會員 ID 與有效 deviceId（至少 8 碼）',
    });
  }

  try {
    const existing = await prisma.member.findUnique({ where: { id: memberId } });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }

    const bindPatch = deviceBindUpdateIfChanged(existing.deviceId, deviceId);
    const member = bindPatch
      ? await prisma.member.update({
          where: { id: memberId },
          data: bindPatch,
        })
      : existing;

    res.json({
      status: 'success',
      message: bindPatch
        ? `會員 [${member.name}] 已手動綁定裝置（舊裝置登入已失效）`
        : `會員 [${member.name}] 裝置碼未變更`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '綁定裝置失敗' });
  }
});

router.post('/members/:id/unbind-device', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data: deviceBindUpdateData({ deviceId: null }),
    });
    res.json({
      status: 'success',
      message: `會員 [${member.name}] 已解除裝置綁定（舊登入已失效）`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '解除裝置綁定失敗' });
  }
});

// ==========================================
// 0.04 【LINE 佔位帳號改綁真實手機】
// POST /api/ops/members/:id/bind-phone
// Body: { phone }
// ==========================================
router.post('/members/:id/bind-phone', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const phone = normalizePhone(req.body.phone);

  if (!Number.isInteger(memberId) || !phone) {
    return res.status(400).json({ status: 'error', message: '需提供會員 ID 與 phone' });
  }

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data: { phone },
    });
    res.json({
      status: 'success',
      message: `已將會員 [${member.name}] 手機綁定為 ${phone}`,
      data: toCounterMemberView(member),
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '此手機已被其他會員使用' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '綁定手機失敗' });
  }
});

// ==========================================
// 0.05 【退費折讓】強制回收贈送運動金 + ezPay 折讓單
// 網址：POST /api/ops/refund
// Payload：{ orderId?, invoiceNumber?, buyerEmail? }（至少 orderId 或 invoiceNumber）
// 有發票時固定開立折讓（產出可列印折讓單）；不作廢
// ==========================================
router.post('/refund', async (req, res) => {
  const { orderId: orderIdRaw, invoiceNumber: invoiceNumberRaw, buyerEmail: buyerEmailRaw, ...illegalFields } =
    req.body || {};

  if (Object.keys(illegalFields).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：退費 API 只允許 orderId、invoiceNumber、buyerEmail，已拒絕 [${Object.keys(illegalFields).join(', ')}]`,
    });
  }

  let buyerEmail;
  let invoiceNumberInput;
  try {
    buyerEmail = normalizeBuyerEmail(buyerEmailRaw);
    invoiceNumberInput = normalizeInvoiceNumberInput(invoiceNumberRaw);
  } catch (normErr) {
    return res.status(normErr.statusCode || 400).json({
      status: 'error',
      message: normErr.message,
    });
  }

  let orderId = orderIdRaw ? String(orderIdRaw).trim() : '';
  if (!orderId && !invoiceNumberInput) {
    return res.status(400).json({
      status: 'error',
      message: '參數錯誤：請提供 orderId 或 invoiceNumber',
    });
  }

  try {
    if (!orderId && invoiceNumberInput) {
      const byInv = await prisma.order.findFirst({
        where: { invoiceNumber: invoiceNumberInput, status: 'PAID' },
        orderBy: { createdAt: 'desc' },
      });
      if (!byInv) {
        return res.status(404).json({
          status: 'error',
          message: `找不到發票 ${invoiceNumberInput} 對應的已付款訂單`,
        });
      }
      orderId = byInv.id;
    }

    // ① 預覽計算（唯讀）→ ② ezPay 折讓 → ③ 錢包交易
    const preview = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });

      if (!order) {
        const err = new Error('找不到此訂單');
        err.statusCode = 404;
        throw err;
      }

      if (order.status !== 'PAID') {
        const err = new Error(`⛔ 訂單狀態為 [${order.status}]，僅已付款 (PAID) 訂單可退費`);
        err.statusCode = 400;
        throw err;
      }

      if (invoiceNumberInput) {
        const orderInv = order.invoiceNumber
          ? String(order.invoiceNumber).trim().toUpperCase()
          : '';
        if (orderInv && orderInv !== invoiceNumberInput) {
          const err = new Error(
            `發票號碼不符：訂單 ${order.id} 發票為 ${orderInv}，輸入為 ${invoiceNumberInput}`,
          );
          err.statusCode = 400;
          throw err;
        }
      }

      const meta = await resolveTopupMetaFromOrder(order, tx);
      if (meta.usageType === 'UNLIMITED') {
        const err = new Error('⛔ 無限使用方案購案訂單不支援自動退費，請改用「月卡訂閱／請假」取消結算');
        err.statusCode = 400;
        throw err;
      }

      const originalPrice = roundMoney(meta.price);
      const originalBonus = roundMoney(meta.bonusGiven);

      const member = await tx.member.findUnique({ where: { id: order.memberId } });
      if (!member) {
        const err = new Error('找不到此會員');
        err.statusCode = 404;
        throw err;
      }

      const recoveredBonus = roundMoney(Math.min(member.bonusWallet, originalBonus));
      const shortfall = roundMoney(originalBonus - recoveredBonus);
      const remainingPrincipal = roundMoney(Math.min(member.cashWallet, originalPrice));
      const refundCash = roundMoney(remainingPrincipal - shortfall);

      if (refundCash < 0) {
        const err = new Error(
          `⛔ 退費阻擋：運動金已消耗且本金殘值不足以折讓。` +
            `本金殘值 $${remainingPrincipal} − 已消耗運動金 $${shortfall} = $${refundCash}。` +
            `請人工處理，禁止套利退費。`,
        );
        err.statusCode = 403;
        throw err;
      }

      const invoiceCtx = await resolveOrderInvoiceReverse(order, { refundCash, tx });
      // 退費折讓：有「真實」發票且應退現金 > 0 才開立折讓；禁止 SPLIT:／複合標記與 $0 全額折讓
      const pickRealInvoice = (n) => {
        const s = String(n || '').trim();
        if (!s || s.startsWith('SPLIT:') || s.includes(',')) return null;
        return s;
      };
      const resolvedInv =
        pickRealInvoice(invoiceCtx.invoiceNumber) || pickRealInvoice(invoiceNumberInput);
      if (resolvedInv && refundCash > 0) {
        invoiceCtx.invoiceNumber = resolvedInv;
        invoiceCtx.prefer = 'allowance';
        invoiceCtx.skip = false;
        invoiceCtx.amount = roundMoney(
          invoiceCtx.amount > 0 ? invoiceCtx.amount : refundCash,
        );
      } else {
        invoiceCtx.invoiceNumber = resolvedInv;
        invoiceCtx.skip = true;
        invoiceCtx.amount = 0;
        if (!invoiceCtx.skipReason) {
          invoiceCtx.skipReason =
            refundCash <= 0 ? '應退現金為 0，無需折讓／作廢' : '無可用發票號碼';
        }
      }

      return {
        order,
        member,
        meta,
        originalPrice,
        originalBonus,
        recoveredBonus,
        shortfall,
        remainingPrincipal,
        refundCash,
        invoiceCtx,
      };
    });

    let invoiceReverse = { action: 'none', invoiceNumber: null };
    try {
      invoiceReverse = await executeInvoiceReverse(preview.invoiceCtx, {
        reason: '退費折讓',
        buyerEmail,
        prefer: 'allowance',
      });
    } catch (ezErr) {
      console.error(`退費 ${orderId} ezPay 折讓失敗:`, ezErr);
      return res.status(ezErr.statusCode || 502).json({
        status: 'error',
        message: ezErr.message || 'ezPay 折讓失敗，退費已中止（錢包未異動）',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        const err = new Error('找不到此訂單');
        err.statusCode = 404;
        throw err;
      }
      if (order.status === 'REFUNDED') {
        const member = await tx.member.findUnique({ where: { id: order.memberId } });
        return {
          alreadyRefunded: true,
          member,
          order,
          refundCash: preview.refundCash,
          recoveredBonus: preview.recoveredBonus,
          shortfall: preview.shortfall,
          remainingPrincipal: preview.remainingPrincipal,
        };
      }
      if (order.status !== 'PAID') {
        const err = new Error('訂單狀態已變更，請重新查詢後再退費（若折讓已開立請人工核對）');
        err.statusCode = 409;
        throw err;
      }

      const member = await tx.member.findUnique({ where: { id: order.memberId } });
      if (!member) {
        const err = new Error('找不到此會員');
        err.statusCode = 404;
        throw err;
      }

      const recoveredBonus = roundMoney(
        Math.min(member.bonusWallet, preview.originalBonus),
      );
      const shortfall = roundMoney(preview.originalBonus - recoveredBonus);
      const remainingPrincipal = roundMoney(
        Math.min(member.cashWallet, preview.originalPrice),
      );
      const refundCash = roundMoney(remainingPrincipal - shortfall);
      if (refundCash < 0) {
        const err = new Error(
          '⛔ 退費阻擋：錢包狀態已變更，本金殘值不足以折讓。若折讓已開立請人工核對。',
        );
        err.statusCode = 409;
        throw err;
      }
      if (refundCash !== preview.refundCash || remainingPrincipal !== preview.remainingPrincipal) {
        console.warn(
          `退費 ${orderId} 寫入時金額與預覽不一致：preview=$${preview.refundCash} now=$${refundCash}`,
        );
      }

      const updatedMember = await tx.member.update({
        where: { id: member.id },
        data: {
          bonusWallet: { decrement: recoveredBonus },
          cashWallet: { decrement: remainingPrincipal },
        },
      });

      const clawbackNote =
        `退費折讓：本金殘值$${remainingPrincipal}` +
        ` − 已消耗運動金$${shortfall} = 應退$${refundCash}` +
        `（回收運動金$${recoveredBonus}）`;

      const statusUpdated = await tx.order.updateMany({
        where: { id: order.id, status: 'PAID' },
        data: {
          status: 'REFUNDED',
          itemDesc: appendInvoiceReverseNote(
            `${order.itemDesc} | ${clawbackNote}`,
            invoiceReverse,
          ),
        },
      });
      if (statusUpdated.count === 0) {
        const err = new Error('訂單狀態已變更，請重新查詢（若折讓已開立請人工核對）');
        err.statusCode = 409;
        throw err;
      }

      const refundedOrder = await tx.order.findUnique({ where: { id: order.id } });

      await syncCheckoutInvoiceAfterReverse(
        tx,
        preview.invoiceCtx.checkoutSessionId,
        invoiceReverse,
      );
      await reevaluateCheckoutSessionStatus(
        tx,
        preview.invoiceCtx.checkoutSessionId,
      );

      return {
        member: updatedMember,
        order: refundedOrder,
        refundCash,
        recoveredBonus,
        shortfall,
        remainingPrincipal,
      };
    });

    let allowanceSlip = null;
    if (invoiceReverse.action === 'allowance') {
      const branchId =
        (await resolveBranchIdForOrder(preview.order)) ||
        req.user?.branchId ||
        null;
      const sellerHeader = await resolveInvoiceSellerHeader(branchId);
      allowanceSlip = await savePrintableAllowanceSlip({
        reverseResult: invoiceReverse,
        orderId: result.order.id,
        memberId: result.member.id,
        memberName: result.member.name,
        itemDesc: preview.order.itemDesc,
        buyerEmail,
        merchantOrderNo: preview.invoiceCtx.merchantOrderNo,
        amount: invoiceReverse.allowanceAmt || preview.invoiceCtx.amount,
        source: 'REFUND',
        staffId: req.user?.id ?? null,
        sellerHeader,
      });
    }

    const invMsg =
      invoiceReverse.action === 'allowance'
        ? `，已開立折讓單 ${invoiceReverse.allowanceNo}（發票 ${invoiceReverse.invoiceNumber}／$${invoiceReverse.allowanceAmt}）`
        : invoiceReverse.action === 'void'
          ? `，發票 ${invoiceReverse.invoiceNumber} 已作廢`
          : preview.invoiceCtx?.skipReason
            ? `（${preview.invoiceCtx.skipReason}）`
            : '';

    res.json({
      status: 'success',
      message: result.alreadyRefunded
        ? `訂單 ${orderId} 已是退費狀態`
        : `【體育客】訂單 ${orderId} 退費折讓完成，應退現金 $${result.refundCash}${invMsg}`,
      data: {
        orderId: result.order.id,
        memberId: result.member.id,
        memberName: result.member.name,
        clawback: {
          originalPrice: preview.originalPrice,
          originalBonus: preview.originalBonus,
          recoveredBonus: result.recoveredBonus,
          spentBonus: result.shortfall,
          remainingPrincipal: result.remainingPrincipal,
          refundCash: result.refundCash,
        },
        wallet: {
          cash: result.member.cashWallet,
          bonus: result.member.bonusWallet,
        },
        invoice: invoiceReverse,
        allowanceSlip,
        buyerEmail: buyerEmail || null,
        invoiceNumber: invoiceReverse.invoiceNumber || preview.order.invoiceNumber || invoiceNumberInput,
      },
    });
  } catch (error) {
    console.error('退費失敗:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '退費失敗' });
  }
});

/** 依發票號碼查詢可退費訂單（帶出訂單／發票） */
router.get('/refund-lookup', async (req, res) => {
  try {
    const invoiceNumber = normalizeInvoiceNumberInput(req.query.invoiceNumber);
    const orderId = req.query.orderId ? String(req.query.orderId).trim() : '';
    if (!invoiceNumber && !orderId) {
      return res.status(400).json({
        status: 'error',
        message: '請提供 invoiceNumber 或 orderId',
      });
    }
    const order = orderId
      ? await prisma.order.findUnique({
          where: { id: orderId },
          include: { member: { select: { id: true, name: true, memberNo: true, phone: true } } },
        })
      : await prisma.order.findFirst({
          where: { invoiceNumber, status: { in: ['PAID', 'REFUNDED'] } },
          orderBy: { createdAt: 'desc' },
          include: { member: { select: { id: true, name: true, memberNo: true, phone: true } } },
        });
    if (!order) {
      return res.status(404).json({ status: 'error', message: '找不到訂單' });
    }
    const allowances = await prisma.invoiceAllowance.findMany({
      where: {
        OR: [
          { orderId: order.id },
          ...(order.invoiceNumber ? [{ invoiceNumber: order.invoiceNumber }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    res.json({
      status: 'success',
      data: {
        order: {
          id: order.id,
          status: order.status,
          amount: order.amount,
          invoiceNumber: order.invoiceNumber,
          itemDesc: order.itemDesc,
          createdAt: order.createdAt,
        },
        member: order.member,
        allowances: allowances.map((a) => toPrintableAllowance(a)),
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '查詢失敗' });
  }
});

/** 折讓單列印資料 */
router.get('/allowances/:allowanceNo', async (req, res) => {
  try {
    const no = String(req.params.allowanceNo || '').trim();
    const row = await prisma.invoiceAllowance.findUnique({ where: { allowanceNo: no } });
    if (!row) {
      return res.status(404).json({ status: 'error', message: '找不到折讓單' });
    }
    res.json({ status: 'success', data: toPrintableAllowance(row) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取折讓單失敗' });
  }
});

router.get('/allowances', async (req, res) => {
  try {
    const take = Math.min(50, parseInt(req.query.take, 10) || 20);
    const orderId = req.query.orderId ? String(req.query.orderId).trim() : null;
    const invoiceNumber = req.query.invoiceNumber
      ? normalizeInvoiceNumberInput(req.query.invoiceNumber)
      : null;
    const rows = await prisma.invoiceAllowance.findMany({
      where: {
        ...(orderId ? { orderId } : {}),
        ...(invoiceNumber ? { invoiceNumber } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    res.json({ status: 'success', data: rows.map((r) => toPrintableAllowance(r)) });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取折讓單失敗' });
  }
});

function parsePayBreakdown(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

// ==========================================
// 0.06 【取消商品銷售】PAID／PENDING → CANCELLED；已扣庫則回補；零錢包退回
// 有發票時先呼叫 ezPay 作廢（失敗則全額／部分折讓），成功後才改單據
// POST /api/ops/cancel-sale  { saleId, reason? }
// ==========================================
router.post('/cancel-sale', async (req, res) => {
  const { saleId, reason, prefer, ...illegal } = req.body || {};
  if (Object.keys(illegal).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：只允許 saleId、reason、prefer，已拒絕 [${Object.keys(illegal).join(', ')}]`,
    });
  }
  const id = String(saleId || '').trim();
  if (!id) {
    return res.status(400).json({ status: 'error', message: '請提供銷貨單號 saleId（SAL…）' });
  }
  const preferMode =
    prefer === 'allowance' || prefer === 'void' ? prefer : null;

  try {
    const sale = await prisma.saleOrder.findUnique({
      where: { id },
      include: { items: true, member: { select: { id: true, name: true } } },
    });
    if (!sale) {
      return res.status(404).json({ status: 'error', message: '找不到此銷貨單' });
    }
    if (sale.status === 'CANCELLED') {
      return res.status(400).json({ status: 'error', message: '此銷貨單已取消' });
    }
    if (sale.status !== 'PAID' && sale.status !== 'PENDING') {
      return res.status(400).json({
        status: 'error',
        message: `⛔ 狀態 [${sale.status}] 不可取消`,
      });
    }

    assertBranchAccess(req, sale.branchId);

    const wasPaid = sale.status === 'PAID';
    const invoiceCtx = wasPaid
      ? await resolveSaleInvoiceReverse(sale)
      : {
          invoiceNumber: null,
          merchantOrderNo: sale.id,
          amount: 0,
          itemDesc: sale.itemDesc,
          prefer: 'void',
          checkoutSessionId: sale.checkoutSessionId || null,
          sharedInvoice: false,
          skip: true,
        };

    if (preferMode === 'allowance') {
      invoiceCtx.prefer = 'allowance';
    } else if (preferMode === 'void' && !invoiceCtx.sharedInvoice) {
      invoiceCtx.prefer = 'void';
    }

    let invoiceReverse = { action: 'none', invoiceNumber: null };
    if (wasPaid && invoiceCtx.invoiceNumber && !invoiceCtx.skip) {
      try {
        invoiceReverse = await executeInvoiceReverse(invoiceCtx, {
          reason: reason || '取消銷貨',
          prefer: invoiceCtx.prefer,
        });
      } catch (ezErr) {
        console.error(`取消銷貨 ${id} ezPay 反向失敗:`, ezErr);
        return res.status(ezErr.statusCode || 502).json({
          status: 'error',
          message: ezErr.message || 'ezPay 發票作廢／折讓失敗，取消已中止（庫存／錢包未異動）',
        });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const fresh = await tx.saleOrder.findUnique({
        where: { id },
        include: { items: true, member: { select: { id: true, name: true } } },
      });
      if (!fresh) {
        const err = new Error('找不到此銷貨單');
        err.statusCode = 404;
        throw err;
      }
      if (fresh.status === 'CANCELLED') {
        return {
          alreadyCancelled: true,
          sale: fresh,
          wasPaid: false,
          restocked: false,
          walletRefunded: 0,
          memberName: fresh.member?.name || null,
          memberWallet: null,
          invoiceNumber: fresh.invoiceNumber,
          payMethod: fresh.payMethod,
        };
      }
      if (fresh.status !== 'PAID' && fresh.status !== 'PENDING') {
        const err = new Error(
          '銷貨單狀態已變更，請重新查詢（若發票已作廢／折讓請人工核對）',
        );
        err.statusCode = 409;
        throw err;
      }

      const paidNow = fresh.status === 'PAID';
      if (paidNow) {
        await restockSaleStock(tx, fresh, req.user?.id ?? null);
      }

      const breakdown = parsePayBreakdown(fresh.payBreakdown);
      let walletRefunded = 0;
      let memberWallet = null;
      if (paidNow) {
        let sessionAmount = fresh.amount;
        if (fresh.checkoutSessionId) {
          const sess = await tx.checkoutSession.findUnique({
            where: { id: fresh.checkoutSessionId },
            select: { amount: true },
          });
          if (sess?.amount) sessionAmount = sess.amount;
        }
        const walletCash = prorateCheckoutWalletCash({
          payBreakdown: breakdown,
          legAmount: fresh.amount,
          sessionAmount,
        });
        if (walletCash > 0) {
          if (!fresh.memberId) {
            const err = new Error('銷貨含零錢包扣款但無會員，無法自動退回');
            err.statusCode = 400;
            throw err;
          }
          const member = await tx.member.update({
            where: { id: fresh.memberId },
            data: { cashWallet: { increment: walletCash } },
          });
          walletRefunded = walletCash;
          memberWallet = { cash: member.cashWallet, bonus: member.bonusWallet };
        }
      }

      const note = String(reason || '').trim();
      const descBase = `${fresh.itemDesc || ''}｜已取消${note ? `：${note}` : ''}`;
      const cancelUpdated = await tx.saleOrder.updateMany({
        where: { id, status: { in: ['PAID', 'PENDING'] } },
        data: {
          status: 'CANCELLED',
          itemDesc: appendInvoiceReverseNote(descBase, invoiceReverse),
        },
      });
      if (cancelUpdated.count === 0) {
        const err = new Error(
          '銷貨單狀態已變更，請重新查詢（若發票已作廢／折讓請人工核對）',
        );
        err.statusCode = 409;
        throw err;
      }

      const updated = await tx.saleOrder.findUnique({ where: { id } });

      await syncCheckoutInvoiceAfterReverse(
        tx,
        invoiceCtx.checkoutSessionId,
        invoiceReverse,
      );
      await reevaluateCheckoutSessionStatus(tx, invoiceCtx.checkoutSessionId);

      return {
        sale: updated,
        wasPaid: paidNow,
        restocked: paidNow,
        walletRefunded,
        memberName: fresh.member?.name || null,
        memberWallet,
        invoiceNumber: invoiceCtx.invoiceNumber || fresh.invoiceNumber,
        payMethod: fresh.payMethod,
        amount: fresh.amount,
        invoice: invoiceReverse,
        sharedInvoice: Boolean(invoiceCtx.sharedInvoice),
      };
    });

    const invMsg =
      result.invoice?.action === 'void'
        ? `，發票 ${result.invoice.invoiceNumber} 已作廢`
        : result.invoice?.action === 'allowance'
          ? `，發票 ${result.invoice.invoiceNumber} 已開立折讓 ${result.invoice.allowanceNo}${
              result.sharedInvoice ? '（合併結帳部分折讓）' : ''
            }`
          : '';

    let allowanceSlip = null;
    if (result.invoice?.action === 'allowance') {
      const sellerHeader = await resolveInvoiceSellerHeader(sale.branchId);
      allowanceSlip = await savePrintableAllowanceSlip({
        reverseResult: result.invoice,
        saleOrderId: id,
        memberId: sale.memberId,
        memberName: result.memberName,
        itemDesc: sale.itemDesc,
        merchantOrderNo: result.invoice.merchantOrderNo || id,
        amount: result.invoice.allowanceAmt || sale.amount,
        source: 'CANCEL_SALE',
        staffId: req.user?.id ?? null,
        sellerHeader,
      });
    }

    res.json({
      status: 'success',
      message: result.alreadyCancelled
        ? `銷貨 [${id}] 已是取消狀態`
        : result.wasPaid
        ? `銷貨 [${id}] 已取消並回補庫存${
            result.walletRefunded > 0 ? `，零錢包退回 $${result.walletRefunded}` : ''
          }；現金／刷卡／抵用券請人工處理${invMsg}`
        : `銷貨 [${id}]（待付款）已取消，尚未扣庫無需回補`,
      data: { ...result, allowanceSlip },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '取消銷貨失敗' });
  }
});

// ==========================================
// 0.06b 【取消私教課程購買】CHK… 或獨立私教 Order
// POST /api/ops/cancel-pt-purchase  { checkoutId?, orderId?, reason?, prefer? }
// prefer: void＝取消沖回｜allowance＝退費折讓
// ==========================================
router.post('/cancel-pt-purchase', async (req, res) => {
  const { checkoutId, orderId, reason, prefer, ...illegal } = req.body || {};
  if (Object.keys(illegal).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：只允許 checkoutId、orderId、reason、prefer，已拒絕 [${Object.keys(illegal).join(', ')}]`,
    });
  }
  try {
    const chk = checkoutId ? String(checkoutId).trim().toUpperCase() : '';
    const oid = orderId ? String(orderId).trim().toUpperCase() : '';
    if (chk) {
      const session = await prisma.checkoutSession.findUnique({
        where: { id: chk },
        select: { branchId: true },
      });
      if (!session) {
        return res.status(404).json({ status: 'error', message: '找不到此結帳編號' });
      }
      if (session.branchId != null) assertBranchAccess(req, session.branchId);
    } else if (oid) {
      const order = await prisma.order.findUnique({
        where: { id: oid },
        select: { checkoutSessionId: true, itemDesc: true },
      });
      if (!order) {
        return res.status(404).json({ status: 'error', message: '找不到此訂單' });
      }
      if (order.checkoutSessionId) {
        const session = await prisma.checkoutSession.findUnique({
          where: { id: order.checkoutSessionId },
          select: { branchId: true },
        });
        if (session?.branchId != null) assertBranchAccess(req, session.branchId);
      }
    }

    const mode = String(prefer || 'void').toLowerCase() === 'allowance' ? 'allowance' : 'void';
    const result = await cancelPtPurchase({
      checkoutId: chk || undefined,
      orderId: oid || undefined,
      reason,
      prefer: mode,
      staffId: req.user?.id ?? null,
    });
    const invMsg =
      result.invoice?.action === 'void'
        ? `，發票 ${result.invoice.invoiceNumber} 已作廢`
        : result.invoice?.action === 'allowance'
          ? `，發票已開立折讓 ${result.invoice.allowanceNo}`
          : '';

    let allowanceSlip = null;
    if (result.invoice?.action === 'allowance') {
      let branchId = req.user?.branchId || null;
      let memberId = null;
      let memberName = null;
      let itemDesc = null;
      const primaryOrderId = result.orderIds?.[0] || oid || null;
      if (primaryOrderId) {
        const order = await prisma.order.findUnique({
          where: { id: primaryOrderId },
          include: { member: { select: { id: true, name: true } } },
        });
        memberId = order?.memberId ?? null;
        memberName = order?.member?.name || null;
        itemDesc = order?.itemDesc || null;
        branchId =
          (await resolveBranchIdForOrder(order)) || branchId;
      } else if (result.checkoutId) {
        const session = await prisma.checkoutSession.findUnique({
          where: { id: result.checkoutId },
          include: { member: { select: { id: true, name: true } } },
        });
        branchId = session?.branchId || branchId;
        memberId = session?.memberId ?? null;
        memberName = session?.member?.name || null;
        itemDesc = session?.itemDesc || null;
      }
      const sellerHeader = await resolveInvoiceSellerHeader(branchId);
      allowanceSlip = await savePrintableAllowanceSlip({
        reverseResult: result.invoice,
        orderId: primaryOrderId,
        memberId,
        memberName,
        itemDesc,
        merchantOrderNo: result.invoice.merchantOrderNo || primaryOrderId,
        amount: result.invoice.allowanceAmt || result.amount,
        source: 'CANCEL_PT',
        staffId: req.user?.id ?? null,
        sellerHeader,
      });
    }

    res.json({
      status: 'success',
      message:
        mode === 'allowance'
          ? `私教購案已退費折讓${result.walletRefunded > 0 ? `，零錢包退回 $${result.walletRefunded}` : ''}${invMsg}`
          : `私教購案已取消沖回${result.walletRefunded > 0 ? `，零錢包退回 $${result.walletRefunded}` : ''}${invMsg}`,
      data: { ...result, allowanceSlip },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '取消私教購案失敗' });
  }
});

// ==========================================
// 0.07 【取消進出場】依 CheckInLog id
// - 在場中：直接取消進場（不扣費）— ops 可操作
// - 已出場：費用退回零錢包 — 限 DUTY+
// POST /api/ops/cancel-gate  { logId, reason? }
// ==========================================
router.post('/cancel-gate', async (req, res) => {
  const { logId, reason, ...illegal } = req.body || {};
  if (Object.keys(illegal).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：只允許 logId、reason，已拒絕 [${Object.keys(illegal).join(', ')}]`,
    });
  }

  try {
    const id = await resolveGateLogId(logId, prisma);
    if (!id) {
      return res.status(400).json({
        status: 'error',
        message: '請提供有效的進出場單號（ACC＋日期時間 或數字 id）',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const log = await tx.checkInLog.findUnique({
        where: { id },
        include: { member: { select: { id: true, name: true, phone: true } } },
      });
      if (!log) {
        const err = new Error('找不到此進出場紀錄');
        err.statusCode = 404;
        throw err;
      }
      if (log.status === 'CANCELLED') {
        const err = new Error('此進出場紀錄已取消');
        err.statusCode = 400;
        throw err;
      }

      if (log.branchId) {
        assertBranchAccess(req, log.branchId);
      }

      const fee = roundMoney(Number(log.fee) || 0);
      const wasCheckedOut = Boolean(log.checkOutAt);

      if (wasCheckedOut && !hasDutyRankOrAbove(req.user)) {
        const err = new Error('⛔ 已出場紀錄取消退費僅限 DUTY（值星）以上');
        err.statusCode = 403;
        throw err;
      }

      let refundedFee = 0;
      let memberWallet = null;

      if (wasCheckedOut && fee > 0) {
        const member = await tx.member.update({
          where: { id: log.memberId },
          data: { cashWallet: { increment: fee } },
        });
        refundedFee = fee;
        memberWallet = { cash: member.cashWallet, bonus: member.bonusWallet };
      }

      const note = String(reason || '').trim() || null;
      const updated = await tx.checkInLog.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: note,
          cancelledByStaffId: req.user?.id ?? null,
          // 在場中取消：視同結束在場狀態，避免佔用防卡單
          checkOutAt: log.checkOutAt || new Date(),
        },
      });

      return {
        logId: updated.id,
        gateAccessNo: formatGateAccessNo(log.checkInAt),
        memberId: log.memberId,
        memberName: log.member?.name,
        wasCheckedOut,
        originalFee: fee,
        refundedFee,
        memberWallet,
        billingMode: log.billingMode,
      };
    });

    broadcastOccupancy({ type: 'gate-cancel', memberId: result.memberId }).catch(() => {});

    const accessLabel = result.gateAccessNo || `#${result.logId}`;
    res.json({
      status: 'success',
      message: result.wasCheckedOut
        ? `進出場 ${accessLabel} 已取消${result.refundedFee > 0 ? `，費用 $${result.refundedFee} 已退回零錢包` : '（原無計費）'}`
        : `進出場 ${accessLabel} 進場已取消（會員改為離場）`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '取消進出場失敗' });
  }
});

// ==========================================
// 進場會員列表（在場中）
// GET /api/ops/check-ins/active?branchId=
// ==========================================
router.get('/check-ins/active', async (req, res) => {
  try {
    const rawBranch = req.query.branchId;
    let branchId = null;
    if (rawBranch !== undefined && rawBranch !== '' && rawBranch !== 'all') {
      branchId = parseInt(rawBranch, 10);
      if (!Number.isInteger(branchId) || branchId <= 0) {
        return res.status(400).json({ status: 'error', message: 'branchId 無效' });
      }
      assertBranchAccess(req, branchId);
    } else if (!isAdminUser(req.user)) {
      if (!req.user?.branchId) {
        return res.status(403).json({ status: 'error', message: '⛔ 帳號未綁定分店' });
      }
      branchId = req.user.branchId;
    }

    const logs = await prisma.checkInLog.findMany({
      where: {
        checkOutAt: null,
        status: 'ACTIVE',
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { checkInAt: 'desc' },
      include: {
        member: { select: { id: true, memberNo: true, name: true, phone: true, plan: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });

    res.json({
      status: 'success',
      data: logs.map((log) => ({
        logId: log.id,
        gateAccessNo: formatGateAccessNo(log.checkInAt),
        memberId: log.memberId,
        memberNo: log.member?.memberNo || '',
        name: log.member?.name || '',
        phone: log.member?.phone || null,
        plan: log.member?.plan || null,
        billingMode: log.billingMode,
        checkInAt: log.checkInAt,
        branchId: log.branchId,
        branchLabel: log.branch
          ? [log.branch.code, log.branch.name].filter(Boolean).join(' · ')
          : null,
      })),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '查詢進場會員失敗' });
  }
});

// ==========================================
// 櫃檯補登出場（依進場快照計費，非取消）
// POST /api/ops/check-ins/:logId/check-out
// ==========================================
router.post('/check-ins/:logId/check-out', async (req, res) => {
  const logId = parseInt(req.params.logId, 10);
  if (!Number.isInteger(logId) || logId <= 0) {
    return res.status(400).json({ status: 'error', message: '進出場單號無效' });
  }

  try {
    const log = await prisma.checkInLog.findUnique({
      where: { id: logId },
      select: {
        id: true,
        memberId: true,
        branchId: true,
        checkOutAt: true,
        status: true,
        billingMode: true,
      },
    });
    if (!log) {
      return res.status(404).json({ status: 'error', message: '找不到此進出場紀錄' });
    }
    if (log.status === 'CANCELLED') {
      return res.status(400).json({ status: 'error', message: '此進出場紀錄已取消' });
    }
    if (log.checkOutAt) {
      return res.status(400).json({ status: 'error', message: '此會員已出場，無需補登' });
    }
    if (!log.branchId) {
      return res.status(400).json({ status: 'error', message: '此進場紀錄未綁定分店，無法補登出場' });
    }
    assertBranchAccess(req, log.branchId);

    const result = await processCheckOut({
      memberId: log.memberId,
      exitMethod: 'STAFF',
      branchId: log.branchId,
      logId: log.id,
    });
    broadcastCheckOut(result);
    const payload = checkOutSuccessPayload(result);
    return res.json({
      ...payload,
      data: {
        logId: result.log.id,
        memberName: result.member.name,
        feeDetails: result.feeDetails,
        remaining: result.remaining,
        billingMode: result.billingMode,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '補登出場失敗' });
  }
});

// ==========================================
// 0.1 查詢上架中的儲值商品（櫃檯選購用）
// 網址：GET /api/ops/promotions
// ==========================================
router.get('/promotions', async (req, res) => {
  try {
    const promotions = await prisma.promotion.findMany({
      where: promotionSellablePrismaWhere(promotionListWhere(req)),
      include: {
        branch: { select: { id: true, name: true, code: true } },
        contractLinks: {
          include: {
            contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    res.json({
      status: 'success',
      data: promotions.map((p) => {
        const { contractLinks, ...rest } = p;
        return {
          ...rest,
          contracts: mapPromotionContracts({ contractLinks }),
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取促銷商品失敗' });
  }
});

// ==========================================
// 會員合約：列表／指派待簽／電子簽名存檔
// ==========================================
router.get('/members/:id/contracts', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }
  try {
    const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    const { boardByMember } = await buildMembersContractBoard([memberId]);
    const board = boardByMember.get(memberId) || [];

    // 一併回傳已有簽署列（含正文，供展開簽名）
    const rows = await prisma.memberContractSignature.findMany({
      where: { memberId },
      include: {
        contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
        contractVersion: {
          select: { id: true, version: true, body: true, changeNote: true },
        },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    res.json({
      status: 'success',
      data: {
        board,
        signatures: rows.map(serializeSignature),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取會員合約失敗' });
  }
});

// POST /api/ops/members/:id/contracts/open  { contractId }
// 點選合約展開簽署：確保目前版本有 PENDING／SIGNED 列並回傳完整內容
router.post('/members/:id/contracts/open', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const contractId = parseInt(req.body?.contractId, 10);
  if (!Number.isInteger(memberId) || !Number.isInteger(contractId)) {
    return res.status(400).json({ status: 'error', message: '需提供會員 ID 與 contractId' });
  }

  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, name: true },
    });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }

    const contract = await prisma.membershipContract.findFirst({
      where: { id: contractId, status: 'ACTIVE' },
      select: { id: true, title: true },
    });
    if (!contract) {
      return res.status(404).json({ status: 'error', message: '找不到啟用中的合約' });
    }

    const row = await prisma.$transaction(async (tx) => {
      await ensurePendingSignatures(tx, memberId, [contractId], {
        staffId: req.user?.id ?? null,
      });
      const version = await tx.membershipContractVersion.findFirst({
        where: { contractId, status: 'ACTIVE' },
        orderBy: { version: 'desc' },
      });
      return tx.memberContractSignature.findUnique({
        where: {
          memberId_contractVersionId: {
            memberId,
            contractVersionId: version.id,
          },
        },
        include: {
          contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
          contractVersion: {
            select: { id: true, version: true, body: true, changeNote: true },
          },
        },
      });
    });

    const [{ boardByMember }, history] = await Promise.all([
      buildMembersContractBoard([memberId]),
      listMemberContractHistory(memberId, contractId),
    ]);
    const boardItem = (boardByMember.get(memberId) || []).find(
      (b) => b.contractId === contractId,
    );

    res.json({
      status: 'success',
      data: {
        signature: serializeSignature(row),
        boardItem: boardItem || null,
        history,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '開啟合約失敗' });
  }
});

// POST /api/ops/members/:id/contracts/assign  { contractIds } 或 { promotionId }
router.post('/members/:id/contracts/assign', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true, name: true } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }

    let contractIds = parseContractIds(req.body?.contractIds) || [];
    const promotionIdRaw = req.body?.promotionId;
    if (promotionIdRaw !== undefined && promotionIdRaw !== null && promotionIdRaw !== '') {
      const promotionId = parseInt(promotionIdRaw, 10);
      if (!Number.isInteger(promotionId)) {
        return res.status(400).json({ status: 'error', message: 'promotionId 無效' });
      }
      const promo = await prisma.promotion.findUnique({
        where: { id: promotionId },
        include: {
          contractLinks: { select: { contractId: true } },
        },
      });
      if (!promo) {
        return res.status(404).json({ status: 'error', message: '找不到此方案' });
      }
      assertBranchAccess(req, promo.branchId);
      if (!promo.requiresMemberContract) {
        return res.status(400).json({
          status: 'error',
          message: '此方案未勾選需簽署會員合約',
        });
      }
      contractIds = promo.contractLinks.map((l) => l.contractId);
    }

    if (!contractIds.length) {
      return res.status(400).json({
        status: 'error',
        message: '請提供 contractIds 或 promotionId',
      });
    }

    const clientMeta = getRequestClientMeta(req);
    const rows = await prisma.$transaction(async (tx) => {
      await assertActiveContracts(tx, contractIds);
      const created = await ensurePendingSignatures(tx, memberId, contractIds, {
        staffId: req.user?.id ?? null,
      });
      for (const sig of created.newlyCreated || []) {
        await writeContractAudit(tx, {
          contractId: sig.contractId,
          memberId,
          signatureId: sig.id,
          versionId: sig.contractVersionId,
          action: 'ASSIGN',
          summary: `指派待簽電子合約給會員 #${memberId}`,
          detail: { contractIds },
          actorStaffId: req.user?.id ?? null,
          actorType: 'STAFF',
          ...clientMeta,
        });
      }
      return tx.memberContractSignature.findMany({
        where: { memberId, contractId: { in: contractIds } },
        include: {
          contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
          contractVersion: {
            select: { id: true, version: true, body: true, bodyHash: true, status: true },
          },
        },
        orderBy: { id: 'desc' },
      });
    });

    res.json({
      status: 'success',
      message: `已為會員 [${member.name}] 建立／更新待簽電子合約`,
      data: rows.map(serializeSignature),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '指派電子合約失敗' });
  }
});

// POST /api/ops/members/:id/contracts/:signId/resign — 已簽版本改回待簽（重簽；舊簽名進稽核）
router.post('/members/:id/contracts/:signId/resign', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const signId = parseInt(req.params.signId, 10);
  const clientMeta = getRequestClientMeta(req);
  if (!Number.isInteger(memberId) || !Number.isInteger(signId)) {
    return res.status(400).json({ status: 'error', message: '無效的參數' });
  }

  try {
    const existing = await prisma.memberContractSignature.findFirst({
      where: { id: signId, memberId },
      include: {
        contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
        contractVersion: {
          select: { id: true, version: true, body: true, bodyHash: true, changeNote: true, status: true },
        },
      },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到此合約簽署紀錄' });
    }
    if (existing.contract?.status !== 'ACTIVE') {
      return res.status(400).json({ status: 'error', message: '此合約已作廢，無法重簽' });
    }
    if (existing.contractVersion?.status !== 'ACTIVE') {
      return res.status(400).json({
        status: 'error',
        message: '此合約版本已作廢，請開啟目前版本重新簽署',
      });
    }
    if (existing.status !== 'SIGNED') {
      return res.status(400).json({ status: 'error', message: '僅已簽署的合約可重簽' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await writeContractAudit(tx, {
        contractId: existing.contractId,
        memberId,
        signatureId: existing.id,
        versionId: existing.contractVersionId,
        action: 'RESIGN',
        summary: `電子合約重簽準備：${existing.contract?.title || existing.contractId}`,
        changeNote: String(req.body?.changeNote || '').trim() || '現場要求重簽',
        detail: {
          previousStatus: existing.status,
          previousSignedAt: existing.signedAt,
          previousBodyHash: existing.bodyHash || existing.contractVersion?.bodyHash || null,
          previousIpAddress: existing.ipAddress || null,
          previousActorType: existing.actorType || null,
          previousStaffId: existing.staffId || null,
          // 舊簽名完整快照，避免清掉 signatureData 後失去證據
          previousSignatureData: existing.signatureData || null,
        },
        actorStaffId: req.user?.id ?? null,
        actorType: 'STAFF',
        ...clientMeta,
      });

      return tx.memberContractSignature.update({
        where: { id: signId },
        data: {
          status: 'PENDING',
          signatureData: null,
          bodyHash: null,
          ipAddress: null,
          userAgent: null,
          actorType: null,
          signedAt: null,
          staffId: req.user?.id ?? null,
        },
        include: {
          contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
          contractVersion: {
            select: {
              id: true,
              version: true,
              body: true,
              bodyHash: true,
              changeNote: true,
              status: true,
            },
          },
        },
      });
    });

    const history = await listMemberContractHistory(memberId, updated.contractId);
    await syncMemberAllowBiometrics(memberId);

    res.json({
      status: 'success',
      message: `電子合約 [${updated.contract.title}] ${serializeSignature(updated).versionLabel || ''} 已改為待重簽（舊簽名已留存稽核）`,
      data: {
        signature: serializeSignature(updated),
        history,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '電子合約重簽準備失敗' });
  }
});

// POST /api/ops/members/:id/contracts/:signId/sign  { signatureData }
router.post('/members/:id/contracts/:signId/sign', async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const signId = parseInt(req.params.signId, 10);
  const signatureData = String(req.body?.signatureData || '').trim();
  const clientMeta = getRequestClientMeta(req);

  if (!Number.isInteger(memberId) || !Number.isInteger(signId)) {
    return res.status(400).json({ status: 'error', message: '無效的參數' });
  }
  if (!signatureData.startsWith('data:image/') || !signatureData.includes('base64,')) {
    return res.status(400).json({
      status: 'error',
      message: '簽名格式無效，請使用簽名板重新簽署',
    });
  }
  if (signatureData.length > 1_500_000) {
    return res.status(400).json({ status: 'error', message: '簽名圖檔過大' });
  }

  try {
    const existing = await prisma.memberContractSignature.findFirst({
      where: { id: signId, memberId },
      include: {
        contract: { select: { id: true, title: true, shortName: true, status: true, versionBase: true } },
        contractVersion: {
          select: {
            id: true,
            version: true,
            body: true,
            bodyHash: true,
            changeNote: true,
            status: true,
          },
        },
      },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到此合約簽署紀錄' });
    }
    if (existing.contract?.status !== 'ACTIVE') {
      return res.status(400).json({ status: 'error', message: '此合約已作廢，無法簽署' });
    }
    if (existing.contractVersion?.status !== 'ACTIVE') {
      return res.status(400).json({
        status: 'error',
        message: '此合約版本已作廢，請開啟目前版本重新簽署',
      });
    }
    if (existing.status === 'SIGNED') {
      return res.status(400).json({
        status: 'error',
        message: '此合約版本已簽署完成，若需再簽請先按「合約重簽」',
      });
    }

    const versionBody = existing.contractVersion?.body || '';
    const bodyHash =
      existing.contractVersion?.bodyHash || hashContractBody(versionBody);

    const updated = await prisma.$transaction(async (tx) => {
      if (!existing.contractVersion?.bodyHash && existing.contractVersionId) {
        await tx.membershipContractVersion.update({
          where: { id: existing.contractVersionId },
          data: { bodyHash },
        });
      }

      const signed = await tx.memberContractSignature.update({
        where: { id: signId },
        data: {
          status: 'SIGNED',
          signatureData,
          bodyHash,
          ipAddress: clientMeta.ipAddress,
          userAgent: clientMeta.userAgent,
          actorType: 'STAFF',
          signedAt: new Date(),
          staffId: req.user?.id ?? null,
        },
        include: {
          contract: {
            select: { id: true, title: true, shortName: true, status: true, versionBase: true },
          },
          contractVersion: {
            select: {
              id: true,
              version: true,
              body: true,
              bodyHash: true,
              changeNote: true,
              status: true,
            },
          },
        },
      });

      await writeContractAudit(tx, {
        contractId: signed.contractId,
        memberId,
        signatureId: signed.id,
        versionId: signed.contractVersionId,
        action: 'SIGN',
        summary: `電子合約已簽署：${signed.contract?.title || signed.contractId}`,
        detail: {
          bodyHash,
          signatureBytes: signatureData.length,
          version: signed.contractVersion?.version ?? null,
        },
        actorStaffId: req.user?.id ?? null,
        actorType: 'STAFF',
        ...clientMeta,
      });

      return signed;
    });

    const history = await listMemberContractHistory(memberId, updated.contractId);
    await syncMemberAllowBiometrics(memberId);

    res.json({
      status: 'success',
      message: `電子合約 [${updated.contract.title}] ${serializeSignature(updated).versionLabel || ''} 已簽署存檔`,
      data: {
        signature: serializeSignature(updated),
        history,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '簽署存檔失敗' });
  }
});

// GET /api/ops/contracts — 啟用中合約清單（指派用）
router.get('/contracts', async (req, res) => {
  try {
    const rows = await prisma.membershipContract.findMany({
      where: { status: 'ACTIVE' },
      include: {
        versions: {
          where: { status: 'ACTIVE' },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
      orderBy: { id: 'desc' },
    });
    res.json({
      status: 'success',
      data: rows.map((c) => {
        const versionBase = c.versionBase || DEFAULT_VERSION_BASE;
        const v = c.versions[0];
        return {
          id: c.id,
          title: c.title,
          shortName: c.shortName || null,
          displayName: c.shortName || c.title,
          versionBase,
          status: c.status,
          currentVersion: v
            ? {
                id: v.id,
                version: v.version,
                versionLabel: buildVersionLabel(versionBase, v.version),
              }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取合約清單失敗' });
  }
});

// ==========================================
// 1. 建立交易訂單 (準備導向統一金流 UPP) — 同樣綁定 promotionId
// 網址：POST /api/ops/orders
// Payload：{ memberId, promotionId }（禁止任意 amount）
// ==========================================
router.post('/orders', async (req, res) => {
  const {
    memberId,
    promotionId,
    cardMode,
    cardInst,
    periodType,
    periodTimes,
    amount,
    itemDesc,
    ...rest
  } = req.body;

  if (amount !== undefined || itemDesc !== undefined || Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message:
        '⛔ 非法參數：線上訂單只允許 memberId、promotionId、cardMode、cardInst、periodType、periodTimes；金額一律由後端查 Promotion 表決定',
    });
  }

  if (memberId === undefined || promotionId === undefined) {
    return res.status(400).json({ status: 'error', message: '參數錯誤：必須提供 memberId 與 promotionId' });
  }

  try {
    const promotion = await prisma.promotion.findUnique({
      where: { id: parseInt(promotionId, 10) },
    });

    if (!promotion) {
      return res.status(400).json({ status: 'error', message: '促銷商品不存在或已下架' });
    }

    assertBranchAccess(req, promotion.branchId);
    assertPromotionSellable(promotion);

    const member = await prisma.member.findUnique({
      where: { id: parseInt(memberId, 10) },
    });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }

    let cardOpts;
    try {
      cardOpts = parseCardPayOptions(
        { cardMode, cardInst, periodType, periodTimes },
        { allowRecurring: Boolean(promotion.enableCardRecurring) },
      );
    } catch (error) {
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    }

    const orderId = resolveTopupOrderId({
      cardMode: cardOpts.cardMode,
      promotion,
    });

    // 建立 PENDING 訂單；錢包加值等 Webhook 確認付款後再做（避免未付款先入帳）
    const newOrder = await prisma.order.create({
      data: {
        id: orderId,
        memberId: member.id,
        amount: promotion.price,
        itemDesc: buildTopupItemDesc(promotion, '線上'),
        payMethod: 'CARD',
        cardAmount: promotion.price,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
        status: 'PENDING',
      },
    });

    const payuniPayload = buildUPPPayload({
      id: newOrder.id,
      amount: newOrder.amount,
      itemDesc: newOrder.itemDesc,
      cardMode: cardOpts.cardMode,
      cardInst: cardOpts.cardInst,
      periodType: cardOpts.periodType,
      periodTimes: cardOpts.periodTimes,
    });

    res.json({
      status: 'success',
      message: '訂單建立成功，準備導向金流',
      data: {
        actionUrl: PAYUNI_UPP_URL,
        payload: payuniPayload,
        orderId: newOrder.id,
        promotionId: promotion.id,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '訂單建立失敗' });
  }
});

// ==========================================
// 2. 【臨櫃身分辨認】手機 / QR / 人臉
// 必須放在 /members/:id 之前，避免被當成 id
// ==========================================

// GET /api/ops/members/lookup?phone=0912345678
router.get('/members/lookup', async (req, res) => {
  try {
    const result = await lookupMemberByPhone(req.query.phone);
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '手機查詢失敗' });
  }
});

// POST /api/ops/members/identify
// Body: { method: "PHONE"|"QR"|"FACE", phone?, qrToken?, faceImage? }
router.post('/members/identify', async (req, res) => {
  try {
    const result = await identifyMember(req.body || {});
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error('臨櫃辨認失敗:', error);
    res.status(500).json({ status: 'error', message: error.message || '臨櫃辨認失敗' });
  }
});

// ==========================================
// 2.1 綁定 Papago 人臉辨識 ID
// 網址：POST /api/ops/members/:id/face
// ==========================================
router.post('/members/:id/face', async (req, res) => {
  const memberId = parseInt(req.params.id);
  const { papagoFaceId, faceImage } = req.body;

  if (!papagoFaceId && !faceImage) {
    return res.status(400).json({ status: "error", message: "必須提供 faceImage (人臉照片) 或 papagoFaceId (手動綁定)" });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: "error", message: "找不到此會員" });
    }

    await assertMemberSignedBiometricsConsent(memberId);
    if (!member.faceEnabled) {
      return res.status(400).json({
        status: 'error',
        message: '請先於會員編輯勾選「啟用人臉辨識」，並完成生物辨識同意書簽署',
      });
    }

    let resolvedFaceId = papagoFaceId;

    // 優先走 Face8 API 註冊 (臨櫃拍攝人臉)
    if (faceImage) {
      const registration = await registerFace({
        imageBase64: faceImage,
        externalId: memberId,
        displayName: member.name,
      });
      resolvedFaceId = registration.faceId;
    }

    const updatedMember = await prisma.member.update({
      where: { id: memberId },
      data: {
        papagoFaceId: resolvedFaceId,
        allowBiometrics: true,
      },
    });

    res.json({
      status: "success",
      message: `會員 [${updatedMember.name}] PAPAGO 人臉綁定成功`,
      data: { faceId: updatedMember.papagoFaceId, allowBiometrics: true }
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    if (error.code === 'P2002') {
      return res.status(400).json({ status: "error", message: "此人臉資料已被其他會員綁定" });
    }
    console.error(error);
    res.status(500).json({ status: "error", message: error.message || "人臉綁定失敗" });
  }
});

// ==========================================
// 3. 查詢會員列表 (櫃檯營運必備)
// 網址：GET /api/ops/members
// ==========================================
router.get('/members', async (req, res) => {
  try {
    const members = await prisma.member.findMany({
      select: {
        id: true, memberNo: true, name: true, phone: true, plan: true, expireDate: true,
        cashWallet: true, bonusWallet: true,
        papagoFaceId: true, isAlert: true, allowBiometrics: true, faceEnabled: true,
        deviceId: true, lineId: true,
        emergencyContact: true, emergencyContactPhone: true,
        branches: {
          include: { branch: { select: { id: true, name: true, code: true } } },
        },
      },
      orderBy: { createdAt: 'desc' }
    });
    const memberIds = members.map((m) => m.id);
    const [{ boardByMember }, bioSignedIds, recentTopupOrders] = await Promise.all([
      buildMembersContractBoard(memberIds),
      getBiometricsSignedMemberIdSet(memberIds),
      prisma.order.findMany({
        where: {
          memberId: { in: memberIds },
          status: 'PAID',
          itemDesc: { contains: '商品#' },
        },
        select: { memberId: true, itemDesc: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const planNameByMember = new Map();
    for (const row of recentTopupOrders) {
      if (planNameByMember.has(row.memberId)) continue;
      const parts = String(row.itemDesc || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const planName = parts.length >= 2 ? parts[1] : null;
      if (planName) planNameByMember.set(row.memberId, planName);
    }
    res.json({
      status: 'success',
      data: members.map((m) => {
        const allowBiometrics = bioSignedIds.has(m.id);
        return {
          ...toCounterMemberView({
            ...m,
            allowBiometrics,
            planName: planNameByMember.get(m.id) || m.plan,
          }),
          papagoFaceId: m.papagoFaceId ? '(已綁定)' : null,
          contracts: boardByMember.get(m.id) || [],
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "讀取會員列表失敗" });
  }
});

export default router;