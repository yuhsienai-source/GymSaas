// lib/staffNotifyEvents.js — 排班／教練週班表／排假／請假／薪資單事件 → 員工通知（文案與收件人；派送見 staffNotificationService）
/**
 * 所有函式皆吞錯（通知失敗不得影響主流程）。
 * 訊息禁止含請假事由、薪資金額、證件號等敏感內容；請至系統查看。
 */
import prisma from './prisma.js';
import { LEAVE_TYPES } from './laborLaw.js';
import { branchManagerIds, coachPlanReviewerIds, hqAdminIds, notifyStaff } from './staffNotificationService.js';

const LINK_MY_ROSTER = '/staff/my-roster';
const LINK_ROSTER = '/staff/roster';
const LINK_MY_ATTENDANCE = '/staff/my-attendance';
const LINK_HQ = '/staff/hq';

function safe(label, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[staff-notify] ${label} 失敗:`, err.message);
      return 0;
    }
  };
}

const TPE = 'Asia/Taipei';

function fmtDateTime(d) {
  return new Date(d).toLocaleString('zh-TW', {
    timeZone: TPE,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtMd(key) {
  const [, m, d] = String(key).split('-');
  return `${Number(m)}/${Number(d)}`;
}

function cycleLabel(startKey, endKey) {
  return `${fmtMd(startKey)}–${fmtMd(endKey)}`;
}

function staffName(s) {
  return s?.name || s?.displayName || `員工#${s?.id ?? '?'}`;
}

async function staffBrief(staffId) {
  return prisma.staff.findUnique({
    where: { id: staffId },
    select: { id: true, name: true, displayName: true, branchId: true },
  });
}

// ── 四週排班 ──────────────────────────────────────

/**
 * 發布：通知本期有排班格之員工（72 小時內確認）；未能排休之申請日一併列出
 * @param {{ periodId: number, publishedAt: Date, ackDeadline: Date, branchName: string, startKey: string, endKey: string,
 *   staffIds: number[], unmetOff: Map<number, string[]> }} p
 */
