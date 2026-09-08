// routes/hq.js — 總部營運端（開店 / 場地 / 促銷 / 教練調度）
// 企業核心資產：僅 ADMIN（店長／總部）可操作
import express from 'express';
import prisma from '../lib/prisma.js';
import bcrypt from 'bcrypt';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import {
  STAFF_PERMISSIONS,
  validateStaffCreateInput,
} from '../lib/staffAccess.js';
import {
  normalizeProductKind,
  PRODUCT_KIND_SERVICE,
  resolveSafetyStock,
} from '../lib/productKind.js';
import {
  normalizePlanMode,
  normalizeUsageType,
  normalizePromotionKind,
  resolvePromotionFields,
  resolvePromotionSchedule,
  isUnlimitedPromotion,
} from '../lib/promotion.js';
import {
  grantCompensationBonus,
  grantCompensationExpire,
  grantCompensationCourse,
  clearMemberAlert,
  listHqCompensationLogs,
  HQ_COMPENSATION_ACTIONS,
} from '../lib/hqCompensation.js';
import { normalizePhone } from '../lib/memberIdentify.js';
import { normalizeBranchSellerUbn } from '../lib/invoiceAllowance.js';
import { normalizeBranchCode, staffBranchLabel } from '../lib/branchLabel.js';
import { normalizeDisplayName } from '../lib/displayName.js';
import {
  mapPromotionContracts,
  syncPromotionContracts,
  mapCoursePlanContracts,
  syncCoursePlanContracts,
  parseContractIds,
} from '../lib/memberContract.js';
import {
  serializeVenue,
  syncVenueStations,
  venueWithStationsInclude,
} from '../lib/venueStation.js';
import {
  normalizeCoursePlanType,
  normalizeCoursePlanKind,
  resolveCoursePlanFields,
  resolveCoursePlanSchedule,
} from '../lib/coursePlan.js';
import {
  generateDeviceKey,
  hashDeviceKey,
  normalizeDeviceCode,
  serializeGateDevice,
} from '../lib/gateDevice.js';

const router = express.Router();

// 雙重海關：先過員工 JWT，再鎖死 ADMIN
router.use(verifyStaff, requireAdmin);

const promotionContractInclude = {
  branch: { select: { id: true, name: true, code: true } },
  contractLinks: {
    include: {
      contract: { select: { id: true, title: true, shortName: true, status: true } },
    },
  },
};

function withPromotionContracts(promotion) {
  if (!promotion) return promotion;
  const { contractLinks, ...rest } = promotion;
  return {
    ...rest,
    contracts: mapPromotionContracts({ contractLinks }),
  };
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

function parsePositiveInt(value, fieldName) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    httpError(`${fieldName} 必須為正整數`, 400);
  }
  return n;
}

// ==========================================
// 總覽：分店／場地／促銷／教練指派現況
// GET /api/hq/overview
// ==========================================
router.get('/overview', async (req, res) => {
  try {
    const [branches, trainers] = await Promise.all([
      prisma.branch.findMany({
        where: { isActive: true },
        include: {
          venues: { select: { id: true, name: true } },
          promotions: {
            where: { isActive: true },
            select: { id: true, name: true, price: true, bonusGiven: true },
          },
          trainers: {
            include: {
              trainer: { select: { id: true, name: true, role: true, isActive: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
      }),
      prisma.trainer.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          branches: {
            select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
          },
        },
        orderBy: { id: 'asc' },
      }),
    ]);

    res.json({ status: 'success', data: { branches, trainers } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取總部總覽失敗' });
  }
});

// ==========================================
// 1. 開立分店 (Branch)
// POST /api/hq/branches
// Body: { name, code, address?, invoiceSellerName?, invoiceSellerUbn? }
// ==========================================
router.post('/branches', async (req, res) => {
  const { name, code, address, invoiceSellerName, invoiceSellerUbn } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ status: 'error', message: '請提供分店名稱' });
  }

  try {
    const branchCode = normalizeBranchCode(code);
    let sellerUbn = undefined;
    if (invoiceSellerUbn !== undefined) {
      sellerUbn = normalizeBranchSellerUbn(invoiceSellerUbn);
    }
    const branch = await prisma.branch.create({
      data: {
        name: name.trim(),
        code: branchCode,
        address: address?.trim() || null,
        invoiceSellerName:
          invoiceSellerName !== undefined
            ? String(invoiceSellerName || '').trim() || null
            : null,
        ...(sellerUbn !== undefined ? { invoiceSellerUbn: sellerUbn } : {}),
        isActive: true,
      },
    });

    res.status(201).json({
      status: 'success',
      message: `分店 [${branch.name}]（${branch.code}）開立成功`,
      data: branch,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    if (error.code === 'P2002') {
      const targets = error.meta?.target;
      const field = Array.isArray(targets) ? targets.join(',') : String(targets || '');
      if (field.includes('code')) {
        return res.status(400).json({ status: 'error', message: '分店代碼已存在' });
      }
      return res.status(400).json({ status: 'error', message: '分店名稱已存在' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '分店建立失敗' });
  }
});

// GET /api/hq/branches
router.get('/branches', async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      include: {
        _count: { select: { venues: true, promotions: true, trainers: true } },
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: branches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取分店列表失敗' });
  }
});

// PATCH /api/hq/branches/:id
router.patch('/branches/:id', async (req, res) => {
  const { name, code, address, isActive, invoiceSellerName, invoiceSellerUbn } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (code !== undefined) data.code = normalizeBranchCode(code);
  if (address !== undefined) data.address = address ? String(address).trim() : null;
  if (invoiceSellerName !== undefined) {
    data.invoiceSellerName = String(invoiceSellerName || '').trim() || null;
  }
  if (invoiceSellerUbn !== undefined) {
    data.invoiceSellerUbn = normalizeBranchSellerUbn(invoiceSellerUbn);
  }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
    }
    data.isActive = isActive;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const branch = await prisma.branch.update({ where: { id }, data });
    res.json({
      status: 'success',
      message: `分店 [${branch.name}]${branch.code ? `（${branch.code}）` : ''} 已更新`,
      data: branch,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      const targets = error.meta?.target;
      const field = Array.isArray(targets) ? targets.join(',') : String(targets || '');
      if (field.includes('code')) {
        return res.status(400).json({ status: 'error', message: '分店代碼已存在' });
      }
      return res.status(400).json({ status: 'error', message: '分店名稱已存在' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此分店' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新分店失敗' });
  }
});

// DELETE /api/hq/branches/:id
// 有營運關聯 → 軟刪（isActive=false）；無關聯 → 硬刪（含 cascade 場地／站點／促銷等）
router.delete('/branches/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const branch = await prisma.branch.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            venues: true,
            promotions: true,
            coursePlans: true,
            trainers: true,
            products: true,
            purchaseOrders: true,
            saleOrders: true,
            checkoutSessions: true,
            shiftHandovers: true,
            checkInLogs: true,
            staffMembers: true,
            ptContracts: true,
            memberBranches: true,
            gateDevices: true,
          },
        },
      },
    });
    if (!branch) {
      return res.status(404).json({ status: 'error', message: '找不到此分店' });
    }

    const c = branch._count;
    const [classCount, seriesCount] = await Promise.all([
      prisma.class.count({ where: { venue: { branchId: id } } }),
      prisma.classSeries.count({ where: { venue: { branchId: id } } }),
    ]);
    const blocking =
      c.promotions +
      c.coursePlans +
      c.trainers +
      c.products +
      c.purchaseOrders +
      c.saleOrders +
      c.checkoutSessions +
      c.shiftHandovers +
      c.checkInLogs +
      c.staffMembers +
      c.ptContracts +
      c.memberBranches +
      c.gateDevices +
      classCount +
      seriesCount;

    if (blocking > 0) {
      if (!branch.isActive) {
        return res.status(409).json({
          status: 'error',
          message: `分店 [${branch.name}] 已停用，且仍有歷史／綁定資料，無法永久刪除`,
        });
      }
      const updated = await prisma.branch.update({
        where: { id },
        data: { isActive: false },
      });
      return res.json({
        status: 'success',
        message: `分店 [${updated.name}] 已停用（保留歷史資料，未永久刪除）`,
        data: { ...updated, softDeleted: true },
      });
    }

    // 僅有空場地可 cascade 刪
    await prisma.branch.delete({ where: { id } });
    return res.json({
      status: 'success',
      message: `分店 [${branch.name}] 已刪除`,
      data: { id, hardDeleted: true },
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此分店' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({
        status: 'error',
        message: '分店仍有關聯資料，無法刪除；已改請先停用或清除關聯',
      });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除分店失敗' });
  }
});

