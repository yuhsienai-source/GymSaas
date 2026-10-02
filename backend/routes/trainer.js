// routes/trainer.js — 教練個人工作區（資料不共享；ADMIN 可代管）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission, requireAdmin } from '../middleware/jwtAuth.js';
import { isAdminUser } from '../lib/staffAccess.js';
import { venueStationConflictWhere } from '../lib/venueStation.js';
import {
  assertOwnsTrainerOrAdmin,
  resolveTrainerWorkspace,
} from '../lib/trainerAccess.js';
import { identifyMember, lookupMemberByPhone } from '../lib/memberIdentify.js';
import { notifyClassBooked } from '../lib/lineNotify.js';
import { memberBranchLabel, staffBranchLabel } from '../lib/branchLabel.js';
import { resolveDisplayName } from '../lib/displayName.js';
import {
  serializeConsultGuest,
  upsertConsultGuest,
} from '../lib/consultGuest.js';
import {
  assertTrainerBookable,
  createTrainerTimeOff,
  deleteTrainerTimeOff,
  listTrainerTimeOffs,
  TIME_OFF_REASONS,
  updateTrainerTimeOff,
} from '../lib/trainerTimeOff.js';
import { assertPrivateVenueAllowed } from '../lib/branchShare.js';
import { isManagerTrainer, normalizeTrainerRole } from '../lib/orgStructure.js';
import { coachPerformanceBetween, resolveRules, serializeRule } from '../lib/coachPerformance.js';
import { taipeiDateKey } from '../lib/laborLaw.js';
import { monthRange } from '../lib/payrollExport.js';
import { EFFECTIVE_WORK_SLOT_WHERE } from '../lib/staffScheduleService.js';

const router = express.Router();
router.use(verifyStaff, requirePermission('trainer'));

function overlapWhere(startTime, endTime) {
  return {
    startAt: { lt: endTime },
    endAt: { gt: startTime },
  };
}

function serializeClass(row) {
  const booked = row.reservations?.length ?? row._count?.reservations ?? 0;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    startAt: row.startAt,
    endAt: row.endAt,
    capacity: row.capacity,
    booked,
    remaining: Math.max(0, (row.capacity || 0) - booked),
    trainerId: row.trainerId,
    trainerName: row.trainer?.name || null,
    venueId: row.venueId,
    venueName: row.venue?.name || null,
    branchId: row.venue?.branchId ?? row.venue?.branch?.id ?? null,
    branchName: staffBranchLabel(row.venue?.branch),
    stationId: row.stationId,
    stationName: row.station?.name || null,
    reservations: (row.reservations || []).map((r) => ({
      id: r.id,
      status: r.status,
      bookedAt: r.bookedAt,
      source: r.source || null,
      memberId: r.memberId ?? null,
      memberName: r.member?.name || r.consultGuest?.name || null,
      memberPhone: r.member?.phone || r.consultGuest?.phone || null,
      consultGuestId: r.consultGuestId ?? null,
      isConsultGuest: Boolean(r.consultGuestId),
    })),
  };
}

function serializePtContract(row) {
  const remaining = Math.max(0, (row.totalSessions || 0) - (row.usedSessions || 0));
  return {
    id: row.id,
    memberId: row.memberId,
    memberName: row.member?.name || null,
    memberPhone: row.member?.phone || null,
    memberNo: row.member?.memberNo || null,
    hasLineBound: Boolean(row.member?.lineId),
    isAlert: Boolean(row.member?.isAlert),
    cashWallet: Number(row.member?.cashWallet) || 0,
    bonusWallet: Number(row.member?.bonusWallet) || 0,
    memberExpireDate: row.member?.expireDate || null,
    trainerId: row.trainerId,
    branchId: row.branchId ?? row.branch?.id ?? null,
    branchCode: row.branch?.code || null,
    branchName: staffBranchLabel(row.branch) || row.branch?.name || null,
    coursePlanId: row.coursePlanId ?? row.coursePlan?.id ?? null,
    coursePlanName: row.coursePlan?.name || null,
    /** PURCHASE＝付費購案｜COMPENSATION＝總部補償贈送 */
    source: row.source || 'PURCHASE',
    totalSessions: row.totalSessions,
    usedSessions: row.usedSessions,
    remainingSessions: remaining,
    pricePaid: row.pricePaid,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

/**
 * 教練服務訊息：未付款、堂數將盡、合約將到期、警示、未綁 LINE
 */
function buildTrainerInbox({ ptContracts, pendingOrders, pendingSales, pendingCheckouts }) {
  const items = [];
  const now = Date.now();
  const in14d = now + 14 * 24 * 60 * 60 * 1000;

  for (const o of pendingOrders || []) {
    items.push({
      id: `order:${o.id}`,
      type: 'UNPAID',
      severity: 'high',
      title: '儲值／購案款項未付',
      body: `${o.member?.name || `會員 #${o.memberId}`} · ${o.itemDesc || o.id} · $${Math.round(Number(o.amount) || 0)}`,
      memberId: o.memberId,
      memberName: o.member?.name || null,
      refId: o.id,
      at: o.createdAt,
      actionHint: '請引導學員至櫃檯完成付款',
    });
  }
  for (const s of pendingSales || []) {
    items.push({
      id: `sale:${s.id}`,
      type: 'UNPAID',
      severity: 'high',
      title: '商品／服務款項未付',
      body: `${s.member?.name || `會員 #${s.memberId}`} · ${s.itemDesc || s.id} · $${Math.round(Number(s.amount) || 0)}`,
      memberId: s.memberId,
      memberName: s.member?.name || null,
      refId: s.id,
      at: s.createdAt,
      actionHint: '請引導學員至櫃檯完成結帳',
    });
  }
  for (const c of pendingCheckouts || []) {
    items.push({
      id: `chk:${c.id}`,
      type: 'UNPAID',
      severity: 'high',
      title: '合併結帳未完成',
      body: `${c.member?.name || `會員 #${c.memberId}`} · ${c.itemDesc || c.id} · $${Math.round(Number(c.amount) || 0)}`,
      memberId: c.memberId,
      memberName: c.member?.name || null,
      refId: c.id,
      at: c.createdAt,
      actionHint: '請引導學員至櫃檯完成付款',
    });
  }

  for (const c of ptContracts || []) {
    const name = c.memberName || `會員 #${c.memberId}`;
    if (c.isAlert) {
      items.push({
        id: `alert:${c.id}`,
        type: 'ALERT',
        severity: 'high',
        title: '警示學員',
        body: `${name} 帳號標記警示，代約前請先確認`,
        memberId: c.memberId,
        memberName: c.memberName,
        refId: String(c.id),
        at: c.createdAt,
        actionHint: '必要時請轉交櫃檯處理',
      });
    }
    if (c.remainingSessions <= 2) {
      items.push({
        id: `low:${c.id}`,
        type: 'LOW_SESSIONS',
        severity: c.remainingSessions <= 0 ? 'high' : 'medium',
        title: c.remainingSessions <= 0 ? '私教堂數已用罄' : '私教堂數將盡',
        body: `${name} · 剩餘 ${c.remainingSessions}／${c.totalSessions} 堂`,
        memberId: c.memberId,
        memberName: c.memberName,
        refId: String(c.id),
        at: c.createdAt,
        actionHint: '可提醒學員至櫃檯續購私教',
      });
    }
    if (c.expiresAt) {
      const exp = new Date(c.expiresAt).getTime();
      if (!Number.isNaN(exp) && exp <= in14d) {
        items.push({
          id: `exp:${c.id}`,
          type: 'EXPIRING',
          severity: exp < now ? 'high' : 'medium',
          title: exp < now ? '私教合約已到期' : '私教合約即將到期',
          body: `${name} · ${new Date(c.expiresAt).toLocaleDateString('zh-TW')}`,
          memberId: c.memberId,
          memberName: c.memberName,
          refId: String(c.id),
          at: c.expiresAt,
          actionHint: '請提醒續約或至櫃檯處理',
        });
      }
    }
    if (!c.hasLineBound) {
      items.push({
        id: `noline:${c.id}`,
        type: 'NO_LINE',
        severity: 'low',
        title: '學員未綁 LINE',
        body: `${name} · 約課成功無法自動推播`,
        memberId: c.memberId,
        memberName: c.memberName,
        refId: String(c.id),
        at: c.createdAt,
        actionHint: '請請學員於會員端綁定 LINE',
      });
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => {
    const sa = severityRank[a.severity] ?? 9;
    const sb = severityRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
  return items.slice(0, 60);
}

// GET /api/trainer/members/lookup — 僅限「本人私教學員」
router.get('/members/lookup', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });
    if (!trainer) {
      return res.status(400).json({
        status: 'error',
        message: isAdmin ? '請指定 viewAsTrainerId' : '尚未綁定教練檔案',
      });
    }
    const studentIds = (
      await prisma.pTContract.findMany({
        where: { trainerId: trainer.id, isActive: true },
        select: { memberId: true },
      })
    ).map((r) => r.memberId);
    if (!studentIds.length) {
      return res.status(404).json({
        status: 'error',
        message: '尚無私教學員，請學員先於櫃檯購買你的私教方案',
      });
    }
    const result = await lookupMemberByPhone(req.query.phone);
    const filterOne = (m) => (m && studentIds.includes(m.id) ? m : null);
    if (result?.data?.member) {
      result.data.member = filterOne(result.data.member);
    }
    if (Array.isArray(result?.data?.candidates)) {
      result.data.candidates = result.data.candidates.filter((m) => studentIds.includes(m.id));
    }
    if (!result?.data?.member && !(result?.data?.candidates || []).length) {
      return res.status(404).json({
        status: 'error',
        message: '查無符合的「自己的學員」（僅能搜尋私教合約學員）',
      });
    }
    if (!result.data.member && result.data.candidates?.length === 1) {
      result.data.member = result.data.candidates[0];
      result.data.candidates = [];
    }
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '手機查詢失敗' });
  }
});

