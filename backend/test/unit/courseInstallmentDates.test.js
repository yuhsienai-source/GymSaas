// 客製化教練課分期扣款日：30 日一期，第 k 期＝首期付款日 + 30k 日（台灣日），
// 落在 1～15 日扣當月 1 日、16～31 日扣當月 16 日；換卡續約不得送出今日或過去日給 PayUNi
import '../helpers/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { courseInstallmentChargeDates, remainingCourseChargeDates } from '../../lib/coursePlan.js';
import { resolveBindSchedule } from '../../lib/payuni.js';

const tw = (ymd, hm = '10:00') => new Date(`${ymd}T${hm}:00+08:00`);
const twToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

describe('courseInstallmentChargeDates', () => {
  test('契約範例：首期 2022-01-08 → 第 2 期 D+30＝02-07 收斂 02-01，其後 03-01、04-01', () => {
    assert.deepEqual(courseInstallmentChargeDates(3, tw('2022-01-08')), ['2022-02-01', '2022-03-01', '2022-04-01']);
  });

  test('15／16 日臨界：D+30 落 15 日 → 當月 1 日；落 16 日 → 當月 16 日', () => {
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2022-01-16')), ['2022-02-01']);
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2022-01-17')), ['2022-02-16']);
  });

  test('大月：01-01 + 30＝01-31 → 01-16', () => {
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2022-01-01')), ['2022-01-16']);
  });

  test('2 月平閏年跨月', () => {
    // 閏年 01-30 + 30＝02-29；平年＝03-01
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2024-01-30')), ['2024-02-16']);
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2023-01-30')), ['2023-03-01']);
    // 01-31 + 30：閏年 03-01、平年 03-02，皆收斂 03-01
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2024-01-31')), ['2024-03-01']);
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2023-01-31')), ['2023-03-01']);
  });

  test('30 日一期非按月：可能跳過某月（01-16 → 03-01）', () => {
    assert.deepEqual(courseInstallmentChargeDates(3, tw('2022-01-01')), ['2022-01-16', '2022-03-01', '2022-04-01']);
  });

  test('以台灣日起算：台灣 01-17 00:30（UTC 仍為 01-16）→ 02-16', () => {
    assert.deepEqual(courseInstallmentChargeDates(1, tw('2022-01-17', '00:30')), ['2022-02-16']);
  });

  test('期數無效回空陣列', () => {
    assert.deepEqual(courseInstallmentChargeDates(0, tw('2022-01-08')), []);
    assert.deepEqual(courseInstallmentChargeDates('x', tw('2022-01-08')), []);
  });
});

describe('remainingCourseChargeDates（換卡續約）', () => {
  // 共 4 期（首期＋3 期）：02-01、03-01、04-01
  const origin = tw('2022-01-08');

  test('剩餘期數與未來扣款日相符：沿用原扣款表', () => {
    assert.deepEqual(remainingCourseChargeDates(4, 2, origin, tw('2022-02-20')), ['2022-03-01', '2022-04-01']);
  });

  test('03-05 換卡、3 月已扣：只排 04-01', () => {
    assert.deepEqual(remainingCourseChargeDates(4, 1, origin, tw('2022-03-05')), ['2022-04-01']);
  });

  test('03-05 換卡、3 月未扣（D+60＝03-09 收斂 03-01 已過）：不送過去日，回 null 改用預設排程', () => {
    assert.equal(remainingCourseChargeDates(4, 2, origin, tw('2022-03-05')), null);
  });

  test('扣款日當天換卡：今日不可排入，回 null', () => {
    assert.equal(remainingCourseChargeDates(4, 1, origin, tw('2022-04-01')), null);
  });
});

describe('resolveBindSchedule（送 PayUNi 之排程）', () => {
  test('固定扣款日皆晚於台灣今日且筆數相符：原樣採用', () => {
    assert.deepEqual(resolveBindSchedule('M', 1, { periodDates: ['2022-04-01'] }, tw('2022-03-05')), ['2022-04-01']);
  });

  test('含今日／過去日、筆數不符或無固定日：退回預設排程，且皆為嚴格未來日', () => {
    const cases = [
      { periodDates: ['2022-03-01', '2022-04-01'], now: tw('2022-03-05') },
      { periodDates: ['2022-04-01'], now: tw('2022-04-01') },
      { periodDates: ['2022-04-01', '2022-05-01'], now: tw('2022-03-05'), times: 3 },
      { periodDates: null, now: tw('2022-03-05') },
    ];
    const today = twToday();
    for (const c of cases) {
      const times = c.times ?? 2;
      const out = resolveBindSchedule('M', times, { periodDates: c.periodDates }, c.now);
      assert.equal(out.length, times);
      assert.notDeepEqual(out, c.periodDates);
      assert.ok(out.every((d) => d > today), `${out} 須晚於今日 ${today}`);
    }
  });
});
