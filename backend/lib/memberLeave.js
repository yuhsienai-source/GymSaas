// lib/memberLeave.js — 會員權暫停（契約第十二條）：送審 → 核准 → 生效（效期順延＋定期定額暫停）
import prisma from './prisma.js';
import {
  UNLIMITED_MEMBER_PLAN,
  remainingExpireDays,
  shiftDateByDays,
} from './promotion.js';
import {
  resolveExpectedNextChargeAt,
  resumeCardSubscription,
} from './cardSubscription.js';
import {
  extractPeriodTradeNo,
  stopPayuniRecurringForSubscription,
} from './payuni.js';
import { deleteIdPhotoObject } from './idPhotoStorage.js';
import { hasDutyRankOrAbove } from './staffAccess.js';
import {
  LEAVE_CATEGORY_LABELS,
  LEAVE_REVIEW_WORKING_DAYS,
  addWorkingDays,
  medicalSuspensionSummary,
  reviewHolidayWindow,
  validateLeaveApplication,
} from './memberLeaveRules.js';
import { holidayKeySet } from './publicHolidayService.js';

const OPEN_STATUSES = ['PENDING', 'APPROVED', 'ACTIVE'];
const REJECT_REASON_MIN = 2;
const REJECT_REASON_MAX = 200;

function httpError(message, statusCode = 400, code = undefined) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function isLeavePlan(plan) {
  return plan === UNLIMITED_MEMBER_PLAN || plan === '月費會員';
}

/**
 * 請假順延後的下次扣款日（本地 00:00）
 * 若 DB 仍是 2099 佔位，先推算真實預期日再 +days
 */
function shiftSubscriptionNextChargeAt(sub, leaveDays, now = new Date()) {
  const base = resolveExpectedNextChargeAt(sub, now);
  const shifted = shiftDateByDays(base, leaveDays);
  shifted.setHours(0, 0, 0, 0);
  return shifted;
}

/**
 * 請假開始前：PERIOD 訂閱必須先 suspend PayUNi，否則畫面請假金流仍扣
 */
async function suspendPayuniForLeave(sub, { forceLocalOnly = false } = {}) {
  if (!sub || !extractPeriodTradeNo(sub)) {
    return { ok: true, skipped: true, message: '無 PayUNi 續期單' };
  }
  let payuniStop;
  try {
    payuniStop = await stopPayuniRecurringForSubscription(sub, { mode: 'suspend' });
  } catch (e) {
    payuniStop = { ok: false, message: e.message || '暫停 PayUNi 續期失敗' };
  }
  if (!payuniStop.ok && !payuniStop.skipped && !forceLocalOnly) {
    const err = httpError(
      payuniStop.message ||
        'PayUNi 續期尚未暫停，請假未建立（避免顯示已請假卻仍扣款）',
      409,
    );
    err.payuniStop = payuniStop;
    throw err;
  }
  return payuniStop;
}

/**
 * 銷假後恢復訂閱；閘機／自動銷假用 forceLocalOnly，避免卡入場
 */
async function resumeSubscriptionAfterLeave(
  subId,
  { now = new Date(), forceLocalOnly = true } = {},
) {
  if (!subId) return null;
  const sub = await prisma.cardSubscription.findUnique({ where: { id: subId } });
  if (!sub || sub.status !== 'PAUSED') return sub;
  try {
    const resumed = await resumeCardSubscription(sub.id, { now, forceLocalOnly });
    if (
      resumed?.payuniResume &&
      !resumed.payuniResume.ok &&
      !resumed.payuniResume.skipped
    ) {
      console.warn(
        `[請假銷假] ${subId} 本機已恢復，PayUNi：${resumed.payuniResume.message || '未啟用'}`,
      );
    }
    return resumed?.subscription || resumed;
  } catch (e) {
    console.warn(`[請假銷假] 恢復訂閱失敗 ${subId}:`, e.message);
    if (!forceLocalOnly) throw e;
    return sub;
  }
}

/**
 * 找會員目前可用的定期定額訂閱（ACTIVE／PAUSED）
 */
