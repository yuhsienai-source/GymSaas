// routes/opsExtensions.js — 會員群組、備註、黑名單、發票查詢、訂閱管理、證件歸檔
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import {
  normalizeIdPhotoSide,
  resolveIdPhotoDeleteRequest,
  computeRetentionUntil,
  issueStaffIdPhotoAccess,
} from '../lib/idPhoto.js';
import { applyCardSubscriptionCreditUpdate } from '../lib/cardSubscription.js';
import {
  stageYipayCapture,
  listYipayCaptures,
  reconcileYipayDay,
  markYipayCaptureOrphan,
} from '../lib/yipayCapture.js';
import { isCrossBranchUser, staffBranchIds } from '../lib/staffAccess.js';

const router = express.Router();
router.use(verifyStaff, requireDutyOrAbove);

function parseDateTimeRange(query) {
  const where = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) {
      const err = new Error('from 日期時間格式無效');
      err.statusCode = 400;
      throw err;
    }
    where.gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) {
      const err = new Error('to 日期時間格式無效');
      err.statusCode = 400;
      throw err;
    }
    where.lte = to;
  }
  return Object.keys(where).length ? where : undefined;
}

// GET/POST /api/ops/member-groups
router.get('/member-groups', async (req, res) => {
  try {
    const groups = await prisma.memberGroup.findMany({
      include: { _count: { select: { members: true } } },
      orderBy: { id: 'asc' },
    });
    return res.json({ status: 'success', data: groups });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '讀取群組失敗' });
  }
});

router.post('/member-groups', async (req, res) => {
  try {
    const { name, description, branchId } = req.body || {};
    if (!String(name || '').trim()) {
      return res.status(400).json({ status: 'error', message: '請填群組名稱' });
    }
    const group = await prisma.memberGroup.create({
      data: {
        name: String(name).trim(),
        description: description?.trim() || null,
        branchId: branchId ? Number(branchId) : null,
      },
    });
    return res.json({ status: 'success', data: group });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '建立群組失敗' });
  }
});

router.post('/member-groups/:id/members', async (req, res) => {
  try {
    const groupId = Number(req.params.id);
    const memberId = Number(req.body?.memberId);
    if (!groupId || !memberId) {
      return res.status(400).json({ status: 'error', message: '缺少 groupId 或 memberId' });
    }
    await prisma.memberGroupMember.upsert({
      where: { memberId_groupId: { memberId, groupId } },
      create: { memberId, groupId },
      update: {},
    });
    return res.json({ status: 'success', message: '已加入群組' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '加入群組失敗' });
  }
});

// GET/POST /api/ops/members/:id/notes
router.get('/members/:id/notes', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const notes = await prisma.memberNote.findMany({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ status: 'success', data: notes });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '讀取備註失敗' });
  }
});

router.post('/members/:id/notes', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const content = String(req.body?.content || '').trim();
    const visibility = String(req.body?.visibility || 'SHARED').toUpperCase();
    if (!content) {
      return res.status(400).json({ status: 'error', message: '請填備註內容' });
    }
    const staffId = req.user?.staffId ?? req.user?.id ?? null;
    const note = await prisma.memberNote.create({
      data: { memberId, content, visibility, staffId },
    });
    return res.json({ status: 'success', data: note });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '新增備註失敗' });
  }
});

// POST /api/ops/members/:id/adjust-expire
router.post('/members/:id/adjust-expire', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    const days = Number(req.body?.days);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isFinite(days) || days === 0) {
      return res.status(400).json({ status: 'error', message: 'days 須為非零整數' });
    }
    if (!reason) {
      return res.status(400).json({ status: 'error', message: '請填調整原因' });
    }
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到會員' });
    }
    const base = member.expireDate ? new Date(member.expireDate) : new Date();
    base.setDate(base.getDate() + days);
    const updated = await prisma.member.update({
      where: { id: memberId },
      data: { expireDate: base },
    });
    // 證件保存期限隨會籍到期日重算（會籍結束 + 3 年）
    const retentionUntil = computeRetentionUntil(updated.expireDate);
    await prisma.memberIdPhoto.updateMany({
      where: { memberId, isCurrent: true, deletedAt: null },
      data: { retentionUntil },
    });
    await prisma.memberNote.create({
      data: {
        memberId,
        content: `[調整會籍 ${days > 0 ? '+' : ''}${days} 天] ${reason}`,
        visibility: 'SHARED',
        staffId: req.user?.staffId ?? req.user?.id ?? null,
      },
    });
    return res.json({ status: 'success', data: { expireDate: updated.expireDate } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '調整會籍失敗' });
  }
});