// ==========================================
// 2. 為分店建立場地 (Venue)
// POST /api/hq/venues
// Body: { branchId, name, stations? }  stations: "A~E、外區" 或 ["A","B","外區"]
// ==========================================
router.post('/venues', async (req, res) => {
  const { branchId, name, stations } = req.body;

  if (!branchId || !name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({
      status: 'error',
      message: '請提供 branchId 與場地名稱',
    });
  }

  try {
    const parsedBranchId = parsePositiveInt(branchId, 'branchId');

    const branch = await prisma.branch.findUnique({ where: { id: parsedBranchId } });
    if (!branch || !branch.isActive) {
      return res.status(404).json({ status: 'error', message: '找不到此分店或分店已停用' });
    }

    const venue = await prisma.$transaction(async (tx) => {
      const created = await tx.venue.create({
        data: {
          branchId: parsedBranchId,
          name: name.trim(),
        },
      });
      if (stations !== undefined && stations !== null && String(stations).trim() !== '') {
        await syncVenueStations(tx, created.id, stations);
      }
      return tx.venue.findUnique({
        where: { id: created.id },
        include: venueWithStationsInclude,
      });
    });

    res.status(201).json({
      status: 'success',
      message: `場地 [${venue.name}] 已掛載至分店 [${staffBranchLabel(branch)}]`,
      data: serializeVenue(venue),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '場地建立失敗' });
  }
});

// GET /api/hq/venues?branchId=
router.get('/venues', async (req, res) => {
  try {
    const where = {};
    if (req.query.branchId !== undefined) {
      where.branchId = parsePositiveInt(req.query.branchId, 'branchId');
    }

    const venues = await prisma.venue.findMany({
      where,
      include: venueWithStationsInclude,
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });
    res.json({ status: 'success', data: venues.map(serializeVenue) });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取場地列表失敗' });
  }
});

// PATCH /api/hq/venues/:id
// Body: { name?, stations? }  stations 傳入則整批同步（空字串＝清空站點）
router.patch('/venues/:id', async (req, res) => {
  const { name, stations } = req.body || {};
  if (name === undefined && stations === undefined) {
    return res.status(400).json({ status: 'error', message: '請提供場地名稱或站點' });
  }
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ status: 'error', message: '請提供場地名稱' });
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const venue = await prisma.$transaction(async (tx) => {
      if (name !== undefined) {
        await tx.venue.update({
          where: { id },
          data: { name: String(name).trim() },
        });
      }
      if (stations !== undefined) {
        await syncVenueStations(tx, id, stations);
      }
      return tx.venue.findUnique({
        where: { id },
        include: venueWithStationsInclude,
      });
    });
    res.json({
      status: 'success',
      message: `場地 [${venue.name}] 已更新`,
      data: serializeVenue(venue),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此場地' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新場地失敗' });
  }
});

// DELETE /api/hq/venues/:id — 有排課／期班則拒絕；站點 cascade
router.delete('/venues/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const venue = await prisma.venue.findUnique({
      where: { id },
      include: {
        _count: { select: { classes: true, classSeries: true } },
      },
    });
    if (!venue) {
      return res.status(404).json({ status: 'error', message: '找不到此場地' });
    }
    if (venue._count.classes > 0 || venue._count.classSeries > 0) {
      return res.status(409).json({
        status: 'error',
        message: `場地 [${venue.name}] 仍有課程或期班，無法刪除`,
      });
    }

    await prisma.venue.delete({ where: { id } });
    return res.json({
      status: 'success',
      message: `場地 [${venue.name}] 已刪除`,
      data: { id },
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此場地' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({
        status: 'error',
        message: '場地仍有關聯資料，無法刪除',
      });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除場地失敗' });
  }
});

// ==========================================
// 3. 為分店建立促銷方案 (Promotion) — 商品化儲值來源
// POST /api/hq/promotions
// Body: { branchIds: number[] }（或相容舊版 branchId）+ name, price, …
// 多選分店時，每間分店會各建一筆相同條件的方案
// ==========================================
router.post('/promotions', async (req, res) => {
  const {
    branchId,
    branchIds,
    name,
    price,
    bonusGiven,
    kind,
    type,
    usageType,
    planMode,
    saleStartAt,
    saleEndAt,
    durationDays,
    unitDays,
    periodCount,
    requiresMemberContract,
    enableCardRecurring,
    recurringAmount,
    payuniPeriodHash,
    payuniPeriodHashOnline,
    contractIds,
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim() || price === undefined) {
    return res.status(400).json({
      status: 'error',
      message: '欄位不完整：需提供 name、price，以及 branchIds（或 branchId）',
    });
  }

  try {
    const rawIds = Array.isArray(branchIds)
      ? branchIds
      : branchId !== undefined
        ? [branchId]
        : [];
    if (rawIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: '請至少選擇一間分店（branchIds）',
      });
    }

    const uniqueBranchIds = [...new Set(rawIds.map((id) => parsePositiveInt(id, 'branchId')))];

    const branches = await prisma.branch.findMany({
      where: { id: { in: uniqueBranchIds }, isActive: true },
      select: { id: true, name: true, code: true },
    });
    if (branches.length !== uniqueBranchIds.length) {
      return res.status(404).json({
        status: 'error',
        message: '部分分店不存在或已停用，請確認 branchIds',
      });
    }

    const schedule = resolvePromotionSchedule({ planMode, saleStartAt, saleEndAt });
    const normalizedMode = normalizePlanMode(planMode);
    const fields = resolvePromotionFields(
      {
        kind: kind ?? type,
        usageType,
        price,
        bonusGiven,
        durationDays,
        unitDays,
        periodCount,
        requiresMemberContract,
        enableCardRecurring,
        recurringAmount,
        payuniPeriodHash,
        payuniPeriodHashOnline,
      },
      { partial: false },
    );

    const promotions = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const bid of uniqueBranchIds) {
        const promo = await tx.promotion.create({
          data: {
            branchId: bid,
            name: name.trim(),
            kind: fields.kind,
            usageType: fields.usageType,
            planMode: normalizedMode,
            saleStartAt: schedule.saleStartAt,
            saleEndAt: schedule.saleEndAt,
            unitDays: fields.unitDays,
            periodCount: fields.periodCount,
            durationDays: fields.durationDays,
            requiresMemberContract: fields.requiresMemberContract,
            enableCardRecurring: fields.enableCardRecurring,
            recurringAmount: fields.recurringAmount,
            payuniPeriodHash: fields.payuniPeriodHash,
            payuniPeriodHashOnline: fields.payuniPeriodHashOnline,
            price: fields.price,
            bonusGiven: fields.bonusGiven,
            isActive: true,
          },
        });
        await syncPromotionContracts(tx, promo.id, {
          requiresMemberContract: fields.requiresMemberContract,
          contractIds,
        });
        const full = await tx.promotion.findUnique({
          where: { id: promo.id },
          include: promotionContractInclude,
        });
        created.push(full);
      }
      return created;
    });

    const sample = promotions[0];
    const detail =
      fields.kind === 'COMPENSATION'
        ? `客訴補償 · 運動金 $${fields.bonusGiven}（price $0，禁銷售通路）`
        : isUnlimitedPromotion(sample)
          ? `無限使用 ${fields.unitDays} 天×${fields.periodCount} 期＝${fields.durationDays} 天 · 方案費 $${fields.price}（不入錢包）`
          : `現金 $${fields.price} + 運動金 $${fields.bonusGiven}`;
    const branchNames = branches.map((b) => staffBranchLabel(b)).join('、');
    const mapped = promotions.map(withPromotionContracts);

    res.status(201).json({
      status: 'success',
      message: `方案 [${name.trim()}] 已上架至 ${promotions.length} 間分店（${branchNames}｜${detail}）`,
      data: mapped.length === 1 ? mapped[0] : mapped,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '方案建立失敗' });
  }
});

