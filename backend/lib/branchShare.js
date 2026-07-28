// lib/branchShare.js — 分店購案歸屬與共享例外
// 預設：在哪購買只能在哪使用；例外見下方群組。
import prisma from './prisma.js';
import { staffBranchLabel } from './branchLabel.js';

/** 私教場地共享（可互上私教課） */
export const PRIVATE_VENUE_SHARE_GROUPS = [['HP', 'HR']];

/** 進出場館共享（閘機可互進） */
export const GATE_ACCESS_SHARE_GROUPS = [['AC', 'HP']];

function httpError(message, statusCode = 403) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return c || null;
}

function groupContaining(code, groups) {
  const c = normCode(code);
  if (!c) return null;
  return groups.find((g) => g.some((x) => normCode(x) === c)) || null;
}

/** 同一共享群組（含同店） */
export function codesShareGroup(codeA, codeB, groups) {
  const a = normCode(codeA);
  const b = normCode(codeB);
  if (!a || !b) return false;
  if (a === b) return true;
  const g = groupContaining(a, groups);
  return Boolean(g && g.some((x) => normCode(x) === b));
}

/** 將單一代碼展開為可使用的代碼集合（含共享群組） */
export function expandCodes(code, groups) {
  const c = normCode(code);
  if (!c) return [];
  const g = groupContaining(c, groups);
  return g ? g.map(normCode).filter(Boolean) : [c];
}

export function expandCodesFromList(codes, groups) {
  const out = new Set();
  for (const code of codes || []) {
    for (const c of expandCodes(code, groups)) out.add(c);
  }
  return [...out];
}

/**
 * 私教：購案分店 ↔ 上課場地分店是否允許
 * @param {{ id: number, code?: string|null, name?: string|null }|null} purchaseBranch
 * @param {{ id: number, code?: string|null, name?: string|null }|null} venueBranch
 */
export function isPrivateVenueAllowed(purchaseBranch, venueBranch) {
  if (!purchaseBranch || !venueBranch) return false;
  if (purchaseBranch.id === venueBranch.id) return true;
  return codesShareGroup(purchaseBranch.code, venueBranch.code, PRIVATE_VENUE_SHARE_GROUPS);
}

/**
 * 進出場：購案分店集合 ↔ 閘機分店是否允許
 * @param {Array<{ id: number, code?: string|null }>} entitlementBranches
 * @param {{ id: number, code?: string|null }|null} gateBranch
 */
export function isGateAccessAllowed(entitlementBranches, gateBranch) {
  if (!gateBranch) return true; // 未指定閘機分店：相容舊行為
  const list = entitlementBranches || [];
  if (list.length === 0) return false;
  if (list.some((b) => b.id === gateBranch.id)) return true;
  const gateCode = normCode(gateBranch.code);
  if (!gateCode) return list.some((b) => b.id === gateBranch.id);
  const allowed = new Set(
    expandCodesFromList(
      list.map((b) => b.code),
      GATE_ACCESS_SHARE_GROUPS,
    ),
  );
  return allowed.has(gateCode);
}

/** 團課：僅購買分店（無私教／閘機共享例外） */
export function isClassVenueAllowed(entitlementBranches, venueBranch) {
  if (!venueBranch) return false;
  const list = entitlementBranches || [];
  if (list.length === 0) return false;
  return list.some((b) => b.id === venueBranch.id);
}

export function assertPrivateVenueAllowed(purchaseBranch, venueBranch) {
  if (isPrivateVenueAllowed(purchaseBranch, venueBranch)) return;
  const buy = staffBranchLabel(purchaseBranch) || purchaseBranch?.id || '？';
  const at = staffBranchLabel(venueBranch) || venueBranch?.id || '？';
  throw httpError(
    `⛔ 私教上課分店不符：購案屬 [${buy}]，僅可在該店或共享私教場地上課（HP↔HR）；不可在 [${at}]`,
    403,
  );
}