// GET/POST /api/ops/payment-blacklist
router.get('/payment-blacklist', async (req, res) => {
  try {
    const rows = await prisma.paymentBlacklist.findMany({
      where: { isActive: true },
      include: { member: { select: { id: true, name: true, phone: true, memberNo: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ status: 'success', data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '讀取黑名單失敗' });
  }
});

router.post('/payment-blacklist', async (req, res) => {
  try {
    const memberId = Number(req.body?.memberId);
    const reason = String(req.body?.reason || '').trim();
    if (!memberId || !reason) {
      return res.status(400).json({ status: 'error', message: '缺少 memberId 或 reason' });
    }
    const row = await prisma.paymentBlacklist.upsert({
      where: { memberId },
      create: {
        memberId,
        reason,
        note: req.body?.note?.trim() || null,
        staffId: req.user?.staffId ?? req.user?.id ?? null,
        isActive: true,
      },
      update: {
        reason,
        note: req.body?.note?.trim() || null,
        isActive: true,
        clearedAt: null,
      },
    });
    await prisma.member.update({ where: { id: memberId }, data: { isAlert: true } });
    return res.json({ status: 'success', data: row });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '加入黑名單失敗' });
  }
});

router.post('/payment-blacklist/:memberId/clear', async (req, res) => {
  try {
    const memberId = Number(req.params.memberId);
    await prisma.paymentBlacklist.updateMany({
      where: { memberId, isActive: true },
      data: { isActive: false, clearedAt: new Date() },
    });
    return res.json({ status: 'success', message: '已解除黑名單' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '解除黑名單失敗' });
  }
});

// GET /api/ops/invoices/search?from=&to=&invoiceNumber=
router.get('/invoices/search', async (req, res) => {
  try {
    const range = parseDateTimeRange(req.query);
    const invoiceNumber = String(req.query.invoiceNumber || '').trim().toUpperCase();
    const where = { invoiceNumber: { not: null } };
    if (range) where.issuedAt = range;
    if (invoiceNumber) where.invoiceNumber = { contains: invoiceNumber };
    if (!isCrossBranchUser(req.user)) {
      where.OR = [{ branchId: { in: staffBranchIds(req.user) } }, { branchId: null }];
    }
    const rows = await prisma.eInvoice.findMany({
      where,
      include: { legalEntity: { select: { id: true, code: true, name: true, ubn: true } } },
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
    const items = rows.map((r) => ({
      kind: r.refType === 'SALE' ? 'SALE' : r.refType === 'CHECKOUT' ? 'CHECKOUT' : 'ORDER',
      id: r.refId,
      einvoiceId: r.id,
      memberId: r.memberId,
      amount: r.totalAmount,
      invoiceNumber: r.invoiceNumber,
      category: r.category,
      status: r.status,
      allowanceTotal: r.allowanceTotal,
      legalEntity: r.legalEntity,
      createdAt: r.issuedAt || r.createdAt,
    }));
    return res.json({ status: 'success', data: items });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '發票查詢失敗' });
  }
});

// PATCH /api/ops/card-subscriptions/:id/charge-day
router.patch('/card-subscriptions/:id/charge-day', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const day = Number(req.body?.chargeDayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return res.status(400).json({ status: 'error', message: 'chargeDayOfMonth 須為 1–28' });
    }
    const sub = await prisma.cardSubscription.update({
      where: { id },
      data: { chargeDayOfMonth: day },
    });
    return res.json({ status: 'success', data: sub });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '更新扣款日失敗' });
  }
});

// PATCH /api/ops/card-subscriptions/:id/credit-hash — 人工貼上 Token（登打錯誤修正）
router.patch('/card-subscriptions/:id/credit-hash', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const creditHash = String(req.body?.creditHash || '').trim();
    if (!creditHash) {
      return res.status(400).json({ status: 'error', message: '缺少 creditHash' });
    }
    const sub = await applyCardSubscriptionCreditUpdate(id, {
      creditHash,
      mode: 'manual',
    });
    if (!sub) {
      return res.status(404).json({ status: 'error', message: '找不到訂閱' });
    }
    return res.json({ status: 'success', message: '已更新信用卡 Token', data: sub });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '更新信用卡 Token 失敗' });
  }
});

// ——— 證件調閱（DUTY+；原圖須原因＋稽核；meta／代辦上傳在 ops.js）———

function staffIdFromReq(req) {
  return req.user?.staffId ?? req.user?.id ?? null;
}

