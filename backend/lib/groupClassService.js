// lib/groupClassService.js — 付費期班團課：報名保留／付款啟用／候補遞補／請假補課／退費／期班取消
import prisma from './prisma.js';
import {
  TERM,
  DROP_IN,
  HOLD_MINUTES,
  WAITLIST_OFFER_HOURS,
  LEAVE_MIN_HOURS,
  normalizeEnrollKind,
  quoteTermPrice,
  quoteDropInPrice,
  computeSeatAvailability,
  canLeaveWithMakeup,
  makeupExpiresAt,
  computeGroupRefund,
  splitRefundChannels,
  roundNtd,
} from './groupClassRules.js';
import { generateGroupOrderId } from './orderIds.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from './walletMutation.js';
import { assertMemberSignedCoursePlanContracts } from './memberContract.js';
import { pushLineText } from './lineNotify.js';
import { issueOrderInvoice, saveInvoiceRequest, issuedInvoiceFor, cancelUnissuedInvoices } from './einvoice.js';
import {
  resolveOrderInvoiceReverse,
  executeInvoiceReverse,
  appendInvoiceReverseNote,
  syncCheckoutInvoiceAfterReverse,
  reevaluateCheckoutSessionStatus,
} from './ezpayReverse.js';
import { refundLinePayPayment } from './linepay.js';
import { memberBranchLabel, staffBranchLabel } from './branchLabel.js';
import { formatWeekdaysLabel } from './groupClassSeries.js';
import { resolveDisplayName } from './displayName.js';

const ACTIVE_RES = ['PENDING', 'CONFIRMED'];
const HOUR_MS = 3600 * 1000;

function httpError(message, statusCode = 400, code = undefined) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export async function lockSeriesRow(tx, seriesId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM "ClassSeries" WHERE id = ${seriesId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

const seriesInclude = {
  coursePlan: {
    select: { id: true, name: true, requiresMemberContract: true, branchId: true },
  },
  venue: { include: { branch: { select: { id: true, name: true, code: true, parentId: true } } } },
  station: { select: { id: true, name: true } },
  trainer: { select: { id: true, name: true, displayName: true } },
};

/**
 * 讀取期班現況：剩餘堂次空位、候補佔位
 * @param {{ memberId?: number|null, now?: Date }} opts memberId＝排除本人之候補佔位
 */
export async function loadSeriesState(tx, seriesId, { memberId = null, now = new Date() } = {}) {
  const series = await tx.classSeries.findUnique({ where: { id: seriesId }, include: seriesInclude });
  if (!series) throw httpError('找不到此期班', 404);
  const classes = await tx.class.findMany({
    where: { seriesId },
    orderBy: { startAt: 'asc' },
    select: {
      id: true,
      startAt: true,
      endAt: true,
      capacity: true,
      _count: { select: { reservations: { where: { status: { in: ACTIVE_RES } } } } },
    },
  });
  const withFree = classes.map((c) => ({
    id: c.id,
    startAt: c.startAt,
    endAt: c.endAt,
    capacity: c.capacity,
    booked: c._count.reservations,
    free: Math.max(0, c.capacity - c._count.reservations),
  }));
  const future = withFree.filter((c) => c.startAt > now);
  const minFree = future.length ? Math.min(...future.map((c) => c.free)) : 0;
  const waitlist = await tx.groupWaitlist.findMany({
    where: { seriesId, status: { in: ['WAITING', 'OFFERED'] } },
    orderBy: { createdAt: 'asc' },
  });
  const liveOffers = waitlist.filter(
    (w) => w.status === 'OFFERED' && w.offerExpiresAt && w.offerExpiresAt > now,
  );
  const waiting = waitlist.filter((w) => w.status === 'WAITING');
  const offersOthers = liveOffers.filter((w) => w.memberId !== memberId).length;
  // 只有排在本人之前的候補才佔位：已遞補者優先於所有等待者
  const myOffered = memberId != null && liveOffers.some((w) => w.memberId === memberId);
  const myWaitIdx = memberId != null ? waiting.findIndex((w) => w.memberId === memberId) : -1;
  const waitingOthers = myOffered ? 0 : myWaitIdx >= 0 ? myWaitIdx : waiting.length;
  return {
    series,
    classes: withFree,
    future,
    minFree,
    waitlist,
    liveOffers,
    waiting,
    offersOthers,
    waitingOthers,
    termAvailability: computeSeatAvailability({ classFree: null, minFree, offersOthers, waitingOthers }).term,
  };
}

export function isSeriesSellable(series) {
  return Boolean(
    series &&
      series.coursePlanId &&
      series.termPrice != null &&
      series.sessionCount &&
      series.status === 'OPEN' &&
      series.isActive,
  );
}

export function assertSeriesSellable(series) {
  if (!series) throw httpError('找不到此期班', 404);
  if (!series.coursePlanId || series.termPrice == null || !series.sessionCount) {
    throw httpError('此期班未綁定團課課程方案（舊資料），不開放報名', 409, 'SERIES_NOT_SELLABLE');
  }
  if (series.status !== 'OPEN' || !series.isActive) {
    throw httpError('此期班已取消或停止報名', 409, 'SERIES_CLOSED');
  }
}

function taipeiDateLabel(d) {
  return new Date(d).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function buildGroupItemDesc(series, kind, quote, cls = null) {
  if (kind === DROP_IN) {
    return `團課單堂 | ${series.title} | 期班#${series.id} | ${cls ? taipeiDateLabel(cls.startAt) : ''}`.slice(0, 200);
  }
  const label = quote.prorated ? `插班 ${quote.sessions}/${series.sessionCount} 堂` : `整期 ${quote.sessions} 堂`;
  return `團課期班 | ${series.title} | 期班#${series.id} | ${label}`.slice(0, 200);
}

/**
 * 後端報價（不寫入）；POS 購物車與會員報名共用
 */
export async function quoteGroupItem(tx, { seriesId, kind: kindRaw, classId = null, now = new Date() }) {
  const kind = normalizeEnrollKind(kindRaw);
  const state = await loadSeriesState(tx, seriesId, { now });
  assertSeriesSellable(state.series);
  if (kind === TERM) {
    const quote = quoteTermPrice({
      termPrice: state.series.termPrice,
      sessionCount: state.series.sessionCount,
      remainingSessions: state.future.length,
    });
    return { kind, quote, series: state.series, cls: null, itemDesc: buildGroupItemDesc(state.series, kind, quote) };
  }
  const cls = state.future.find((c) => c.id === Number(classId));
  if (!cls) throw httpError('單堂須為本期班尚未開始之堂次', 400);
  const quote = quoteDropInPrice(state.series);
  return { kind, quote, series: state.series, cls, itemDesc: buildGroupItemDesc(state.series, kind, quote, cls) };
}

/**
 * 建立待付款報名：鎖期班列 → 檢查名額／候補優先 → GRP 訂單＋PENDING 預約保留名額
 */
export async function createEnrollmentHold(tx, {
  memberId,
  seriesId,
  kind: kindRaw,
  classId = null,
  source,
  staffId = null,
  checkoutSessionId = null,
  payMethod = null,
  payBreakdown = null,
  voucherCode = null,
  invoiceOpts = {},
  expectedPrice = null,
  now = new Date(),
}) {
  const kind = normalizeEnrollKind(kindRaw);
  await lockSeriesRow(tx, seriesId);
  const member = await tx.member.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, isAlert: true },
  });
  if (!member) throw httpError('找不到會員', 404);
  if (member.isAlert) throw httpError('警示帳號無法報名團課，請洽櫃檯主管', 403, 'MEMBER_ALERT');

  const state = await loadSeriesState(tx, seriesId, { memberId, now });
  const { series } = state;
  assertSeriesSellable(series);
  if (series.coursePlan?.requiresMemberContract) {
    await assertMemberSignedCoursePlanContracts(memberId, series.coursePlan.id, tx);
  }

  const futureIds = state.future.map((c) => c.id);
  const myActive = futureIds.length
    ? await tx.reservation.findMany({
        where: { memberId, classId: { in: futureIds }, status: { in: ACTIVE_RES } },
        select: { classId: true },
      })
    : [];
  const myOffer = state.liveOffers.find((w) => w.memberId === memberId) || null;

  let quote;
  let targetClasses;
  let cls = null;
  if (kind === TERM) {
    const existing = await tx.groupEnrollment.findFirst({
      where: { memberId, seriesId, kind: TERM, status: { in: ['PENDING', 'ACTIVE'] } },
      select: { id: true, status: true },
    });
    if (existing) {
      throw httpError(
        existing.status === 'PENDING' ? '已有待付款的整期報名，請完成付款' : '已報名此期班',
        409,
        'ALREADY_ENROLLED',
      );
    }
    if (myActive.length > 0) {
      throw httpError('已有本期班單堂／補課預約，請先取消後再報名整期', 409, 'CONFLICT_RESERVATION');
    }
    quote = quoteTermPrice({
      termPrice: series.termPrice,
      sessionCount: series.sessionCount,
      remainingSessions: state.future.length,
    });
    const avail = computeSeatAvailability({
      classFree: null,
      minFree: state.minFree,
      offersOthers: state.offersOthers,
      waitingOthers: state.waitingOthers,
    });
    if (avail.term < 1) {
      throw httpError('期班名額已滿（含候補保留），可登記候補', 409, 'SERIES_FULL');
    }
    targetClasses = state.future;
  } else {
    cls = state.future.find((c) => c.id === Number(classId));
    if (!cls) throw httpError('單堂須為本期班尚未開始之堂次', 400);
    if (myActive.some((r) => r.classId === cls.id)) {
      throw httpError('您已預約此堂課', 409, 'ALREADY_BOOKED');
    }
    quote = quoteDropInPrice(series);
    const avail = computeSeatAvailability({
      classFree: cls.free,
      minFree: state.minFree,
      offersOthers: state.offersOthers,
      waitingOthers: state.waitingOthers,
    });
    if (avail.single < 1) throw httpError('此堂名額已滿（空位保留給候補者）', 409, 'CLASS_FULL');
    targetClasses = [cls];
  }

  if (expectedPrice != null && roundNtd(expectedPrice) !== quote.price) {
    throw httpError('報名價格已變動（剩餘堂數改變），請重新整理後再結帳', 409, 'PRICE_CHANGED');
  }

  const orderId = generateGroupOrderId();
  const itemDesc = buildGroupItemDesc(series, kind, quote, cls);
  await tx.order.create({
    data: {
      id: orderId,
      memberId,
      amount: quote.price,
      itemDesc,
      payMethod,
      payBreakdown,
      voucherCode,
      cardAmount: 0,
      cardMode: 'LUMP',
      branchId: series.venue?.branchId ?? null,
      status: 'PENDING',
      checkoutSessionId,
    },
  });
  if (!checkoutSessionId) {
    await saveInvoiceRequest(tx, { refType: 'ORDER', refId: orderId, buyerName: member.name, ...invoiceOpts });
  }
  const enrollment = await tx.groupEnrollment.create({
    data: {
      memberId,
      seriesId,
      kind,
      classId: cls ? cls.id : null,
      status: 'PENDING',
      sessionsTotal: quote.sessions,
      unitPrice: quote.unitPrice,
      price: quote.price,
      orderId,
      checkoutSessionId,
      source,
      holdExpiresAt: new Date(now.getTime() + HOLD_MINUTES * 60 * 1000),
      createdByStaffId: staffId,
      waitlistId: kind === TERM && myOffer ? myOffer.id : null,
    },
  });
  await tx.reservation.createMany({
    data: targetClasses.map((c) => ({
      memberId,
      classId: c.id,
      status: 'PENDING',
      source: source === 'POS' ? 'STAFF' : 'MEMBER',
      enrollmentId: enrollment.id,
    })),
  });
  return { enrollment, orderId, quote, itemDesc, series, memberName: member.name };
}

