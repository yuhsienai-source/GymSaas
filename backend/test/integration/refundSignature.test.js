// 折讓簽名：PREVIEW_STALE（顧客所簽版本失效）、previewToken 綁定、孤兒簽名檔清除
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backendRoot } from '../helpers/env.js';
import { closePrisma, createBranch, createStaffUser, prisma, resetDb, testId } from '../helpers/db.js';
import { inkedSignature, makePng } from '../helpers/png.js';
import { attachRefundSignature, buildSignPreview } from '../../lib/refundSignature.js';
import { withRefundLock } from '../../lib/refundService.js';
import { signToken } from '../../lib/signedToken.js';

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

const sigDir = (refundId) => path.join(backendRoot, 'uploads/allowance-signatures', refundId);
const storedFiles = (refundId) => fs.readdir(sigDir(refundId)).catch(() => []);

let user;
let branch;
const createdRefunds = [];

beforeEach(async () => {
  await resetDb();
  user = await createStaffUser('ADMIN');
  branch = await createBranch();
});

after(async () => {
  await Promise.all(createdRefunds.map((id) => fs.rm(sigDir(id), { recursive: true, force: true })));
  await closePrisma();
});

/** B2B 折讓待簽名之退費單（不經金流／ezPay） */
async function createSignableRefund() {
  const refund = await prisma.refundRequest.create({
    data: {
      id: testId('RFD'),
      kind: 'ORDER_REFUND',
      refType: 'ORDER',
      refId: testId('TYK'),
      branchId: branch.id,
      scope: 'UNUSED',
      grossAmount: 500,
      payoutAmount: 500,
      signatureRequired: true,
      reason: '測試折讓',
      staffId: user.id,
      status: 'SIGNATURE_PENDING',
    },
  });
  createdRefunds.push(refund.id);
  const allowance = await prisma.invoiceAllowance.create({
    data: {
      id: testId('IAL'),
      allowanceNo: testId('A'),
      invoiceNumber: 'AB12345678',
      merchantOrderNo: refund.refId,
      untaxedAmt: 476,
      taxAmt: 24,
      totalAmt: 500,
      status: 'ISSUED',
      refundId: refund.id,
      subOrderId: refund.refId,
      branchId: branch.id,
      category: 'B2B',
      buyerUbn: '12345678',
      buyerName: '測試股份有限公司',
      items: {
        create: [{ lineNo: 1, name: '計時儲值', qty: 1, unitPrice: 476, amount: 476, taxAmt: 24, grossAmount: 500 }],
      },
    },
    include: { items: true },
  });
  return { refund, allowance };
}

async function assertNotSigned(refundId) {
  assert.equal(await prisma.refundSignature.count({ where: { refundId } }), 0);
  const r = await prisma.refundRequest.findUnique({ where: { id: refundId }, select: { signatureId: true, status: true } });
  assert.deepEqual(r, { signatureId: null, status: 'SIGNATURE_PENDING' });
  assert.deepEqual(await storedFiles(refundId), [], '不得留下簽名檔');
}

