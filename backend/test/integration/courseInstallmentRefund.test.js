// 客製化教練課分期解約：應退＝（契約總價 − 已上 × 單價）× 80% − 未繳期數金額，
// 由最新一期往前分攤退款；負數退 0 並顯示應補繳；續扣單不可單獨退
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePrisma,
  createBranch,
  createMember,
  createStaffUser,
  idempotencyKey,
  prisma,
  resetDb,
  testId,
} from '../helpers/db.js';
import { abortRefund, executeSubOrderRefund, previewSubOrderRefund } from '../../lib/refundService.js';

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

let user;
let branch;

beforeEach(async () => {
  await resetDb();
  user = await createStaffUser('ADMIN');
  branch = await createBranch();
});

after(closePrisma);

/** 契約 $22,000／20 堂、分 4 期每期 $5,500；已繳首期＋第 2 期（$11,000） */
async function setup({ usedSessions, renewalPayMethod = 'WALLET_CASH', subStatus = 'CANCELLED' }) {
  const member = await createMember();
  const trainer = await prisma.trainer.create({ data: { name: '測試教練', phone: `09${Date.now() % 1e8}` } });
  const plan = await prisma.coursePlan.create({
    data: { branchId: branch.id, name: '客製化教練課', planType: 'CUSTOM_PT', price: 22000, sessions: 20 },
  });
  const origin = await prisma.order.create({
    data: {
      id: testId('CRS'),
      memberId: member.id,
      branchId: branch.id,
      amount: 5500,
      status: 'PAID',
      payMethod: 'WALLET_CASH',
      cardMode: 'RECURRING',
      itemDesc: `課程定期定額首期 | 客製化教練課 ×1 | 課程方案#${plan.id} | 4期`,
    },
  });
  const sub = await prisma.cardSubscription.create({
    data: {
      id: testId('CRS'),
      memberId: member.id,
      coursePlanId: plan.id,
      originOrderId: origin.id,
      creditHash: '',
      amount: 5500,
      periodType: 'M',
      periodTimes: 4,
      chargedCount: 2,
      status: subStatus,
      nextChargeAt: new Date(Date.now() + 30 * 86400_000),
    },
  });
  const renewal = await prisma.order.create({
    data: {
      id: testId('CRS'),
      memberId: member.id,
      branchId: branch.id,
      amount: 5500,
      status: 'PAID',
      payMethod: renewalPayMethod,
      itemDesc: `課程定期定額續扣 | 客製化教練課 | 課程方案#${plan.id} | 訂閱#${sub.id} | 期2`,
    },
  });
  await prisma.cardSubscriptionCharge.create({
    data: { id: testId('CRC'), subscriptionId: sub.id, orderId: renewal.id, amount: 5500, periodIndex: 2, status: 'PAID' },
  });
  const contract = await prisma.pTContract.create({
    data: {
      memberId: member.id,
      trainerId: trainer.id,
      branchId: branch.id,
      totalSessions: 20,
      usedSessions,
      pricePaid: 22000,
      orderId: origin.id,
    },
  });
  return { member, origin, renewal, contract, sub };
}

