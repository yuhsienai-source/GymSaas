// routes/ops.js
import express from 'express';
import prisma from '../lib/prisma.js';
import { paymentDebtByMember } from '../lib/paymentDebt.js';
import { verifyStaff, requirePermission, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import {
  assertBranchAccess,
  hasManagerRankOrAbove,
  promotionListWhere,
  isCrossBranchUser,
  staffBranchIds,
  canAccessBranch,
} from '../lib/staffAccess.js';
import { coercePaymentsFromBody, TOPUP_PAY_METHODS } from '../lib/compositePay.js';
import { payWithCashWallet, restoreHeldCashWallet } from '../lib/walletMutation.js';
import {
  assertPromotionSellable,
  promotionSellablePrismaWhere,
  fulfillPromotionPurchase,
  fulfillmentGrantData,
  buildTopupItemDesc,
  isUnlimitedTopupOrder,
  parseTopupQtyFromItemDesc,
  computeTopupAmount,
  isUnlimitedPromotion,
  TOPUP_NO_WALLET_MESSAGE,
  resolvePromotionRecurringAmount,
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
  buildCardCheckoutRequest,
  decryptInfo,
  verifyWebhookHash,
  parseCardPayOptions,
  extractCardTradeMeta,
  isPayuniNotifySuccess,
  resolvePayuniOrderRef,
  resolvePayuniPeriodHash,
  resolveBindCreditHash,
  maybeCancelBindVerifyAuth,
} from '../lib/payuni.js';
import {
  createSubscriptionFromPaidOrder,
  ensureSubscriptionForPaidRecurringOrder,
  processDueSubscriptions,
  cancelCardSubscription,
  pauseCardSubscription,
  resumeCardSubscription,
  applyCardSubscriptionCreditUpdate,
  buildSubscriptionRebindRequest,
  toRebindStatusView,
  REBIND_PENDING_MARKER,
  repairPlaceholderNextChargeAts,
  syncPeriodNextChargeAtsFromPayuni,
} from '../lib/cardSubscription.js';
import {
  settleCancelSubscription,
  settleCancelUnlimitedOrder,
  previewCancelUnlimitedOrder,
  EXPIRE_POLICIES,
  findLatestPaidOrderForSubscription,
  computeMonthlyCardRefundDetail,
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
  lockOpenShiftForSale,
  previousShiftEnd,
} from '../lib/shiftHandover.js';
import { normalizeInvoiceOptions } from '../lib/ezpay.js';
import {
  issueOrderInvoice,
  saveInvoiceRequest,
  listEInvoices,
  retryEInvoice,
  attachInvoiceSummary,
  issuedInvoiceFor,
} from '../lib/einvoice.js';
import { allocateUniqueMemberNo, isValidMemberNo } from '../lib/memberNo.js';
import { registerFace } from '../lib/papago.js';
import {
  identifyMember,
  lookupMemberByPhone,
  normalizePhone,
  toCounterMemberView,
} from '../lib/memberIdentify.js';
import { setMemberBranches, listMemberBranches } from '../lib/memberBranch.js';
import { deviceBindUpdateIfChanged } from '../lib/memberDevice.js';
import { opsResetMemberDevice } from '../lib/deviceReset.js';
import {
  clientIp,
  clientUserAgent,
} from '../lib/memberDeviceAudit.js';
import { normalizeEmail } from '../lib/emailOtp.js';
import { assertRequiredIdNumber } from '../lib/deviceReset.js';
import { posPayReturnRedirect, topupPayReturnRedirect, checkoutPayReturnRedirect, payReturnRedirect } from '../lib/frontendUrl.js';
import { fulfillCardSaleOrder } from '../lib/inventory.js';
import { confirmLinePayPayment, payLinePayPosWithOneTimeKey } from '../lib/linepay.js';
import {
  processCheckOut,
  broadcastCheckOut,
  checkOutSuccessPayload,
} from '../lib/gateCheckout.js';
import { fulfillCheckoutSession, runOpsCheckout } from '../lib/checkout.js';
import {
  fulfillGroupOnlineOrder,
  releaseEnrollmentHold,
  processWaitlist,
} from '../lib/groupClassService.js';
import { confirmYipayCheckout, confirmYipayOrder, confirmYipaySale } from '../lib/yipay.js';
import { reconcileYipayDay } from '../lib/yipayCapture.js';
import { resolveTopupOrderId } from '../lib/orderIds.js';
import { formatGateAccessNo } from '../lib/gateAccessNo.js';
import {
  getIdPhotoMetaForMember,
  normalizeIdPhotoSide,
  redeemLocalIdPhotoAccessToken,
  uploadMemberIdPhoto,
} from '../lib/idPhoto.js';



const router = express.Router();

// ==========================================
// 🚨 【金流 Webhook 中樞】(必須放在 verifyStaff 上方)
// 網址：POST /api/ops/payuni/webhook
// ==========================================

/** 續期收款 Notify 的 MerTradeNo 常非本系統單號：以金額＋近期 PENDING RECURRING 回填 */
async function resolvePendingRecurringOrderRef(tradeData, preferredRef) {
  if (preferredRef && /^(CHK|SAL|CRS|TYK|CRC)/i.test(String(preferredRef))) {
    return preferredRef;
  }
  const amt = Number(
    tradeData?.AuthAmt ?? tradeData?.FAmt ?? tradeData?.TradeAmt ?? NaN,
  );
  if (!Number.isFinite(amt) || amt <= 0) return preferredRef;

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const session = await prisma.checkoutSession.findFirst({
    where: {
      status: 'PENDING',
      cardMode: 'RECURRING',
      createdAt: { gte: since },
      OR: [{ cardAmount: amt }, { amount: amt }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (session) {
    console.warn(
      `[PayUNi] 續期 Notify MerTradeNo=${tradeData?.MerTradeNo} → PENDING CHK ${session.id}（$${amt}）`,
    );
    return session.id;
  }

  const order = await prisma.order.findFirst({
    where: {
      status: 'PENDING',
      cardMode: 'RECURRING',
      createdAt: { gte: since },
      amount: amt,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (order) {
    console.warn(
      `[PayUNi] 續期 Notify MerTradeNo=${tradeData?.MerTradeNo} → PENDING 訂單 ${order.id}（$${amt}）`,
    );
    return order.id;
  }
  return preferredRef;
}

/**
 * 乙禾已 PAID 後的續期「僅約定」Notify：
 * PayUNi 常覆寫 MerTradeNo／ProdDesc，且可能無 CreditHash（僅 PeriodTradeNo）。
 * 以 PeriodAmt＋近期「已入帳、尚未寫入約定」的 CHK／訂單／換卡訂閱對應。
 */
async function resolvePaidRecurringBindRef(tradeData, preferredRef) {
  if (preferredRef && /^(CHK|SAL|CRS|TYK|CRC)/i.test(String(preferredRef))) {
    return preferredRef;
  }
  const hasPeriodSignal =
    Boolean(tradeData?.PeriodTradeNo) ||
    Boolean(tradeData?.CreditHash) ||
    Boolean(tradeData?.CreditToken) ||
    String(tradeData?.ResCode || '') === '00';
  if (!hasPeriodSignal) return preferredRef;

  const periodAmt = Number(tradeData?.PeriodAmt ?? NaN);
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const unboundHash = {
    OR: [{ creditHash: null }, { creditHash: '' }],
  };

  const session = await prisma.checkoutSession.findFirst({
    where: {
      status: 'PAID',
      cardMode: 'RECURRING',
      createdAt: { gte: since },
      AND: [unboundHash],
      ...(Number.isFinite(periodAmt) && periodAmt > 0
        ? { recurringAmount: periodAmt }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (session) {
    console.warn(
      `[PayUNi] 續期約定 Notify MerTradeNo=${tradeData?.MerTradeNo} → PAID CHK ${session.id}` +
        (Number.isFinite(periodAmt) ? `（PeriodAmt=$${periodAmt}）` : ''),
    );
    return session.id;
  }

  const order = await prisma.order.findFirst({
    where: {
      status: 'PAID',
      cardMode: 'RECURRING',
      createdAt: { gte: since },
      AND: [unboundHash],
      ...(Number.isFinite(periodAmt) && periodAmt > 0
        ? { OR: [{ recurringAmount: periodAmt }, { amount: periodAmt }] }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (order) {
    const ref = order.checkoutSessionId || order.id;
    console.warn(
      `[PayUNi] 續期約定 Notify MerTradeNo=${tradeData?.MerTradeNo} → PAID 訂單 ${order.id} → ${ref}`,
    );
    return ref;
  }

  const sub = await prisma.cardSubscription.findFirst({
    where: {
      lastError: REBIND_PENDING_MARKER,
      updatedAt: { gte: since },
      ...(Number.isFinite(periodAmt) && periodAmt > 0 ? { amount: periodAmt } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (sub) {
    console.warn(
      `[PayUNi] 續期約定 Notify MerTradeNo=${tradeData?.MerTradeNo} → 換卡訂閱 ${sub.id}`,
    );
    return sub.id;
  }

  return preferredRef;
}

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
    
    // UPP：Status+TradeStatus；續期收款：常無 TradeStatus，改看 ResCode／AuthAmt
    if (!isPayuniNotifySuccess(tradeData)) {
      console.warn(
        `[PayUNi] Notify 未視為成功入帳 Status=${tradeData.Status} TradeStatus=${tradeData.TradeStatus} ResCode=${tradeData.ResCode}`,
      );
      return res.status(200).send('OK');
    }

    let orderId = resolvePayuniOrderRef(tradeData);
    orderId = await resolvePendingRecurringOrderRef(tradeData, orderId);
    orderId = await resolvePaidRecurringBindRef(tradeData, orderId);

    if (!orderId) {
      console.error('[PayUNi] Notify 成功但無法解析本系統單號', {
        MerTradeNo: tradeData.MerTradeNo,
        ProdDesc: tradeData.ProdDesc,
        PeriodTradeNo: tradeData.PeriodTradeNo,
        PeriodAmt: tradeData.PeriodAmt,
      });
      return res.status(200).send('OK');
    }

    // 3.0 訂閱換卡／補綁：ProdDesc／MerTradeNo 指向 CardSubscription（CRS…）
    {
      const subHit = await prisma.cardSubscription.findUnique({
        where: { id: String(orderId) },
      });
      if (subHit) {
        const cardMeta = extractCardTradeMeta(tradeData);
        try {
          const updated = await applyCardSubscriptionCreditUpdate(subHit.id, {
            creditHash: resolveBindCreditHash(cardMeta, tradeData),
            periodTradeNo: cardMeta.periodTradeNo || tradeData.PeriodTradeNo,
          });
          if (updated) {
            console.log(`✅ 訂閱 ${subHit.id} 換卡／補綁 Notify 已回寫約定（CreditHash／PeriodTradeNo）`);
          } else {
            console.warn(
              `[PayUNi] 訂閱 ${subHit.id} Notify 成功但無 CreditHash／PeriodTradeNo 可寫`,
            );
          }
        } catch (rebindErr) {
          console.error(`❌ 訂閱 ${subHit.id} 換卡回寫失敗:`, rebindErr.message);
        }
        try {
          await maybeCancelBindVerifyAuth(tradeData);
        } catch (voidErr) {
          console.error(`[PayUNi] 訂閱 ${subHit.id} 驗卡取消授權例外:`, voidErr.message);
        }
        return res.status(200).send('OK');
      }
    }

    // 3a. 合併結帳（CHK…）
      if (String(orderId || '').startsWith('CHK')) {
        const cardMeta = extractCardTradeMeta(tradeData);
        try {
          const fulfilled = await fulfillCheckoutSession(
            orderId,
            tradeData.TradeNo || tradeData.PeriodTradeNo,
            cardMeta,
          );
          if (fulfilled) {
            console.log(`✅ 合併結帳 ${orderId} 刷卡入帳成功`);
          }
        } catch (chkErr) {
          console.error(
            `❌ 合併結帳 ${orderId} 入帳／開票失敗（已沖回業務單據；刷卡款請人工退）：`,
            chkErr.message,
          );
        }
        try {
          await maybeCancelBindVerifyAuth(tradeData);
        } catch (voidErr) {
          console.error(`[PayUNi] CHK ${orderId} 驗卡取消授權例外:`, voidErr.message);
        }
        return res.status(200).send('OK');
      }

      // 3b. POS 銷貨（SAL…）
      if (String(orderId || '').startsWith('SAL')) {
        const cardMeta = extractCardTradeMeta(tradeData);
        try {
          const fulfilled = await fulfillCardSaleOrder(orderId, tradeData.TradeNo, null, cardMeta);
          if (fulfilled) {
            console.log(`✅ 銷貨 ${orderId} 刷卡入帳＋扣庫成功`);
          }
        } catch (salErr) {
          console.error(
            `❌ 銷貨 ${orderId} 入帳／開票失敗（已沖回；刷卡款請人工退）：`,
            salErr.message,
          );
        }
        return res.status(200).send('OK');
      }

      // 3b-2. 團課報名（GRP…）：報名生效＋開票，禁止入帳錢包
      if (String(orderId || '').startsWith('GRP')) {
        try {
          const r = await fulfillGroupOnlineOrder(orderId, tradeData.TradeNo || null);
          if (r?.activated) console.log(`✅ 團課訂單 ${orderId} 刷卡入帳，報名 #${r.enrollmentId} 生效`);
        } catch (grpErr) {
          console.error(`❌ 團課訂單 ${orderId} 入帳失敗（刷卡款請人工核對）：`, grpErr.message);
        }
        return res.status(200).send('OK');
      }

      // 3c. 儲值／購案 Order（CRS／TYK…）
      const order = await prisma.order.findUnique({ 
        where: { id: orderId },
        include: { member: true },
      });

      // 合併結帳子單：一律走 CHK fulfill（避免 Order 已 PAID、Session 仍 PENDING、訂閱未建）
      if (order?.checkoutSessionId && String(order.checkoutSessionId).startsWith('CHK')) {
        const cardMeta = extractCardTradeMeta(tradeData);
        try {
          const fulfilled = await fulfillCheckoutSession(
            order.checkoutSessionId,
            tradeData.TradeNo || tradeData.PeriodTradeNo,
            cardMeta,
          );
          if (fulfilled) {
            console.log(
              `✅ 合併結帳 ${order.checkoutSessionId}（經訂單 ${orderId}）刷卡入帳成功`,
            );
          }
        } catch (chkErr) {
          console.error(
            `❌ 合併結帳 ${order.checkoutSessionId} 入帳失敗：`,
            chkErr.message,
          );
        }
        try {
          await maybeCancelBindVerifyAuth(tradeData);
        } catch (voidErr) {
          console.error(
            `[PayUNi] CHK ${order.checkoutSessionId} 驗卡取消授權例外:`,
            voidErr.message,
          );
        }
        return res.status(200).send('OK');
      }

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
              merchantNo: tradeData.TradeNo || tradeData.PeriodTradeNo || order.merchantNo,
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
                orderId: order.id,
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
              periodTradeNo: cardMeta.periodTradeNo || tradeData.PeriodTradeNo,
              dateList: cardMeta.dateList || tradeData.DateList || null,
            });
          } catch (subErr) {
            console.error(`❌ 訂單 ${orderId} 建立定期定額訂閱失敗:`, subErr.message);
          }
        }

        // 開立電子發票；失敗入佇列補開（禁止沖回已收款）
        await tryIssueOrderInvoice(order, order.member.name);
      } else if (
        order &&
        order.status === 'PAID' &&
        String(order.cardMode || '').toUpperCase() === 'RECURRING'
      ) {
        // 舊 Notify／無 CreditHash 時可能已入帳卻未建訂閱 → 補建
        const cardMeta = extractCardTradeMeta(tradeData);
        try {
          const sub = await ensureSubscriptionForPaidRecurringOrder(order, {
            creditHash: cardMeta.creditHash || order.creditHash,
            periodTradeNo: cardMeta.periodTradeNo || tradeData.PeriodTradeNo,
            dateList: cardMeta.dateList || tradeData.DateList || null,
          });
          if (sub) {
            console.log(`🔁 訂單 ${orderId} 已補建／確認定期定額訂閱 ${sub.id}`);
          }
        } catch (subErr) {
          console.error(`❌ 訂單 ${orderId} 補建定期定額失敗:`, subErr.message);
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
// 網址：POST|GET /api/ops/payuni/return
// 金流以瀏覽器打回 → 回 HTML 自動跳轉獨立前端（比純 303 更穩）
// 注意：入帳靠 NotifyURL（webhook）；ReturnURL 只負責把人帶回系統頁
// ==========================================
function extractMerTradeNoFromPayuniReturn(body = {}, query = {}) {
  const encryptInfo = body.EncryptInfo || query.EncryptInfo;
  const hashInfo = body.HashInfo || query.HashInfo;
  if (!encryptInfo) {
    return {
      merTradeNo: null,
      status: body.Status || query.Status || null,
      note: 'no_encrypt',
    };
  }

  let tradeData;
  let note = 'ok';
  try {
    const hashOk = Boolean(hashInfo) && verifyWebhookHash(encryptInfo, hashInfo);
    tradeData = decryptInfo(encryptInfo);
    if (!hashOk) note = hashInfo ? 'hash_mismatch' : 'no_hash';
  } catch (err) {
    return {
      merTradeNo: null,
      status: body.Status || query.Status || null,
      note: `decrypt_fail:${err.message || 'error'}`,
    };
  }

  const merTradeNo = String(
    tradeData.MerTradeNo ||
      tradeData.merTradeNo ||
      tradeData.MerchantTradeNo ||
      tradeData.MerOrderNo ||
      '',
  ).trim();

  return {
    merTradeNo: merTradeNo || null,
    status: tradeData.Status || body.Status || query.Status || null,
    note,
  };
}

function sendPayuniBrowserBounce(res, targetUrl) {
  res.redirect(302, targetUrl);
}

function handlePayuniBrowserReturn(req, res) {
  try {
    const body = req.body || {};
    const query = req.query || {};
    const parsed = extractMerTradeNoFromPayuniReturn(body, query);
    const merTradeNo = parsed.merTradeNo || '';

    let saleId;
    let orderId;
    let checkoutId;
    if (merTradeNo.startsWith('CHK')) checkoutId = merTradeNo;
    else if (merTradeNo.startsWith('SAL')) saleId = merTradeNo;
    else if (merTradeNo.startsWith('TYK') || merTradeNo.startsWith('CRS')) orderId = merTradeNo;
    else if (merTradeNo.startsWith('GRP')) {
      return sendPayuniBrowserBounce(res, payReturnRedirect({ orderId: merTradeNo, kind: 'group' }));
    }

    console.log(
      '🪃 PayUNi ReturnURL → 前端',
      checkoutId || saleId || orderId || '(無單號)',
      `method=${req.method}`,
      `status=${parsed.status || '-'}`,
      `note=${parsed.note}`,
      `keys=${Object.keys(body).join(',') || Object.keys(query).join(',') || '-'}`,
    );

    let target;
    if (checkoutId) target = checkoutPayReturnRedirect({ checkoutId });
    else if (saleId) target = posPayReturnRedirect({ saleId });
    else if (orderId) target = topupPayReturnRedirect({ orderId });
    else target = posPayReturnRedirect({});

    return sendPayuniBrowserBounce(res, target);
  } catch (error) {
    console.error('PayUNi return 導向失敗:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || '無法導向前端付款結果頁',
    });
  }
}

router.post('/payuni/return', handlePayuniBrowserReturn);
router.get('/payuni/return', handlePayuniBrowserReturn);

// ==========================================
// LinePay Confirm／Cancel（公開；須在 verifyStaff 之前）
// ConfirmURL 帶 transactionId + orderId（= MerTradeNo / CHK…）
// ==========================================
async function handleLinePayConfirm(req, res) {
  try {
    const q = { ...(req.query || {}), ...(req.body || {}) };
    const transactionId = String(q.transactionId || '').trim();
    const orderId = String(q.orderId || '').trim();
    if (!transactionId || !orderId) {
      return res.status(400).json({ status: 'error', message: '缺少 transactionId 或 orderId' });
    }

    let redirectTarget = checkoutPayReturnRedirect({ checkoutId: orderId });

    if (orderId.startsWith('CHK')) {
      const session = await prisma.checkoutSession.findUnique({ where: { id: orderId } });
      if (!session) {
        return res.status(404).json({ status: 'error', message: '找不到結帳單' });
      }
      const bd =
        session.payBreakdown && typeof session.payBreakdown === 'object'
          ? session.payBreakdown
          : {};
      const amount = Math.round(Number(bd.LINEPAY || session.amount));
      await confirmLinePayPayment({ transactionId, amount });
      await fulfillCheckoutSession(orderId, `LP:${transactionId}`, null);
      redirectTarget = checkoutPayReturnRedirect({ checkoutId: orderId });
    } else if (orderId.startsWith('SAL')) {
      const sale = await prisma.saleOrder.findUnique({ where: { id: orderId } });
      if (!sale) {
        return res.status(404).json({ status: 'error', message: '找不到銷貨單' });
      }
      const bd =
        sale.payBreakdown && typeof sale.payBreakdown === 'object' ? sale.payBreakdown : {};
      const amount = Math.round(Number(bd.LINEPAY || sale.amount));
      await confirmLinePayPayment({ transactionId, amount });
      await fulfillCardSaleOrder(orderId, `LP:${transactionId}`, null, null);
      redirectTarget = posPayReturnRedirect({ saleId: orderId });
    } else if (orderId.startsWith('GRP')) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        return res.status(404).json({ status: 'error', message: '找不到訂單' });
      }
      if (order.status !== 'PAID') {
        await confirmLinePayPayment({ transactionId, amount: Math.round(Number(order.amount)) });
        await fulfillGroupOnlineOrder(orderId, `LP:${transactionId}`);
      }
      redirectTarget = payReturnRedirect({ orderId, kind: 'group' });
    } else {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        return res.status(404).json({ status: 'error', message: '找不到訂單' });
      }
      const bd =
        order.payBreakdown && typeof order.payBreakdown === 'object' ? order.payBreakdown : {};
      const amount = Math.round(Number(bd.LINEPAY || order.amount));
      await confirmLinePayPayment({ transactionId, amount });
      if (order.status === 'PENDING') {
        const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
        const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
        await prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: orderId },
            data: { status: 'PAID', merchantNo: `LP:${transactionId}` },
          });
          if (promotionId) {
            const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
            if (promotion) {
              const qty = parseTopupQtyFromItemDesc(order.itemDesc);
              await fulfillPromotionPurchase(tx, order.memberId, promotion, { qty, orderId: order.id });
            }
          }
        });
        const paid = await prisma.order.findUnique({ where: { id: orderId } });
        const member = paid
          ? await prisma.member.findUnique({ where: { id: paid.memberId } })
          : null;
        if (paid && member) {
          await tryIssueOrderInvoice(paid, member.name);
        }
      }
      const client = String(q.client || '').toLowerCase();
      redirectTarget =
        client === 'member'
          ? payReturnRedirect({ orderId })
          : topupPayReturnRedirect({ orderId });
    }

    return res.redirect(302, redirectTarget);
  } catch (error) {
    console.error('[LinePay] confirm 失敗:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || 'LinePay 確認失敗',
    });
  }
}

async function handleLinePayCancel(req, res) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  const orderId = String(q.orderId || '').trim();
  const client = String(q.client || '').toLowerCase();
  try {
    let target;
    if (orderId.startsWith('GRP')) {
      const enrollment = await prisma.groupEnrollment.findUnique({ where: { orderId } });
      if (enrollment?.status === 'PENDING') {
        await prisma.$transaction((tx) => releaseEnrollmentHold(tx, enrollment.id, 'CANCELLED'));
        processWaitlist(enrollment.seriesId).catch(() => {});
      }
      target = payReturnRedirect({ orderId, kind: 'group' });
    } else if (client === 'member') {
      target = payReturnRedirect(orderId ? { orderId } : {});
    } else if (orderId.startsWith('CHK')) {
      target = checkoutPayReturnRedirect({ checkoutId: orderId });
    } else if (orderId.startsWith('SAL')) {
      target = posPayReturnRedirect({ saleId: orderId });
    } else if (orderId) {
      target = topupPayReturnRedirect({ orderId });
    } else {
      target = checkoutPayReturnRedirect({});
    }
    const u = new URL(target);
    u.searchParams.set('pay', 'cancelled');
    return res.redirect(302, u.toString());
  } catch (error) {
    console.error('[LinePay] cancel 導向失敗:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

router.get('/linepay/confirm', handleLinePayConfirm);
router.post('/linepay/confirm', handleLinePayConfirm);
router.get('/linepay/cancel', handleLinePayCancel);
router.post('/linepay/cancel', handleLinePayCancel);

/**
 * 短效證件調閱兌換（無 Staff JWT；token 即憑證）
 * GET /api/ops/id-photo-access/:token
 */
router.get('/id-photo-access/:token', async (req, res) => {
  try {
    const file = await redeemLocalIdPhotoAccessToken(req.params.token, req);
    res.setHeader('Content-Type', file.contentType || 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(file.buf);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.code,
        message: error.message,
      });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '調閱失敗' });
  }
});

// 所有 ops.js 內的路由，強制通過員工海關驗證
// 訂閱／請假限 DUTY 以上；其餘限櫃檯模組（退費／取消／折讓單在 routes/opsTransactions.js）
router.use(verifyStaff);
router.use((req, res, next) => {
  const isTxPath =
    req.path.startsWith('/card-subscriptions') ||
    req.path.startsWith('/member-leaves');
  if (isTxPath) {
    return requireDutyOrAbove(req, res, next);
  }
  return requirePermission('ops')(req, res, next);
});

/** 單據發票摘要（invoiceNumber／invoiceStatus／invoices），來源 EInvoice */
async function invoiceFieldsOf(refId, opts = {}) {
  const { invoiceNumber, invoiceStatus, invoices } = await attachInvoiceSummary({ id: refId }, opts);
  return { invoiceNumber, invoiceStatus, invoices };
}

/** 已收款訂單開票；失敗入佇列（不沖回已收款），回傳發票號或 null */
async function tryIssueOrderInvoice(order, buyerName) {
  let itemName = null;
  if (String(order.cardMode || '').toUpperCase() === 'RECURRING') {
    const promoMatch = String(order.itemDesc || '').match(/\| ([^|]+) \| UNLIMITED/);
    const promoName =
      promoMatch?.[1]?.trim() ||
      String(order.itemDesc || '')
        .split('|')[1]
        ?.trim() ||
      '月卡';
    itemName = buildRecurringInvoiceItemDesc(promoName, { periodIndex: 1 });
  }
  const inv = await issueOrderInvoice(order.id, { buyerName, itemName });
  return inv.invoiceNumber || null;
}

// ==========================================
// 信用卡定期定額訂閱管理
// ==========================================

/** 非跨店員工綁會員分店：僅保留自身範圍（本店＋隸屬分店），全不符則退回本店 */
function scopeMemberBranchIds(req, requested) {
  const scope = staffBranchIds(req.user);
  const kept = requested.filter((id) => scope.includes(id));
  return kept.length > 0 ? kept : [req.user.branchId];
}

function assertSubscriptionBranchAccess(req, sub) {
  const branchId = sub?.promotion?.branchId ?? sub?.coursePlan?.branchId ?? null;
  if (branchId == null) {
    if (isCrossBranchUser(req.user)) return;
    const err = new Error('⛔ 訂閱缺少分店綁定，請洽管理員');
    err.statusCode = 403;
    throw err;
  }
  assertBranchAccess(req, branchId);
}

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

    // 4) 訂單存在但無訂閱列
    const order = await prisma.order.findUnique({
      where: { id: raw },
      select: {
        id: true,
        cardMode: true,
        itemDesc: true,
        status: true,
        memberId: true,
        amount: true,
        payMethod: true,
        creditHash: true,
        recurringAmount: true,
        recurringAmountFinal: true,
        periodType: true,
        periodTimes: true,
        cardAmount: true,
        merchantNo: true,
      },
    });
    if (order) {
      const isRecurring = String(order.cardMode || '').toUpperCase() === 'RECURRING';
      if (isUnlimitedTopupOrder(order.itemDesc)) {
        // 定期定額已付款但缺 CreditHash 時，補建訂閱列（供取消／請假）；失敗則改走訂單效期結算
        if (isRecurring && order.status === 'PAID') {
          try {
            const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
            const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
            const promotion = promotionId
              ? await prisma.promotion.findUnique({ where: { id: promotionId } })
              : null;
            if (promotion) {
              const created = await createSubscriptionFromPaidOrder(order, {
                promotion,
                creditHash: order.creditHash,
              });
              if (created) {
                const full = await prisma.cardSubscription.findUnique({
                  where: { id: created.id },
                  ...withInclude,
                });
                if (full) return { sub: full, message: null };
              }
            }
          } catch (backfillErr) {
            console.warn(
              `[取消訂閱] 訂單 ${order.id} 補建訂閱失敗，改走效期結算:`,
              backfillErr.message,
            );
          }
        }
        return { sub: null, unlimitedOrder: order, message: null };
      }
      return {
        sub: null,
        unlimitedOrder: null,
        message: isRecurring
          ? '此定期定額訂單尚未建立訂閱（可能刷卡未完成），且非無限月卡，無法取消訂閱'
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

/** 臨櫃篩選：優先會員編號 memberNo（6 碼），否則相容內部 memberId */
async function resolveOpsMemberIdParam({ memberNo, memberId } = {}) {
  const no = String(memberNo || '').trim().toUpperCase();
  if (no) {
    if (!isValidMemberNo(no)) {
      const err = new Error('會員編號格式無效（須為 6 碼大寫英數）');
      err.statusCode = 400;
      throw err;
    }
    const m = await prisma.member.findUnique({
      where: { memberNo: no },
      select: { id: true },
    });
    if (!m) {
      const err = new Error('找不到該會員編號');
      err.statusCode = 404;
      throw err;
    }
    return m.id;
  }
  if (memberId !== undefined && memberId !== null && memberId !== '') {
    const id = Number(memberId);
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error('memberId 無效');
      err.statusCode = 400;
      throw err;
    }
    return id;
  }
  return undefined;
}

router.get('/card-subscriptions', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const where = {};
    const memberId = await resolveOpsMemberIdParam({
      memberNo: req.query.memberNo,
      memberId: req.query.memberId,
    });
    if (memberId != null) where.memberId = memberId;
    if (status) where.status = status;

    // 補建：已付款定期定額缺訂閱列（舊版無 CreditHash 略過）
    const orphanWhere = {
      status: 'PAID',
      cardMode: 'RECURRING',
      ...(where.memberId ? { memberId: where.memberId } : {}),
    };
    const orphanOrders = await prisma.order.findMany({
      where: orphanWhere,
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        status: true,
        cardMode: true,
        creditHash: true,
        itemDesc: true,
        memberId: true,
        recurringAmount: true,
        recurringAmountFinal: true,
        periodType: true,
        periodTimes: true,
        cardAmount: true,
        amount: true,
        merchantNo: true,
        checkoutSessionId: true,
      },
    });
    for (const orphan of orphanOrders) {
      try {
        const created = await ensureSubscriptionForPaidRecurringOrder(orphan);
        // 子單已入帳但 CHK 仍 PENDING → 對齊狀態，避免櫃檯輪詢卡住
        if (created && orphan.checkoutSessionId?.startsWith('CHK')) {
          await prisma.checkoutSession.updateMany({
            where: { id: orphan.checkoutSessionId, status: 'PENDING' },
            data: {
              status: 'PAID',
              merchantNo: orphan.merchantNo || undefined,
            },
          });
        }
      } catch (backfillErr) {
        console.warn(`[訂閱一覽] 訂單 ${orphan.id} 補建失敗:`, backfillErr.message);
      }
    }

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
        coursePlan: {
          select: {
            id: true,
            name: true,
            price: true,
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
      const branchId = r.promotion?.branchId ?? r.coursePlan?.branchId ?? null;
      if (branchId == null) {
        // 無分店綁定：跨店職位可見；一般員工略過（避免誤放行）
        return isCrossBranchUser(req.user);
      }
      try {
        assertBranchAccess(req, branchId);
        return true;
      } catch {
        return false;
      }
    });

    const repaired = await repairPlaceholderNextChargeAts(filtered);
    const synced = await syncPeriodNextChargeAtsFromPayuni(repaired);
    res.json({ status: 'success', data: synced });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
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
      include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
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
        staffId: req.user?.id ?? null,
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
      return res.json({
        status: 'success',
        message: `月卡購案已取消；${exp}${inv}`,
        data: { ...result, orderId: unlimitedOrder.id, allowanceSlip: result.invoice?.slip || null },
      });
    }

    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);

    // 新結算流程：效期政策 + 可選折讓；舊呼叫（無參數）仍只停續扣
    const forceLocalOnly = Boolean(req.body?.forceLocalOnly);
    if (hasSettleFields || expirePolicy !== 'KEEP') {
      const result = await settleCancelSubscription(sub.id, {
        reason: req.body?.reason,
        expirePolicy,
        doAllowance: req.body?.doAllowance,
        forceLocalOnly,
        staffId: req.user?.id ?? null,
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
      const allowanceSlip = result.invoice?.slip || null;
      return res.json({
        status: 'success',
        message: `訂閱已取消；${exp}${inv}${
          result.payuniStop && !result.payuniStop.skipped
            ? result.payuniStop.ok
              ? '；PayUNi 續期已終止'
              : `；⚠ PayUNi 續期可能未停（${result.payuniStop.message || '請至統一金流後台手動終止'}）`
            : ''
        }`,
        data: { ...result, subscriptionId: sub.id, allowanceSlip },
      });
    }

    const updated = await cancelCardSubscription(sub.id, {
      reason: req.body?.reason,
      forceLocalOnly,
    });
    const payuniStop = updated?.payuniStop;
    const payuniMsg =
      payuniStop && !payuniStop.skipped
        ? payuniStop.ok
          ? '；PayUNi 續期已終止'
          : `；⚠ PayUNi 續期可能未停（${payuniStop.message || '請至統一金流後台手動終止'}）`
        : '';
    res.json({
      status: 'success',
      message: `訂閱已取消（效期未變更）${payuniMsg}`,
      data: updated,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        data: error.payuniStop ? { payuniStop: error.payuniStop } : undefined,
      });
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
        coursePlan: true,
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
    assertSubscriptionBranchAccess(req, sub);

    const now = new Date();
    const unusedDays = remainingExpireDays(sub.member?.expireDate, now);
    const periodDays =
      resolveRecurringPeriodDays(sub.promotion) ||
      sub.promotion?.unitDays ||
      sub.promotion?.durationDays ||
      30;
    const latest = await findLatestPaidOrderForSubscription(sub);
    const refundDetail = latest.order
      ? computeMonthlyCardRefundDetail({
          orderAmount: latest.order.amount,
          unusedDays,
          periodDays,
        })
      : null;

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
        promotion: sub.promotion
          ? {
              id: sub.promotion.id,
              name: sub.promotion.name,
              usageType: sub.promotion.usageType,
              unitDays: sub.promotion.unitDays,
              durationDays: sub.promotion.durationDays,
            }
          : null,
        coursePlan: sub.coursePlan
          ? {
              id: sub.coursePlan.id,
              name: sub.coursePlan.name,
            }
          : null,
        expirePolicies: EXPIRE_POLICIES,
        unusedDays,
        periodDays,
        usedDays: refundDetail?.usedDays ?? null,
        refundDetail,
        latestOrder: latest.order
          ? {
              id: latest.order.id,
              amount: latest.order.amount,
              invoiceNumber: (await issuedInvoiceFor(latest.order.id))?.invoiceNumber || null,
              status: latest.order.status,
              periodIndex: latest.periodIndex,
            }
          : null,
        estimatedAllowance: refundDetail?.amount ?? 0,
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
      include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    const updated = await pauseCardSubscription(sub.id, {
      forceLocalOnly: Boolean(req.body?.forceLocalOnly),
    });
    const payuniStop = updated?.payuniStop;
    const payuniMsg =
      payuniStop && !payuniStop.skipped
        ? payuniStop.ok
          ? '；PayUNi 續期已暫停'
          : `；⚠ PayUNi 續期可能未停（${payuniStop.message || '請至統一金流後台手動暫停'}）`
        : '';
    res.json({
      status: 'success',
      message: `訂閱已暫停續扣（效期仍持續計算；請假請改用請假 API）${payuniMsg}`,
      data: updated,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        data: error.payuniStop ? { payuniStop: error.payuniStop } : undefined,
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '暫停訂閱失敗' });
  }
});

/**
 * 查詢訂閱對應的 PayUNi 續期排程（period/query）
 * GET /api/ops/card-subscriptions/:id/payuni-period
 */
router.get('/card-subscriptions/:id/payuni-period', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    const {
      extractPeriodTradeNo,
      queryPayuniPeriod,
      summarizePayuniPeriodSchedule,
    } = await import('../lib/payuni.js');
    const periodTradeNo = extractPeriodTradeNo(sub);
    if (!periodTradeNo) {
      return res.json({
        status: 'success',
        message: '此訂閱非 PayUNi 續期頁（無 PeriodTradeNo）',
        data: { subscriptionId: sub.id, periodTradeNo: null, creditHash: sub.creditHash },
      });
    }
    const query = await queryPayuniPeriod({ periodTradeNo });
    const schedule = query.ok ? summarizePayuniPeriodSchedule(query.data) : null;
    res.json({
      status: query.ok ? 'success' : 'error',
      message: query.message || (query.ok ? '查詢成功' : '查詢失敗'),
      data: {
        subscriptionId: sub.id,
        subscriptionStatus: sub.status,
        periodTradeNo,
        schedule,
        raw: query.data || null,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '查詢 PayUNi 續期失敗' });
  }
});

/**
 * 僅重試停 PayUNi 續期／約定（本機訂閱狀態不變更）
 * POST /api/ops/card-subscriptions/:id/stop-payuni
 * body: { mode?: 'terminate'|'suspend' }
 */
router.post('/card-subscriptions/:id/stop-payuni', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    const modeRaw = String(req.body?.mode || 'terminate').toLowerCase();
    const mode =
      modeRaw === 'suspend' || modeRaw === 'pause'
        ? 'suspend'
        : modeRaw === 'restart' || modeRaw === 'resume'
          ? 'restart'
          : 'terminate';
    const {
      stopPayuniRecurringForSubscription,
      resumePayuniRecurringForSubscription,
    } = await import('../lib/payuni.js');
    const payuniStop =
      mode === 'restart'
        ? await resumePayuniRecurringForSubscription(sub)
        : await stopPayuniRecurringForSubscription(sub, { mode });
    if (payuniStop?.ok) {
      await prisma.cardSubscription.update({
        where: { id: sub.id },
        data: {
          lastError:
            mode === 'suspend'
              ? 'PayUNi 續期已暫停（手動同步）'
              : mode === 'restart'
                ? 'PayUNi 續期已啟用（手動同步）'
                : 'PayUNi 續期已終止（手動同步）',
        },
      });
    }
    res.status(payuniStop?.ok ? 200 : 409).json({
      status: payuniStop?.ok ? 'success' : 'error',
      message: payuniStop?.ok
        ? mode === 'suspend'
          ? 'PayUNi 續期已暫停'
          : mode === 'restart'
            ? 'PayUNi 續期已啟用'
            : 'PayUNi 續期已終止'
        : payuniStop?.message || '同步 PayUNi 續期失敗',
      data: { subscriptionId: sub.id, payuniStop },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '停 PayUNi 續期失敗' });
  }
});

router.post('/card-subscriptions/:id/resume', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    await settleExpiredLeave(sub.memberId);
    const current = await prisma.cardSubscription.findUnique({ where: { id: sub.id } });
    if (!current) return res.status(404).json({ status: 'error', message: '找不到訂閱' });
    if (current.status === 'ACTIVE') {
      return res.json({
        status: 'success',
        message: '訂閱已是啟用狀態（請假到期已自動恢復）',
        data: current,
      });
    }
    const updated = await resumeCardSubscription(current.id, {
      forceLocalOnly: Boolean(req.body?.forceLocalOnly),
    });
    const payuniResume = updated?.payuniResume;
    const payuniMsg =
      payuniResume && !payuniResume.skipped
        ? payuniResume.ok
          ? '；PayUNi 續期已啟用'
          : `；⚠ PayUNi 續期可能未啟用（${payuniResume.message || '請至統一金流後台手動啟用'}）`
        : '';
    res.json({
      status: 'success',
      message: `訂閱已恢復${payuniMsg}`,
      data: updated,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        data: error.payuniResume ? { payuniResume: error.payuniResume } : undefined,
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '恢復訂閱失敗' });
  }
});

