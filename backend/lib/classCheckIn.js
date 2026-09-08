// lib/classCheckIn.js — 課堂 QR 簽到 token
import crypto from 'crypto';
import prisma from './prisma.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

export async function createClassCheckInToken(classId, kind = 'GROUP_VENUE') {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.classCheckInToken.create({
    data: {
      classId: Number(classId),
      token,
      kind,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export async function checkInWithToken(token, reservationId) {
  const row = await prisma.classCheckInToken.findUnique({
    where: { token: String(token || '').trim() },
    include: { class: true },
  });
  if (!row || row.expiresAt < new Date()) {
    const err = new Error('QR 已失效或不存在');
    err.statusCode = 400;
    throw err;
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id: Number(reservationId) },
    include: { class: true, member: true },
  });
  if (!reservation || reservation.classId !== row.classId) {
    const err = new Error('預約與 QR 課程不符');
    err.statusCode = 400;
    throw err;
  }
  if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
    const err = new Error('預約狀態不可簽到');
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.classAttendance.findUnique({
    where: { reservationId: reservation.id },
  });
  if (existing) {
    return { already: true, attendance: existing };
  }

  const attendance = await prisma.$transaction(async (tx) => {
    const att = await tx.classAttendance.create({
      data: {
        classId: reservation.classId,
        reservationId: reservation.id,
        memberId: reservation.memberId,
        method: 'QR',
      },
    });

    // 團課點數課：簽到扣 1 點（吃到飽 UNLIMITED_PASS 只記錄）
    if (reservation.class.type === 'GROUP' && reservation.memberId) {
      const deductPoints = 1;
      const member = await tx.member.findUnique({ where: { id: reservation.memberId } });
      if (member && member.pointsBalance >= deductPoints) {
        const balance = member.pointsBalance - deductPoints;
        await tx.member.update({
          where: { id: member.id },
          data: { pointsBalance: balance },
        });
        await tx.memberPointsLedger.create({
          data: {
            memberId: member.id,
            delta: -deductPoints,
            balance,
            reason: '團課簽到扣點',
            refType: 'CLASS',
            refId: String(reservation.classId),
          },
        });
      }
    }

    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: 'ATTENDED' },
    });

    return att;
  });

  return { already: false, attendance };
}
