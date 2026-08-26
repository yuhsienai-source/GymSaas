// routes/pt.js — 團課排課（主）＋私教合約／購課（櫃檯／舊 API 仍可用）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission } from '../middleware/jwtAuth.js';
import { identifyMember, lookupMemberByPhone } from '../lib/memberIdentify.js';
import {
  assertCoursePlanSellable,
} from '../lib/coursePlan.js';
import { assertMemberSignedCoursePlanContracts } from '../lib/memberContract.js';
import { issueInvoice, normalizeInvoiceOptions } from '../lib/ezpay.js';
import {
  serializeVenue,
  serializeVenueStation,
  venueStationConflictWhere,
  venueWithStationsInclude,
} from '../lib/venueStation.js';
import { staffBranchLabel } from '../lib/branchLabel.js';
import { assertTrainerNotOnTimeOff } from '../lib/trainerTimeOff.js';
import { assertPrivateVenueAllowed } from '../lib/branchShare.js';
import { resolveDisplayName } from '../lib/displayName.js';
import {
  expandSeriesSessions,
  formatWeekdaysLabel,
  normalizeWeekdays,
} from '../lib/groupClassSeries.js';

const router = express.Router();
router.use(verifyStaff, requirePermission('pt'));

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

function generateOrderId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `TYK${dateStr}${randomStr}`;
}

async function tryIssuePtOrderInvoice(order, buyerName) {
  try {
    const invoiceResult = await issueInvoice({
      id: order.id,
      amount: order.amount,
      itemDesc: order.itemDesc,
      buyerName: buyerName || '體育客顧客',
      carrierNum: order.carrierNum || null,
      buyerUbn: order.buyerUbn || null,
      loveCode: order.loveCode || null,
    });
    if (invoiceResult.Status === 'SUCCESS') {
      const invoiceData = JSON.parse(invoiceResult.Result);
      await prisma.order.update({
        where: { id: order.id },
        data: { invoiceNumber: invoiceData.InvoiceNumber },
      });
      console.log(`🧾 私教訂單 ${order.id} 發票：${invoiceData.InvoiceNumber}`);
      return invoiceData.InvoiceNumber;
    }
    console.error(`❌ 私教訂單 ${order.id} 發票失敗:`, invoiceResult.Message || invoiceResult);
    return null;
  } catch (error) {
    console.error(`❌ 私教訂單 ${order.id} 發票例外:`, error.message);
    return null;
  }
}

/** 經典區間重疊：(新開始 < 舊結束) ∧ (新結束 > 舊開始) */
function overlapWhere(startTime, endTime) {
  return {
    startAt: { lt: endTime },
    endAt: { gt: startTime },
  };
}

function serializeGroupClass(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    capacity: row.capacity,
    startAt: row.startAt,
    endAt: row.endAt,
    seriesId: row.seriesId ?? null,
    venueId: row.venueId,
    venueName: row.venue?.name || null,
    branchId: row.venue?.branchId ?? null,
    branchName: staffBranchLabel(row.venue?.branch),
    stationId: row.stationId,
    stationName: row.station?.name || null,
    trainerId: row.trainerId,
    trainerName: row.trainer?.name || null,
    booked: row._count?.reservations ?? row.reservations?.length ?? 0,
  };
}

function serializeClassSeries(row) {
  const classCount = row._count?.classes ?? row.classes?.length ?? 0;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    capacity: row.capacity,
    startDate: row.startDate,
    endDate: row.endDate,
    weekdays: row.weekdays || [],
    weekdaysLabel: formatWeekdaysLabel(row.weekdays || []),
    startTime: row.startTime,
    endTime: row.endTime,
    venueId: row.venueId,
    venueName: row.venue?.name || null,
    branchName: staffBranchLabel(row.venue?.branch),
    stationId: row.stationId,
    stationName: row.station?.name || null,
    trainerId: row.trainerId,
    trainerName: row.trainer?.name || null,
    classCount,
    isActive: row.isActive,
  };
}