describe('課程分期解約', () => {
  test('試算：契約公式扣未繳，應退由最新一期分攤', async () => {
    const { origin, renewal } = await setup({ usedSessions: 5 });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    assert.equal(plan.orderKind, 'COURSE_SUB');
    assert.equal(plan.calc.contractRefund, 13200);
    assert.equal(plan.calc.paid, 11000);
    assert.equal(plan.calc.unpaid, 11000);
    assert.equal(plan.grossAmount, 2200);
    assert.deepEqual(plan.calc.allocations, [{ orderId: renewal.id, amount: 2200, full: false }]);
    assert.deepEqual(
      plan.legs.map((l) => [l.method, l.amount, l.refOrderId]),
      [['WALLET_CASH', 2200, renewal.id]],
    );
  });

  test('續扣單不可單獨退費', async () => {
    const { renewal } = await setup({ usedSessions: 5 });
    await assert.rejects(previewSubOrderRefund(user, renewal.id, { scope: 'UNUSED' }), isError(409, 'USE_COURSE_ORIGIN_ORDER'));
  });

  test('執行：停用合約、各期訂單依分攤累加已退；中止可回復', async () => {
    const { origin, renewal, contract, member } = await setup({ usedSessions: 5 });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    const refund = await executeSubOrderRefund(user, origin.id, {
      quoteToken: plan.quoteToken,
      scope: 'UNUSED',
      reason: '測試解約',
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(refund.payoutAmount, 2200);
    assert.equal(refund.status, 'COMPLETED');
    const r1 = await prisma.order.findUnique({ where: { id: renewal.id } });
    assert.equal(r1.refundedAmount, 2200);
    assert.equal(r1.status, 'PAID');
    const o1 = await prisma.order.findUnique({ where: { id: origin.id } });
    assert.equal(o1.refundedAmount, 0);
    const c1 = await prisma.pTContract.findUnique({ where: { id: contract.id } });
    assert.equal(c1.isActive, false);
    const m1 = await prisma.member.findUnique({ where: { id: member.id } });
    assert.equal(Number(m1.cashWallet), 2200);
    const pays = await prisma.refundPayment.findMany({ where: { refundId: refund.id } });
    assert.deepEqual(pays.map((p) => p.refOrderId), [renewal.id]);

    await assert.rejects(previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' }), isError(409, 'ALREADY_REFUNDED'));
  });

  test('中止退費（乙禾端末未退刷）：各期訂單與合約回復', async () => {
    const { origin, renewal, contract } = await setup({ usedSessions: 5, renewalPayMethod: 'YIPAY' });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    const refund = await executeSubOrderRefund(user, origin.id, {
      quoteToken: plan.quoteToken,
      scope: 'UNUSED',
      reason: '測試解約',
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(refund.status, 'AWAITING_TERMINAL');
    const mid = await prisma.order.findUnique({ where: { id: renewal.id } });
    assert.equal(mid.refundedAmount, 2200);
    await abortRefund(user, refund.id, { reason: '測試中止' });
    const r1 = await prisma.order.findUnique({ where: { id: renewal.id } });
    assert.equal(r1.refundedAmount, 0);
    assert.equal(r1.status, 'PAID');
    const c1 = await prisma.pTContract.findUnique({ where: { id: contract.id } });
    assert.equal(c1.isActive, true);
    assert.equal(c1.refundedAt, null);
  });

  test('未繳大於契約可退：退 0、提示補繳差額；確認臨櫃收訖後才終止合約並留稽核，不設警示', async () => {
    const { origin, contract, member } = await setup({ usedSessions: 15 });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    assert.equal(plan.calc.contractRefund, 4400);
    assert.equal(plan.grossAmount, 0);
    assert.equal(plan.calc.shortfall, 6600);
    assert.equal(plan.shortfall, 6600);
    assert.equal(plan.legs.length, 0);
    assert.ok(plan.warnings.some((w) => w.includes('補繳差額 $6600')));
    const refund = await executeSubOrderRefund(user, origin.id, {
      quoteToken: plan.quoteToken,
      scope: 'UNUSED',
      reason: '測試解約',
      idempotencyKey: idempotencyKey(),
      shortfallResolution: 'PAID_AT_POS',
      shortfallNote: 'SAL-TEST-001',
    });
    assert.equal(refund.payoutAmount, 0);
    assert.equal(refund.status, 'COMPLETED');
    assert.equal(refund.calc.approvals.shortfall.amount, 6600);
    assert.equal(refund.calc.approvals.shortfall.resolution, 'PAID_AT_POS');
    const c1 = await prisma.pTContract.findUnique({ where: { id: contract.id } });
    assert.equal(c1.isActive, false);
    assert.ok(c1.refundedAt);
    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_SHORTFALL_CONFIRM' } });
    assert.equal(audit?.after?.amount, 6600);
    assert.equal(audit?.after?.note, 'SAL-TEST-001');
    assert.equal(audit?.staffId, user.id);
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);
    assert.equal(await prisma.paymentBlacklist.count({ where: { memberId: member.id } }), 0);
  });

  test('立案追償：同交易寫欠款黑名單（既有事由累加）並留稽核，不設警示帳號', async () => {
    const { origin, member } = await setup({ usedSessions: 15 });
    await prisma.paymentBlacklist.create({ data: { memberId: member.id, reason: '舊欠款', note: '舊備註', isActive: true } });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    const refund = await executeSubOrderRefund(user, origin.id, {
      quoteToken: plan.quoteToken,
      scope: 'UNUSED',
      reason: '測試解約',
      idempotencyKey: idempotencyKey(),
      shortfallResolution: 'FLAG_ALERT_FOR_RECOVERY',
    });
    assert.equal(refund.status, 'COMPLETED');
    assert.equal(refund.calc.approvals.shortfall.resolution, 'FLAG_ALERT_FOR_RECOVERY');
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);
    const bl = await prisma.paymentBlacklist.findUnique({ where: { memberId: member.id } });
    assert.equal(bl.isActive, true);
    assert.ok(bl.reason.startsWith('舊欠款；課程分期解約欠繳 $6600'));
    assert.ok(bl.reason.includes(refund.id));
    assert.equal(bl.note, '舊備註');
    assert.equal(bl.staffId, user.id);
    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_SHORTFALL_RECOVERY' } });
    assert.deepEqual(audit?.before, { blacklistActive: true, blacklistReason: '舊欠款' });
    assert.equal(audit?.after?.blacklistActive, true);
    assert.equal(audit?.after?.amount, 6600);
  });

  test('已臨櫃收訖未填收款單號：400 SHORTFALL_NOTE_REQUIRED，不停扣、不建退費單', async () => {
    const { origin, sub } = await setup({ usedSessions: 15, subStatus: 'ACTIVE' });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    for (const shortfallNote of [undefined, '  ', 'A']) {
      await assert.rejects(
        executeSubOrderRefund(user, origin.id, {
          quoteToken: plan.quoteToken,
          scope: 'UNUSED',
          reason: '測試解約',
          idempotencyKey: idempotencyKey(),
          shortfallResolution: 'PAID_AT_POS',
          shortfallNote,
        }),
        isError(400, 'SHORTFALL_NOTE_REQUIRED'),
      );
    }
    assert.equal((await prisma.cardSubscription.findUnique({ where: { id: sub.id } })).status, 'ACTIVE');
    assert.equal(await prisma.refundRequest.count({ where: { refId: origin.id } }), 0);
  });

  test('處置方式無效：400，不建退費單', async () => {
    const { origin } = await setup({ usedSessions: 15 });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    await assert.rejects(
      executeSubOrderRefund(user, origin.id, {
        quoteToken: plan.quoteToken,
        scope: 'UNUSED',
        reason: '測試解約',
        idempotencyKey: idempotencyKey(),
        shortfallResolution: 'WAIVE',
      }),
      isError(400, 'SHORTFALL_RESOLUTION_INVALID'),
    );
    assert.equal(await prisma.refundRequest.count({ where: { refId: origin.id } }), 0);
  });

  test('應補繳未確認：409 SHORTFALL_SETTLEMENT_REQUIRED，不停扣、不終止合約、不建退費單', async () => {
    const { origin, contract, sub } = await setup({ usedSessions: 15, subStatus: 'ACTIVE' });
    const plan = await previewSubOrderRefund(user, origin.id, { scope: 'UNUSED' });
    await assert.rejects(
      executeSubOrderRefund(user, origin.id, {
        quoteToken: plan.quoteToken,
        scope: 'UNUSED',
        reason: '測試解約',
        idempotencyKey: idempotencyKey(),
      }),
      isError(409, 'SHORTFALL_SETTLEMENT_REQUIRED'),
    );
    assert.equal((await prisma.cardSubscription.findUnique({ where: { id: sub.id } })).status, 'ACTIVE');
    const c1 = await prisma.pTContract.findUnique({ where: { id: contract.id } });
    assert.equal(c1.isActive, true);
    assert.equal(c1.refundedAt, null);
    assert.equal(await prisma.refundRequest.count({ where: { refId: origin.id } }), 0);
  });

  test('應補繳確認限 DUTY+', async () => {
    const { origin, member } = await setup({ usedSessions: 15 });
    const staff = { ...(await createStaffUser('STAFF')), branchIds: [branch.id] };
    const plan = await previewSubOrderRefund(staff, origin.id, { scope: 'UNUSED' });
    await assert.rejects(
      executeSubOrderRefund(staff, origin.id, {
        quoteToken: plan.quoteToken,
        scope: 'UNUSED',
        reason: '測試解約',
        idempotencyKey: idempotencyKey(),
        shortfallResolution: 'FLAG_ALERT_FOR_RECOVERY',
      }),
      isError(403, 'DUTY_APPROVAL_REQUIRED_FOR_SHORTFALL'),
    );
    assert.equal(await prisma.refundRequest.count({ where: { refId: origin.id } }), 0);
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);
  });
});