router.post('/members/identify', async (req, res) => {
  try {
    const method = String(req.body?.method || '').toUpperCase();
    if (method === 'FACE') {
      return res.status(403).json({
        status: 'error',
        message: '教練端不開放人臉辨識',
      });
    }
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) {
      return res.status(400).json({
        status: 'error',
        message: isAdmin ? '請指定 viewAsTrainerId' : '尚未綁定教練檔案',
      });
    }
    const studentIds = new Set(
      (
        await prisma.pTContract.findMany({
          where: { trainerId: trainer.id, isActive: true },
          select: { memberId: true },
        })
      ).map((r) => r.memberId),
    );
    const result = await identifyMember(req.body || {});
    const member = result?.data?.member;
    if (!member || !studentIds.has(member.id)) {
      return res.status(403).json({
        status: 'error',
        message: '僅能辨識自己的私教學員',
      });
    }
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '會員辨識失敗' });
  }
});

// GET /api/trainer/dashboard?viewAsTrainerId= — 個人工作區總覽
router.get('/dashboard', async (req, res) => {
  try {
    const { trainer, isAdmin, canSwitch } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });

    const trainersForAdmin = isAdmin
      ? await prisma.trainer.findMany({
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            phone: true,
            role: true,
            staffId: true,
            branches: {
              select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
            },
          },
          orderBy: { id: 'asc' },
        })
      : [];

    if (!trainer) {
      return res.json({
        status: 'success',
        data: {
          isAdmin,
          canSwitch,
          profile: null,
          needsTrainerPick: true,
          trainers: trainersForAdmin,
          venues: [],
          upcomingClasses: [],
          recentClasses: [],
          ptContracts: [],
          inbox: [],
          timeOffs: [],
          timeOffReasons: TIME_OFF_REASONS,
          employed: false,
          workSlots: [],
          stats: {
            todayClasses: 0,
            upcomingClasses: 0,
            openSeats: 0,
            activePtContracts: 0,
            remainingPtSessions: 0,
            inboxCount: 0,
            unpaidCount: 0,
            upcomingTimeOffs: 0,
          },
        },
      });
    }

    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setHours(23, 59, 59, 999);
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const branchIds =
      isManagerTrainer(trainer)
        ? null
        : trainer.branches.map((b) => b.branchId);

    const venueWhere =
      branchIds == null
        ? {}
        : branchIds.length
          ? { branchId: { in: branchIds } }
          : { id: -1 };

    const [venues, upcomingClasses, recentClasses, ptContractRows, todayCount, timeOffRows] =
      await Promise.all([
        prisma.venue.findMany({
          where: venueWhere,
          include: {
            branch: { select: { id: true, name: true, code: true } },
            stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
          },
          orderBy: { id: 'asc' },
        }),
        prisma.class.findMany({
          where: {
            trainerId: trainer.id,
            startAt: { gte: now, lte: horizon },
          },
          include: {
            trainer: { select: { id: true, name: true } },
            venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
            station: { select: { id: true, name: true } },
            reservations: {
              where: { status: { in: ['PENDING', 'CONFIRMED'] } },
              include: {
                member: { select: { id: true, name: true, phone: true } },
                consultGuest: { select: { id: true, name: true, phone: true } },
              },
              orderBy: { bookedAt: 'asc' },
            },
          },
          orderBy: { startAt: 'asc' },
          take: 40,
        }),
        prisma.class.findMany({
          where: {
            trainerId: trainer.id,
            endAt: { lt: now },
          },
          include: {
            trainer: { select: { id: true, name: true } },
            venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
            station: { select: { id: true, name: true } },
            reservations: {
              where: { status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'] } },
              include: {
                member: { select: { id: true, name: true, phone: true } },
                consultGuest: { select: { id: true, name: true, phone: true } },
              },
              orderBy: { bookedAt: 'asc' },
            },
          },
          orderBy: { startAt: 'desc' },
          take: 20,
        }),
        prisma.pTContract.findMany({
          where: { trainerId: trainer.id, isActive: true },
          include: {
            branch: { select: { id: true, name: true, code: true } },
            coursePlan: { select: { id: true, name: true, kind: true } },
            member: {
              select: {
                id: true,
                name: true,
                phone: true,
                memberNo: true,
                lineId: true,
                isAlert: true,
                cashWallet: true,
                bonusWallet: true,
                expireDate: true,
              },
            },
          },
          orderBy: { id: 'desc' },
          take: 50,
        }),
        prisma.class.count({
          where: {
            trainerId: trainer.id,
            startAt: { gte: dayStart, lte: dayEnd },
          },
        }),
        listTrainerTimeOffs({
          trainerId: trainer.id,
          from: now.toISOString(),
          to: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
          take: 60,
        }),
      ]);
    const workSlots = trainer.staffId
      ? await prisma.staffSchedule.findMany({
          where: { AND: [EFFECTIVE_WORK_SLOT_WHERE, { staffId: trainer.staffId, endAt: { gt: now }, startAt: { lt: horizon } }] },
          select: { id: true, startAt: true, endAt: true, branchId: true },
          orderBy: { startAt: 'asc' },
          take: 60,
        })
      : [];

    const ptContracts = ptContractRows.map(serializePtContract);
    const memberIds = [...new Set(ptContracts.map((c) => c.memberId).filter(Boolean))];

    let pendingOrders = [];
    let pendingSales = [];
    let pendingCheckouts = [];
    if (memberIds.length) {
      [pendingOrders, pendingSales, pendingCheckouts] = await Promise.all([
        prisma.order.findMany({
          where: { memberId: { in: memberIds }, status: 'PENDING' },
          select: {
            id: true,
            memberId: true,
            amount: true,
            itemDesc: true,
            createdAt: true,
            member: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        prisma.saleOrder.findMany({
          where: { memberId: { in: memberIds }, status: 'PENDING' },
          select: {
            id: true,
            memberId: true,
            amount: true,
            itemDesc: true,
            createdAt: true,
            member: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        prisma.checkoutSession.findMany({
          where: {
            memberId: { in: memberIds },
            status: 'PENDING',
          },
          select: {
            id: true,
            memberId: true,
            amount: true,
            itemDesc: true,
            createdAt: true,
            member: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
      ]);
    }

    const inbox = buildTrainerInbox({
      ptContracts,
      pendingOrders,
      pendingSales,
      pendingCheckouts,
    });
    const unpaidCount = inbox.filter((i) => i.type === 'UNPAID').length;

    const upcomingSerialized = upcomingClasses.map(serializeClass);
    const openSeats = upcomingSerialized.reduce((sum, c) => sum + c.remaining, 0);
    const remainingPtSessions = ptContracts.reduce(
      (sum, c) => sum + Math.max(0, c.remainingSessions),
      0,
    );

    res.json({
      status: 'success',
      data: {
        isAdmin,
        canSwitch,
        needsTrainerPick: false,
        profile: {
          id: trainer.id,
          name: trainer.name,
          displayName: resolveDisplayName(trainer),
          phone: trainer.phone,
          role: trainer.role,
          branches: trainer.branches,
        },
        trainers: trainersForAdmin,
        venues: venues.map((v) => ({
          id: v.id,
          name: v.name,
          branchId: v.branchId,
          branch: v.branch,
          stations: v.stations,
        })),
        upcomingClasses: upcomingSerialized,
        recentClasses: recentClasses.map(serializeClass),
        ptContracts,
        inbox,
        timeOffs: timeOffRows,
        timeOffReasons: TIME_OFF_REASONS,
        employed: Boolean(trainer.staffId),
        workSlots,
        stats: {
          todayClasses: todayCount,
          upcomingClasses: upcomingSerialized.length,
          openSeats,
          activePtContracts: ptContracts.length,
          remainingPtSessions,
          inboxCount: inbox.length,
          unpaidCount,
          upcomingTimeOffs: timeOffRows.length,
        },
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '載入教練工作區失敗' });
  }
});

// POST /api/trainer/register — 僅總部（相容舊路徑；正式建立請走 HQ）
router.post('/register', requireAdmin, async (req, res) => {
  const { name, phone, role } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ status: 'error', message: '請填寫教練姓名與電話' });
  }

  try {
    const trainer = await prisma.trainer.create({
      data: {
        name: String(name).trim(),
        phone: String(phone).trim(),
        role: normalizeTrainerRole(role),
        isActive: true,
      },
    });
    res.json({ status: 'success', message: `教練 [${name}] 註冊成功`, data: trainer });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '該電話號碼已被註冊為教練' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '教練註冊失敗' });
  }
});

// POST /api/trainer/schedule-class
// Body: { venueId, stationId?, title, type?, startAt, endAt, capacity?, trainerId? }
// 僅 ADMIN 可排課；一般教練禁止自行新增課程
router.post('/schedule-class', async (req, res) => {
  const { venueId, stationId, title, type, startAt, endAt, capacity } = req.body;

  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({
        status: 'error',
        message: '⛔ 教練不可自行新增課程，請由總部排課；你仍可代學生約課',
      });
    }

    const { trainer: selfTrainer } = await resolveTrainerWorkspace(req, {});
    let targetTrainerId = selfTrainer?.id ?? null;

    const raw = req.body?.trainerId ?? req.body?.viewAsTrainerId;
    if (raw !== undefined && raw !== null && raw !== '') {
      targetTrainerId = parseInt(raw, 10);
    }
    if (!targetTrainerId) {
      return res.status(400).json({
        status: 'error',
        message: '總部代排請指定 trainerId',
      });
    }

    if (!venueId || !title || !startAt || !endAt) {
      return res.status(400).json({
        status: 'error',
        message: '需提供 venueId、title、startAt、endAt',
      });
    }
    const classType = String(type || '').toUpperCase();
    if (!['PRIVATE', 'CONSULT'].includes(classType)) {
      return res.status(400).json({
        status: 'error',
        code: 'USE_GROUP_SERIES',
        message: '團課為付費期班，請至「團課管理」綁定團體課程方案開班；單堂請指定 type（PRIVATE／CONSULT）',
      });
    }

    const startTime = new Date(startAt);
    const endTime = new Date(endAt);
    if (Number.isNaN(startTime.getTime()) || startTime >= endTime) {
      return res.status(400).json({ status: 'error', message: '開課失敗：結束時間必須大於開始時間' });
    }

    const parsedStationId =
      stationId === undefined || stationId === null || stationId === ''
        ? null
        : parseInt(stationId, 10);
    if (parsedStationId !== null && !Number.isInteger(parsedStationId)) {
      return res.status(400).json({ status: 'error', message: 'stationId 無效' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const trainer = await tx.trainer.findUnique({ where: { id: targetTrainerId } });
      if (!trainer || !trainer.isActive) {
        const err = new Error('教練不存在或已停用');
        err.statusCode = 404;
        throw err;
      }
      assertOwnsTrainerOrAdmin(req, trainer.id, selfTrainer?.id);

      const venue = await tx.venue.findUnique({
        where: { id: parseInt(venueId, 10) },
        include: {
          branch: true,
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) {
        const err = new Error('場地不存在');
        err.statusCode = 404;
        throw err;
      }

      if (parsedStationId != null) {
        if (!venue.stations.some((s) => s.id === parsedStationId)) {
          const err = new Error('站點不屬於此場地');
          err.statusCode = 400;
          throw err;
        }
      } else if (venue.stations.length > 0) {
        const err = new Error('此場地已設定站點，請選擇訓練站點');
        err.statusCode = 400;
        throw err;
      }

      if (!isManagerTrainer(trainer)) {
        const allowed = await tx.trainerBranch.findUnique({
          where: {
            trainerId_branchId: {
              trainerId: trainer.id,
              branchId: venue.branchId,
            },
          },
        });
        if (!allowed) {
          const err = new Error(`教練無權在分店 [${staffBranchLabel(venue.branch)}] 開課`);
          err.statusCode = 403;
          throw err;
        }
      }

      const trainerConflict = await tx.class.findFirst({
        where: { trainerId: trainer.id, ...overlapWhere(startTime, endTime) },
      });
      if (trainerConflict) {
        const err = new Error(`教練防衝堂：此時段已有 [${trainerConflict.title}]`);
        err.statusCode = 409;
        throw err;
      }

      await assertTrainerBookable(tx, trainer.id, startTime, endTime);

      const venueConflict = await tx.class.findFirst({
        where: {
          ...venueStationConflictWhere(venue.id, parsedStationId),
          ...overlapWhere(startTime, endTime),
        },
      });
      if (venueConflict) {
        const err = new Error(`場地防衝堂：此時段已被 [${venueConflict.title}] 佔用`);
        err.statusCode = 409;
        throw err;
      }

      return tx.class.create({
        data: {
          trainerId: trainer.id,
          venueId: venue.id,
          stationId: parsedStationId,
          title: String(title).trim(),
          type: classType,
          capacity: parseInt(capacity, 10) || 10,
          startAt: startTime,
          endAt: endTime,
        },
      });
    });

    res.json({ status: 'success', message: `課程 [${title}] 排班成功！`, data: result });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '排班開課失敗' });
  }
});

// POST /api/trainer/book-class — 僅能幫「本人課程」代訂（ADMIN 可跨教練）
// 成功後嘗試 LINE 推播約課通知（失敗不回滾預約）
router.post('/book-class', async (req, res) => {
  const { memberId, classId } = req.body;

  if (!memberId || !classId) {
    return res.status(400).json({ status: 'error', message: '需提供 memberId 與 classId' });
  }

  try {
    const { trainer: selfTrainer } = await resolveTrainerWorkspace(req, {});

    const result = await prisma.$transaction(async (tx) => {
      const targetClass = await tx.class.findUnique({
        where: { id: parseInt(classId, 10) },
        include: {
          reservations: { where: { status: { in: ['PENDING', 'CONFIRMED'] } } },
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
        },
      });
      if (!targetClass) {
        const err = new Error('找不到該課程');
        err.statusCode = 404;
        throw err;
      }

      if (!isAdminUser(req.user)) {
        if (!selfTrainer) {
          const err = new Error('此帳號尚未綁定教練檔案');
          err.statusCode = 403;
          throw err;
        }
        if (targetClass.trainerId !== selfTrainer.id) {
          const err = new Error('⛔ 僅能為本人課程代訂學員');
          err.statusCode = 403;
          throw err;
        }
      }

      if (targetClass.type !== 'PRIVATE' && targetClass.type !== 'CONSULT') {
        const err = new Error('教練代約僅限私教／諮詢課');
        err.statusCode = 400;
        throw err;
      }

      const pt = await tx.pTContract.findFirst({
        where: {
          trainerId: targetClass.trainerId,
          memberId: parseInt(memberId, 10),
          isActive: true,
        },
        include: { branch: { select: { id: true, name: true, code: true } } },
      });
      if (!pt) {
        const err = new Error('僅能為自己的私教學員代約（需有進行中合約）');
        err.statusCode = 403;
        throw err;
      }
      if (pt.usedSessions >= pt.totalSessions) {
        const err = new Error('此學員私教堂數已用罄，請引導至櫃檯續購');
        err.statusCode = 400;
        throw err;
      }
      if (pt.branch && targetClass.venue?.branch) {
        assertPrivateVenueAllowed(pt.branch, targetClass.venue.branch);
      }

      if (targetClass.reservations.length >= targetClass.capacity) {
        const err = new Error(`預約失敗：名額已滿（上限 ${targetClass.capacity}）`);
        err.statusCode = 400;
        throw err;
      }

      const member = await tx.member.findUnique({
        where: { id: parseInt(memberId, 10) },
        select: { id: true, name: true, phone: true, lineId: true },
      });
      if (!member) {
        const err = new Error('找不到會員');
        err.statusCode = 404;
        throw err;
      }

      const alreadyBooked = await tx.reservation.findFirst({
        where: {
          memberId: member.id,
          classId: targetClass.id,
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      });
      if (alreadyBooked) {
        const err = new Error('已預約過這堂課程');
        err.statusCode = 400;
        throw err;
      }

      const reservation = await tx.reservation.create({
        data: {
          memberId: member.id,
          classId: targetClass.id,
          status: 'CONFIRMED',
          source: 'TRAINER',
        },
        include: {
          member: { select: { id: true, name: true, phone: true, lineId: true } },
          class: {
            select: {
              id: true,
              title: true,
              startAt: true,
              endAt: true,
            },
          },
        },
      });

      return { reservation, member, targetClass };
    });

    const { reservation, member, targetClass } = result;
    const notify = await notifyClassBooked({
      lineId: member.lineId,
      memberName: member.name,
      classTitle: targetClass.title,
      startAt: targetClass.startAt,
      endAt: targetClass.endAt,
      branchName: memberBranchLabel(targetClass.venue?.branch),
      venueName: targetClass.venue?.name || null,
      stationName: targetClass.station?.name || null,
      trainerName: targetClass.trainer ? resolveDisplayName(targetClass.trainer) : null,
      bookedBy: 'trainer',
    });

    let message = '私教代約成功';
    if (notify.ok) {
      message += '，已透過 LINE 通知學員';
    } else if (notify.skipped) {
      message += `（未推播：${notify.reason}）`;
    } else {
      message += `（LINE 通知失敗：${notify.reason || '未知錯誤'}）`;
    }

    res.json({
      status: 'success',
      message,
      data: {
        ...reservation,
        notify: {
          ok: Boolean(notify.ok),
          skipped: Boolean(notify.skipped),
          reason: notify.reason || null,
        },
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '預約系統異常' });
  }
});

// ==========================================
// 諮詢客人（姓名＋電話，無需正式會員／私教合約）
// ==========================================
router.get('/consult-guests', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });
    if (!trainer && !isAdmin) {
      return res.status(403).json({ status: 'error', message: '此帳號尚未綁定教練檔案' });
    }
    if (!trainer) {
      return res.json({ status: 'success', data: [] });
    }
    const q = String(req.query.q || '').trim();
    const rows = await prisma.consultGuest.findMany({
      where: {
        trainerId: trainer.id,
        isActive: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      },
      include: { member: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(parseInt(req.query.take, 10) || 40, 100),
    });
    res.json({
      status: 'success',
      data: rows.map(serializeConsultGuest),
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '讀取諮詢客人失敗' });
  }
});

router.post('/consult-guests', async (req, res) => {
  try {
    const { trainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!trainer) {
      return res.status(403).json({ status: 'error', message: '此帳號尚未綁定教練檔案' });
    }
    const guest = await upsertConsultGuest(prisma, {
      trainerId: trainer.id,
      name: req.body?.name,
      phone: req.body?.phone,
      note: req.body?.note,
    });
    res.json({
      status: 'success',
      message: '已儲存諮詢客人',
      data: serializeConsultGuest(guest),
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '儲存諮詢客人失敗' });
  }
});

// POST /api/trainer/book-consult — 諮詢客人代約（CONSULT 課；輸入姓名＋電話）
router.post('/book-consult', async (req, res) => {
  const { classId, name, phone, note, consultGuestId } = req.body || {};

  if (!classId) {
    return res.status(400).json({ status: 'error', message: '需提供 classId' });
  }

  try {
    const { trainer: selfTrainer } = await resolveTrainerWorkspace(req, {});

    const result = await prisma.$transaction(async (tx) => {
      const targetClass = await tx.class.findUnique({
        where: { id: parseInt(classId, 10) },
        include: {
          reservations: { where: { status: { in: ['PENDING', 'CONFIRMED'] } } },
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
        },
      });
      if (!targetClass) {
        const err = new Error('找不到該課程');
        err.statusCode = 404;
        throw err;
      }

      if (!isAdminUser(req.user)) {
        if (!selfTrainer) {
          const err = new Error('此帳號尚未綁定教練檔案');
          err.statusCode = 403;
          throw err;
        }
        if (targetClass.trainerId !== selfTrainer.id) {
          const err = new Error('⛔ 僅能為本人諮詢課代約');
          err.statusCode = 403;
          throw err;
        }
      }

      if (targetClass.type !== 'CONSULT') {
        const err = new Error('諮詢客人僅能預約諮詢課（CONSULT）');
        err.statusCode = 400;
        throw err;
      }

      await assertTrainerBookable(
        tx,
        targetClass.trainerId,
        targetClass.startAt,
        targetClass.endAt,
      );

      if (targetClass.reservations.length >= targetClass.capacity) {
        const err = new Error(`預約失敗：名額已滿（上限 ${targetClass.capacity}）`);
        err.statusCode = 400;
        throw err;
      }

      let guest;
      if (consultGuestId) {
        guest = await tx.consultGuest.findFirst({
          where: {
            id: parseInt(consultGuestId, 10),
            trainerId: targetClass.trainerId,
            isActive: true,
          },
          include: { member: { select: { id: true, name: true, lineId: true } } },
        });
        if (!guest) {
          const err = new Error('找不到此諮詢客人');
          err.statusCode = 404;
          throw err;
        }
        if (name || phone) {
          guest = await upsertConsultGuest(tx, {
            trainerId: targetClass.trainerId,
            name: name || guest.name,
            phone: phone || guest.phone,
            note,
          });
        }
      } else {
        guest = await upsertConsultGuest(tx, {
          trainerId: targetClass.trainerId,
          name,
          phone,
          note,
        });
      }

      const dupOr = [{ consultGuestId: guest.id }];
      if (guest.memberId) {
        dupOr.push({ memberId: guest.memberId });
      }
      const alreadyBooked = await tx.reservation.findFirst({
        where: {
          classId: targetClass.id,
          status: { in: ['PENDING', 'CONFIRMED'] },
          OR: dupOr,
        },
      });
      if (alreadyBooked) {
        const err = new Error('此客人已預約過這堂諮詢課');
        err.statusCode = 400;
        throw err;
      }

      const reservation = await tx.reservation.create({
        data: {
          consultGuestId: guest.id,
          memberId: guest.memberId ?? null,
          classId: targetClass.id,
          status: 'CONFIRMED',
          source: 'CONSULT_GUEST',
        },
        include: {
          consultGuest: { select: { id: true, name: true, phone: true, memberId: true } },
          member: { select: { id: true, name: true, phone: true, lineId: true } },
        },
      });

      return { reservation, guest, targetClass };
    });

    const { reservation, guest, targetClass } = result;
    const lineId = reservation.member?.lineId || null;
    const notify = await notifyClassBooked({
      lineId,
      memberName: guest.name,
      classTitle: targetClass.title,
      startAt: targetClass.startAt,
      endAt: targetClass.endAt,
      branchName: memberBranchLabel(targetClass.venue?.branch),
      venueName: targetClass.venue?.name || null,
      stationName: targetClass.station?.name || null,
      trainerName: targetClass.trainer ? resolveDisplayName(targetClass.trainer) : null,
      bookedBy: 'trainer',
    });

    let message = `諮詢預約成功：${guest.name}`;
    if (lineId) {
      if (notify.ok) message += '，已 LINE 通知';
      else if (notify.skipped) message += `（未推播：${notify.reason}）`;
      else message += `（LINE 通知失敗：${notify.reason || '未知'}）`;
    } else {
      message += '（尚未綁定會員 LINE，無法推播）';
    }

    res.json({
      status: 'success',
      message,
      data: {
        ...reservation,
        guest: serializeConsultGuest(guest),
        notify: {
          ok: Boolean(notify.ok),
          skipped: Boolean(notify.skipped || !lineId),
          reason: lineId ? notify.reason || null : '客人尚未綁定會員 LINE',
        },
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '諮詢預約失敗' });
  }
});

// ==========================================
// POST /api/trainer/schedule-private
// Body: { contractId, venueId, stationId?, startAt, endAt, viewAsTrainerId? }
// 依購買合約自選日期／時間開 PRIVATE 堂＋代約＋扣堂＋LINE
// ==========================================
router.post('/schedule-private', async (req, res) => {
  const { contractId, venueId, stationId, startAt, endAt } = req.body || {};

  if (!contractId || !venueId || !startAt || !endAt) {
    return res.status(400).json({
      status: 'error',
      message: '需提供 contractId、venueId、startAt、endAt',
    });
  }

  const startTime = new Date(startAt);
  const endTime = new Date(endAt);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return res.status(400).json({ status: 'error', message: '時間格式無效' });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ status: 'error', message: '結束時間必須大於開始時間' });
  }
  if (startTime.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ status: 'error', message: '不可預約已過去的時段' });
  }

  const parsedContractId = parseInt(contractId, 10);
  const parsedVenueId = parseInt(venueId, 10);
  const parsedStationId =
    stationId === undefined || stationId === null || stationId === ''
      ? null
      : parseInt(stationId, 10);
  if (!Number.isInteger(parsedContractId) || !Number.isInteger(parsedVenueId)) {
    return res.status(400).json({ status: 'error', message: 'contractId／venueId 無效' });
  }
  if (parsedStationId !== null && !Number.isInteger(parsedStationId)) {
    return res.status(400).json({ status: 'error', message: 'stationId 無效' });
  }

  try {
    const { trainer: selfTrainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });

    const result = await prisma.$transaction(async (tx) => {
      const contract = await tx.pTContract.findUnique({
        where: { id: parsedContractId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          member: {
            select: { id: true, name: true, phone: true, lineId: true, isAlert: true },
          },
          trainer: {
            select: { id: true, name: true, displayName: true, role: true, isActive: true },
          },
        },
      });
      if (!contract || !contract.isActive) {
        const err = new Error('找不到合約或合約已失效');
        err.statusCode = 400;
        throw err;
      }
      if (!isAdminUser(req.user)) {
        if (!selfTrainer) {
          const err = new Error('此帳號尚未綁定教練檔案');
          err.statusCode = 403;
          throw err;
        }
        if (contract.trainerId !== selfTrainer.id) {
          const err = new Error('⛔ 僅能為自己的私教合約代約');
          err.statusCode = 403;
          throw err;
        }
      } else if (selfTrainer && contract.trainerId !== selfTrainer.id) {
        const err = new Error('所選教練與合約教練不符');
        err.statusCode = 400;
        throw err;
      }

      if (contract.expiresAt && new Date() > contract.expiresAt) {
        await tx.pTContract.update({
          where: { id: contract.id },
          data: { isActive: false },
        });
        const err = new Error('合約已過期');
        err.statusCode = 403;
        throw err;
      }
      if (contract.usedSessions >= contract.totalSessions) {
        const err = new Error('此學員私教堂數已用罄，請引導至櫃檯續購');
        err.statusCode = 400;
        throw err;
      }
      if (!contract.trainer.isActive) {
        const err = new Error('綁定教練已停用');
        err.statusCode = 400;
        throw err;
      }

      const venue = await tx.venue.findUnique({
        where: { id: parsedVenueId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) {
        const err = new Error('找不到場地');
        err.statusCode = 404;
        throw err;
      }

      if (parsedStationId != null) {
        if (!venue.stations.some((s) => s.id === parsedStationId)) {
          const err = new Error('站點不屬於此場地');
          err.statusCode = 400;
          throw err;
        }
      } else if (venue.stations.length > 0) {
        const err = new Error('此場地已設定站點，請選擇訓練站點');
        err.statusCode = 400;
        throw err;
      }

      // 購案分店 ↔ 上課場地（HP↔HR 私教共享）
      if (contract.branch) {
        assertPrivateVenueAllowed(contract.branch, venue.branch);
      } else if (contract.branchId) {
        assertPrivateVenueAllowed(
          { id: contract.branchId, code: null, name: null },
          venue.branch,
        );
      }

      if (!isManagerTrainer(contract.trainer)) {
        const allowed = await tx.trainerBranch.findUnique({
          where: {
            trainerId_branchId: {
              trainerId: contract.trainerId,
              branchId: venue.branchId,
            },
          },
        });
        if (!allowed) {
          const err = new Error(
            `教練無權在分店 [${staffBranchLabel(venue.branch)}] 授課`,
          );
          err.statusCode = 403;
          throw err;
        }
      }

      const trainerConflict = await tx.class.findFirst({
        where: {
          trainerId: contract.trainerId,
          ...overlapWhere(startTime, endTime),
        },
        select: { id: true, title: true, startAt: true, endAt: true },
      });
      if (trainerConflict) {
        const err = new Error(
          `教練防衝堂：此時段已有 [${trainerConflict.title}]`,
        );
        err.statusCode = 409;
        throw err;
      }

      await assertTrainerBookable(tx, contract.trainerId, startTime, endTime);

      const venueConflict = await tx.class.findFirst({
        where: {
          ...venueStationConflictWhere(parsedVenueId, parsedStationId),
          ...overlapWhere(startTime, endTime),
        },
        select: { id: true, title: true },
      });
      if (venueConflict) {
        const err = new Error(`場地防衝堂：此時段已被 [${venueConflict.title}] 佔用`);
        err.statusCode = 409;
        throw err;
      }

      const newClass = await tx.class.create({
        data: {
          title: `1v1 私教｜${contract.member.name} × ${resolveDisplayName(contract.trainer)}`,
          type: 'PRIVATE',
          venueId: parsedVenueId,
          stationId: parsedStationId,
          trainerId: contract.trainerId,
          ptContractId: contract.id,
          capacity: 1,
          startAt: startTime,
          endAt: endTime,
        },
        include: {
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
        },
      });

      const reservation = await tx.reservation.create({
        data: {
          memberId: contract.memberId,
          classId: newClass.id,
          status: 'CONFIRMED',
          source: 'TRAINER',
        },
      });

      const nextUsed = contract.usedSessions + 1;
      const updatedContract = await tx.pTContract.update({
        where: { id: contract.id },
        data: {
          usedSessions: nextUsed,
          isActive: nextUsed < contract.totalSessions,
        },
      });

      return {
        newClass,
        reservation,
        updatedContract,
        member: contract.member,
        trainer: contract.trainer,
      };
    });

    const remaining =
      result.updatedContract.totalSessions - result.updatedContract.usedSessions;
    const notify = await notifyClassBooked({
      lineId: result.member.lineId,
      memberName: result.member.name,
      classTitle: result.newClass.title,
      startAt: result.newClass.startAt,
      endAt: result.newClass.endAt,
      branchName: memberBranchLabel(result.newClass.venue?.branch),
      venueName: result.newClass.venue?.name || null,
      stationName: result.newClass.station?.name || null,
      trainerName: resolveDisplayName(result.trainer),
      bookedBy: 'trainer',
    });

    let message = `私教代約成功，已扣 1 堂（剩 ${remaining} 堂）`;
    if (notify.ok) message += '，已透過 LINE 通知學員';
    else if (notify.skipped) message += `（未推播：${notify.reason}）`;
    else message += `（LINE 通知失敗：${notify.reason || '未知錯誤'}）`;

    res.json({
      status: 'success',
      message,
      data: {
        class: serializeClass({ ...result.newClass, reservations: [result.reservation] }),
        reservationId: result.reservation.id,
        contractId: result.updatedContract.id,
        remainingSessions: remaining,
        notify: {
          ok: Boolean(notify.ok),
          skipped: Boolean(notify.skipped),
          reason: notify.reason || null,
        },
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '私教代約失敗' });
  }
});