/**
 * 臨櫃換卡：開 PayUNi 續期頁（$1 驗證授權後取消）；Notify 回寫 CreditHash
 * POST /api/ops/card-subscriptions/:id/rebind
 */
router.post('/card-subscriptions/:id/rebind', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: {
        promotion: { select: { branchId: true } },
        coursePlan: { select: { branchId: true } },
      },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    const bind = await buildSubscriptionRebindRequest(sub.id, { channel: 'counter' });
    res.json({
      status: 'success',
      message: bind.messageHint || '請完成 PayUNi 換卡約定',
      data: bind,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '開換卡頁失敗' });
  }
});

/**
 * 換卡輪詢（不回傳原始 CreditHash）
 * GET /api/ops/card-subscriptions/:id/rebind-status
 */
router.get('/card-subscriptions/:id/rebind-status', async (req, res) => {
  try {
    const { sub, message } = await resolveSubscriptionByRef(req.params.id, {
      include: {
        promotion: { select: { branchId: true } },
        coursePlan: { select: { branchId: true } },
      },
    });
    if (!sub) return res.status(404).json({ status: 'error', message: message || '找不到訂閱' });
    assertSubscriptionBranchAccess(req, sub);
    const fresh = await prisma.cardSubscription.findUnique({ where: { id: sub.id } });
    res.json({
      status: 'success',
      data: toRebindStatusView(fresh),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取換卡狀態失敗' });
  }
});

// ==========================================
// 無限使用請假
// ==========================================
router.get('/member-leaves', async (req, res) => {
  try {
    const memberId = await resolveOpsMemberIdParam({
      memberNo: req.query.memberNo,
      memberId: req.query.memberId,
    });
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = await listMemberLeaves({ memberId, status });
    // 分店過濾：有訂閱則看方案分店；無則放行 ADMIN，DUTY 需 memberId
    const filtered = [];
    for (const row of rows) {
      if (row.subscriptionId) {
        const sub = await prisma.cardSubscription.findUnique({
          where: { id: row.subscriptionId },
          include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
        });
        try {
          if (sub) assertSubscriptionBranchAccess(req, sub);
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
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取請假失敗' });
  }
});

router.post('/member-leaves', async (req, res) => {
  try {
    const memberId = await resolveOpsMemberIdParam({
      memberNo: req.body?.memberNo,
      memberId: req.body?.memberId,
    });
    if (memberId == null) {
      return res.status(400).json({ status: 'error', message: '請提供會員編號' });
    }
    const subId = req.body?.subscriptionId ? String(req.body.subscriptionId).trim() : undefined;
    if (subId) {
      const sub = await prisma.cardSubscription.findUnique({
        where: { id: subId },
        include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
      });
      if (!sub) return res.status(404).json({ status: 'error', message: '找不到訂閱' });
      assertSubscriptionBranchAccess(req, sub);
    }

    const result = await startMemberLeave({
      memberId,
      days: req.body?.days,
      reason: req.body?.reason,
      staffId: req.user?.id ?? null,
      subscriptionId: subId,
      forceLocalOnly: Boolean(req.body?.forceLocalOnly),
    });
    const payuniMsg =
      result.payuniStop && !result.payuniStop.skipped
        ? result.payuniStop.ok
          ? '；PayUNi 續期已暫停'
          : `；⚠ PayUNi 續期可能未停（${result.payuniStop.message || '請至統一金流後台手動暫停'}）`
        : '';
    res.json({
      status: 'success',
      message: `已請假 ${result.leave.days} 天（至 ${new Date(result.leave.endAt).toLocaleDateString('zh-TW')}）；效期已順延，定期定額已暫停${payuniMsg}`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        data: error.payuniStop ? { payuniStop: error.payuniStop } : undefined,
      });
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
        include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
      });
      if (sub) assertSubscriptionBranchAccess(req, sub);
    }

    const result = await endMemberLeaveEarly({
      memberId: leave.memberId,
      leaveId: leave.id,
      reason: req.body?.reason,
      resumeSubscription: req.body?.resumeSubscription !== false,
      forceLocalOnly: Boolean(req.body?.forceLocalOnly),
    });
    res.json({
      status: 'success',
      message: `已提早銷假，收回未休 ${result.unusedLeaveDays} 天效期順延`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
        data: error.payuniResume ? { payuniResume: error.payuniResume } : undefined,
      });
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
        include: { promotion: { select: { branchId: true } }, coursePlan: { select: { branchId: true } } },
      });
      if (sub) assertSubscriptionBranchAccess(req, sub);
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
        carryFrom: await previousShiftEnd(open),
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
          ? Math.round(
              ((open.openingFloat || 0) + (liveSummary?.cashIn || 0) - (liveSummary?.cashRefund || 0)) * 100,
            ) / 100
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

// ——— 乙禾日結／發票佇列（一般櫃檯即可；DUTY+ 延伸路由亦有同路徑）———
router.get('/yipay/reconcile', async (req, res) => {
  try {
    const branchId =
      req.query.branchId != null && req.query.branchId !== ''
        ? Number(req.query.branchId)
        : req.user?.branchId;
    if (branchId != null && Number.isFinite(branchId)) {
      assertBranchAccess(req, branchId);
    }
    const data = await reconcileYipayDay(req.query.day || req.query.date, {
      branchId: Number.isFinite(branchId) ? branchId : null,
      edcCount: req.query.edcCount,
      edcAmount: req.query.edcAmount,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '乙禾日結對帳失敗' });
  }
});

router.get('/invoice-jobs', async (req, res) => {
  try {
    const items = await listEInvoices({
      status: req.query.status,
      take: req.query.take,
      checkoutId: req.query.checkoutId,
      branchIds: isCrossBranchUser(req.user) ? null : staffBranchIds(req.user),
    });
    return res.json({ status: 'success', data: { items } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '查詢開票任務失敗' });
  }
});

router.post('/invoice-jobs/:id/retry', async (req, res) => {
  try {
    const row = await prisma.eInvoice.findUnique({ where: { id: String(req.params.id) }, select: { branchId: true } });
    if (row?.branchId && !canAccessBranch(req.user, row.branchId)) {
      return res.status(403).json({ status: 'error', message: '⛔ 無權補開其他分店發票' });
    }
    const job = await retryEInvoice(req.params.id, { staffId: req.user?.id ?? null });
    return res.json({ status: 'success', message: '已重新排隊開票', data: job });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '重試開票失敗' });
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
      code: result.code || undefined,
      message: result.message,
      data: result.data,
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
    return res.status(500).json({ status: 'error', message: error.message || '合併結帳失敗' });
  }
});

/**
 * 乙禾／凱基固定式刷卡機：端末成功後櫃檯確認入帳＋ezPay
 * POST /api/ops/confirm-yipay  { checkoutId? | orderId? | saleId?, terminalRef? }
 */
router.post('/confirm-yipay', async (req, res) => {
  const { checkoutId, orderId, saleId, terminalRef, ...illegal } = req.body || {};
  if (Object.keys(illegal).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：只允許 checkoutId、orderId、saleId、terminalRef，已拒絕 [${Object.keys(illegal).join(', ')}]`,
    });
  }
  try {
    if (checkoutId) {
      const data = await confirmYipayCheckout(String(checkoutId).trim(), {
        terminalRef,
        staffId: req.user?.id,
      });
      return res.json({
        status: 'success',
        message: data.needsPeriodBind
          ? data.messageHint ||
            '乙禾首期已入帳；請完成 PayUNi 續期頁約定'
          : data.alreadyPaid
            ? '此結帳單已入帳'
            : '乙禾刷卡已確認入帳',
        data,
      });
    }
    if (saleId) {
      const data = await confirmYipaySale(String(saleId).trim(), {
        terminalRef,
        staffId: req.user?.id,
      });
      return res.json({
        status: 'success',
        message: data.alreadyPaid ? '此銷貨單已入帳' : '乙禾刷卡已確認入帳',
        data,
      });
    }
    if (orderId) {
      const data = await confirmYipayOrder(String(orderId).trim(), { terminalRef });
      return res.json({
        status: 'success',
        message: data.alreadyPaid ? '此訂單已入帳' : '乙禾刷卡已確認入帳',
        data,
      });
    }
    return res.status(400).json({
      status: 'error',
      message: '請提供 checkoutId（CHK…）、saleId（SAL…）或 orderId',
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: error.message || '乙禾確認入帳失敗' });
  }
});

/** GET /api/ops/checkout/:id — 輪詢刷卡／續期收款入帳狀態（Notify 為準） */
router.get('/checkout/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ status: 'error', message: '缺少 checkoutId' });
    }

    if (id.startsWith('CHK')) {
      const session = await prisma.checkoutSession.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          amount: true,
          cardAmount: true,
          cardMode: true,
          merchantNo: true,
          orderId: true,
          saleOrderId: true,
          ptFulfilled: true,
          creditHash: true,
          updatedAt: true,
        },
      });
      if (!session) {
        return res.status(404).json({ status: 'error', message: '找不到結帳單' });
      }
      return res.json({
        status: 'success',
        data: {
          kind: 'checkout',
          checkoutId: session.id,
          orderId: session.orderId,
          saleId: session.saleOrderId,
          payStatus: session.status,
          amount: session.amount,
          cardAmount: session.cardAmount,
          cardMode: session.cardMode,
          merchantNo: session.merchantNo,
          ...(await invoiceFieldsOf(session.id, { bySession: true })),
          ptFulfilled: session.ptFulfilled,
          hasCreditHash: Boolean(session.creditHash),
          updatedAt: session.updatedAt,
        },
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        amount: true,
        cardAmount: true,
        cardMode: true,
        merchantNo: true,
        checkoutSessionId: true,
        creditHash: true,
        updatedAt: true,
      },
    });
    if (!order) {
      return res.status(404).json({ status: 'error', message: '找不到訂單' });
    }
    return res.json({
      status: 'success',
      data: {
        kind: 'order',
        checkoutId: order.checkoutSessionId,
        orderId: order.id,
        saleId: null,
        payStatus: order.status,
        amount: order.amount,
        cardAmount: order.cardAmount,
        cardMode: order.cardMode,
        merchantNo: order.merchantNo,
        ...(await invoiceFieldsOf(order.id)),
        ptFulfilled: null,
        hasCreditHash: Boolean(order.creditHash),
        updatedAt: order.updatedAt,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '查詢結帳狀態失敗' });
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
    linePayOneTimeKey,
    ...illegalFields
  } = req.body;

  const forbiddenKeys = Object.keys(illegalFields);
  if (forbiddenKeys.length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：儲值 API 只允許 memberId、promotionId、qty、payments、payMethod、voucherCode、carrierNum、buyerUbn、loveCode、cardMode、cardInst、periodType、periodTimes、recurringAmount、linePayOneTimeKey，已拒絕 [${forbiddenKeys.join(', ')}]`,
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
    // 開票營業人＝方案所屬分店；全店通用方案歸櫃檯所在分店
    const topupBranchId = promotion.branchId ?? req.user?.branchId ?? null;
    const saveTopupInvoiceRequest = (tx, orderId) =>
      saveInvoiceRequest(tx, { refType: 'ORDER', refId: orderId, buyerName: member.name, ...invoiceOpts });

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
    if (pay.walletAmount > 0 && !isUnlimitedPromotion(promotion)) {
      return res.status(400).json({ status: 'error', code: 'TOPUP_NO_WALLET', message: TOPUP_NO_WALLET_MESSAGE });
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
      // 臨櫃一次／分期請走乙禾；PayUNi CARD 僅定期定額
      if (cardOpts.cardMode !== 'RECURRING') {
        return res.status(400).json({
          status: 'error',
          message: '臨櫃一次付清／分期請使用「乙禾現場刷卡」（YIPAY）；PayUNi（CARD）僅用於定期定額',
        });
      }
      if (cardOpts.cardMode === 'RECURRING') {
        const periodCount = parseInt(promotion.periodCount, 10);
        if (!Number.isInteger(periodCount) || periodCount <= 0) {
          return res.status(400).json({
            status: 'error',
            message: '此儲值方案未設定有效期期數，無法使用定期定額',
          });
        }
        cardOpts.periodTimes = periodCount;
        recurringAmount = resolvePromotionRecurringAmount(promotion);
        if (!recurringAmount) {
          return res.status(400).json({
            status: 'error',
            message: '此儲值方案未設定定期定額扣款金額',
          });
        }
      }
    }

    // 乙禾現場刷卡：PENDING，端末成功後 POST /ops/confirm-yipay
    if (pay.needsYipay) {
      const order = await prisma.$transaction(async (tx) => {
        await lockOpenShiftForSale(tx, topupBranchId);
        const orderId = resolveTopupOrderId({ promotion });
        if (pay.walletAmount > 0) {
          await payWithCashWallet(tx, {
            memberId: parsedMemberId,
            amount: pay.walletAmount,
            refType: 'ORDER',
            refId: orderId,
            staffId: req.user?.id,
            branchId: topupBranchId,
          });
        }

        const created = await tx.order.create({
          data: {
            id: orderId,
            memberId: parsedMemberId,
            amount,
            itemDesc,
            payMethod: pay.payMethodLabel,
            payBreakdown: pay.breakdown,
            voucherCode: pay.voucherCode,
            cardAmount: pay.yipayAmount,
            branchId: topupBranchId,
            status: 'PENDING',
          },
        });
        await saveTopupInvoiceRequest(tx, created.id);
        return created;
      });

      return res.json({
        status: 'success',
        message: `請於乙禾／凱基固定式刷卡機完成收款 $${pay.yipayAmount}，完成後按「確認刷卡成功」`,
        data: {
          orderId: order.id,
          amount: order.amount,
          yipayAmount: pay.yipayAmount,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          channel: 'YIPAY',
          terminalHint: '乙禾凱基固定式刷卡機',
        },
      });
    }

    // 含刷卡：PENDING，刷卡成功後再入帳（避免未付完先配發）
    if (pay.needsCard) {
      const order = await prisma.$transaction(async (tx) => {
        await lockOpenShiftForSale(tx, topupBranchId);
        const orderId = resolveTopupOrderId({ cardMode: cardOpts.cardMode, promotion });
        if (pay.walletAmount > 0) {
          await payWithCashWallet(tx, {
            memberId: parsedMemberId,
            amount: pay.walletAmount,
            refType: 'ORDER',
            refId: orderId,
            staffId: req.user?.id,
            branchId: topupBranchId,
          });
        }

        const created = await tx.order.create({
          data: {
            id: orderId,
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
            branchId: topupBranchId,
            status: 'PENDING',
          },
        });
        await saveTopupInvoiceRequest(tx, created.id);
        return created;
      });

      const { actionUrl, payload: payuniPayload } = buildCardCheckoutRequest({
        id: order.id,
        amount: pay.cardAmount,
        itemDesc: order.itemDesc,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
        periodAmt: recurringAmount,
        recurringAmount,
        payuniPeriodHash: resolvePayuniPeriodHash({ channel: 'counter', promotion }),
        channel: 'counter',
        promotion,
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
          actionUrl,
          payload: payuniPayload,
        },
      });
    }

    // 臨櫃 LinePay：POS 掃付款碼（oneTimeKey），扣款成功後入帳
    if (pay.needsLinePay) {
      if (cardOpts.cardMode === 'RECURRING') {
        return res.status(400).json({
          status: 'error',
          message: '定期定額請使用刷卡（PayUNi），LinePay 僅支援一次付清',
        });
      }
      const oneTimeKey = String(linePayOneTimeKey || '').trim();
      if (!oneTimeKey) {
        return res.status(400).json({
          status: 'error',
          message: '臨櫃 LinePay 為 POS 掃碼模式：請掃描會員 LinePay 付款碼（My Code）後再結帳',
        });
      }

      const pendingOrder = await prisma.$transaction(async (tx) => {
        await lockOpenShiftForSale(tx, topupBranchId);
        const orderId = resolveTopupOrderId({ promotion });
        if (pay.walletAmount > 0) {
          await payWithCashWallet(tx, {
            memberId: parsedMemberId,
            amount: pay.walletAmount,
            refType: 'ORDER',
            refId: orderId,
            staffId: req.user?.id,
            branchId: topupBranchId,
          });
        }

        const created = await tx.order.create({
          data: {
            id: orderId,
            memberId: parsedMemberId,
            amount,
            itemDesc,
            payMethod: pay.payMethodLabel,
            payBreakdown: pay.breakdown,
            voucherCode: pay.voucherCode,
            cardAmount: 0,
            branchId: topupBranchId,
            status: 'PENDING',
          },
        });
        await saveTopupInvoiceRequest(tx, created.id);
        return created;
      });

      let branchName = null;
      if (promotion.branchId) {
        const br = await prisma.branch.findUnique({
          where: { id: promotion.branchId },
          select: { name: true, code: true },
        });
        branchName = br?.name || br?.code || null;
      }

      let lp;
      try {
        lp = await payLinePayPosWithOneTimeKey({
          orderId: pendingOrder.id,
          amount: pay.linePayAmount,
          productName: itemDesc,
          oneTimeKey,
          branchId: promotion.branchId,
          branchName,
        });
      } catch (lpErr) {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.order.updateMany({
            where: { id: pendingOrder.id, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
          if (claimed.count && pay.walletAmount > 0) {
            await restoreHeldCashWallet(tx, {
              memberId: parsedMemberId,
              refType: 'ORDER',
              refId: pendingOrder.id,
              staffId: req.user?.id,
              branchId: topupBranchId,
              reason: `臨櫃 LINE Pay 扣款失敗，退回零錢包 ${pendingOrder.id}`,
            });
          }
        });
        throw lpErr;
      }

      const result = await prisma.$transaction(async (tx) => {
        const { updatedMember, fulfillment } = await fulfillPromotionPurchase(
          tx,
          parsedMemberId,
          promotion,
          { qty: parsedQty, orderId: pendingOrder.id },
        );
        const order = await tx.order.update({
          where: { id: pendingOrder.id },
        data: {
            status: 'PAID',
            merchantNo: `LP:${lp.transactionId}`,
            amount: fulfillment.amount,
            itemDesc: buildTopupItemDesc(promotion, '臨櫃', fulfillment.qty),
          },
        });
        return { updatedMember, order, promotion, fulfillment };
      });

      // 已收款：開票失敗只入佇列補開，不沖回
      const invoiceNumber = await tryIssueOrderInvoice(result.order, result.updatedMember.name);
      const successMessage =
        result.fulfillment.type === 'UNLIMITED'
          ? `【體育客】會員 [${result.updatedMember.name}] 購案成功：${result.promotion.name}（效期至 ${new Date(result.fulfillment.expireDate).toLocaleDateString('zh-TW')}）`
          : `【體育客】會員 [${result.updatedMember.name}] 儲值成功：${result.promotion.name} ×${result.fulfillment.qty}`;

      return res.json({
        status: 'success',
        message: successMessage,
        data: {
          orderId: result.order.id,
          amount: result.order.amount,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          linePayAmount: pay.linePayAmount,
          linePayMode: 'POS',
          transactionId: lp.transactionId,
          voucherCode: pay.voucherCode,
          invoiceNumber,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          promotion: {
            id: result.promotion.id,
            name: result.promotion.name,
            usageType: result.promotion.usageType,
          },
        },
      });
    }

    // 無刷卡／無 LinePay：當場入帳 + 開發票（可含零錢包折抵）
    const result = await prisma.$transaction(async (tx) => {
      await lockOpenShiftForSale(tx, topupBranchId);
      const orderId = resolveTopupOrderId({ promotion });
      if (pay.walletAmount > 0) {
        await payWithCashWallet(tx, {
          memberId: parsedMemberId,
          amount: pay.walletAmount,
          refType: 'ORDER',
          refId: orderId,
          staffId: req.user?.id,
          branchId: topupBranchId,
        });
      }

      const { updatedMember, fulfillment } = await fulfillPromotionPurchase(
        tx,
        parsedMemberId,
        promotion,
        { qty: parsedQty, ledgerRefId: orderId, staffId: req.user?.id, branchId: topupBranchId },
      );

      const order = await tx.order.create({
        data: {
          id: orderId,
          memberId: parsedMemberId,
          amount: fulfillment.amount,
          itemDesc: buildTopupItemDesc(promotion, '臨櫃', fulfillment.qty),
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: 0,
          branchId: topupBranchId,
          status: 'PAID',
          ...fulfillmentGrantData(fulfillment),
        },
      });
      await saveTopupInvoiceRequest(tx, order.id);

      return { updatedMember, order, promotion, fulfillment };
    });

    // 已收款：開票失敗只入佇列補開，不沖回
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
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      });
    }
    console.error('儲值失敗:', error);
    res.status(500).json({ status: 'error', message: '儲值失敗' });
  }
});

