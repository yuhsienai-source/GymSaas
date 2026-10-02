// lib/trainerTimeOff.js — 教練排課可用性：出勤班表內、非請假、非「不開放預約」時段
/**
 * 教練為僱傭關係：休假一律走週班表例假／休息日或請假系統；TrainerTimeOff 僅為工時內不開放預約（行政、備課等）。
 */
import prisma from './prisma.js';
import { EFFECTIVE_WORK_SLOT_WHERE } from './staffScheduleService.js';

export const TIME_OFF_REASONS = ['行政作業', '備課', '外出公務', '其他'];
const LEAVE_LIKE_REASONS = ['休假', '私人', '請假', '排休'];

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/**
 * 排課／預約前檢查（交易內呼叫）：
 * 1. 教練須綁定在職員工帳號（僱傭關係）→ 409 COACH_NOT_EMPLOYED
 * 2. 時段須完全落在已生效班表（核准週班表／已發布四週排班／總部臨時排班）→ 409 OUTSIDE_WORK_SCHEDULE
 * 3. 不得與已核准請假重疊 → 409 COACH_ON_LEAVE
 * 4. 不得與不開放預約時段重疊 → 409
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} db
 */
export async function assertTrainerBookable(db, trainerId, startAt, endAt) {
  const trainer = await db.trainer.findUnique({
    where: { id: Number(trainerId) },
    select: { id: true, staffId: true, staff: { select: { id: true, isActive: true } } },
  });
  if (!trainer) throw httpError('找不到教練', 404);
  if (!trainer.staffId || !trainer.staff?.isActive) {
    throw httpError('教練未綁定在職員工帳號（僱傭關係），不得排課或預約；請洽總部綁定', 409, 'COACH_NOT_EMPLOYED');
  }
  const slots = await db.staffSchedule.findMany({
    where: { AND: [EFFECTIVE_WORK_SLOT_WHERE, { staffId: trainer.staffId, startAt: { lt: endAt }, endAt: { gt: startAt } }] },
    select: { startAt: true, endAt: true },
    orderBy: { startAt: 'asc' },
  });
  let cursor = new Date(startAt).getTime();
  for (const s of slots) {
    if (s.startAt.getTime() > cursor) break;
    cursor = Math.max(cursor, s.endAt.getTime());
  }
  if (cursor < new Date(endAt).getTime()) {
    throw httpError(
      '課程時段不在教練已核准之出勤班表內；班表外授課屬未經同意之延長工時，請先調整班表',
      409,
      'OUTSIDE_WORK_SCHEDULE',
    );
  }
  const leave = await db.staffLeave.findFirst({
    where: { staffId: trainer.staffId, status: 'APPROVED', startAt: { lt: endAt }, endAt: { gt: startAt } },
    select: { id: true },
  });
  if (leave) throw httpError('教練該時段已核准請假，請改選其他時段', 409, 'COACH_ON_LEAVE');
  await assertTrainerNotOnTimeOff(db, trainer.id, startAt, endAt);
}

export function overlapWhere(startAt, endAt) {
  return {
    startAt: { lt: endAt },
    endAt: { gt: startAt },
  };
}

export function serializeTimeOff(row) {
  return {
    id: row.id,
    trainerId: row.trainerId,
    startAt: row.startAt,
    endAt: row.endAt,
    reason: row.reason || '其他',
    note: row.note || null,
    createdByStaffId: row.createdByStaffId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseTimeOffRange(startAt, endAt) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw httpError('時段格式無效', 400);
  }
  if (start >= end) {
    throw httpError('結束時間必須晚於開始時間', 400);
  }
  if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) {
    throw httpError('不開放預約時段單筆最長 24 小時；休假請改用請假或週班表例假／休息日', 400);
  }
  return { start, end };
}

export function normalizeTimeOffReason(raw) {
  const v = String(raw || '其他').trim().slice(0, 20) || '其他';
  if (LEAVE_LIKE_REASONS.includes(v)) {
    throw httpError('休假請於「我的出勤」申請請假，或於週班表指定例假／休息日', 400, 'USE_LEAVE');
  }
  return v;
}

/**
 * 若時段與教練不開放預約時段重疊則拋 409
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} db
 */
async function assertTrainerNotOnTimeOff(db, trainerId, startAt, endAt) {
  const hit = await db.trainerTimeOff.findFirst({
    where: {
      trainerId: Number(trainerId),
      ...overlapWhere(startAt, endAt),
    },
    orderBy: { startAt: 'asc' },
  });
  if (hit) {
    const err = httpError(
      `教練該時段不開放預約：${hit.reason || '其他'}（${hit.startAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} ~ ${hit.endAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}），請改選其他時段`,
      409,
      'COACH_UNAVAILABLE',
    );
    err.timeOff = serializeTimeOff(hit);
    throw err;
  }
  return null;
}

