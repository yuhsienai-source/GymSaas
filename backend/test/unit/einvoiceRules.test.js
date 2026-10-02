import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateInteger, decideInvoiceActions, invoicePeriodKey, splitAllowanceAmount } from '../../lib/einvoiceRules.js';

describe('allocateInteger（最大餘數法）', () => {
  test('加總恆等於總額', () => {
    for (const [total, weights] of [
      [100, [1, 1, 1]],
      [7, [3, 3, 1]],
      [1001, [333, 333, 334]],
      [5, [0.1, 0.2, 0.7]],
    ]) {
      const out = allocateInteger(total, weights);
      assert.equal(out.reduce((a, b) => a + b, 0), total);
      assert.ok(out.every((n) => Number.isInteger(n) && n >= 0));
    }
  });

  test('餘數給小數部分最大者，同分給較前者', () => {
    assert.deepEqual(allocateInteger(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocateInteger(10, [1, 2]), [3, 7]);
  });

  test('權重皆 0 時全額歸第一筆', () => {
    assert.deepEqual(allocateInteger(50, [0, 0]), [50, 0]);
  });
});

describe('invoicePeriodKey（台灣時區雙月期）', () => {
  test('以台灣日期判期別', () => {
    assert.equal(invoicePeriodKey(new Date('2026-02-28T15:59:59Z')), '202601');
    assert.equal(invoicePeriodKey(new Date('2026-02-28T16:00:00Z')), '202603');
    assert.equal(invoicePeriodKey(new Date('2026-12-31T16:30:00Z')), '202701');
  });
});

describe('decideInvoiceActions（作廢 vs 折讓）', () => {
  const now = new Date('2026-10-02T04:00:00Z');
  const period = invoicePeriodKey(now);
  const issued = (over = {}) => ({ id: 'E1', status: 'ISSUED', periodKey: period, allowanceTotal: 0, ...over });

  test('無發票 → NONE', () => {
    assert.deepEqual(decideInvoiceActions({ invoices: [], fullRefund: true, now }), { action: 'NONE', perInvoice: [] });
    assert.equal(decideInvoiceActions({ invoices: [issued({ status: 'VOIDED' })], fullRefund: true, now }).action, 'NONE');
  });

  test('全額退＋當期＋未曾折讓＋非合併發票 → VOID', () => {
    const r = decideInvoiceActions({ invoices: [issued(), issued({ id: 'E2' })], fullRefund: true, now });
    assert.equal(r.action, 'VOID');
    assert.deepEqual(r.perInvoice.map((p) => p.action), ['VOID', 'VOID']);
  });

  test('跨期、曾折讓、舊制合併發票或部分退 → ALLOWANCE', () => {
    assert.equal(decideInvoiceActions({ invoices: [issued({ periodKey: '202607' })], fullRefund: true, now }).action, 'ALLOWANCE');
    assert.equal(decideInvoiceActions({ invoices: [issued({ allowanceTotal: 10 })], fullRefund: true, now }).action, 'ALLOWANCE');
    assert.equal(decideInvoiceActions({ invoices: [issued()], fullRefund: true, sharedInvoice: true, now }).action, 'ALLOWANCE');
    assert.equal(decideInvoiceActions({ invoices: [issued()], fullRefund: false, now }).action, 'ALLOWANCE');
  });

  test('任一張跨期即整單改折讓（不混用）', () => {
    const r = decideInvoiceActions({ invoices: [issued(), issued({ id: 'E2', periodKey: '202607' })], fullRefund: true, now });
    assert.deepEqual(r.perInvoice.map((p) => p.action), ['ALLOWANCE', 'ALLOWANCE']);
  });

  test('開立中 → 409 INVOICE_ISSUING', () => {
    assert.throws(
      () => decideInvoiceActions({ invoices: [issued({ status: 'ISSUING' })], fullRefund: true, now }),
      (e) => e.statusCode === 409 && e.code === 'INVOICE_ISSUING',
    );
  });

  test('未開立：部分退 409 INVOICE_NOT_ISSUED；全額退 → CANCEL_UNISSUED', () => {
    const pending = { id: 'E3', status: 'FAILED' };
    assert.throws(
      () => decideInvoiceActions({ invoices: [pending], fullRefund: false, now }),
      (e) => e.statusCode === 409 && e.code === 'INVOICE_NOT_ISSUED',
    );
    assert.deepEqual(decideInvoiceActions({ invoices: [pending], fullRefund: true, now }), {
      action: 'CANCEL_UNISSUED',
      perInvoice: [{ id: 'E3', action: 'CANCEL' }],
    });
  });

  test('已開立＋未開立混合全額退：已開立作廢、未開立取消', () => {
    const r = decideInvoiceActions({ invoices: [issued(), { id: 'E3', status: 'PENDING' }], fullRefund: true, now });
    assert.equal(r.action, 'VOID');
    assert.deepEqual(r.perInvoice, [
      { id: 'E1', action: 'VOID' },
      { id: 'E3', action: 'CANCEL' },
    ]);
  });
});

describe('splitAllowanceAmount', () => {
  test('應稅：未稅＝round(含稅/1.05)，稅額＝差額；免稅不拆', () => {
    assert.deepEqual(splitAllowanceAmount(500, '1'), { total: 500, untaxed: 476, tax: 24 });
    assert.deepEqual(splitAllowanceAmount(500, '3'), { total: 500, untaxed: 500, tax: 0 });
  });

  test('非正數拒絕', () => {
    assert.throws(() => splitAllowanceAmount(0), (e) => e.statusCode === 400);
  });
});
