// routes/hr.js — 員工考勤／請假／排班（HQ 管理 + 員工自助）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';

/** 員工 JWT：staffId 在 id（相容 staffId 欄位） */
function staffIdFromUser(user) {
  const raw = user?.staffId ?? user?.id;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError('branchId 無效');
  return n;
}

function sendErr(res, error, fallback = '操作失敗') {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

const staffInclude = { staff: { select: { id: true, name: true, displayName: true, role: true } } };

// ==========================================
// HQ 管理：/api/hq/hr
// ==========================================
export const hrAdminRouter = express.Router();
hrAdminRouter.use(verifyStaff, requireAdmin);

hrAdminRouter.get('/attendance', async (req, res) => {
  try {
    const where = {};
    if (req.query.staffId) where.staffId = parseInt(req.query.staffId, 10);
    if (req.query.from) where.punchIn = { ...(where.punchIn || {}), gte: parseDate(req.query.from, 'from') };
    if (req.query.to) where.punchIn = { ...(where.punchIn || {}), lte: parseDate(req.query.to, 'to') };
    const rows = await prisma.staffAttendance.findMany({
      where,
      include: staffInclude,
      orderBy: { punchIn: 'desc' },
      take: Math.min(500, parseInt(req.query.take, 10) || 200),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取考勤失敗');
  }
});

hrAdminRouter.post('/attendance', async (req, res) => {
  try {
    const staffId = parseInt(req.body?.staffId, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) throw httpError('請提供 staffId');
    const punchIn = parseDate(req.body?.punchIn || new Date(), 'punchIn');
    const punchOut = req.body?.punchOut ? parseDate(req.body.punchOut, 'punchOut') : null;
    const row = await prisma.staffAttendance.create({
      data: {
        staffId,
        branchId: parseOptionalInt(req.body?.branchId),
        punchIn,
        punchOut,
        note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
      },
      include: staffInclude,
    });
    res.json({ status: 'success', message: '已建立考勤紀錄', data: row });
  } catch (error) {
    sendErr(res, error, '建立考勤失敗');
  }
});

hrAdminRouter.get('/leaves', async (req, res) => {
  try {
    const where = {};
    if (req.query.staffId) where.staffId = parseInt(req.query.staffId, 10);
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    const rows = await prisma.staffLeave.findMany({
      where,
      include: staffInclude,
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, parseInt(req.query.take, 10) || 100),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取請假失敗');
  }
});

hrAdminRouter.post('/leaves', async (req, res) => {
  try {
    const staffId = parseInt(req.body?.staffId, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) throw httpError('請提供 staffId');
    const startAt = parseDate(req.body?.startAt, 'startAt');
    const endAt = parseDate(req.body?.endAt, 'endAt');
    if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');
    const row = await prisma.staffLeave.create({
      data: {
        staffId,
        startAt,
        endAt,
        reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
        proofUrl: req.body?.proofUrl ? String(req.body.proofUrl).slice(0, 500) : null,
        status: 'APPROVED',
      },
      include: staffInclude,
    });
    res.json({ status: 'success', message: '已建立請假', data: row });
  } catch (error) {
    sendErr(res, error, '建立請假失敗');
  }
});

hrAdminRouter.patch('/leaves/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = String(req.body?.status || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw httpError('status 須為 APPROVED 或 REJECTED');
    }
    const existing = await prisma.staffLeave.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ status: 'error', message: '找不到請假紀錄' });
    const row = await prisma.staffLeave.update({
      where: { id },
      data: { status },
      include: staffInclude,
    });
    res.json({ status: 'success', message: status === 'APPROVED' ? '已核准' : '已拒絕', data: row });
  } catch (error) {
    sendErr(res, error, '更新請假失敗');
  }
});