// GET /api/hq/promotions?branchId=&kind=SALE|COMPENSATION
router.get('/promotions', async (req, res) => {
  try {
    const where = {};
    if (req.query.branchId !== undefined) {
      where.branchId = parsePositiveInt(req.query.branchId, 'branchId');
    }
    if (req.query.kind !== undefined && String(req.query.kind).trim() !== '') {
      where.kind = normalizePromotionKind(req.query.kind);
    }

    const promotions = await prisma.promotion.findMany({
      where,
      include: promotionContractInclude,
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });
    res.json({
      status: 'success',
      data: promotions.map(withPromotionContracts),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取促銷方案失敗' });
  }
});

// PATCH /api/hq/promotions/:id
router.patch('/promotions/:id', async (req, res) => {
  const {
    name,
    price,
    bonusGiven,
    kind,
    type,
    isActive,
    usageType,
    planMode,
    saleStartAt,
    saleEndAt,
    durationDays,
    unitDays,
    periodCount,
    requiresMemberContract,
    enableCardRecurring,
    recurringAmount,
    payuniPeriodHash,
    payuniPeriodHashOnline,
    contractIds,
  } = req.body || {};
  const data = {};

  if (name !== undefined) data.name = String(name).trim();
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
    }
    data.isActive = isActive;
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const current = await prisma.promotion.findUnique({ where: { id } });
    if (!current) {
      return res.status(404).json({ status: 'error', message: '找不到此促銷方案' });
    }

    const kindInput = kind ?? type;
    const hasFieldUpdates =
      price !== undefined ||
      bonusGiven !== undefined ||
      kindInput !== undefined ||
      usageType !== undefined ||
      durationDays !== undefined ||
      unitDays !== undefined ||
      periodCount !== undefined ||
      requiresMemberContract !== undefined ||
      enableCardRecurring !== undefined ||
      recurringAmount !== undefined ||
      payuniPeriodHash !== undefined ||
      payuniPeriodHashOnline !== undefined;

    if (hasFieldUpdates) {
      const fields = resolvePromotionFields(
        {
          kind: kindInput ?? current.kind,
          usageType: usageType ?? current.usageType,
          price: price ?? current.price,
          bonusGiven: bonusGiven ?? current.bonusGiven,
          durationDays: durationDays !== undefined ? durationDays : current.durationDays,
          unitDays: unitDays !== undefined ? unitDays : current.unitDays,
          periodCount: periodCount !== undefined ? periodCount : current.periodCount,
          requiresMemberContract:
            requiresMemberContract !== undefined
              ? requiresMemberContract
              : current.requiresMemberContract,
          enableCardRecurring:
            enableCardRecurring !== undefined ? enableCardRecurring : current.enableCardRecurring,
          recurringAmount:
            recurringAmount !== undefined ? recurringAmount : current.recurringAmount,
          payuniPeriodHash:
            payuniPeriodHash !== undefined ? payuniPeriodHash : current.payuniPeriodHash,
          payuniPeriodHashOnline:
            payuniPeriodHashOnline !== undefined
              ? payuniPeriodHashOnline
              : current.payuniPeriodHashOnline,
        },
        { partial: true, current },
      );
      data.kind = fields.kind;
      data.usageType = fields.usageType;
      data.price = fields.price;
      data.bonusGiven = fields.bonusGiven;
      data.unitDays = fields.unitDays;
      data.periodCount = fields.periodCount;
      data.durationDays = fields.durationDays;
      data.requiresMemberContract = fields.requiresMemberContract;
      data.enableCardRecurring = fields.enableCardRecurring;
      data.recurringAmount = fields.recurringAmount;
      data.payuniPeriodHash = fields.payuniPeriodHash;
      data.payuniPeriodHashOnline = fields.payuniPeriodHashOnline;
    } else if (usageType !== undefined) {
      data.usageType = normalizeUsageType(usageType);
    }

    if (
      planMode !== undefined ||
      saleStartAt !== undefined ||
      saleEndAt !== undefined
    ) {
      const schedule = resolvePromotionSchedule({
        planMode: planMode ?? current.planMode,
        saleStartAt: saleStartAt !== undefined ? saleStartAt : current.saleStartAt,
        saleEndAt: saleEndAt !== undefined ? saleEndAt : current.saleEndAt,
      });
      data.planMode = normalizePlanMode(planMode ?? current.planMode);
      data.saleStartAt = schedule.saleStartAt;
      data.saleEndAt = schedule.saleEndAt;
    }

    const shouldSyncContracts =
      contractIds !== undefined || requiresMemberContract !== undefined;

    if (Object.keys(data).length === 0 && !shouldSyncContracts) {
      return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
    }

    const promotion = await prisma.$transaction(async (tx) => {
      let updated = current;
      if (Object.keys(data).length > 0) {
        updated = await tx.promotion.update({
          where: { id },
          data,
        });
      }

      if (shouldSyncContracts) {
        await syncPromotionContracts(tx, id, {
          requiresMemberContract: updated.requiresMemberContract,
          contractIds:
            contractIds !== undefined
              ? contractIds
              : (
                  await tx.promotionMembershipContract.findMany({
                    where: { promotionId: id },
                    select: { contractId: true },
                  })
                ).map((r) => r.contractId),
        });
      }

      return tx.promotion.findUnique({
        where: { id },
        include: promotionContractInclude,
      });
    });

    res.json({
      status: 'success',
      message: `方案 [${promotion.name}] 已更新`,
      data: withPromotionContracts(promotion),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此促銷方案' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新方案失敗' });
  }
});

