// 定型化契約第十二條「會員權暫停」純函式規則
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addWorkingDays,
  frozenDaysOf,
  medicalSuspensionSummary,
  reviewHolidayWindow,
  validateLeaveApplication,
} from '../../lib/memberLeaveRules.js';

// 2026-10-05（一）10:00 台灣時間
const NOW = new Date('2026-10-05T02:00:00Z');
const rejectsWith = (code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, 400);
  return true;
};

describe('validateLeaveApplication', () => {
  test('起迄日換算台灣 00:00，含頭尾天數，迄日次日為 endAt', () => {
    const r = validateLeaveApplication({ category: 'military', startDate: '2026-10-10', endDate: '2026-11-09', hasProof: true, now: NOW });
    assert.equal(r.category, 'MILITARY');
    assert.equal(r.days, 31);
    assert.equal(r.startAt.toISOString(), '2026-10-09T16:00:00.000Z');
    assert.equal(r.endAt.toISOString(), '2026-11-09T16:00:00.000Z');
    assert.equal(r.backdated, false);
    assert.equal(r.proofDueAt, null);
  });

  test('事由、日期、天數上限', () => {
    assert.throws(() => validateLeaveApplication({ category: 'VACATION', startDate: '2026-10-10', endDate: '2026-10-11', hasProof: true, now: NOW }), rejectsWith('LEAVE_CATEGORY_INVALID'));
    assert.throws(() => validateLeaveApplication({ category: 'OTHER', startDate: '2026-10-12', endDate: '2026-10-11', hasProof: true, now: NOW }), rejectsWith('LEAVE_DATES_INVALID'));
    assert.throws(() => validateLeaveApplication({ category: 'OTHER', startDate: '2026-02-30', endDate: '2026-03-01', hasProof: true, now: NOW }), rejectsWith('LEAVE_DATES_INVALID'));
    assert.throws(() => validateLeaveApplication({ category: 'OTHER', startDate: '2026-10-10', endDate: '2027-10-10', hasProof: true, now: NOW }), rejectsWith('LEAVE_DAYS_OUT_OF_RANGE'));
  });

  test('出國須逾一個月（≥31 日）', () => {
    assert.throws(() => validateLeaveApplication({ category: 'OVERSEAS', startDate: '2026-10-10', endDate: '2026-11-08', hasProof: true, now: NOW }), rejectsWith('LEAVE_OVERSEAS_MIN_DAYS'));
    assert.equal(validateLeaveApplication({ category: 'OVERSEAS', startDate: '2026-10-10', endDate: '2026-11-09', hasProof: true, now: NOW }).days, 31);
  });

  test('回溯僅限傷病／疫情且 30 日內', () => {
    assert.throws(() => validateLeaveApplication({ category: 'FAMILY_CARE', startDate: '2026-10-04', endDate: '2026-10-20', hasProof: true, now: NOW }), rejectsWith('LEAVE_BACKDATE_NOT_ALLOWED'));
    assert.throws(() => validateLeaveApplication({ category: 'MEDICAL', startDate: '2026-09-04', endDate: '2026-10-20', hasProof: true, now: NOW }), rejectsWith('LEAVE_BACKDATE_TOO_FAR'));
    const r = validateLeaveApplication({ category: 'MEDICAL', startDate: '2026-09-05', endDate: '2026-10-20', hasProof: true, now: NOW });
    assert.equal(r.backdated, true);
    // 今日起算不算回溯
    assert.equal(validateLeaveApplication({ category: 'OTHER', startDate: '2026-10-05', endDate: '2026-10-06', hasProof: true, now: NOW }).backdated, false);
  });

  test('證明：一般事由必附；傷病／疫情可先送件，期限＝今日＋30 日當日結束', () => {
    assert.throws(() => validateLeaveApplication({ category: 'RELOCATION', startDate: '2026-10-10', endDate: '2026-10-20', hasProof: false, now: NOW }), rejectsWith('LEAVE_PROOF_REQUIRED'));
    const r = validateLeaveApplication({ category: 'EPIDEMIC', startDate: '2026-10-10', endDate: '2026-10-20', hasProof: false, now: NOW });
    assert.equal(r.proofDueAt.toISOString(), '2026-11-04T16:00:00.000Z');
  });
});

describe('addWorkingDays', () => {
  test('週一起算 7 工作日＝下週三當日結束（跳過週末）', () => {
    assert.equal(addWorkingDays(NOW).toISOString(), '2026-10-14T15:59:59.999Z');
  });
  test('週五起算 1 工作日＝下週一', () => {
    assert.equal(addWorkingDays(new Date('2026-10-09T03:00:00Z'), 1).toISOString(), '2026-10-12T15:59:59.999Z');
  });
  test('排除國定假日：2026 春節（2/16～2/19）不計入', () => {
    const cny = new Set(['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19']);
    // 2/12（四）起：2/13、2/20、2/23～2/27 → 第 7 個工作日 2/27
    assert.equal(addWorkingDays(new Date('2026-02-12T02:00:00Z'), 7, cny).toISOString(), '2026-02-27T15:59:59.999Z');
    assert.equal(addWorkingDays(new Date('2026-02-12T02:00:00Z'), 7).toISOString(), '2026-02-23T15:59:59.999Z');
  });
  test('假日查詢區間以台灣日起算 45 日', () => {
    assert.deepEqual(reviewHolidayWindow(new Date('2026-02-11T17:00:00Z')), { fromKey: '2026-02-12', toKey: '2026-03-29' });
  });
});

describe('frozenDaysOf／medicalSuspensionSummary', () => {
  const startAt = new Date('2026-01-01T16:00:00Z');
  test('已結束取 frozenDays；截斷者依 endedAt；進行中依經過天數；其他狀態 0', () => {
    assert.equal(frozenDaysOf({ status: 'ENDED', days: 30, frozenDays: 12, startAt }), 12);
    assert.equal(frozenDaysOf({ status: 'ENDED', days: 30, frozenDays: null, startAt, endedAt: new Date('2026-01-11T16:00:00Z') }), 10);
    assert.equal(frozenDaysOf({ status: 'ENDED', days: 30, startAt }), 30);
    assert.equal(frozenDaysOf({ status: 'ACTIVE', days: 30, startAt }, new Date('2026-01-06T04:00:00Z')), 5);
    assert.equal(frozenDaysOf({ status: 'ACTIVE', days: 30, startAt }, new Date('2026-06-01T00:00:00Z')), 30);
    assert.equal(frozenDaysOf({ status: 'APPROVED', days: 30, startAt }), 0);
  });

  test('傷病累計滿 180 日方達免手續費門檻，其他事由不計', () => {
    const leaves = [
      { category: 'MEDICAL', status: 'ENDED', days: 120, frozenDays: 120, startAt },
      { category: 'MEDICAL', status: 'ENDED', days: 59, frozenDays: 59, startAt },
      { category: 'OVERSEAS', status: 'ENDED', days: 60, frozenDays: 60, startAt },
    ];
    assert.deepEqual(medicalSuspensionSummary(leaves), { days: 179, exemptEligible: false });
    leaves.push({ category: 'MEDICAL', status: 'ENDED', days: 1, frozenDays: 1, startAt });
    assert.deepEqual(medicalSuspensionSummary(leaves), { days: 180, exemptEligible: true });
  });
});