/**
 * 付款成功 → 報名生效；保留逾時後才入帳者仍補建預約（已付款不可拒絕）
 */
export async function activateEnrollment(tx, enrollment, { merchantNo = null, now = new Date() } = {}) {
  const e = await tx.groupEnrollment.findUnique({ where: { id: enrollment.id } });
  if (!e || e.status === 'ACTIVE' || e.status === 'REFUNDED') return false;
  if (e.status === 'PENDING') {
    await tx.reservation.updateMany({
      where: { enrollmentId: e.id, status: 'PENDING' },
      data: { status: 'CONFIRMED' },
    });
  } else {
    const classIds =
      e.kind === TERM
        ? (
            await tx.class.findMany({
              where: { seriesId: e.seriesId, startAt: { gt: now } },
              select: { id: true },
            })
          ).map((c) => c.id)
        : e.classId
          ? (
              await tx.class.findMany({
                where: { id: e.classId, startAt: { gt: now } },
                select: { id: true },
              })
            ).map((c) => c.id)
          : [];
    for (const classId of classIds) {
      const dup = await tx.reservation.findFirst({
        where: { memberId: e.memberId, classId, status: { in: ACTIVE_RES } },
        select: { id: true },
      });
      if (dup) continue;
      await tx.reservation.create({
        data: {
          memberId: e.memberId,
          classId,
          status: 'CONFIRMED',
          source: e.source === 'POS' ? 'STAFF' : 'MEMBER',
          enrollmentId: e.id,
        },
      });
    }
    console.warn(`[團課] 報名 #${e.id} 保留已逾時（${e.status}）後才入帳，已補建 ${classIds.length} 堂預約`);
  }
  await tx.groupEnrollment.update({
    where: { id: e.id },
    data: { status: 'ACTIVE', paidAt: now, holdExpiresAt: null },
  });
  if (e.orderId) {
    await tx.order.updateMany({
      where: { id: e.orderId, status: { in: ['PENDING', 'CANCELLED'] } },
      data: { status: 'PAID', ...(merchantNo ? { merchantNo } : {}) },
    });
  }
  if (e.kind === TERM) {
    await tx.groupWaitlist.updateMany({
      where: { seriesId: e.seriesId, memberId: e.memberId, status: { in: ['WAITING', 'OFFERED'] } },
      data: { status: 'ENROLLED' },
    });
  }
  return true;
}