// PATCH /api/hq/promotions/:id/status — 上下架（相容舊路由）
router.patch('/promotions/:id/status', async (req, res) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const promotion = await prisma.promotion.update({
      where: { id },
      data: { isActive },
    });
    res.json({
      status: 'success',
      message: `方案 [${promotion.name}] 已${isActive ? '上架' : '下架'}`,
      data: promotion,
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此促銷方案' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新方案狀態失敗' });
  }
});

// DELETE /api/hq/promotions/:id
// 有定期定額訂閱 → 軟刪（下架）；否則硬刪（合約連結 cascade）
router.delete('/promotions/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const promotion = await prisma.promotion.findUnique({
      where: { id },
      include: {
        _count: { select: { cardSubscriptions: true } },
      },
    });
    if (!promotion) {
      return res.status(404).json({ status: 'error', message: '找不到此促銷方案' });
    }

    if (promotion._count.cardSubscriptions > 0) {
      if (!promotion.isActive) {
        return res.status(409).json({
          status: 'error',
          message: `方案 [${promotion.name}] 已下架，且仍有定期定額訂閱，無法永久刪除`,
        });
      }
      const updated = await prisma.promotion.update({
        where: { id },
        data: { isActive: false },
      });
      return res.json({
        status: 'success',
        message: `方案 [${updated.name}] 已下架（保留訂閱紀錄，未永久刪除）`,
        data: { ...updated, softDeleted: true },
      });
    }

    await prisma.promotion.delete({ where: { id } });
    return res.json({
      status: 'success',
      message: `方案 [${promotion.name}] 已刪除`,
      data: { id, hardDeleted: true },
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此促銷方案' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({
        status: 'error',
        message: '方案仍有關聯資料，無法刪除；請改為下架',
      });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除方案失敗' });
  }
});

// ==========================================
// 課程方案 CoursePlan（客製化私教／團體課程）
// ==========================================
const coursePlanInclude = {
  branch: { select: { id: true, name: true, code: true } },
  contractLinks: {
    include: {
      contract: { select: { id: true, title: true, shortName: true, status: true } },
    },
  },
};

function withCoursePlanContracts(plan) {
  return {
    ...plan,
    contracts: mapCoursePlanContracts(plan),
    contractLinks: undefined,
  };
}

// POST /api/hq/course-plans
router.post('/course-plans', async (req, res) => {
  const {
    branchId,
    branchIds,
    name,
    kind,
    type,
    planType,
    planMode,
    saleStartAt,
    saleEndAt,
    price,
    sessions,
    capacity,
    description,
    enableCardRecurring,
    recurringPeriods,
    recurringAmount,
    recurringAmount4,
    recurringAmountFinal,
    payuniPeriodHash,
    payuniPeriodHashOnline,
    requiresMemberContract,
    enableSecondPerson,
    giftLabel,
    giftQty,
    contractIds,
  } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim() || price === undefined) {
    return res.status(400).json({
      status: 'error',
      message: '欄位不完整：需提供 name、price，以及 branchIds（或 branchId）',
    });
  }

  try {
    const rawIds = Array.isArray(branchIds)
      ? branchIds
      : branchId !== undefined
        ? [branchId]
        : [];
    if (rawIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: '請至少選擇一間分店（branchIds）',
      });
    }

    const uniqueBranchIds = [...new Set(rawIds.map((id) => parsePositiveInt(id, 'branchId')))];
    const branches = await prisma.branch.findMany({
      where: { id: { in: uniqueBranchIds }, isActive: true },
      select: { id: true, name: true, code: true },
    });
    if (branches.length !== uniqueBranchIds.length) {
      return res.status(404).json({
        status: 'error',
        message: '部分分店不存在或已停用，請確認 branchIds',
      });
    }

    const schedule = resolveCoursePlanSchedule({ planMode, saleStartAt, saleEndAt });
    const fields = resolveCoursePlanFields(
      {
        kind: kind ?? type,
        planType,
        price,
        sessions,
        capacity,
        description,
        enableCardRecurring,
        recurringPeriods,
        recurringAmount,
        recurringAmount4,
        recurringAmountFinal,
        payuniPeriodHash,
        payuniPeriodHashOnline,
        requiresMemberContract,
        enableSecondPerson,
        giftLabel,
        giftQty,
      },
      { partial: false },
    );
    const normalizedMode = normalizePlanMode(planMode);
    const parsedContractIds = fields.requiresMemberContract
      ? parseContractIds(contractIds ?? [])
      : [];

    const plans = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const bid of uniqueBranchIds) {
        const plan = await tx.coursePlan.create({
          data: {
            branchId: bid,
            name: name.trim(),
            kind: fields.kind,
            planType: fields.planType,
            planMode: normalizedMode,
            saleStartAt: schedule.saleStartAt,
            saleEndAt: schedule.saleEndAt,
            price: fields.price,
            sessions: fields.sessions,
            capacity: fields.capacity,
            description: fields.description,
            enableCardRecurring: fields.enableCardRecurring,
            recurringPeriods: fields.recurringPeriods,
            recurringAmount: fields.recurringAmount,
            recurringAmount4: fields.recurringAmount4,
            recurringAmountFinal: fields.recurringAmountFinal,
            payuniPeriodHash: fields.payuniPeriodHash,
            payuniPeriodHashOnline: fields.payuniPeriodHashOnline,
            requiresMemberContract: fields.requiresMemberContract,
            enableSecondPerson: fields.enableSecondPerson,
            giftLabel: fields.giftLabel,
            giftQty: fields.giftQty,
            isActive: true,
          },
        });
        await syncCoursePlanContracts(tx, plan.id, {
          requiresMemberContract: fields.requiresMemberContract,
          contractIds: parsedContractIds,
        });
        const full = await tx.coursePlan.findUnique({
          where: { id: plan.id },
          include: coursePlanInclude,
        });
        created.push(withCoursePlanContracts(full));
      }
      return created;
    });

    const typeLabel = fields.planType === 'GROUP' ? '團體課程' : '客製化私教';
    const branchNames = branches.map((b) => staffBranchLabel(b)).join('、');
    res.status(201).json({
      status: 'success',
      message: `課程方案 [${name.trim()}]（${typeLabel}）已上架至 ${plans.length} 間分店（${branchNames}）`,
      data: plans.length === 1 ? plans[0] : plans,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立課程方案失敗' });
  }
});