export const notifyRosterPublished = safe('排班發布通知', async (p) => {
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(p.staffIds, (staffId) => {
    const unmet = p.unmetOff.get(staffId) || [];
    return {
      type: 'ROSTER_PUBLISHED',
      title: `${cycle} 班表已發布`,
      body: [
        `${p.branchName} ${cycle} 四週班表已發布。`,
        `請於 ${fmtDateTime(p.ackDeadline)} 前確認或提出異議；逾期未回覆視為同意。`,
        unmet.length ? `以下排假申請日因人力不足已排班：${unmet.map(fmtMd).join('、')}，如有問題請提出異議。` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      link: LINK_MY_ROSTER,
      dedupeKey: `ROSTER_PUBLISHED:${p.periodId}:${p.publishedAt.getTime()}`,
    };
  });
});

export const notifyRosterUnpublished = safe('排班撤回通知', async (p) => {
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(p.staffIds, {
    type: 'ROSTER_UNPUBLISHED',
    title: `${cycle} 班表已撤回調整`,
    body: `${p.branchName} ${cycle} 班表已由店長撤回調整（原因：${p.reason}）。重新發布後需再次確認。`,
    link: LINK_MY_ROSTER,
  });
});

/** 員工提出異議 → 分店督導 */
export const notifyRosterDisputed = safe('排班異議通知', async (p) => {
  const managers = await branchManagerIds(p.branchId);
  const staff = await staffBrief(p.staffId);
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(
    managers.filter((id) => id !== p.staffId),
    {
      type: 'ROSTER_ACK_DISPUTED',
      title: `${staffName(staff)} 對 ${cycle} 班表提出異議`,
      body: [
        `${p.branchName} ${cycle}：${staffName(staff)} 提出班表異議${p.late ? '（已逾確認期限）' : ''}。`,
        `說明：${String(p.message || '').slice(0, 120)}`,
        '請至排班管理檢視；如需調整請撤回發布（附原因）後修改。',
      ].join('\n'),
      link: LINK_ROSTER,
      dedupeKey: `ROSTER_ACK_DISPUTED:${p.periodId}:${p.publishedAt.getTime()}:${p.staffId}:${p.respondedAt.getTime()}`,
    },
  );
});

/** 全員回覆完畢或逾期自動同意後 → 分店督導彙整 */
export const notifyRosterAckSummary = safe('排班確認彙整通知', async (p) => {
  const managers = await branchManagerIds(p.branchId);
  const cycle = cycleLabel(p.startKey, p.endKey);
  const parts = [`確認 ${p.confirmed} 人${p.autoConfirmed ? `（其中逾期自動同意 ${p.autoConfirmed} 人）` : ''}`];
  if (p.disputed) parts.push(`異議 ${p.disputed} 人`);
  return notifyStaff(managers, {
    type: 'ROSTER_ACK_SUMMARY',
    title: `${cycle} 班表確認完成`,
    body: `${p.branchName} ${cycle} 班表回覆已齊（共 ${p.total} 人）：${parts.join('、')}。${
      p.disputed ? '請處理異議。' : ''
    }`,
    link: LINK_ROSTER,
    dedupeKey: `ROSTER_ACK_SUMMARY:${p.periodId}:${p.publishedAt.getTime()}`,
  });
});

export const notifyRosterAutoConfirmed = safe('排班自動同意通知', async (p) => {
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(p.staffIds, {
    type: 'ROSTER_AUTO_CONFIRMED',
    title: `${cycle} 班表已逾期自動同意`,
    body: `您未於期限內回覆 ${p.branchName} ${cycle} 班表，系統已視為同意。如有問題仍可提出異議，由店長撤回調整。`,
    link: LINK_MY_ROSTER,
    dedupeKey: `ROSTER_AUTO_CONFIRMED:${p.periodId}:${p.publishedAt.getTime()}`,
  });
});

export const notifyRosterAckReminder = safe('排班確認提醒', async (p) => {
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(p.staffIds, {
    type: 'ROSTER_ACK_REMINDER',
    title: `請確認 ${cycle} 班表`,
    body: `${p.branchName} ${cycle} 班表確認期限為 ${fmtDateTime(p.ackDeadline)}，逾期未回覆將自動視為同意。`,
    link: LINK_MY_ROSTER,
    dedupeKey: `ROSTER_ACK_REMINDER:${p.periodId}:${p.publishedAt.getTime()}`,
  });
});

// ── 排假申請 ──────────────────────────────────────

/** 員工遞交／修改／撤回排假 → 分店督導；同內容不重複通知 */
export const notifyOffRequestSubmitted = safe('排假申請通知', async (p) => {
  const managers = await branchManagerIds(p.branchId);
  const staff = await staffBrief(p.staffId);
  const cycle = cycleLabel(p.startKey, p.endKey);
  const withdrawn = p.dates.length === 0;
  return notifyStaff(
    managers.filter((id) => id !== p.staffId),
    {
      type: 'OFF_REQUEST_SUBMITTED',
      title: withdrawn ? `${staffName(staff)} 撤回 ${cycle} 排假申請` : `${staffName(staff)} 遞交 ${cycle} 排假申請`,
      body: withdrawn
        ? `${p.branchName} ${cycle}：${staffName(staff)} 已撤回排假申請。`
        : `${p.branchName} ${cycle}：${staffName(staff)} 希望休假 ${p.dates.length} 日（${p.dates.map(fmtMd).join('、')}）。截止日 ${fmtMd(p.deadlineKey)}。`,
      link: LINK_ROSTER,
      dedupeKey: `OFF_REQUEST:${p.branchId}:${p.startKey}:${p.staffId}:${p.dates.join(',') || 'none'}`,
    },
  );
});

export const notifyOffRequestReminder = safe('排假提醒', async (p) => {
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(p.staffIds, {
    type: 'OFF_REQUEST_REMINDER',
    title: `${cycle} 排假申請即將截止`,
    body: `${p.branchName} ${cycle} 排假申請將於 ${fmtMd(p.deadlineKey)} 截止（每期開始前 14 日），尚未遞交者請盡快申請。`,
    link: LINK_MY_ROSTER,
    dedupeKey: `OFF_REQUEST_REMINDER:${p.branchId}:${p.startKey}`,
  });
});

export const notifyOffRequestClosed = safe('排假截止彙整', async (p) => {
  const managers = await branchManagerIds(p.branchId);
  const cycle = cycleLabel(p.startKey, p.endKey);
  return notifyStaff(managers, {
    type: 'OFF_REQUEST_CLOSED',
    title: `${cycle} 排假申請已截止`,
    body: `${p.branchName} ${cycle} 排假申請已截止：已遞交 ${p.submitted}／${p.total} 人。可開始自動排班並發布。`,
    link: LINK_ROSTER,
    dedupeKey: `OFF_REQUEST_CLOSED:${p.branchId}:${p.startKey}`,
  });
});

// ── 週班表（教練／管理職）────────────────────────────

const REVIEWER_LABELS = { ADMIN: '總公司', FM: '教練部主管', STORE_MANAGER: '店長' };

/** 送審 → 教練：該分店店長＋FM；店長／GM／FM：總公司 ADMIN */
export const notifyCoachPlanSubmitted = safe('週班表送審通知', async (p) => {
  const isManager = p.planRole === 'MANAGER';
  const recipients = isManager ? await hqAdminIds() : await coachPlanReviewerIds(p.branchId);
  const staff = await staffBrief(p.staffId);
  const week = cycleLabel(p.weekStart, p.weekEnd);
  return notifyStaff(
    recipients.filter((id) => id !== p.staffId),
    {
      type: 'COACH_PLAN_SUBMITTED',
      title: `${staffName(staff)} 送審 ${week} 週班表`,
      body: `${staffName(staff)} 已提報 ${week} 週班表（出勤 ${p.workDays} 日），請至${
        isManager ? '總部「員工 HR → 排班 → 週班表審核」' : '排班管理「週班表審核」'
      }審核。`,
      link: isManager ? LINK_HQ : LINK_ROSTER,
      dedupeKey: `COACH_PLAN_SUBMITTED:${p.planId}:${new Date(p.submittedAt).getTime()}`,
    },
  );
});

/** 核准／退回／撤回核准 → 提報人本人 */
export const notifyCoachPlanReviewed = safe('週班表審核通知', async (p) => {
  const week = cycleLabel(p.weekStart, p.weekEnd);
  const reviewer = REVIEWER_LABELS[p.reviewerRole] ?? '審核主管';
  const text = {
    APPROVED: { title: `${week} 週班表已核准`, body: `您 ${week} 週班表已由${reviewer}核准生效，出勤打卡與可預約時段依核准班表。` },
    REJECTED: { title: `${week} 週班表已退回`, body: `${reviewer}已退回您 ${week} 週班表（原因：${String(p.reason || '').slice(0, 120)}），請修正後重新送審。` },
    REOPENED: {
      title: `${week} 週班表已撤回核准`,
      body: `${reviewer}已撤回 ${week} 週班表核准（原因：${String(p.reason || '').slice(0, 120)}），請調整後重新送審；重新核准前該週班表不生效。`,
    },
  }[p.action];
  if (!text) return 0;
  return notifyStaff([p.staffId], {
    type: `COACH_PLAN_${p.action}`,
    ...text,
    link: LINK_MY_ROSTER,
    dedupeKey: `COACH_PLAN_${p.action}:${p.planId}:${new Date(p.at).getTime()}`,
  });
});

// ── 請假 ─────────────────────────────────────────

function leaveSpan(leave) {
  return `${fmtDateTime(leave.startAt)} – ${fmtDateTime(leave.endAt)}`;
}

function leaveTypeLabel(leave) {
  return LEAVE_TYPES[leave.leaveType] ?? leave.leaveType;
}

function conflictLines(conflicts) {
  return conflicts
    .slice(0, 5)
    .map((c) => `・${fmtDateTime(c.startAt)} ${c.label}`)
    .concat(conflicts.length > 5 ? [`…共 ${conflicts.length} 班`] : []);
}

/** 員工申請 → 總部審核者＋分店督導（不含事由） */
export const notifyLeaveRequested = safe('請假申請通知', async (leave) => {
  const staff = leave.staff ?? (await staffBrief(leave.staffId));
  const [admins, managers] = await Promise.all([hqAdminIds(), branchManagerIds(staff?.branchId)]);
  const conflicts = leave.conflicts || [];
  return notifyStaff(
    [...admins, ...managers].filter((id) => id !== leave.staffId),
    (recipientId) => ({
      type: 'LEAVE_REQUESTED',
      title: `${staffName(staff)} 申請${leaveTypeLabel(leave)}`,
      body: [
        `${staffName(staff)} 申請${leaveTypeLabel(leave)}：${leaveSpan(leave)}${leave.hours ? `（${leave.hours} 小時）` : ''}。`,
        conflicts.length ? `與 ${conflicts.length} 個已排班次重疊，核准後需調整班表：` : null,
        ...conflictLines(conflicts),
        '請至總部「員工 HR → 請假」審核。',
      ]
        .filter(Boolean)
        .join('\n'),
      link: admins.includes(recipientId) ? LINK_HQ : LINK_ROSTER,
      dedupeKey: `LEAVE_REQUESTED:${leave.id}`,
    }),
  );
});

/** 審核結果 → 申請人；核准且與班表衝突 → 分店督導 */
export const notifyLeaveReviewed = safe('請假審核通知', async (leave) => {
  const statusText = { APPROVED: '已核准', REJECTED: '未核准', CANCELLED: '已撤銷' }[leave.status];
  if (!statusText) return 0;
  const conflicts = leave.status === 'APPROVED' ? leave.conflicts || [] : [];
  const note = leave.status !== 'APPROVED' && leave.review?.note ? `原因：${String(leave.review.note).slice(0, 120)}` : null;
  let count = await notifyStaff([leave.staffId], {
    type: 'LEAVE_REVIEWED',
    title: `${leaveTypeLabel(leave)}${statusText}`,
    body: [
      `您的${leaveTypeLabel(leave)}（${leaveSpan(leave)}）${statusText}。`,
      note,
      conflicts.length ? `此時段仍有 ${conflicts.length} 個班次，店長將協助調整班表。` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    link: LINK_MY_ATTENDANCE,
    dedupeKey: `LEAVE_REVIEWED:${leave.id}:${leave.status}`,
  });
  if (conflicts.length) count += await notifyLeaveConflict(leave);
  return count;
});

/** 已核准請假與已生效班次重疊 → 分店督導（需撤回班表調整） */
export const notifyLeaveConflict = safe('假期衝突通知', async (leave) => {
  const conflicts = leave.conflicts || [];
  if (!conflicts.length) return 0;
  const staff = leave.staff ?? (await staffBrief(leave.staffId));
  const branchIds = [...new Set([staff?.branchId, ...conflicts.map((c) => c.branchId)].filter(Boolean))];
  const managers = [...new Set((await Promise.all(branchIds.map(branchManagerIds))).flat())];
  return notifyStaff(
    managers.filter((id) => id !== leave.staffId),
    {
      type: 'LEAVE_CONFLICT',
      title: `假期衝突：${staffName(staff)} 核准請假與班表重疊`,
      body: [
        `${staffName(staff)} 已核准${leaveTypeLabel(leave)}（${leaveSpan(leave)}），與以下已生效班次重疊：`,
        ...conflictLines(conflicts),
        '請撤回班表（附原因）調整人力後重新發布。',
      ].join('\n'),
      link: LINK_ROSTER,
      dedupeKey: `LEAVE_CONFLICT:${leave.id}`,
    },
  );
});

// ── 薪資單 ──────────────────────────────────────

function monthLabel(month) {
  const [y, m] = String(month).split('-');
  return `${y} 年 ${Number(m)} 月`;
}

/** 總部結算完成 → 當月有薪資單之員工（不含金額） */
export const notifyPayslipReady = safe('薪資單通知', async ({ runId, month, finalizedAt, staffIds }) =>
  notifyStaff(staffIds, {
    type: 'PAYSLIP_READY',
    title: `${monthLabel(month)}薪資單已發布`,
    body: `${monthLabel(month)}薪資已結算，請至「我的出勤」查看薪資單明細；如有疑問請洽總部。`,
    link: LINK_MY_ATTENDANCE,
    dedupeKey: `PAYSLIP_READY:${runId}:${new Date(finalizedAt).getTime()}`,
  }),
);

/** 總部撤銷結算（重新核算中） */
export const notifyPayslipReopened = safe('薪資單撤銷通知', async ({ runId, month, at, staffIds }) =>
  notifyStaff(staffIds, {
    type: 'PAYSLIP_REOPENED',
    title: `${monthLabel(month)}薪資單重新核算中`,
    body: `總部正在重新核算${monthLabel(month)}薪資，薪資單暫停顯示，完成後將再次通知。`,
    link: LINK_MY_ATTENDANCE,
    dedupeKey: `PAYSLIP_REOPENED:${runId}:${new Date(at).getTime()}`,
  }),
);
