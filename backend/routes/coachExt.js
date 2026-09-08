// routes/coachExt.js — 教練延伸（QR 簽到、訓練紀錄、場地預約、拆帳）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin, requirePermission } from '../middleware/jwtAuth.js';
import { isAdminUser } from '../lib/staffAccess.js';
import {
  assertOwnsTrainerOrAdmin,
  resolveTrainerWorkspace,
} from '../lib/trainerAccess.js';
import { venueStationConflictWhere } from '../lib/venueStation.js';
import {
  createClassCheckInToken,
  checkInWithToken,
} from '../lib/classCheckIn.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function parseDate(value, fieldName) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(`${fieldName} 無效`);
  return d;
}

function sendErr(res, error, fallback = '操作失敗') {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

function overlapWhere(startAt, endAt) {
  return { startAt: { lt: endAt }, endAt: { gt: startAt } };
}

function generateCommissionLedgerId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `CCL${dateStr}${randomStr}`;
}

function pickTierRate(tierRates, gross) {
  const tiers = Array.isArray(tierRates) ? [...tierRates] : [{ minRevenue: 0, rate: 0.3 }];
  tiers.sort((a, b) => (b.minRevenue || 0) - (a.minRevenue || 0));
  for (const t of tiers) {
    if (gross >= (Number(t.minRevenue) || 0)) {
      return Number(t.rate) || 0;
    }
  }
  return 0;
}

async function assertTrainerOwnsClass(req, classId, trainer) {
  const cls = await prisma.class.findUnique({ where: { id: Number(classId) } });
  if (!cls) throw httpError('找不到課程', 404);
  if (trainer) assertOwnsTrainerOrAdmin(req, cls.trainerId, trainer.id);
  return cls;
}

async function assertMemberIsTrainerStudent(trainerId, memberId) {
  const linked = await prisma.pTContract.findFirst({
    where: { trainerId, memberId, isActive: true },
  });
  if (linked) return;
  const reserved = await prisma.reservation.findFirst({
    where: {
      memberId,
      class: { trainerId },
      status: { in: ['CONFIRMED', 'PENDING', 'ATTENDED'] },
    },
  });
  if (!reserved) throw httpError('此會員不在您的學員名單', 403);
}

// ==========================================
// 教練端：/api/trainer/ext
// ==========================================
export const coachExtTrainerRouter = express.Router();
coachExtTrainerRouter.use(verifyStaff, requirePermission('trainer'));

coachExtTrainerRouter.post('/classes/:id/check-in-token', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId ?? req.query?.viewAsTrainerId,
    });
    if (!trainer && !isAdminUser(req.user)) {
      throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    }
    await assertTrainerOwnsClass(req, req.params.id, trainer);
    const kind = String(req.body?.kind || 'GROUP_VENUE').toUpperCase();
    const result = await createClassCheckInToken(req.params.id, kind);
    res.json({ status: 'success', message: 'QR 簽到碼已產生', data: result });
  } catch (error) {
    sendErr(res, error, '產生 QR 失敗');
  }
});

coachExtTrainerRouter.post('/check-in', async (req, res) => {
  try {
    const result = await checkInWithToken(req.body?.token, req.body?.reservationId);
    res.json({
      status: 'success',
      message: result.already ? '已簽到過' : '簽到成功',
      data: result,
    });
  } catch (error) {
    sendErr(res, error, '簽到失敗');
  }
});

coachExtTrainerRouter.get('/training-records', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const where = { trainerId: trainer.id };
    if (req.query.memberId) where.memberId = parseInt(req.query.memberId, 10);
    const rows = await prisma.trainingRecord.findMany({
      where,
      include: { member: { select: { id: true, name: true, memberNo: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, parseInt(req.query.take, 10) || 50),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取訓練紀錄失敗');
  }
});

coachExtTrainerRouter.post('/training-records', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const memberId = parseInt(req.body?.memberId, 10);
    if (!Number.isInteger(memberId) || memberId <= 0) throw httpError('請提供 memberId');
    await assertMemberIsTrainerStudent(trainer.id, memberId);
    const title = String(req.body?.title || '').trim().slice(0, 80);
    if (!title) throw httpError('請提供 title');
    const row = await prisma.trainingRecord.create({
      data: {
        memberId,
        trainerId: trainer.id,
        title,
        content: req.body?.content ?? null,
      },
      include: { member: { select: { id: true, name: true } } },
    });
    res.json({ status: 'success', message: '已建立訓練紀錄', data: row });
  } catch (error) {
    sendErr(res, error, '建立訓練紀錄失敗');
  }
});

