import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COURSE_FEE_CAP,
  allocateInstallmentRefund,
  assertTopupVoidable,
  canAbortRefund,
  computeCourseInstallmentRefund,
  computePtRefund,
  computeSaleReturnLines,
  computeTimedTopupRefund,
  courseFee,
  lateLeaveChargeFor,
  lateLeaveCompensation,
  ptContractExpiresAt,
  normalizeBreakdown,
  normalizeOverrideFee,
  normalizeTerminationClause,
  hasPendingYipayTerminal,
  paymentPhaseStatus,
  ptUnitPrice,
  resolveAppliedFee,
  splitRefundLegs,
  withinCoolingOff,
} from '../../lib/refundRules.js';
import { computeMonthlyCardRefundDetail } from '../../lib/subscriptionSettle.js';

const rejectsWith = (fn, statusCode, code) => assert.throws(fn, (e) => e.statusCode === statusCode && e.code === code);

describe('契約第九條手續費／第八條 7 日', () => {
  test('課程違約金＝應退餘額 20%（四捨五入），上限 9000，負數歸 0', () => {
    assert.equal(courseFee(1000), 200);
    assert.equal(courseFee(45000), 9000);
    assert.equal(courseFee(100000), COURSE_FEE_CAP);
    assert.equal(courseFee(-500), 0);
    assert.equal(courseFee(333), 67);
  });

  test('7 日無條件解約以台灣日曆日計（含第 7 日整天）', () => {
    const paid = new Date('2026-01-01T00:00:00Z'); // 台灣 1/1 08:00
    assert.equal(withinCoolingOff(paid, new Date('2026-01-08T15:59:59Z')), true); // 台灣 1/8 23:59
    assert.equal(withinCoolingOff(paid, new Date('2026-01-08T16:00:00Z')), false); // 台灣 1/9 00:00
  });

  test('私教單價無條件捨去；臨時請假補償 20%、不足 100 以 100 計', () => {
    assert.equal(ptUnitPrice(10000, 3), 3333);
    assert.equal(lateLeaveCompensation(1200), 240);
    assert.equal(lateLeaveCompensation(400), 100);
    assert.equal(lateLeaveCompensation(1666), 333);
  });

  test('臨時請假每期前 2 次免收，第 3 次起收；效期每堂 10 日', () => {
    assert.equal(lateLeaveChargeFor(0, 1100), 0);
    assert.equal(lateLeaveChargeFor(1, 1100), 0);
    assert.equal(lateLeaveChargeFor(2, 1100), 220);
    assert.equal(lateLeaveChargeFor(5, 400), 100);
    const from = new Date('2026-01-01T00:00:00Z');
    assert.equal(ptContractExpiresAt(20, from).toISOString(), '2026-07-20T00:00:00.000Z');
  });

  test('條款／手續費調降：EXEMPT 為 0，調降不得超過上限', () => {
    assert.equal(resolveAppliedFee(500), 500);
    assert.equal(resolveAppliedFee(500, { clause: 'EXEMPT', overrideFeeAmount: 300 }), 0);
    assert.equal(resolveAppliedFee(500, { overrideFeeAmount: 200 }), 200);
    rejectsWith(() => resolveAppliedFee(500, { overrideFeeAmount: 501 }), 400, 'FEE_EXCEEDS_CONTRACT_LIMIT');
    assert.equal(normalizeTerminationClause(''), 'VOLUNTARY');
    assert.equal(normalizeTerminationClause('exempt'), 'EXEMPT');
    rejectsWith(() => normalizeTerminationClause('ARTICLE_99'), 400, 'CLAUSE_INVALID');
    assert.equal(normalizeOverrideFee(''), null);
    assert.equal(normalizeOverrideFee('300'), 300);
    rejectsWith(() => normalizeOverrideFee(-1), 400, 'INVALID_FEE_AMOUNT');
    rejectsWith(() => normalizeOverrideFee(12.5), 400, 'INVALID_FEE_AMOUNT');
  });
});

