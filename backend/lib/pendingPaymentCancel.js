// lib/pendingPaymentCancel.js — 作廢待付款（乙禾／PayUNi 未完成）之臨櫃單，回補預扣零錢包
import prisma from './prisma.js';
import { assertBranchAccess } from './staffAccess.js';
import { restoreHeldCashWallet } from './walletMutation.js';
import { cancelUnissuedInvoices } from './einvoice.js';
import { releaseHoldsForCheckout, processWaitlist } from './groupClassService.js';
import { clientIp } from './memberDeviceAudit.js';

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const KINDS = {
  CHECKOUT: { table: 'CheckoutSession', model: 'checkoutSession', ledgerRef: 'CHECKOUT', captureType: 'CHECKOUT' },
  SALE: { table: 'SaleOrder', model: 'saleOrder', ledgerRef: 'SALE', captureType: 'SALE' },
  ORDER: { table: 'Order', model: 'order', ledgerRef: 'ORDER', captureType: 'ORDER' },
};

function kindOf(id) {
  if (id.startsWith('CHK')) return 'CHECKOUT';
  if (id.startsWith('SAL')) return 'SALE';
  return 'ORDER';
}

export async function cancelPendingPayment(req, rawId, body = {}) {
  const id = String(rawId || '').trim().toUpperCase();
  if (!id) throw httpError(400, 'ID_REQUIRED', '缺少單號');
  if (id.startsWith('GRP')) {
    throw httpError(409, 'USE_GROUP_HOLD', '團課報名待付款由系統逾時釋出，不可於此作廢');
  }
  const reason = String(body.reason ?? '').trim().slice(0, 200);
  if (reason.length < 2) throw httpError(400, 'REASON_REQUIRED', '請填寫作廢原因（至少 2 字）');
  if (body.checked !== true) {
    throw httpError(409, 'PAYMENT_CHECK_REQUIRED', '請先確認乙禾端末／金流後台未成功扣款，再勾選後作廢');
  }

  const kind = kindOf(id);
  const spec = KINDS[kind];
  const user = req.user;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT id FROM "${spec.table}" WHERE id = $1 FOR UPDATE`, id);
    const row = await tx[spec.model].findUnique({ where: { id } });
    if (!row) throw httpError(404, 'NOT_FOUND', `找不到單號 ${id}`);
    if (row.status !== 'PENDING') {
      const hint = row.status === 'PAID' ? '已入帳，請改用退費' : `目前狀態 ${row.status}`;
      throw httpError(409, 'NOT_PENDING', `單號 ${id} 非待付款（${hint}）`);
    }
    if (kind !== 'CHECKOUT' && row.checkoutSessionId) {
      throw httpError(409, 'USE_CHECKOUT_CANCEL', `此單屬合併結帳 ${row.checkoutSessionId}，請以結帳單號作廢`);
    }
    if (row.branchId) assertBranchAccess(req, row.branchId);

    const targetIds = [id];
    if (kind === 'CHECKOUT') {
      if (row.saleOrderId) targetIds.push(row.saleOrderId);
      if (row.orderId) targetIds.push(row.orderId);
    }

    const capture = await tx.yipayTerminalCapture.findFirst({
      where: { targetId: { in: targetIds }, status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
      select: { id: true, status: true },
    });
    if (capture) {
      throw httpError(
        409,
        'YIPAY_CAPTURED',
        `端末已有刷卡紀錄（${capture.id}），請按「確認刷卡成功」入帳，或先將刷卡紀錄標記孤兒後再作廢`,
      );
    }

    const claimed = await tx[spec.model].updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (!claimed.count) throw httpError(409, 'NOT_PENDING', `單號 ${id} 狀態已變更，請重新整理`);

    let releasedSeries = [];
    if (kind === 'CHECKOUT') {
      if (row.saleOrderId) {
        await tx.saleOrder.updateMany({ where: { id: row.saleOrderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      }
      if (row.orderId) {
        await tx.order.updateMany({ where: { id: row.orderId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      }
      releasedSeries = (await releaseHoldsForCheckout(tx, id, 'CANCELLED')) || [];
    }

    for (const refId of targetIds) {
      await cancelUnissuedInvoices(refId, `待付款作廢：${reason}`, tx);
    }

    const fallbackAmount = round2(row.payBreakdown?.WALLET_CASH);
    if (fallbackAmount > 0 && !row.memberId) {
      throw httpError(409, 'MEMBER_REQUIRED', `單號 ${id} 有零錢包預扣但無會員，無法退回`);
    }
    const { restored: held, after: walletAfter } = await restoreHeldCashWallet(tx, {
      memberId: row.memberId,
      refType: spec.ledgerRef,
      refId: id,
      fallbackAmount,
      staffId: user?.id ?? null,
      branchId: row.branchId ?? null,
      reason: `待付款作廢退回零錢包 ${id}：${reason}`,
    });

    await tx.transactionAuditLog.create({
      data: {
        action: 'PENDING_PAYMENT_CANCEL',
        refType: kind,
        refId: id,
        staffId: user?.id ?? null,
        staffRole: user?.role ?? null,
        branchId: row.branchId ?? null,
        reason,
        before: { status: 'PENDING', amount: row.amount, payBreakdown: row.payBreakdown ?? null },
        after: { status: 'CANCELLED', childIds: targetIds.slice(1), walletRestored: held > 0 ? held : 0 },
        clientIp: clientIp(req),
      },
    });

    return {
      id,
      kind,
      walletRestored: held > 0 ? held : 0,
      memberWallet: walletAfter ? { cashWallet: walletAfter.cash, bonusWallet: walletAfter.bonus } : null,
      releasedSeries,
    };
  });

  for (const seriesId of result.releasedSeries) {
    processWaitlist(seriesId).catch((e) => console.error('[pendingCancel] waitlist', seriesId, e.message));
  }
  const { releasedSeries: _omit, ...data } = result;
  return data;
}
