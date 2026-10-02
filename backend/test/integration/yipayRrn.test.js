// 乙禾 RRN 唯一：收款暫存冪等／跨單拒絕、DB partial unique、退刷確認重複 RRN
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createBranch, createStaffUser, prisma, resetDb, testId } from '../helpers/db.js';
import { stageYipayCapture } from '../../lib/yipayCapture.js';
import { confirmYipayRefund } from '../../lib/refundService.js';

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};
const isUniqueViolation = (e) => {
  assert.equal(e.code, 'P2002', e.message);
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

describe('收款暫存 stageYipayCapture', () => {
  const capture = (over = {}) => ({
    targetType: 'ORDER',
    targetId: 'TYKTESTRRN1',
    amount: 1200,
    rrn: '123456789012',
    authCode: 'A1B2C3',
    cardLast4: '4242',
    ...over,
  });

  test('同 RRN 同單同額重送回傳同一筆（冪等）', async () => {
    const a = await stageYipayCapture(capture());
    const b = await stageYipayCapture(capture());
    assert.equal(a.id, b.id);
    assert.equal(await prisma.yipayTerminalCapture.count(), 1);
  });

  test('並發同 RRN 只建立一筆', async () => {
    const rows = await Promise.all(Array.from({ length: 6 }, () => stageYipayCapture(capture())));
    assert.equal(new Set(rows.map((r) => r.id)).size, 1);
    assert.equal(await prisma.yipayTerminalCapture.count(), 1);
  });

  test('同 RRN 用於他單或金額不符 → 409 YIPAY_RRN_DUPLICATE', async () => {
    await stageYipayCapture(capture());
    await assert.rejects(stageYipayCapture(capture({ targetId: 'TYKTESTRRN2' })), isError(409, 'YIPAY_RRN_DUPLICATE'));
    await assert.rejects(stageYipayCapture(capture({ amount: 1199 })), isError(409, 'YIPAY_RRN_DUPLICATE'));
    assert.equal(await prisma.yipayTerminalCapture.count(), 1);
  });

  test('DB 層 uniq_yipay_capture_rrn：直接寫入重複 RRN 被拒；已作廢者不佔用', async () => {
    const base = { targetType: 'ORDER', amount: 100, rrn: 'RRNDB0001' };
    await prisma.yipayTerminalCapture.create({ data: { ...base, id: testId('YCAP'), targetId: 'X1', status: 'VOIDED' } });
    await prisma.yipayTerminalCapture.create({ data: { ...base, id: testId('YCAP'), targetId: 'X2', status: 'PENDING_CONFIRM' } });
    await assert.rejects(
      prisma.yipayTerminalCapture.create({ data: { ...base, id: testId('YCAP'), targetId: 'X3', status: 'CONFIRMED' } }),
      isUniqueViolation,
    );
  });
});

describe('退刷 RefundPayment', () => {
  async function createRefundWithYipayLeg(status = 'AWAITING_TERMINAL', extra = {}) {
    const refund = await prisma.refundRequest.create({
      data: {
        id: testId('RFD'),
        kind: 'ORDER_REFUND',
        refType: 'ORDER',
        refId: testId('TYK'),
        branchId: branch.id,
        scope: 'UNUSED',
        grossAmount: 800,
        payoutAmount: 800,
        reason: '測試退刷',
        staffId: user.id,
        status: status === 'REFUNDED' ? 'INVOICE_PENDING' : 'AWAITING_TERMINAL',
      },
    });
    const leg = await prisma.refundPayment.create({
      data: { id: testId('RFP'), refundId: refund.id, method: 'YIPAY', amount: 800, status, ...extra },
    });
    return { refund, leg };
  }

  test('DB 層 uniq_yipay_refund_rrn：兩筆已退刷不得共用 RRN', async () => {
    const done = { rrn: 'RRNREF001', authCode: 'ZX9Y8W', cardLast4: '1111' };
    await createRefundWithYipayLeg('REFUNDED', done);
    await assert.rejects(createRefundWithYipayLeg('REFUNDED', done), isUniqueViolation);
  });

  test('confirmYipayRefund：RRN 已用於其他退款 → 409，退款腿維持待端末', async () => {
    await createRefundWithYipayLeg('REFUNDED', { rrn: 'RRNREF002', authCode: 'ZX9Y8W', cardLast4: '1111' });
    const { refund, leg } = await createRefundWithYipayLeg();
    await assert.rejects(
      confirmYipayRefund(user, refund.id, leg.id, { rrn: 'RRNREF002', authCode: 'ab12cd', cardLast4: '2222' }),
      isError(409, 'YIPAY_RRN_DUPLICATE'),
    );
    const fresh = await prisma.refundPayment.findUnique({ where: { id: leg.id } });
    assert.equal(fresh.status, 'AWAITING_TERMINAL');
    assert.equal(fresh.rrn, null);
  });

  test('confirmYipayRefund：憑證格式錯誤 → 400', async () => {
    const { refund, leg } = await createRefundWithYipayLeg();
    await assert.rejects(
      confirmYipayRefund(user, refund.id, leg.id, { rrn: '12', authCode: 'AB12CD', cardLast4: '2222' }),
      isError(400, 'YIPAY_RRN_INVALID'),
    );
    await assert.rejects(
      confirmYipayRefund(user, refund.id, leg.id, { rrn: 'RRN123456', authCode: 'AB12CD', cardLast4: '22' }),
      isError(400, 'YIPAY_CARD_INVALID'),
    );
  });
});