// ==========================================
// 0.02 【臨櫃開卡】綁電話＋綁定分店
// POST /api/ops/members
// Body: { name, phone, idNumber, branchIds?: number[], faceEnabled?: boolean, email?: string }
// 方案／效期禁止前端指定：未購方案一律分鐘計費、無效期
// faceEnabled=true 時建立後需簽署生物辨識同意書（allowBiometrics 仍由簽署同步）
// phone、idNumber 必填；外國客 idNumber 可填居留證或護照
// ==========================================
router.post('/members', async (req, res) => {
  const {
    name,
    phone,
    allowBiometrics,
    plan,
    expireDate,
    branchIds,
    faceEnabled,
    email,
    idNumber,
    ...rest
  } = req.body || {};

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
      message: `⛔ 非法參數：開卡只允許 name、phone、branchIds、faceEnabled、email、idNumber，已拒絕 [${Object.keys(rest).join(', ')}]`,
    });
  }

  if (!name || !phone || !String(idNumber || '').trim()) {
    return res.status(400).json({
      status: 'error',
      message: '開卡失敗：姓名、手機號碼與證件號為必填',
    });
  }

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone.length < 8) {
    return res.status(400).json({ status: 'error', message: '手機號碼格式無效' });
  }

  let normalizedId;
  try {
    normalizedId = assertRequiredIdNumber(idNumber);
  } catch (e) {
    return res.status(400).json({
      status: 'error',
      message: e.message || '證件號格式無效（身分證／居留證／護照）',
    });
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
  if (!isCrossBranchUser(req.user) && req.user?.branchId) {
    resolvedBranchIds = scopeMemberBranchIds(req, resolvedBranchIds);
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

  let normalizedEmail = null;
  if (email !== undefined && email !== null && String(email).trim()) {
    try {
      normalizedEmail = normalizeEmail(email);
    } catch (e) {
      return res.status(400).json({ status: 'error', message: e.message || 'Email 格式無效' });
    }
  }

  try {
    const idTaken = await prisma.member.findUnique({ where: { idNumber: normalizedId } });
    if (idTaken) {
      return res.status(409).json({ status: 'error', message: '此證件號已註冊' });
    }

    const memberNo = await allocateUniqueMemberNo();
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
      data: {
          memberNo,
        name: String(name).trim(),
        phone: normalizedPhone,
          email: normalizedEmail,
          idNumber: normalizedId,
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

  // 解除警示僅限總部合規 API（須寫入 reason 日誌）
  // 注意：body 帶 isAlert:false 且會員「目前為警示」才拒絕；已是未警示則略過該欄（相容誤傳）
  const clearAlertAttempt =
    req.body?.isAlert === false || req.body?.isAlert === 'false' || req.body?.isAlert === 0;
  if (clearAlertAttempt) {
    const current = await prisma.member.findUnique({
      where: { id: memberId },
      select: { isAlert: true },
    });
    if (current?.isAlert) {
      return res.status(400).json({
        status: 'error',
        message: '⛔ 解除警示請改走總部合規補償 API：POST /api/hq/members/:id/clear-alert（須填 reason）',
      });
    }
    delete req.body.isAlert;
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
    'email',
    'idNumber',
    'emergencyContact',
    'emergencyContactPhone',
  ];
  const data = {};
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;

    if (key === 'phone') {
      const phone = normalizePhone(req.body.phone);
      if (phone.length < 8) {
        return res.status(400).json({ status: 'error', message: '手機號碼為必填且格式須有效' });
      }
      data.phone = phone;
      continue;
    }

    if (key === 'email') {
      const raw = String(req.body.email || '').trim();
      if (!raw) {
        data.email = null;
        continue;
      }
      try {
        data.email = normalizeEmail(raw);
      } catch (e) {
        return res.status(400).json({ status: 'error', message: e.message || 'Email 格式無效' });
      }
      continue;
    }

    if (key === 'idNumber') {
      try {
        data.idNumber = assertRequiredIdNumber(req.body.idNumber);
      } catch (e) {
    return res.status(400).json({
      status: 'error',
          message: e.message || '證件號為必填（身分證／居留證／護照）',
        });
      }
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
    if (!isCrossBranchUser(req.user) && req.user?.branchId) {
      resolvedBranchIds = scopeMemberBranchIds(req, resolvedBranchIds);
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

    const bindPatch = deviceBindUpdateIfChanged(existing.deviceId, deviceId, memberId);
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
    const result = await opsResetMemberDevice({
      memberId,
      operatorId: req.user?.id ?? null,
      reason: '櫃檯解除裝置綁定',
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
      action: 'OPS_UNBIND',
    });
    res.json({
      status: 'success',
      message: result.message,
      data: toCounterMemberView(result.member),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此會員' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '解除裝置綁定失敗' });
  }
});

/**
 * 臨櫃核身重置裝置（方案 A 備援；DUTY+）
 * POST /api/ops/members/:id/reset-device
 * Body 可選：{ reason }
 */
router.post('/members/:id/reset-device', requireDutyOrAbove, async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID' });
  }

  try {
    const result = await opsResetMemberDevice({
      memberId,
      operatorId: req.user?.id ?? null,
      reason: req.body?.reason
        ? String(req.body.reason).slice(0, 200)
        : '臨櫃核身重置裝置（Email 收不到／輸入錯誤）',
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
      action: 'OPS_UNBIND',
    });
    res.json({
      status: 'success',
      message: result.message,
      data: toCounterMemberView(result.member),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '重置裝置失敗' });
  }
});

/** GET /api/ops/members/:id/id-photos — 狀態標記（無影像；櫃檯 ops 可查） */
router.get('/members/:id/id-photos', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (!Number.isFinite(memberId)) {
      return res.status(400).json({ status: 'error', message: '無效的會員 id' });
    }
    const meta = await getIdPhotoMetaForMember(memberId);
    return res.json({
      status: 'success',
      data: {
        ...meta,
        policy: {
          retentionYears: 3,
          versionYears: 1,
          staffAccess: 'status_only',
          originalRequiresDuty: true,
          deleteRequiresApproval: true,
          presignTtlSecHint: '180-300',
        },
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '讀取證件狀態失敗' });
  }
});

/** POST /api/ops/members/:id/id-photo — 臨櫃代辦上傳（須 consentSignatureId） */
router.post('/members/:id/id-photo', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (!Number.isFinite(memberId)) {
      return res.status(400).json({ status: 'error', message: '無效會員 id' });
    }
    const consentSignatureId = String(req.body?.consentSignatureId || '').trim();
    if (!consentSignatureId) {
      return res.status(403).json({
        status: 'error',
        code: 'CONSENT_REQUIRED',
        message: '臨櫃代辦上傳證件須先取得客顯授權簽章（consentSignatureId）',
      });
    }
    const side = normalizeIdPhotoSide(req.body?.side || 'front');
    const staffId = req.user?.staffId ?? req.user?.id ?? null;
    const branchId = req.user?.branchId != null ? Number(req.user.branchId) : null;
    const branchCode = req.body?.branchCode || req.user?.branchCode || branchId || '—';
    const today = new Date().toISOString().slice(0, 10);
    const watermarkText = [
      '僅供體育客會籍查驗｜他用無效',
      `分店代碼：${branchCode}`,
      `經辦人員：${staffId}`,
      `日期：${today}`,
    ].join('｜');

    const saved = await uploadMemberIdPhoto(
      memberId,
      req.body?.image || req.body?.dataUrl,
      side,
      req,
      {
        watermarkText,
        uploadedByStaffId: staffId,
        uploadBranchId: branchId,
        uploadSource: 'STAFF_USB_SCANNER',
        consentSignatureId,
      },
    );
    return res.json({
      status: 'success',
      message: '臨櫃證件已上傳',
      data: saved,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.code,
        message: error.message,
      });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '臨櫃證件上傳失敗' });
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
    } else if (!isCrossBranchUser(req.user)) {
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

// POST /api/ops/contracts/:id/refund — 消保法 7 日無條件解約
router.post('/contracts/:id/refund', async (req, res) => {
  const signId = parseInt(req.params.id, 10);
  if (!signId) return res.status(400).json({ status: 'error', message: '無效參數' });
  
  try {
    // 檢查合約是否存在
    const signature = await prisma.memberContractSignature.findUnique({
      where: { id: signId }
    });
    if (!signature) {
      return res.status(404).json({ status: 'error', message: '找不到合約' });
    }

    // 檢查是否簽約 7 日內
    const signedAt = signature.signedAt || signature.createdAt;
    const daysSince = (new Date() - new Date(signedAt)) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      return res.status(400).json({ status: 'error', message: '超過 7 日，不適用無條件解約' });
    }

    // 檢查是否已使用服務 (有無進場紀錄)
    const checkins = await prisma.checkInLog.count({
      where: { 
        memberId: signature.memberId, 
        checkInAt: { gte: signedAt }
      }
    });
    if (checkins > 0) {
      return res.status(400).json({ status: 'error', message: '已使用服務（有進場紀錄），無法無條件解約' });
    }

    // 將合約狀態標記為作廢
    await prisma.memberContractSignature.update({
      where: { id: signId },
      data: { status: 'VOIDED' }
    });

    return res.json({
      status: 'success',
      message: '符合 7 日無條件解約，100% 全額無息退還',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: '解約退費處理失敗' });
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

    let recurringAmount = null;
    if (cardOpts.cardMode === 'RECURRING') {
      const periodCount = parseInt(promotion.periodCount, 10);
      if (!Number.isInteger(periodCount) || periodCount <= 0) {
        return res.status(400).json({
          status: 'error',
          message: '此儲值方案未設定有效期期數，無法使用定期定額',
        });
      }
      cardOpts.periodTimes = periodCount;
      recurringAmount = resolvePromotionRecurringAmount(promotion);
      if (!recurringAmount) {
        return res.status(400).json({
          status: 'error',
          message: '此儲值方案未設定定期定額扣款金額',
        });
      }
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
        branchId: promotion.branchId ?? null,
        cardAmount: promotion.price,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
        recurringAmount,
        status: 'PENDING',
      },
    });

    const { actionUrl, payload: payuniPayload } = buildCardCheckoutRequest({
      id: newOrder.id,
      amount: newOrder.amount,
      itemDesc: newOrder.itemDesc,
      cardMode: cardOpts.cardMode,
      cardInst: cardOpts.cardInst,
      periodType: cardOpts.periodType,
      periodTimes: cardOpts.periodTimes,
      periodAmt: recurringAmount ?? newOrder.amount,
      recurringAmount: recurringAmount ?? newOrder.amount,
      payuniPeriodHash: resolvePayuniPeriodHash({ channel: 'online', promotion }),
      channel: 'online',
      promotion,
    });

    res.json({
      status: 'success',
      message: '訂單建立成功，準備導向金流',
      data: {
        actionUrl,
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
// 網址：GET /api/ops/members?q=&take=&skip=&id=&lite=
// ==========================================
router.get('/members', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const lite = req.query.lite === '1' || req.query.lite === 'true';
    const takeRaw = Number(req.query.take);
    const skipRaw = Number(req.query.skip);
    const take = Math.min(100, Math.max(1, Number.isFinite(takeRaw) && takeRaw > 0 ? Math.floor(takeRaw) : 50));
    const skip = Math.max(0, Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0);
    const idRaw = req.query.id != null && req.query.id !== '' ? Number(req.query.id) : null;
    const byId = Number.isInteger(idRaw) && idRaw > 0 ? idRaw : null;

    const where = {};
    if (byId) {
      where.id = byId;
    } else if (q) {
      const or = [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { memberNo: { contains: q, mode: 'insensitive' } },
        { lineId: { contains: q, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(q)) {
        or.push({ id: Number(q) });
      }
      where.OR = or;
    }

    const pageSkip = byId ? 0 : skip;
    const [total, members] = await Promise.all([
      prisma.member.count({ where }),
      prisma.member.findMany({
        where,
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
        orderBy: { createdAt: 'desc' },
        take,
        skip: pageSkip,
      }),
    ]);

    const memberIds = members.map((m) => m.id);
    const debtByMember = await paymentDebtByMember(prisma, memberIds);
    let boardByMember = new Map();
    let planNameByMember = new Map();
    /** @type {Set<number>} */
    let bioSignedIds = new Set();

    if (lite) {
      // Cmd+K：略過合約板與購案方案名掃描；allowBiometrics 用 DB 欄位
      bioSignedIds = new Set(members.filter((m) => m.allowBiometrics).map((m) => m.id));
    } else if (memberIds.length > 0) {
      const [{ boardByMember: board }, bioIds, recentTopupOrders] = await Promise.all([
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
      boardByMember = board;
      bioSignedIds = bioIds;
      for (const row of recentTopupOrders) {
        if (planNameByMember.has(row.memberId)) continue;
        const parts = String(row.itemDesc || '')
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
        const planName = parts.length >= 2 ? parts[1] : null;
        if (planName) planNameByMember.set(row.memberId, planName);
      }
    }

    res.json({
      status: 'success',
      data: {
        items: members.map((m) => {
          const allowBiometrics = bioSignedIds.has(m.id);
          const view = {
            ...toCounterMemberView({
              ...m,
              allowBiometrics,
              planName: planNameByMember.get(m.id) || m.plan,
            }),
        papagoFaceId: m.papagoFaceId ? '(已綁定)' : null,
            paymentDebt: debtByMember.get(m.id) || null,
          };
          if (!lite) {
            view.contracts = boardByMember.get(m.id) || [];
          }
          return view;
        }),
        total,
        take,
        skip: pageSkip,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "讀取會員列表失敗" });
  }
});

export default router;