// ==========================================
// POST /api/trainer/schedule-consult
// Body: { venueId, stationId?, startAt, endAt, name, phone, note?, consultGuestId?, capacity? }
// 諮詢僅此一種：自選日期／時間開 CONSULT 堂＋代約（無需選「課程」）
// ==========================================
router.post('/schedule-consult', async (req, res) => {
  const {
    venueId,
    stationId,
    startAt,
    endAt,
    name,
    phone,
    note,
    consultGuestId,
    capacity,
  } = req.body || {};

  if (!venueId || !startAt || !endAt) {
    return res.status(400).json({
      status: 'error',
      message: '需提供 venueId、startAt、endAt',
    });
  }
  if (!String(name || '').trim() || !String(phone || '').trim()) {
    return res.status(400).json({ status: 'error', message: '需提供姓名與電話' });
  }

  const startTime = new Date(startAt);
  const endTime = new Date(endAt);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return res.status(400).json({ status: 'error', message: '時間格式無效' });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ status: 'error', message: '結束時間必須大於開始時間' });
  }
  if (startTime.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ status: 'error', message: '不可預約已過去的時段' });
  }

  const parsedVenueId = parseInt(venueId, 10);
  const parsedStationId =
    stationId === undefined || stationId === null || stationId === ''
      ? null
      : parseInt(stationId, 10);
  const parsedCapacity = capacity == null || capacity === '' ? 1 : parseInt(capacity, 10);
  if (!Number.isInteger(parsedVenueId)) {
    return res.status(400).json({ status: 'error', message: 'venueId 無效' });
  }
  if (parsedStationId !== null && !Number.isInteger(parsedStationId)) {
    return res.status(400).json({ status: 'error', message: 'stationId 無效' });
  }
  if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
    return res.status(400).json({ status: 'error', message: 'capacity 須為正整數' });
  }

  try {
    const { trainer: workspaceTrainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });
    if (!workspaceTrainer) {
      return res.status(400).json({
        status: 'error',
        message: isAdminUser(req.user) ? '請指定 viewAsTrainerId' : '尚未綁定教練檔案',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const trainer = await tx.trainer.findUnique({
        where: { id: workspaceTrainer.id },
        select: { id: true, name: true, displayName: true, role: true, isActive: true },
      });
      if (!trainer || !trainer.isActive) {
        const err = new Error('教練不存在或已停用');
        err.statusCode = 404;
        throw err;
      }

      const venue = await tx.venue.findUnique({
        where: { id: parsedVenueId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) {
        const err = new Error('找不到場地');
        err.statusCode = 404;
        throw err;
      }

      if (parsedStationId != null) {
        if (!venue.stations.some((s) => s.id === parsedStationId)) {
          const err = new Error('站點不屬於此場地');
          err.statusCode = 400;
          throw err;
        }
      } else if (venue.stations.length > 0) {
        const err = new Error('此場地已設定站點，請選擇訓練站點');
        err.statusCode = 400;
        throw err;
      }

      if (!isManagerTrainer(trainer)) {
        const allowed = await tx.trainerBranch.findUnique({
          where: {
            trainerId_branchId: {
              trainerId: trainer.id,
              branchId: venue.branchId,
            },
          },
        });
        if (!allowed) {
          const err = new Error(
            `教練無權在分店 [${staffBranchLabel(venue.branch)}] 開諮詢`,
          );
          err.statusCode = 403;
          throw err;
        }
      }

      const trainerConflict = await tx.class.findFirst({
        where: { trainerId: trainer.id, ...overlapWhere(startTime, endTime) },
        select: { id: true, title: true },
      });
      if (trainerConflict) {
        const err = new Error(`教練防衝堂：此時段已有 [${trainerConflict.title}]`);
        err.statusCode = 409;
        throw err;
      }

      await assertTrainerBookable(tx, trainer.id, startTime, endTime);

      const venueConflict = await tx.class.findFirst({
        where: {
          ...venueStationConflictWhere(parsedVenueId, parsedStationId),
          ...overlapWhere(startTime, endTime),
        },
        select: { id: true, title: true },
      });
      if (venueConflict) {
        const err = new Error(`場地防衝堂：此時段已被 [${venueConflict.title}] 佔用`);
        err.statusCode = 409;
        throw err;
      }

      const guestName = String(name).trim();
      let guest;
      if (consultGuestId) {
        guest = await tx.consultGuest.findFirst({
          where: {
            id: parseInt(consultGuestId, 10),
            trainerId: trainer.id,
            isActive: true,
          },
          include: { member: { select: { id: true, name: true, lineId: true } } },
        });
        if (!guest) {
          const err = new Error('找不到此諮詢客人');
          err.statusCode = 404;
          throw err;
        }
        guest = await upsertConsultGuest(tx, {
          trainerId: trainer.id,
          name: guestName || guest.name,
          phone: phone || guest.phone,
          note,
        });
      } else {
        guest = await upsertConsultGuest(tx, {
          trainerId: trainer.id,
          name: guestName,
          phone,
          note,
        });
      }

      const newClass = await tx.class.create({
        data: {
          title: `諮詢｜${guest.name}`,
          type: 'CONSULT',
          venueId: parsedVenueId,
          stationId: parsedStationId,
          trainerId: trainer.id,
          capacity: parsedCapacity,
          startAt: startTime,
          endAt: endTime,
        },
        include: {
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
        },
      });

      const reservation = await tx.reservation.create({
        data: {
          consultGuestId: guest.id,
          memberId: guest.memberId ?? null,
          classId: newClass.id,
          status: 'CONFIRMED',
          source: 'CONSULT_GUEST',
        },
        include: {
          consultGuest: { select: { id: true, name: true, phone: true, memberId: true } },
          member: { select: { id: true, name: true, phone: true, lineId: true } },
        },
      });

      return { newClass, reservation, guest, trainer };
    });

    const lineId = result.reservation.member?.lineId || null;
    const notify = await notifyClassBooked({
      lineId,
      memberName: result.guest.name,
      classTitle: result.newClass.title,
      startAt: result.newClass.startAt,
      endAt: result.newClass.endAt,
      branchName: memberBranchLabel(result.newClass.venue?.branch),
      venueName: result.newClass.venue?.name || null,
      stationName: result.newClass.station?.name || null,
      trainerName: resolveDisplayName(result.trainer),
      bookedBy: 'trainer',
    });

    let message = `諮詢預約成功：${result.guest.name}`;
    if (lineId) {
      if (notify.ok) message += '，已 LINE 通知';
      else if (notify.skipped) message += `（未推播：${notify.reason}）`;
      else message += `（LINE 通知失敗：${notify.reason || '未知'}）`;
    } else {
      message += '（尚未綁定會員 LINE，無法推播）';
    }

    res.json({
      status: 'success',
      message,
      data: {
        class: serializeClass({ ...result.newClass, reservations: [result.reservation] }),
        reservation: result.reservation,
        guest: serializeConsultGuest(result.guest),
        notify: {
          ok: Boolean(notify.ok),
          skipped: Boolean(notify.skipped || !lineId),
          reason: lineId ? notify.reason || null : '客人尚未綁定會員 LINE',
        },
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '諮詢代約失敗' });
  }
});

// ==========================================
// GET /api/trainer/performance?month=YYYY-MM — 本人當月業績獎金試算（實發以總部結算之薪資單為準）
// ==========================================
router.get('/performance', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });
    if (!trainer) {
      return res.status(400).json({ status: 'error', message: isAdmin ? '請指定 viewAsTrainerId' : '尚未綁定教練檔案' });
    }
    const month = String(req.query.month || taipeiDateKey().slice(0, 7));
    const { start, end } = monthRange(month);
    const [perf, rules] = await Promise.all([
      coachPerformanceBetween({ trainerIds: [trainer.id], start, end }),
      resolveRules([trainer.id]),
    ]);
    const r = rules.get(trainer.id);
    res.json({
      status: 'success',
      data: {
        month,
        trainerId: trainer.id,
        performance: perf.get(trainer.id),
        rules: {
          PRIVATE: r.PRIVATE ? serializeRule(r.PRIVATE) : null,
          GROUP: r.GROUP ? serializeRule(r.GROUP) : null,
        },
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取業績失敗' });
  }
});

