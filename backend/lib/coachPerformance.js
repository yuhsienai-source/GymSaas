// lib/coachPerformance.js — 教練業績獎金（工資之一部，併入月薪資單計算；底薪一律於薪資設定）
/**
 * 獎金組成（皆不得為負、不得抵扣底薪；營業成本如刷卡手續費不得轉嫁）：
 * - 私教業績抽成：當月執行堂數之合約單堂價（pricePaid ÷ totalSessions）加總 × 階梯比例（達標級距適用全額）
 * - 授課獎金：私教每執行堂、團課每開課堂（有到課者）固定金額
 * - 團課人頭獎金：每到課人次固定金額
 * 規則：教練個別規則優先，無則用全體預設（trainerId=null）；每位教練每課型僅一筆生效。
 */
import prisma from './prisma.js';

export const COURSE_KINDS = { PRIVATE: '私教', GROUP: '團課' };
const MAX_TIERS = 10;
const MAX_MONEY = 1_000_000;

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const r0 = (n) => Math.round(Number(n) || 0);

export function normalizeTierRates(raw) {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return null;
  if (!Array.isArray(raw)) throw httpError('tierRates 須為陣列');
  if (raw.length > MAX_TIERS) throw httpError(`階梯最多 ${MAX_TIERS} 級`);
  const tiers = raw.map((t, i) => {
    const minRevenue = Number(t?.minRevenue);
    const rate = Number(t?.rate);
    if (!Number.isFinite(minRevenue) || minRevenue < 0 || minRevenue > 100_000_000) throw httpError(`第 ${i + 1} 級門檻無效`);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw httpError(`第 ${i + 1} 級比例須介於 0～100%`);
    return { minRevenue: Math.round(minRevenue), rate: Math.round(rate * 10000) / 10000 };
  });
  tiers.sort((a, b) => a.minRevenue - b.minRevenue);
  if (new Set(tiers.map((t) => t.minRevenue)).size !== tiers.length) throw httpError('階梯門檻不可重複');
  return tiers;
}

export function pickTierRate(tiers, revenue) {
  let rate = 0;
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (revenue >= Number(t.minRevenue)) rate = Number(t.rate) || 0;
  }
  return rate;
}

function moneyOrNull(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw httpError(`${label} 須介於 0～${MAX_MONEY}`);
  return Math.round(n);
}

/** 規則輸入驗證；底薪／扣除費率／鐘點制一律拒絕 */
export function normalizeRuleInput(body) {
  const courseKind = String(body?.courseKind || '').toUpperCase();
  if (!COURSE_KINDS[courseKind]) throw httpError('courseKind 須為 PRIVATE 或 GROUP');
  if (Number(body?.baseSalary) > 0) {
    throw httpError('教練底薪請於「薪資 → 薪資設定」維護，獎金規則不得含底薪', 400, 'BASE_SALARY_IN_PAYROLL');
  }
  if (body?.deductRates || body?.hourlyRate != null || String(body?.payModel || '').toUpperCase() === 'HOURLY') {
    throw httpError('不得轉嫁營業成本或採僅付上課鐘點制；授課獎金請用 sessionBonus', 400, 'NON_EMPLOYMENT_TERMS');
  }
  const trainerId = body?.trainerId === undefined || body?.trainerId === null || body?.trainerId === '' ? null : Number(body.trainerId);
  if (trainerId !== null && (!Number.isInteger(trainerId) || trainerId <= 0)) throw httpError('trainerId 無效');
  const data = {
    trainerId,
    courseKind,
    tierRates: courseKind === 'PRIVATE' ? normalizeTierRates(body?.tierRates) : null,
    sessionBonus: moneyOrNull(body?.sessionBonus, '授課獎金'),
    perHeadRate: courseKind === 'GROUP' ? moneyOrNull(body?.perHeadRate, '人頭獎金') : null,
  };
  if (!data.tierRates && !data.sessionBonus && !data.perHeadRate) throw httpError('請至少設定一項獎金');
  return data;
}

export function serializeRule(r) {
  return {
    id: r.id,
    trainerId: r.trainerId,
    trainer: r.trainer ? { id: r.trainer.id, name: r.trainer.name } : null,
    scope: r.trainerId ? 'TRAINER' : 'DEFAULT',
    courseKind: r.courseKind,
    courseKindLabel: COURSE_KINDS[r.courseKind] ?? r.courseKind,
    tierRates: Array.isArray(r.tierRates) ? r.tierRates : null,
    sessionBonus: r.sessionBonus ?? null,
    perHeadRate: r.perHeadRate ?? null,
    createdAt: r.createdAt,
  };
}

/** 生效規則：trainerId → { PRIVATE, GROUP }（個別優先、預設次之） */
export async function resolveRules(trainerIds) {
  const rules = await prisma.coachCommissionRule.findMany({
    where: { isActive: true, OR: [{ trainerId: null }, { trainerId: { in: trainerIds } }] },
    orderBy: { createdAt: 'desc' },
  });
  const pick = (trainerId, kind) =>
    rules.find((r) => r.trainerId === trainerId && r.courseKind === kind) ??
    rules.find((r) => r.trainerId === null && r.courseKind === kind) ??
    null;
  return new Map(trainerIds.map((id) => [id, { PRIVATE: pick(id, 'PRIVATE'), GROUP: pick(id, 'GROUP') }]));
}

