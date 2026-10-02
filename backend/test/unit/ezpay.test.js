import '../helpers/env.js';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAllowancePostData,
  buildInvoiceSearchPostData,
  buildVoidPostData,
  decryptPostData,
  encryptPostData,
  issueAllowance,
  parseEzpayResponse,
  sanitizeInvalidReason,
} from '../../lib/ezpay.js';
import { buildAllowanceLines } from '../../lib/einvoiceRules.js';

const merchant = {
  entityCode: 'T',
  merchantId: '3622183',
  hashKey: '12345678901234567890123456789012',
  hashIv: '1234567890123456',
  invoiceUrl: 'https://cinv.ezpay.com.tw/Api/invoice_issue',
};

const baseAllowance = {
  invoiceNumber: 'ab12345678',
  merchantOrderNo: 'SAL20261002001',
  total: 1050,
  items: [{ name: '乳清蛋白', qty: 1, unit: '罐', unitPrice: 1000, amount: 1000, taxAmt: 50 }],
};

const expectAmountInvalid = (fn) => assert.throws(fn, (e) => e.code === 'EINVOICE_AMOUNT_INVALID' && e.statusCode === 400);

describe('invoice_search 查詢欄位互斥', () => {
  test('SearchType 0 只帶發票號與隨機碼', () => {
    const p = buildInvoiceSearchPostData({ searchType: '0', invoiceNumber: 'ab12345678', randomNum: '4253', merchantOrderNo: 'SAL1', totalAmount: 100 });
    assert.equal(p.SearchType, '0');
    assert.equal(p.InvoiceNumber, 'AB12345678');
    assert.equal(p.RandomNum, '4253');
    assert.equal('MerchantOrderNo' in p, false);
    assert.equal('TotalAmt' in p, false);
  });

  test('SearchType 1 只帶自訂編號與金額', () => {
    const p = buildInvoiceSearchPostData({ searchType: '1', merchantOrderNo: 'SAL1', totalAmount: 1000 });
    assert.equal(p.SearchType, '1');
    assert.equal(p.MerchantOrderNo, 'SAL1');
    assert.equal(p.TotalAmt, '1000');
    assert.equal('InvoiceNumber' in p, false);
  });

  test('隨機碼不是 4 位數字 → 400', () => {
    assert.throws(() => buildInvoiceSearchPostData({ invoiceNumber: 'AB12345678', randomNum: '12' }), (e) => e.code === 'INVALID_RANDOM_NUM');
  });
});

describe('欄位命名：作廢 InvoiceNumber／折讓 InvoiceNo', () => {
  test('invoice_invalid 只帶 InvoiceNumber', () => {
    const p = buildVoidPostData({ invoiceNumber: ' ab12345678 ', reason: '退貨' });
    assert.equal(p.Version, '1.0');
    assert.equal(p.InvoiceNumber, 'AB12345678');
    assert.equal('InvoiceNo' in p, false);
  });

  test('allowance_issue 只帶 InvoiceNo', () => {
    const p = buildAllowancePostData(baseAllowance);
    assert.equal(p.Version, '1.3');
    assert.equal(p.InvoiceNo, 'AB12345678');
    assert.equal('InvoiceNumber' in p, false);
  });

  test('發票號格式錯誤 400 INVALID_INVOICE_NUMBER', () => {
    for (const invoiceNumber of ['', 'SPLIT:AB1', 'AB1234567', 'A123456789']) {
      assert.throws(() => buildVoidPostData({ invoiceNumber }), (e) => e.code === 'INVALID_INVOICE_NUMBER');
      assert.throws(
        () => buildAllowancePostData({ ...baseAllowance, invoiceNumber }),
        (e) => e.code === 'INVALID_INVOICE_NUMBER',
      );
    }
  });
});

describe('多品項 | 分隔', () => {
  test('品名／單位內半形 | 轉全形 ｜，各欄品項數一致', () => {
    const p = buildAllowancePostData({
      ...baseAllowance,
      total: 2100,
      items: [
        { name: '乳清|巧克力', qty: 1, unit: '|', unitPrice: 1000, amount: 1000, taxAmt: 50 },
        { name: '私教課', qty: 2, unit: '堂', unitPrice: 500, amount: 1000, taxAmt: 50 },
      ],
    });
    for (const k of ['ItemName', 'ItemCount', 'ItemUnit', 'ItemPrice', 'ItemAmt', 'ItemTaxAmt']) {
      assert.equal(p[k].split('|').length, 2, k);
    }
    assert.equal(p.ItemName, '乳清｜巧克力|私教課');
    assert.equal(p.ItemUnit, '｜|堂');
  });
});

describe('作廢／折讓原因長度', () => {
  test('含中文截 6 字、純英數截 20 字', () => {
    assert.equal(sanitizeInvalidReason('顧客要求退貨並全額退款處理'), '顧客要求退貨');
    assert.equal(sanitizeInvalidReason('a'.repeat(30)), 'a'.repeat(20));
    assert.equal(sanitizeInvalidReason(''), '交易取消');
  });

  test('作廢 PostData 套用截斷', () => {
    const p = buildVoidPostData({ invoiceNumber: 'AB12345678', reason: '顧客要求退貨並全額退款處理' });
    assert.equal(p.InvalidReason, '顧客要求退貨');
  });
});