export function assertGateAccessAllowed(entitlementBranches, gateBranch) {
  if (isGateAccessAllowed(entitlementBranches, gateBranch)) return;
  const gate = staffBranchLabel(gateBranch) || gateBranch?.id || '？';
  throw httpError(
    `⛔ 進出場分店不符：此會員無可進 [${gate}] 的購案（AC↔HP 進出場共享；其餘僅購買分店）`,
    403,
  );
}

export function assertGroupClassVenueAllowed(entitlementBranches, venueBranch) {
  if (isClassVenueAllowed(entitlementBranches, venueBranch)) return;
  const at = staffBranchLabel(venueBranch) || venueBranch?.id || '？';
  throw httpError(`⛔ 團課僅限購買分店上課，不可在 [${at}] 預約`, 403);
}

/** 依購案分店 + 私教共享，回傳可上課的 branchId 列表 */
export async function resolvePrivateVenueBranchIds(purchaseBranchId, db = prisma) {
  if (!purchaseBranchId) return [];
  const purchase = await db.branch.findUnique({
    where: { id: purchaseBranchId },
    select: { id: true, code: true },
  });
  if (!purchase) return [];
  const codes = expandCodes(purchase.code, PRIVATE_VENUE_SHARE_GROUPS);
  if (codes.length <= 1 && !purchase.code) return [purchase.id];
  const rows = await db.branch.findMany({
    where: {
      isActive: true,
      OR: [
        { id: purchase.id },
        ...(codes.length
          ? codes.map((code) => ({ code: { equals: code, mode: 'insensitive' } }))
          : []),
      ],
    },
    select: { id: true },
  });
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * 會員「進出場／團課」購案分店（儲值／月卡／合併結帳／銷貨）
 */
export async function resolveMemberFacilityBranches(memberId, db = prisma) {
  const mid = parseInt(memberId, 10);
  if (!Number.isInteger(mid)) return [];

  const idSet = new Set();

  const [sessions, sales, subs, orders] = await Promise.all([
    db.checkoutSession.findMany({
      where: { memberId: mid, status: 'PAID', branchId: { not: null } },
      select: { branchId: true },
      take: 100,
    }),
    db.saleOrder.findMany({
      where: { memberId: mid, status: 'PAID' },
      select: { branchId: true },
      take: 100,
    }),
    db.cardSubscription.findMany({
      where: { memberId: mid, status: { in: ['ACTIVE', 'PAUSED'] } },
      select: { promotion: { select: { branchId: true } } },
      take: 50,
    }),
    db.order.findMany({
      where: { memberId: mid, status: 'PAID' },
      select: { itemDesc: true, checkoutSessionId: true },
      orderBy: { createdAt: 'desc' },
      take: 80,
    }),
  ]);

  for (const s of sessions) if (s.branchId) idSet.add(s.branchId);
  for (const s of sales) if (s.branchId) idSet.add(s.branchId);
  for (const s of subs) {
    const bid = s.promotion?.branchId;
    if (bid) idSet.add(bid);
  }

  const sessionIds = [
    ...new Set(orders.map((o) => o.checkoutSessionId).filter(Boolean)),
  ];
  if (sessionIds.length) {
    const sess = await db.checkoutSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, branchId: true },
    });
    for (const s of sess) if (s.branchId) idSet.add(s.branchId);
  }

  const promoIds = [];
  for (const o of orders) {
    const m = String(o.itemDesc || '').match(/商品#(\d+)/);
    if (m) promoIds.push(Number(m[1]));
  }
  if (promoIds.length) {
    const promos = await db.promotion.findMany({
      where: { id: { in: [...new Set(promoIds)] } },
      select: { branchId: true },
    });
    for (const p of promos) if (p.branchId) idSet.add(p.branchId);
  }

  if (idSet.size === 0) return [];

  return db.branch.findMany({
    where: { id: { in: [...idSet] }, isActive: true },
    select: { id: true, name: true, code: true },
  });
}

export async function loadBranch(branchId, db = prisma) {
  if (!branchId) return null;
  return db.branch.findFirst({
    where: { id: Number(branchId), isActive: true },
    select: { id: true, name: true, code: true },
  });
}