coachExtTrainerRouter.patch('/training-records/:id/share', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {});
    if (!trainer) throw httpError('請綁定教練檔案', 403);
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.trainingRecord.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ status: 'error', message: '找不到紀錄' });
    assertOwnsTrainerOrAdmin(req, existing.trainerId, trainer.id);
    const shared = req.body?.shared !== false;
    const row = await prisma.trainingRecord.update({
      where: { id },
      data: { sharedAt: shared ? new Date() : null },
    });
    res.json({ status: 'success', message: shared ? '已分享給學員' : '已取消分享', data: row });
  } catch (error) {
    sendErr(res, error, '更新分享狀態失敗');
  }
});

coachExtTrainerRouter.get('/self-training-plans', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const where = { trainerId: trainer.id };
    if (req.query.memberId) where.memberId = parseInt(req.query.memberId, 10);
    const rows = await prisma.selfTrainingPlan.findMany({
      where,
      include: { member: { select: { id: true, name: true, memberNo: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取自主訓練課表失敗');
  }
});

coachExtTrainerRouter.post('/self-training-plans', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const memberId = parseInt(req.body?.memberId, 10);
    if (!Number.isInteger(memberId) || memberId <= 0) throw httpError('請提供 memberId');
    await assertMemberIsTrainerStudent(trainer.id, memberId);
    const title = String(req.body?.title || '').trim().slice(0, 80);
    if (!title) throw httpError('請提供 title');
    const row = await prisma.selfTrainingPlan.create({
      data: {
        memberId,
        trainerId: trainer.id,
        title,
        exercises: req.body?.exercises ?? null,
      },
    });
    res.json({ status: 'success', message: '已建立自主訓練課表', data: row });
  } catch (error) {
    sendErr(res, error, '建立自主訓練課表失敗');
  }
});

coachExtTrainerRouter.get('/venue-bookings', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const where = { trainerId: trainer.id, status: { not: 'CANCELLED' } };
    if (req.query.from) where.startAt = { ...(where.startAt || {}), gte: parseDate(req.query.from, 'from') };
    if (req.query.to) where.startAt = { ...(where.startAt || {}), lte: parseDate(req.query.to, 'to') };
    const rows = await prisma.venueBooking.findMany({
      where,
      include: { venue: { select: { id: true, name: true, branchId: true } } },
      orderBy: { startAt: 'asc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取場地預約失敗');
  }
});

coachExtTrainerRouter.post('/venue-bookings', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const venueId = parseInt(req.body?.venueId, 10);
    const startAt = parseDate(req.body?.startAt, 'startAt');
    const endAt = parseDate(req.body?.endAt, 'endAt');
    if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');
    const stationId =
      req.body?.stationId != null ? parseInt(req.body.stationId, 10) : null;

    const classConflict = await prisma.class.findFirst({
      where: {
        ...venueStationConflictWhere(venueId, stationId),
        ...overlapWhere(startAt, endAt),
      },
    });
    if (classConflict) throw httpError('時段與既有課程衝突', 409);

    const bookingConflict = await prisma.venueBooking.findFirst({
      where: {
        venueId,
        status: { not: 'CANCELLED' },
        ...overlapWhere(startAt, endAt),
        ...(stationId != null
          ? { OR: [{ stationId }, { stationId: null }] }
          : {}),
      },
    });
    if (bookingConflict) throw httpError('時段與既有場地預約衝突', 409);

    const row = await prisma.venueBooking.create({
      data: {
        venueId,
        stationId,
        trainerId: trainer.id,
        memberId: req.body?.memberId ? parseInt(req.body.memberId, 10) : null,
        startAt,
        endAt,
        note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
      },
      include: { venue: { select: { id: true, name: true } } },
    });
    res.json({ status: 'success', message: '場地預約成功', data: row });
  } catch (error) {
    sendErr(res, error, '場地預約失敗');
  }
});