export async function activateEnrollmentsForCheckout(tx, checkoutSessionId, { merchantNo = null } = {}) {
  const rows = await tx.groupEnrollment.findMany({
    where: { checkoutSessionId, status: { in: ['PENDING', 'EXPIRED'] } },
  });
  let n = 0;
  for (const e of rows) {
    if (await activateEnrollment(tx, e, { merchantNo })) n += 1;
  }
  return n;
}

/** 釋放待付款保留（逾時 EXPIRED／付款失敗 CANCELLED） */
export async function releaseEnrollmentHold(tx, enrollmentId, status = 'EXPIRED') {
  const e = await tx.groupEnrollment.findUnique({ where: { id: enrollmentId } });
  if (!e || e.status !== 'PENDING') return null;
  await tx.reservation.updateMany({
    where: { enrollmentId: e.id, status: { in: ACTIVE_RES } },
    data: { status: 'CANCELLED' },
  });
  await tx.groupEnrollment.update({
    where: { id: e.id },
    data: { status, holdExpiresAt: null },
  });
  if (e.orderId) {
    await tx.order.updateMany({
      where: { id: e.orderId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  }
  return e.seriesId;
}

export async function releaseHoldsForCheckout(tx, checkoutSessionId, status = 'CANCELLED') {
  const rows = await tx.groupEnrollment.findMany({
    where: { checkoutSessionId, status: 'PENDING' },
    select: { id: true },
  });
  const seriesIds = new Set();
  for (const r of rows) {
    const sid = await releaseEnrollmentHold(tx, r.id, status);
    if (sid) seriesIds.add(sid);
  }
  return [...seriesIds];
}

/** 線上 GRP 訂單開票（營業人＝期班場地分店）；失敗入佇列（不沖回已收款） */
export async function issueGroupOrderInvoice(orderId) {
  return issueOrderInvoice(orderId, { leg: 'GROUP' });
}

/** 線上金流（PayUNi／LINE Pay）回呼：GRP 訂單 → 報名生效＋開票；禁止入帳錢包 */
export async function fulfillGroupOnlineOrder(orderId, merchantNo) {
  const e = await prisma.groupEnrollment.findUnique({ where: { orderId } });
  if (!e) return null;
  const activated = await prisma.$transaction((tx) => activateEnrollment(tx, e, { merchantNo }));
  if (!activated) return { enrollmentId: e.id, already: true };
  const invoice = await issueGroupOrderInvoice(orderId);
  return { enrollmentId: e.id, activated: true, invoice };
}

// ==========================================
// 候補
// ==========================================

async function notifyMember(memberId, text) {
  try {
    const m = await prisma.member.findUnique({ where: { id: memberId }, select: { lineId: true } });
    return await pushLineText(m?.lineId, text);
  } catch (err) {
    console.warn('[團課] 會員推播失敗:', err.message);
    return { ok: false };
  }
}

function groupPageHint() {
  return '請至會員中心「團課」頁查看。';
}

/**
 * 候補遞補：逾期未付之遞補作廢 → 以空位依序遞補（限時付款）＋推播
 */
export async function processWaitlist(seriesId, now = new Date()) {
  const offered = await prisma.$transaction(async (tx) => {
    await lockSeriesRow(tx, seriesId);
    const overdue = await tx.groupWaitlist.findMany({
      where: { seriesId, status: 'OFFERED', offerExpiresAt: { lt: now } },
    });
    for (const w of overdue) {
      const holding = await tx.groupEnrollment.count({ where: { waitlistId: w.id, status: 'PENDING' } });
      if (holding === 0) {
        await tx.groupWaitlist.update({ where: { id: w.id }, data: { status: 'EXPIRED' } });
      }
    }
    const state = await loadSeriesState(tx, seriesId, { now });
    if (!isSeriesSellable(state.series) || state.future.length === 0) return [];
    let free = state.minFree - state.liveOffers.length;
    const out = [];
    const firstStart = state.future[0].startAt.getTime();
    for (const w of state.waiting) {
      if (free < 1) break;
      const expires = new Date(Math.min(now.getTime() + WAITLIST_OFFER_HOURS * HOUR_MS, firstStart));
      await tx.groupWaitlist.update({
        where: { id: w.id },
        data: { status: 'OFFERED', offeredAt: now, offerExpiresAt: expires },
      });
      out.push({ memberId: w.memberId, title: state.series.title, expires });
      free -= 1;
    }
    return out;
  });
  for (const o of offered) {
    await notifyMember(
      o.memberId,
      [
        '【體育客】團課候補遞補通知',
        '',
        `您候補的期班「${o.title}」已有名額釋出，已為您保留至 ${taipeiDateLabel(o.expires)}。`,
        '請於期限內完成報名付款，逾期將由下一位候補遞補。',
        groupPageHint(),
      ].join('\n'),
    );
  }
  return offered.length;
}

export async function joinWaitlist({ memberId, seriesId, source = 'MEMBER', staffId = null, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    await lockSeriesRow(tx, seriesId);
    const state = await loadSeriesState(tx, seriesId, { memberId, now });
    assertSeriesSellable(state.series);
    if (state.future.length === 0) throw httpError('期班已無剩餘堂次', 409, 'SERIES_ENDED');
    const enrolled = await tx.groupEnrollment.findFirst({
      where: { memberId, seriesId, kind: TERM, status: { in: ['PENDING', 'ACTIVE'] } },
      select: { id: true },
    });
    if (enrolled) throw httpError('已報名此期班', 409, 'ALREADY_ENROLLED');
    if (state.waitlist.some((w) => w.memberId === memberId)) {
      throw httpError('已在候補名單中', 409, 'ALREADY_WAITLISTED');
    }
    if (state.termAvailability >= 1) {
      throw httpError('期班仍有名額，請直接報名', 409, 'SEATS_AVAILABLE');
    }
    const row = await tx.groupWaitlist.create({
      data: { seriesId, memberId, status: 'WAITING', source, createdByStaffId: staffId },
    });
    const position = state.waiting.length + 1;
    return { ...row, position };
  });
}

export async function cancelWaitlist({ memberId, waitlistId }) {
  const w = await prisma.groupWaitlist.findFirst({ where: { id: waitlistId, memberId } });
  if (!w) throw httpError('找不到候補紀錄', 404);
  if (!['WAITING', 'OFFERED'].includes(w.status)) throw httpError('此候補已結束', 409);
  await prisma.groupWaitlist.update({ where: { id: w.id }, data: { status: 'CANCELLED' } });
  if (w.status === 'OFFERED') await processWaitlist(w.seriesId).catch(() => {});
  return { id: w.id, status: 'CANCELLED' };
}

// ==========================================
// 請假／補課
// ==========================================

export async function requestGroupLeave({ memberId, reservationId, reason = null, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUnique({
      where: { id: reservationId },
      include: { class: { include: { series: true } }, enrollment: true, classLeave: true },
    });
    if (!r || r.memberId !== memberId) throw httpError('找不到預約', 404);
    if (!r.enrollmentId && !r.makeupCreditId) {
      throw httpError('此預約不是團課報名／補課', 400, 'NOT_GROUP_RESERVATION');
    }
    if (r.status !== 'CONFIRMED') throw httpError('此預約狀態不可請假', 409);
    if (r.enrollment?.kind === DROP_IN) {
      throw httpError(
        '單堂報名不適用請假補課；取消請洽櫃檯（開課前 24 小時全額退費）',
        409,
        'USE_DROP_IN_CANCEL',
      );
    }
    if (r.enrollment && r.enrollment.status !== 'ACTIVE') throw httpError('報名尚未生效或已退費', 409);
    if (!canLeaveWithMakeup(r.class.startAt, now)) {
      throw httpError(
        `請假須於開課前 ${LEAVE_MIN_HOURS} 小時提出；逾時視為已上課，不發補課`,
        409,
        'LEAVE_TOO_LATE',
      );
    }
    await tx.reservation.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
    if (!r.classLeave) {
      await tx.classLeave.create({
        data: {
          memberId,
          reservationId: r.id,
          reason: reason ? String(reason).slice(0, 200) : null,
          status: 'APPROVED',
          withinPolicy: true,
        },
      });
    }
    if (r.makeupCreditId) {
      await tx.groupMakeupCredit.update({
        where: { id: r.makeupCreditId },
        data: { status: 'AVAILABLE', usedReservationId: null, usedAt: null },
      });
      return { kind: 'MAKEUP_RESTORED', creditId: r.makeupCreditId };
    }
    const credit = await tx.groupMakeupCredit.create({
      data: {
        memberId,
        enrollmentId: r.enrollmentId,
        coursePlanId: r.class.series?.coursePlanId ?? null,
        sourceReservationId: r.id,
        status: 'AVAILABLE',
        expiresAt: makeupExpiresAt(r.class.series?.endDate || r.class.startAt),
      },
    });
    return { kind: 'MAKEUP_CREDIT', creditId: credit.id, expiresAt: credit.expiresAt };
  });
}

async function loadAvailableCredit(tx, memberId, creditId, now) {
  const credit = await tx.groupMakeupCredit.findFirst({
    where: { id: creditId, memberId },
    include: { enrollment: { select: { seriesId: true } } },
  });
  if (!credit) throw httpError('找不到補課權', 404);
  if (credit.status !== 'AVAILABLE' || credit.expiresAt <= now) {
    throw httpError('補課權已使用或已過期', 409, 'MAKEUP_UNAVAILABLE');
  }
  if (!credit.coursePlanId) throw httpError('補課權未綁定課程方案，請洽櫃檯', 409);
  return credit;
}

export async function listMakeupOptions({ memberId, creditId, now = new Date() }) {
  const credit = await loadAvailableCredit(prisma, memberId, creditId, now);
  const classes = await prisma.class.findMany({
    where: {
      type: 'GROUP',
      seriesId: { not: credit.enrollment.seriesId },
      series: { coursePlanId: credit.coursePlanId, status: 'OPEN', isActive: true },
      startAt: { gt: now, lte: credit.expiresAt },
    },
    include: {
      series: { select: { id: true, title: true } },
      venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
      trainer: { select: { id: true, name: true, displayName: true } },
      reservations: { where: { memberId, status: { in: ACTIVE_RES } }, select: { id: true } },
    },
    orderBy: { startAt: 'asc' },
    take: 60,
  });
  const stateCache = new Map();
  const out = [];
  for (const c of classes) {
    if (c.reservations.length > 0) continue;
    if (!stateCache.has(c.seriesId)) {
      stateCache.set(c.seriesId, await loadSeriesState(prisma, c.seriesId, { memberId, now }));
    }
    const st = stateCache.get(c.seriesId);
    const cf = st.classes.find((x) => x.id === c.id);
    const seats = computeSeatAvailability({
      classFree: cf?.free ?? 0,
      minFree: st.minFree,
      offersOthers: st.offersOthers,
      waitingOthers: st.waitingOthers,
    }).single;
    if (seats < 1) continue;
    out.push({
      classId: c.id,
      seriesId: c.seriesId,
      seriesTitle: c.series?.title || c.title,
      startAt: c.startAt,
      endAt: c.endAt,
      seats,
      branchName: memberBranchLabel(c.venue?.branch),
      venueName: c.venue?.name || null,
      trainerName: c.trainer ? resolveDisplayName(c.trainer) : null,
    });
  }
  return { credit: { id: credit.id, expiresAt: credit.expiresAt }, options: out };
}

export async function bookMakeup({ memberId, creditId, classId, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: { series: true },
    });
    if (!cls || !cls.series) throw httpError('找不到團課堂次', 404);
    await lockSeriesRow(tx, cls.seriesId);
    const credit = await loadAvailableCredit(tx, memberId, creditId, now);
    if (cls.series.coursePlanId !== credit.coursePlanId) {
      throw httpError('補課僅限同一課程方案之其他期班', 409, 'MAKEUP_COURSE_MISMATCH');
    }
    if (cls.seriesId === credit.enrollment.seriesId) {
      throw httpError('補課須選擇其他期班之堂次', 409, 'MAKEUP_SAME_SERIES');
    }
    if (cls.series.status !== 'OPEN' || !cls.series.isActive) throw httpError('該期班已取消', 409);
    if (cls.startAt <= now) throw httpError('該堂已開始', 409);
    if (cls.startAt > credit.expiresAt) throw httpError('該堂超過補課權有效期限', 409, 'MAKEUP_EXPIRED');
    const dup = await tx.reservation.findFirst({
      where: { memberId, classId: cls.id, status: { in: ACTIVE_RES } },
      select: { id: true },
    });
    if (dup) throw httpError('您已預約此堂課', 409, 'ALREADY_BOOKED');
    const st = await loadSeriesState(tx, cls.seriesId, { memberId, now });
    const cf = st.classes.find((x) => x.id === cls.id);
    const seats = computeSeatAvailability({
      classFree: cf?.free ?? 0,
      minFree: st.minFree,
      offersOthers: st.offersOthers,
      waitingOthers: st.waitingOthers,
    }).single;
    if (seats < 1) throw httpError('此堂名額已滿', 409, 'CLASS_FULL');
    const r = await tx.reservation.create({
      data: {
        memberId,
        classId: cls.id,
        status: 'CONFIRMED',
        source: 'MAKEUP',
        makeupCreditId: credit.id,
      },
    });
    await tx.groupMakeupCredit.update({
      where: { id: credit.id },
      data: { status: 'USED', usedReservationId: r.id, usedAt: now },
    });
    return { reservationId: r.id, classId: cls.id, startAt: cls.startAt, title: cls.title };
  });
}

