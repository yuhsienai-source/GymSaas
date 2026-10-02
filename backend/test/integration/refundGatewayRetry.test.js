// 失敗退費單重試：已完成的金流腿不得再打、作廢先查遠端、第二個請求不得同時進入
import '../helpers/env.js';
import pg from 'pg';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createBranch, createMember, createStaffUser, prisma, resetDb, testId } from '../helpers/db.js';
import { retryGateway } from '../../lib/refundService.js';
import { decryptPostData } from '../../lib/ezpay.js';
import { invoicePeriodKey } from '../../lib/einvoiceRules.js';

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

const ENTITY_CODE = 'TST';
process.env[`EZPAY_${ENTITY_CODE}_HASH_KEY`] = '12345678901234567890123456789012';
process.env[`EZPAY_${ENTITY_CODE}_HASH_IV`] = '1234567890123456';
process.env[`EZPAY_${ENTITY_CODE}_INVOICE_URL`] = 'https://cinv.ezpay.com.tw/Api/invoice_issue';

const keys = {
  entityCode: ENTITY_CODE,
  merchantId: '3622183',
  hashKey: process.env[`EZPAY_${ENTITY_CODE}_HASH_KEY`],
  hashIv: process.env[`EZPAY_${ENTITY_CODE}_HASH_IV`],
  invoiceUrl: process.env[`EZPAY_${ENTITY_CODE}_INVOICE_URL`],
};

const realFetch = globalThis.fetch;
let calls;

function mockEzpay(handlers, { capture } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const api = String(url).split('/').pop();
    calls.push(api);
    if (capture && api === 'invoice_search') {
      const hex = new URLSearchParams(String(init?.body || '')).get('PostData_');
      capture.push(decryptPostData(keys, hex));
    }
    const h = handlers[api];
    if (!h) throw new Error(`未預期的外部呼叫 ${api}`);
    const out = await h();
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200 });
  };
}

let user;
let branch;
let entity;