// GET /api/hq/course-plans?branchId=&kind=SALE|COMPENSATION
router.get('/course-plans', async (req, res) => {
  try {
    const where = {};
    if (req.query.branchId !== undefined) {
      where.branchId = parsePositiveInt(req.query.branchId, 'branchId');
    }
    if (req.query.kind !== undefined && String(req.query.kind).trim() !== '') {
      where.kind = normalizeCoursePlanKind(req.query.kind);
    }
    const plans = await prisma.coursePlan.findMany({
      where,
      include: coursePlanInclude,
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });
    res.json({
      status: 'success',
      data: plans.map(withCoursePlanContracts),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取課程方案失敗' });
  }
});

// PATCH /api/hq/course-plans/:id
router.patch('/course-plans/:id', async (req, res) => {
  const {
    name,
    kind,
    type,
    planType,
    planMode,
    saleStartAt,
    saleEndAt,
    price,
    sessions,
    capacity,
    description,
    enableCardRecurring,
    recurringPeriods,
    recurringAmount,
    recurringAmount4,
    recurringAmountFinal,
    payuniPeriodHash,
    payuniPeriodHashOnline,
    requiresMemberContract,
    enableSecondPerson,
    giftLabel,
    giftQty,
    contractIds,
    isActive,
  } = req.body || {};
  const data = {};

  if (name !== undefined) data.name = String(name).trim();
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
    }
    data.isActive = isActive;
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const current = await prisma.coursePlan.findUnique({
      where: { id },
      include: { contractLinks: { select: { contractId: true } } },
    });
    if (!current) {
      return res.status(404).json({ status: 'error', message: '找不到此課程方案' });
    }

    const kindInput = kind ?? type;
    const hasFieldUpdates =
      kindInput !== undefined ||
      planType !== undefined ||
      price !== undefined ||
      sessions !== undefined ||
      capacity !== undefined ||
      description !== undefined ||
      enableCardRecurring !== undefined ||
      recurringPeriods !== undefined ||
      recurringAmount !== undefined ||
      recurringAmount4 !== undefined ||
      recurringAmountFinal !== undefined ||
      payuniPeriodHash !== undefined ||
      payuniPeriodHashOnline !== undefined ||
      requiresMemberContract !== undefined ||
      enableSecondPerson !== undefined ||
      giftLabel !== undefined ||
      giftQty !== undefined;

    if (hasFieldUpdates) {
      const fields = resolveCoursePlanFields(
        {
          kind: kindInput ?? current.kind,
          planType: planType ?? current.planType,
          price: price ?? current.price,
          sessions: sessions !== undefined ? sessions : current.sessions,
          capacity: capacity !== undefined ? capacity : current.capacity,
          description: description !== undefined ? description : current.description,
          enableCardRecurring:
            enableCardRecurring !== undefined
              ? enableCardRecurring
              : current.enableCardRecurring,
          recurringPeriods:
            recurringPeriods !== undefined
              ? recurringPeriods
              : current.recurringPeriods,
          recurringAmount:
            recurringAmount !== undefined
              ? recurringAmount
              : current.recurringAmount,
          recurringAmount4:
            recurringAmount4 !== undefined
              ? recurringAmount4
              : current.recurringAmount4,
          recurringAmountFinal:
            recurringAmountFinal !== undefined
              ? recurringAmountFinal
              : current.recurringAmountFinal,
          payuniPeriodHash:
            payuniPeriodHash !== undefined
              ? payuniPeriodHash
              : current.payuniPeriodHash,
          payuniPeriodHashOnline:
            payuniPeriodHashOnline !== undefined
              ? payuniPeriodHashOnline
              : current.payuniPeriodHashOnline,
          requiresMemberContract:
            requiresMemberContract !== undefined
              ? requiresMemberContract
              : current.requiresMemberContract,
          enableSecondPerson:
            enableSecondPerson !== undefined
              ? enableSecondPerson
              : current.enableSecondPerson,
          giftLabel: giftLabel !== undefined ? giftLabel : current.giftLabel,
          giftQty: giftQty !== undefined ? giftQty : current.giftQty,
        },
        { partial: true, current },
      );
      data.kind = fields.kind;
      data.planType = fields.planType;
      data.price = fields.price;
      data.sessions = fields.sessions;
      data.capacity = fields.capacity;
      data.description = fields.description;
      data.enableCardRecurring = fields.enableCardRecurring;
      data.recurringPeriods = fields.recurringPeriods;
      data.recurringAmount = fields.recurringAmount;
      data.recurringAmount4 = fields.recurringAmount4;
      data.recurringAmountFinal = fields.recurringAmountFinal;
      data.payuniPeriodHash = fields.payuniPeriodHash;
      data.payuniPeriodHashOnline = fields.payuniPeriodHashOnline;
      data.requiresMemberContract = fields.requiresMemberContract;
      data.enableSecondPerson = fields.enableSecondPerson;
      data.giftLabel = fields.giftLabel;
      data.giftQty = fields.giftQty;
    } else if (planType !== undefined) {
      data.planType = normalizeCoursePlanType(planType);
    }

    if (planMode !== undefined || saleStartAt !== undefined || saleEndAt !== undefined) {
      const schedule = resolveCoursePlanSchedule({
        planMode: planMode ?? current.planMode,
        saleStartAt: saleStartAt !== undefined ? saleStartAt : current.saleStartAt,
        saleEndAt: saleEndAt !== undefined ? saleEndAt : current.saleEndAt,
      });
      data.planMode = normalizePlanMode(planMode ?? current.planMode);
      data.saleStartAt = schedule.saleStartAt;
      data.saleEndAt = schedule.saleEndAt;
    }

    const shouldSyncContracts =
      contractIds !== undefined || requiresMemberContract !== undefined;

    if (Object.keys(data).length === 0 && !shouldSyncContracts) {
      return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
    }

    const plan = await prisma.$transaction(async (tx) => {
      let updated = current;
      if (Object.keys(data).length) {
        updated = await tx.coursePlan.update({ where: { id }, data });
      }
      if (shouldSyncContracts) {
        const flag =
          data.requiresMemberContract !== undefined
            ? data.requiresMemberContract
            : updated.requiresMemberContract;
        const ids =
          contractIds !== undefined
            ? parseContractIds(contractIds)
            : current.contractLinks.map((l) => l.contractId);
        await syncCoursePlanContracts(tx, id, {
          requiresMemberContract: flag,
          contractIds: ids,
        });
      }
      return tx.coursePlan.findUnique({
        where: { id },
        include: coursePlanInclude,
      });
    });

    res.json({
      status: 'success',
      message: `課程方案 [${plan.name}] 已更新`,
      data: withCoursePlanContracts(plan),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此課程方案' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新課程方案失敗' });
  }
});

// DELETE /api/hq/course-plans/:id — 上架中改下架；已下架則硬刪（合約連結 cascade）
router.delete('/course-plans/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const plan = await prisma.coursePlan.findUnique({ where: { id } });
    if (!plan) {
      return res.status(404).json({ status: 'error', message: '找不到此課程方案' });
    }

    if (plan.isActive) {
      const updated = await prisma.coursePlan.update({
        where: { id },
        data: { isActive: false },
      });
      return res.json({
        status: 'success',
        message: `課程方案 [${updated.name}] 已下架（未永久刪除；再刪一次可永久移除）`,
        data: { ...updated, softDeleted: true },
      });
    }

    await prisma.coursePlan.delete({ where: { id } });
    return res.json({
      status: 'success',
      message: `課程方案 [${plan.name}] 已刪除`,
      data: { id, hardDeleted: true },
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此課程方案' });
    }
    if (error.code === 'P2003') {
      return res.status(409).json({
        status: 'error',
        message: '課程方案仍有關聯資料，無法刪除',
      });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除課程方案失敗' });
  }
});