// ==========================================
// 教練不開放預約時段（工時內行政／備課等；休假請走請假或週班表例假／休息日）
// ==========================================
router.get('/time-offs', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });
    if (!trainer) {
      return res.status(400).json({
        status: 'error',
        message: isAdmin ? '請指定 viewAsTrainerId' : '尚未綁定教練檔案',
      });
    }
    const data = await listTrainerTimeOffs({
      trainerId: trainer.id,
      from: req.query.from,
      to: req.query.to,
      take: parseInt(req.query.take, 10) || 80,
    });
    res.json({
      status: 'success',
      data,
      meta: { reasons: TIME_OFF_REASONS, trainerId: trainer.id },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取不開放預約時段失敗' });
  }
});

router.post('/time-offs', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId ?? req.body?.trainerId,
    });
    if (!trainer) {
      return res.status(400).json({
        status: 'error',
        message: isAdmin ? '請指定 trainerId／viewAsTrainerId' : '尚未綁定教練檔案',
      });
    }
    const row = await createTrainerTimeOff({
      trainerId: trainer.id,
      startAt: req.body?.startAt,
      endAt: req.body?.endAt,
      reason: req.body?.reason,
      note: req.body?.note,
      createdByStaffId: req.user?.id,
    });
    res.json({
      status: 'success',
      message: `已登記不開放預約：${row.reason}`,
      data: row,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '新增不開放預約時段失敗' });
  }
});

