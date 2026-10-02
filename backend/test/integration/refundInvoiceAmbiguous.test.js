// ezPay 作廢／折讓結果不明：保留預占、禁止中止、人工核對（補登折讓號／確認未開立）、作廢重試先查遠端
import '../helpers/env.js';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createBranch, createMember, createStaffUser, prisma, resetDb, testId } from '../helpers/db.js';
import { abortRefund, resolveInvoiceOutcome, retryRefund } from '../../lib/refundService.js';
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

const realFetch = globalThis.fetch;
let calls;

/** handlers：{ allowance_issue: () => body, invoice_invalid: …, invoice_search: … }；未列出者視為測試錯誤 */
function mockEzpay(handlers) {
  calls = [];
  globalThis.fetch = async (url) => {
    const api = String(url).split('/').pop();
    calls.push(api);
    const h = handlers[api];
    if (!h) throw new Error(`未預期的 ezPay 呼叫 ${api}`);
    const out = h();
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), { status: 200 });
  };
}

const networkDown = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });

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

/** 已付款私教訂單＋已開立發票＋停在發票階段之退費單（不經金流） */
async function createInvoicePhaseRefund({ action = 'ALLOWANCE', category = 'B2C', gross = 1050, total = 2100 } = {}) {
  const member = await createMember();
  const order = await prisma.order.create({
    data: { id: testId('TYK'), memberId: member.id, branchId: branch.id, amount: total, status: 'REFUNDED', payMethod: 'CASH', itemDesc: '私教購案 測試' },
  });
  const salesAmount = Math.round(total / 1.05);
  const einvoice = await prisma.eInvoice.create({
    data: {
      id: testId('EIV'),
      legalEntityId: entity.id,
      branchId: branch.id,
      refType: 'ORDER',
      refId: order.id,
      merchantOrderNo: order.id,
      category,
      buyerUbn: category === 'B2B' ? '12345678' : null,
      buyerName: category === 'B2B' ? '測試股份有限公司' : null,
      salesAmount,
      taxAmount: total - salesAmount,
      totalAmount: total,
      itemDesc: '私教課程',
      status: 'ISSUED',
      invoiceNumber: `AB${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      issuedAt: new Date(),
      periodKey: invoicePeriodKey(new Date()),
      items: { create: [{ lineNo: 1, name: '私教課程', qty: 1, unit: '式', unitPrice: total, amount: total }] },
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
      scope: action === 'VOID' ? 'FULL' : 'UNUSED',
      grossAmount: action === 'VOID' ? total : gross,
      payoutAmount: action === 'VOID' ? total : gross,
      fullRefund: action === 'VOID',
      invoiceAction: action,
      reason: '測試退費',
      staffId: user.id,
      status: 'INVOICE_PENDING',
    },
  });
  return { order, einvoice, refund };
}

const allowanceTotalOf = async (id) => (await prisma.eInvoice.findUnique({ where: { id }, select: { allowanceTotal: true } })).allowanceTotal;

/** 第一次折讓：ezPay 回 SUCCESS 但 Result 無法解析 → 停在 INVOICE_FAILED、預占保留 */
async function failAmbiguously(refund) {
  mockEzpay({ allowance_issue: () => ({ Status: 'SUCCESS', Message: 'ok', Result: '{bad' }) });
  const out = await retryRefund(user, refund.id);
  assert.equal(out.status, 'INVOICE_FAILED');
  return out;
}

describe('折讓結果不明：保留預占', () => {
  test('SUCCESS 但 Result 無法解析 → 預占保留、回傳待核對資訊、重試 409', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    const out = await failAmbiguously(refund);
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
    assert.equal(out.needsCheck, true);
    assert.deepEqual(out.invoiceResolve, { einvoiceId: einvoice.id, invoiceNumber: einvoice.invoiceNumber, amount: 1050, untaxed: 1000, tax: 50, category: 'B2C' });
    assert.equal(out.invoiceResults.some((x) => 'held' in x), false, '不得回傳預占明細原文');

    await assert.rejects(retryRefund(user, refund.id, { checked: true }), isError(409, 'INVOICE_RESULT_UNKNOWN'));
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
  });

  test('連線逾時同樣保留預占', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    mockEzpay({ allowance_issue: networkDown });
    const out = await retryRefund(user, refund.id);
    assert.equal(out.status, 'INVOICE_FAILED');
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
    assert.ok(out.invoiceResolve);
  });

  test('ezPay 明確拒絕（非結果不明）→ 釋放預占、不需核對', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    mockEzpay({ allowance_issue: () => ({ Status: 'INV10014', Message: '參數錯誤' }) });
    const out = await retryRefund(user, refund.id);
    assert.equal(out.status, 'INVOICE_FAILED');
    assert.equal(out.invoiceResolve, null);
    assert.equal(await allowanceTotalOf(einvoice.id), 0);
  });

  test('結果不明時禁止中止，帳務不動', async () => {
    const { refund } = await createInvoicePhaseRefund();
    await failAmbiguously(refund);
    await assert.rejects(abortRefund(user, refund.id, { reason: '顧客改變心意' }), isError(409, 'INVOICE_RESULT_UNKNOWN'));
    assert.equal((await prisma.refundRequest.findUnique({ where: { id: refund.id } })).status, 'INVOICE_FAILED');
  });
});

describe('人工核對：已開立補登折讓號', () => {
  test('B2C：寫入折讓單（明細＝預占）、預占不重複累加、結案', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    await failAmbiguously(refund);
    calls = [];

    const out = await resolveInvoiceOutcome(user, refund.id, {
      einvoiceId: einvoice.id,
      outcome: 'ISSUED',
      allowanceNo: 'a260000001',
      reason: '藍新後台查得折讓單',
    });
    assert.equal(out.status, 'COMPLETED');
    assert.deepEqual(calls, [], '補登不得再呼叫 ezPay');
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);

    const rec = await prisma.invoiceAllowance.findUnique({ where: { allowanceNo: 'A260000001' }, include: { items: true } });
    assert.equal(rec.refundId, refund.id);
    assert.deepEqual([rec.untaxedAmt, rec.taxAmt, rec.totalAmt], [1000, 50, 1050]);
    assert.equal(rec.items.length, 1);
    assert.deepEqual([rec.items[0].amount, rec.items[0].taxAmt], [1000, 50]);

    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_INVOICE_RESOLVE' } });
    assert.equal(audit.reason, '藍新後台查得折讓單');
    assert.equal(audit.staffId, user.id);
    assert.equal(audit.after.ezPayAllowanceNo, 'A260000001');
    assert.equal(audit.after.confirmedByStaffId, user.id);
  });

  test('B2B：補登後進入待簽名', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund({ category: 'B2B' });
    await failAmbiguously(refund);
    const out = await resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'ISSUED', allowanceNo: 'A260000002', reason: '後台已開立' });
    assert.equal(out.status, 'SIGNATURE_PENDING');
  });

  test('折讓號已被其他折讓單使用 → 409，維持待核對', async () => {
    const other = await createInvoicePhaseRefund();
    await failAmbiguously(other.refund);
    await resolveInvoiceOutcome(user, other.refund.id, { einvoiceId: other.einvoice.id, outcome: 'ISSUED', allowanceNo: 'A260000003', reason: '後台已開立' });

    const { refund, einvoice } = await createInvoicePhaseRefund();
    await failAmbiguously(refund);
    await assert.rejects(
      resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'ISSUED', allowanceNo: 'A260000003', reason: '後台已開立' }),
      isError(409, 'ALLOWANCE_NO_TAKEN'),
    );
    assert.ok((await retryRefund(user, refund.id).catch((e) => e)).code === 'INVOICE_RESULT_UNKNOWN');
  });
});

describe('人工核對：確認未開立', () => {
  test('釋放預占後重開成功，allowanceTotal 為單次金額', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    await failAmbiguously(refund);
    mockEzpay({
      allowance_issue: () => ({
        Status: 'SUCCESS',
        Message: 'ok',
        Result: JSON.stringify({ AllowanceNo: 'A260000009', AllowanceAmt: 1050, RemainAmt: 1050, InvoiceNumber: einvoice.invoiceNumber }),
      }),
    });
    const out = await resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED', confirmEzPayNotIssued: true, reason: '藍新後台查無折讓' });
    assert.equal(out.status, 'COMPLETED');
    assert.deepEqual(calls, ['allowance_issue']);
    const audit = await prisma.transactionAuditLog.findFirst({ where: { refundId: refund.id, action: 'REFUND_INVOICE_RESOLVE' } });
    assert.equal(audit.after.confirmEzPayNotIssued, true);
    assert.equal(audit.after.confirmedByStaffId, user.id);
    assert.ok(audit.after.confirmedAt);
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
    assert.equal(await prisma.invoiceAllowance.count({ where: { refundId: refund.id } }), 1);
  });

  test('重開仍結果不明 → 再次保留預占（不重複累加）', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    await failAmbiguously(refund);
    mockEzpay({ allowance_issue: networkDown });
    const out = await resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED', confirmEzPayNotIssued: true, reason: '藍新後台查無折讓' });
    assert.equal(out.status, 'INVOICE_FAILED');
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
  });
});

describe('核對入口防呆', () => {
  test('參數與狀態檢核', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund();
    await assert.rejects(
      resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED', reason: '查無' }),
      isError(409, 'NO_UNRESOLVED_INVOICE'),
    );
    await failAmbiguously(refund);
    await assert.rejects(resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED' }), isError(400, 'REASON_REQUIRED'));
    await assert.rejects(
      resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED', reason: '查無' }),
      isError(409, 'EZPAY_NOT_ISSUED_UNCONFIRMED'),
    );
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
    await assert.rejects(resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'MAYBE', reason: '查無' }), isError(400, 'OUTCOME_INVALID'));
    await assert.rejects(resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'ISSUED', reason: '已開立' }), isError(400, 'ALLOWANCE_NO_REQUIRED'));
    await assert.rejects(
      resolveInvoiceOutcome(user, refund.id, { einvoiceId: einvoice.id, outcome: 'ISSUED', allowanceNo: 'A-1', reason: '已開立' }),
      isError(400, 'ALLOWANCE_NO_INVALID'),
    );
    await assert.rejects(
      resolveInvoiceOutcome(user, refund.id, { einvoiceId: 'EIVOTHER', outcome: 'NOT_ISSUED', reason: '查無' }),
      isError(409, 'INVOICE_MISMATCH'),
    );
    const outsider = { ...(await createStaffUser('DUTY')), branchIds: [] };
    await assert.rejects(
      resolveInvoiceOutcome(outsider, refund.id, { einvoiceId: einvoice.id, outcome: 'NOT_ISSUED', reason: '查無' }),
      isError(404, 'REFUND_NOT_FOUND'),
    );
    assert.equal(await allowanceTotalOf(einvoice.id), 1050);
  });
});

describe('作廢結果不明：重試前先查遠端', () => {
  test('遠端已作廢 → 只同步本地、不再呼叫作廢、結案', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund({ action: 'VOID' });
    mockEzpay({ invoice_invalid: networkDown });
    const first = await retryRefund(user, refund.id);
    assert.equal(first.status, 'INVOICE_FAILED');
    assert.equal(first.needsCheck, true);
    await assert.rejects(abortRefund(user, refund.id, { reason: '改變心意' }), isError(409, 'INVOICE_RESULT_UNKNOWN'));

    mockEzpay({
      invoice_search: () => ({
        Status: 'SUCCESS',
        Message: 'ok',
        Result: JSON.stringify({ InvoiceNumber: einvoice.invoiceNumber, MerchantOrderNo: einvoice.merchantOrderNo, TotalAmt: einvoice.totalAmount, InvoiceStatus: '2' }),
      }),
    });
    const out = await retryRefund(user, refund.id);
    assert.equal(out.status, 'COMPLETED');
    assert.deepEqual(calls, ['invoice_search']);
    assert.equal((await prisma.eInvoice.findUnique({ where: { id: einvoice.id } })).status, 'VOIDED');
    assert.equal(out.invoiceResults[0].remoteAlreadyVoided, true);
  });

  test('遠端未作廢 → 重新作廢', async () => {
    const { refund, einvoice } = await createInvoicePhaseRefund({ action: 'VOID' });
    mockEzpay({ invoice_invalid: networkDown });
    await retryRefund(user, refund.id);
    mockEzpay({
      invoice_search: () => ({
        Status: 'SUCCESS',
        Message: 'ok',
        Result: JSON.stringify({ InvoiceNumber: einvoice.invoiceNumber, MerchantOrderNo: einvoice.merchantOrderNo, TotalAmt: einvoice.totalAmount, InvoiceStatus: '1' }),
      }),
      invoice_invalid: () => ({ Status: 'SUCCESS', Message: 'ok', Result: JSON.stringify({ InvoiceNumber: einvoice.invoiceNumber }) }),
    });
    const out = await retryRefund(user, refund.id);
    assert.equal(out.status, 'COMPLETED');
    assert.deepEqual(calls, ['invoice_search', 'invoice_invalid']);
  });
});