// ==========================================
// 退費
// ==========================================

/** 已使用堂數：已開課未取消之本報名預約＋已上補課＋過期補課權 */
export async function countConsumedSessions(tx, enrollmentId, now = new Date()) {
  const own = await tx.reservation.count({
    where: {
      enrollmentId,
      status: { not: 'CANCELLED' },
      class: { startAt: { lte: now } },
    },
  });
  const credits = await tx.groupMakeupCredit.findMany({ where: { enrollmentId } });
  let extra = 0;
  for (const c of credits) {
    if (c.status === 'EXPIRED' || (c.status === 'AVAILABLE' && c.expiresAt <= now)) {
      extra += 1;
    } else if (c.status === 'USED' && c.usedReservationId) {
      const used = await tx.reservation.findFirst({
        where: {
          id: c.usedReservationId,
          status: { not: 'CANCELLED' },
          class: { startAt: { lte: now } },
        },
        select: { id: true },
      });
      if (used) extra += 1;
    }
  }
  return own + extra;
}

async function buildRefundContext(enrollmentId, now) {
  const e = await prisma.groupEnrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      series: { select: { id: true, title: true, status: true, venue: { select: { branchId: true } } } },
      member: { select: { id: true, name: true } },
    },
  });
  if (!e) throw httpError('找不到報名', 404);
  if (e.status !== 'ACTIVE') {
    throw httpError(
      e.status === 'PENDING' ? '報名尚未付款，無需退費' : `報名狀態 [${e.status}] 不可退費`,
      409,
      'NOT_REFUNDABLE',
    );
  }
  const order = e.orderId ? await prisma.order.findUnique({ where: { id: e.orderId } }) : null;
  if (!order) throw httpError('找不到報名訂單', 404);
  const session = order.checkoutSessionId
    ? await prisma.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } })
    : null;
  const consumed = e.kind === TERM ? await countConsumedSessions(prisma, e.id, now) : 0;
  const cls = e.kind === DROP_IN && e.classId
    ? await prisma.class.findUnique({ where: { id: e.classId }, select: { startAt: true } })
    : null;
  const calc = computeGroupRefund({
    kind: e.kind,
    price: e.price,
    unitPrice: e.unitPrice,
    consumedSessions: consumed,
    paidAt: e.paidAt,
    seriesCancelled: e.series.status === 'CANCELLED',
    classStartAt: cls?.startAt ?? null,
    now,
  });
  const merchant = String(session?.merchantNo || order.merchantNo || '');
  const linePayTx = merchant.startsWith('LP:') ? merchant.slice(3) : null;
  const channels = splitRefundChannels({
    payBreakdown: order.payBreakdown,
    paymentTotal: session?.amount || order.amount,
    refundAmount: calc.refundAmount,
  });
  if (channels.LINEPAY > 0 && !linePayTx) {
    channels.MANUAL += channels.LINEPAY;
    channels.LINEPAY = 0;
  }
  const invoiceCtx = calc.refundAmount > 0
    ? await resolveOrderInvoiceReverse(order, { refundCash: calc.refundAmount })
    : { skip: true, invoiceNumber: null, prefer: 'none' };
  let invoicePlan = 'none';
  let invoiceBlocked = null;
  if (calc.refundAmount > 0) {
    if (!invoiceCtx.skip && invoiceCtx.invoiceNumber) {
      invoicePlan = invoiceCtx.prefer;
    } else if (!(await issuedInvoiceFor(order.id))) {
      if (calc.refundAmount >= roundNtd(order.amount)) invoicePlan = 'cancel_job';
      else invoiceBlocked = '此訂單電子發票尚未開立完成，請先於發票佇列補開後再辦理部分退費';
    }
  }
  return { e, order, session, consumed, calc, channels, linePayTx, invoiceCtx, invoicePlan, invoiceBlocked };
}

