// routes/hr.js — 員工考勤／請假／國定假日／排班（HQ 管理 + 員工自助）；商業規則在 lib/*Service.js
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import { getMyRosterOverview, respondRosterAck, submitOffRequest } from '../lib/rosterService.js';
import {
  EFFECTIVE_SCHEDULE_OR,
  createManualSchedule,
  deleteManualSchedule,
  listScheduleOverview,
  updateManualSchedule,
} from '../lib/staffScheduleService.js';
import { getMyCoachPlans, saveMyCoachPlan, submitMyCoachPlan, withdrawMyCoachPlan } from '../lib/coachScheduleService.js';
import {
  backfillAttendance,
  correctAttendance,
  getMyAttendance,
  listAttendance,
  punchIn,
  punchOut,
  resolveDutyStatus,
} from '../lib/attendanceService.js';
import {
  cancelMyLeave,
  createLeaveByHq,
  getMyLeaves,
  leaveMonthReport,
  listLeaves,
  requestLeave,
  reviewLeave,
} from '../lib/staffLeaveService.js';
import {
  addHoliday,
  deleteHoliday,
  listHolidays,
  parseHolidayYear,
  renameHoliday,
  seedDefaultHolidays,
} from '../lib/publicHolidayService.js';
import { buildPayrollExport } from '../lib/payrollExport.js';
import { getMyPayslip, listMyPayslips } from '../lib/payrollService.js';

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
  if (value === undefined || value === null || value === '' || Number.isNaN(d.getTime())) {
    throw httpError(`${fieldName} 無效`);
  }
  return d;
}

