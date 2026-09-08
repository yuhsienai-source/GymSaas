// routes/cms.js — 公開內容（公告／FAQ／場館／教練）＋總部 CMS 管理
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import { notifyStaffInbox } from '../lib/mailer.js';
import { resolveDisplayName } from '../lib/displayName.js';

const router = express.Router();

const adminGuard = [verifyStaff, requireAdmin];

const BRANCH_PUBLIC_SELECT = {
  id: true,
  name: true,
  code: true,
  address: true,
  introText: true,
  introImages: true,
  introVideos: true,
  showOccupancy: true,
};

function parseOptionalBranchId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function activeAnnouncementWhere(branchId) {
  const now = new Date();
  const timeFilter = {
    isActive: true,
    publishedAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
  if (branchId) {
    return {
      AND: [timeFilter, { OR: [{ branchId: null }, { branchId }] }],
    };
  }
  return timeFilter;
}

function activeFaqWhere(branchId) {
  const base = { isActive: true };
  if (branchId) {
    return {
      isActive: true,
      OR: [{ branchId: null }, { branchId }],
    };
  }
  return base;
}

function serializeTrainer(row) {
  return {
    id: row.id,
    displayName: resolveDisplayName(row),
    bio: row.bio || null,
    photoUrl: row.photoUrl || null,
    branches: (row.branches || []).map((b) => ({
      branchId: b.branchId,
      name: b.branch?.name || null,
      code: b.branch?.code || null,
    })),
  };
}

// ==========================================
// 公開唯讀
// ==========================================

// GET /api/cms/announcements?branchId=
router.get('/announcements', async (req, res) => {
  try {
    const branchId = parseOptionalBranchId(req.query.branchId);
    const items = await prisma.announcement.findMany({
      where: activeAnnouncementWhere(branchId),
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取公告失敗' });
  }
});

// GET /api/cms/faq?branchId=
router.get('/faq', async (req, res) => {
  try {
    const branchId = parseOptionalBranchId(req.query.branchId);
    const items = await prisma.faqItem.findMany({
      where: activeFaqWhere(branchId),
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取 FAQ 失敗' });
  }
});

// GET /api/cms/branches
router.get('/branches', async (req, res) => {
  try {
    const items = await prisma.branch.findMany({
      where: { isActive: true },
      select: BRANCH_PUBLIC_SELECT,
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取場館列表失敗' });
  }
});

// GET /api/cms/branches/:id
router.get('/branches/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: '無效的分店 ID' });
    }
    const branch = await prisma.branch.findFirst({
      where: { id, isActive: true },
      select: BRANCH_PUBLIC_SELECT,
    });
    if (!branch) {
      return res.status(404).json({ status: 'error', message: '找不到場館' });
    }
    res.json({ status: 'success', data: branch });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取場館詳情失敗' });
  }
});

// GET /api/cms/trainers?branchId=
router.get('/trainers', async (req, res) => {
  try {
    const branchId = parseOptionalBranchId(req.query.branchId);
    const where = { isActive: true };
    if (branchId) {
      where.branches = { some: { branchId } };
    }
    const rows = await prisma.trainer.findMany({
      where,
      include: {
        branches: {
          include: { branch: { select: { id: true, name: true, code: true } } },
        },
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: rows.map(serializeTrainer) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取教練列表失敗' });
  }
});

// POST /api/cms/contact — { name, email?, phone?, message }
router.post('/contact', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = req.body?.email != null ? String(req.body.email).trim() || null : null;
  const phone = req.body?.phone != null ? String(req.body.phone).trim() || null : null;
  const message = String(req.body?.message || '').trim();

  if (!name || !message) {
    return res.status(400).json({ status: 'error', message: '請填寫姓名與留言內容' });
  }

  try {
    const row = await prisma.contactMessage.create({
      data: { name, email, phone, message },
    });

    const html = [
      `<p><strong>姓名：</strong>${name}</p>`,
      email ? `<p><strong>Email：</strong>${email}</p>` : '',
      phone ? `<p><strong>電話：</strong>${phone}</p>` : '',
      `<p><strong>留言：</strong></p><p>${message.replace(/\n/g, '<br>')}</p>`,
    ]
      .filter(Boolean)
      .join('');

    await notifyStaffInbox('【體育客】聯絡我們新留言', html);

    res.status(201).json({
      status: 'success',
      message: '留言已送出，我們將盡快與您聯繫',
      data: { id: row.id, createdAt: row.createdAt },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '送出留言失敗' });
  }
});

// ==========================================
// 總部 CMS 管理（ADMIN）
// ==========================================

// POST /api/cms/announcements
router.post('/announcements', ...adminGuard, async (req, res) => {
  const { title, body, branchId, category, pushEnabled, publishedAt, expiresAt, isActive } =
    req.body || {};
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t || !b) {
    return res.status(400).json({ status: 'error', message: '標題與內容為必填' });
  }

  try {
    const data = {
      title: t,
      body: b,
      branchId: branchId != null && branchId !== '' ? parseInt(branchId, 10) : null,
      category: category ? String(category).trim() : 'GENERAL',
      pushEnabled: Boolean(pushEnabled),
      publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive: isActive !== false,
    };
    if (data.branchId != null && (!Number.isInteger(data.branchId) || data.branchId <= 0)) {
      return res.status(400).json({ status: 'error', message: 'branchId 無效' });
    }
    const row = await prisma.announcement.create({ data });
    res.status(201).json({ status: 'success', message: '公告已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立公告失敗' });
  }
});

// PATCH /api/cms/announcements/:id
router.patch('/announcements/:id', ...adminGuard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: '無效的公告 ID' });
  }

  const patch = {};
  const allowed = [
    'title',
    'body',
    'branchId',
    'category',
    'pushEnabled',
    'publishedAt',
    'expiresAt',
    'isActive',
  ];
  for (const key of allowed) {
    if (req.body?.[key] === undefined) continue;
    if (key === 'title' || key === 'body' || key === 'category') {
      patch[key] = String(req.body[key]).trim();
    } else if (key === 'branchId') {
      patch[key] =
        req.body[key] === null || req.body[key] === ''
          ? null
          : parseInt(req.body[key], 10);
    } else if (key === 'pushEnabled' || key === 'isActive') {
      patch[key] = Boolean(req.body[key]);
    } else if (key === 'publishedAt' || key === 'expiresAt') {
      patch[key] = req.body[key] ? new Date(req.body[key]) : null;
    }
  }

  try {
    const row = await prisma.announcement.update({ where: { id }, data: patch });
    res.json({ status: 'success', message: '公告已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到公告' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新公告失敗' });
  }
});

// DELETE /api/cms/announcements/:id
router.delete('/announcements/:id', ...adminGuard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: '無效的公告 ID' });
  }

  try {
    await prisma.announcement.delete({ where: { id } });
    res.json({ status: 'success', message: '公告已刪除' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到公告' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除公告失敗' });
  }
});