hrAdminRouter.get('/schedules', async (req, res) => {
  try {
    const where = {};
    if (req.query.staffId) where.staffId = parseInt(req.query.staffId, 10);
    if (req.query.branchId) where.branchId = parseInt(req.query.branchId, 10);
    if (req.query.from) where.startAt = { ...(where.startAt || {}), gte: parseDate(req.query.from, 'from') };
    if (req.query.to) where.startAt = { ...(where.startAt || {}), lte: parseDate(req.query.to, 'to') };
    const rows = await prisma.staffSchedule.findMany({
      where,
      include: staffInclude,
      orderBy: { startAt: 'asc' },
      take: Math.min(500, parseInt(req.query.take, 10) || 200),
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取排班失敗');
  }
});

hrAdminRouter.post('/schedules', async (req, res) => {
  try {
    const staffId = parseInt(req.body?.staffId, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) throw httpError('請提供 staffId');
    const startAt = parseDate(req.body?.startAt, 'startAt');
    const endAt = parseDate(req.body?.endAt, 'endAt');
    if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');
    const row = await prisma.staffSchedule.create({
      data: {
        staffId,
        branchId: parseOptionalInt(req.body?.branchId),
        startAt,
        endAt,
        slotType: String(req.body?.slotType || 'SHIFT').toUpperCase(),
        note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
      },
      include: staffInclude,
    });
    res.json({ status: 'success', message: '已建立排班', data: row });
  } catch (error) {
    sendErr(res, error, '建立排班失敗');
  }
});

hrAdminRouter.patch('/schedules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.staffSchedule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ status: 'error', message: '找不到排班' });
    const data = {};
    if (req.body?.startAt) data.startAt = parseDate(req.body.startAt, 'startAt');
    if (req.body?.endAt) data.endAt = parseDate(req.body.endAt, 'endAt');
    if (req.body?.branchId !== undefined) data.branchId = parseOptionalInt(req.body.branchId);
    if (req.body?.slotType) data.slotType = String(req.body.slotType).toUpperCase();
    if (req.body?.note !== undefined) {
      data.note = req.body.note ? String(req.body.note).slice(0, 200) : null;
    }
    const row = await prisma.staffSchedule.update({
      where: { id },
      data,
      include: staffInclude,
    });
    res.json({ status: 'success', message: '已更新排班', data: row });
  } catch (error) {
    sendErr(res, error, '更新排班失敗');
  }
});

hrAdminRouter.delete('/schedules/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.staffSchedule.delete({ where: { id } });
    res.json({ status: 'success', message: '已刪除排班' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到排班' });
    }
    sendErr(res, error, '刪除排班失敗');
  }
});

hrAdminRouter.get('/attendance/report', async (req, res) => {
  try {
    const from = parseDate(req.query.from || new Date(Date.now() - 30 * 86400000), 'from');
    const to = parseDate(req.query.to || new Date(), 'to');
    const rows = await prisma.staffAttendance.findMany({
      where: { punchIn: { gte: from, lte: to } },
      include: { staff: { select: { id: true, name: true, displayName: true } } },
    });
    const summary = {};
    for (const row of rows) {
      const key = row.staffId;
      if (!summary[key]) {
        summary[key] = {
          staffId: key,
          staffName: row.staff?.name,
          displayName: row.staff?.displayName,
          shifts: 0,
          totalMinutes: 0,
          openShifts: 0,
        };
      }
      summary[key].shifts += 1;
      const out = row.punchOut || new Date();
      summary[key].totalMinutes += Math.max(0, (out - row.punchIn) / 60000);
      if (!row.punchOut) summary[key].openShifts += 1;
    }
    res.json({
      status: 'success',
      data: {
        from,
        to,
        items: Object.values(summary),
        recordCount: rows.length,
      },
    });
  } catch (error) {
    sendErr(res, error, '匯出考勤報表失敗');
  }
});

hrAdminRouter.get('/leaves/report', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    let start;
    let end;
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map((x) => parseInt(x, 10));
      start = new Date(Date.UTC(y, m - 1, 1));
      end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    const rows = await prisma.staffLeave.findMany({
      where: {
        startAt: { lte: end },
        endAt: { gte: start },
        status: { in: ['APPROVED', 'PENDING'] },
      },
      include: { staff: { select: { id: true, name: true, displayName: true } } },
      orderBy: { startAt: 'asc' },
    });
    res.json({ status: 'success', data: { month: month || `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`, items: rows } });
  } catch (error) {
    sendErr(res, error, '匯出請假報表失敗');
  }
});