function serializeRefundPreview(ctx) {
  return {
    enrollmentId: ctx.e.id,
    kind: ctx.e.kind,
    seriesId: ctx.e.seriesId,
    seriesTitle: ctx.e.series.title,
    seriesCancelled: ctx.e.series.status === 'CANCELLED',
    memberId: ctx.e.memberId,
    memberName: ctx.e.member?.name || null,
    orderId: ctx.order.id,
    price: ctx.e.price,
    unitPrice: ctx.e.unitPrice,
    sessionsTotal: ctx.e.sessionsTotal,
    consumedSessions: ctx.consumed,
    paidAt: ctx.e.paidAt,
    refundable: Boolean(ctx.calc.refundable) && !ctx.invoiceBlocked,
    refundKind: ctx.calc.kind || null,
    refundAmount: ctx.calc.refundAmount,
    fee: ctx.calc.fee,
    consumedValue: ctx.calc.consumedValue ?? 0,
    unfulfilled: ctx.calc.unfulfilled ?? 0,
    blockCode: ctx.calc.refundable ? (ctx.invoiceBlocked ? 'INVOICE_NOT_ISSUED' : null) : ctx.calc.code || 'NOTHING_TO_REFUND',
    blockMessage: ctx.calc.refundable ? ctx.invoiceBlocked : ctx.calc.message || '無可退金額',
    channels: ctx.channels,
    invoice: { plan: ctx.invoicePlan, invoiceNumber: ctx.invoiceCtx?.invoiceNumber || null },
  };
}

export async function previewGroupRefund(enrollmentId, now = new Date()) {
  return serializeRefundPreview(await buildRefundContext(enrollmentId, now));
}

const refundInFlight = new Set();

/**
 * 辦理退費：ezPay 作廢／折讓 → LINE Pay 線上退 → 交易內釋放名額、撤銷補課權、零錢包退回
 */