coachExtTrainerRouter.get('/google-calendar/status', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const link = await prisma.googleCalendarLink.findUnique({
      where: { trainerId: trainer.id },
    });
    res.json({
      status: 'success',
      data: {
        linked: Boolean(link?.calendarId),
        calendarId: link?.calendarId || null,
        syncEnabled: link?.syncEnabled ?? false,
      },
    });
  } catch (error) {
    sendErr(res, error, '讀取 Google 日曆狀態失敗');
  }
});

coachExtTrainerRouter.post('/google-calendar/link', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const calendarId = String(req.body?.calendarId || '').trim();
    if (!calendarId) throw httpError('請提供 calendarId');
    const row = await prisma.googleCalendarLink.upsert({
      where: { trainerId: trainer.id },
      create: { trainerId: trainer.id, calendarId, syncEnabled: false },
      update: { calendarId },
    });
    res.json({ status: 'success', message: '已儲存 Google 日曆連結（OAuth 同步待實作）', data: row });
  } catch (error) {
    sendErr(res, error, '連結 Google 日曆失敗');
  }
});

coachExtTrainerRouter.get('/consult-allocations', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query?.viewAsTrainerId,
    });
    if (!trainer) throw httpError('請指定 viewAsTrainerId 或綁定教練檔案', 403);
    const rows = await prisma.consultAllocation.findMany({
      where: { trainerId: trainer.id },
      include: {
        consultGuest: { select: { id: true, name: true, phone: true, memberId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, parseInt(req.query.take, 10) || 50),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取諮詢分配失敗');
  }
});

// ==========================================
// HQ 教練拆帳：/api/hq/coach
// ==========================================
export const coachExtAdminRouter = express.Router();
coachExtAdminRouter.use(verifyStaff, requireAdmin);

coachExtAdminRouter.get('/commission-rules', async (req, res) => {
  try {
    const where = { isActive: true };
    if (req.query.trainerId) where.trainerId = parseInt(req.query.trainerId, 10);
    const rows = await prisma.coachCommissionRule.findMany({
      where,
      include: { trainer: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取拆帳規則失敗');
  }
});

coachExtAdminRouter.post('/commission-rules', async (req, res) => {
  try {
    const row = await prisma.coachCommissionRule.create({
      data: {
        trainerId: req.body?.trainerId ? parseInt(req.body.trainerId, 10) : null,
        courseKind: String(req.body?.courseKind || 'PRIVATE').toUpperCase(),
        payModel: String(req.body?.payModel || 'PERFORMANCE').toUpperCase(),
        baseSalary: Number(req.body?.baseSalary) || 0,
        tierRates: req.body?.tierRates ?? null,
        hourlyRate: req.body?.hourlyRate != null ? Number(req.body.hourlyRate) : null,
        perHeadRate: req.body?.perHeadRate != null ? Number(req.body.perHeadRate) : null,
        deductRates: req.body?.deductRates ?? null,
        scoreFactor: req.body?.scoreFactor ?? null,
      },
    });
    res.json({ status: 'success', message: '已建立拆帳規則', data: row });
  } catch (error) {
    sendErr(res, error, '建立拆帳規則失敗');
  }
});

coachExtAdminRouter.patch('/commission-rules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = {};
    for (const key of [
      'courseKind',
      'payModel',
      'baseSalary',
      'tierRates',
      'hourlyRate',
      'perHeadRate',
      'deductRates',
      'scoreFactor',
      'isActive',
    ]) {
      if (req.body?.[key] !== undefined) data[key] = req.body[key];
    }
    const row = await prisma.coachCommissionRule.update({ where: { id }, data });
    res.json({ status: 'success', message: '已更新拆帳規則', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到規則' });
    }
    sendErr(res, error, '更新拆帳規則失敗');
  }
});

coachExtAdminRouter.get('/commission-ledger', async (req, res) => {
  try {
    const where = {};
    if (req.query.trainerId) where.trainerId = parseInt(req.query.trainerId, 10);
    if (req.query.from) where.periodStart = { ...(where.periodStart || {}), gte: parseDate(req.query.from, 'from') };
    if (req.query.to) where.periodEnd = { ...(where.periodEnd || {}), lte: parseDate(req.query.to, 'to') };
    const rows = await prisma.coachCommissionLedger.findMany({
      where,
      include: { trainer: { select: { id: true, name: true } } },
      orderBy: { periodStart: 'desc' },
      take: Math.min(200, parseInt(req.query.take, 10) || 100),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取拆帳帳冊失敗');
  }
});

coachExtAdminRouter.post('/commission-ledger/run', async (req, res) => {
  try {
    const trainerId = parseInt(req.body?.trainerId, 10);
    const periodStart = parseDate(req.body?.periodStart, 'periodStart');
    const periodEnd = parseDate(req.body?.periodEnd, 'periodEnd');
    if (periodEnd <= periodStart) throw httpError('periodEnd 須晚於 periodStart');

    const rule = await prisma.coachCommissionRule.findFirst({
      where: { trainerId, isActive: true, courseKind: 'PRIVATE' },
    });
    const tierRates = rule?.tierRates;

    const ptContracts = await prisma.pTContract.findMany({
      where: { trainerId, isActive: true, source: 'PURCHASE' },
    });
    const ptAttendances = await prisma.classAttendance.findMany({
      where: {
        checkedInAt: { gte: periodStart, lte: periodEnd },
        class: { trainerId, type: 'PRIVATE' },
      },
      include: { class: true },
    });

    let ptGross = 0;
    for (const att of ptAttendances) {
      const contract = ptContracts.find((c) => c.memberId === att.memberId);
      if (!contract || contract.totalSessions <= 0) continue;
      ptGross += contract.pricePaid / contract.totalSessions;
    }

    const groupAttendances = await prisma.classAttendance.findMany({
      where: {
        checkedInAt: { gte: periodStart, lte: periodEnd },
        class: { trainerId, type: 'GROUP' },
      },
    });
    const groupRule = await prisma.coachCommissionRule.findFirst({
      where: { trainerId, isActive: true, courseKind: 'GROUP' },
    });
    const perHead = Number(groupRule?.perHeadRate) || 0;
    const groupGross = groupAttendances.length * perHead;

    const grossAmount = Math.round((ptGross + groupGross) * 100) / 100;
    const rate = pickTierRate(tierRates, ptGross);
    const commission = Math.round(ptGross * rate * 100) / 100;
    const baseSalary = Number(rule?.baseSalary) || 0;
    const netAmount = Math.round((baseSalary + commission + groupGross) * 100) / 100;

    const row = await prisma.coachCommissionLedger.create({
      data: {
        id: generateCommissionLedgerId(),
        trainerId,
        periodStart,
        periodEnd,
        grossAmount,
        deductions: 0,
        netAmount,
        detail: {
          ptGross,
          groupGross,
          tierRate: rate,
          ptSessions: ptAttendances.length,
          groupHeads: groupAttendances.length,
          baseSalary,
        },
      },
    });
    res.json({ status: 'success', message: '拆帳試算完成', data: row });
  } catch (error) {
    sendErr(res, error, '拆帳試算失敗');
  }
});

coachExtAdminRouter.post('/consult-allocate', async (req, res) => {
  try {
    const consultGuestId = parseInt(req.body?.consultGuestId, 10);
    const trainerId = parseInt(req.body?.trainerId, 10);
    if (!Number.isInteger(consultGuestId) || !Number.isInteger(trainerId)) {
      throw httpError('請提供 consultGuestId 與 trainerId');
    }
    const guest = await prisma.consultGuest.findUnique({ where: { id: consultGuestId } });
    if (!guest) return res.status(404).json({ status: 'error', message: '找不到諮詢客人' });
    const row = await prisma.consultAllocation.create({
      data: {
        consultGuestId,
        trainerId,
        assignMode: String(req.body?.assignMode || 'MANUAL').toUpperCase(),
        staffId: req.user?.id ?? null,
        note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
      },
      include: {
        consultGuest: { select: { id: true, name: true, phone: true } },
      },
    });
    const trainer = await prisma.trainer.findUnique({
      where: { id: trainerId },
      select: { id: true, name: true },
    });
    res.json({ status: 'success', message: '已分配諮詢資源', data: { ...row, trainer } });
  } catch (error) {
    sendErr(res, error, '諮詢分配失敗');
  }
});