// ==========================================
// 會員辨識（與櫃檯儲值相同：電話／QR／人臉）
// ==========================================
router.get('/members/lookup', async (req, res) => {
  try {
    const result = await lookupMemberByPhone(req.query.phone);
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
    const result = await identifyMember(req.body || {});
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: error.message || '會員辨認失敗' });
  }
});

// ==========================================
// 【團課管理】控制台：場地／教練／即將團課
// GET /api/pt/dashboard-data
// ==========================================
router.get('/dashboard-data', async (req, res) => {
  try {
    const now = new Date();
    const [trainers, venues, upcomingGroupClasses, activeSeries] = await Promise.all([
      prisma.trainer.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          role: true,
          branches: { select: { branchId: true, branch: { select: { id: true, name: true, code: true } } } },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.venue.findMany({
        include: venueWithStationsInclude,
        orderBy: { id: 'asc' },
      }),
      prisma.class.findMany({
        where: { type: 'GROUP', startAt: { gte: now } },
        include: {
          venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true } },
          _count: {
            select: {
              reservations: { where: { status: { in: ['PENDING', 'CONFIRMED'] } } },
            },
          },
        },
        orderBy: { startAt: 'asc' },
        take: 80,
      }),
      prisma.classSeries.findMany({
        where: { isActive: true, endDate: { gte: now } },
        include: {
          venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true } },
          _count: { select: { classes: true } },
        },
        orderBy: { startDate: 'asc' },
        take: 40,
      }),
    ]);

    res.json({
      status: 'success',
      data: {
        trainers,
        venues: venues.map(serializeVenue),
        upcomingGroupClasses: upcomingGroupClasses.map(serializeGroupClass),
        activeSeries: activeSeries.map(serializeClassSeries),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取團課管理資料失敗' });
  }
});