export async function refundGroupEnrollment({ enrollmentId, staffId = null, reason, now = new Date() }) {
  const note = String(reason || '').trim();
  if (!note) throw httpError('請填寫退費原因', 400);
  if (refundInFlight.has(enrollmentId)) throw httpError('此報名退費處理中，請稍候', 409);
  refundInFlight.add(enrollmentId);
  try {
    const ctx = await buildRefundContext(enrollmentId, now);
    if (!ctx.calc.refundable) {
      throw httpError(ctx.calc.message || '無可退金額', 409, ctx.calc.code || 'NOTHING_TO_REFUND');
    }
    if (ctx.invoiceBlocked) throw httpError(ctx.invoiceBlocked, 409, 'INVOICE_NOT_ISSUED');

    let invoiceReverse = { action: 'none', invoiceNumber: null };
    if (ctx.invoicePlan === 'void' || ctx.invoicePlan === 'allowance') {
      invoiceReverse = await executeInvoiceReverse(ctx.invoiceCtx, {
        reason: ctx.invoicePlan === 'void' ? '團課全額退費' : '團課退費折讓',
        prefer: ctx.invoicePlan,
        staffId,
        allowance: { source: 'GROUP_REFUND', orderId: ctx.order.id },
      });
    } else if (ctx.invoicePlan === 'cancel_job') {
      await cancelUnissuedInvoices(ctx.order.id, '訂單已全額退費，取消補開');
    }

    const channels = { ...ctx.channels };
    let linePayNote = null;
    if (channels.LINEPAY > 0) {
      try {
        await refundLinePayPayment({ transactionId: ctx.linePayTx, refundAmount: channels.LINEPAY });
      } catch (lpErr) {
        linePayNote = lpErr.message;
        channels.MANUAL += channels.LINEPAY;
        channels.LINEPAY = 0;
        console.error(`[團課] 報名 #${enrollmentId} LINE Pay 退款失敗，改臨櫃人工退:`, lpErr.message);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const fresh = await tx.groupEnrollment.findUnique({ where: { id: enrollmentId } });
      if (!fresh || fresh.status !== 'ACTIVE') {
        throw httpError('報名狀態已變更，請重新查詢（若發票已作廢／折讓請人工核對）', 409);
      }
      await tx.reservation.updateMany({
        where: { enrollmentId, status: { in: ACTIVE_RES }, class: { startAt: { gt: now } } },
        data: { status: 'CANCELLED' },
      });
      const credits = await tx.groupMakeupCredit.findMany({
        where: { enrollmentId, status: { in: ['AVAILABLE', 'USED'] } },
      });
      for (const c of credits) {
        if (c.status === 'USED' && c.usedReservationId) {
          const upcoming = await tx.reservation.updateMany({
            where: { id: c.usedReservationId, status: { in: ACTIVE_RES }, class: { startAt: { gt: now } } },
            data: { status: 'CANCELLED' },
          });
          if (upcoming.count === 0) continue;
        }
        await tx.groupMakeupCredit.update({ where: { id: c.id }, data: { status: 'REVOKED' } });
      }
      if (channels.WALLET_CASH > 0) {
        await mutateMemberWallet(tx, {
          memberId: fresh.memberId,
          txType: WALLET_TX.GROUP_REFUND,
          mode: WALLET_MODE.CREDIT_BUCKETS,
          cashDelta: channels.WALLET_CASH,
          bonusDelta: 0,
          reason: `團課退費退回零錢包（報名 #${enrollmentId}）`,
          refType: 'ORDER',
          refId: ctx.order.id,
          staffId,
          branchId: ctx.order.branchId ?? null,
        });
      }
      const updated = await tx.groupEnrollment.update({
        where: { id: enrollmentId },
        data: {
          status: 'REFUNDED',
          refundKind: ctx.calc.kind,
          refundAmount: ctx.calc.refundAmount,
          refundFee: ctx.calc.fee,
          consumedSessions: ctx.consumed,
          refundReason: note.slice(0, 300),
          refundedAt: now,
          refundedByStaffId: staffId,
          refundBreakdown: { ...channels, ...(linePayNote ? { linePayError: linePayNote.slice(0, 200) } : {}) },
        },
      });
      const calcNote =
        `團課退費(${ctx.calc.kind})：實付$${roundNtd(ctx.e.price)} − 已使用${ctx.consumed}堂$${ctx.calc.consumedValue ?? 0}` +
        ` − 手續費$${ctx.calc.fee} = 應退$${ctx.calc.refundAmount}`;
      await tx.order.update({
        where: { id: ctx.order.id },
        data: {
          status: 'REFUNDED',
          itemDesc: appendInvoiceReverseNote(`${ctx.order.itemDesc} | ${calcNote}`, invoiceReverse).slice(0, 500),
        },
      });
      if (ctx.order.checkoutSessionId) {
        await syncCheckoutInvoiceAfterReverse(tx, ctx.order.checkoutSessionId, invoiceReverse);
        await reevaluateCheckoutSessionStatus(tx, ctx.order.checkoutSessionId);
      }
      return updated;
    });

    if (ctx.e.series.status === 'OPEN') await processWaitlist(ctx.e.seriesId).catch(() => {});
    return {
      enrollment: result,
      refundAmount: ctx.calc.refundAmount,
      fee: ctx.calc.fee,
      refundKind: ctx.calc.kind,
      consumedSessions: ctx.consumed,
      channels,
      linePayError: linePayNote,
      invoice: invoiceReverse,
    };
  } finally {
    refundInFlight.delete(enrollmentId);
  }
}

// ==========================================
// 期班取消（未達開班人數等；總部）
// ==========================================

export async function cancelGroupSeries({ seriesId, staffId, reason, now = new Date() }) {
  const note = String(reason || '').trim();
  if (!note) throw httpError('請填寫取消原因', 400);
  const txResult = await prisma.$transaction(async (tx) => {
    await lockSeriesRow(tx, seriesId);
    const series = await tx.classSeries.findUnique({ where: { id: seriesId } });
    if (!series) throw httpError('找不到此期班', 404);
    if (series.status === 'CANCELLED') throw httpError('期班已取消', 409, 'SERIES_CLOSED');
    await tx.classSeries.update({
      where: { id: seriesId },
      data: {
        status: 'CANCELLED',
        isActive: false,
        cancelledAt: now,
        cancelReason: note.slice(0, 300),
        cancelledByStaffId: staffId,
      },
    });
    const pending = await tx.groupEnrollment.findMany({
      where: { seriesId, status: 'PENDING' },
      select: { id: true },
    });
    for (const p of pending) await releaseEnrollmentHold(tx, p.id, 'CANCELLED');
    await tx.groupWaitlist.updateMany({
      where: { seriesId, status: { in: ['WAITING', 'OFFERED'] } },
      data: { status: 'CANCELLED' },
    });
    const futureClasses = await tx.class.findMany({
      where: { seriesId, startAt: { gt: now } },
      select: { id: true },
    });
    const futureIds = futureClasses.map((c) => c.id);
    let restoredCredits = 0;
    if (futureIds.length) {
      const makeups = await tx.reservation.findMany({
        where: { classId: { in: futureIds }, makeupCreditId: { not: null }, status: { in: ACTIVE_RES } },
        select: { makeupCreditId: true },
      });
      for (const m of makeups) {
        await tx.groupMakeupCredit.update({
          where: { id: m.makeupCreditId },
          data: { status: 'AVAILABLE', usedReservationId: null, usedAt: null },
        });
        restoredCredits += 1;
      }
      await tx.class.deleteMany({ where: { id: { in: futureIds } } });
    }
    const members = await tx.groupWaitlist.findMany({
      where: { seriesId },
      select: { memberId: true },
    });
    const active = await tx.groupEnrollment.findMany({
      where: { seriesId, status: 'ACTIVE' },
      select: { id: true, memberId: true },
    });
    return {
      title: series.title,
      removedClasses: futureIds.length,
      restoredCredits,
      activeIds: active.map((a) => a.id),
      notifyIds: [...new Set([...active.map((a) => a.memberId), ...members.map((m) => m.memberId)])],
    };
  });

  const refunded = [];
  const failed = [];
  for (const id of txResult.activeIds) {
    try {
      const r = await refundGroupEnrollment({ enrollmentId: id, staffId, reason: `期班取消：${note}`, now });
      refunded.push({ enrollmentId: id, refundAmount: r.refundAmount, channels: r.channels });
    } catch (err) {
      failed.push({ enrollmentId: id, message: err.message, code: err.code || null });
    }
  }
  for (const memberId of txResult.notifyIds) {
    await notifyMember(
      memberId,
      [
        '【體育客】團課期班取消通知',
        '',
        `很抱歉，期班「${txResult.title}」已取消開班。`,
        '已報名者之未上課款項將全額退還（依原付款方式，臨櫃付款請洽櫃檯領回）；候補登記已一併取消。',
        groupPageHint(),
      ].join('\n'),
    );
  }
  return {
    seriesId,
    removedClasses: txResult.removedClasses,
    restoredCredits: txResult.restoredCredits,
    refunded,
    failed,
  };
}

// ==========================================
// 排程：保留逾時／遞補逾期
// ==========================================

