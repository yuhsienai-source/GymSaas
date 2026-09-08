// lib/memberLeave.js — 無限使用訂閱制月卡請假（效期順延 + 定期定額順延）
import prisma from './prisma.js';
import {
  UNLIMITED_MEMBER_PLAN,
  computeMemberExpireDate,
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

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
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

/**
 * 開始請假
 * - 效期：expireDate 預先 +days（時鐘不空轉）
 * - 進場：leaveUntil = endAt，閘機拒絕月費通行
 * - 訂閱：PERIOD 先 PayUNi suspend，再本機 PAUSED + nextChargeAt 順延 +days
 */
export async function startMemberLeave({
  memberId,
  days,
  reason,
  staffId,
  subscriptionId,
  forceLocalOnly = false,
  now = new Date(),
  proofStorageKey = null,
  proofFileName = null,
} = {}) {
  const leaveDays = parseInt(days, 10);
  if (!Number.isInteger(leaveDays) || leaveDays <= 0 || leaveDays > 365) {
    throw httpError('請假天數須為 1～365 的整數');
  }

  await settleExpiredLeave(memberId, { now });

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw httpError('找不到會員', 404);

  if (member.leaveUntil && new Date(member.leaveUntil) > now) {
    throw httpError('會員已在請假中，請先銷假或等待期滿');
  }

  const existing = await prisma.memberLeave.findFirst({
    where: { memberId, status: 'ACTIVE' },
  });
  if (existing) {
    throw httpError('尚有進行中的請假紀錄');
  }

  if (member.plan !== UNLIMITED_MEMBER_PLAN && member.plan !== '月費會員') {
    throw httpError('僅無限使用／月費會員可請假');
  }
  if (!member.expireDate || new Date(member.expireDate) <= now) {
    throw httpError('效期已到期，無法請假；請先續購');
  }

  const sub = await findActiveSubscriptionForMember(memberId, { subscriptionId });
  const payuniStop = await suspendPayuniForLeave(sub, { forceLocalOnly });

  const startAt = new Date(now);
  const endAt = shiftDateByDays(startAt, leaveDays);
  const expireDateBefore = member.expireDate ? new Date(member.expireDate) : null;
  // 快照用「可顯示的預期扣款日」（含把 2099 佔位還原），銷假／稽核才有意義
  const nextChargeAtBefore = sub ? resolveExpectedNextChargeAt(sub, now) : null;
  const newExpire = computeMemberExpireDate(member.expireDate, leaveDays, now);
  const nextChargeAtAfter = sub
    ? shiftSubscriptionNextChargeAt(sub, leaveDays, now)
    : null;

  const leave = await prisma.$transaction(async (tx) => {
    const row = await tx.memberLeave.create({
      data: {
        memberId,
        subscriptionId: sub?.id || null,
        days: leaveDays,
        startAt,
        endAt,
        expireDateBefore,
        nextChargeAtBefore,
        status: 'ACTIVE',
        reason: reason ? String(reason).trim().slice(0, 200) : null,
        staffId: staffId ?? null,
        proofStorageKey: proofStorageKey ? String(proofStorageKey).slice(0, 500) : null,
        proofFileName: proofFileName ? String(proofFileName).trim().slice(0, 120) : null,
      },
    });

    await tx.member.update({
      where: { id: memberId },
      data: {
        expireDate: newExpire,
        leaveUntil: endAt,
      },
    });

    const payuniNote =
      payuniStop && !payuniStop.skipped
        ? payuniStop.ok
          ? '；PayUNi 已暫停'
          : `；PayUNi：${String(payuniStop.message || '').slice(0, 80)}`
        : '';

    if (sub && sub.status === 'ACTIVE') {
      await tx.cardSubscription.update({
        where: { id: sub.id },
        data: {
          status: 'PAUSED',
          nextChargeAt: nextChargeAtAfter,
          lastError: `請假中至 ${endAt.toISOString().slice(0, 10)}${payuniNote}`.slice(
            0,
            200,
          ),
        },
      });
    } else if (sub && sub.status === 'PAUSED') {
      // 已暫停續扣：仍順延下次扣款，避免銷假後立刻扣；必要時已補 suspend
      await tx.cardSubscription.update({
        where: { id: sub.id },
        data: {
          nextChargeAt: nextChargeAtAfter,
          lastError:
            `請假中至 ${endAt.toISOString().slice(0, 10)}（原已暫停）${payuniNote}`.slice(
              0,
              200,
            ),
        },
      });
    }

    return row;
  });

  const updatedMember = await prisma.member.findUnique({ where: { id: memberId } });
  const updatedSub = sub
    ? await prisma.cardSubscription.findUnique({ where: { id: sub.id } })
    : null;

  return {
    leave,
    member: updatedMember,
    subscription: updatedSub,
    payuniStop,
    remainingDaysBefore: remainingExpireDays(expireDateBefore, now),
    expireDateAfter: newExpire,
  };
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
      data: { status: 'ENDED', endedAt: now },
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

export async function listMemberLeaves({ memberId, status, take = 50 } = {}) {
  return prisma.memberLeave.findMany({
    where: {
      ...(memberId ? { memberId: Number(memberId) } : {}),
      ...(status ? { status: String(status) } : {}),
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

/** 閘機／進場前：請假中擋月費；期滿自動清 leaveUntil 並恢復 PAUSED 訂閱 */
export async function assertMemberNotOnLeave(member, { now = new Date(), tx } = {}) {
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
    // 用 root client 恢復訂閱，避免卡在進場長交易裡；PayUNi 失敗不擋入場
    await resumeSubscriptionAfterLeave(subId, { now, forceLocalOnly: true });
  }
  return updated;
}
