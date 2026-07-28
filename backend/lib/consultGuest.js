// lib/consultGuest.js — 諮詢客人（姓名＋電話，教練代登）
import { normalizePhone } from './memberIdentify.js';

export function serializeConsultGuest(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    note: row.note || null,
    trainerId: row.trainerId,
    memberId: row.memberId ?? null,
    memberName: row.member?.name || null,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseGuestContact({ name, phone }) {
  const guestName = String(name || '').trim().slice(0, 40);
  const guestPhone = normalizePhone(phone);
  if (!guestName) {
    const err = new Error('請輸入諮詢客人姓名');
    err.statusCode = 400;
    throw err;
  }
  if (!guestPhone || guestPhone.length < 8) {
    const err = new Error('請輸入有效電話（至少 8 碼）');
    err.statusCode = 400;
    throw err;
  }
  if (guestPhone.length > 20) {
    const err = new Error('電話過長');
    err.statusCode = 400;
    throw err;
  }
  return { name: guestName, phone: guestPhone };
}

/**
 * 依教練＋電話找到或建立諮詢客人；若電話已是會員則自動連結 memberId
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof import('./prisma.js').default} db
 */
export async function upsertConsultGuest(db, { trainerId, name, phone, note }) {
  const contact = parseGuestContact({ name, phone });
  const member = await db.member.findUnique({
    where: { phone: contact.phone },
    select: { id: true, name: true },
  });

  const noteVal =
    note === undefined || note === null ? undefined : String(note).trim().slice(0, 200) || null;

  const existing = await db.consultGuest.findUnique({
    where: {
      trainerId_phone: {
        trainerId: Number(trainerId),
        phone: contact.phone,
      },
    },
  });

  if (existing) {
    return db.consultGuest.update({
      where: { id: existing.id },
      data: {
        name: contact.name,
        isActive: true,
        ...(noteVal !== undefined ? { note: noteVal } : {}),
        ...(member ? { memberId: member.id } : {}),
      },
      include: { member: { select: { id: true, name: true } } },
    });
  }

  return db.consultGuest.create({
    data: {
      trainerId: Number(trainerId),
      name: contact.name,
      phone: contact.phone,
      note: noteVal ?? null,
      memberId: member?.id ?? null,
      isActive: true,
    },
    include: { member: { select: { id: true, name: true } } },
  });
}