// ==========================================
// 員工自助：/api/staff/hr
// ==========================================
export const hrSelfRouter = express.Router();
hrSelfRouter.use(verifyStaff);

hrSelfRouter.post('/punch-in', async (req, res) => {
  try {
    const staffId = staffIdFromUser(req.user);
    if (!staffId) return res.status(403).json({ status: 'error', message: '⛔ 憑證缺少員工 id' });

    const open = await prisma.staffAttendance.findFirst({
      where: { staffId, punchOut: null },
      orderBy: { punchIn: 'desc' },
    });
    if (open) throw httpError('尚有未下班的打卡紀錄，請先 punch-out');

    const row = await prisma.staffAttendance.create({
      data: {
        staffId,
        branchId: parseOptionalInt(req.body?.branchId) ?? req.user?.branchId ?? null,
        punchIn: new Date(),
      },
    });
    res.json({ status: 'success', message: '上班打卡成功', data: row });
  } catch (error) {
    sendErr(res, error, '上班打卡失敗');
  }
});

hrSelfRouter.post('/punch-out', async (req, res) => {
  try {
    const staffId = staffIdFromUser(req.user);
    if (!staffId) return res.status(403).json({ status: 'error', message: '⛔ 憑證缺少員工 id' });

    const open = await prisma.staffAttendance.findFirst({
      where: { staffId, punchOut: null },
      orderBy: { punchIn: 'desc' },
    });
    if (!open) throw httpError('找不到未下班的打卡紀錄');

    const row = await prisma.staffAttendance.update({
      where: { id: open.id },
      data: { punchOut: new Date() },
    });
    res.json({ status: 'success', message: '下班打卡成功', data: row });
  } catch (error) {
    sendErr(res, error, '下班打卡失敗');
  }
});

hrSelfRouter.post('/leave-request', async (req, res) => {
  try {
    const staffId = staffIdFromUser(req.user);
    if (!staffId) return res.status(403).json({ status: 'error', message: '⛔ 憑證缺少員工 id' });

    const startAt = parseDate(req.body?.startAt, 'startAt');
    const endAt = parseDate(req.body?.endAt, 'endAt');
    if (endAt <= startAt) throw httpError('結束時間須晚於開始時間');

    const row = await prisma.staffLeave.create({
      data: {
        staffId,
        startAt,
        endAt,
        reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
        proofUrl: req.body?.proofUrl ? String(req.body.proofUrl).slice(0, 500) : null,
        status: 'PENDING',
      },
    });
    res.json({ status: 'success', message: '請假申請已送出', data: row });
  } catch (error) {
    sendErr(res, error, '請假申請失敗');
  }
});

hrSelfRouter.get('/my-schedule', async (req, res) => {
  try {
    const staffId = staffIdFromUser(req.user);
    if (!staffId) return res.status(403).json({ status: 'error', message: '⛔ 憑證缺少員工 id' });

    const from = req.query.from ? parseDate(req.query.from, 'from') : new Date();
    const to = req.query.to
      ? parseDate(req.query.to, 'to')
      : new Date(from.getTime() + 30 * 86400000);

    const rows = await prisma.staffSchedule.findMany({
      where: { staffId, startAt: { gte: from, lte: to } },
      orderBy: { startAt: 'asc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取排班失敗');
  }
});

hrSelfRouter.get('/my-attendance', async (req, res) => {
  try {
    const staffId = staffIdFromUser(req.user);
    if (!staffId) return res.status(403).json({ status: 'error', message: '⛔ 憑證缺少員工 id' });

    const take = Math.min(100, parseInt(req.query.take, 10) || 50);
    const rows = await prisma.staffAttendance.findMany({
      where: { staffId },
      orderBy: { punchIn: 'desc' },
      take,
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取考勤失敗');
  }
});
