// 欠款黑名單：只擋新購課程／課程分期（不設 isAlert、不擋入場），櫃檯辨認附 paymentDebt
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createMember, createStaffUser, prisma, resetDb } from '../helpers/db.js';
import {
  addPaymentDebt,
  assertNoPaymentDebt,
  clearPaymentDebt,
  findActivePaymentDebt,
} from '../../lib/paymentDebt.js';
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

describe('結清欠款（防以立案追償繞過 PAID_AT_POS 收訖紀錄）', () => {
  const isError = (statusCode, code) => (e) => {
    assert.equal(e.code, code, e.message);
    assert.equal(e.statusCode, statusCode);
    return true;
  };
  const clearAudits = () => prisma.transactionAuditLog.findMany({ where: { action: 'PAYMENT_DEBT_CLEAR' } });

  async function debtor() {
    const member = await createMember();
    await addPaymentDebt(prisma, { memberId: member.id, reason: '課程分期解約欠繳 $6600', note: '電話追償', staffId: user.id });
    return member;
  }

  test('一般櫃檯 STAFF：403 DUTY_ROLE_REQUIRED_FOR_DEBT_CLEAR，欠款維持有效、不寫稽核', async () => {
    const member = await debtor();
    const staff = await createStaffUser('STAFF');
    await assert.rejects(
      clearPaymentDebt(prisma, { memberId: member.id, reason: 'POS SAL20261005001', user: staff }),
      isError(403, 'DUTY_ROLE_REQUIRED_FOR_DEBT_CLEAR'),
    );
    assert.ok(await findActivePaymentDebt(prisma, member.id));
    assert.equal((await clearAudits()).length, 0);
  });

  test('未填或少於 2 字之收款單號／清償說明：400 DEBT_CLEAR_REASON_REQUIRED', async () => {
    const member = await debtor();
    const duty = await createStaffUser('DUTY');
    for (const reason of [undefined, '', '   ', 'A']) {
      await assert.rejects(
        clearPaymentDebt(prisma, { memberId: member.id, reason, user: duty }),
        isError(400, 'DEBT_CLEAR_REASON_REQUIRED'),
      );
    }
    assert.ok(await findActivePaymentDebt(prisma, member.id));
    assert.equal((await clearAudits()).length, 0);
  });

  test('DUTY 帶收款單號：解除黑名單、同交易寫 PAYMENT_DEBT_CLEAR（經辦、原欠款快照），不動 isAlert', async () => {
    const member = await debtor();
    const duty = await createStaffUser('DUTY');
    const row = await clearPaymentDebt(prisma, {
      memberId: member.id,
      reason: '  POS 收款 SAL20261005001  ',
      user: duty,
      clientIp: '10.0.0.8',
    });
    assert.equal(row.isActive, false);
    assert.ok(row.clearedAt);
    assert.equal(await findActivePaymentDebt(prisma, member.id), null);
    await assertNoPaymentDebt(prisma, member.id);
    assert.equal((await prisma.member.findUnique({ where: { id: member.id } })).isAlert, false);

    const [audit] = await clearAudits();
    assert.equal(audit.staffId, duty.id);
    assert.equal(audit.staffRole, 'DUTY');
    assert.equal(audit.refType, 'PAYMENT_BLACKLIST');
    assert.equal(audit.refId, String(member.id));
    assert.equal(audit.reason, 'POS 收款 SAL20261005001');
    assert.equal(audit.clientIp, '10.0.0.8');
    assert.equal(audit.before.reason, '課程分期解約欠繳 $6600');
    assert.equal(audit.before.note, '電話追償');
    assert.equal(audit.before.addedByStaffId, user.id);
    assert.equal(audit.after.isActive, false);
  });

  test('無有效欠款 409 PAYMENT_DEBT_NOT_FOUND；查無會員 404；皆不寫稽核', async () => {
    const duty = await createStaffUser('DUTY');
    const clean = await createMember();
    await assert.rejects(
      clearPaymentDebt(prisma, { memberId: clean.id, reason: '重複結清', user: duty }),
      isError(409, 'PAYMENT_DEBT_NOT_FOUND'),
    );
    const member = await debtor();
    await clearPaymentDebt(prisma, { memberId: member.id, reason: 'POS 收款 A', user: duty });
    await assert.rejects(
      clearPaymentDebt(prisma, { memberId: member.id, reason: 'POS 收款 A', user: duty }),
      isError(409, 'PAYMENT_DEBT_NOT_FOUND'),
    );
    await assert.rejects(
      clearPaymentDebt(prisma, { memberId: 99999999, reason: 'POS 收款 B', user: duty }),
      isError(404, 'MEMBER_NOT_FOUND'),
    );
    assert.equal((await clearAudits()).length, 1);
  });
});