export async function runGroupClassHousekeeping(now = new Date()) {
  const stale = await prisma.groupEnrollment.findMany({
    where: { status: 'PENDING', holdExpiresAt: { lt: now } },
    select: { id: true, seriesId: true, orderId: true, checkoutSessionId: true },
    take: 200,
  });
  const touched = new Set();
  let expired = 0;
  for (const e of stale) {
    const paid = e.checkoutSessionId
      ? (await prisma.checkoutSession.findUnique({ where: { id: e.checkoutSessionId }, select: { status: true } }))
          ?.status === 'PAID'
      : e.orderId
        ? (await prisma.order.findUnique({ where: { id: e.orderId }, select: { status: true } }))?.status === 'PAID'
        : false;
    await prisma.$transaction(async (tx) => {
      if (paid) await activateEnrollment(tx, e, { now });
      else if (await releaseEnrollmentHold(tx, e.id, 'EXPIRED')) expired += 1;
    });
    touched.add(e.seriesId);
  }
  const overdueOffers = await prisma.groupWaitlist.findMany({
    where: { status: 'OFFERED', offerExpiresAt: { lt: now } },
    select: { seriesId: true },
    distinct: ['seriesId'],
  });
  for (const o of overdueOffers) touched.add(o.seriesId);
  await prisma.groupMakeupCredit.updateMany({
    where: { status: 'AVAILABLE', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  let offered = 0;
  for (const sid of touched) {
    offered += await processWaitlist(sid, now).catch((err) => {
      console.error(`[團課] 期班 #${sid} 候補遞補失敗:`, err.message);
      return 0;
    });
  }
  return { expired, offered };
}

let housekeepingTimer = null;
export function startGroupClassScheduler(intervalMs) {
  if (housekeepingTimer) return;
  const ms = Number(intervalMs) || Number(process.env.GROUP_CLASS_TICK_MS) || 60 * 1000;
  const tick = async () => {
    try {
      const r = await runGroupClassHousekeeping();
      if (r.expired || r.offered) console.log(`[團課] 保留逾時釋放 ${r.expired}、候補遞補 ${r.offered}`);
    } catch (err) {
      console.error('[團課] 排程例外:', err.message);
    }
  };
  void tick();
  housekeepingTimer = setInterval(() => void tick(), ms);
  if (typeof housekeepingTimer.unref === 'function') housekeepingTimer.unref();
}

// ==========================================
// 查詢／序列化
// ==========================================

function serializeSeriesBase(series) {
  return {
    id: series.id,
    title: series.title,
    coursePlanId: series.coursePlanId,
    coursePlanName: series.coursePlan?.name || null,
    requiresMemberContract: Boolean(series.coursePlan?.requiresMemberContract),
    startDate: series.startDate,
    endDate: series.endDate,
    weekdays: series.weekdays || [],
    weekdaysLabel: series.weekdays?.length ? formatWeekdaysLabel(series.weekdays) : '',
    startTime: series.startTime,
    endTime: series.endTime,
    capacity: series.capacity,
    termPrice: series.termPrice,
    dropInPrice: series.dropInPrice,
    sessionCount: series.sessionCount,
    minEnrollment: series.minEnrollment,
    enrollDeadline: series.enrollDeadline,
    status: series.status,
    sellable: isSeriesSellable(series),
    branchId: series.venue?.branchId ?? series.venue?.branch?.id ?? null,
    branchName: memberBranchLabel(series.venue?.branch),
    venueName: series.venue?.name || null,
    stationName: series.station?.name || null,
    trainerId: series.trainerId,
    trainerName: series.trainer ? resolveDisplayName(series.trainer) : null,
  };
}

function safeQuoteTerm(state) {
  try {
    return quoteTermPrice({
      termPrice: state.series.termPrice,
      sessionCount: state.series.sessionCount,
      remainingSessions: state.future.length,
    });
  } catch {
    return null;
  }
}

/** 可售期班（會員／櫃檯）：報價與名額皆由後端計算 */
export async function listSellableSeries({ memberId = null, branchIds = null, now = new Date() } = {}) {
  const todayStart = new Date(now.getTime() - 24 * HOUR_MS);
  const rows = await prisma.classSeries.findMany({
    where: {
      status: 'OPEN',
      isActive: true,
      coursePlanId: { not: null },
      termPrice: { not: null },
      endDate: { gte: todayStart },
      ...(branchIds ? { venue: { branchId: { in: branchIds } } } : {}),
    },
    include: seriesInclude,
    orderBy: { startDate: 'asc' },
    take: 60,
  });
  const out = [];
  for (const s of rows) {
    const state = await loadSeriesState(prisma, s.id, { memberId, now });
    if (state.future.length === 0) continue;
    const mine = memberId
      ? await prisma.groupEnrollment.findFirst({
          where: { memberId, seriesId: s.id, kind: TERM, status: { in: ['PENDING', 'ACTIVE'] } },
          select: { id: true, status: true },
        })
      : null;
    const myWait = memberId ? state.waitlist.find((w) => w.memberId === memberId) || null : null;
    const activeTerm = await prisma.groupEnrollment.count({
      where: { seriesId: s.id, kind: TERM, status: 'ACTIVE' },
    });
    out.push({
      ...serializeSeriesBase(s),
      remainingSessions: state.future.length,
      nextClassAt: state.future[0]?.startAt || null,
      termQuote: safeQuoteTerm(state),
      seatsLeft: Math.max(0, state.termAvailability),
      waitingCount: state.waiting.length,
      enrolledCount: activeTerm,
      myEnrollment: mine,
      myWaitlist: myWait
        ? { id: myWait.id, status: myWait.status, offerExpiresAt: myWait.offerExpiresAt }
        : null,
    });
  }
  return out;
}

export async function getSeriesDetail({ seriesId, memberId = null, now = new Date() }) {
  const state = await loadSeriesState(prisma, seriesId, { memberId, now });
  const myRes = memberId
    ? await prisma.reservation.findMany({
        where: { memberId, classId: { in: state.classes.map((c) => c.id) }, status: { in: ACTIVE_RES } },
        select: { classId: true },
      })
    : [];
  const mySet = new Set(myRes.map((r) => r.classId));
  const myWait = memberId ? state.waitlist.find((w) => w.memberId === memberId) || null : null;
  return {
    ...serializeSeriesBase(state.series),
    remainingSessions: state.future.length,
    termQuote: safeQuoteTerm(state),
    seatsLeft: Math.max(0, state.termAvailability),
    waitingCount: state.waiting.length,
    myWaitlist: myWait ? { id: myWait.id, status: myWait.status, offerExpiresAt: myWait.offerExpiresAt } : null,
    classes: state.classes.map((c) => {
      const upcoming = c.startAt > now;
      const single = upcoming
        ? computeSeatAvailability({
            classFree: c.free,
            minFree: state.minFree,
            offersOthers: state.offersOthers,
            waitingOthers: state.waitingOthers,
          }).single
        : 0;
      return {
        id: c.id,
        startAt: c.startAt,
        endAt: c.endAt,
        capacity: c.capacity,
        booked: c.booked,
        upcoming,
        dropInSeats: Math.max(0, single),
        mine: mySet.has(c.id),
      };
    }),
  };
}

/** 會員團課總覽：報名、預約（可否請假）、候補、補課權 */
export async function getMemberGroupOverview(memberId, now = new Date()) {
  const [enrollments, waitlist, credits] = await Promise.all([
    prisma.groupEnrollment.findMany({
      where: { memberId, status: { in: ['PENDING', 'ACTIVE', 'REFUNDED'] } },
      include: {
        series: { include: seriesInclude },
        reservations: {
          include: { class: { select: { id: true, startAt: true, endAt: true } } },
          orderBy: { class: { startAt: 'asc' } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
    prisma.groupWaitlist.findMany({
      where: { memberId, status: { in: ['WAITING', 'OFFERED'] } },
      include: { series: { select: { id: true, title: true, startDate: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.groupMakeupCredit.findMany({
      where: { memberId, status: { in: ['AVAILABLE', 'USED'] } },
      include: { enrollment: { select: { series: { select: { id: true, title: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
  ]);

  const waitPositions = new Map();
  for (const w of waitlist) {
    if (w.status !== 'WAITING') continue;
    const ahead = await prisma.groupWaitlist.count({
      where: { seriesId: w.seriesId, status: 'WAITING', createdAt: { lt: w.createdAt } },
    });
    waitPositions.set(w.id, ahead + 1);
  }

  const usedIds = credits.filter((c) => c.usedReservationId).map((c) => c.usedReservationId);
  const makeupRes = usedIds.length
    ? await prisma.reservation.findMany({
        where: { id: { in: usedIds } },
        include: { class: { select: { id: true, title: true, startAt: true, endAt: true } } },
      })
    : [];
  const makeupMap = new Map(makeupRes.map((r) => [r.id, r]));

  return {
    enrollments: enrollments.map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      price: e.price,
      sessionsTotal: e.sessionsTotal,
      source: e.source,
      paidAt: e.paidAt,
      holdExpiresAt: e.holdExpiresAt,
      refundAmount: e.refundAmount,
      refundedAt: e.refundedAt,
      series: serializeSeriesBase(e.series),
      reservations: e.reservations.map((r) => ({
        id: r.id,
        status: r.status,
        classId: r.classId,
        startAt: r.class.startAt,
        endAt: r.class.endAt,
        canLeave:
          e.status === 'ACTIVE' &&
          e.kind === TERM &&
          r.status === 'CONFIRMED' &&
          canLeaveWithMakeup(r.class.startAt, now),
      })),
    })),
    waitlist: waitlist.map((w) => ({
      id: w.id,
      status: w.status,
      seriesId: w.seriesId,
      seriesTitle: w.series.title,
      startDate: w.series.startDate,
      position: waitPositions.get(w.id) ?? null,
      offerExpiresAt: w.offerExpiresAt,
    })),
    makeupCredits: credits.map((c) => {
      const used = c.usedReservationId ? makeupMap.get(c.usedReservationId) : null;
      return {
        id: c.id,
        status: c.status,
        expiresAt: c.expiresAt,
        sourceSeriesTitle: c.enrollment?.series?.title || null,
        usedReservation: used
          ? {
              id: used.id,
              status: used.status,
              title: used.class.title,
              startAt: used.class.startAt,
              canLeave: used.status === 'CONFIRMED' && canLeaveWithMakeup(used.class.startAt, now),
            }
          : null,
      };
    }),
  };
}

/** 總部期班列表（含報名統計與開班判定） */
export async function listSeriesForAdmin({ includeEnded = false, now = new Date() } = {}) {
  const rows = await prisma.classSeries.findMany({
    where: includeEnded ? {} : { endDate: { gte: new Date(now.getTime() - 24 * HOUR_MS) } },
    include: { ...seriesInclude, _count: { select: { classes: true } } },
    orderBy: { startDate: 'asc' },
    take: 100,
  });
  const ids = rows.map((r) => r.id);
  const [enrollAgg, waitAgg] = ids.length
    ? await Promise.all([
        prisma.groupEnrollment.groupBy({
          by: ['seriesId', 'kind', 'status'],
          where: { seriesId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.groupWaitlist.groupBy({
          by: ['seriesId', 'status'],
          where: { seriesId: { in: ids }, status: { in: ['WAITING', 'OFFERED'] } },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const count = (sid, kind, status) =>
    enrollAgg
      .filter((a) => a.seriesId === sid && a.kind === kind && a.status === status)
      .reduce((s, a) => s + a._count._all, 0);
  const wcount = (sid, status) =>
    waitAgg.filter((a) => a.seriesId === sid && a.status === status).reduce((s, a) => s + a._count._all, 0);
  return rows.map((s) => {
    const termActive = count(s.id, TERM, 'ACTIVE');
    const belowMinimum = s.minEnrollment > 0 && termActive < s.minEnrollment;
    const deadlinePassed = Boolean(s.enrollDeadline && now > s.enrollDeadline);
    return {
      ...serializeSeriesBase(s),
      branchName: staffBranchLabel(s.venue?.branch),
      classCount: s._count.classes,
      termActive,
      termPending: count(s.id, TERM, 'PENDING'),
      dropInActive: count(s.id, DROP_IN, 'ACTIVE'),
      refunded: count(s.id, TERM, 'REFUNDED') + count(s.id, DROP_IN, 'REFUNDED'),
      waiting: wcount(s.id, 'WAITING'),
      offered: wcount(s.id, 'OFFERED'),
      belowMinimum,
      deadlinePassed,
      needsDecision: s.status === 'OPEN' && belowMinimum && deadlinePassed,
      cancelledAt: s.cancelledAt,
      cancelReason: s.cancelReason,
    };
  });
}

export async function getSeriesRoster(seriesId, now = new Date()) {
  const state = await loadSeriesState(prisma, seriesId, { now });
  const [enrollments, waitlist, attendance] = await Promise.all([
    prisma.groupEnrollment.findMany({
      where: { seriesId, status: { in: ['PENDING', 'ACTIVE', 'REFUNDED'] } },
      include: { member: { select: { id: true, name: true, memberNo: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.groupWaitlist.findMany({
      where: { seriesId, status: { in: ['WAITING', 'OFFERED'] } },
      include: { member: { select: { id: true, name: true, memberNo: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.classAttendance.groupBy({
      by: ['classId'],
      where: { classId: { in: state.classes.map((c) => c.id) } },
      _count: { _all: true },
    }),
  ]);
  const attMap = new Map(attendance.map((a) => [a.classId, a._count._all]));
  return {
    series: { ...serializeSeriesBase(state.series), branchName: staffBranchLabel(state.series.venue?.branch) },
    seatsLeft: Math.max(0, state.termAvailability),
    classes: state.classes.map((c) => ({
      id: c.id,
      startAt: c.startAt,
      endAt: c.endAt,
      capacity: c.capacity,
      booked: c.booked,
      attended: attMap.get(c.id) || 0,
    })),
    enrollments: enrollments.map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      classId: e.classId,
      price: e.price,
      sessionsTotal: e.sessionsTotal,
      source: e.source,
      paidAt: e.paidAt,
      holdExpiresAt: e.holdExpiresAt,
      refundAmount: e.refundAmount,
      refundKind: e.refundKind,
      memberId: e.memberId,
      memberName: e.member?.name || null,
      memberNo: e.member?.memberNo || null,
    })),
    waitlist: waitlist.map((w) => ({
      id: w.id,
      status: w.status,
      memberId: w.memberId,
      memberName: w.member?.name || null,
      memberNo: w.member?.memberNo || null,
      createdAt: w.createdAt,
      offerExpiresAt: w.offerExpiresAt,
    })),
  };
}

/** 櫃檯查會員團課（報名／候補／補課權） */
export async function getMemberGroupForStaff(memberId, now = new Date()) {
  const overview = await getMemberGroupOverview(memberId, now);
  return overview;
}
