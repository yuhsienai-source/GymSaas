// routes/marketing.js — 總部行銷 CRM（ADMIN）
import express from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import { pushLineText } from '../lib/lineNotify.js';

const router = express.Router();

router.use(verifyStaff, requireAdmin);

const SEGMENTS = [
  'DORMANT_BALANCE',
  'DORMANT_VISIT',
  'NO_RENEW',
  'UNUSED_SESSIONS',
  'POST_CONSULT',
];

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function readId(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function memberBrief(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    lineId: row.lineId || null,
    cashWallet: row.cashWallet,
    bonusWallet: row.bonusWallet,
  };
}

async function querySegmentMembers(segment) {
  const s = String(segment || '').trim().toUpperCase();
  if (!SEGMENTS.includes(s)) {
    const err = new Error(`segment 僅允許：${SEGMENTS.join('、')}`);
    err.statusCode = 400;
    throw err;
  }

  if (s === 'DORMANT_BALANCE') {
    const cutoff = daysAgo(30);
    const rows = await prisma.member.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        lineId: true,
        cashWallet: true,
        bonusWallet: true,
        checkInLogs: { orderBy: { checkInAt: 'desc' }, take: 1, select: { checkInAt: true } },
      },
    });
    return rows
      .filter((m) => m.cashWallet + m.bonusWallet > 1000)
      .filter((m) => !m.checkInLogs[0] || m.checkInLogs[0].checkInAt < cutoff)
      .map(memberBrief);
  }

  if (s === 'DORMANT_VISIT') {
    const cutoff = daysAgo(60);
    const rows = await prisma.member.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        lineId: true,
        cashWallet: true,
        bonusWallet: true,
        checkInLogs: { orderBy: { checkInAt: 'desc' }, take: 1, select: { checkInAt: true } },
      },
    });
    return rows
      .filter((m) => !m.checkInLogs[0] || m.checkInLogs[0].checkInAt < cutoff)
      .map(memberBrief);
  }

  if (s === 'NO_RENEW') {
    const now = new Date();
    const expired = await prisma.pTContract.findMany({
      where: {
        expiresAt: { lt: now },
        isActive: true,
      },
      include: {
        member: {
          select: {
            id: true,
            name: true,
            phone: true,
            lineId: true,
            cashWallet: true,
            bonusWallet: true,
          },
        },
      },
    });
    const seen = new Set();
    const out = [];
    for (const c of expired) {
      if (!c.member || seen.has(c.member.id)) continue;
      const newer = await prisma.pTContract.findFirst({
        where: {
          memberId: c.memberId,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
          createdAt: { gt: c.createdAt },
        },
      });
      if (newer) continue;
      seen.add(c.member.id);
      out.push(memberBrief(c.member));
    }
    return out;
  }

  if (s === 'UNUSED_SESSIONS') {
    const contracts = await prisma.pTContract.findMany({
      where: { isActive: true },
      include: {
        member: {
          select: {
            id: true,
            name: true,
            phone: true,
            lineId: true,
            cashWallet: true,
            bonusWallet: true,
          },
        },
      },
    });
    const seen = new Set();
    const out = [];
    for (const c of contracts) {
      if (c.usedSessions >= c.totalSessions || !c.member || seen.has(c.member.id)) continue;
      seen.add(c.member.id);
      out.push({
        ...memberBrief(c.member),
        ptContractId: c.id,
        usedSessions: c.usedSessions,
        totalSessions: c.totalSessions,
      });
    }
    return out;
  }

  // POST_CONSULT — 諮詢客人尚未轉正式會員／購課
  const guests = await prisma.consultGuest.findMany({
    where: { isActive: true, memberId: null },
    include: {
      trainer: { select: { id: true, displayName: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return guests.map((g) => ({
    consultGuestId: g.id,
    name: g.name,
    phone: g.phone,
    note: g.note,
    trainerId: g.trainerId,
    trainerName: g.trainer?.displayName || g.trainer?.name || null,
    createdAt: g.createdAt,
  }));
}

function giftCardCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function inBodyCode() {
  return `IB${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

// GET /api/hq/marketing/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const items = await prisma.marketingCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { pushLogs: true } } },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取行銷活動失敗' });
  }
});

// POST /api/hq/marketing/campaigns
router.post('/campaigns', async (req, res) => {
  const { name, segment, message, scheduledAt, status } = req.body || {};
  const n = String(name || '').trim();
  const seg = String(segment || '').trim().toUpperCase();
  const msg = String(message || '').trim();
  if (!n || !seg || !msg) {
    return res.status(400).json({ status: 'error', message: 'name、segment、message 為必填' });
  }
  if (!SEGMENTS.includes(seg)) {
    return res.status(400).json({ status: 'error', message: `segment 僅允許：${SEGMENTS.join('、')}` });
  }

  try {
    const row = await prisma.marketingCampaign.create({
      data: {
        name: n,
        segment: seg,
        message: msg,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        status: status ? String(status).trim() : 'DRAFT',
      },
    });
    res.status(201).json({ status: 'success', message: '行銷活動已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立行銷活動失敗' });
  }
});

// PATCH /api/hq/marketing/campaigns/:id
router.patch('/campaigns/:id', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的活動 ID' });
  }
  const patch = {};
  for (const key of ['name', 'segment', 'message', 'status']) {
    if (req.body?.[key] !== undefined) {
      patch[key] = key === 'segment' ? String(req.body[key]).trim().toUpperCase() : String(req.body[key]).trim();
    }
  }
  if (req.body?.scheduledAt !== undefined) {
    patch.scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
  }
  if (patch.segment && !SEGMENTS.includes(patch.segment)) {
    return res.status(400).json({ status: 'error', message: `segment 僅允許：${SEGMENTS.join('、')}` });
  }

  try {
    const row = await prisma.marketingCampaign.update({ where: { id }, data: patch });
    res.json({ status: 'success', message: '行銷活動已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到行銷活動' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新行銷活動失敗' });
  }
});

// POST /api/hq/marketing/campaigns/:id/send
router.post('/campaigns/:id/send', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的活動 ID' });
  }

  try {
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id } });
    if (!campaign) {
      return res.status(404).json({ status: 'error', message: '找不到行銷活動' });
    }

    const targets = await querySegmentMembers(campaign.segment);
    const memberTargets = targets.filter((t) => t.id != null);

    const logs = [];
    for (const t of memberTargets) {
      const push = await pushLineText(t.lineId, campaign.message);
      const status = push.ok ? 'SENT' : push.skipped ? 'MOCK' : 'FAILED';
      const log = await prisma.pushCampaignLog.create({
        data: {
          campaignId: id,
          memberId: t.id,
          channel: 'LINE',
          status,
        },
      });
      logs.push({ logId: log.id, memberId: t.id, push });
    }

    const updated = await prisma.marketingCampaign.update({
      where: { id },
      data: { sentAt: new Date(), status: 'SENT' },
    });

    res.json({
      status: 'success',
      message: `已推播 ${logs.length} 位會員（非會員諮詢名單不推播）`,
      data: {
        campaign: updated,
        targetCount: targets.length,
        sentCount: logs.length,
        logs,
      },
    });
  } catch (error) {
    const code = error.statusCode || 500;
    console.error(error);
    res.status(code).json({
      status: 'error',
      message: error.message || '推播失敗',
    });
  }
});

// GET /api/hq/marketing/dormant-lists?segment=
router.get('/dormant-lists', async (req, res) => {
  try {
    const items = await querySegmentMembers(req.query.segment);
    res.json({
      status: 'success',
      data: { segment: String(req.query.segment || '').trim().toUpperCase(), count: items.length, items },
    });
  } catch (error) {
    const code = error.statusCode || 500;
    console.error(error);
    res.status(code).json({ status: 'error', message: error.message || '查詢名單失敗' });
  }
});

// GET /api/hq/marketing/referral-offers
router.get('/referral-offers', async (req, res) => {
  try {
    const items = await prisma.referralOffer.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取推薦優惠失敗' });
  }
});

// POST /api/hq/marketing/referral-offers
router.post('/referral-offers', async (req, res) => {
  const { name, discountPct, discountAmt, referrerBonus, isActive } = req.body || {};
  const n = String(name || '').trim();
  if (!n) {
    return res.status(400).json({ status: 'error', message: 'name 為必填' });
  }

  try {
    const row = await prisma.referralOffer.create({
      data: {
        name: n,
        discountPct: discountPct != null ? Number(discountPct) : null,
        discountAmt: discountAmt != null ? Number(discountAmt) : null,
        referrerBonus: referrerBonus != null ? Number(referrerBonus) : null,
        isActive: isActive !== false,
      },
    });
    res.status(201).json({ status: 'success', message: '推薦優惠已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立推薦優惠失敗' });
  }
});

// PATCH /api/hq/marketing/referral-offers/:id
router.patch('/referral-offers/:id', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的推薦優惠 ID' });
  }
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body?.discountPct !== undefined) patch.discountPct = req.body.discountPct == null ? null : Number(req.body.discountPct);
  if (req.body?.discountAmt !== undefined) patch.discountAmt = req.body.discountAmt == null ? null : Number(req.body.discountAmt);
  if (req.body?.referrerBonus !== undefined) patch.referrerBonus = req.body.referrerBonus == null ? null : Number(req.body.referrerBonus);
  if (req.body?.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

  try {
    const row = await prisma.referralOffer.update({ where: { id }, data: patch });
    res.json({ status: 'success', message: '推薦優惠已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到推薦優惠' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新推薦優惠失敗' });
  }
});

// GET /api/hq/marketing/addon-offers
router.get('/addon-offers', async (req, res) => {
  try {
    const items = await prisma.addOnOffer.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取加價購失敗' });
  }
});

// POST /api/hq/marketing/addon-offers
router.post('/addon-offers', async (req, res) => {
  const { name, productId, price, minCartAmt, isActive } = req.body || {};
  const n = String(name || '').trim();
  const p = Number(price);
  if (!n || !Number.isFinite(p) || p < 0) {
    return res.status(400).json({ status: 'error', message: 'name 與有效 price 為必填' });
  }

  try {
    const row = await prisma.addOnOffer.create({
      data: {
        name: n,
        productId: productId != null ? parseInt(productId, 10) : null,
        price: p,
        minCartAmt: minCartAmt != null ? Number(minCartAmt) : null,
        isActive: isActive !== false,
      },
    });
    res.status(201).json({ status: 'success', message: '加價購已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立加價購失敗' });
  }
});

// PATCH /api/hq/marketing/addon-offers/:id
router.patch('/addon-offers/:id', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的加價購 ID' });
  }
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body?.productId !== undefined) {
    patch.productId = req.body.productId == null ? null : parseInt(req.body.productId, 10);
  }
  if (req.body?.price !== undefined) patch.price = Number(req.body.price);
  if (req.body?.minCartAmt !== undefined) {
    patch.minCartAmt = req.body.minCartAmt == null ? null : Number(req.body.minCartAmt);
  }
  if (req.body?.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

  try {
    const row = await prisma.addOnOffer.update({ where: { id }, data: patch });
    res.json({ status: 'success', message: '加價購已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到加價購' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新加價購失敗' });
  }
});

// GET /api/hq/marketing/lottery-pools
router.get('/lottery-pools', async (req, res) => {
  try {
    const items = await prisma.lotteryPool.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { entries: true } } },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取抽獎池失敗' });
  }
});

// POST /api/hq/marketing/lottery-pools
router.post('/lottery-pools', async (req, res) => {
  const { name, drawAt, status } = req.body || {};
  const n = String(name || '').trim();
  if (!n) {
    return res.status(400).json({ status: 'error', message: 'name 為必填' });
  }

  try {
    const row = await prisma.lotteryPool.create({
      data: {
        name: n,
        drawAt: drawAt ? new Date(drawAt) : null,
        status: status ? String(status).trim() : 'OPEN',
      },
    });
    res.status(201).json({ status: 'success', message: '抽獎池已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立抽獎池失敗' });
  }
});

// POST /api/hq/marketing/lottery-pools/:id/draw
router.post('/lottery-pools/:id/draw', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的抽獎池 ID' });
  }

  try {
    const pool = await prisma.lotteryPool.findUnique({
      where: { id },
      include: {
        entries: {
          include: { member: { select: { id: true, name: true, phone: true } } },
        },
      },
    });
    if (!pool) {
      return res.status(404).json({ status: 'error', message: '找不到抽獎池' });
    }
    if (pool.entries.length === 0) {
      return res.status(400).json({ status: 'error', message: '尚無抽獎名額' });
    }

    const winner = pool.entries[Math.floor(Math.random() * pool.entries.length)];
    const updated = await prisma.lotteryPool.update({
      where: { id },
      data: { status: 'DRAWN', drawAt: pool.drawAt || new Date() },
    });

    res.json({
      status: 'success',
      message: '抽獎完成',
      data: {
        pool: updated,
        winner: {
          entryId: winner.id,
          memberId: winner.memberId,
          memberName: winner.member?.name || null,
          memberPhone: winner.member?.phone || null,
        },
      },
    });
  } catch (error) {
    const code = error.statusCode || 500;
    console.error(error);
    res.status(code).json({ status: 'error', message: error.message || '抽獎失敗' });
  }
});

// GET /api/hq/marketing/family-cards
router.get('/family-cards', async (req, res) => {
  try {
    const items = await prisma.familyCard.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          include: { member: { select: { id: true, name: true, phone: true } } },
        },
      },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取家庭卡失敗' });
  }
});

// POST /api/hq/marketing/family-cards
router.post('/family-cards', async (req, res) => {
  const { name, ownerId, promotionId, maxMembers, isActive } = req.body || {};
  const n = String(name || '').trim();
  const owner = parseInt(ownerId, 10);
  if (!n || !Number.isInteger(owner) || owner <= 0) {
    return res.status(400).json({ status: 'error', message: 'name 與 ownerId 為必填' });
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const card = await tx.familyCard.create({
        data: {
          name: n,
          ownerId: owner,
          promotionId: promotionId != null ? parseInt(promotionId, 10) : null,
          maxMembers: maxMembers != null ? parseInt(maxMembers, 10) || 4 : 4,
          isActive: isActive !== false,
        },
      });
      await tx.familyCardMember.create({
        data: { familyCardId: card.id, memberId: owner },
      });
      return card;
    });
    res.status(201).json({ status: 'success', message: '家庭卡已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立家庭卡失敗' });
  }
});

// POST /api/hq/marketing/family-cards/:id/members — { memberId }
router.post('/family-cards/:id/members', async (req, res) => {
  const id = readId(req.params.id);
  if (id == null) {
    return res.status(400).json({ status: 'error', message: '無效的家庭卡 ID' });
  }
  const memberId = parseInt(req.body?.memberId, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ status: 'error', message: 'memberId 為必填' });
  }

  try {
    const card = await prisma.familyCard.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    if (!card || !card.isActive) {
      return res.status(404).json({ status: 'error', message: '找不到有效家庭卡' });
    }
    if (card._count.members >= card.maxMembers) {
      return res.status(400).json({ status: 'error', message: '家庭卡成員已達上限' });
    }

    const row = await prisma.familyCardMember.create({
      data: { familyCardId: id, memberId },
    });
    res.status(201).json({ status: 'success', message: '已加入家庭卡成員', data: row });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ status: 'error', message: '該會員已在家庭卡中' });
    }
    const code = error.statusCode || 500;
    console.error(error);
    res.status(code).json({ status: 'error', message: error.message || '加入成員失敗' });
  }
});

// POST /api/hq/marketing/gift-cards/issue — { amount, purchaserId? }
router.post('/gift-cards/issue', async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ status: 'error', message: 'amount 須為正數' });
  }
  const purchaserId =
    req.body?.purchaserId != null ? parseInt(req.body.purchaserId, 10) : null;
  if (purchaserId != null && (!Number.isInteger(purchaserId) || purchaserId <= 0)) {
    return res.status(400).json({ status: 'error', message: 'purchaserId 無效' });
  }

  try {
    const id = `GFC${Date.now()}`;
    let code = giftCardCode();
    for (let i = 0; i < 5; i += 1) {
      try {
        const row = await prisma.giftCard.create({
          data: {
            id,
            amount,
            code,
            purchaserId,
            status: 'ACTIVE',
          },
        });
        return res.status(201).json({
          status: 'success',
          message: '禮物卡已發行',
          data: row,
        });
      } catch (err) {
        if (err.code === 'P2002') {
          code = giftCardCode();
          continue;
        }
        throw err;
      }
    }
    res.status(500).json({ status: 'error', message: '無法產生唯一兌換碼' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '發行禮物卡失敗' });
  }
});

// POST /api/hq/marketing/inbody-vouchers/grant — { memberId, qty? }
router.post('/inbody-vouchers/grant', async (req, res) => {
  const memberId = parseInt(req.body?.memberId, 10);
  const qty = req.body?.qty != null ? parseInt(req.body.qty, 10) : 1;
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ status: 'error', message: 'memberId 為必填' });
  }
  if (!Number.isInteger(qty) || qty <= 0 || qty > 20) {
    return res.status(400).json({ status: 'error', message: 'qty 須為 1–20' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到會員' });
    }

    const rows = [];
    for (let i = 0; i < qty; i += 1) {
      let code = inBodyCode();
      for (let j = 0; j < 5; j += 1) {
        try {
          const row = await prisma.inBodyVoucher.create({
            data: { memberId, code, status: 'ACTIVE' },
          });
          rows.push(row);
          break;
        } catch (err) {
          if (err.code === 'P2002') {
            code = inBodyCode();
            continue;
          }
          throw err;
        }
      }
    }

    res.status(201).json({
      status: 'success',
      message: `已贈送 ${rows.length} 張 InBody 兌換券`,
      data: rows,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '贈送 InBody 兌換券失敗' });
  }
});

export default router;