function parseOptionalInt(value, fieldName = 'id') {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${fieldName} 無效`);
  return n;
}

function parseId(value, fieldName = 'id') {
  const n = parseOptionalInt(value, fieldName);
  if (!n) throw httpError(`${fieldName} 無效`);
  return n;
}

function queryKey(value) {
  return value ? String(value).trim().toUpperCase() : undefined;
}

function sendErr(res, error, fallback = '操作失敗') {
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ status: 'error', code: error.code || undefined, message: error.message, data: error.data });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

/** 員工自助路由共用：身分一律取自 JWT */
function selfStaffId(req) {
  const staffId = staffIdFromUser(req.user);
  if (!staffId) throw httpError('⛔ 憑證缺少員工 id', 403);
  return staffId;
}

// ==========================================
// HQ 管理：/api/hq/hr
// ==========================================
export const hrAdminRouter = express.Router();
hrAdminRouter.use(verifyStaff, requireAdmin);

// ── 考勤 ──
hrAdminRouter.get('/attendance', async (req, res) => {
  try {
    const data = await listAttendance({
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      branchId: parseOptionalInt(req.query.branchId, 'branchId'),
      staffId: parseOptionalInt(req.query.staffId, 'staffId'),
      flag: queryKey(req.query.flag),
    });
    res.json({ status: 'success', message: '考勤', data });
  } catch (error) {
    sendErr(res, error, '讀取考勤失敗');
  }
});

hrAdminRouter.post('/attendance', async (req, res) => {
  try {
    const data = await backfillAttendance({
      staffId: parseId(req.body?.staffId, 'staffId'),
      branchId: parseOptionalInt(req.body?.branchId, 'branchId'),
      scheduleId: parseOptionalInt(req.body?.scheduleId, 'scheduleId'),
      punchIn: parseDate(req.body?.punchIn, 'punchIn'),
      punchOut: req.body?.punchOut ? parseDate(req.body.punchOut, 'punchOut') : null,
      reason: req.body?.reason,
      actorStaffId: staffIdFromUser(req.user),
    });
    res.json({ status: 'success', message: '已補登考勤', data });
  } catch (error) {
    sendErr(res, error, '補登考勤失敗');
  }
});

hrAdminRouter.patch('/attendance/:id', async (req, res) => {
  try {
    const data = await correctAttendance(parseId(req.params.id), {
      punchIn: req.body?.punchIn ? parseDate(req.body.punchIn, 'punchIn') : undefined,
      punchOut:
        req.body?.punchOut === null ? null : req.body?.punchOut ? parseDate(req.body.punchOut, 'punchOut') : undefined,
      reason: req.body?.reason,
      actorStaffId: staffIdFromUser(req.user),
    });
    res.json({ status: 'success', message: '已更正考勤', data });
  } catch (error) {
    sendErr(res, error, '更正考勤失敗');
  }
});

/** 相容舊報表：區間彙總（同 GET /attendance 之 byStaff） */
hrAdminRouter.get('/attendance/report', async (req, res) => {
  try {
    const data = await listAttendance({
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      defaultDays: 30,
    });
    res.json({
      status: 'success',
      data: { from: data.from, to: data.to, items: data.byStaff, summary: data.summary },
    });
  } catch (error) {
    sendErr(res, error, '匯出考勤報表失敗');
  }
});

// ── 請假 ──
hrAdminRouter.get('/leaves', async (req, res) => {
  try {
    const data = await listLeaves({
      status: queryKey(req.query.status),
      staffId: parseOptionalInt(req.query.staffId, 'staffId'),
      branchId: parseOptionalInt(req.query.branchId, 'branchId'),
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
    });
    res.json({ status: 'success', message: '請假', data });
  } catch (error) {
    sendErr(res, error, '讀取請假失敗');
  }
});

hrAdminRouter.post('/leaves', async (req, res) => {
  try {
    const data = await createLeaveByHq(
      parseId(req.body?.staffId, 'staffId'),
      {
        startAt: parseDate(req.body?.startAt, 'startAt'),
        endAt: parseDate(req.body?.endAt, 'endAt'),
        leaveType: req.body?.leaveType,
        hours: req.body?.hours,
        reason: req.body?.reason,
        proofUrl: req.body?.proofUrl,
      },
      staffIdFromUser(req.user),
    );
    res.json({ status: 'success', message: '已代登請假（已核准）', data });
  } catch (error) {
    sendErr(res, error, '建立請假失敗');
  }
});

hrAdminRouter.patch('/leaves/:id', async (req, res) => {
  try {
    const status = queryKey(req.body?.status);
    const data = await reviewLeave(parseId(req.params.id), {
      status,
      note: req.body?.note,
      actorStaffId: staffIdFromUser(req.user),
    });
    const message = { APPROVED: '已核准', REJECTED: '已拒絕', CANCELLED: '已撤銷，額度已回補' }[status] ?? '已更新';
    res.json({ status: 'success', message, data });
  } catch (error) {
    sendErr(res, error, '更新請假失敗');
  }
});

hrAdminRouter.get('/leaves/report', async (req, res) => {
  try {
    res.json({ status: 'success', data: await leaveMonthReport(req.query.month) });
  } catch (error) {
    sendErr(res, error, '匯出請假報表失敗');
  }
});

// ── 工資核算匯出（僅彙整考勤／請假事實，CSV 由前端組檔） ──
hrAdminRouter.get('/payroll-export', async (req, res) => {
  try {
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');
    const data = await buildPayrollExport({ month: String(req.query.month || ''), branchId });
    await prisma.payrollExportLog.create({
      data: {
        month: data.month,
        branchId,
        staffCount: data.summary.rows.length,
        generatedByStaffId: staffIdFromUser(req.user),
      },
    });
    res.json({ status: 'success', message: '工資核算資料', data });
  } catch (error) {
    sendErr(res, error, '產生工資核算資料失敗');
  }
});

// ── 國定假日曆 ──
hrAdminRouter.get('/holidays', async (req, res) => {
  try {
    res.json({ status: 'success', message: '國定假日', data: await listHolidays(parseHolidayYear(req.query.year)) });
  } catch (error) {
    sendErr(res, error, '讀取國定假日失敗');
  }
});

hrAdminRouter.post('/holidays', async (req, res) => {
  try {
    const data = await addHoliday({ date: String(req.body?.date || '').trim(), name: req.body?.name });
    res.json({ status: 'success', message: '已新增國定假日', data });
  } catch (error) {
    sendErr(res, error, '新增國定假日失敗');
  }
});

hrAdminRouter.post('/holidays/defaults', async (req, res) => {
  try {
    const year = parseHolidayYear(req.body?.year);
    const data = await seedDefaultHolidays(year);
    res.json({ status: 'success', message: `已補入 ${year} 年 ${data.count} 筆預設國定假日`, data });
  } catch (error) {
    sendErr(res, error, '補入預設國定假日失敗');
  }
});

hrAdminRouter.patch('/holidays/:id', async (req, res) => {
  try {
    const data = await renameHoliday(parseId(req.params.id), { name: req.body?.name });
    res.json({ status: 'success', message: '已更新國定假日', data });
  } catch (error) {
    sendErr(res, error, '更新國定假日失敗');
  }
});

hrAdminRouter.delete('/holidays/:id', async (req, res) => {
  try {
    await deleteHoliday(parseId(req.params.id));
    res.json({ status: 'success', message: '已刪除國定假日' });
  } catch (error) {
    sendErr(res, error, '刪除國定假日失敗');
  }
});

// ── 班表總覽 ──
hrAdminRouter.get('/schedules', async (req, res) => {
  try {
    const data = await listScheduleOverview({
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      branchId: parseOptionalInt(req.query.branchId, 'branchId'),
      staffId: parseOptionalInt(req.query.staffId, 'staffId'),
      source: queryKey(req.query.source),
      includeOff: req.query.includeOff === '1' || req.query.includeOff === 'true',
    });
    res.json({ status: 'success', message: '班表總覽', data });
  } catch (error) {
    sendErr(res, error, '讀取排班失敗');
  }
});

hrAdminRouter.post('/schedules', async (req, res) => {
  try {
    const data = await createManualSchedule({
      staffId: parseId(req.body?.staffId, 'staffId'),
      branchId: parseOptionalInt(req.body?.branchId, 'branchId'),
      startAt: parseDate(req.body?.startAt, 'startAt'),
      endAt: parseDate(req.body?.endAt, 'endAt'),
      note: req.body?.note,
      actorStaffId: staffIdFromUser(req.user),
    });
    res.json({ status: 'success', message: '已建立臨時排班', data });
  } catch (error) {
    sendErr(res, error, '建立排班失敗');
  }
});

hrAdminRouter.patch('/schedules/:id', async (req, res) => {
  try {
    const data = await updateManualSchedule(parseId(req.params.id), {
      startAt: req.body?.startAt ? parseDate(req.body.startAt, 'startAt') : undefined,
      endAt: req.body?.endAt ? parseDate(req.body.endAt, 'endAt') : undefined,
      branchId: req.body?.branchId !== undefined ? parseOptionalInt(req.body.branchId, 'branchId') : undefined,
      note: req.body?.note,
    });
    res.json({ status: 'success', message: '已更新排班', data });
  } catch (error) {
    sendErr(res, error, '更新排班失敗');
  }
});

hrAdminRouter.delete('/schedules/:id', async (req, res) => {
  try {
    await deleteManualSchedule(parseId(req.params.id));
    res.json({ status: 'success', message: '已刪除排班' });
  } catch (error) {
    sendErr(res, error, '刪除排班失敗');
  }
});

// ==========================================
// 員工自助：/api/staff/hr（身分一律取自 JWT）
// ==========================================
export const hrSelfRouter = express.Router();
hrSelfRouter.use(verifyStaff);

// 班表值勤判定（登入後前端輪詢；業務模組海關同一套規則）
hrSelfRouter.get('/duty-status', async (req, res) => {
  try {
    const data = await resolveDutyStatus(req.user);
    res.json({ status: 'success', message: data.message, data });
  } catch (error) {
    sendErr(res, error, '讀取值勤狀態失敗');
  }
});

hrSelfRouter.post('/punch-in', async (req, res) => {
  try {
    const staffId = selfStaffId(req);
    const { row, staleClosedId, shift } = await punchIn(req.user, staffId, parseOptionalInt(req.body?.branchId, 'branchId'));
    const duty = await resolveDutyStatus(req.user);
    res.json({
      status: 'success',
      message: staleClosedId ? '上班打卡成功（前一筆未打下班卡，請洽主管更正）' : '上班打卡成功',
      data: { ...row, staleClosedId, shift, duty },
    });
  } catch (error) {
    sendErr(res, error, '上班打卡失敗');
  }
});

hrSelfRouter.post('/punch-out', async (req, res) => {
  try {
    const row = await punchOut(selfStaffId(req));
    const duty = await resolveDutyStatus(req.user);
    res.json({ status: 'success', message: '下班打卡成功', data: { ...row, duty } });
  } catch (error) {
    sendErr(res, error, '下班打卡失敗');
  }
});

hrSelfRouter.get('/my-attendance', async (req, res) => {
  try {
    res.json({ status: 'success', message: '我的出勤', data: await getMyAttendance(selfStaffId(req)) });
  } catch (error) {
    sendErr(res, error, '讀取考勤失敗');
  }
});

// ── 薪資單（僅本人、僅已結算批次） ──
hrSelfRouter.get('/payslips', async (req, res) => {
  try {
    res.json({ status: 'success', message: '我的薪資單', data: await listMyPayslips(selfStaffId(req)) });
  } catch (error) {
    sendErr(res, error, '讀取薪資單失敗');
  }
});

hrSelfRouter.get('/payslips/:month', async (req, res) => {
  try {
    res.json({ status: 'success', message: '薪資單明細', data: await getMyPayslip(selfStaffId(req), String(req.params.month)) });
  } catch (error) {
    sendErr(res, error, '讀取薪資單失敗');
  }
});

hrSelfRouter.get('/my-leaves', async (req, res) => {
  try {
    res.json({ status: 'success', message: '我的請假', data: await getMyLeaves(selfStaffId(req)) });
  } catch (error) {
    sendErr(res, error, '讀取請假失敗');
  }
});

hrSelfRouter.post('/leave-request', async (req, res) => {
  try {
    const data = await requestLeave(selfStaffId(req), {
      startAt: parseDate(req.body?.startAt, 'startAt'),
      endAt: parseDate(req.body?.endAt, 'endAt'),
      leaveType: req.body?.leaveType,
      hours: req.body?.hours,
      reason: req.body?.reason,
      proofUrl: req.body?.proofUrl,
    });
    res.json({ status: 'success', message: '請假申請已送出，待主管審核', data });
  } catch (error) {
    sendErr(res, error, '請假申請失敗');
  }
});

hrSelfRouter.post('/my-leaves/:id/cancel', async (req, res) => {
  try {
    await cancelMyLeave(selfStaffId(req), parseId(req.params.id));
    res.json({ status: 'success', message: '已撤回請假申請' });
  } catch (error) {
    sendErr(res, error, '撤回請假失敗');
  }
});

hrSelfRouter.get('/my-schedule', async (req, res) => {
  try {
    const staffId = selfStaffId(req);
    const from = req.query.from ? parseDate(req.query.from, 'from') : new Date();
    const to = req.query.to ? parseDate(req.query.to, 'to') : new Date(from.getTime() + 30 * 86400000);
    const rows = await prisma.staffSchedule.findMany({
      where: {
        staffId,
        startAt: { gte: from, lte: to },
        OR: EFFECTIVE_SCHEDULE_OR,
      },
      orderBy: { startAt: 'asc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取排班失敗');
  }
});

// 排假申請：排班編制員工（場務／實習教練）於本期／下一期指定希望休假日；班表發布後截止
hrSelfRouter.get('/off-requests', async (req, res) => {
  try {
    res.json({ status: 'success', data: await getMyRosterOverview(selfStaffId(req)) });
  } catch (error) {
    sendErr(res, error, '讀取排假資料失敗');
  }
});

hrSelfRouter.put('/off-requests', async (req, res) => {
  try {
    const data = await submitOffRequest(selfStaffId(req), req.body || {});
    const withdrawn = !(Array.isArray(req.body?.dates) && req.body.dates.length);
    res.json({ status: 'success', message: withdrawn ? '已撤回排假申請' : '排假申請已遞交，店長排班時會優先安排', data });
  } catch (error) {
    sendErr(res, error, '遞交排假申請失敗');
  }
});

// 班表確認回覆：發布後 72 小時內 { cycleStartDate, status: CONFIRMED|DISPUTED, message? }
hrSelfRouter.post('/roster-ack', async (req, res) => {
  try {
    const data = await respondRosterAck(selfStaffId(req), req.body || {});
    const disputed = String(req.body?.status || '').toUpperCase() === 'DISPUTED';
    res.json({ status: 'success', message: disputed ? '已送出異議，店長將重新檢視班表' : '已確認班表', data });
  } catch (error) {
    sendErr(res, error, '班表確認回覆失敗');
  }
});

// 週班表（轉正教練／店長／GM／FM）本人提報；/api/staff/week-plans 審核核准後生效（coach-plans 為舊路徑別名）
const WEEK_PLAN_PATHS = ['/week-plans', '/coach-plans'];
hrSelfRouter.get(WEEK_PLAN_PATHS, async (req, res) => {
  try {
    res.json({ status: 'success', data: await getMyCoachPlans(selfStaffId(req)) });
  } catch (error) {
    sendErr(res, error, '讀取週班表失敗');
  }
});

hrSelfRouter.put(WEEK_PLAN_PATHS.map((p) => `${p}/:weekStart`), async (req, res) => {
  try {
    const data = await saveMyCoachPlan(selfStaffId(req), req.params.weekStart, req.body || {});
    res.json({ status: 'success', message: data.evaluation?.hasError ? '已儲存草稿，尚有不符規定項目須修正' : '已儲存草稿', data });
  } catch (error) {
    sendErr(res, error, '儲存週班表失敗');
  }
});

hrSelfRouter.post(WEEK_PLAN_PATHS.map((p) => `${p}/:weekStart/submit`), async (req, res) => {
  try {
    const data = await submitMyCoachPlan(selfStaffId(req), req.params.weekStart);
    res.json({ status: 'success', message: '已送出審核，核准後生效', data });
  } catch (error) {
    sendErr(res, error, '送審週班表失敗');
  }
});

hrSelfRouter.post(WEEK_PLAN_PATHS.map((p) => `${p}/:weekStart/withdraw`), async (req, res) => {
  try {
    const data = await withdrawMyCoachPlan(selfStaffId(req), req.params.weekStart);
    res.json({ status: 'success', message: '已撤回送審', data });
  } catch (error) {
    sendErr(res, error, '撤回送審失敗');
  }
});