beforeEach(async () => {
  await resetDb();
  user = await createStaffUser('ADMIN');
  branch = await createBranch();
  entity = await prisma.legalEntity.create({
    data: { code: ENTITY_CODE, name: '測試營業人', ubn: '04595257', ezpayMerchantId: '3622183' },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(closePrisma);

async function seedVoidRefund({ paymentStatus = 'REFUNDED', providerRef = 'LP-REF-1', randomNum = null, status = 'INVOICE_FAILED' } = {}) {
  const member = await createMember();
  const order = await prisma.order.create({
    data: {
      id: testId('TYK'),
      memberId: member.id,
      branchId: branch.id,
      amount: 2100,
      status: 'REFUNDED',
      payMethod: 'LINEPAY',
      itemDesc: '私教購案 測試',
    },
  });
  const einvoice = await prisma.eInvoice.create({
    data: {
      id: testId('EIV'),
      legalEntityId: entity.id,
      branchId: branch.id,
      refType: 'ORDER',
      refId: order.id,
      merchantOrderNo: order.id,
      category: 'B2C',
      salesAmount: 2000,
      taxAmount: 100,
      totalAmount: 2100,
      itemDesc: '私教課程',
      status: 'ISSUED',
      invoiceNumber: `AB${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      randomNum,
      issuedAt: new Date(),
      periodKey: invoicePeriodKey(new Date()),
      items: { create: [{ lineNo: 1, name: '私教課程', qty: 1, unit: '式', unitPrice: 2100, amount: 2100 }] },
    },
  });
  const refund = await prisma.refundRequest.create({
    data: {
      id: testId('RFD'),
      kind: 'ORDER_REFUND',
      refType: 'ORDER',
      refId: order.id,
      branchId: branch.id,
      memberId: member.id,
      scope: 'FULL',
      grossAmount: 2100,
      payoutAmount: 2100,
      fullRefund: true,
      invoiceAction: 'VOID',
      reason: '測試退費',
      staffId: user.id,
      status,
      payments: {
        create: {
          id: testId('RFP'),
          method: 'LINEPAY',
          amount: 2100,
          status: paymentStatus,
          originalRef: 'LP-ORIG-1',
          providerRef,
          refundedAt: paymentStatus === 'REFUNDED' ? new Date() : null,
        },
      },
    },
  });
  return { order, einvoice, refund };
}

describe('retry-gateway 檢查點', () => {
  test('金流已退成時只補作廢，不呼叫 LINE Pay', async () => {
    const { refund, einvoice } = await seedVoidRefund();
    mockEzpay({
      invoice_invalid: () => ({ Status: 'SUCCESS', Message: 'ok', Result: JSON.stringify({ InvoiceNumber: einvoice.invoiceNumber }) }),
    });
    const out = await retryGateway(user, refund.id);
    assert.equal(out.reconciledAction, 'RETRIED_AND_COMPLETED');
    assert.equal(out.refund.status, 'COMPLETED');
    assert.equal(out.stepSummary.paymentGatewayStep, 'SKIPPED_ALREADY_COMPLETED');
    assert.equal(out.stepSummary.ezPayInvoiceStep, 'EXECUTED_EZPAY_VOID');
    assert.deepEqual(calls, ['invoice_invalid']);
    const leg = await prisma.refundPayment.findFirst({ where: { refundId: refund.id } });
    assert.equal(leg.status, 'REFUNDED');
    assert.equal(leg.providerRef, 'LP-REF-1');
  });

  test('有退款序號但腿被標成 FAILED：修成已退成，不重打金流', async () => {
    const { refund, einvoice } = await seedVoidRefund({ paymentStatus: 'FAILED', providerRef: 'LP-REF-9' });
    mockEzpay({
      invoice_invalid: () => ({ Status: 'SUCCESS', Message: 'ok', Result: JSON.stringify({ InvoiceNumber: einvoice.invoiceNumber }) }),
    });
    const out = await retryGateway(user, refund.id);
    assert.equal(out.stepSummary.paymentGatewayStep, 'HEALED_FROM_EXISTING_TRADE_NO');
    assert.deepEqual(calls, ['invoice_invalid']);
    assert.equal((await prisma.refundPayment.findFirst({ where: { refundId: refund.id } })).status, 'REFUNDED');
  });

  test('有隨機碼時作廢前以 SearchType 0 查詢，遠端已作廢則不再作廢', async () => {
    const { refund, einvoice } = await seedVoidRefund({ randomNum: '4253', status: 'INVOICE_FAILED' });
    await prisma.refundRequest.update({
      where: { id: refund.id },
      data: {
        invoiceResults: [{ einvoiceId: einvoice.id, invoiceNumber: einvoice.invoiceNumber, action: 'VOID', op: 'VOID', done: false, ambiguous: true, error: 'timeout' }],
        lastError: '[待確認]timeout',
      },
    });
    const captured = [];
    mockEzpay({
      invoice_search: () => ({
        Status: 'SUCCESS',
        Message: 'ok',
        Result: JSON.stringify({
          InvoiceNumber: einvoice.invoiceNumber,
          RandomNum: '4253',
          MerchantOrderNo: einvoice.merchantOrderNo,
          TotalAmt: einvoice.totalAmount,
          InvoiceStatus: '2',
          InvoiceTransNo: 'T99001',
        }),
      }),
    }, { capture: captured });
    const out = await retryGateway(user, refund.id);
    assert.equal(out.refund.status, 'COMPLETED');
    assert.equal(out.stepSummary.ezPayInvoiceStep, 'HEALED_VOID_FROM_EZPAY_REMOTE_QUERY');
    assert.deepEqual(calls, ['invoice_search']);
    assert.equal(captured[0].SearchType, '0');
    assert.equal(captured[0].InvoiceNumber, einvoice.invoiceNumber);
    assert.equal(captured[0].RandomNum, '4253');
    assert.equal('MerchantOrderNo' in captured[0], false);
    assert.equal((await prisma.eInvoice.findUnique({ where: { id: einvoice.id } })).status, 'VOIDED');
  });

  test('另一條連線持有列鎖時，重試立刻 409，狀態不變', async () => {
    const { refund } = await seedVoidRefund();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM "RefundRequest" WHERE id = $1 FOR UPDATE', [refund.id]);
      await assert.rejects(retryGateway(user, refund.id), isError(409, 'REFUND_RETRY_IN_PROGRESS'));
      assert.equal((await prisma.refundRequest.findUnique({ where: { id: refund.id } })).status, 'INVOICE_FAILED');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('無退款序號且結果不明：只送 checked 不得重打；confirmGatewayNotRefunded 才寫稽核並放行', async () => {
    const { refund } = await seedVoidRefund({ paymentStatus: 'FAILED', providerRef: null, status: 'PAYMENT_FAILED' });
    await prisma.refundPayment.updateMany({
      where: { refundId: refund.id },
      data: { providerRef: null, lastError: '[待確認]timeout' },
    });
    calls = [];
    globalThis.fetch = async () => {
      calls.push('linepay');
      return new Response(JSON.stringify({ returnCode: '1198', returnMessage: '未退款' }), { status: 200 });
    };
    await assert.rejects(retryGateway(user, refund.id, { checked: true }), isError(409, 'RETRY_NEEDS_CHECK'));
    assert.deepEqual(calls, []);
    assert.equal((await prisma.refundRequest.findUnique({ where: { id: refund.id } })).status, 'PAYMENT_FAILED');
    assert.equal(await prisma.transactionAuditLog.count({ where: { refundId: refund.id, action: 'REFUND_GATEWAY_CONFIRM' } }), 0);

    const out = await retryGateway(user, refund.id, { confirmGatewayNotRefunded: true });
    assert.deepEqual(calls, ['linepay']);
    assert.equal(out.refund.status, 'PAYMENT_FAILED');
    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_GATEWAY_CONFIRM' } });
    assert.equal(audit.after.confirmGatewayNotRefunded, true);
    assert.equal(audit.after.confirmedByStaffId, user.id);
    assert.ok(audit.after.confirmedAt);
    assert.equal(audit.staffId, user.id);
  });

  test('一般櫃檯不可重試', async () => {
    const { refund } = await seedVoidRefund();
    const staff = await createStaffUser('STAFF');
    await assert.rejects(retryGateway(staff, refund.id), isError(403, 'DUTY_ROLE_REQUIRED_FOR_RETRY'));
  });

  test('已完成的退費單再重試，不呼叫外部', async () => {
    const { refund } = await seedVoidRefund({ status: 'COMPLETED' });
    mockEzpay({});
    const out = await retryGateway(user, refund.id);
    assert.equal(out.reconciledAction, 'ALREADY_COMPLETED');
    assert.deepEqual(calls, []);
  });
});