describe('computeMonthlyCardRefundDetail（月卡：半月制、手續費 $500）', () => {
  const base = { orderAmount: 12000, periodDays: 30, contractDays: 360 };

  test('當期未滿 15 日以半個月計', () => {
    const r = computeMonthlyCardRefundDetail({ ...base, unusedDays: 350 });
    assert.equal(r.consumedPeriods, 0.5);
    assert.equal(r.monthlyAvg, 1000);
    assert.equal(r.base, 11500);
    assert.equal(r.fee, 500);
    assert.equal(r.amount, 11000);
  });

  test('當期滿 15 日以一個月計；跨期累計整月', () => {
    assert.equal(computeMonthlyCardRefundDetail({ ...base, unusedDays: 340 }).amount, 10500);
    const r = computeMonthlyCardRefundDetail({ ...base, unusedDays: 300 });
    assert.equal(r.consumedPeriods, 2);
    assert.equal(r.amount, 9500);
  });

  test('月平均無條件捨去；手續費不超過剩餘可退', () => {
    const r = computeMonthlyCardRefundDetail({ orderAmount: 10000, periodDays: 30, contractDays: 90, unusedDays: 80 });
    assert.equal(r.monthlyAvg, 3333);
    assert.equal(r.base, 8333);
    assert.equal(r.amount, 7833);
    const tiny = computeMonthlyCardRefundDetail({ orderAmount: 600, periodDays: 30, contractDays: 30, unusedDays: 20 });
    assert.equal(tiny.base, 300);
    assert.equal(tiny.feeMax, 300);
    assert.equal(tiny.amount, 0);
  });

  test('第十四條免手續費／主管調降', () => {
    assert.equal(computeMonthlyCardRefundDetail({ ...base, unusedDays: 350, feePolicy: { clause: 'EXEMPT' } }).amount, 11500);
    assert.equal(computeMonthlyCardRefundDetail({ ...base, unusedDays: 350, feePolicy: { overrideFeeAmount: 200 } }).amount, 11300);
    rejectsWith(
      () => computeMonthlyCardRefundDetail({ ...base, unusedDays: 350, feePolicy: { overrideFeeAmount: 600 } }),
      400,
      'FEE_EXCEEDS_CONTRACT_LIMIT',
    );
  });

  test('當期滿 15 日且為最後一期：無剩餘可退', () => {
    const r = computeMonthlyCardRefundDetail({ orderAmount: 1500, periodDays: 30, contractDays: 30, unusedDays: 10 });
    assert.equal(r.eligible, false);
    assert.equal(r.amount, 0);
  });
});

describe('computeTimedTopupRefund（契約第九條第一款：手續費 $100）', () => {
  test('全未使用（逾 7 日）：實付 − $100，運動金全數註銷', () => {
    const r = computeTimedTopupRefund({ cashWallet: 1000, bonusWallet: 100, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.recoveredBonus, 100);
    assert.equal(r.usedAmount, 0);
    assert.equal(r.refundFee, 100);
    assert.equal(r.refundCash, 900);
  });

  test('第八條：7 日內未使用免手續費', () => {
    const r = computeTimedTopupRefund({ cashWallet: 1000, bonusWallet: 100, originalPrice: 1000, originalBonus: 100, coolingOff: true });
    assert.equal(r.unusedGrace, true);
    assert.equal(r.refundFee, 0);
    assert.equal(r.refundCash, 1000);
  });

  test('運動金已消耗：自應退現金等額扣除', () => {
    const r = computeTimedTopupRefund({ cashWallet: 1000, bonusWallet: 40, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.shortfall, 60);
    assert.equal(r.usedAmount, 60);
    assert.equal(r.beforeFee, 940);
    assert.equal(r.refundFee, 100);
    assert.equal(r.refundCash, 840);
  });

  test('錢包含其他儲值時只回收本單入帳額（取 min）', () => {
    const r = computeTimedTopupRefund({ cashWallet: 5000, bonusWallet: 900, originalPrice: 1000, originalBonus: 100 });
    assert.equal(r.remainingPrincipal, 1000);
    assert.equal(r.recoveredBonus, 100);
    assert.equal(r.refundCash, 900);
  });

  test('高額儲值手續費仍為 $100；剩餘不足 $100 時以剩餘為上限', () => {
    const r = computeTimedTopupRefund({ cashWallet: 50000, bonusWallet: 0, originalPrice: 50000, originalBonus: 0 });
    assert.equal(r.refundFee, 100);
    assert.equal(r.refundCash, 49900);
    const low = computeTimedTopupRefund({ cashWallet: 60, bonusWallet: 0, originalPrice: 1000, originalBonus: 0 });
    assert.equal(low.refundFee, 60);
    assert.equal(low.refundCash, 0);
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

  test('高額合約違約金封頂 9000', () => {
    const r = computePtRefund({ pricePaid: 100000, totalSessions: 50, usedSessions: 0, scope: 'UNUSED' });
    assert.equal(r.fee, 9000);
    assert.equal(r.gross, 91000);
  });

  test('單價含贈送堂數且無條件捨去；臨時請假補償自應退餘額扣除', () => {
    const r = computePtRefund({ pricePaid: 10000, totalSessions: 12, usedSessions: 2, lateLeaveFees: 166, scope: 'UNUSED' });
    assert.equal(r.unitPrice, 833);
    assert.equal(r.consumedValue, 1666);
    assert.equal(r.refundable, 8168);
    assert.equal(r.fee, 1634);
    assert.equal(r.gross, 6534);
  });

  test('有臨時請假補償即不可全額退；堂數用罄不可退', () => {
    rejectsWith(
      () => computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 0, lateLeaveFees: 200, scope: 'FULL' }),
      409,
      'SERVICE_ALREADY_USED',
    );
    rejectsWith(() => computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 10, scope: 'UNUSED' }), 409, 'COURSE_SESSIONS_EXHAUSTED');
  });

  test('第十四條免違約金', () => {
    const r = computePtRefund({ pricePaid: 10000, totalSessions: 10, usedSessions: 3, scope: 'UNUSED', feePolicy: { clause: 'EXEMPT' } });
    assert.equal(r.feeMax, 1400);
    assert.equal(r.fee, 0);
    assert.equal(r.gross, 7000);
  });
});