router.patch('/time-offs/:id', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId ?? req.query.viewAsTrainerId,
    });
    const existing = await prisma.trainerTimeOff.findUnique({
      where: { id: parseInt(req.params.id, 10) },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到不開放預約時段' });
    }
    if (!isAdmin) {
      if (!trainer || existing.trainerId !== trainer.id) {
        return res.status(403).json({ status: 'error', message: '僅能修改本人時段' });
      }
    }
    const row = await updateTrainerTimeOff({
      id: existing.id,
      trainerId: isAdmin ? undefined : trainer.id,
      startAt: req.body?.startAt,
      endAt: req.body?.endAt,
      reason: req.body?.reason,
      note: req.body?.note,
    });
    res.json({ status: 'success', message: '已更新不開放預約時段', data: row });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新不開放預約時段失敗' });
  }
});

router.delete('/time-offs/:id', async (req, res) => {
  try {
    const { trainer, isAdmin } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.query.viewAsTrainerId,
    });
    const existing = await prisma.trainerTimeOff.findUnique({
      where: { id: parseInt(req.params.id, 10) },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到不開放預約時段' });
    }
    if (!isAdmin) {
      if (!trainer || existing.trainerId !== trainer.id) {
        return res.status(403).json({ status: 'error', message: '僅能刪除本人時段' });
      }
    }
    const row = await deleteTrainerTimeOff({
      id: existing.id,
      trainerId: isAdmin ? undefined : trainer.id,
    });
    res.json({ status: 'success', message: '已取消不開放預約時段', data: row });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除不開放預約時段失敗' });
  }
});