// ==========================================
// 4b. 教練管理（總部）
// GET /api/hq/trainers
// POST /api/hq/trainers
// PATCH /api/hq/trainers/:id
// ==========================================
router.get('/trainers', async (req, res) => {
  try {
    const trainers = await prisma.trainer.findMany({
      include: {
        branches: {
          select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
        },
        staff: { select: { id: true, account: true, name: true, displayName: true, isActive: true } },
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: trainers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取教練列表失敗' });
  }
});

router.post('/trainers', async (req, res) => {
  const { name, phone, role, displayName } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ status: 'error', message: '請填寫教練姓名與電話' });
  }

  try {
    const trainer = await prisma.trainer.create({
      data: {
        name: String(name).trim(),
        displayName: normalizeDisplayName(displayName),
        phone: String(phone).trim(),
        role: role === 'MANAGER' ? 'MANAGER' : 'NORMAL',
        isActive: true,
      },
    });
    res.status(201).json({
      status: 'success',
      message: `教練 [${trainer.name}] 已建立`,
      data: trainer,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '該電話號碼已被註冊為教練' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '教練建立失敗' });
  }
});

router.patch('/trainers/:id', async (req, res) => {
  const { name, phone, role, isActive, staffId, displayName } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (displayName !== undefined) data.displayName = normalizeDisplayName(displayName);
  if (phone !== undefined) data.phone = String(phone).trim();
  if (role !== undefined) data.role = role === 'MANAGER' ? 'MANAGER' : 'NORMAL';
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
    }
    data.isActive = isActive;
  }

  let nextStaffId;
  if (staffId !== undefined) {
    if (staffId === null || staffId === '') {
      nextStaffId = null;
    } else {
      const parsed = parseInt(staffId, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({ status: 'error', message: 'staffId 無效' });
      }
      nextStaffId = parsed;
    }
    data.staffId = nextStaffId;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');

    if (nextStaffId !== undefined && nextStaffId !== null) {
      const staff = await prisma.staff.findUnique({
        where: { id: nextStaffId },
        select: { id: true, isActive: true, permissions: true, role: true },
      });
      if (!staff || !staff.isActive) {
        return res.status(400).json({ status: 'error', message: '找不到可綁定的員工帳號' });
      }
      const canTrainer =
        staff.role === 'ADMIN' ||
        (Array.isArray(staff.permissions) && staff.permissions.includes('trainer'));
      if (!canTrainer) {
        return res.status(400).json({
          status: 'error',
          message: '該員工需具備 trainer 模組權限（或為 ADMIN）才能綁定教練檔案',
        });
      }
    }

    const trainer = await prisma.$transaction(async (tx) => {
      if (nextStaffId !== undefined && nextStaffId !== null) {
        // 同一員工不可綁多位教練
        await tx.trainer.updateMany({
          where: { staffId: nextStaffId, NOT: { id } },
          data: { staffId: null },
        });
      }
      return tx.trainer.update({
        where: { id },
        data,
        include: {
          staff: { select: { id: true, account: true, name: true, displayName: true, isActive: true } },
          branches: {
            select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
          },
        },
      });
    });

    res.json({
      status: 'success',
      message:
        nextStaffId === undefined
          ? `教練 [${trainer.name}] 已更新`
          : nextStaffId
            ? `教練 [${trainer.name}] 已綁定員工帳號`
            : `教練 [${trainer.name}] 已解除員工綁定`,
      data: trainer,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({
        status: 'error',
        message: '電話或員工帳號綁定衝突（一人僅能綁一位教練）',
      });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此教練' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新教練失敗' });
  }
});

// ==========================================
// 4. 將教練指派給分店 (TrainerBranch)
// POST /api/hq/trainers/assign
// Body: { trainerId, role, branchIds: number[] }
// NORMAL → 須綁定「指定分店」（可多間）；MANAGER → 不限分店（branchIds 可空）
// ==========================================
router.post('/trainers/assign', async (req, res) => {
  const { trainerId, role, branchIds } = req.body;

  if (!trainerId || !role || !Array.isArray(branchIds)) {
    return res.status(400).json({
      status: 'error',
      message: '參數錯誤：必須提供 trainerId、role、branchIds（陣列）',
    });
  }

  if (role !== 'NORMAL' && role !== 'MANAGER') {
    return res.status(400).json({
      status: 'error',
      message: 'role 只能是 NORMAL（一般教練）或 MANAGER（主管教練）',
    });
  }

  try {
    const parsedTrainerId = parsePositiveInt(trainerId, 'trainerId');
    const uniqueBranchIds = [
      ...new Set(
        branchIds
          .filter((id) => id !== undefined && id !== null && id !== '')
          .map((id) => parsePositiveInt(id, 'branchId')),
      ),
    ];

    if (role === 'NORMAL' && uniqueBranchIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: '一般教練須至少指派一間指定分店',
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const trainer = await tx.trainer.findUnique({ where: { id: parsedTrainerId } });
      if (!trainer || !trainer.isActive) {
        httpError('找不到此教練或教練已停用', 404);
      }

      if (uniqueBranchIds.length > 0) {
        const branches = await tx.branch.findMany({
          where: { id: { in: uniqueBranchIds }, isActive: true },
        });
        if (branches.length !== uniqueBranchIds.length) {
          httpError('部分分店不存在或已停用，請確認 branchIds', 400);
        }
      }

      await tx.trainer.update({
        where: { id: parsedTrainerId },
        data: { role },
      });

      // 清空舊指派後重建（避免殘留幽靈權限）
      await tx.trainerBranch.deleteMany({ where: { trainerId: parsedTrainerId } });

      if (uniqueBranchIds.length > 0) {
        await tx.trainerBranch.createMany({
          data: uniqueBranchIds.map((branchId) => ({
            trainerId: parsedTrainerId,
            branchId,
          })),
        });
      }

      return tx.trainer.findUnique({
        where: { id: parsedTrainerId },
        select: {
          id: true,
          name: true,
          role: true,
          branches: {
            select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
          },
        },
      });
    });

    const scopeMsg =
      role === 'MANAGER' && result.branches.length === 0
        ? '主管教練（不限分店）'
        : `並指派 ${result.branches.length} 間分店`;

    res.json({
      status: 'success',
      message: `教練 [${result.name}] 已設為 ${role}，${scopeMsg}`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '權限指派失敗' });
  }
});

// ==========================================
// 5. 商品（進銷存 SKU，與 Promotion 分離）
// ==========================================

// POST /api/hq/products  Body: { branchId, sku, name, price, cost?, productKind?, safetyStock? }
router.post('/products', async (req, res) => {
  const { branchId, sku, name, price, cost, stockQty, productKind, safetyStock } = req.body || {};

  if (stockQty !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 禁止直接指定 stockQty，請走進貨 API',
    });
  }

  if (!sku || !name || price === undefined || branchId === undefined) {
    return res.status(400).json({
      status: 'error',
      message: '參數錯誤：必須提供 branchId、sku、name、price',
    });
  }

  const parsedPrice = Number(price);
  const parsedCost = cost === undefined || cost === null || cost === '' ? 0 : Number(cost);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ status: 'error', message: 'price 必須為非負數字' });
  }
  if (!Number.isFinite(parsedCost) || parsedCost < 0) {
    return res.status(400).json({ status: 'error', message: 'cost 必須為非負數字' });
  }

  try {
    const kind = normalizeProductKind(productKind);
    const parsedSafety = resolveSafetyStock(safetyStock, kind);
    const parsedBranchId = parsePositiveInt(branchId, 'branchId');
    const branch = await prisma.branch.findUnique({ where: { id: parsedBranchId } });
    if (!branch || !branch.isActive) {
      return res.status(404).json({ status: 'error', message: '分店不存在或已停用' });
    }

    const product = await prisma.product.create({
      data: {
        branchId: parsedBranchId,
        sku: String(sku).trim(),
        name: String(name).trim(),
        productKind: kind,
        price: parsedPrice,
        cost: parsedCost,
        stockQty: 0,
        safetyStock: parsedSafety,
        isActive: true,
      },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });

    const msg =
      kind === PRODUCT_KIND_SERVICE
        ? `服務類商品 [${product.name}] 已建立（不控管庫存）`
        : `商品 [${product.name}] 已建立（庫存 0，請進貨）`;

    res.status(201).json({
      status: 'success',
      message: msg,
      data: product,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '此分店 SKU 已存在' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立商品失敗' });
  }
});

