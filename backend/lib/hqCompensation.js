// lib/hqCompensation.js — 總部合規補償：運動金／效期／解鎖警示（append-only 日誌）
import prisma from './prisma.js';
import { getRequestClientMeta } from './contractAudit.js';
import {
  UNLIMITED_MEMBER_PLAN,
  computeMemberExpireDate,
  isCompensationPromotion,
  isUnlimitedPromotion,
} from './promotion.js';
import { isCompensationCoursePlan } from './coursePlan.js';
import { staffBranchLabel } from './branchLabel.js';
import { isManagerTrainer } from './orgStructure.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from './walletMutation.js';

export const HQ_COMPENSATION_ACTIONS = ['BONUS', 'EXPIRE', 'CLEAR_ALERT', 'COURSE'];

const REASON_MIN = 4;
const REASON_MAX = 500;
const EXPIRE_DAYS_MAX = 90;

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function generateHqCompensationLogId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `HCL${dateStr}${randomStr}`;
}

export function normalizeCompensationReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < REASON_MIN) {
    throw httpError(`reason 必填（客訴結案單號或原因，至少 ${REASON_MIN} 字）`);
  }
  if (text.length > REASON_MAX) {
    throw httpError(`reason 過長（最多 ${REASON_MAX} 字）`);
  }
  return text;
}

function assertNoFreeformBonusFields(body = {}) {
  const forbidden = [
    'amount',
    'bonusAmount',
    'bonusGiven',
    'cashAmount',
    'cashWallet',
    'bonusWallet',
    'value',
  ];
  const hit = forbidden.filter((k) => body[k] !== undefined);
  if (hit.length > 0) {
    throw httpError(
      `⛔ 禁止自由輸入補償金額欄位 [${hit.join(', ')}]；請改綁定客訴補償專案 promotionId`,
    );
  }
}

function assertNoFreeformCourseFields(body = {}) {
  const forbidden = [
    'sessions',
    'totalSessions',
    'pricePaid',
    'amount',
    'price',
    'qty',
  ];
  const hit = forbidden.filter((k) => body[k] !== undefined);
  if (hit.length > 0) {
    throw httpError(
      `⛔ 禁止自填堂數／金額 [${hit.join(', ')}]；請改綁定客訴補償課程 coursePlanId（堂數以方案為準）`,
    );
  }
}

async function writeLog(tx, {
  action,
  memberId,
  actorStaffId,
  promotionId,
  coursePlanId,
  reason,
  detail,
  ipAddress,
  userAgent,
}) {
  return tx.hqCompensationLog.create({
    data: {
      id: generateHqCompensationLogId(),
      action,
      memberId,
      actorStaffId,
      promotionId: promotionId ?? null,
      coursePlanId: coursePlanId ?? null,
      reason,
      detail: detail ?? undefined,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
  });
}

const memberSelect = {
  id: true,
  memberNo: true,
  name: true,
  phone: true,
  plan: true,
  expireDate: true,
  cashWallet: true,
  bonusWallet: true,
  isAlert: true,
};

/**
 * 1) 補償運動金：僅允許 kind=COMPENSATION 且 price=0 的 Promotion
 */
export async function grantCompensationBonus({
  memberId,
  promotionId,
  reason,
  actorStaffId,
  req,
  body = {},
}) {
  assertNoFreeformBonusFields(body);
  const reasonText = normalizeCompensationReason(reason);
  const mid = parseInt(memberId, 10);
  const pid = parseInt(promotionId, 10);
  if (!Number.isInteger(mid) || mid <= 0) throw httpError('無效的 memberId');
  if (!Number.isInteger(pid) || pid <= 0) {
    throw httpError('必須提供 promotionId（客訴補償專案）');
  }
  if (!Number.isInteger(actorStaffId) || actorStaffId <= 0) {
    throw httpError('缺少操作人員', 401);
  }

  const meta = getRequestClientMeta(req);

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: mid }, select: memberSelect });
    if (!member) throw httpError('找不到會員', 404);

    const promotion = await tx.promotion.findUnique({ where: { id: pid } });
    if (!promotion) throw httpError('找不到此促銷方案', 404);
    if (!isCompensationPromotion(promotion)) {
      throw httpError('僅能配發 kind=COMPENSATION 的客訴補償專案');
    }
    if (!promotion.isActive) {
      throw httpError(`補償專案 [${promotion.name}] 已停用`);
    }
    if (isUnlimitedPromotion(promotion)) {
      throw httpError('客訴補償專案不可為無限使用方案');
    }
    if (Number(promotion.price) !== 0) {
      throw httpError('客訴補償專案 price 必須為 0');
    }
    const bonusAdded = roundMoney(promotion.bonusGiven);
    if (bonusAdded <= 0) {
      throw httpError('客訴補償專案 bonusGiven 必須大於 0');
    }

    await mutateMemberWallet(tx, {
      memberId: mid,
      txType: WALLET_TX.HQ_COMPENSATION,
      mode: WALLET_MODE.CREDIT_BUCKETS,
      cashDelta: 0,
      bonusDelta: bonusAdded,
      reason: `總部客訴補償 ${promotion.name}：${reasonText}`,
      refType: 'HQ_COMPENSATION',
      refId: pid,
      staffId: actorStaffId,
    });
    const updatedMember = await tx.member.findUnique({ where: { id: mid }, select: memberSelect });

    const log = await writeLog(tx, {
      action: 'BONUS',
      memberId: mid,
      actorStaffId,
      promotionId: pid,
      reason: reasonText,
      detail: {
        promotionName: promotion.name,
        bonusAdded,
        bonusWalletBefore: roundMoney(member.bonusWallet),
        bonusWalletAfter: roundMoney(updatedMember.bonusWallet),
      },
      ...meta,
    });

    return { member: updatedMember, promotion, bonusAdded, log };
  });
}