// ==========================================
// PATCH /api/trainer/classes/:id/reschedule
// Body: { startAt, endAt, venueId?, stationId?, viewAsTrainerId? }
// 拖拉改時：僅改時間／可選場地，保留預約與堂數（不重扣堂）
// ==========================================
router.patch('/classes/:id/reschedule', async (req, res) => {
  const classId = parseInt(req.params.id, 10);
  const { startAt, endAt, venueId, stationId } = req.body || {};

  if (!Number.isInteger(classId)) {
    return res.status(400).json({ status: 'error', message: 'classId 無效' });
  }
  if (!startAt || !endAt) {
    return res.status(400).json({ status: 'error', message: '需提供 startAt、endAt' });
  }

  const startTime = new Date(startAt);
  const endTime = new Date(endAt);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return res.status(400).json({ status: 'error', message: '時間格式無效' });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ status: 'error', message: '結束時間必須大於開始時間' });
  }
  if (startTime.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ status: 'error', message: '不可改到已過去的時段' });
  }

  try {
    const { trainer: selfTrainer } = await resolveTrainerWorkspace(req, {
      viewAsTrainerId: req.body?.viewAsTrainerId,
    });

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.class.findUnique({
        where: { id: classId },
        include: {
          venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
          reservations: {
            include: {
              member: { select: { id: true, name: true, phone: true } },
              consultGuest: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });
      if (!existing) {
        const err = new Error('找不到課程');
        err.statusCode = 404;
        throw err;
      }
      if (!isAdminUser(req.user)) {
        if (!selfTrainer || existing.trainerId !== selfTrainer.id) {
          const err = new Error('⛔ 僅能調整自己的課表');
          err.statusCode = 403;
          throw err;
        }
      } else if (selfTrainer && existing.trainerId !== selfTrainer.id) {
        const err = new Error('所選教練與課程教練不符');
        err.statusCode = 400;
        throw err;
      }

      const nextVenueId =
        venueId === undefined || venueId === null || venueId === ''
          ? existing.venueId
          : parseInt(venueId, 10);
      if (!Number.isInteger(nextVenueId)) {
        const err = new Error('venueId 無效');
        err.statusCode = 400;
        throw err;
      }

      let nextStationId = existing.stationId;
      if (stationId !== undefined) {
        nextStationId =
          stationId === null || stationId === ''
            ? null
            : parseInt(stationId, 10);
        if (nextStationId !== null && !Number.isInteger(nextStationId)) {
          const err = new Error('stationId 無效');
          err.statusCode = 400;
          throw err;
        }
      }

      const venue = await tx.venue.findUnique({
        where: { id: nextVenueId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) {
        const err = new Error('找不到場地');
        err.statusCode = 404;
        throw err;
      }

      if (nextStationId != null) {
        const station = venue.stations.find((s) => s.id === nextStationId);
        if (!station) {
          const err = new Error('站點不屬於此場地');
          err.statusCode = 400;
          throw err;
        }
      } else if (venue.stations.length > 0 && nextStationId == null) {
        const err = new Error('此場地已設定站點，請選擇訓練站點');
        err.statusCode = 400;
        throw err;
      }

      const trainerConflict = await tx.class.findFirst({
        where: {
          trainerId: existing.trainerId,
          id: { not: classId },
          ...overlapWhere(startTime, endTime),
        },
        select: { id: true, title: true },
      });
      if (trainerConflict) {
        const err = new Error(`教練防衝堂：此時段已有 [${trainerConflict.title}]`);
        err.statusCode = 409;
        throw err;
      }

      await assertTrainerBookable(tx, existing.trainerId, startTime, endTime);

      const venueConflict = await tx.class.findFirst({
        where: {
          id: { not: classId },
          ...venueStationConflictWhere(nextVenueId, nextStationId),
          ...overlapWhere(startTime, endTime),
        },
        select: { id: true, title: true },
      });
      if (venueConflict) {
        const err = new Error(`場地防衝堂：此時段已被 [${venueConflict.title}] 佔用`);
        err.statusCode = 409;
        throw err;
      }

      const updated = await tx.class.update({
        where: { id: classId },
        data: {
          startAt: startTime,
          endAt: endTime,
          venueId: nextVenueId,
          stationId: nextStationId,
        },
        include: {
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
          reservations: {
            include: {
              member: { select: { id: true, name: true, phone: true } },
              consultGuest: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });

      return updated;
    });

    res.json({
      status: 'success',
      message: '課表時間已更新',
      data: serializeClass(result),
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '改期失敗' });
  }
});

export default router;
