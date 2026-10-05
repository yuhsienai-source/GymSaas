// 欠款黑名單：只擋新購課程／課程分期（不設 isAlert、不擋入場），櫃檯辨認附 paymentDebt
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createMember, createStaffUser, prisma, resetDb } from '../helpers/db.js';
import { addPaymentDebt, assertNoPaymentDebt, findActivePaymentDebt } from '../../lib/paymentDebt.js';
import { resolveCheckoutCart } from '../../lib/checkout.js';
import { lookupMemberByPhone } from '../../lib/memberIdentify.js';

let user;

beforeEach(async () => {
  await resetDb();
  user = await createStaffUser('ADMIN');
});

after(closePrisma);

const courseCart = (memberId) => ({ memberId, trainerId: 1, courseItems: [{ coursePlanId: 1, qty: 1 }] });

describe('欠款黑名單', () => {
  test('有效欠款：POS 合併結帳含課程 409 PAYMENT_DEBT_OUTSTANDING；解除後不再攔截', async () => {
    const member = await createMember();
    await prisma.paymentBlacklist.create({ data: { memberId: member.id, reason: '課程分期解約欠繳 $6600', isActive: true } });

    await assert.rejects(resolveCheckoutCart(courseCart(member.id), { user }), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'PAYMENT_DEBT_OUTSTANDING');
      assert.ok(e.message.includes('$6600'));
      return true;
    });
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);

    await prisma.paymentBlacklist.update({ where: { memberId: member.id }, data: { isActive: false, clearedAt: new Date() } });
    assert.equal(await findActivePaymentDebt(prisma, member.id), null);
    await assertNoPaymentDebt(prisma, member.id);
  });

  test('登錄欠款：不設 isAlert；有效紀錄累加事由、保留備註；解除後重新登錄不帶舊事由', async () => {
    const member = await createMember();
    const first = await addPaymentDebt(prisma, { memberId: member.id, reason: '手動欠款 A', note: '電話追償', staffId: user.id });
    assert.deepEqual(first.before, { blacklistActive: false, blacklistReason: null });
    const second = await addPaymentDebt(prisma, { memberId: member.id, reason: '手動欠款 B' });
    assert.equal(second.row.reason, '手動欠款 A；手動欠款 B');
    assert.equal(second.row.note, '電話追償');
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);

    await prisma.paymentBlacklist.update({ where: { memberId: member.id }, data: { isActive: false, clearedAt: new Date() } });
    const third = await addPaymentDebt(prisma, { memberId: member.id, reason: '新欠款 C' });
    assert.equal(third.row.reason, '新欠款 C');
    assert.equal(third.row.note, null);
    assert.equal(third.row.clearedAt, null);
  });

  test('櫃檯電話辨認附 paymentDebt（無欠款為 null）', async () => {
    const debtor = await createMember();
    const clean = await createMember();
    await prisma.paymentBlacklist.create({ data: { memberId: debtor.id, reason: '欠款', note: '待追償', isActive: true } });

    const a = await lookupMemberByPhone(debtor.phone);
    assert.equal(a.data.member.paymentDebt.reason, '欠款');
    assert.equal(a.data.member.paymentDebt.note, '待追償');
    const b = await lookupMemberByPhone(clean.phone);
    assert.equal(b.data.member.paymentDebt, null);
  });
});