export async function findActiveSubscriptionForMember(memberId, { subscriptionId } = {}) {
  if (subscriptionId) {
    const sub = await prisma.cardSubscription.findUnique({
      where: { id: String(subscriptionId) },
      include: { promotion: true },
    });
    if (!sub || sub.memberId !== memberId) {
      throw httpError('訂閱不存在或不屬於此會員', 404);
    }
    return sub;
  }
  return prisma.cardSubscription.findFirst({
    where: {
      memberId,
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
    include: { promotion: true },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * 若請假已到期，自動銷假（清 leaveUntil；效期已於請假開始時預先順延）
 * 並恢復對應 PAUSED 訂閱（與 completeMemberLeaveOnSchedule 一致）
 */
export async function settleExpiredLeave(memberId, { now = new Date() } = {}) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member?.leaveUntil || new Date(member.leaveUntil) > now) {
    return { settled: false, member };
  }

  const active = await prisma.memberLeave.findFirst({
    where: { memberId, status: 'ACTIVE' },
    orderBy: { endAt: 'desc' },
  });

  const result = await prisma.$transaction(async (tx) => {
    if (active) {
      await tx.memberLeave.update({
        where: { id: active.id },
        data: { status: 'ENDED', endedAt: now },
      });
    }
    const updated = await tx.member.update({
      where: { id: memberId },
      data: { leaveUntil: null },
    });
    return { settled: true, member: updated, leave: active };
  });

  const subId = active?.subscriptionId;
  if (subId) {
    await resumeSubscriptionAfterLeave(subId, { now, forceLocalOnly: true });
  }

  return result;
}

/** 七工作日審核期限（排除週末與國定假日）；查假日曆用根 prisma，須於交易外呼叫 */
async function computeReviewDueAt(now) {
  const { fromKey, toKey } = reviewHolidayWindow(now);
  return addWorkingDays(now, LEAVE_REVIEW_WORKING_DAYS, await holidayKeySet(fromKey, toKey));
}

/** 回溯期間（起日～min(迄日, 現在)）不得有月費通行進場紀錄，否則與「暫停會員權之行使」矛盾 */
async function assertNoMonthlyCheckInDuring(db, memberId, startAt, endAt, now) {
  const until = endAt < now ? endAt : now;
  if (startAt >= until) return;
  const hit = await db.checkInLog.findFirst({
    where: {
      memberId,
      billingMode: '月費通行',
      status: { not: 'CANCELLED' },
      checkInAt: { gte: startAt, lt: until },
    },
    select: { checkInAt: true },
  });
  if (hit) {
    throw httpError(
      `暫停期間內已有月費進場紀錄（${hit.checkInAt.toISOString().slice(0, 10)}），不得回溯暫停`,
      409,
      'LEAVE_OVERLAPS_CHECKIN',
    );
  }
}

/**
 * 送出暫停申請（會員自助或櫃檯代建）：一律建立 PENDING，須 DUTY+ 核准才生效
 * @param {{ storageKey: string, fileName: string } | null} proof 已存私有儲存之證明
 */
export async function submitLeaveApplication({
  memberId,
  category,
  startDate,
  endDate,
  reason = null,
  subscriptionId,
  proof = null,
  source = 'MEMBER',
  staffId = null,
  now = new Date(),
}) {
  const rule = validateLeaveApplication({ category, startDate, endDate, hasProof: Boolean(proof), now });

  await settleExpiredLeave(memberId, { now });
  const sub = await findActiveSubscriptionForMember(memberId, { subscriptionId });
  const reviewDueAt = proof ? await computeReviewDueAt(now) : null;

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${memberId} FOR UPDATE`;
    if (!locked.length) throw httpError('找不到會員', 404);
    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!isLeavePlan(member.plan)) {
      throw httpError('僅無限使用／月費會員可辦理會籍暫停', 409, 'LEAVE_PLAN_INELIGIBLE');
    }
    if (!member.expireDate || new Date(member.expireDate) <= rule.startAt) {
      throw httpError('暫停起始日已超過會籍效期，無法暫停；請先續購', 409, 'LEAVE_MEMBERSHIP_EXPIRED');
    }
    const open = await tx.memberLeave.findFirst({
      where: { memberId, status: { in: OPEN_STATUSES } },
      select: { id: true, status: true },
    });
    if (open) {
      throw httpError('尚有待審、已核准或進行中的暫停申請', 409, 'LEAVE_ALREADY_OPEN');
    }
    if (rule.backdated) {
      await assertNoMonthlyCheckInDuring(tx, memberId, rule.startAt, rule.endAt, now);
    }

    return tx.memberLeave.create({
      data: {
        memberId,
        subscriptionId: sub?.id || null,
        category: rule.category,
        source: source === 'STAFF' ? 'STAFF' : 'MEMBER',
        days: rule.days,
        startAt: rule.startAt,
        endAt: rule.endAt,
        status: 'PENDING',
        reason: reason ? String(reason).trim().slice(0, 200) : null,
        staffId: staffId ?? null,
        proofStorageKey: proof?.storageKey ? String(proof.storageKey).slice(0, 500) : null,
        proofFileName: proof?.fileName ? String(proof.fileName).trim().slice(0, 120) : null,
        proofUploadedAt: proof ? now : null,
        proofDueAt: rule.proofDueAt,
        reviewDueAt,
      },
    });
  });
}

/** 傷病／疫情先送件者補附證明；補齊後起算七工作日審核期限 */
export async function attachLeaveProof({ leaveId, memberId, proof, now = new Date() }) {
  if (!proof?.storageKey) throw httpError('請提供證明檔案', 400, 'LEAVE_PROOF_REQUIRED');
  const leave = await prisma.memberLeave.findUnique({ where: { id: Number(leaveId) } });
  if (!leave || (memberId != null && leave.memberId !== memberId)) {
    throw httpError('找不到暫停申請', 404, 'LEAVE_NOT_FOUND');
  }
  const updated = await prisma.memberLeave.updateMany({
    where: { id: leave.id, status: 'PENDING' },
    data: {
      proofStorageKey: String(proof.storageKey).slice(0, 500),
      proofFileName: proof.fileName ? String(proof.fileName).trim().slice(0, 120) : null,
      proofUploadedAt: now,
      proofDueAt: null,
      reviewDueAt: leave.reviewDueAt ?? (await computeReviewDueAt(now)),
    },
  });
  if (!updated.count) throw httpError('僅待審中的申請可補附證明', 409, 'LEAVE_NOT_PENDING');
  if (leave.proofStorageKey && leave.proofStorageKey !== proof.storageKey) {
    await deleteIdPhotoObject(leave.proofStorageKey).catch(() => {});
  }
  return prisma.memberLeave.findUnique({ where: { id: leave.id } });
}

/** 會籍於核准／生效時仍須為可暫停方案、效期涵蓋起日，且暫停期間無月費進場（外部 I/O 前檢查） */
async function assertLeaveStillApplicable(db, leave, now) {
  const member = await db.member.findUnique({ where: { id: leave.memberId } });
  if (!member) throw httpError('找不到會員', 404, 'MEMBER_NOT_FOUND');
  if (!isLeavePlan(member.plan)) {
    throw httpError('目前方案不適用會員權暫停', 409, 'LEAVE_PLAN_INELIGIBLE');
  }
  if (!member.expireDate || new Date(member.expireDate) <= leave.startAt) {
    throw httpError('暫停起始日已超過會籍效期', 409, 'LEAVE_MEMBERSHIP_EXPIRED');
  }
  await assertNoMonthlyCheckInDuring(db, leave.memberId, leave.startAt, leave.endAt, now);
  return member;
}

const AUTO_REJECT_CODES = new Set(['LEAVE_PLAN_INELIGIBLE', 'LEAVE_MEMBERSHIP_EXPIRED', 'LEAVE_OVERLAPS_CHECKIN']);

/**
 * 生效：效期順延 days、閘機擋月費通行至 endAt、定期定額暫停並順延扣款日。
 * 回溯且已期滿者直接結案（只順延效期與扣款日，不暫停訂閱）。
 */
async function activateLeave(leaveId, { now = new Date(), forceLocalOnly = false } = {}) {
  const leave = await prisma.memberLeave.findUnique({ where: { id: leaveId } });
  if (!leave || leave.status !== 'APPROVED') {
    throw httpError('僅已核准之暫停可生效', 409, 'LEAVE_STATE_CHANGED');
  }
  const member = await assertLeaveStillApplicable(prisma, leave, now);

  const ended = leave.endAt <= now;
  const sub = leave.subscriptionId
    ? await prisma.cardSubscription.findUnique({ where: { id: leave.subscriptionId }, include: { promotion: true } })
    : await findActiveSubscriptionForMember(leave.memberId);
  const payuniStop = ended ? null : await suspendPayuniForLeave(sub, { forceLocalOnly });

  const expireDateBefore = new Date(member.expireDate);
  const newExpire = shiftDateByDays(expireDateBefore, leave.days);
  const nextChargeAtBefore = sub ? resolveExpectedNextChargeAt(sub, now) : null;
  const nextChargeAtAfter = sub ? shiftSubscriptionNextChargeAt(sub, leave.days, now) : null;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.memberLeave.updateMany({
      where: { id: leave.id, status: 'APPROVED' },
      data: {
        status: ended ? 'ENDED' : 'ACTIVE',
        subscriptionId: sub?.id || null,
        expireDateBefore,
        nextChargeAtBefore,
        ...(ended ? { endedAt: now, frozenDays: leave.days } : {}),
      },
    });
    if (!claimed.count) throw httpError('暫停狀態已變更，請重新整理', 409, 'LEAVE_STATE_CHANGED');
    await assertNoMonthlyCheckInDuring(tx, leave.memberId, leave.startAt, leave.endAt, now);

    await tx.member.update({
      where: { id: leave.memberId },
      data: { expireDate: newExpire, ...(ended ? {} : { leaveUntil: leave.endAt }) },
    });

    if (!sub) return;
    const payuniNote =
      payuniStop && !payuniStop.skipped
        ? payuniStop.ok
          ? '；PayUNi 已暫停'
          : `；PayUNi：${String(payuniStop.message || '').slice(0, 80)}`
        : '';
    const until = leave.endAt.toISOString().slice(0, 10);
    if (ended) {
      await tx.cardSubscription.update({ where: { id: sub.id }, data: { nextChargeAt: nextChargeAtAfter } });
    } else if (sub.status === 'ACTIVE') {
      await tx.cardSubscription.update({
        where: { id: sub.id },
        data: { status: 'PAUSED', nextChargeAt: nextChargeAtAfter, lastError: `請假中至 ${until}${payuniNote}`.slice(0, 200) },
      });
    } else if (sub.status === 'PAUSED') {
      await tx.cardSubscription.update({
        where: { id: sub.id },
        data: { nextChargeAt: nextChargeAtAfter, lastError: `請假中至 ${until}（原已暫停）${payuniNote}`.slice(0, 200) },
      });
    }
  });

  return {
    leave: await prisma.memberLeave.findUnique({ where: { id: leave.id } }),
    member: await prisma.member.findUnique({ where: { id: leave.memberId } }),
    subscription: sub ? await prisma.cardSubscription.findUnique({ where: { id: sub.id } }) : null,
    payuniStop,
    remainingDaysBefore: remainingExpireDays(expireDateBefore, now),
    expireDateAfter: newExpire,
  };
}

/**
 * 核准（DUTY+）：須已附證明；起日已到即生效，未到改 APPROVED 由排程於起日生效
 */
export async function approveMemberLeave({ leaveId, user, note = null, now = new Date(), forceLocalOnly = false }) {
  if (!hasDutyRankOrAbove(user)) {
    throw httpError('審核會籍暫停限值班主管（DUTY）以上', 403, 'DUTY_ROLE_REQUIRED_FOR_LEAVE_REVIEW');
  }
  const leave = await prisma.memberLeave.findUnique({ where: { id: Number(leaveId) } });
  if (!leave) throw httpError('找不到暫停申請', 404, 'LEAVE_NOT_FOUND');
  if (leave.status !== 'PENDING') throw httpError('僅待審中的申請可核准', 409, 'LEAVE_NOT_PENDING');
  if (!leave.proofStorageKey) {
    throw httpError('尚未檢附證明文件，不得核准', 409, 'LEAVE_PROOF_REQUIRED');
  }
  await assertLeaveStillApplicable(prisma, leave, now);

  const claimed = await prisma.memberLeave.updateMany({
    where: { id: leave.id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      reviewedByStaffId: user?.id ?? null,
      reviewedAt: now,
      reviewNote: note ? String(note).trim().slice(0, REJECT_REASON_MAX) : null,
    },
  });
  if (!claimed.count) throw httpError('暫停狀態已變更，請重新整理', 409, 'LEAVE_STATE_CHANGED');

  if (leave.startAt > now) {
    return { scheduled: true, leave: await prisma.memberLeave.findUnique({ where: { id: leave.id } }) };
  }
  return { scheduled: false, ...(await activateLeave(leave.id, { now, forceLocalOnly })) };
}

/** 退回（DUTY+，必填原因）：待審，或已核准尚未開始者 */
export async function rejectMemberLeave({ leaveId, user, reason, now = new Date() }) {
  if (!hasDutyRankOrAbove(user)) {
    throw httpError('審核會籍暫停限值班主管（DUTY）以上', 403, 'DUTY_ROLE_REQUIRED_FOR_LEAVE_REVIEW');
  }
  const text = String(reason ?? '').trim();
  if (text.length < REJECT_REASON_MIN) {
    throw httpError('請填寫退回原因（至少 2 字）', 400, 'LEAVE_REJECT_REASON_REQUIRED');
  }
  const updated = await prisma.memberLeave.updateMany({
    where: { id: Number(leaveId), status: { in: ['PENDING', 'APPROVED'] } },
    data: {
      status: 'REJECTED',
      reviewedByStaffId: user?.id ?? null,
      reviewedAt: now,
      reviewNote: text.slice(0, REJECT_REASON_MAX),
      endedAt: now,
    },
  });
  if (!updated.count) throw httpError('僅待審或尚未開始之暫停可退回', 409, 'LEAVE_NOT_PENDING');
  return prisma.memberLeave.findUnique({ where: { id: Number(leaveId) } });
}

/**
 * 提早銷假：扣回未休完天數的效期／扣款順延，恢復訂閱
 */
export async function endMemberLeaveEarly({
  memberId,
  leaveId,
  reason,
  resumeSubscription = true,
  forceLocalOnly = false,
  now = new Date(),
} = {}) {
  const leave = leaveId
    ? await prisma.memberLeave.findUnique({ where: { id: Number(leaveId) } })
    : await prisma.memberLeave.findFirst({
        where: { memberId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });

  if (!leave || leave.memberId !== memberId) {
    throw httpError('找不到進行中的請假', 404);
  }
  if (leave.status !== 'ACTIVE') {
    throw httpError('此請假已結束');
  }

  const unusedLeaveDays = remainingExpireDays(leave.endAt, now);
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw httpError('找不到會員', 404);

  let newExpire = member.expireDate ? new Date(member.expireDate) : null;
  if (unusedLeaveDays > 0 && newExpire) {
    newExpire = shiftDateByDays(newExpire, -unusedLeaveDays);
    // 不可早於現在（銷假當下至少保有銷假前剩餘）
    if (newExpire < now) newExpire = new Date(now);
  }

  await prisma.$transaction(async (tx) => {
    await tx.memberLeave.update({
      where: { id: leave.id },
      data: {
        status: 'ENDED',
        endedAt: now,
        frozenDays: Math.max(0, leave.days - unusedLeaveDays),
        reason: reason
          ? `${leave.reason || ''}｜提早銷假：${String(reason).trim()}`.slice(0, 200)
          : leave.reason,
      },
    });
    await tx.member.update({
      where: { id: memberId },
      data: {
        leaveUntil: null,
        expireDate: newExpire,
      },
    });

    if (leave.subscriptionId && unusedLeaveDays > 0) {
      const sub = await tx.cardSubscription.findUnique({
        where: { id: leave.subscriptionId },
      });
      if (sub) {
        const rolled = shiftSubscriptionNextChargeAt(sub, -unusedLeaveDays, now);
        await tx.cardSubscription.update({
          where: { id: sub.id },
          data: {
            nextChargeAt: rolled,
            lastError: null,
          },
        });
      }
    }
  });

  let subscription = null;
  if (resumeSubscription && leave.subscriptionId) {
    subscription = await resumeSubscriptionAfterLeave(leave.subscriptionId, {
      now,
      forceLocalOnly,
    });
  }

  return {
    leave: await prisma.memberLeave.findUnique({ where: { id: leave.id } }),
    member: await prisma.member.findUnique({ where: { id: memberId } }),
    subscription,
    unusedLeaveDays,
  };
}

/**
 * 請假期滿銷假（僅清 leaveUntil／標記 ENDED；效期已預先順延不必再加）
 */
export async function completeMemberLeaveOnSchedule(leaveId, { now = new Date() } = {}) {
  const leave = await prisma.memberLeave.findUnique({ where: { id: leaveId } });
  if (!leave || leave.status !== 'ACTIVE') return null;
  if (new Date(leave.endAt) > now) {
    throw httpError('請假尚未到期，若要提早回來請用提早銷假');
  }

  await prisma.$transaction(async (tx) => {
    await tx.memberLeave.update({
      where: { id: leave.id },
      data: { status: 'ENDED', endedAt: now, frozenDays: leave.days },
    });
    await tx.member.update({
      where: { id: leave.memberId },
      data: { leaveUntil: null },
    });
  });

  if (leave.subscriptionId) {
    await resumeSubscriptionAfterLeave(leave.subscriptionId, {
      now,
      forceLocalOnly: true,
    });
  }

  return prisma.memberLeave.findUnique({
    where: { id: leave.id },
    include: { member: true, subscription: true },
  });
}

/** 對外回傳：隱藏儲存鍵、附事由標籤與審核逾期 */
export function toLeaveView(row, now = new Date()) {
  if (!row) return row;
  const { proofStorageKey, ...rest } = row;
  return {
    ...rest,
    hasProof: Boolean(proofStorageKey),
    categoryLabel: row.category ? LEAVE_CATEGORY_LABELS[row.category] || row.category : null,
    reviewOverdue: row.status === 'PENDING' && Boolean(row.reviewDueAt) && new Date(row.reviewDueAt) < now,
  };
}

export async function listMemberLeaves({ memberId, status, take = 50 } = {}) {
  const statuses = status ? String(status).split(',').map((s) => s.trim()).filter(Boolean) : null;
  return prisma.memberLeave.findMany({
    where: {
      ...(memberId ? { memberId: Number(memberId) } : {}),
      ...(statuses ? { status: { in: statuses } } : {}),
    },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          memberNo: true,
          phone: true,
          leaveUntil: true,
          expireDate: true,
          plan: true,
        },
      },
      subscription: {
        select: { id: true, status: true, nextChargeAt: true, amount: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, take),
  });
}

/** 傷病（第二款）累計凍結天數：滿 180 日得依第九點終止、免手續費（仍由 DUTY+ 選 EXEMPT 並核對診斷證明） */
export async function medicalSuspensionForMember(db, memberId, now = new Date()) {
  const leaves = await db.memberLeave.findMany({
    where: { memberId, category: 'MEDICAL', status: { in: ['ACTIVE', 'ENDED'] } },
    select: { category: true, status: true, days: true, frozenDays: true, startAt: true, endedAt: true },
  });
  return medicalSuspensionSummary(leaves, now);
}

/**
 * 排程：已核准且起日已到 → 生效；先送件逾期未補證明 → 自動退回；暫停期滿 → 結案恢復訂閱
 */
export async function processMemberLeaveQueue({ now = new Date() } = {}) {
  const out = { activated: 0, autoRejected: 0, proofExpired: 0, completed: 0, errors: [] };

  const due = await prisma.memberLeave.findMany({
    where: { status: 'APPROVED', startAt: { lte: now } },
    select: { id: true },
  });
  for (const row of due) {
    try {
      await activateLeave(row.id, { now });
      out.activated += 1;
    } catch (e) {
      if (!AUTO_REJECT_CODES.has(e.code)) {
        out.errors.push({ id: row.id, step: 'activate', message: e.message });
        continue;
      }
      const r = await prisma.memberLeave.updateMany({
        where: { id: row.id, status: 'APPROVED' },
        data: {
          status: 'REJECTED',
          reviewNote: `系統自動退回：${e.message}`.slice(0, REJECT_REASON_MAX),
          endedAt: now,
        },
      });
      out.autoRejected += r.count;
    }
  }

  const expired = await prisma.memberLeave.updateMany({
    where: { status: 'PENDING', proofStorageKey: null, proofDueAt: { lt: now } },
    data: { status: 'REJECTED', reviewedAt: now, reviewNote: '逾期未補附證明，系統自動退回', endedAt: now },
  });
  out.proofExpired = expired.count;

  const finished = await prisma.memberLeave.findMany({
    where: { status: 'ACTIVE', endAt: { lte: now } },
    select: { id: true },
  });
  for (const row of finished) {
    try {
      await completeMemberLeaveOnSchedule(row.id, { now });
      out.completed += 1;
    } catch (e) {
      out.errors.push({ id: row.id, step: 'complete', message: e.message });
    }
  }
  return out;
}

let leaveSchedulerTimer = null;

/** MEMBER_LEAVE_SCHEDULER=false 可停用（本機省 Neon 喚醒）；預設每 10 分鐘 */
export function startMemberLeaveScheduler(intervalMs) {
  if (leaveSchedulerTimer || String(process.env.MEMBER_LEAVE_SCHEDULER || '').toLowerCase() === 'false') return;
  const ms = Number(intervalMs) || Number(process.env.MEMBER_LEAVE_SCHEDULER_MS) || 10 * 60 * 1000;
  const tick = async () => {
    try {
      const r = await processMemberLeaveQueue();
      if (r.activated || r.autoRejected || r.proofExpired || r.completed || r.errors.length) {
        console.log('[會籍暫停排程]', JSON.stringify(r));
      }
    } catch (e) {
      console.error('[會籍暫停排程] 失敗', e.message);
    }
  };
  leaveSchedulerTimer = setInterval(() => void tick(), ms);
}

/**
 * 閘機／進場前：請假中擋月費；期滿自動清 leaveUntil 並恢復 PAUSED 訂閱
 * @param {{ now?: Date, tx?: object, afterCommit?: Array<() => Promise<unknown>> }} [opts]
 *   tx 內呼叫時必須傳 afterCommit：恢復訂閱會打 PayUNi，禁止在持有列鎖的交易內等待外部 I/O
 */
export async function assertMemberNotOnLeave(member, { now = new Date(), tx, afterCommit } = {}) {
  if (!member?.leaveUntil) return member;
  if (new Date(member.leaveUntil) > now) {
    throw httpError(
      `會員請假中（至 ${new Date(member.leaveUntil).toLocaleDateString('zh-TW')}），無法以無限方案進場`,
      403,
    );
  }
  const db = tx || prisma;
  const active = await db.memberLeave.findFirst({
    where: { memberId: member.id, status: 'ACTIVE' },
    orderBy: { endAt: 'desc' },
  });
  const updated = await db.member.update({
    where: { id: member.id },
    data: { leaveUntil: null },
  });
  await db.memberLeave.updateMany({
    where: { memberId: member.id, status: 'ACTIVE', endAt: { lte: now } },
    data: { status: 'ENDED', endedAt: now },
  });

  const subId = active?.subscriptionId;
  if (subId) {
    const resume = () => resumeSubscriptionAfterLeave(subId, { now, forceLocalOnly: true });
    if (tx) {
      if (!Array.isArray(afterCommit)) throw new Error('assertMemberNotOnLeave 於交易內呼叫必須提供 afterCommit');
      afterCommit.push(resume);
    } else {
      await resume();
    }
  }
  return updated;
}
