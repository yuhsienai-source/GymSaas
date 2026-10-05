// 私教合約中途解約（契約第九條第三款、第六條第五款、第十四條）：
// 已預約未上之堂次退費時自動取消並還堂、臨時請假補償自應退扣除、上課中禁止退費、手續費減免須 DUTY+
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
import { executeSubOrderRefund, previewSubOrderRefund } from '../../lib/refundService.js';

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

const HOUR = 3600_000;
let user;
let branch;

beforeEach(async () => {
  await resetDb();
  user = await createStaffUser('ADMIN');
  branch = await createBranch();
});

after(closePrisma);

/** 10 堂 $10,000；已上 2 堂、未來已預約 2 堂（預約即扣堂 → usedSessions 4）、臨時請假 1 次補償 $200 */
async function setup() {
  const member = await createMember();
  const trainer = await prisma.trainer.create({ data: { name: '測試教練', phone: `09${Date.now() % 1e8}` } });
  const venue = await prisma.venue.create({ data: { branchId: branch.id, name: '測試場地' } });
  const order = await prisma.order.create({
    data: {
      id: testId('TYK'),
      memberId: member.id,
      branchId: branch.id,
      amount: 10000,
      status: 'PAID',
      payMethod: 'WALLET_CASH',
      itemDesc: '私教購案 | 10 堂',
    },
  });
  const contract = await prisma.pTContract.create({
    data: {
      memberId: member.id,
      trainerId: trainer.id,
      branchId: branch.id,
      totalSessions: 10,
      usedSessions: 4,
      pricePaid: 10000,
      orderId: order.id,
    },
  });
  const now = Date.now();
  const mkClass = async (startOffsetH, status = 'CONFIRMED') => {
    const cls = await prisma.class.create({
      data: {
        title: '私教',
        type: 'PRIVATE',
        venueId: venue.id,
        trainerId: trainer.id,
        ptContractId: contract.id,
        startAt: new Date(now + startOffsetH * HOUR),
        endAt: new Date(now + (startOffsetH + 1) * HOUR),
      },
    });
    const res = await prisma.reservation.create({ data: { memberId: member.id, classId: cls.id, status } });
    return { cls, res };
  };
  await mkClass(-72, 'COMPLETED');
  await mkClass(-48, 'COMPLETED');
  const futureA = await mkClass(24);
  const futureB = await mkClass(48);
  const late = await mkClass(-24, 'CANCELLED');
  await prisma.classLeave.create({
    data: {
      memberId: member.id,
      reservationId: late.res.id,
      withinPolicy: false,
      ptContractId: contract.id,
      compensationFee: 200,
    },
  });
  return { member, trainer, venue, order, contract, mkClass, future: [futureA.cls.id, futureB.cls.id] };
}

