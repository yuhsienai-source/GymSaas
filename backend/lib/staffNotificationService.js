// lib/staffNotificationService.js — 員工通知匣＋LINE 推播佇列
/**
 * notifyStaff() 寫入 StaffNotification（dedupeKey 去重）後非同步派送：
 *   已綁 LINE 且開啟推播 → pushLineText；未綁／關閉／未設定 Token → SKIPPED（站內通知匣仍可查看）。
 * 推播失敗標 FAILED，排程重試至 MAX_ATTEMPTS。任何錯誤皆不拋入主流程。
 * 訊息禁止含假由、證件號等敏感內容。
 */
import prisma from './prisma.js';
import { pushLineText } from './lineNotify.js';
import { buildFrontendRedirect } from './frontendUrl.js';
import { canonicalRole } from './orgStructure.js';

const MAX_ATTEMPTS = 5;
const DISPATCH_BATCH = 50;
const INBOX_LIMIT = 50;

let dispatching = false;
let dispatchQueued = false;

function uniqueIds(ids) {
  return [...new Set((ids || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
}

function frontendLink(link) {
  if (!link) return null;
  try {
    return buildFrontendRedirect(link);
  } catch {
    return null;
  }
}

function composeText(row) {
  const url = frontendLink(row.link);
  return [`【體育客】${row.title}`, '', row.body, url ? `\n${url}` : null].filter((x) => x != null).join('\n');
}

/**
 * @param {number[]} staffIds
 * @param {{ type: string, title: string, body: string, link?: string|null, dedupeKey?: string|null }
 *   | ((staffId: number) => { type: string, title: string, body: string, link?: string|null, dedupeKey?: string|null } | null)} payload
 *   dedupeKey 會自動加上 `:staffId`
 * @returns {Promise<number>} 新增筆數
 */
export async function notifyStaff(staffIds, payload) {
  try {
    const ids = uniqueIds(staffIds);
    if (!ids.length) return 0;
    const data = [];
    for (const staffId of ids) {
      const p = typeof payload === 'function' ? payload(staffId) : payload;
      if (!p?.type || !p?.title) continue;
      data.push({
        staffId,
        type: String(p.type),
        title: String(p.title).slice(0, 120),
        body: String(p.body || '').slice(0, 1500),
        link: p.link || null,
        dedupeKey: p.dedupeKey ? `${p.dedupeKey}:${staffId}` : null,
      });
    }
    if (!data.length) return 0;
    const { count } = await prisma.staffNotification.createMany({ data, skipDuplicates: true });
    if (count) scheduleDispatch();
    return count;
  } catch (err) {
    console.error('[staff-notify] 寫入通知失敗:', err.message);
    return 0;
  }
}

function scheduleDispatch() {
  setImmediate(() => {
    dispatchStaffNotifications().catch((err) => console.error('[staff-notify] 派送失敗:', err.message));
  });
}

async function deliver(row) {
  // 樂觀鎖認領：同一筆僅一個程序可遞增 attempts
  const claim = await prisma.staffNotification.updateMany({
    where: { id: row.id, status: row.status, attempts: row.attempts },
    data: { attempts: { increment: 1 } },
  });
  if (!claim.count) return;

  const staff = row.staff;
  let status;
  let lastError = null;
  if (!staff?.isActive) {
    status = 'SKIPPED';
    lastError = '帳號已停用';
  } else if (!staff.lineUserId) {
    status = 'SKIPPED';
    lastError = '未綁定 LINE';
  } else if (!staff.lineNotifyEnabled) {
    status = 'SKIPPED';
    lastError = '已關閉 LINE 推播';
  } else {
    const result = await pushLineText(staff.lineUserId, composeText(row));
    if (result.ok) status = 'SENT';
    else if (result.skipped) {
      status = 'SKIPPED';
      lastError = result.reason || null;
    } else {
      status = 'FAILED';
      lastError = String(result.reason || result.error || 'LINE 推播失敗').slice(0, 300);
    }
  }
  await prisma.staffNotification.update({
    where: { id: row.id },
    data: { status, lastError, sentAt: status === 'SENT' ? new Date() : null },
  });
}

async function drain(where) {
  let afterId = 0;
  for (;;) {
    const rows = await prisma.staffNotification.findMany({
      where: { ...where, id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take: DISPATCH_BATCH,
      include: { staff: { select: { isActive: true, lineUserId: true, lineNotifyEnabled: true } } },
    });
    for (const row of rows) await deliver(row);
    if (rows.length < DISPATCH_BATCH) return;
    afterId = rows[rows.length - 1].id;
  }
}

/**
 * 派送 PENDING；retryFailed=true（僅排程）時一併重試 attempts < MAX_ATTEMPTS 之 FAILED。
 * 同程序內不重入，期間新進通知於本輪結束後補派。
 */
export async function dispatchStaffNotifications({ retryFailed = false } = {}) {
  if (dispatching) {
    dispatchQueued = true;
    return;
  }
  dispatching = true;
  try {
    if (retryFailed) await drain({ status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } });
    do {
      dispatchQueued = false;
      await drain({ status: 'PENDING' });
    } while (dispatchQueued);
  } finally {
    dispatching = false;
  }
}

// ── 收件人 ──────────────────────────────────────────

const MANAGER_ROLES = ['STORE_MANAGER', 'MANAGER'];

/** 分店督導：本店（或 CLASS 之上層 GYM）店長；ACADEMY → FM；GYM 無店長時由 GM 代收 */
export async function branchManagerIds(branchId) {
  const id = Number(branchId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const branch = await prisma.branch.findUnique({
    where: { id },
    select: { id: true, type: true, parentId: true },
  });
  if (!branch) return [];
  if (branch.type === 'ACADEMY') {
    const fms = await prisma.staff.findMany({ where: { isActive: true, role: 'FM' }, select: { id: true } });
    return fms.map((s) => s.id);
  }
  const branchIds = [branch.id, branch.parentId].filter(Boolean);
  const managers = await prisma.staff.findMany({
    where: { isActive: true, role: { in: MANAGER_ROLES }, branchId: { in: branchIds } },
    select: { id: true },
  });
  if (managers.length) return managers.map((s) => s.id);
  const gms = await prisma.staff.findMany({ where: { isActive: true, role: 'GM' }, select: { id: true } });
  return gms.map((s) => s.id);
}

/** 教練週班表審核者：該分店（或上層 GYM）店長＋全部 FM */
export async function coachPlanReviewerIds(branchId) {
  const id = Number(branchId);
  const branch = Number.isInteger(id) && id > 0
    ? await prisma.branch.findUnique({ where: { id }, select: { id: true, parentId: true } })
    : null;
  const branchIds = branch ? [branch.id, branch.parentId].filter(Boolean) : [];
  const rows = await prisma.staff.findMany({
    where: {
      isActive: true,
      OR: [{ role: 'FM' }, ...(branchIds.length ? [{ role: { in: MANAGER_ROLES }, branchId: { in: branchIds } }] : [])],
    },
    select: { id: true },
  });
  return rows.map((s) => s.id);
}

export async function hqAdminIds() {
  const rows = await prisma.staff.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { id: true } });
  return rows.map((s) => s.id);
}

export function isManagerRole(role) {
  return canonicalRole(role) === 'STORE_MANAGER';
}

// ── 站內通知匣 ─────────────────────────────────────

function inboxRow(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    status: r.status,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    readAt: r.readAt,
  };
}

export async function listMyNotifications(staffId, { limit = INBOX_LIMIT } = {}) {
  const take = Math.min(Math.max(Number(limit) || INBOX_LIMIT, 1), 100);
  const [rows, unread] = await Promise.all([
    prisma.staffNotification.findMany({ where: { staffId }, orderBy: { id: 'desc' }, take }),
    prisma.staffNotification.count({ where: { staffId, readAt: null } }),
  ]);
  return { items: rows.map(inboxRow), unread };
}

/** ids 省略＝全部已讀；只能標記自己的通知 */
export async function markNotificationsRead(staffId, ids) {
  const list = Array.isArray(ids) ? uniqueIds(ids) : null;
  const { count } = await prisma.staffNotification.updateMany({
    where: { staffId, readAt: null, ...(list ? { id: { in: list } } : {}) },
    data: { readAt: new Date() },
  });
  return { updated: count };
}
