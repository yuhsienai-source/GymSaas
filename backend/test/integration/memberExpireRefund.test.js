// 會籍效期邊界（購買／續購／補償／暫停順延同一台灣日曆）與月卡退費第九條第二款半月制、第十二條傷病免手續費
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createBranch, createMember, prisma, resetDb, testId } from '../helpers/db.js';
import { UNLIMITED_MEMBER_PLAN, computeMemberExpireDate, remainingExpireDays, shiftDateByDays } from '../../lib/promotion.js';
import { computeMonthlyCardRefundDetail, previewCancelUnlimitedOrder } from '../../lib/subscriptionSettle.js';

const DAY = 24 * 3600 * 1000;
const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

beforeEach(resetDb);
after(closePrisma);

describe('computeMemberExpireDate（台灣日曆日）', () => {
  test('新購：購買日算第 1 天，9/7 買 30 天 → 10/6 23:59:59.999（台灣）', () => {
    const buy = new Date('2026-09-07T02:00:00Z');
    assert.equal(computeMemberExpireDate(null, 30, buy).toISOString(), '2026-10-06T15:59:59.999Z');
  });

  test('與伺服器時區無關：台灣 9/7 07:00（UTC 9/6 23:00）購買仍至 10/6', () => {
    const buy = new Date('2026-09-06T23:00:00Z');
    assert.equal(computeMemberExpireDate(null, 30, buy).toISOString(), '2026-10-06T15:59:59.999Z');
  });

  test('效期中續購／補償：自到期日次日接續整整 days 天，與暫停順延（shiftDateByDays）一致', () => {
    const expire = new Date('2026-10-06T15:59:59.999Z');
    const renewed = computeMemberExpireDate(expire, 30, new Date('2026-09-20T02:00:00Z'));
    assert.equal(renewed.toISOString(), '2026-11-05T15:59:59.999Z');
    assert.equal(renewed.getTime(), shiftDateByDays(expire, 30).getTime());
  });

  test('已過期再購視同新購', () => {
    const expired = new Date('2026-08-01T15:59:59.999Z');
    assert.equal(computeMemberExpireDate(expired, 30, new Date('2026-09-07T02:00:00Z')).toISOString(), '2026-10-06T15:59:59.999Z');
  });
});

describe('第九條第二款：續購之當期已用天數與新購一致（未滿 15 日半個月）', () => {
  const detailAt = (expireDate, now) =>
    computeMonthlyCardRefundDetail({ orderAmount: 1500, unusedDays: remainingExpireDays(expireDate, now), periodDays: 30 });

  test('新購 9/7：第 15 天（9/21）已用 14 日 → 半個月；第 16 天 → 一個月', () => {
    const expire = computeMemberExpireDate(null, 30, new Date('2026-09-07T02:00:00Z'));
    assert.equal(detailAt(expire, new Date('2026-09-21T02:00:00Z')).usedDays, 14);
    assert.equal(detailAt(expire, new Date('2026-09-21T02:00:00Z')).consumedPeriods, 0.5);
    assert.equal(detailAt(expire, new Date('2026-09-22T02:00:00Z')).consumedPeriods, 1);
  });

  test('效期中續購：續期 10/7 起，第 15 天（10/21）仍為半個月（修正前差一天會變一個月）', () => {
    const first = computeMemberExpireDate(null, 30, new Date('2026-09-07T02:00:00Z'));
    const renewed = computeMemberExpireDate(first, 30, new Date('2026-09-20T02:00:00Z'));
    const d15 = detailAt(renewed, new Date('2026-10-21T02:00:00Z'));
    assert.equal(d15.usedDays, 14);
    assert.equal(d15.consumedPeriods, 0.5);
    assert.equal(d15.amount, 750 - 500);
    assert.equal(detailAt(renewed, new Date('2026-10-22T02:00:00Z')).consumedPeriods, 1);
  });
});

describe('第十二條末款：傷病暫停滿 180 日終止不得收手續費（後端強制）', () => {
  const base = { orderAmount: 9000, unusedDays: 80, periodDays: 90, contractDays: 90 };

  test('exemptEligible → 手續費上限 0，自願條款亦不收；未滿 180 日照收 $500', () => {
    const waived = computeMonthlyCardRefundDetail({ ...base, medicalSuspension: { days: 180, exemptEligible: true } });
    assert.equal(waived.feeMax, 0);
    assert.equal(waived.fee, 0);
    assert.equal(waived.medicalFeeWaived, true);
    assert.equal(waived.amount, 4500);
    assert.match(waived.note, /第十二條/);

    const normal = computeMonthlyCardRefundDetail({ ...base, medicalSuspension: { days: 179, exemptEligible: false } });
    assert.equal(normal.fee, 500);
    assert.equal(normal.amount, 4000);
  });

  test('主管帶入手續費 > 0 → 400 FEE_EXCEEDS_CONTRACT_LIMIT', () => {
    assert.throws(
      () =>
        computeMonthlyCardRefundDetail({
          ...base,
          medicalSuspension: { days: 200, exemptEligible: true },
          feePolicy: { clause: 'VOLUNTARY', overrideFeeAmount: 500 },
        }),
      isError(400, 'FEE_EXCEEDS_CONTRACT_LIMIT'),
    );
  });

  test('月卡取消試算自動帶入會員傷病累計', async () => {
    const branch = await createBranch();
    const m = await createMember();
    const now = new Date();
    await prisma.member.update({
      where: { id: m.id },
      data: { plan: UNLIMITED_MEMBER_PLAN, expireDate: new Date(now.getTime() + 80 * DAY) },
    });
    const order = await prisma.order.create({
      data: {
        id: testId('TYK'),
        memberId: m.id,
        branchId: branch.id,
        amount: 9000,
        status: 'PAID',
        payMethod: 'CASH',
        itemDesc: '臨櫃購案 | 測試季卡 | UNLIMITED | 天數+90 | 方案費$9000',
        createdAt: new Date(now.getTime() - 10 * DAY),
      },
    });
    const before = await previewCancelUnlimitedOrder(order.id, { now });
    assert.equal(before.refundDetail.fee, 500);

    await prisma.memberLeave.create({
      data: {
        memberId: m.id,
        category: 'MEDICAL',
        status: 'ENDED',
        days: 180,
        frozenDays: 180,
        startAt: new Date('2025-01-01T16:00:00Z'),
        endAt: new Date('2025-06-30T16:00:00Z'),
      },
    });
    const after = await previewCancelUnlimitedOrder(order.id, { now });
    assert.equal(after.refundDetail.fee, 0);
    assert.equal(after.refundDetail.feeMax, 0);
    assert.equal(after.refundDetail.amount, before.refundDetail.amount + 500);
  });
});