describe('私教中途解約', () => {
  test('試算：未來預約不計已上堂數；單價 floor、扣臨時請假補償、違約金 20%', async () => {
    const { order } = await setup();
    const plan = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    assert.equal(plan.calc.used, 2);
    assert.equal(plan.calc.releasedSessions, 2);
    assert.equal(plan.calc.lateLeaveFees, 200);
    assert.equal(plan.consumedValue, 2200);
    assert.equal(plan.feeMax, 1560);
    assert.equal(plan.feeAmount, 1560);
    assert.equal(plan.grossAmount, 6240);
    assert.equal(plan.clause, 'VOLUNTARY');
    assert.ok(plan.warnings.some((w) => w.includes('2')), '須提示將自動取消未來預約');
  });

  test('第十四條免違約金；調降不得超過上限；非 DUTY+ 不可減免', async () => {
    const { order } = await setup();
    const exempt = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED', clause: 'EXEMPT' });
    assert.equal(exempt.feeAmount, 0);
    assert.equal(exempt.grossAmount, 7800);
    const reduced = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED', overrideFeeAmount: '500' });
    assert.equal(reduced.feeAmount, 500);
    assert.equal(reduced.grossAmount, 7300);
    await assert.rejects(
      previewSubOrderRefund(user, order.id, { scope: 'UNUSED', overrideFeeAmount: 2000 }),
      isError(400, 'FEE_EXCEEDS_CONTRACT_LIMIT'),
    );
    const staff = await createStaffUser('STAFF');
    await assert.rejects(
      previewSubOrderRefund(staff, order.id, { scope: 'UNUSED', clause: 'EXEMPT' }),
      isError(403, 'DUTY_ROLE_REQUIRED_FOR_FEE_WAIVER'),
    );
  });

  test('課程進行中禁止退費', async () => {
    const { order, mkClass } = await setup();
    await mkClass(-0.5);
    await assert.rejects(previewSubOrderRefund(user, order.id, { scope: 'UNUSED' }), isError(409, 'COURSE_SESSION_IN_PROGRESS'));
  });

  test('執行：同交易刪除未來預約堂次、合約停用並回寫實際已上堂數', async () => {
    const { order, contract, future } = await setup();
    const plan = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    const refund = await executeSubOrderRefund(user, order.id, {
      quoteToken: plan.quoteToken,
      scope: 'UNUSED',
      reason: '測試解約',
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(refund.payoutAmount, 6240);
    assert.equal(await prisma.class.count({ where: { id: { in: future } } }), 0);
    const after = await prisma.pTContract.findUnique({ where: { id: contract.id } });
    assert.equal(after.isActive, false);
    assert.ok(after.refundedAt);
    assert.equal(after.usedSessions, 2);
  });

  test('逾效期：試算只提示不擋；非 DUTY+ 執行 403，DUTY+ 專案核准並留稽核', async () => {
    const { order, contract } = await setup();
    const expiredAt = new Date(Date.now() - 86400_000);
    await prisma.pTContract.update({ where: { id: contract.id }, data: { expiresAt: expiredAt } });
    const fresh = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    assert.equal(fresh.isContractExpired, true);
    assert.equal(fresh.contractExpiresAt, expiredAt.toISOString());
    assert.equal(fresh.grossAmount, 6240);
    assert.ok(fresh.warnings.some((w) => w.includes('已逾契約效期')));

    const staff = { ...(await createStaffUser('STAFF')), branchIds: [branch.id] };
    const staffPlan = await previewSubOrderRefund(staff, order.id, { scope: 'UNUSED' });
    await assert.rejects(
      executeSubOrderRefund(staff, order.id, {
        quoteToken: staffPlan.quoteToken,
        scope: 'UNUSED',
        reason: '測試解約',
        idempotencyKey: idempotencyKey(),
      }),
      isError(403, 'DUTY_APPROVAL_REQUIRED_FOR_EXPIRED_COURSE'),
    );
    assert.equal(await prisma.refundRequest.count({ where: { refId: order.id } }), 0);

    const refund = await executeSubOrderRefund(user, order.id, {
      quoteToken: fresh.quoteToken,
      scope: 'UNUSED',
      reason: '專案退費',
      idempotencyKey: idempotencyKey(),
    });
    assert.equal(refund.payoutAmount, 6240);
    assert.equal(refund.calc.approvals.expiredCourse.approvedByStaffId, user.id);
    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_EXPIRED_COURSE_APPROVAL' } });
    assert.equal(audit?.after?.contractExpiresAt, expiredAt.toISOString());
  });

  test('未逾效期：isContractExpired=false，到期日＝購買日＋堂數×10 日', async () => {
    const { order, contract } = await setup();
    const plan = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    assert.equal(plan.isContractExpired, false);
    assert.equal(plan.contractExpiresAt, new Date(contract.createdAt.getTime() + 100 * 86400_000).toISOString());
  });

  test('試算後換了條款：送出時摘要不符 → 409 QUOTE_STALE', async () => {
    const { order } = await setup();
    const plan = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    await assert.rejects(
      executeSubOrderRefund(user, order.id, {
        quoteToken: plan.quoteToken,
        scope: 'UNUSED',
        clause: 'EXEMPT',
        reason: '測試解約',
        idempotencyKey: idempotencyKey(),
      }),
      isError(409, 'QUOTE_STALE'),
    );
    assert.equal(await prisma.refundRequest.count({ where: { refId: order.id } }), 0);
  });
});
