import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_SIGNATURE_BYTES, validateSignaturePng } from '../../lib/refundSignature.js';
import { inkedSignature, makePng } from '../helpers/png.js';

const rejectsSignature = (buf) =>
  assert.rejects(validateSignaturePng(buf), (e) => e.statusCode === 400 && e.code === 'SIGNATURE_REQUIRED');

describe('validateSignaturePng（防空白簽名）', () => {
  test('有筆跡之 PNG 通過', async () => {
    await validateSignaturePng(await inkedSignature());
  });

  test('純白空白簽名被拒', async () => {
    await rejectsSignature(await makePng());
  });

  test('全透明空白簽名被拒（先鋪白底再判筆跡）', async () => {
    await rejectsSignature(await makePng({ background: [0, 0, 0, 0] }));
  });

  test('僅有淺色浮水印（灰階 ≥128）不算筆跡', async () => {
    await rejectsSignature(await makePng({ strokes: [{ x: 0, y: 0, w: 400, h: 200, rgba: [200, 200, 200, 255] }] }));
  });

  test('筆跡像素不足（<120）被拒', async () => {
    await rejectsSignature(await makePng({ strokes: [{ x: 10, y: 10, w: 100, h: 1 }] }));
  });

  test('尺寸過小被拒', async () => {
    await rejectsSignature(await makePng({ width: 150, height: 60, strokes: [{ x: 0, y: 20, w: 150, h: 10 }] }));
  });

  test('非 PNG（JPEG 偽裝）、空內容、過大檔案被拒', async () => {
    const jpeg = await sharp(await inkedSignature()).jpeg().toBuffer();
    await rejectsSignature(jpeg);
    await rejectsSignature(Buffer.alloc(0));
    await rejectsSignature('not-a-buffer');
    const huge = Buffer.concat([(await inkedSignature()).subarray(0, 8), Buffer.alloc(MAX_SIGNATURE_BYTES)]);
    await rejectsSignature(huge);
  });

  test('PNG 標頭正確但內容損毀被拒', async () => {
    const png = await inkedSignature();
    await rejectsSignature(Buffer.concat([png.subarray(0, 16), Buffer.alloc(64, 0xff)]));
  });
});
