import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_FEE_CAP,
  assertTopupVoidable,
  canAbortRefund,
  computePtRefund,
  computeSaleReturnLines,
  computeTimedTopupRefund,
  contractFee,
  normalizeBreakdown,
  paymentPhaseStatus,
  splitRefundLegs,
  withinCoolingOff,
} from '../../lib/refundRules.js';

const rejectsWith = (fn, statusCode, code) => assert.throws(fn, (e) => e.statusCode === statusCode && e.code === code);

describe('contractFee／withinCoolingOff', () => {
  test('手續費＝未履約 20%，上限 5000，負數歸 0', () => {
    assert.equal(contractFee(1000), 200);
    assert.equal(contractFee(25000), 5000);
    assert.equal(contractFee(100000), CONTRACT_FEE_CAP);
    assert.equal(contractFee(-500), 0);
    assert.equal(contractFee(333), 67);
  });

  test('7 日無條件解約邊界（含第 7 日整）', () => {
    const paid = new Date('2026-01-01T00:00:00Z');
    assert.equal(withinCoolingOff(paid, new Date('2026-01-08T00:00:00Z')), true);
    assert.equal(withinCoolingOff(paid, new Date('2026-01-08T00:00:01Z')), false);
  });
});

describe('computeTimedTopupRefund（計時儲值消保公式）', () => {
  test('全未使用：實付 − 20% 手續費，運動金全數回收', () => {
    const r = computeTimedTopupRefund({ cashWallet: 1000, bonusWallet: 100, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.recoveredBonus, 100);
    assert.equal(r.usedAmount, 0);
    assert.equal(r.refundFee, 200);
    assert.equal(r.refundCash, 800);
  });

  test('運動金已消耗：自應退現金等額扣除', () => {
    const r = computeTimedTopupRefund({ cashWallet: 1000, bonusWallet: 40, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.shortfall, 60);
    assert.equal(r.usedAmount, 60);
    assert.equal(r.beforeFee, 940);
    assert.equal(r.refundFee, 188);
    assert.equal(r.refundCash, 752);
  });

  test('錢包含其他儲值時只回收本單入帳額（取 min）', () => {
    const r = computeTimedTopupRefund({ cashWallet: 5000, bonusWallet: 900, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.remainingPrincipal, 1000);
    assert.equal(r.recoveredBonus, 100);
    assert.equal(r.refundCash, 800);
  });

  test('手續費上限 5000', () => {
    const r = computeTimedTopupRefund({ cashWallet: 50000, bonusWallet: 0, originalPrice: 50000, originalBonus: 0 });
    assert.equal(r.refundFee, 5000);
    assert.equal(r.refundCash, 45000);
  });

  test('本金用罄且運動金已耗：beforeFee 為負、不收手續費（服務層據此拒退，不倒貼）', () => {
    const r = computeTimedTopupRefund({ cashWallet: 0, bonusWallet: 0, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.beforeFee, -100);
    assert.equal(r.refundFee, 0);
    assert.ok(r.refundCash < 0);
  });
});

describe('assertTopupVoidable（原單取消）', () => {
  test('本金與運動金皆完整留存才可取消', () => {
    assert.deepEqual(assertTopupVoidable({ cashWallet: 1000, bonusWallet: 100, grantedCash: 1000, grantedBonus: 100 }), {
      deductCash: 1000,
      deductBonus: 100,
    });
  });

  test('本金或運動金不足 → 409 WALLET_INSUFFICIENT_FOR_VOID', () => {
    rejectsWith(
      () => assertTopupVoidable({ cashWallet: 999.99, bonusWallet: 100, grantedCash: 1000, grantedBonus: 100 }),
      409,
      'WALLET_INSUFFICIENT_FOR_VOID',
    );
    rejectsWith(
      () => assertTopupVoidable({ cashWallet: 1000, bonusWallet: 99, grantedCash: 1000, grantedBonus: 100 }),
      409,
      'WALLET_INSUFFICIENT_FOR_VOID',
    );
  });

  test('缺入帳快照 → 409 TOPUP_GRANT_UNKNOWN', () => {
    rejectsWith(
      () => assertTopupVoidable({ cashWallet: 1000, bonusWallet: 100, grantedCash: null, grantedBonus: 100 }),
      409,
      'TOPUP_GRANT_UNKNOWN',
    );
  });
});

describe('computePtRefund（私教）', () => {
  test('未履約：實付 − 已上堂 × 單堂價 − 手續費', () => {
    const r = computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 3, scope: 'UNUSED' });
    assert.equal(r.consumedValue, 3000);
    assert.equal(r.fee, 1400);
    assert.equal(r.gross, 5600);
  });

  test('7 日內且未使用免手續費；已使用不可全額退', () => {
    assert.equal(computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 0, scope: 'UNUSED', coolingOff: true }).fee, 0);
    rejectsWith(() => computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 1, scope: 'FULL' }), 409, 'SERVICE_ALREADY_USED');
  });

  test('高額合約手續費封頂 5000', () => {
    const r = computePtRefund({ pricePaid: 100000, totalSessions: 50, usedSessions: 0, scope: 'UNUSED' });
    assert.equal(r.fee, 5000);
    assert.equal(r.gross, 95000);
  });
});

