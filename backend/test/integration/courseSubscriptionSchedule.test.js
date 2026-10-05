// 課程分期訂閱（持真實 CreditHash、由本機排程續扣）之扣款日：
// 起算點＝首期訂單建立時間，下期扣款日依 1／16 日扣款表，不以訂閱建立／Notify 時間推算
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createBranch, createMember, prisma, resetDb, testId } from '../helpers/db.js';
import { createSubscriptionFromPaidOrder, resolveCourseOriginAt } from '../../lib/cardSubscription.js';

const tw = (ymd, hm = '10:00') => new Date(`${ymd}T${hm}:00+08:00`);

let branch;

beforeEach(async () => {
  await resetDb();
  branch = await createBranch();
});

after(closePrisma);

async function setup({ originAt }) {
  const member = await createMember();
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
      payMethod: 'YIPAY',
      cardMode: 'RECURRING',
      periodType: 'M',
      periodTimes: 4,
      recurringAmount: 5500,
      itemDesc: `課程定期定額首期 | 客製化教練課 ×1 | 課程方案#${plan.id} | 4期`,
      createdAt: originAt,
    },
  });
  return { member, plan, origin };
}

describe('課程分期訂閱扣款日', () => {
  test('首期 01-08、Notify 晚到 01-12 才建訂閱：第 2 期仍為 02-01（台灣日 00:00）', async () => {
    const { plan, origin } = await setup({ originAt: tw('2022-01-08') });
    const sub = await createSubscriptionFromPaidOrder(origin, {
      coursePlan: plan,
      creditHash: 'HASH-TEST',
      now: tw('2022-01-12'),
    });
    assert.equal(sub.nextChargeAt.toISOString(), tw('2022-02-01', '00:00').toISOString());
  });

  test('呼叫端以 select 取單（缺 createdAt）：改查首期訂單，不以現在起算', async () => {
    const { plan, origin } = await setup({ originAt: tw('2022-01-17') });
    const sub = await createSubscriptionFromPaidOrder(
      { id: origin.id, memberId: origin.memberId, cardMode: 'RECURRING', periodType: 'M', periodTimes: 4, amount: 5500 },
      { coursePlan: plan, creditHash: 'HASH-TEST', now: tw('2022-01-25') },
    );
    assert.equal(sub.nextChargeAt.toISOString(), tw('2022-02-16', '00:00').toISOString());
  });

  test('起算點優先取首期訂單，查無才用訂閱建立時間；非課程分期回 null', async () => {
    const { member, plan, origin } = await setup({ originAt: tw('2022-01-08') });
    const sub = await createSubscriptionFromPaidOrder(origin, {
      coursePlan: plan,
      creditHash: 'HASH-TEST',
      now: tw('2022-01-12'),
    });
    assert.equal((await resolveCourseOriginAt(sub)).toISOString(), tw('2022-01-08').toISOString());

    const orphan = { ...sub, originOrderId: 'NOT-EXIST', createdAt: tw('2022-01-12') };
    assert.equal((await resolveCourseOriginAt(orphan)).toISOString(), tw('2022-01-12').toISOString());

    assert.equal(await resolveCourseOriginAt({ coursePlanId: null, memberId: member.id }), null);
  });
});
