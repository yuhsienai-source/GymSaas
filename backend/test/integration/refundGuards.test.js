// 退費引擎防線：MEMBER_CHECKED_IN、報價鎖（QUOTE_STALE／QUOTE_EXPIRED）、WALLET_INSUFFICIENT_FOR_VOID
// 全部於外部金流呼叫前即被拒；每案前清空測試庫，並驗證未建立退費單、錢包未變動
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePrisma,
  createBranch,
  createMember,
  createStaffUser,
  createTimedTopupOrder,
  idempotencyKey,
  prisma,
  resetDb,
  walletOf,
} from '../helpers/db.js';
import { executeSubOrderRefund, executeTopupCancel, previewSubOrderRefund, previewTopupCancel } from '../../lib/refundService.js';
import { signToken } from '../../lib/signedToken.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from '../../lib/walletMutation.js';

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

async function assertUntouched(memberId, orderId, wallet) {
  assert.equal(await prisma.refundRequest.count({ where: { refId: orderId } }), 0, '不得建立退費單');
  assert.deepEqual(await walletOf(memberId), wallet, '錢包不得變動');
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, refundedAmount: true } });
  assert.deepEqual(order, { status: 'PAID', refundedAmount: 0 });
}

describe('MEMBER_CHECKED_IN：計時進場未出場前禁止回收儲值', () => {
  async function setup() {
    const member = await createMember({ cash: 1000, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    return { member, order };
  }

  test('計時進場中：原單取消與未使用退費試算皆 409', async () => {
    const { member, order } = await setup();
    await prisma.checkInLog.create({ data: { memberId: member.id, branchId: branch.id, billingMode: '計時扣款' } });
    await assert.rejects(previewTopupCancel(user, order.id), isError(409, 'MEMBER_CHECKED_IN'));
    await assert.rejects(previewSubOrderRefund(user, order.id, { scope: 'UNUSED' }), isError(409, 'MEMBER_CHECKED_IN'));
  });

  test('月費通行進場、無進場、已出場：可試算', async () => {
    const { member, order } = await setup();
    const plan = await previewTopupCancel(user, order.id);
    assert.equal(plan.kind, 'TOPUP_VOID');
    assert.equal(plan.payoutAmount, 1000);

    const pass = await prisma.checkInLog.create({ data: { memberId: member.id, billingMode: '月費通行' } });
    assert.equal((await previewTopupCancel(user, order.id)).kind, 'TOPUP_VOID');

    await prisma.checkInLog.update({ where: { id: pass.id }, data: { checkOutAt: new Date() } });
    await prisma.checkInLog.create({ data: { memberId: member.id, billingMode: '計時扣款', checkOutAt: new Date() } });
    assert.equal((await previewTopupCancel(user, order.id)).kind, 'TOPUP_VOID');
  });

  test('試算後才進場：送出時重驗仍擋下，不動帳', async () => {
    const { member, order } = await setup();
    const { quoteToken } = await previewTopupCancel(user, order.id);
    await prisma.checkInLog.create({ data: { memberId: member.id, billingMode: '計時扣款' } });
    await assert.rejects(
      executeTopupCancel(user, order.id, { reason: '測試取消', quoteToken, idempotencyKey: idempotencyKey() }),
      isError(409, 'MEMBER_CHECKED_IN'),
    );
    await assertUntouched(member.id, order.id, { cashWallet: 1000, bonusWallet: 100 });
  });
});

describe('報價鎖 quoteToken', () => {
  test('試算綁子單／作法／經辦，摘要為 SHA-256，效期 10 分鐘', async () => {
    const member = await createMember({ cash: 1000, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const t0 = Date.now();
    const plan = await previewTopupCancel(user, order.id);
    const payload = JSON.parse(Buffer.from(plan.quoteToken.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(payload.ref, order.id);
    assert.equal(payload.m, 'TOPUP_VOID');
    assert.equal(payload.sid, user.id);
    assert.match(payload.dg, /^[0-9a-f]{64}$/);
    assert.ok(payload.exp - t0 >= 9.9 * 60_000 && payload.exp - t0 <= 10 * 60_000 + 5_000);

    const again = await previewTopupCancel(user, order.id);
    const dg2 = JSON.parse(Buffer.from(again.quoteToken.split('.')[0], 'base64url').toString('utf8')).dg;
    assert.equal(dg2, payload.dg, '相同狀態重算摘要一致');
  });

  test('QUOTE_STALE：試算後會員餘額變動 → 409，不動帳', async () => {
    // 已用本金 400：未使用退費金額取決於錢包餘額
    const member = await createMember({ cash: 600, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const plan = await previewSubOrderRefund(user, order.id, { scope: 'UNUSED' });
    assert.equal(plan.payoutAmount, 480);

    await prisma.$transaction((tx) =>
      mutateMemberWallet(tx, {
        memberId: member.id,
        txType: WALLET_TX.WALLET_PAY,
        mode: WALLET_MODE.CASH_ONLY_DEDUCT,
        amount: 100,
        reason: '測試：試算後零錢包消費',
      }),
    );

    await assert.rejects(
      executeSubOrderRefund(user, order.id, {
        scope: 'UNUSED',
        reason: '測試退費',
        quoteToken: plan.quoteToken,
        idempotencyKey: idempotencyKey(),
      }),
      isError(409, 'QUOTE_STALE'),
    );
    await assertUntouched(member.id, order.id, { cashWallet: 500, bonusWallet: 100 });
  });

  test('QUOTE_EXPIRED：逾時憑證 → 409，不動帳', async () => {
    const member = await createMember({ cash: 1000, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const plan = await previewTopupCancel(user, order.id);
    const payload = JSON.parse(Buffer.from(plan.quoteToken.split('.')[0], 'base64url').toString('utf8'));
    const expired = signToken('refund-quote', { ...payload, exp: Date.now() - 1000 });
    await assert.rejects(
      executeTopupCancel(user, order.id, { reason: '測試取消', quoteToken: expired, idempotencyKey: idempotencyKey() }),
      isError(409, 'QUOTE_EXPIRED'),
    );
    await assertUntouched(member.id, order.id, { cashWallet: 1000, bonusWallet: 100 });
  });

  test('缺少、偽造、他人或他單之憑證 → 400', async () => {
    const member = await createMember({ cash: 1000, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const other = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const otherUser = await createStaffUser('ADMIN');
    const run = (quoteToken) =>
      executeTopupCancel(user, order.id, { reason: '測試取消', quoteToken, idempotencyKey: idempotencyKey() });

    await assert.rejects(run(''), isError(400, 'QUOTE_TOKEN_REQUIRED'));
    const { quoteToken } = await previewTopupCancel(user, order.id);
    await assert.rejects(run(`${quoteToken.slice(0, -2)}xx`), isError(400, 'QUOTE_TOKEN_INVALID'));
    await assert.rejects(run((await previewTopupCancel(otherUser, order.id)).quoteToken), isError(400, 'QUOTE_TOKEN_INVALID'));
    await assert.rejects(run((await previewTopupCancel(user, other.id)).quoteToken), isError(400, 'QUOTE_TOKEN_INVALID'));
    await assert.rejects(
      executeSubOrderRefund(user, order.id, { scope: 'UNUSED', reason: '測試', quoteToken, idempotencyKey: idempotencyKey() }),
      isError(400, 'QUOTE_TOKEN_INVALID'),
      '原單取消之憑證不可用於子單退費',
    );
    await assertUntouched(member.id, order.id, { cashWallet: 1000, bonusWallet: 100 });
  });
});

describe('WALLET_INSUFFICIENT_FOR_VOID', () => {
  test('本金或運動金已動用：原單取消試算 409', async () => {
    const member = await createMember({ cash: 999, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    await assert.rejects(previewTopupCancel(user, order.id), isError(409, 'WALLET_INSUFFICIENT_FOR_VOID'));

    const member2 = await createMember({ cash: 1000, bonus: 50 });
    const order2 = await createTimedTopupOrder({ memberId: member2.id, branchId: branch.id });
    await assert.rejects(previewTopupCancel(user, order2.id), isError(409, 'WALLET_INSUFFICIENT_FOR_VOID'));
  });

  test('試算後動用錢包：送出時 409（報價或錢包檢核），不動帳', async () => {
    const member = await createMember({ cash: 1000, bonus: 100 });
    const order = await createTimedTopupOrder({ memberId: member.id, branchId: branch.id });
    const { quoteToken } = await previewTopupCancel(user, order.id);
    await prisma.$transaction((tx) =>
      mutateMemberWallet(tx, {
        memberId: member.id,
        txType: WALLET_TX.WALLET_PAY,
        mode: WALLET_MODE.CASH_ONLY_DEDUCT,
        amount: 1,
        reason: '測試：試算後零錢包消費',
      }),
    );
    await assert.rejects(
      executeTopupCancel(user, order.id, { reason: '測試取消', quoteToken, idempotencyKey: idempotencyKey() }),
      isError(409, 'WALLET_INSUFFICIENT_FOR_VOID'),
    );
    await assertUntouched(member.id, order.id, { cashWallet: 999, bonusWallet: 100 });
  });

  test('mutateMemberWallet EXACT_BUCKETS_DEDUCT 不足 → 409，交易回滾且不寫流水', async () => {
    const member = await createMember({ cash: 500, bonus: 100 });
    const ledgerBefore = await prisma.walletLedger.count({ where: { memberId: member.id } });
    await assert.rejects(
      prisma.$transaction((tx) =>
        mutateMemberWallet(tx, {
          memberId: member.id,
          txType: WALLET_TX.TOPUP_VOID,
          mode: WALLET_MODE.EXACT_BUCKETS_DEDUCT,
          cashDeduct: 500,
          bonusDeduct: 100.01,
          reason: '測試：扣回超過運動金',
        }),
      ),
      isError(409, 'WALLET_INSUFFICIENT_FOR_VOID'),
    );
    assert.deepEqual(await walletOf(member.id), { cashWallet: 500, bonusWallet: 100 });
    assert.equal(await prisma.walletLedger.count({ where: { memberId: member.id } }), ledgerBefore);
  });
});