// ==========================================
// 團課期班排課（GROUP）
// POST /api/pt/schedule-group-class
// Body: { title, venueId, stationId?, startDate, endDate, weekdays|weekday,
//         startTime, endTime, capacity, trainerId }
// ==========================================
router.post('/schedule-group-class', async (req, res) => {
  const {
    title,
    venueId,
    stationId,
    startDate,
    endDate,
    weekdays,
    weekday,
    startTime,
    endTime,
    capacity,
    trainerId,
    ...illegal
  } = req.body || {};

  if (Object.keys(illegal).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：已拒絕 [${Object.keys(illegal).join(', ')}]`,
    });
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ status: 'error', message: '請提供團課名稱' });
  }
  if (venueId === undefined || trainerId === undefined || !startDate || !endDate) {
    return res.status(400).json({
      status: 'error',
      message: '需提供 venueId、trainerId、startDate、endDate、weekdays、startTime、endTime',
    });
  }

  try {
    const weekdayList = normalizeWeekdays(
      weekdays !== undefined ? weekdays : weekday !== undefined ? [weekday] : [],
    );
    const sessions = expandSeriesSessions({
      startDate,
      endDate,
      weekdays: weekdayList,
      startTime,
      endTime,
    });

    const parsedVenueId = parseInt(venueId, 10);
    const parsedTrainerId = parseInt(trainerId, 10);
    const parsedStationId =
      stationId === undefined || stationId === null || stationId === ''
        ? null
        : parseInt(stationId, 10);
    if (!Number.isInteger(parsedVenueId) || parsedVenueId <= 0) {
      return res.status(400).json({ status: 'error', message: 'venueId 無效' });
    }
    if (!Number.isInteger(parsedTrainerId) || parsedTrainerId <= 0) {
      return res.status(400).json({ status: 'error', message: 'trainerId 無效' });
    }
    if (parsedStationId !== null && !Number.isInteger(parsedStationId)) {
      return res.status(400).json({ status: 'error', message: 'stationId 無效' });
    }
    const cap = parseInt(capacity, 10);
    if (!Number.isInteger(cap) || cap < 1) {
      return res.status(400).json({ status: 'error', message: '人數上限須為正整數' });
    }

    const trimmedTitle = title.trim().slice(0, 100);
    const startTimeStr = String(startTime).trim();
    const endTimeStr = String(endTime).trim();

    const result = await prisma.$transaction(async (tx) => {
      const trainer = await tx.trainer.findUnique({ where: { id: parsedTrainerId } });
      if (!trainer || !trainer.isActive) {
        httpError('教練不存在或已停用', 404);
      }

      const venue = await tx.venue.findUnique({
        where: { id: parsedVenueId },
        include: {
          branch: true,
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) httpError('場地不存在', 404);

      if (parsedStationId != null) {
        if (!venue.stations.some((s) => s.id === parsedStationId)) {
          httpError('站點不屬於此場地', 400);
        }
      } else if (venue.stations.length > 0) {
        httpError('此場地已設定站點，請選擇訓練站點', 400);
      }

      if (trainer.role !== 'MANAGER') {
        const allowed = await tx.trainerBranch.findUnique({
          where: {
            trainerId_branchId: {
              trainerId: trainer.id,
              branchId: venue.branchId,
            },
          },
        });
        if (!allowed) {
          httpError(`教練無權在分店 [${staffBranchLabel(venue.branch)}] 開課`, 403);
        }
      }

      for (const slot of sessions) {
        await assertTrainerNotOnTimeOff(tx, trainer.id, slot.startAt, slot.endAt);

        const trainerConflict = await tx.class.findFirst({
          where: { trainerId: trainer.id, ...overlapWhere(slot.startAt, slot.endAt) },
          select: { id: true, title: true, startAt: true },
        });
        if (trainerConflict) {
          httpError(
            `教練防衝堂：${slot.date} 已有 [${trainerConflict.title}]`,
            409,
          );
        }

        const venueConflict = await tx.class.findFirst({
          where: {
            ...venueStationConflictWhere(venue.id, parsedStationId),
            ...overlapWhere(slot.startAt, slot.endAt),
          },
          select: { id: true, title: true },
        });
        if (venueConflict) {
          httpError(`場地防衝堂：${slot.date} 已被 [${venueConflict.title}] 佔用`, 409);
        }
      }

      const series = await tx.classSeries.create({
        data: {
          title: trimmedTitle,
          type: 'GROUP',
          venueId: venue.id,
          stationId: parsedStationId,
          trainerId: trainer.id,
          capacity: cap,
          startDate: new Date(`${String(startDate).trim()}T00:00:00.000Z`),
          endDate: new Date(`${String(endDate).trim()}T00:00:00.000Z`),
          weekdays: weekdayList,
          startTime: startTimeStr,
          endTime: endTimeStr,
          isActive: true,
        },
      });

      await tx.class.createMany({
        data: sessions.map((slot) => ({
          seriesId: series.id,
          trainerId: trainer.id,
          venueId: venue.id,
          stationId: parsedStationId,
          title: trimmedTitle,
          type: 'GROUP',
          capacity: cap,
          startAt: slot.startAt,
          endAt: slot.endAt,
        })),
      });

      return tx.classSeries.findUnique({
        where: { id: series.id },
        include: {
          venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true } },
          _count: { select: { classes: true } },
        },
      });
    });

    const wdLabel = formatWeekdaysLabel(weekdayList);
    res.status(201).json({
      status: 'success',
      message: `期班「${result.title}」已建立：${String(startDate).trim()}～${String(endDate).trim()} · ${wdLabel} ${startTimeStr}–${endTimeStr} · 共 ${result._count.classes} 堂`,
      data: {
        series: serializeClassSeries(result),
        sessionCount: result._count.classes,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '團課期班排課失敗' });
  }
});

// ==========================================
// 1. 購買私教堂數合約（依總部 CoursePlan；禁止自填堂數／金額）
// POST /api/pt/buy-contract
// Body: { memberId, trainerId, items: [{ coursePlanId, qty }], carrierNum?, buyerUbn?, loveCode? }
// ==========================================
router.post('/buy-contract', async (req, res) => {
  const {
    memberId,
    trainerId,
    items,
    totalSessions,
    pricePaid,
    coursePlanId,
    qty,
    carrierNum,
    buyerUbn,
    loveCode,
    ...rest
  } = req.body || {};

  if (totalSessions !== undefined || pricePaid !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 禁止自填堂數／金額：請以 coursePlanId（方案）與 qty（數量）購買',
    });
  }

  if (Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：已拒絕 [${Object.keys(rest).join(', ')}]`,
    });
  }

  if (memberId === undefined || trainerId === undefined) {
    return res.status(400).json({
      status: 'error',
      message: '合約資料不完整：需提供 memberId、trainerId、items',
    });
  }

  let invoiceOpts;
  try {
    invoiceOpts = normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }

  // 相容單筆：{ coursePlanId, qty } → items
  let rawItems = items;
  if (!Array.isArray(rawItems) && coursePlanId !== undefined) {
    rawItems = [{ coursePlanId, qty: qty ?? 1 }];
  }

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: '請提供 items：[{ coursePlanId, qty }]',
    });
  }

  const parsedMemberId = parseInt(memberId, 10);
  const parsedTrainerId = parseInt(trainerId, 10);
  if (!Number.isInteger(parsedMemberId) || !Number.isInteger(parsedTrainerId)) {
    return res.status(400).json({ status: 'error', message: 'memberId / trainerId 必須為整數' });
  }

  const normalizedItems = [];
  for (const row of rawItems) {
    const planId = parseInt(row?.coursePlanId, 10);
    const units = parseInt(row?.qty, 10);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(400).json({ status: 'error', message: 'coursePlanId 無效' });
    }
    if (!Number.isInteger(units) || units <= 0) {
      return res.status(400).json({ status: 'error', message: 'qty 必須為正整數' });
    }
    normalizedItems.push({ coursePlanId: planId, qty: units });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.member.findUnique({ where: { id: parsedMemberId } });
      if (!member) httpError('找不到此會員', 404);

      const trainer = await tx.trainer.findUnique({
        where: { id: parsedTrainerId },
        include: { branches: { select: { branchId: true } } },
      });
      if (!trainer || !trainer.isActive) {
        httpError('找不到此教練或教練已停用', 404);
      }
      const trainerBranchIds = new Set(trainer.branches.map((b) => b.branchId));
      const isManager = trainer.role === 'MANAGER';

      const created = [];
      for (const line of normalizedItems) {
        const plan = await tx.coursePlan.findUnique({
          where: { id: line.coursePlanId },
          include: { branch: { select: { id: true, name: true, code: true } } },
        });
        if (!plan || plan.planType !== 'CUSTOM_PT') {
          httpError('找不到客製化私教方案，或方案類型不符', 404);
        }
        assertCoursePlanSellable(plan);
        if (!Number.isInteger(plan.sessions) || plan.sessions <= 0) {
          httpError(`方案 [${plan.name}] 未設定堂數`, 400);
        }
        if (!isManager && !trainerBranchIds.has(plan.branchId)) {
          httpError(
            `教練無權販售分店「${staffBranchLabel(plan.branch) || plan.branchId}」的方案`,
            403,
          );
        }
        if (plan.requiresMemberContract) {
          await assertMemberSignedCoursePlanContracts(parsedMemberId, plan.id);
        }

        const totalSessionsLine = plan.sessions * line.qty;
        const priceLine = plan.price * line.qty;

        const contract = await tx.pTContract.create({
          data: {
            memberId: parsedMemberId,
            trainerId: parsedTrainerId,
            totalSessions: totalSessionsLine,
            usedSessions: 0,
            pricePaid: priceLine,
            isActive: true,
            source: 'PURCHASE',
            coursePlanId: plan.id,
            branchId: plan.branchId,
          },
          include: {
            member: { select: { id: true, name: true } },
            trainer: { select: { id: true, name: true } },
          },
        });

        const order = await tx.order.create({
          data: {
            id: generateOrderId(),
            memberId: parsedMemberId,
            amount: priceLine,
            itemDesc:
              `私教購案 | ${plan.name} ×${line.qty}` +
              ` | 方案#${plan.id} | ${trainer.name} × ${totalSessionsLine} 堂` +
              ` | 學員 ${member.name}`,
            payMethod: 'CASH',
            carrierNum: invoiceOpts.carrierNum,
            buyerUbn: invoiceOpts.buyerUbn,
            loveCode: invoiceOpts.loveCode,
            status: 'PAID',
          },
        });

        created.push({
          contract,
          order,
          memberName: member.name,
          coursePlanId: plan.id,
          qty: line.qty,
          totalSessions: totalSessionsLine,
          pricePaid: priceLine,
        });
      }

      return created;
    });

    const invoices = [];
    for (const row of result) {
      const invoiceNumber = await tryIssuePtOrderInvoice(row.order, row.memberName);
      invoices.push({ orderId: row.order.id, invoiceNumber });
    }

    const totalSessionsSum = result.reduce((s, r) => s + r.totalSessions, 0);
    const totalAmount = result.reduce((s, r) => s + r.pricePaid, 0);
    const invoiceNumbers = invoices.map((i) => i.invoiceNumber).filter(Boolean);

    res.json({
      status: 'success',
      message:
        `合約成立！共 ${result.length} 筆、${totalSessionsSum} 堂、$${totalAmount}（不扣會員錢包）` +
        (invoiceNumbers.length ? ` · 發票 ${invoiceNumbers.join('、')}` : ''),
      data: {
        items: result.map((r) => ({
          contract: r.contract,
          orderId: r.order.id,
          coursePlanId: r.coursePlanId,
          qty: r.qty,
          totalSessions: r.totalSessions,
          pricePaid: r.pricePaid,
          remainingSessions: r.contract.totalSessions,
          invoiceNumber:
            invoices.find((i) => i.orderId === r.order.id)?.invoiceNumber || null,
        })),
        invoices,
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '合約建立失敗' });
  }
});