/**
 * 2) 補償效期：展延 expireDate；計時會員一併升為無限會員以暫時免降級／計時扣款
 */
export async function grantCompensationExpire({
  memberId,
  days,
  reason,
  actorStaffId,
  req,
  now = new Date(),
}) {
  const reasonText = normalizeCompensationReason(reason);
  const mid = parseInt(memberId, 10);
  const dayCount = parseInt(days, 10);
  if (!Number.isInteger(mid) || mid <= 0) throw httpError('無效的 memberId');
  if (!Number.isInteger(dayCount) || dayCount <= 0) {
    throw httpError('days 必須為正整數（補償天數）');
  }
  if (dayCount > EXPIRE_DAYS_MAX) {
    throw httpError(`單次效期補償最多 ${EXPIRE_DAYS_MAX} 天`);
  }
  if (!Number.isInteger(actorStaffId) || actorStaffId <= 0) {
    throw httpError('缺少操作人員', 401);
  }

  const meta = getRequestClientMeta(req);

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: mid }, select: memberSelect });
    if (!member) throw httpError('找不到會員', 404);

    const expireDateBefore = member.expireDate ? new Date(member.expireDate) : null;
    const planBefore = member.plan;
    const expireDateAfter = computeMemberExpireDate(expireDateBefore, dayCount, now);
    const planAfter =
      planBefore === UNLIMITED_MEMBER_PLAN || planBefore === '月費會員'
        ? planBefore
        : UNLIMITED_MEMBER_PLAN;

    const updatedMember = await tx.member.update({
      where: { id: mid },
      data: {
        expireDate: expireDateAfter,
        plan: planAfter,
      },
      select: memberSelect,
    });

    const log = await writeLog(tx, {
      action: 'EXPIRE',
      memberId: mid,
      actorStaffId,
      reason: reasonText,
      detail: {
        days: dayCount,
        planBefore,
        planAfter,
        expireDateBefore,
        expireDateAfter,
      },
      ...meta,
    });

    return { member: updatedMember, days: dayCount, expireDateBefore, expireDateAfter, log };
  });
}

/**
 * 3) 解鎖帳號：清除 isAlert（僅 ADMIN／HQ 路徑應呼叫）
 */
export async function clearMemberAlert({
  memberId,
  reason,
  actorStaffId,
  req,
}) {
  const reasonText = normalizeCompensationReason(reason);
  const mid = parseInt(memberId, 10);
  if (!Number.isInteger(mid) || mid <= 0) throw httpError('無效的 memberId');
  if (!Number.isInteger(actorStaffId) || actorStaffId <= 0) {
    throw httpError('缺少操作人員', 401);
  }

  const meta = getRequestClientMeta(req);

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: mid }, select: memberSelect });
    if (!member) throw httpError('找不到會員', 404);

    if (!member.isAlert) {
      const log = await writeLog(tx, {
        action: 'CLEAR_ALERT',
        memberId: mid,
        actorStaffId,
        reason: reasonText,
        detail: { alreadyCleared: true, isAlertBefore: false, isAlertAfter: false },
        ...meta,
      });
      return { member, alreadyCleared: true, log };
    }

    const updatedMember = await tx.member.update({
      where: { id: mid },
      data: { isAlert: false },
      select: memberSelect,
    });

    const log = await writeLog(tx, {
      action: 'CLEAR_ALERT',
      memberId: mid,
      actorStaffId,
      reason: reasonText,
      detail: { alreadyCleared: false, isAlertBefore: true, isAlertAfter: false },
      ...meta,
    });

    return { member: updatedMember, alreadyCleared: false, log };
  });
}