describe('折讓簽名 previewToken', () => {
  test('預覽金額由後端組成；簽名後歸檔並結案', async () => {
    const { refund } = await createSignableRefund();
    const preview = await buildSignPreview(user, refund.id);
    assert.deepEqual(preview.totals, { untaxed: 476, tax: 24, total: 500 });
    assert.equal(preview.docs[0].buyerLabel, '測試股份有限公司（12345678）');

    const out = await attachRefundSignature(user, refund.id, {
      previewToken: preview.previewToken,
      requestId: preview.requestId,
      signature: await inkedSignature(),
    });
    assert.equal(out.status, 'COMPLETED');
    const sig = await prisma.refundSignature.findFirst({ where: { refundId: refund.id } });
    assert.equal(sig.previewDigest.length, 64);
    assert.deepEqual(await storedFiles(refund.id), [`${sig.id}.png`]);
    assert.equal((await prisma.invoiceAllowance.findFirst({ where: { refundId: refund.id } })).signatureId, sig.id);
  });

  test('PREVIEW_STALE：預覽後折讓金額變動 → 409，不歸檔', async () => {
    const { refund, allowance } = await createSignableRefund();
    const preview = await buildSignPreview(user, refund.id);
    await prisma.invoiceAllowance.update({ where: { id: allowance.id }, data: { untaxedAmt: 477, taxAmt: 23 } });
    await assert.rejects(
      attachRefundSignature(user, refund.id, {
        previewToken: preview.previewToken,
        requestId: preview.requestId,
        signature: await inkedSignature(),
      }),
      isError(409, 'PREVIEW_STALE'),
    );
    await assertNotSigned(refund.id);
  });

  test('PREVIEW_STALE：預覽後折讓品項或實退金額變動 → 409', async () => {
    const { refund, allowance } = await createSignableRefund();
    const p1 = await buildSignPreview(user, refund.id);
    await prisma.invoiceAllowanceItem.updateMany({ where: { allowanceId: allowance.id }, data: { name: '其他品項' } });
    await assert.rejects(
      attachRefundSignature(user, refund.id, { previewToken: p1.previewToken, requestId: p1.requestId, signature: await inkedSignature() }),
      isError(409, 'PREVIEW_STALE'),
    );

    const p2 = await buildSignPreview(user, refund.id);
    await prisma.refundRequest.update({ where: { id: refund.id }, data: { payoutAmount: 400 } });
    await assert.rejects(
      attachRefundSignature(user, refund.id, { previewToken: p2.previewToken, requestId: p2.requestId, signature: await inkedSignature() }),
      isError(409, 'PREVIEW_STALE'),
    );
    assert.equal(await prisma.refundSignature.count({ where: { refundId: refund.id } }), 0);
  });

  test('requestId／經辦不符 → 400；逾時 → 409 PREVIEW_EXPIRED', async () => {
    const { refund } = await createSignableRefund();
    const preview = await buildSignPreview(user, refund.id);
    const signature = await inkedSignature();
    await assert.rejects(
      attachRefundSignature(user, refund.id, { previewToken: preview.previewToken, requestId: 'ASRWRONG', signature }),
      isError(400, 'PREVIEW_TOKEN_INVALID'),
    );
    const otherUser = await createStaffUser('ADMIN');
    await assert.rejects(
      attachRefundSignature(otherUser, refund.id, { previewToken: preview.previewToken, requestId: preview.requestId, signature }),
      isError(400, 'PREVIEW_TOKEN_INVALID'),
    );
    const payload = JSON.parse(Buffer.from(preview.previewToken.split('.')[0], 'base64url').toString('utf8'));
    const expired = signToken('allowance-sign-preview', { ...payload, exp: Date.now() - 1 });
    await assert.rejects(
      attachRefundSignature(user, refund.id, { previewToken: expired, requestId: preview.requestId, signature }),
      isError(409, 'PREVIEW_EXPIRED'),
    );
    await assertNotSigned(refund.id);
  });

  test('空白簽名 → 400 SIGNATURE_REQUIRED，不落檔', async () => {
    const { refund } = await createSignableRefund();
    const preview = await buildSignPreview(user, refund.id);
    await assert.rejects(
      attachRefundSignature(user, refund.id, { previewToken: preview.previewToken, requestId: preview.requestId, signature: await makePng() }),
      isError(400, 'SIGNATURE_REQUIRED'),
    );
    await assertNotSigned(refund.id);
  });
});

describe('孤兒簽名檔清除', () => {
  test('影像已上傳但歸檔失敗（退費單處理中）→ 刪除已上傳檔並拋出原例外', async () => {
    const { refund } = await createSignableRefund();
    const preview = await buildSignPreview(user, refund.id);
    const signature = await inkedSignature();
    await withRefundLock(refund.id, async () => {
      await assert.rejects(
        attachRefundSignature(user, refund.id, { previewToken: preview.previewToken, requestId: preview.requestId, signature }),
        isError(409, 'REFUND_IN_PROGRESS'),
      );
    });
    await assertNotSigned(refund.id);
  });

  test('交易內失敗（簽名已被搶先歸檔）→ 刪除本次上傳檔，保留勝者檔案', async () => {
    const { refund } = await createSignableRefund();
    const p1 = await buildSignPreview(user, refund.id);
    const p2 = await buildSignPreview(user, refund.id);
    const signature = await inkedSignature();
    const results = await Promise.allSettled([
      attachRefundSignature(user, refund.id, { previewToken: p1.previewToken, requestId: p1.requestId, signature }),
      attachRefundSignature(user, refund.id, { previewToken: p2.previewToken, requestId: p2.requestId, signature }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.ok(['REFUND_IN_PROGRESS', 'SIGNATURE_EXISTS'].includes(failed[0].reason.code), failed[0].reason.message);
    const sigs = await prisma.refundSignature.findMany({ where: { refundId: refund.id } });
    assert.equal(sigs.length, 1);
    assert.deepEqual(await storedFiles(refund.id), [`${sigs[0].id}.png`]);
  });
});