// GET /api/hq/products?branchId=
router.get('/products', async (req, res) => {
  try {
    const where = {};
    if (req.query.branchId !== undefined) {
      where.branchId = parsePositiveInt(req.query.branchId, 'branchId');
    }
    const products = await prisma.product.findMany({
      where,
      include: { branch: { select: { id: true, name: true, code: true } } },
      orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
    });
    res.json({ status: 'success', data: products });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取商品失敗' });
  }
});

// PATCH /api/hq/products/:id — 禁改 stockQty
router.patch('/products/:id', async (req, res) => {
  const { name, price, cost, isActive, sku, stockQty, productKind, safetyStock, ...rest } =
    req.body || {};

  if (stockQty !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 禁止直接修改庫存，請走進貨／銷貨',
    });
  }
  if (Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 非法參數：${Object.keys(rest).join(', ')}`,
    });
  }

  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const current = await prisma.product.findUnique({ where: { id } });
    if (!current) {
      return res.status(404).json({ status: 'error', message: '找不到此商品' });
    }

    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (sku !== undefined) data.sku = String(sku).trim();
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ status: 'error', message: 'isActive 必須為 boolean' });
      }
      data.isActive = isActive;
    }
    if (price !== undefined) {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        return res.status(400).json({ status: 'error', message: 'price 必須為非負數字' });
      }
      data.price = parsedPrice;
    }
    if (cost !== undefined) {
      const parsedCost = Number(cost);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        return res.status(400).json({ status: 'error', message: 'cost 必須為非負數字' });
      }
      data.cost = parsedCost;
    }

    const nextKind =
      productKind !== undefined
        ? normalizeProductKind(productKind)
        : normalizeProductKind(current.productKind);
    if (productKind !== undefined) {
      data.productKind = nextKind;
    }

    if (safetyStock !== undefined || productKind !== undefined) {
      const safetyRaw =
        safetyStock !== undefined ? safetyStock : current.safetyStock;
      data.safetyStock = resolveSafetyStock(
        nextKind === PRODUCT_KIND_SERVICE ? null : safetyRaw,
        nextKind,
      );
    }

    if (nextKind === PRODUCT_KIND_SERVICE) {
      data.stockQty = 0;
      data.safetyStock = null;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
    }

    const product = await prisma.product.update({
      where: { id },
      data,
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    res.json({
      status: 'success',
      message: `商品 [${product.name}] 已更新`,
      data: product,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '此分店 SKU 已存在' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此商品' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新商品失敗' });
  }
});

// ==========================================
// 員工帳號管理（分店綁定 + 模組權限）
// GET /api/hq/staff
// POST /api/hq/staff
// PATCH /api/hq/staff/:id
// ==========================================
const staffSelect = {
  id: true,
  account: true,
  name: true,
  displayName: true,
  role: true,
  branchId: true,
  permissions: true,
  isActive: true,
  createdAt: true,
  branch: { select: { id: true, name: true, code: true } },
};

router.get('/staff', async (req, res) => {
  try {
    const staffList = await prisma.staff.findMany({
      select: staffSelect,
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });
    res.json({ status: 'success', data: staffList });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取員工列表失敗' });
  }
});

router.post('/staff', async (req, res) => {
  const { account, password, name, role, branchId, permissions, displayName } = req.body || {};

  if (!account || !password || !name) {
    return res.status(400).json({ status: 'error', message: '帳號、密碼與姓名皆為必填' });
  }

  const validated = validateStaffCreateInput({ role, branchId, permissions });
  if (validated.errors.length > 0) {
    return res.status(400).json({ status: 'error', message: validated.errors.join('；') });
  }

  try {
    const existing = await prisma.staff.findUnique({ where: { account: String(account).trim() } });
    if (existing) {
      return res.status(400).json({ status: 'error', message: '此帳號已被使用' });
    }

    if (validated.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: validated.branchId, isActive: true },
      });
      if (!branch) {
        return res.status(400).json({ status: 'error', message: '分店不存在或已停用' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const created = await prisma.staff.create({
      data: {
        account: String(account).trim(),
        password: hashedPassword,
        name: String(name).trim(),
        displayName: normalizeDisplayName(displayName),
        role: validated.role,
        branchId: validated.branchId,
        permissions: validated.permissions,
        isActive: true,
      },
      select: staffSelect,
    });

    res.status(201).json({
      status: 'success',
      message: `員工 [${created.name}] 已建立`,
      data: created,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立員工失敗' });
  }
});

router.patch('/staff/:id', async (req, res) => {
  const staffId = parseInt(req.params.id, 10);
  if (!Number.isInteger(staffId)) {
    return res.status(400).json({ status: 'error', message: '無效的員工 ID' });
  }

  const { name, role, branchId, permissions, isActive, password, displayName } = req.body || {};

  try {
    const data = {};

    if (name !== undefined) data.name = String(name).trim();
    if (displayName !== undefined) data.displayName = normalizeDisplayName(displayName);
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (password) data.password = await bcrypt.hash(password, 10);

    if (role !== undefined || branchId !== undefined || permissions !== undefined) {
      const current = await prisma.staff.findUnique({ where: { id: staffId } });
      if (!current) {
        return res.status(404).json({ status: 'error', message: '找不到此員工' });
      }

      const validated = validateStaffCreateInput({
        role: role ?? current.role,
        branchId: branchId !== undefined ? branchId : current.branchId,
        permissions: permissions ?? current.permissions,
      });

      if (validated.errors.length > 0) {
        return res.status(400).json({ status: 'error', message: validated.errors.join('；') });
      }

      data.role = validated.role;
      data.branchId = validated.branchId;
      data.permissions = validated.permissions;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
    }

    if (data.branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: data.branchId, isActive: true },
      });
      if (!branch) {
        return res.status(400).json({ status: 'error', message: '分店不存在或已停用' });
      }
    }

    const updated = await prisma.staff.update({
      where: { id: staffId },
      data,
      select: staffSelect,
    });

    res.json({
      status: 'success',
      message: `員工 [${updated.name}] 已更新`,
      data: updated,
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此員工' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新員工失敗' });
  }
});

// 供前端權限勾選用
router.get('/staff/permissions', async (_req, res) => {
  res.json({
    status: 'success',
    data: STAFF_PERMISSIONS.map((key) => ({
      key,
      label: key === 'ops' ? '櫃檯維運' : key === 'pt' ? '團課管理' : '教練工作區',
    })),
  });
});

// ==========================================
// 進出場閘機裝置（綁定分店）
// ==========================================
router.get('/gate-devices', async (req, res) => {
  try {
    const branchId =
      req.query.branchId !== undefined && req.query.branchId !== ''
        ? parsePositiveInt(req.query.branchId, 'branchId')
        : null;
    const rows = await prisma.gateDevice.findMany({
      where: branchId ? { branchId } : undefined,
      include: { branch: { select: { id: true, name: true, code: true } } },
      orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
    });
    res.json({
      status: 'success',
      data: rows.map((r) => serializeGateDevice(r)),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取閘機裝置失敗' });
  }
});

router.post('/gate-devices', async (req, res) => {
  try {
    const code = normalizeDeviceCode(req.body?.code);
    const name = String(req.body?.name || '').trim();
    const branchId = parsePositiveInt(req.body?.branchId, 'branchId');
    if (!code) httpError('請提供裝置代碼 code', 400);
    if (!name) httpError('請提供裝置名稱 name', 400);

    const branch = await prisma.branch.findFirst({
      where: { id: branchId, isActive: true },
      select: { id: true, name: true, code: true },
    });
    if (!branch) httpError('分店不存在或已停用', 404);

    const plainKey = generateDeviceKey();
    const created = await prisma.gateDevice.create({
      data: {
        code,
        name,
        branchId,
        keyHash: hashDeviceKey(plainKey),
        keyPrefix: plainKey.slice(0, 6),
        isActive: true,
      },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });

    res.status(201).json({
      status: 'success',
      message: `閘機裝置 [${created.code}] 已建立，請立即複製裝置金鑰`,
      data: serializeGateDevice(created, { includePlainKey: plainKey }),
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '裝置代碼已存在' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立閘機裝置失敗' });
  }
});

router.patch('/gate-devices/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const data = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) httpError('名稱不可為空', 400);
      data.name = name;
    }
    if (req.body?.isActive !== undefined) {
      data.isActive = Boolean(req.body.isActive);
    }
    if (req.body?.branchId !== undefined) {
      const branchId = parsePositiveInt(req.body.branchId, 'branchId');
      const branch = await prisma.branch.findFirst({
        where: { id: branchId, isActive: true },
        select: { id: true },
      });
      if (!branch) httpError('分店不存在或已停用', 404);
      data.branchId = branchId;
    }
    if (req.body?.code !== undefined) {
      const code = normalizeDeviceCode(req.body.code);
      if (!code) httpError('裝置代碼無效', 400);
      data.code = code;
    }
    if (Object.keys(data).length === 0) {
      httpError('沒有可更新的欄位', 400);
    }

    const updated = await prisma.gateDevice.update({
      where: { id },
      data,
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    res.json({
      status: 'success',
      message: `閘機裝置 [${updated.code}] 已更新`,
      data: serializeGateDevice(updated),
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ status: 'error', message: '裝置代碼已存在' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此裝置' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新閘機裝置失敗' });
  }
});

router.post('/gate-devices/:id/rotate-key', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, 'id');
    const plainKey = generateDeviceKey();
    const updated = await prisma.gateDevice.update({
      where: { id },
      data: {
        keyHash: hashDeviceKey(plainKey),
        keyPrefix: plainKey.slice(0, 6),
      },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    res.json({
      status: 'success',
      message: `裝置 [${updated.code}] 金鑰已輪替，請立即複製並更新閘機配對`,
      data: serializeGateDevice(updated, { includePlainKey: plainKey }),
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到此裝置' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '輪替金鑰失敗' });
  }
});

// ==========================================
// 合規補償（ADMIN）：運動金／效期／解鎖警示
// ==========================================

// GET /api/hq/members/search?q= 手機或會員編號
router.get('/members/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({ status: 'error', message: '請輸入至少 2 字（手機或會員編號）' });
    }
    const phone = normalizePhone(q);
    const members = await prisma.member.findMany({
      where: {
        OR: [
          { memberNo: { equals: q.toUpperCase(), mode: 'insensitive' } },
          ...(phone ? [{ phone }] : []),
          { phone: { contains: q } },
          { name: { contains: q } },
        ],
      },
      take: 20,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        memberNo: true,
        name: true,
        phone: true,
        plan: true,
        expireDate: true,
        cashWallet: true,
        bonusWallet: true,
        isAlert: true,
      },
    });
    res.json({ status: 'success', data: members });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '搜尋會員失敗' });
  }
});

// GET /api/hq/compensation-logs?memberId=&action=&limit=
router.get('/compensation-logs', async (req, res) => {
  try {
    const logs = await listHqCompensationLogs({
      memberId: req.query.memberId,
      action: req.query.action,
      limit: req.query.limit,
    });
    res.json({
      status: 'success',
      data: logs,
      meta: { actions: HQ_COMPENSATION_ACTIONS },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取補償日誌失敗' });
  }
});

/**
 * 補償運動金：僅 promotionId（kind=COMPENSATION）+ reason
 * 禁止 amount／bonusAmount 等自由金額欄位
 */
router.post('/members/:id/compensate-bonus', async (req, res) => {
  try {
    const result = await grantCompensationBonus({
      memberId: req.params.id,
      promotionId: req.body?.promotionId,
      reason: req.body?.reason,
      actorStaffId: req.user?.staffId ?? req.user?.id,
      req,
      body: req.body || {},
    });
    res.json({
      status: 'success',
      message: `已配發運動金 $${result.bonusAdded}（專案：${result.promotion.name}）`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '補償運動金失敗' });
  }
});

/** 補償效期：展延 expireDate + reason；寫入異動日誌 */
router.post('/members/:id/compensate-expire', async (req, res) => {
  try {
    const result = await grantCompensationExpire({
      memberId: req.params.id,
      days: req.body?.days,
      reason: req.body?.reason,
      actorStaffId: req.user?.staffId ?? req.user?.id,
      req,
    });
    res.json({
      status: 'success',
      message: `已補償效期 ${result.days} 天`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '補償效期失敗' });
  }
});

/** 解鎖帳號：isAlert=false + reason */
router.post('/members/:id/clear-alert', async (req, res) => {
  try {
    const result = await clearMemberAlert({
      memberId: req.params.id,
      reason: req.body?.reason,
      actorStaffId: req.user?.staffId ?? req.user?.id,
      req,
    });
    res.json({
      status: 'success',
      message: result.alreadyCleared ? '帳號本來就未警示' : '已解除警示，動態 QR 可重新生效',
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '解鎖帳號失敗' });
  }
});

/**
 * 補償課程：僅 coursePlanId（kind=COMPENSATION）+ trainerId + reason
 * 建立 source=COMPENSATION 的 PTContract，與付費購案區隔
 */
router.post('/members/:id/compensate-course', async (req, res) => {
  try {
    const result = await grantCompensationCourse({
      memberId: req.params.id,
      coursePlanId: req.body?.coursePlanId,
      trainerId: req.body?.trainerId,
      reason: req.body?.reason,
      actorStaffId: req.user?.staffId ?? req.user?.id,
      req,
      body: req.body || {},
    });
    res.json({
      status: 'success',
      message: `已補償贈送 ${result.sessions} 堂（${result.coursePlan.name}｜合約#${result.contract.id}）`,
      data: result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '補償課程失敗' });
  }
});

export default router;