/**
 * 4) 補償課程：僅允許 kind=COMPENSATION 且 price=0 的 CoursePlan；建立 source=COMPENSATION 的 PTContract
 */
export async function grantCompensationCourse({
  memberId,
  coursePlanId,
  trainerId,
  reason,
  actorStaffId,
  req,
  body = {},
}) {
  assertNoFreeformCourseFields(body);
  const reasonText = normalizeCompensationReason(reason);
  const mid = parseInt(memberId, 10);
  const pid = parseInt(coursePlanId, 10);
  const tid = parseInt(trainerId, 10);
  if (!Number.isInteger(mid) || mid <= 0) throw httpError('無效的 memberId');
  if (!Number.isInteger(pid) || pid <= 0) {
    throw httpError('必須提供 coursePlanId（客訴補償課程方案）');
  }
  if (!Number.isInteger(tid) || tid <= 0) {
    throw httpError('必須提供 trainerId（綁定授課堂數的教練）');
  }
  if (!Number.isInteger(actorStaffId) || actorStaffId <= 0) {
    throw httpError('缺少操作人員', 401);
  }

  const meta = getRequestClientMeta(req);

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: mid }, select: memberSelect });
    if (!member) throw httpError('找不到會員', 404);

    const plan = await tx.coursePlan.findUnique({
      where: { id: pid },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    if (!plan) throw httpError('找不到此課程方案', 404);
    if (!isCompensationCoursePlan(plan)) {
      throw httpError('僅能配發 kind=COMPENSATION 的客訴補償課程');
    }
    if (!plan.isActive) {
      throw httpError(`補償課程 [${plan.name}] 已停用`);
    }
    if (plan.planType !== 'CUSTOM_PT') {
      throw httpError('客訴補償課程僅限客製化私教');
    }
    if (Number(plan.price) !== 0) {
      throw httpError('客訴補償課程 price 必須為 0');
    }
    const sessions = parseInt(plan.sessions, 10);
    if (!Number.isInteger(sessions) || sessions <= 0) {
      throw httpError('客訴補償課程未設定堂數');
    }

    const trainer = await tx.trainer.findUnique({
      where: { id: tid },
      include: { branches: { select: { branchId: true } } },
    });
    if (!trainer || !trainer.isActive) {
      throw httpError('找不到此教練或教練已停用', 404);
    }
    const trainerBranchIds = new Set(trainer.branches.map((b) => b.branchId));
    if (!isManagerTrainer(trainer) && !trainerBranchIds.has(plan.branchId)) {
      throw httpError(
        `教練無權承接分店「${staffBranchLabel(plan.branch) || plan.branchId}」的補償課程`,
        403,
      );
    }

    const contract = await tx.pTContract.create({
      data: {
        memberId: mid,
        trainerId: tid,
        coursePlanId: plan.id,
        branchId: plan.branchId,
        source: 'COMPENSATION',
        totalSessions: sessions,
        usedSessions: 0,
        pricePaid: 0,
        isActive: true,
      },
      include: {
        member: { select: { id: true, name: true, memberNo: true } },
        trainer: { select: { id: true, name: true, displayName: true } },
        coursePlan: { select: { id: true, name: true, sessions: true, kind: true } },
      },
    });

    const log = await writeLog(tx, {
      action: 'COURSE',
      memberId: mid,
      actorStaffId,
      coursePlanId: plan.id,
      reason: reasonText,
      detail: {
        coursePlanName: plan.name,
        sessions,
        trainerId: tid,
        trainerName: trainer.name,
        contractId: contract.id,
        source: 'COMPENSATION',
        pricePaid: 0,
      },
      ...meta,
    });

    return { member, contract, coursePlan: plan, sessions, log };
  });
}

export async function listHqCompensationLogs({
  memberId,
  action,
  limit = 50,
} = {}) {
  const where = {};
  if (memberId != null && memberId !== '') {
    const mid = parseInt(memberId, 10);
    if (!Number.isInteger(mid)) throw httpError('無效的 memberId');
    where.memberId = mid;
  }
  if (action) {
    const a = String(action).toUpperCase();
    if (!HQ_COMPENSATION_ACTIONS.includes(a)) {
      throw httpError(`action 無效，允許：${HQ_COMPENSATION_ACTIONS.join(' / ')}`);
    }
    where.action = a;
  }
  const take = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  return prisma.hqCompensationLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      member: { select: { id: true, memberNo: true, name: true, phone: true } },
      actorStaff: { select: { id: true, account: true, name: true } },
      promotion: { select: { id: true, name: true, bonusGiven: true, price: true, kind: true } },
      coursePlan: { select: { id: true, name: true, sessions: true, price: true, kind: true } },
    },
  });
}