describe('Result 雙重 JSON 封裝', () => {
  test('字串化 JSON 與物件皆可解析', () => {
    const inner = { AllowanceNo: 'A123', RemainAmt: 0 };
    assert.deepEqual(parseEzpayResponse({ Status: 'SUCCESS', Result: JSON.stringify(inner) }).result, inner);
    assert.deepEqual(parseEzpayResponse({ Status: 'SUCCESS', Result: inner }).result, inner);
  });

  test('無法解析之字串標 resultUnparsed', () => {
    const r = parseEzpayResponse({ Status: 'SUCCESS', Result: '{bad' });
    assert.equal(r.result, null);
    assert.equal(r.resultUnparsed, true);
  });
});

describe('折讓金額：未稅＋稅額＝含稅總額', () => {
  test('Σ(ItemAmt＋ItemTaxAmt) ≠ TotalAmt 拒絕', () => {
    expectAmountInvalid(() => buildAllowancePostData({ ...baseAllowance, total: 1000 }));
  });

  test('未稅小計 ≠ 數量×未稅單價 拒絕', () => {
    expectAmountInvalid(() =>
      buildAllowancePostData({
        ...baseAllowance,
        items: [{ name: 'x', qty: 2, unitPrice: 400, amount: 1000, taxAmt: 50 }],
      }),
    );
  });

  test('小數或負數拒絕', () => {
    expectAmountInvalid(() =>
      buildAllowancePostData({ ...baseAllowance, items: [{ name: 'x', qty: 1, unitPrice: 999.5, amount: 999.5, taxAmt: 50.5 }] }),
    );
    expectAmountInvalid(() =>
      buildAllowancePostData({ ...baseAllowance, items: [{ name: 'x', qty: 1, unitPrice: 1100, amount: 1100, taxAmt: -50 }] }),
    );
  });

  test('免稅發票稅額須為 0', () => {
    expectAmountInvalid(() => buildAllowancePostData({ ...baseAllowance, taxType: '3' }));
    const p = buildAllowancePostData({
      ...baseAllowance,
      taxType: '3',
      total: 1000,
      items: [{ name: 'x', qty: 1, unitPrice: 1000, amount: 1000, taxAmt: 0 }],
    });
    assert.equal(p.ItemTaxAmt, '0');
  });

  test('buildAllowanceLines 產出之明細可直接打包', () => {
    const invoice = { totalAmount: 3000, allowanceTotal: 0, salesAmount: 2857, taxAmount: 143, taxType: '1' };
    const built = buildAllowanceLines({
      invoice,
      lines: [
        { name: '乳清|蛋白', qty: 3, gross: 1000 },
        { name: '私教課', qty: 1, gross: 999 },
      ],
    });
    const p = buildAllowancePostData({ ...baseAllowance, total: built.total, items: built.items });
    const amt = p.ItemAmt.split('|').map(Number);
    const tax = p.ItemTaxAmt.split('|').map(Number);
    assert.equal(amt.reduce((a, b) => a + b, 0) + tax.reduce((a, b) => a + b, 0), Number(p.TotalAmt));
    assert.equal(p.ItemName.split('|').length, 2);
  });

  test('未帶 items 時以單一品項送出', () => {
    const p = buildAllowancePostData({ invoiceNumber: 'AB12345678', merchantOrderNo: 'TYK1', untaxed: 952, tax: 48, total: 1000 });
    assert.equal(p.ItemCount, '1');
    assert.equal(p.ItemPrice, '952');
    assert.equal(p.ItemTaxAmt, '48');
  });
});

describe('AES-256-CBC（32-byte PKCS7）', () => {
  test('加解密往返', () => {
    const data = { RespondType: 'JSON', ItemName: '乳清|私教', TotalAmt: '1050' };
    const hex = encryptPostData(merchant, data);
    assert.equal((hex.length / 2) % 32, 0);
    assert.deepEqual(decryptPostData(merchant, hex), data);
  });
});

describe('issueAllowance 回應處理', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(body, capture = {}) {
    globalThis.fetch = async (url, init) => {
      capture.url = String(url);
      capture.body = new URLSearchParams(init.body);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return capture;
  }

  test('打到 allowance_issue、送出 InvoiceNo，解析字串化 Result', async () => {
    const capture = mockFetch({
      Status: 'SUCCESS',
      Message: 'ok',
      Result: JSON.stringify({ AllowanceNo: 'A260000001', AllowanceAmt: 1050, RemainAmt: 0, InvoiceNumber: 'AB12345678' }),
    });
    const r = await issueAllowance(merchant, baseAllowance);
    assert.equal(r.allowanceNo, 'A260000001');
    assert.equal(r.remainAmt, 0);
    assert.match(capture.url, /\/Api\/allowance_issue$/);
    assert.equal(capture.body.get('MerchantID_'), merchant.merchantId);
    const sent = decryptPostData(merchant, capture.body.get('PostData_'));
    assert.equal(sent.InvoiceNo, 'AB12345678');
    assert.equal(sent.InvoiceNumber, undefined);
  });

  test('SUCCESS 但 Result 無法解析 → EZPAY_BAD_RESPONSE（結果不明）', async () => {
    mockFetch({ Status: 'SUCCESS', Message: 'ok', Result: '{bad' });
    await assert.rejects(issueAllowance(merchant, baseAllowance), (e) => e.code === 'EZPAY_BAD_RESPONSE');
  });

  test('金額檢核失敗不呼叫 ezPay', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };
    await assert.rejects(issueAllowance(merchant, { ...baseAllowance, total: 999 }), (e) => e.code === 'EINVOICE_AMOUNT_INVALID');
    assert.equal(called, false);
  });
});