// POST /api/cms/faq
router.post('/faq', ...adminGuard, async (req, res) => {
  const { branchId, category, question, answer, sortOrder, isActive } = req.body || {};
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (!q || !a) {
    return res.status(400).json({ status: 'error', message: '問題與答案為必填' });
  }

  try {
    const row = await prisma.faqItem.create({
      data: {
        branchId: branchId != null && branchId !== '' ? parseInt(branchId, 10) : null,
        category: category ? String(category).trim() : 'GENERAL',
        question: q,
        answer: a,
        sortOrder: sortOrder != null ? parseInt(sortOrder, 10) || 0 : 0,
        isActive: isActive !== false,
      },
    });
    res.status(201).json({ status: 'success', message: 'FAQ 已建立', data: row });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立 FAQ 失敗' });
  }
});

// PATCH /api/cms/faq/:id
router.patch('/faq/:id', ...adminGuard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: '無效的 FAQ ID' });
  }

  const patch = {};
  for (const key of ['branchId', 'category', 'question', 'answer', 'sortOrder', 'isActive']) {
    if (req.body?.[key] === undefined) continue;
    if (key === 'branchId') {
      patch[key] =
        req.body[key] === null || req.body[key] === ''
          ? null
          : parseInt(req.body[key], 10);
    } else if (key === 'sortOrder') {
      patch[key] = parseInt(req.body[key], 10) || 0;
    } else if (key === 'isActive') {
      patch[key] = Boolean(req.body[key]);
    } else {
      patch[key] = String(req.body[key]).trim();
    }
  }

  try {
    const row = await prisma.faqItem.update({ where: { id }, data: patch });
    res.json({ status: 'success', message: 'FAQ 已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到 FAQ' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新 FAQ 失敗' });
  }
});

// DELETE /api/cms/faq/:id
router.delete('/faq/:id', ...adminGuard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: '無效的 FAQ ID' });
  }

  try {
    await prisma.faqItem.delete({ where: { id } });
    res.json({ status: 'success', message: 'FAQ 已刪除' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到 FAQ' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '刪除 FAQ 失敗' });
  }
});

// PATCH /api/cms/branches/:id/content
router.patch('/branches/:id/content', ...adminGuard, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: '無效的分店 ID' });
  }

  const patch = {};
  if (req.body?.introText !== undefined) {
    patch.introText =
      req.body.introText === null ? null : String(req.body.introText);
  }
  if (req.body?.introImages !== undefined) patch.introImages = req.body.introImages;
  if (req.body?.introVideos !== undefined) patch.introVideos = req.body.introVideos;
  if (req.body?.showOccupancy !== undefined) {
    patch.showOccupancy = Boolean(req.body.showOccupancy);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ status: 'error', message: '未提供可更新欄位' });
  }

  try {
    const row = await prisma.branch.update({
      where: { id },
      data: patch,
      select: BRANCH_PUBLIC_SELECT,
    });
    res.json({ status: 'success', message: '場館內容已更新', data: row });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ status: 'error', message: '找不到分店' });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新場館內容失敗' });
  }
});

export default router;