// ==========================================
// 2. 預約私教課並扣堂（教練防衝堂 + 場地／站點防衝堂）
// POST /api/pt/schedule-session
// Body: { contractId, venueId, stationId?, startAt, endAt }
// ==========================================
router.post('/schedule-session', async (req, res) => {
  const { contractId, venueId, stationId, startAt, endAt } = req.body;

  if (!contractId || !venueId || !startAt || !endAt) {
    return res.status(400).json({
      status: 'error',
      message: '參數不完整：需提供 contractId、venueId、startAt、endAt',
    });
  }

  const startTime = new Date(startAt);
  const endTime = new Date(endAt);

  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    return res.status(400).json({ status: 'error', message: '時間格式無效' });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ status: 'error', message: '預約失敗：結束時間必須大於開始時間' });
  }

  const parsedContractId = parseInt(contractId, 10);
  const parsedVenueId = parseInt(venueId, 10);
  const parsedStationId =
    stationId === undefined || stationId === null || stationId === ''
      ? null
      : parseInt(stationId, 10);
  if (parsedStationId !== null && !Number.isInteger(parsedStationId)) {
    return res.status(400).json({ status: 'error', message: 'stationId 無效' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const contract = await tx.pTContract.findUnique({
        where: { id: parsedContractId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          member: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, role: true, isActive: true } },
        },
      });

      if (!contract || !contract.isActive) {
        httpError('預約失敗：找不到合約或合約已失效', 400);
      }
      if (contract.expiresAt && new Date() > contract.expiresAt) {
        await tx.pTContract.update({
          where: { id: contract.id },
          data: { isActive: false },
        });
        httpError('預約失敗：合約已過期', 403);
      }
      if (contract.usedSessions >= contract.totalSessions) {
        httpError('預約失敗：該合約堂數已耗盡，請重新購買', 403);
      }
      if (!contract.trainer.isActive) {
        httpError('預約失敗：綁定教練已停用', 400);
      }

      const venue = await tx.venue.findUnique({
        where: { id: parsedVenueId },
        include: {
          branch: { select: { id: true, name: true, code: true } },
          stations: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
        },
      });
      if (!venue) httpError('預約失敗：找不到場地', 404);

      let station = null;
      if (parsedStationId != null) {
        station = venue.stations.find((s) => s.id === parsedStationId) || null;
        if (!station) {
          httpError('預約失敗：站點不屬於此場地', 400);
        }
      } else if (venue.stations.length > 0) {
        httpError('預約失敗：此場地已設定站點，請選擇訓練站點', 400);
      }

      if (contract.branch) {
        assertPrivateVenueAllowed(contract.branch, venue.branch);
      }

      if (contract.trainer.role !== 'MANAGER') {
        const allowed = await tx.trainerBranch.findUnique({
          where: {
            trainerId_branchId: {
              trainerId: contract.trainerId,
              branchId: venue.branchId,
            },
          },
        });
        if (!allowed) {
          httpError(
            `⛔ 排課失敗：教練 [${contract.trainer.name}] 無權在分店 [${staffBranchLabel(venue.branch)}] 授課`,
            403
          );
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
        httpError(
          `⛔ 教練防衝堂：教練 [${contract.trainer.name}] 該時段已有課程` +
            ` [${trainerConflict.title}]（${trainerConflict.startAt.toISOString()} ~ ${trainerConflict.endAt.toISOString()}）`,
          409
        );
      }

      await assertTrainerNotOnTimeOff(tx, contract.trainerId, startTime, endTime);

      const venueConflict = await tx.class.findFirst({
        where: {
          ...venueStationConflictWhere(parsedVenueId, parsedStationId),
          ...overlapWhere(startTime, endTime),
        },
        select: {
          id: true,
          title: true,
          startAt: true,
          endAt: true,
          trainerId: true,
          stationId: true,
        },
      });
      if (venueConflict) {
        const loc = station
          ? `${staffBranchLabel(venue.branch)} - ${venue.name}／${station.name}`
          : `${staffBranchLabel(venue.branch)} - ${venue.name}`;
        httpError(
          `⛔ 場地防衝堂：[${loc}] 此時段已被佔用` +
            ` [${venueConflict.title}]（${venueConflict.startAt.toISOString()} ~ ${venueConflict.endAt.toISOString()}）`,
          409
        );
      }

      const newClass = await tx.class.create({
        data: {
          title: `1v1 私教｜${contract.member.name} × ${resolveDisplayName(contract.trainer)}`,
          type: 'PRIVATE',
          venueId: parsedVenueId,
          stationId: parsedStationId,
          trainerId: contract.trainerId,
          capacity: 1,
          startAt: startTime,
          endAt: endTime,
        },
      });

      const reservation = await tx.reservation.create({
        data: {
          memberId: contract.memberId,
          classId: newClass.id,
          status: 'CONFIRMED',
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
        memberName: contract.member.name,
        trainerName: contract.trainer.name,
        venueName: station
          ? `${staffBranchLabel(venue.branch)} - ${venue.name}／${station.name}`
          : `${staffBranchLabel(venue.branch)} - ${venue.name}`,
        station: station ? serializeVenueStation(station) : null,
      };
    });

    const remaining =
      result.updatedContract.totalSessions - result.updatedContract.usedSessions;

    res.json({
      status: 'success',
      message: `預約成功！已扣除 1 堂（剩餘 ${remaining} 堂）｜教練與場地皆無衝突`,
      data: {
        class: result.newClass,
        reservationId: result.reservation.id,
        contractId: result.updatedContract.id,
        remainingSessions: remaining,
        trainer: result.trainerName,
        member: result.memberName,
        venue: result.venueName,
        station: result.station,
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

export default router;
