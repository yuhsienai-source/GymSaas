// lib/trainerTimeOff.js — 教練排休／不可預約時段
import prisma from './prisma.js';

export const TIME_OFF_REASONS = ['休假', '外出', '私人', '其他'];

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
    reason: row.reason || '休假',
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
    const err = new Error('排休時間格式無效');
    err.statusCode = 400;
    throw err;
  }
  if (start >= end) {
    const err = new Error('排休結束時間必須晚於開始時間');
    err.statusCode = 400;
    throw err;
  }
  const maxMs = 31 * 24 * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maxMs) {
    const err = new Error('單筆排休最長 31 天，請拆成多筆');
    err.statusCode = 400;
    throw err;
  }
  return { start, end };
}

export function normalizeTimeOffReason(raw) {
  const v = String(raw || '休假').trim().slice(0, 20);
  if (!v) return '休假';
  return TIME_OFF_REASONS.includes(v) ? v : v;
}

/**
 * 若時段與教練排休重疊則拋 409
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} db
 */
export async function assertTrainerNotOnTimeOff(db, trainerId, startAt, endAt) {
  const hit = await db.trainerTimeOff.findFirst({
    where: {
      trainerId: Number(trainerId),
      ...overlapWhere(startAt, endAt),
    },
    orderBy: { startAt: 'asc' },
  });
  if (hit) {
    const err = new Error(
      `教練排休中：${hit.reason || '休假'}（${hit.startAt.toLocaleString('zh-TW')} ~ ${hit.endAt.toLocaleString('zh-TW')}），請改選其他時段`,
    );
    err.statusCode = 409;
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
      `此時段已有課程「${classHit.title}」，請先調整課表或改選排休時間`,
    );
    err.statusCode = 409;
    throw err;
  }

  const dup = await prisma.trainerTimeOff.findFirst({
    where: { trainerId: tid, ...overlapWhere(start, end) },
  });
  if (dup) {
    const err = new Error('與既有排休時段重疊');
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
    const err = new Error('找不到排休紀錄');
    err.statusCode = 404;
    throw err;
  }
  if (trainerId != null && existing.trainerId !== Number(trainerId)) {
    const err = new Error('無權修改此排休');
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
    const err = new Error(`此時段已有課程「${classHit.title}」，無法改為此排休`);
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
    const err = new Error('與既有排休時段重疊');
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
    const err = new Error('找不到排休紀錄');
    err.statusCode = 404;
    throw err;
  }
  if (trainerId != null && existing.trainerId !== Number(trainerId)) {
    const err = new Error('無權刪除此排休');
    err.statusCode = 403;
    throw err;
  }
  await prisma.trainerTimeOff.delete({ where: { id: existing.id } });
  return serializeTimeOff(existing);
}