describe('computeSaleReturnLines（銷貨退回）', () => {
  const items = [
    { id: 1, name: '水', qty: 3, unitPrice: 20, refundedQty: 1, taxType: 'TAXABLE' },
    { id: 2, name: '毛巾', qty: 1, unitPrice: 300, refundedQty: 0, taxType: 'TAXABLE' },
  ];

  test('未指定品項＝全部未退數量，並判定退盡', () => {
    const r = computeSaleReturnLines(items, null);
    assert.equal(r.gross, 340);
    assert.equal(r.exhausts, true);
  });

  test('超退與重複品項被拒', () => {
    rejectsWith(() => computeSaleReturnLines(items, [{ orderItemId: 1, qty: 3 }]), 409, 'REFUND_QTY_EXCEEDED');
    rejectsWith(
      () => computeSaleReturnLines(items, [{ orderItemId: 2, qty: 1 }, { orderItemId: 2, qty: 1 }]),
      400,
      'ORDER_ITEM_DUPLICATE',
    );
    rejectsWith(() => computeSaleReturnLines(items, [{ orderItemId: 9, qty: 1 }]), 400, 'ORDER_ITEM_INVALID');
  });
});

describe('退款管道拆分', () => {
  test('normalizeBreakdown：CARD＝PayUNi；無分攤以 payMethod 全額；未知管道拒絕', () => {
    assert.deepEqual(normalizeBreakdown({ CASH: 300, CARD: 700 }, {}), { CASH: 300, PAYUNI: 700 });
    assert.deepEqual(normalizeBreakdown(null, { payMethod: 'yipay', amount: 500 }), { YIPAY: 500 });
    rejectsWith(() => normalizeBreakdown(null, { payMethod: 'BITCOIN', amount: 1 }), 409, 'PAY_CHANNEL_UNKNOWN');
  });

  test('依原付款比例拆分，加總不變；抵用券份額 FORFEITED', () => {
    const legs = splitRefundLegs({ breakdown: { CASH: 600, VOUCHER: 400 }, refundAmount: 501 });
    assert.equal(legs.reduce((s, l) => s + l.amount, 0), 501);
    const voucher = legs.find((l) => l.method === 'VOUCHER');
    assert.equal(voucher.forfeited, true);
    assert.equal(legs.find((l) => l.method === 'CASH').forfeited, false);
  });

  test('管道可退額度不足時溢往其他管道；總額超過可退則拒絕', () => {
    const legs = splitRefundLegs({
      breakdown: { LINEPAY: 500, CASH: 500 },
      refundAmount: 600,
      available: { LINEPAY: 100, CASH: 500 },
    });
    assert.deepEqual(Object.fromEntries(legs.map((l) => [l.method, l.amount])), { LINEPAY: 100, CASH: 500 });
    rejectsWith(
      () => splitRefundLegs({ breakdown: { CASH: 500 }, refundAmount: 400, available: { CASH: 300 } }),
      409,
      'REFUND_EXCEEDS_PAID',
    );
  });

  test('付款階段狀態與可否中止', () => {
    assert.equal(paymentPhaseStatus([{ status: 'REFUNDED' }, { status: 'FORFEITED' }]), 'INVOICE_PENDING');
    assert.equal(paymentPhaseStatus([{ status: 'AWAITING_TERMINAL' }, { status: 'REFUNDED' }]), 'AWAITING_TERMINAL');
    assert.equal(paymentPhaseStatus([{ status: 'FAILED' }, { status: 'PENDING' }]), 'PAYMENT_FAILED');
    assert.equal(canAbortRefund([{ method: 'CASH', status: 'REFUNDED' }]), true);
    assert.equal(canAbortRefund([{ method: 'LINEPAY', status: 'PROCESSING' }]), false);
    assert.equal(canAbortRefund([{ method: 'YIPAY', status: 'REFUNDED' }]), false);
  });
});
