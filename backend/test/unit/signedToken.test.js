import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readToken, sha256Hex, signToken } from '../../lib/signedToken.js';

describe('signedToken（quoteToken／previewToken 共用）', () => {
  const payload = () => ({ v: 1, ref: 'TYK1', sid: 7, dg: sha256Hex('plan'), exp: Date.now() + 60_000 });

  test('簽發後可讀回原 payload，未逾時', () => {
    const p = payload();
    const read = readToken('refund-quote', signToken('refund-quote', p));
    assert.deepEqual(read, { payload: p, expired: false });
  });

  test('逾時仍可驗章但標記 expired（由呼叫端回 409 *_EXPIRED）', () => {
    const read = readToken('refund-quote', signToken('refund-quote', { ...payload(), exp: Date.now() - 1 }));
    assert.equal(read.expired, true);
  });

  test('用途隔離：quote 憑證不可當 preview 憑證使用', () => {
    assert.equal(readToken('allowance-sign-preview', signToken('refund-quote', payload())), null);
  });

  test('竄改 payload（如改金額摘要）→ 驗章失敗', () => {
    const [body, sig] = signToken('refund-quote', payload()).split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    forged.dg = sha256Hex('other-plan');
    assert.equal(readToken('refund-quote', `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`), null);
  });

  test('格式錯誤或缺 exp → null', () => {
    assert.equal(readToken('refund-quote', ''), null);
    assert.equal(readToken('refund-quote', 'a.b.c'), null);
    assert.equal(readToken('refund-quote', signToken('refund-quote', { v: 1 })), null);
  });

  test('sha256Hex 穩定：相同內容相同摘要、內容變動摘要即變', () => {
    assert.equal(sha256Hex('{"g":500}'), sha256Hex('{"g":500}'));
    assert.notEqual(sha256Hex('{"g":500}'), sha256Hex('{"g":501}'));
    assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
  });
});