describe('computeCourseInstallmentRefund（課程分期解約）', () => {
  const base = { contractPrice: 22000, totalSessions: 20, scope: 'UNUSED' };

  test('教練課契約範例：20 堂 $22,000、已上 5 堂、已繳 $12,000 → 退 $3,200', () => {
    const r = computeCourseInstallmentRefund({ ...base, paidAmount: 12000, usedSessions: 5 });
    assert.equal(r.unitPrice, 1100);
    assert.equal(r.contractRefund, 13200);
    assert.equal(r.unpaid, 10000);
    assert.equal(r.gross, 3200);
    assert.equal(r.shortfall, 0);
  });

  test('未繳大於契約可退：退 0、列應補繳', () => {
    const r = computeCourseInstallmentRefund({ ...base, paidAmount: 11000, usedSessions: 15 });
    assert.equal(r.gross, 0);
    assert.equal(r.shortfall, 6600);
  });

  test('第八條未上課：退已繳全額（不扣未繳）', () => {
    const r = computeCourseInstallmentRefund({ ...base, paidAmount: 5500, usedSessions: 0, coolingOff: true });
    assert.equal(r.gross, 5500);
    assert.equal(r.fee, 0);
  });

  test('第十四條免違約金', () => {
    const r = computeCourseInstallmentRefund({ ...base, paidAmount: 12000, usedSessions: 5, feePolicy: { clause: 'EXEMPT' } });
    assert.equal(r.gross, 6500);
  });

  test('分攤由最新一期往前，每期不超過可退餘額', () => {
    const periods = [
      { orderId: 'P3', refundable: 5500, amount: 5500 },
      { orderId: 'P2', refundable: 5500, amount: 5500 },
      { orderId: 'P1', refundable: 5500, amount: 5500 },
    ];
    assert.deepEqual(allocateInstallmentRefund(periods, 7000), [
      { orderId: 'P3', amount: 5500, full: true },
      { orderId: 'P2', amount: 1500, full: false },
    ]);
    assert.deepEqual(allocateInstallmentRefund(periods, 0), []);
    rejectsWith(() => allocateInstallmentRefund(periods, 20000), 409, 'REFUND_EXCEEDS_PAID');
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
    assert.equal(hasPendingYipayTerminal([{ method: 'YIPAY', status: 'AWAITING_TERMINAL' }]), true);
    assert.equal(hasPendingYipayTerminal([{ method: 'YIPAY', status: 'REFUNDED', rrn: 'ABC123', authCode: 'A1B2C3' }]), false);
    assert.equal(hasPendingYipayTerminal([{ method: 'YIPAY', status: 'REFUNDED', rrn: 'ABC123' }]), true);
    assert.equal(hasPendingYipayTerminal([{ method: 'CASH', status: 'REFUNDED' }]), false);
  });
});