export async function listTrainerTimeOffs({
  trainerId,
  from,
  to,
  take = 80,
} = {}) {
  const tid = Number(trainerId);
  if (!Number.isInteger(tid) || tid <= 0) {
    const err = new Error('請指定教練');
    err.statusCode = 400;
    throw err;
  }
  const where = { trainerId: tid };
  if (from || to) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date('2999-01-01T00:00:00Z');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      const err = new Error('查詢區間無效');
      err.statusCode = 400;
      throw err;
    }
    where.AND = [{ startAt: { lt: end } }, { endAt: { gt: start } }];
  }
  const rows = await prisma.trainerTimeOff.findMany({
    where,
    orderBy: { startAt: 'asc' },
    take: Math.min(200, Math.max(1, take)),
  });
  return rows.map(serializeTimeOff);
}

export async function createTrainerTimeOff({
  trainerId,
  startAt,
  endAt,
  reason,
  note,
  createdByStaffId,
} = {}) {
  const tid = Number(trainerId);
  if (!Number.isInteger(tid) || tid <= 0) {
    const err = new Error('請指定教練');
    err.statusCode = 400;
    throw err;
  }
  const { start, end } = parseTimeOffRange(startAt, endAt);
  const trainer = await prisma.trainer.findUnique({ where: { id: tid } });
  if (!trainer || !trainer.isActive) {
    const err = new Error('教練不存在或已停用');
    err.statusCode = 404;
    throw err;
  }

  const classHit = await prisma.class.findFirst({
    where: { trainerId: tid, ...overlapWhere(start, end) },
    select: { id: true, title: true, startAt: true, endAt: true },
  });
  if (classHit) {
    const err = new Error(
      `此時段已有課程「${classHit.title}」，請先調整課表或改選其他時段`,
    );
    err.statusCode = 409;
    throw err;
  }

  const dup = await prisma.trainerTimeOff.findFirst({
    where: { trainerId: tid, ...overlapWhere(start, end) },
  });
  if (dup) {
    const err = new Error('與既有不開放預約時段重疊');
    err.statusCode = 409;
    throw err;
  }

  const row = await prisma.trainerTimeOff.create({
    data: {
      trainerId: tid,
      startAt: start,
      endAt: end,
      reason: normalizeTimeOffReason(reason),
      note: note ? String(note).trim().slice(0, 200) : null,
      createdByStaffId: createdByStaffId || null,
    },
  });
  return serializeTimeOff(row);
}

export async function updateTrainerTimeOff({
  id,
  trainerId,
  startAt,
  endAt,
  reason,
  note,
} = {}) {
  const existing = await prisma.trainerTimeOff.findUnique({ where: { id: Number(id) } });
  if (!existing) {
    const err = new Error('找不到不開放預約時段');
    err.statusCode = 404;
    throw err;
  }
  if (trainerId != null && existing.trainerId !== Number(trainerId)) {
    const err = new Error('無權修改此不開放預約時段');
    err.statusCode = 403;
    throw err;
  }

  const start = startAt != null ? new Date(startAt) : existing.startAt;
  const end = endAt != null ? new Date(endAt) : existing.endAt;
  const { start: s, end: e } = parseTimeOffRange(start, end);

  const classHit = await prisma.class.findFirst({
    where: { trainerId: existing.trainerId, ...overlapWhere(s, e) },
    select: { id: true, title: true },
  });
  if (classHit) {
    const err = new Error(`此時段已有課程「${classHit.title}」，無法設為不開放預約`);
    err.statusCode = 409;
    throw err;
  }

  const dup = await prisma.trainerTimeOff.findFirst({
    where: {
      trainerId: existing.trainerId,
      id: { not: existing.id },
      ...overlapWhere(s, e),
    },
  });
  if (dup) {
    const err = new Error('與既有不開放預約時段重疊');
    err.statusCode = 409;
    throw err;
  }

  const row = await prisma.trainerTimeOff.update({
    where: { id: existing.id },
    data: {
      startAt: s,
      endAt: e,
      reason: reason !== undefined ? normalizeTimeOffReason(reason) : undefined,
      note:
        note === undefined
          ? undefined
          : note
            ? String(note).trim().slice(0, 200)
            : null,
    },
  });
  return serializeTimeOff(row);
}

export async function deleteTrainerTimeOff({ id, trainerId } = {}) {
  const existing = await prisma.trainerTimeOff.findUnique({ where: { id: Number(id) } });
  if (!existing) {
    const err = new Error('找不到不開放預約時段');
    err.statusCode = 404;
    throw err;
  }
  if (trainerId != null && existing.trainerId !== Number(trainerId)) {
    const err = new Error('無權刪除此不開放預約時段');
    err.statusCode = 403;
    throw err;
  }
  await prisma.trainerTimeOff.delete({ where: { id: existing.id } });
  return serializeTimeOff(existing);
}