/**
 * 純計算
 * @param {{ privateRule: object|null, groupRule: object|null, ptUnitPrices: number[], groupHeads: number[] }} input
 */
export function computeCoachPerformance({ privateRule, groupRule, ptUnitPrices, groupHeads }) {
  const ptSessions = ptUnitPrices.length;
  const ptRevenue = r0(ptUnitPrices.reduce((n, p) => n + p, 0));
  const tierRate = pickTierRate(privateRule?.tierRates, ptRevenue);
  const ptCommission = r0(ptRevenue * tierRate);
  const ptSessionBonus = r0(ptSessions * (Number(privateRule?.sessionBonus) || 0));
  const held = groupHeads.filter((h) => h > 0);
  const heads = held.reduce((n, h) => n + h, 0);
  const groupHeadBonus = r0(heads * (Number(groupRule?.perHeadRate) || 0));
  const groupSessionBonus = r0(held.length * (Number(groupRule?.sessionBonus) || 0));
  return {
    ptSessions,
    ptRevenue,
    tierRate,
    ptCommission,
    ptSessionBonus,
    groupClasses: held.length,
    groupHeads: heads,
    groupHeadBonus,
    groupSessionBonus,
    total: ptCommission + ptSessionBonus + groupHeadBonus + groupSessionBonus,
    rules: {
      PRIVATE: privateRule ? { id: privateRule.id, scope: privateRule.trainerId ? 'TRAINER' : 'DEFAULT' } : null,
      GROUP: groupRule ? { id: groupRule.id, scope: groupRule.trainerId ? 'TRAINER' : 'DEFAULT' } : null,
    },
  };
}

/**
 * 區間業績（課程開始時間落在 [start, end)，且已結束）
 * @returns {Promise<Map<number, ReturnType<typeof computeCoachPerformance>>>}
 */
export async function coachPerformanceBetween({ trainerIds, start, end }) {
  if (!trainerIds.length) return new Map();
  const until = new Date(Math.min(end.getTime(), Date.now()));
  const [rulesById, ptAttendances, groupClasses] = await Promise.all([
    resolveRules(trainerIds),
    prisma.classAttendance.findMany({
      where: { class: { trainerId: { in: trainerIds }, type: 'PRIVATE', startAt: { gte: start, lt: end }, endAt: { lte: until } } },
      select: {
        memberId: true,
        class: {
          select: {
            trainerId: true,
            startAt: true,
            ptContract: { select: { pricePaid: true, totalSessions: true } },
          },
        },
      },
    }),
    prisma.class.findMany({
      where: { trainerId: { in: trainerIds }, type: 'GROUP', startAt: { gte: start, lt: end }, endAt: { lte: until } },
      select: { trainerId: true, _count: { select: { attendances: true } } },
    }),
  ]);

  const needFallback = ptAttendances.filter((a) => !a.class.ptContract && a.memberId);
  const fallbackContracts = needFallback.length
    ? await prisma.pTContract.findMany({
        where: {
          trainerId: { in: trainerIds },
          memberId: { in: [...new Set(needFallback.map((a) => a.memberId))] },
        },
        select: { trainerId: true, memberId: true, pricePaid: true, totalSessions: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
    : [];
  const unitPrice = (c) => (c && c.totalSessions > 0 ? Number(c.pricePaid) / c.totalSessions : 0);

  const pt = new Map(trainerIds.map((id) => [id, []]));
  for (const a of ptAttendances) {
    const contract =
      a.class.ptContract ??
      fallbackContracts.find((c) => c.trainerId === a.class.trainerId && c.memberId === a.memberId && c.createdAt <= a.class.startAt) ??
      null;
    pt.get(a.class.trainerId)?.push(unitPrice(contract));
  }
  const group = new Map(trainerIds.map((id) => [id, []]));
  for (const c of groupClasses) group.get(c.trainerId)?.push(c._count.attendances);

  return new Map(
    trainerIds.map((id) => {
      const rules = rulesById.get(id);
      return [
        id,
        computeCoachPerformance({
          privateRule: rules.PRIVATE,
          groupRule: rules.GROUP,
          ptUnitPrices: pt.get(id),
          groupHeads: group.get(id),
        }),
      ];
    }),
  );
}

/** 業績獎金明細（薪資單分列） */
export function performanceLines(p) {
  if (!p) return [];
  const lines = [];
  if (p.ptCommission) {
    lines.push({
      code: 'PERF_PT',
      label: `私教業績獎金（${p.ptSessions} 堂・業績 ${p.ptRevenue.toLocaleString('en-US')} × ${Math.round(p.tierRate * 10000) / 100}%）`,
      amount: p.ptCommission,
    });
  }
  if (p.ptSessionBonus) lines.push({ code: 'PERF_SESSION', label: `私教授課獎金（${p.ptSessions} 堂）`, amount: p.ptSessionBonus });
  if (p.groupSessionBonus) lines.push({ code: 'PERF_GROUP_SESSION', label: `團課授課獎金（${p.groupClasses} 堂）`, amount: p.groupSessionBonus });
  if (p.groupHeadBonus) lines.push({ code: 'PERF_GROUP_HEAD', label: `團課人頭獎金（${p.groupHeads} 人次）`, amount: p.groupHeadBonus });
  return lines;
}