// POST /api/ops/members/:id/id-photos/:side/presign — 簽發 3～5 分調閱 URL
router.post('/members/:id/id-photos/:side/presign', async (req, res) => {
  try {
    const memberId = Number(req.params.id);
    if (!Number.isFinite(memberId)) {
      return res.status(400).json({ status: 'error', message: '無效的會員 id' });
    }
    const side = normalizeIdPhotoSide(req.params.side);
    const access = await issueStaffIdPhotoAccess({
      memberId,
      side,
      staffId: staffIdFromReq(req),
      reason: req.body?.reason,
      req,
    });
    if (!access) {
      return res.status(404).json({
        status: 'error',
        message: side === 'back' ? '尚未上傳證件反面' : '尚未上傳證件正面',
      });
    }
    return res.json({
      status: 'success',
      message: '已簽發短效調閱連結',
      data: access,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.code,
        message: error.message,
      });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '簽發調閱失敗' });
  }
});

// GET /api/ops/members/:id/id-photos/:side/preview — 相容：簽發後 302 至短效 URL
router.get('/members/:id/id-photos/:side/preview', async (req, res) => {
  try {
    const reason = String(req.query.reason || '').trim();
    if (reason.length < 4) {
      return res.status(400).json({
        status: 'error',
        code: 'REASON_REQUIRED',
        message: '調閱原圖須填寫原因（至少 4 字）；請改呼叫 POST …/presign',
      });
    }
    const memberId = Number(req.params.id);
    const side = normalizeIdPhotoSide(req.params.side);
    const access = await issueStaffIdPhotoAccess({
      memberId,
      side,
      staffId: staffIdFromReq(req),
      reason,
      req,
    });
    if (!access?.url) {
      return res.status(404).json({
        status: 'error',
        message: side === 'back' ? '尚未上傳證件反面' : '尚未上傳證件正面',
      });
    }
    return res.redirect(302, access.url);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.code,
        message: error.message,
      });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '預覽證件失敗' });
  }
});

// GET /api/ops/id-photo-delete-requests?status=PENDING
router.get('/id-photo-delete-requests', async (req, res) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const take = Math.min(100, parseInt(req.query.take, 10) || 50);
    const rows = await prisma.idPhotoDeleteRequest.findMany({
      where: status === 'ALL' ? undefined : { status },
      orderBy: { requestedAt: 'desc' },
      take,
      include: {
        member: { select: { id: true, memberNo: true, name: true, phone: true } },
      },
    });
    return res.json({ status: 'success', data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '讀取清除申請失敗' });
  }
});

// POST /api/ops/id-photo-delete-requests/:id/approve
router.post('/id-photo-delete-requests/:id/approve', async (req, res) => {
  try {
    const row = await resolveIdPhotoDeleteRequest(req.params.id, {
      approve: true,
      staffId: staffIdFromReq(req),
      note: req.body?.note,
      req,
    });
    return res.json({ status: 'success', message: '已核准並清除證件存檔', data: row });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '核准失敗' });
  }
});

// POST /api/ops/id-photo-delete-requests/:id/reject
router.post('/id-photo-delete-requests/:id/reject', async (req, res) => {
  try {
    const row = await resolveIdPhotoDeleteRequest(req.params.id, {
      approve: false,
      staffId: staffIdFromReq(req),
      note: req.body?.note,
      req,
    });
    return res.json({ status: 'success', message: '已駁回清除申請', data: row });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '駁回失敗' });
  }
});

// ——— 乙禾暫存／日結 ———
router.post('/yipay/captures', async (req, res) => {
  try {
    const row = await stageYipayCapture({
      targetType: req.body?.targetType || req.body?.type,
      targetId: req.body?.targetId || req.body?.checkoutId || req.body?.saleId || req.body?.orderId,
      amount: req.body?.amount,
      rrn: req.body?.rrn,
      authCode: req.body?.authCode,
      cardLast4: req.body?.cardLast4,
      branchId: req.body?.branchId ?? req.user?.branchId,
      staffId: staffIdFromReq(req),
      terminalRef: req.body?.terminalRef,
      raw: req.body?.raw,
    });
    return res.json({ status: 'success', message: '已暫存乙禾端末成功紀錄', data: row });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', code: error.code, message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '暫存失敗' });
  }
});

router.get('/yipay/captures', async (req, res) => {
  try {
    const items = await listYipayCaptures({
      status: req.query.status,
      branchId: req.query.branchId,
      take: req.query.take,
    });
    return res.json({ status: 'success', data: { items } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '查詢失敗' });
  }
});

router.get('/yipay/reconcile', async (req, res) => {
  try {
    const data = await reconcileYipayDay(req.query.day || req.query.date, {
      branchId: req.query.branchId,
      edcCount: req.query.edcCount,
      edcAmount: req.query.edcAmount,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '對帳失敗' });
  }
});

router.post('/yipay/captures/:id/orphan', async (req, res) => {
  try {
    const row = await markYipayCaptureOrphan(req.params.id, req.body?.note);
    return res.json({ status: 'success', data: row });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '標記失敗' });
  }
});

export default router;
