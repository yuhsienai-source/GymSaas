// routes/reports.js — 一般報表／銷售分析（列表與彙總；輸出由前端 CSV）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin, requireDutyOrAbove, requireOpsOrDuty } from '../middleware/jwtAuth.js';
import { branchListWhere, isAdminUser } from '../lib/staffAccess.js';
import { staffBranchLabel } from '../lib/branchLabel.js';
import { formatCheckoutInvoiceDisplay } from '../lib/checkoutInvoice.js';
import { formatGateAccessNo, resolveGateLogId } from '../lib/gateAccessNo.js';

const router = express.Router();
// 先驗員工 JWT；各路由再鎖 ops／DUTY／ADMIN
router.use(verifyStaff);

function parseDateRange(query) {
  const fromRaw = query.from;
  const toRaw = query.to;
  const where = {};

  if (fromRaw) {
    const from = new Date(fromRaw);
    if (Number.isNaN(from.getTime())) {
      const err = new Error('from 日期格式無效');
      err.statusCode = 400;
      throw err;
    }
    where.gte = from;
  }
  if (toRaw) {
    const to = new Date(toRaw);
    if (Number.isNaN(to.getTime())) {
      const err = new Error('to 日期格式無效');
      err.statusCode = 400;
      throw err;
    }
    // 含當日整天
    to.setHours(23, 59, 59, 999);
    where.lte = to;
  }

  return Object.keys(where).length ? where : undefined;
}

/** 銷售分析專用：必有區間，預設近 30 日，最長 366 日 */
const ANALYTICS_MAX_DAYS = 366;
const ANALYTICS_DEFAULT_DAYS = 30;

function parseAnalyticsDateRange(query) {
  const now = new Date();
  let to = query.to ? new Date(query.to) : new Date(now);
  let from = query.from ? new Date(query.from) : null;

  if (Number.isNaN(to.getTime())) {
    const err = new Error('to 日期格式無效');
    err.statusCode = 400;
    throw err;
  }
  if (from && Number.isNaN(from.getTime())) {
    const err = new Error('from 日期格式無效');
    err.statusCode = 400;
    throw err;
  }
  if (!from) {
    from = new Date(to);
    from.setDate(from.getDate() - (ANALYTICS_DEFAULT_DAYS - 1));
    from.setHours(0, 0, 0, 0);
  }
  to.setHours(23, 59, 59, 999);

  const spanMs = to.getTime() - from.getTime();
  if (spanMs < 0) {
    const err = new Error('from 不可晚於 to');
    err.statusCode = 400;
    throw err;
  }
  const maxMs = ANALYTICS_MAX_DAYS * 24 * 60 * 60 * 1000;
  if (spanMs > maxMs) {
    from = new Date(to);
    from.setDate(from.getDate() - (ANALYTICS_MAX_DAYS - 1));
    from.setHours(0, 0, 0, 0);
  }

  return { gte: from, lte: to };
}

function parseOptionalInt(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${fieldName} 無效`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/** 報表「交易狀態」：成功／沖回／退費（其餘保留語意標籤） */
function txnStatusLabel(rawStatus) {
  const s = String(rawStatus || '').toUpperCase();
  if (s === 'PAID' || s === 'ACTIVE') return '成功';
  if (s === 'CANCELLED') return '沖回';
  if (s === 'REFUNDED') return '退費';
  if (s === 'PENDING') return '待付款';
  if (s === 'FAILED') return '失敗';
  return s || '—';
}

/**
 * 已收款但無發票號碼 → 標「成功（未開票）」，避免誤以為交易失敗；
 * 交易狀態碼仍為 PAID（篩選／加總不變）
 */
function txnStatusLabelWithInvoice(rawStatus, invoiceNumber) {
  const base = txnStatusLabel(rawStatus);
  const s = String(rawStatus || '').toUpperCase();
  const inv = String(invoiceNumber || '').trim();
  if ((s === 'PAID' || s === 'ACTIVE') && !inv) return '成功（未開票）';
  return base;
}

function invoiceStatusMeta(rawStatus, invoiceNumber) {
  const s = String(rawStatus || '').toUpperCase();
  const inv = String(invoiceNumber || '').trim();
  if (inv) return { invoiceStatus: 'ISSUED', invoiceStatusLabel: '已開立' };
  if (s === 'PAID' || s === 'ACTIVE') {
    return { invoiceStatus: 'MISSING', invoiceStatusLabel: '未開票' };
  }
  return { invoiceStatus: 'N/A', invoiceStatusLabel: '—' };
}

/** 依 CHK 子單推導交易狀態（歷史資料可能 session 仍為 PAID） */
function deriveCheckoutTxnStatus(sessionStatus, legStatuses) {
  const legs = (legStatuses || [])
    .map((s) => String(s || '').toUpperCase())
    .filter(Boolean);
  if (legs.length) {
    if (legs.some((s) => s === 'PAID' || s === 'PENDING')) return 'PAID';
    if (legs.every((s) => s === 'REFUNDED')) return 'REFUNDED';
    if (legs.every((s) => s === 'CANCELLED' || s === 'REFUNDED' || s === 'FAILED')) {
      return 'CANCELLED';
    }
  }
  return String(sessionStatus || '').toUpperCase() || 'PAID';
}

// GET /api/hq/reports/branches — 報表篩選用分店（依帳號分店範圍）
router.get('/branches', requireOpsOrDuty, async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where: branchListWhere(req),
      select: { id: true, name: true, address: true, isActive: true },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: branches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取分店失敗' });
  }
});

/** 訂單類型（交易一覽） */
function orderKindLabel(order) {
  const desc = String(order?.itemDesc || '');
  if (desc.includes('定期定額')) return '定期定額';
  if (desc.includes('私教')) return '私教';
  if (desc.includes('UNLIMITED') || desc.includes('購案')) return '購案';
  if (desc.includes('儲值') || desc.includes('商品#')) return '儲值';
  if (order?.checkoutSessionId) return '合併結帳';
  return '其他';
}

/** 將業務快照 itemDesc 拆成可讀品項（避免把 | 原樣塞給前端） */
function parseItemDescLines(itemDesc) {
  const raw = String(itemDesc || '').trim();
  if (!raw) return [];

  const lines = [];
  // 合併結帳用「 + 」串接各區塊；不可用裸 +，否則會拆壞「現金+100」「天數+30」
  const chunks = raw.split(/\s\+\s/).map((s) => s.trim()).filter(Boolean);

  for (const chunk of chunks) {
    if (chunk.startsWith('POS')) {
      const body = chunk.replace(/^POS\s*[|｜]\s*/, '');
      for (const part of body.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = part.match(/^(.*?)x(\d+)$/i);
        lines.push({
          kind: 'PRODUCT',
          kindLabel: '商品',
          name: m ? m[1].trim() : part,
          qty: m ? parseInt(m[2], 10) : 1,
          detail: null,
          lineTotal: null,
        });
      }
      continue;
    }

    // 私教 | 教練名 | 方案x份(堂數), … | 會員…
    // 或 私教購案 | 方案名 ×份 | …
    if (chunk.includes('私教')) {
      const pipeParts = chunk.split(/\s*[|｜]\s*/).map((s) => s.trim()).filter(Boolean);
      if (pipeParts[0] === '私教' && pipeParts.length >= 3) {
        const trainerName = pipeParts[1];
        const planBlob = pipeParts[2];
        const who = pipeParts[3] || null;
        const planBits = planBlob.split(',').map((s) => s.trim()).filter(Boolean);
        for (const bit of planBits) {
          const m =
            bit.match(/^(.*?)x(\d+)\((\d+)堂\)$/i) ||
            bit.match(/^(.*?)\s*×\s*(\d+)\s*[（(]\s*(\d+)\s*堂\s*[）)]$/) ||
            bit.match(/^(.*?)\s*×\s*(\d+)/);
          const name = m ? m[1].trim() : bit;
          const qty = m ? parseInt(m[2], 10) : 1;
          const sessions = m && m[3] ? parseInt(m[3], 10) : null;
          lines.push({
            kind: 'COURSE',
            kindLabel: '私教課程',
            name: name || '私教課程',
            qty: Number.isInteger(qty) && qty > 0 ? qty : 1,
            detail: [
              trainerName ? `教練 ${trainerName}` : null,
              sessions ? `共 ${sessions} 堂` : null,
              who || null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
            lineTotal: null,
          });
        }
        if (!planBits.length) {
          lines.push({
            kind: 'COURSE',
            kindLabel: '私教課程',
            name: planBlob || '私教課程',
            qty: 1,
            detail: trainerName ? `教練 ${trainerName}` : null,
            lineTotal: null,
          });
        }
        continue;
      }

      const nameMatch = chunk.match(/私教購案\s*[|｜]\s*([^|｜]+)/);
      const qtyMatch = chunk.match(/×(\d+)/);
      const sessMatch = chunk.match(/(\d+)\s*堂/);
      const trainerMatch = chunk.match(/教練[：: ]\s*([^|｜]+)/);
      lines.push({
        kind: 'COURSE',
        kindLabel: '私教課程',
        name: nameMatch
          ? nameMatch[1].replace(/\s*×\s*\d+.*$/, '').trim()
          : '私教課程',
        qty: qtyMatch ? parseInt(qtyMatch[1], 10) : 1,
        detail: [
          trainerMatch ? `教練 ${trainerMatch[1].trim()}` : null,
          sessMatch ? `${sessMatch[1]} 堂` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
        lineTotal: null,
      });
      continue;
    }

    if (chunk.includes('儲值') || chunk.includes('購案') || chunk.includes('商品#')) {
      const nameMatch =
        chunk.match(/(?:臨櫃|線上)?(?:儲值|購案)\s*[|｜]\s*([^|｜]+)/) ||
        chunk.match(/[|｜]\s*([^|｜]+?)\s*[|｜]\s*(?:TIMED|UNLIMITED)/);
      const qtyMatch = chunk.match(/×(\d+)/);
      const promoMatch = chunk.match(/商品#(\d+)/);
      const isUnlimited = chunk.includes('UNLIMITED');
      const cashMatch = chunk.match(/現金\+(\d+(?:\.\d+)?)/);
      const bonusMatch = chunk.match(/運動金\+(\d+(?:\.\d+)?)/);
      const daysMatch = chunk.match(/天數\+(\d+)/);
      const feeMatch = chunk.match(/方案費\$(\d+(?:\.\d+)?)/);
      const detailParts = [];
      if (isUnlimited) {
        detailParts.push('無限使用');
        if (daysMatch) detailParts.push(`延長 ${daysMatch[1]} 天`);
        if (feeMatch) detailParts.push(`方案費 $${feeMatch[1]}`);
      } else {
        detailParts.push('分鐘計費儲值');
        if (cashMatch) detailParts.push(`本金 +$${cashMatch[1]}`);
        if (bonusMatch) detailParts.push(`運動金 +$${bonusMatch[1]}`);
      }
      if (promoMatch) detailParts.push(`方案 #${promoMatch[1]}`);
      lines.push({
        kind: isUnlimited ? 'PROMO_UNLIMITED' : 'PROMO_TIMED',
        kindLabel: isUnlimited ? '購案' : '儲值',
        name: nameMatch ? nameMatch[1].replace(/\s*×\s*\d+.*$/, '').trim() : '促銷方案',
        qty: qtyMatch ? parseInt(qtyMatch[1], 10) : 1,
        detail: detailParts.join(' · ') || null,
        lineTotal: null,
      });
      continue;
    }

    lines.push({
      kind: 'OTHER',
      kindLabel: '其他',
      name: chunk.replace(/[|｜]/g, '／').slice(0, 80),
      qty: 1,
      detail: null,
      lineTotal: null,
    });
  }

  return lines;
}

function parsePlanNameFromItemDesc(itemDesc) {
  const desc = String(itemDesc || '');
  const parts = desc.split('|').map((s) => s.trim()).filter(Boolean);
  // 例：臨櫃儲值 | 30日月卡 | TIMED | ... 或 線上購案 | 訂閱制 | UNLIMITED | ...
  if (parts.length >= 2) return parts[1];
  return '';
}

function buildPtSessionLines(ptItems, trainerName = null) {
  if (!Array.isArray(ptItems) || !ptItems.length) return [];
  const out = [];
  for (const l of ptItems) {
    out.push({
      kind: 'COURSE',
      kindLabel: '私教課程',
      name: l.name || `方案 #${l.coursePlanId}`,
      qty: Number(l.qty) || 1,
      detail: [
        trainerName ? `教練 ${trainerName}` : null,
        l.totalSessions
          ? `共 ${l.totalSessions} 堂`
          : l.sessions
            ? `每份 ${l.sessions} 堂`
            : null,
        l.secondPersonOnSite || l.secondPersonNote
          ? l.secondPersonNote || '課程第二人+$500(課程當日現場支付)'
          : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
      lineTotal: l.lineTotal != null ? Number(l.lineTotal) : null,
    });
    if (l.giftLabel) {
      out.push({
        kind: 'GIFT',
        kindLabel: '加贈禮',
        name: String(l.giftLabel),
        qty: 1,
        detail: '結帳不收款',
        lineTotal: 0,
      });
    }
  }
  return out;
}

/** 解析購案子單：優先單一品項 + 實付金額，避免誤拆 */
function buildPromoOrderLines(promo) {
  if (!promo) return [];
  const parsed = parseItemDescLines(promo.itemDesc);
  const promoLines = parsed.filter((l) =>
    String(l.kind || '').startsWith('PROMO'),
  );
  if (promoLines.length === 1) {
    return [
      {
        ...promoLines[0],
        lineTotal: Number(promo.amount),
      },
    ];
  }
  if (promoLines.length > 1) {
    return promoLines.map((l, idx) => ({
      ...l,
      // 多列時僅首列掛總額，避免每列都灌入全額
      lineTotal: idx === 0 ? Number(promo.amount) : null,
    }));
  }
  if (parsed.length) {
    return parsed.map((l, idx) => ({
      ...l,
      lineTotal: idx === 0 ? Number(promo.amount) : null,
    }));
  }
  return [
    {
      kind: 'PROMO',
      kindLabel: '購案／儲值',
      name: String(promo.itemDesc || '促銷方案').slice(0, 80),
      qty: 1,
      detail: null,
      lineTotal: Number(promo.amount),
    },
  ];
}

function memberPick(m) {
  return {
    memberId: m?.id ?? null,
    memberNo: m?.memberNo || null,
    memberName: m?.name || null,
    memberPhone: m?.phone || null,
  };
}

function matchesTxnQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    row.orderId,
    row.invoiceNumber,
    row.carrierNum,
    row.buyerUbn,
    row.loveCode,
    row.merchantNo,
    row.checkoutSessionId,
    row.saleOrderId,
    row.payMethod,
    row.memberName,
    row.memberPhone,
    row.memberNo,
    row.orderKind,
    ...(row.lines || []).flatMap((l) => [l.name, l.detail, l.kindLabel]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

// GET /api/hq/reports/orders?from=&to=&q=&status=&branchId=
// 交易一覽：以「一筆付款／結帳」為準（CHK 合併結帳 + 獨立 TYK／SAL），金額為實付總額
router.get('/orders', requireOpsOrDuty, async (req, res) => {
  try {
    const createdAt = parseDateRange(req.query);
    const q = String(req.query.q || '').trim();
    const statusRaw = String(req.query.status || '').trim().toUpperCase();
    const statusFilter =
      statusRaw === 'ALL' || statusRaw === '*' || statusRaw === ''
        ? null
        : statusRaw;
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');

    if (!isAdminUser(req.user) && branchId && req.user?.branchId && branchId !== req.user.branchId) {
      return res.status(403).json({ status: 'error', message: '⛔ 無權查詢其他分店交易' });
    }

    const scopedBranchId = isAdminUser(req.user)
      ? branchId
      : req.user?.branchId || -1;

    const dateWhere = createdAt ? { createdAt } : {};
    // 沖回後子單已 CANCELLED／REFUNDED 但 CHK 可能仍 PAID：先寬抓再依子單推導
    const statusWhere = statusFilter
      ? { status: { in: ['PAID', 'CANCELLED', 'PENDING', 'REFUNDED', 'FAILED'] } }
      : {};
    const branchWhere = scopedBranchId ? { branchId: scopedBranchId } : {};

    const [sessions, orphanOrders, orphanSales] = await Promise.all([
      prisma.checkoutSession.findMany({
        where: { ...dateWhere, ...statusWhere, ...branchWhere },
        include: {
          member: { select: { id: true, memberNo: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      // Order 無 branchId：有分店篩選時略過無法歸戶的獨立訂單
      scopedBranchId
        ? Promise.resolve([])
        : prisma.order.findMany({
            where: {
              ...dateWhere,
              ...statusWhere,
              checkoutSessionId: null,
            },
            include: {
              member: { select: { id: true, memberNo: true, name: true, phone: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 1000,
          }),
      prisma.saleOrder.findMany({
        where: {
          ...dateWhere,
          ...statusWhere,
          checkoutSessionId: null,
          ...branchWhere,
        },
        include: {
          member: { select: { id: true, memberNo: true, name: true, phone: true } },
          branch: { select: { id: true, name: true, code: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);

    // 合併結帳：補商品明細
    const saleIds = sessions.map((s) => s.saleOrderId).filter(Boolean);
    const salesById = new Map();
    if (saleIds.length) {
      const sales = await prisma.saleOrder.findMany({
        where: { id: { in: saleIds } },
        include: { items: true, branch: { select: { id: true, name: true, code: true } } },
      });
      for (const s of sales) salesById.set(s.id, s);
    }

    const promoOrderIds = sessions.map((s) => s.orderId).filter(Boolean);
    const promoById = new Map();
    if (promoOrderIds.length) {
      const promos = await prisma.order.findMany({
        where: { id: { in: promoOrderIds } },
        select: { id: true, amount: true, itemDesc: true, status: true },
      });
      for (const o of promos) promoById.set(o.id, o);
    }

    const sessionIds = sessions.map((s) => s.id);
    const ptOrdersBySession = new Map();
    if (sessionIds.length) {
      const ptOrders = await prisma.order.findMany({
        where: {
          checkoutSessionId: { in: sessionIds },
          itemDesc: { contains: '私教' },
        },
        select: { id: true, checkoutSessionId: true, status: true, amount: true },
      });
      for (const o of ptOrders) {
        const list = ptOrdersBySession.get(o.checkoutSessionId) || [];
        list.push(o);
        ptOrdersBySession.set(o.checkoutSessionId, list);
      }
    }

    const trainerIds = [
      ...new Set(sessions.map((s) => s.trainerId).filter(Boolean)),
    ];
    const trainerNameById = new Map();
    if (trainerIds.length) {
      const trainers = await prisma.trainer.findMany({
        where: { id: { in: trainerIds } },
        select: { id: true, name: true },
      });
      for (const t of trainers) trainerNameById.set(t.id, t.name);
    }

    const sessionRows = sessions.map((s) => {
      const lines = [];
      const sale = s.saleOrderId ? salesById.get(s.saleOrderId) : null;
      if (sale?.items?.length) {
        for (const it of sale.items) {
          lines.push({
            kind: 'PRODUCT',
            kindLabel: '商品',
            name: it.name,
            qty: it.qty,
            detail: sale.branch ? `分店 ${staffBranchLabel(sale.branch)}` : null,
            lineTotal: Number(it.lineTotal),
          });
        }
      }
      const promo = s.orderId ? promoById.get(s.orderId) : null;
      if (promo) {
        lines.push(...buildPromoOrderLines(promo));
      }
      const trainerName = s.trainerId ? trainerNameById.get(s.trainerId) : null;
      lines.push(...buildPtSessionLines(s.ptItems, trainerName || null));

      const legStatuses = [
        sale?.status,
        promo?.status,
        ...(ptOrdersBySession.get(s.id) || []).map((o) => o.status),
      ];
      const effectiveStatus = deriveCheckoutTxnStatus(s.status, legStatuses);
      const invoiceDisplay = formatCheckoutInvoiceDisplay(s.invoiceNumber);

      return {
        orderId: s.id,
        createdAt: s.createdAt,
        orderKind: '合併結帳',
        ...memberPick(s.member),
        amount: s.amount,
        cardAmount: s.cardAmount,
        payMethod: s.payMethod,
        payBreakdown: s.payBreakdown,
        voucherCode: s.voucherCode,
        cardMode: s.cardMode,
        cardInst: s.cardInst,
        periodType: s.periodType,
        periodTimes: s.periodTimes,
        recurringAmount: s.recurringAmount,
        status: effectiveStatus,
        txnStatus: txnStatusLabelWithInvoice(effectiveStatus, invoiceDisplay),
        invoiceNumber: invoiceDisplay,
        ...invoiceStatusMeta(effectiveStatus, invoiceDisplay),
        carrierNum: s.carrierNum,
        buyerUbn: s.buyerUbn,
        loveCode: s.loveCode,
        merchantNo: s.merchantNo,
        checkoutSessionId: s.id,
        saleOrderId: s.saleOrderId,
        promoOrderId: s.orderId,
        trainerId: s.trainerId,
        lines,
        itemSummary: lines
          .map((l) => {
            const qty = l.qty > 1 ? ` ×${l.qty}` : '';
            const amt = l.lineTotal != null ? ` $${l.lineTotal}` : '';
            return `${l.kindLabel}：${l.name}${qty}${amt}`;
          })
          .join('；'),
      };
    }).filter((row) => !statusFilter || String(row.status).toUpperCase() === statusFilter);

    const orderRows = orphanOrders.map((o) => {
      const parsed = parseItemDescLines(o.itemDesc);
      let finalLines;
      if (parsed.length === 1) {
        finalLines = [{ ...parsed[0], lineTotal: Number(o.amount) }];
      } else if (parsed.length > 1) {
        finalLines = parsed.map((l, idx) => ({
          ...l,
          lineTotal:
            l.lineTotal != null
              ? l.lineTotal
              : idx === 0
                ? Number(o.amount)
                : null,
        }));
      } else {
        finalLines = [
          {
            kind: 'OTHER',
            kindLabel: orderKindLabel(o),
            name: String(o.itemDesc || '訂單').slice(0, 80),
            qty: 1,
            detail: null,
            lineTotal: Number(o.amount),
          },
        ];
      }
      return {
        orderId: o.id,
        createdAt: o.createdAt,
        orderKind: orderKindLabel(o),
        ...memberPick(o.member),
        amount: o.amount,
        cardAmount: o.cardAmount,
        payMethod: o.payMethod,
        payBreakdown: o.payBreakdown,
        voucherCode: o.voucherCode,
        cardMode: o.cardMode,
        cardInst: o.cardInst,
        periodType: o.periodType,
        periodTimes: o.periodTimes,
        recurringAmount: o.recurringAmount,
        status: o.status,
        txnStatus: txnStatusLabelWithInvoice(o.status, o.invoiceNumber),
        invoiceNumber: o.invoiceNumber,
        ...invoiceStatusMeta(o.status, o.invoiceNumber),
        carrierNum: o.carrierNum,
        buyerUbn: o.buyerUbn,
        loveCode: o.loveCode,
        merchantNo: o.merchantNo,
        checkoutSessionId: null,
        saleOrderId: null,
        promoOrderId: o.id,
        trainerId: null,
        lines: finalLines,
        itemSummary: finalLines
          .map((l) => `${l.kindLabel}：${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`)
          .join('；'),
      };
    });

    const saleRows = orphanSales.map((s) => {
      const lines = (s.items || []).map((it) => ({
        kind: 'PRODUCT',
        kindLabel: '商品',
        name: it.name,
        qty: it.qty,
        detail: s.branch ? `分店 ${staffBranchLabel(s.branch)}` : null,
        lineTotal: Number(it.lineTotal),
      }));
      return {
        orderId: s.id,
        createdAt: s.createdAt,
        orderKind: '商品銷售',
        ...memberPick(s.member),
        amount: s.amount,
        cardAmount: s.cardAmount,
        payMethod: s.payMethod,
        payBreakdown: s.payBreakdown,
        voucherCode: s.voucherCode,
        cardMode: s.cardMode,
        cardInst: s.cardInst,
        periodType: s.periodType,
        periodTimes: s.periodTimes,
        recurringAmount: null,
        status: s.status,
        txnStatus: txnStatusLabelWithInvoice(s.status, formatCheckoutInvoiceDisplay(s.invoiceNumber)),
        invoiceNumber: formatCheckoutInvoiceDisplay(s.invoiceNumber),
        ...invoiceStatusMeta(s.status, formatCheckoutInvoiceDisplay(s.invoiceNumber)),
        carrierNum: s.carrierNum,
        buyerUbn: s.buyerUbn,
        loveCode: s.loveCode,
        merchantNo: s.merchantNo,
        checkoutSessionId: null,
        saleOrderId: s.id,
        promoOrderId: null,
        trainerId: null,
        lines,
        itemSummary: lines
          .map((l) => `${l.kindLabel}：${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''} $${l.lineTotal ?? ''}`)
          .join('；'),
      };
    });

    let data = [...sessionRows, ...orderRows, ...saleRows]
      .filter((r) => matchesTxnQuery(r, q))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 1000);

    const totalAmount = data.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const paidAmount = data
      .filter((r) => String(r.status).toUpperCase() === 'PAID')
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);

    res.json({
      status: 'success',
      data: {
        rows: data,
        summary: {
          count: data.length,
          totalAmount,
          paidAmount,
          paidCount: data.filter((r) => String(r.status).toUpperCase() === 'PAID').length,
        },
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取交易一覽失敗' });
  }
});

// GET /api/hq/reports/topup?from=&to=&q=&status=
router.get('/topup', requireDutyOrAbove, async (req, res) => {
  try {
    const createdAt = parseDateRange(req.query);
    const q = String(req.query.q || '').trim();
    const statusRaw = String(req.query.status || '').trim().toUpperCase();
    const statusFilter =
      statusRaw === 'ALL' || statusRaw === '*'
        ? null
        : statusRaw || 'PAID';

    const where = {
      ...(createdAt ? { createdAt } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      // 儲值訂單：itemDesc 含「商品#」（臨櫃／線上購案）；排除私教等其他 Order
      itemDesc: { contains: '商品#' },
      ...(q
        ? {
            AND: [
              {
                OR: [
                  { id: { contains: q, mode: 'insensitive' } },
                  { itemDesc: { contains: q, mode: 'insensitive' } },
                  { invoiceNumber: { contains: q, mode: 'insensitive' } },
                  { carrierNum: { contains: q, mode: 'insensitive' } },
                  { member: { name: { contains: q, mode: 'insensitive' } } },
                  { member: { phone: { contains: q } } },
                  { member: { memberNo: { contains: q, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };

    const rows = await prisma.order.findMany({
      where,
      include: {
        member: { select: { id: true, memberNo: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const orderIds = rows.map((o) => o.id);
    const subs = orderIds.length
      ? await prisma.cardSubscription.findMany({
          where: { originOrderId: { in: orderIds } },
          select: { originOrderId: true, status: true, id: true },
          orderBy: { updatedAt: 'desc' },
        })
      : [];
    const subByOrder = new Map();
    for (const s of subs) {
      if (!s.originOrderId || subByOrder.has(s.originOrderId)) continue;
      subByOrder.set(s.originOrderId, s);
    }

    const data = rows.map((o) => {
      const sub = subByOrder.get(o.id) || null;
      const subStatus = sub ? String(sub.status || '').toUpperCase() : null;
      const recurringStopped =
        String(o.cardMode || '').toUpperCase() === 'RECURRING' &&
        (subStatus === 'CANCELLED' ||
          subStatus === 'COMPLETED' ||
          String(o.itemDesc || '').includes('定期定額已停續扣'));
      let txnStatus = txnStatusLabelWithInvoice(o.status, o.invoiceNumber);
      if (String(o.status || '').toUpperCase() === 'PAID' && recurringStopped) {
        txnStatus = '成功（訂閱已停）';
      }
      return {
        orderId: o.id,
        createdAt: o.createdAt,
        memberId: o.memberId,
        memberNo: o.member?.memberNo || null,
        memberName: o.member?.name,
        planName: parsePlanNameFromItemDesc(o.itemDesc),
        usageType: String(o.itemDesc || '').includes('UNLIMITED') ? 'UNLIMITED' : 'TIMED',
        cardMode: o.cardMode || null,
        payMethod: o.payMethod || null,
        amount: o.amount,
        status: o.status,
        txnStatus,
        subscriptionId: sub?.id || null,
        subscriptionStatus: subStatus,
        recurringStopped,
        invoiceNumber: o.invoiceNumber,
        ...invoiceStatusMeta(o.status, o.invoiceNumber),
        carrierNum: o.carrierNum,
        buyerUbn: o.buyerUbn,
        loveCode: o.loveCode,
      };
    });

    const totalAmount = data.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    res.json({
      status: 'success',
      data: { rows: data, summary: { count: data.length, totalAmount } },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取儲值報表失敗' });
  }
});

// GET /api/hq/reports/gate?from=&to=&q=&branchId=
router.get('/gate', requireDutyOrAbove, async (req, res) => {
  try {
    const checkInAt = parseDateRange(req.query);
    const q = String(req.query.q || '').trim();
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');

    let resolvedLogId = null;
    if (q) {
      try {
        resolvedLogId = await resolveGateLogId(q, prisma);
      } catch {
        resolvedLogId = null;
      }
    }

    const where = {
      ...(checkInAt ? { checkInAt } : {}),
      ...(branchId ? { branchId } : {}),
      ...(q
        ? {
            OR: [
              ...(resolvedLogId ? [{ id: resolvedLogId }] : []),
              ...(Number.isInteger(parseInt(q, 10)) && String(parseInt(q, 10)) === q
                ? [{ id: parseInt(q, 10) }]
                : []),
              { member: { name: { contains: q, mode: 'insensitive' } } },
              { member: { phone: { contains: q } } },
              { member: { memberNo: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.checkInLog.findMany({
      where,
      include: {
        member: { select: { id: true, memberNo: true, name: true, phone: true, plan: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { checkInAt: 'desc' },
      take: 1000,
    });

    const data = rows.map((log) => ({
      id: log.id,
      gateLogId: log.id,
      gateAccessNo: formatGateAccessNo(log.checkInAt),
      branchId: log.branchId,
      branchName: staffBranchLabel(log.branch),
      memberId: log.memberId,
      memberNo: log.member?.memberNo || null,
      memberName: log.member?.name,
      memberPhone: log.member?.phone,
      plan: log.member?.plan,
      billingMode: log.billingMode,
      checkInAt: log.checkInAt,
      checkOutAt: log.checkOutAt,
      fee: log.fee,
      status: log.status || 'ACTIVE',
      txnStatus: txnStatusLabel(log.status || 'ACTIVE'),
      inVenue: !log.checkOutAt && (log.status || 'ACTIVE') === 'ACTIVE',
    }));

    const totalFee = data
      .filter((r) => r.status === 'ACTIVE')
      .reduce((s, r) => s + (Number(r.fee) || 0), 0);
    const stillIn = data.filter((r) => r.inVenue).length;

    res.json({
      status: 'success',
      data: { rows: data, summary: { count: data.length, stillIn, totalFee } },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取進出場報表失敗' });
  }
});

// GET /api/hq/reports/sales?from=&to=&branchId=&q=&status=
router.get('/sales', requireDutyOrAbove, async (req, res) => {
  try {
    const createdAt = parseDateRange(req.query);
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');
    const q = String(req.query.q || '').trim();
    const statusRaw = String(req.query.status || '').trim().toUpperCase();
    const statusFilter =
      statusRaw === 'ALL' || statusRaw === '*' || !statusRaw
        ? null
        : statusRaw;

    if (!isAdminUser(req.user) && branchId && req.user?.branchId && branchId !== req.user.branchId) {
      return res.status(403).json({ status: 'error', message: '⛔ 無權查詢其他分店銷售' });
    }

    const scopedBranchId = isAdminUser(req.user)
      ? branchId
      : req.user?.branchId || -1;

    const where = {
      status: statusFilter
        ? statusFilter
        : { in: ['PAID', 'CANCELLED'] },
      ...(createdAt ? { createdAt } : {}),
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
      ...(q
        ? {
            OR: [
              { id: { contains: q, mode: 'insensitive' } },
              { itemDesc: { contains: q, mode: 'insensitive' } },
              { invoiceNumber: { contains: q, mode: 'insensitive' } },
              { carrierNum: { contains: q, mode: 'insensitive' } },
              { voucherCode: { contains: q, mode: 'insensitive' } },
              { member: { name: { contains: q, mode: 'insensitive' } } },
              { member: { phone: { contains: q } } },
              { member: { memberNo: { contains: q, mode: 'insensitive' } } },
              { items: { some: { name: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.saleOrder.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        member: { select: { id: true, memberNo: true, name: true, phone: true } },
        items: {
          select: {
            productId: true,
            name: true,
            unitPrice: true,
            qty: true,
            lineTotal: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const data = rows.map((s) => ({
      saleId: s.id,
      createdAt: s.createdAt,
      branchId: s.branchId,
      branchName: staffBranchLabel(s.branch),
      memberId: s.memberId,
      memberNo: s.member?.memberNo || null,
      memberName: s.member?.name,
      amount: s.amount,
      payMethod: s.payMethod,
      payBreakdown: s.payBreakdown,
      voucherCode: s.voucherCode,
      status: s.status,
      txnStatus: txnStatusLabel(s.status),
      invoiceNumber: s.invoiceNumber,
      carrierNum: s.carrierNum,
      buyerUbn: s.buyerUbn,
      loveCode: s.loveCode,
      itemDesc: s.itemDesc,
      items: s.items,
    }));

    // 未篩選時合計只算成功單；有指定交易狀態時合計對應結果集
    const summaryRows = !statusFilter
      ? data.filter((r) => r.status === 'PAID')
      : data;
    const totalAmount = summaryRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const itemQty = summaryRows.reduce(
      (s, r) => s + r.items.reduce((a, i) => a + (Number(i.qty) || 0), 0),
      0,
    );

    res.json({
      status: 'success',
      data: { rows: data, summary: { count: data.length, totalAmount, itemQty } },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取商品銷售報表失敗' });
  }
});

/**
 * 將 CheckoutSession.ptItems 展開為課程購買明細列
 */
function explodePtCheckoutLines(session, { trainerName = null, branchName = null, ptOrders = [] } = {}) {
  const items = Array.isArray(session.ptItems) ? session.ptItems : [];
  if (!items.length) return [];

  const unusedOrders = [...(ptOrders || [])];

  return items.map((l, idx) => {
    const qty = Math.max(1, Number(l.qty) || 1);
    const sessions = Number(l.sessions) || 0;
    const totalSessions = Number(l.totalSessions) || sessions * qty;
    const unitPrice = l.unitPrice != null ? Number(l.unitPrice) : null;
    const amount = l.lineTotal != null ? Number(l.lineTotal) : (unitPrice != null ? unitPrice * qty : 0);
    const planName = String(l.name || '').trim() || (l.coursePlanId ? `方案 #${l.coursePlanId}` : '課程方案');
    const notes = [
      l.secondPersonOnSite || l.secondPersonNote
        ? l.secondPersonNote || '第二人+$500（當日現場）'
        : null,
      l.giftLabel ? `贈 ${l.giftLabel}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    // 對應軟拆後的私教 Order：優先金額＋方案#，否則依序配對
    let matchedOrder = null;
    const planToken = l.coursePlanId != null ? `方案#${l.coursePlanId}` : null;
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    const byPlanAmt = unusedOrders.findIndex((o) => {
      if (Math.round((Number(o.amount) || 0) * 100) / 100 !== amt) return false;
      if (planToken && !String(o.itemDesc || '').includes(planToken)) return false;
      return true;
    });
    if (byPlanAmt >= 0) {
      matchedOrder = unusedOrders.splice(byPlanAmt, 1)[0];
    } else if (unusedOrders.length) {
      // 方案字樣不一致時仍依建立順序配對，避免沖回後列仍顯示「成功」
      matchedOrder = unusedOrders.shift();
    }

    return {
      rowId: `${session.id}-pt-${idx}`,
      source: 'CHECKOUT',
      checkoutId: session.id,
      orderId: matchedOrder?.id || null,
      saleOrderId: session.saleOrderId || null,
      createdAt: session.createdAt,
      branchId: session.branchId ?? l.branchId ?? null,
      branchName: branchName || null,
      ...memberPick(session.member),
      trainerId: session.trainerId ?? null,
      trainerName: trainerName || null,
      coursePlanId: l.coursePlanId != null ? Number(l.coursePlanId) : null,
      planName,
      qty,
      sessions,
      totalSessions,
      unitPrice,
      amount,
      notes: notes || null,
      giftLabel: l.giftLabel ? String(l.giftLabel) : null,
      secondPersonOnSite: Boolean(l.secondPersonOnSite),
      payMethod: session.payMethod,
      payBreakdown: session.payBreakdown,
      status: matchedOrder?.status || session.status,
      txnStatus: txnStatusLabel(matchedOrder?.status || session.status),
      invoiceNumber:
        matchedOrder?.invoiceNumber ||
        formatCheckoutInvoiceDisplay(session.invoiceNumber),
      carrierNum: session.carrierNum,
      buyerUbn: session.buyerUbn,
      loveCode: session.loveCode,
      voucherCode: session.voucherCode || null,
    };
  });
}

/** 獨立私教 Order（無 CHK）→ 明細列；從 itemDesc 盡力解析 */
function rowFromOrphanPtOrder(order) {
  const desc = String(order.itemDesc || '');
  if (!desc.includes('私教')) return null;

  const nameMatch = desc.match(/私教購案\s*[|｜]\s*([^|｜]+?)(?:\s*[×x]\s*(\d+))?/);
  const planIdMatch = desc.match(/方案\s*#\s*(\d+)/);
  const sessionsMatch = desc.match(/[×x]\s*(\d+)\s*堂/);
  const trainerMatch = desc.match(/[|｜]\s*([^|｜]+?)\s*[×x]\s*\d+\s*堂/);

  let planName = nameMatch?.[1]?.trim() || '';
  // 去掉尾端「×份數」
  planName = planName.replace(/\s*[×x]\s*\d+\s*$/, '').trim() || '私教購案';
  const qty = nameMatch?.[2] ? parseInt(nameMatch[2], 10) : 1;
  const totalSessions = sessionsMatch ? parseInt(sessionsMatch[1], 10) : null;
  let trainerName = trainerMatch?.[1]?.trim() || null;
  if (trainerName && /方案\s*#/.test(trainerName)) trainerName = null;

  return {
    rowId: `ord-${order.id}`,
    source: 'ORDER',
    checkoutId: null,
    orderId: order.id,
    createdAt: order.createdAt,
    branchId: null,
    branchName: null,
    ...memberPick(order.member),
    trainerId: null,
    trainerName,
    coursePlanId: planIdMatch ? parseInt(planIdMatch[1], 10) : null,
    planName,
    qty: Number.isInteger(qty) && qty > 0 ? qty : 1,
    sessions: null,
    totalSessions,
    unitPrice: null,
    amount: Number(order.amount) || 0,
    notes: null,
    giftLabel: null,
    secondPersonOnSite: false,
    payMethod: order.payMethod,
    payBreakdown: null,
    status: order.status,
    txnStatus: txnStatusLabel(order.status),
    invoiceNumber: order.invoiceNumber || null,
    carrierNum: order.carrierNum || null,
    buyerUbn: order.buyerUbn || null,
    loveCode: order.loveCode || null,
    voucherCode: null,
  };
}

function matchesCoursePurchaseQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    row.checkoutId,
    row.orderId,
    row.invoiceNumber,
    row.carrierNum,
    row.buyerUbn,
    row.loveCode,
    row.payMethod,
    row.memberName,
    row.memberPhone,
    row.memberNo,
    row.trainerName,
    row.planName,
    row.notes,
    row.giftLabel,
    row.coursePlanId != null ? String(row.coursePlanId) : null,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

// GET /api/hq/reports/course-purchases?from=&to=&branchId=&trainerId=&q=&status=
router.get('/course-purchases', requireDutyOrAbove, async (req, res) => {
  try {
    const createdAt = parseDateRange(req.query);
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');
    const trainerId = parseOptionalInt(req.query.trainerId, 'trainerId');
    const q = String(req.query.q || '').trim();
    const statusRaw = String(req.query.status || '').trim().toUpperCase();
    const statusFilter =
      statusRaw === 'ALL' || statusRaw === '*' || !statusRaw
        ? null
        : statusRaw;

    if (!isAdminUser(req.user) && branchId && req.user?.branchId && branchId !== req.user.branchId) {
      return res.status(403).json({ status: 'error', message: '⛔ 無權查詢其他分店課程購買' });
    }

    const scopedBranchId = isAdminUser(req.user)
      ? branchId
      : req.user?.branchId || -1;

    const dateWhere = createdAt ? { createdAt } : {};
    // 列狀態以私教 Order 為準；CHK 可能仍 PAID／僅 CANCELLED，故寬抓後再過濾
    const statusWhere = {
      status: { in: ['PAID', 'CANCELLED', 'PENDING'] },
    };
    const branchWhere = scopedBranchId ? { branchId: scopedBranchId } : {};
    // 有課程的 CHK 會寫 trainerId；以此縮小候選（再以 ptItems 展開）
    const trainerWhere = trainerId
      ? { trainerId }
      : { trainerId: { not: null } };

    const orphanStatusWhere = statusFilter
      ? { status: statusFilter }
      : { status: { in: ['PAID', 'CANCELLED', 'REFUNDED'] } };

    const [sessions, orphanOrders] = await Promise.all([
      prisma.checkoutSession.findMany({
        where: {
          ...dateWhere,
          ...statusWhere,
          ...branchWhere,
          ...trainerWhere,
        },
        include: {
          member: { select: { id: true, memberNo: true, name: true, phone: true } },
          branch: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      // 獨立私教 Order 無分店欄：有分店／教練篩選時略過
      scopedBranchId || trainerId
        ? Promise.resolve([])
        : prisma.order.findMany({
            where: {
              ...dateWhere,
              ...orphanStatusWhere,
              checkoutSessionId: null,
              itemDesc: { contains: '私教' },
            },
            include: {
              member: { select: { id: true, memberNo: true, name: true, phone: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 500,
          }),
    ]);

    const trainerIds = [
      ...new Set(sessions.map((s) => s.trainerId).filter(Boolean)),
    ];
    const trainerNameById = new Map();
    if (trainerIds.length) {
      const trainers = await prisma.trainer.findMany({
        where: { id: { in: trainerIds } },
        select: { id: true, name: true },
      });
      for (const t of trainers) trainerNameById.set(t.id, t.name);
    }

    const sessionIds = sessions.map((s) => s.id);
    const ptOrders = sessionIds.length
      ? await prisma.order.findMany({
          where: {
            checkoutSessionId: { in: sessionIds },
            itemDesc: { contains: '私教' },
          },
          select: {
            id: true,
            checkoutSessionId: true,
            amount: true,
            itemDesc: true,
            status: true,
            invoiceNumber: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const ptOrdersBySession = new Map();
    for (const o of ptOrders) {
      const list = ptOrdersBySession.get(o.checkoutSessionId) || [];
      list.push(o);
      ptOrdersBySession.set(o.checkoutSessionId, list);
    }

    const rows = [];
    for (const s of sessions) {
      const items = Array.isArray(s.ptItems) ? s.ptItems : [];
      if (!items.length) continue;
      rows.push(
        ...explodePtCheckoutLines(s, {
          trainerName: s.trainerId ? trainerNameById.get(s.trainerId) || null : null,
          branchName: staffBranchLabel(s.branch),
          ptOrders: ptOrdersBySession.get(s.id) || [],
        }),
      );
    }

    for (const o of orphanOrders) {
      const row = rowFromOrphanPtOrder(o);
      if (row) rows.push(row);
    }

    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const byStatus = statusFilter
      ? rows.filter((r) => String(r.status || '').toUpperCase() === statusFilter)
      : rows;
    const filtered = q ? byStatus.filter((r) => matchesCoursePurchaseQuery(r, q)) : byStatus;
    const capped = filtered.slice(0, 1000);

    const summaryRows = !statusFilter
      ? capped.filter((r) => r.status === 'PAID')
      : capped;
    const totalAmount = summaryRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const sessionsSold = summaryRows.reduce(
      (s, r) => s + (Number(r.totalSessions) || 0),
      0,
    );
    const qtySold = summaryRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);

    res.json({
      status: 'success',
      data: {
        rows: capped,
        summary: {
          count: capped.length,
          totalAmount,
          sessionsSold,
          qtySold,
        },
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取課程購買報表失敗' });
  }
});

// GET /api/hq/reports/trainer?from=&to=&trainerId=&q=
router.get('/trainer', requireDutyOrAbove, async (req, res) => {
  try {
    const createdAt = parseDateRange(req.query);
    const trainerId = parseOptionalInt(req.query.trainerId, 'trainerId');
    const q = String(req.query.q || '').trim();

    const trainerWhere = {
      ...(trainerId ? { id: trainerId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    };

    const trainers = await prisma.trainer.findMany({
      where: trainerWhere,
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        isActive: true,
        ptContracts: {
          where: createdAt ? { createdAt } : undefined,
          select: {
            id: true,
            totalSessions: true,
            usedSessions: true,
            pricePaid: true,
            isActive: true,
            createdAt: true,
            member: { select: { id: true, name: true, phone: true } },
          },
        },
        classes: {
          where: createdAt ? { startAt: createdAt } : undefined,
          select: {
            id: true,
            title: true,
            type: true,
            startAt: true,
            endAt: true,
            capacity: true,
            _count: { select: { reservations: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    const rows = trainers.map((t) => {
      const contracts = t.ptContracts;
      const contractCount = contracts.length;
      const sessionsSold = contracts.reduce((s, c) => s + c.totalSessions, 0);
      const sessionsUsed = contracts.reduce((s, c) => s + c.usedSessions, 0);
      const revenue = contracts.reduce((s, c) => s + (Number(c.pricePaid) || 0), 0);
      const classCount = t.classes.length;
      const reservationCount = t.classes.reduce((s, c) => s + c._count.reservations, 0);

      return {
        trainerId: t.id,
        trainerName: t.name,
        phone: t.phone,
        role: t.role,
        isActive: t.isActive,
        contractCount,
        sessionsSold,
        sessionsUsed,
        sessionsRemaining: sessionsSold - sessionsUsed,
        ptRevenue: revenue,
        classCount,
        reservationCount,
        contracts: contracts.map((c) => ({
          id: c.id,
          memberName: c.member?.name,
          memberPhone: c.member?.phone,
          totalSessions: c.totalSessions,
          usedSessions: c.usedSessions,
          pricePaid: c.pricePaid,
          createdAt: c.createdAt,
          isActive: c.isActive,
        })),
        classes: t.classes.map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          startAt: c.startAt,
          endAt: c.endAt,
          capacity: c.capacity,
          reservations: c._count.reservations,
        })),
      };
    });

    const summary = {
      trainerCount: rows.length,
      contractCount: rows.reduce((s, r) => s + r.contractCount, 0),
      sessionsUsed: rows.reduce((s, r) => s + r.sessionsUsed, 0),
      ptRevenue: rows.reduce((s, r) => s + r.ptRevenue, 0),
      classCount: rows.reduce((s, r) => s + r.classCount, 0),
    };

    res.json({ status: 'success', data: { rows, summary } });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取教練績效報表失敗' });
  }
});

function dayKey(d) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function accumulatePayBreakdown(target, breakdown, fallbackMethod, amount) {
  if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
    for (const [method, raw] of Object.entries(breakdown)) {
      const n = Number(raw) || 0;
      if (n <= 0) continue;
      target[method] = (target[method] || 0) + n;
    }
    return;
  }
  const method = String(fallbackMethod || 'OTHER').split('+')[0] || 'OTHER';
  const n = Number(amount) || 0;
  if (n > 0) target[method] = (target[method] || 0) + n;
}

// ==========================================
// 銷售分析（彙總，非明細列表）— 限總部 ADMIN
// GET /api/hq/reports/analytics?kind=overview|daily|branch|pay-mix|products|trainer
// ==========================================
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const kind = String(req.query.kind || 'overview').trim().toLowerCase();
    const allowed = new Set(['overview', 'daily', 'branch', 'pay-mix', 'products', 'trainer']);
    if (!allowed.has(kind)) {
      return res.status(400).json({
        status: 'error',
        message: 'kind 無效（overview | daily | branch | pay-mix | products | trainer）',
      });
    }

    const createdAt = parseAnalyticsDateRange(req.query);
    const branchId = parseOptionalInt(req.query.branchId, 'branchId');
    const trainerId = parseOptionalInt(req.query.trainerId, 'trainerId');
    const q = String(req.query.q || '').trim();

    // 教練績效：沿用既有彙總邏輯（與 /trainer 相同資料形狀）
    if (kind === 'trainer') {
      const trainerWhere = {
        ...(trainerId ? { id: trainerId } : {}),
        ...(branchId ? { branches: { some: { branchId } } } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      };

      const trainers = await prisma.trainer.findMany({
        where: trainerWhere,
        take: 200,
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          isActive: true,
          ptContracts: {
            where: { createdAt },
            select: {
              id: true,
              totalSessions: true,
              usedSessions: true,
              pricePaid: true,
              isActive: true,
              createdAt: true,
              member: { select: { id: true, name: true, phone: true } },
            },
          },
          classes: {
            where: { startAt: createdAt },
            select: {
              id: true,
              title: true,
              type: true,
              startAt: true,
              endAt: true,
              capacity: true,
              _count: { select: { reservations: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
      });

      const rows = trainers.map((t) => {
        const contracts = t.ptContracts;
        const contractCount = contracts.length;
        const sessionsSold = contracts.reduce((s, c) => s + c.totalSessions, 0);
        const sessionsUsed = contracts.reduce((s, c) => s + c.usedSessions, 0);
        const revenue = contracts.reduce((s, c) => s + (Number(c.pricePaid) || 0), 0);
        const classCount = t.classes.length;
        const reservationCount = t.classes.reduce((s, c) => s + c._count.reservations, 0);

        return {
          trainerId: t.id,
          trainerName: t.name,
          phone: t.phone,
          role: t.role,
          isActive: t.isActive,
          contractCount,
          sessionsSold,
          sessionsUsed,
          sessionsRemaining: sessionsSold - sessionsUsed,
          ptRevenue: revenue,
          classCount,
          reservationCount,
        };
      });

      const summary = {
        trainerCount: rows.length,
        contractCount: rows.reduce((s, r) => s + r.contractCount, 0),
        sessionsUsed: rows.reduce((s, r) => s + r.sessionsUsed, 0),
        ptRevenue: rows.reduce((s, r) => s + r.ptRevenue, 0),
        classCount: rows.reduce((s, r) => s + r.classCount, 0),
      };

      return res.json({ status: 'success', data: { kind, rows, summary } });
    }

    // 儲值 Order 無 branchId：以 CheckoutSession 或促銷方案# 歸戶分店
    let topupBranchClause = {};
    if (branchId) {
      const [promos, sessions] = await Promise.all([
        prisma.promotion.findMany({
          where: { branchId },
          select: { id: true },
        }),
        prisma.checkoutSession.findMany({
          where: { branchId, createdAt },
          select: { id: true },
          take: 5000,
        }),
      ]);
      const or = [];
      if (sessions.length) {
        or.push({ checkoutSessionId: { in: sessions.map((s) => s.id) } });
      }
      for (const p of promos) {
        or.push({ itemDesc: { contains: `商品#${p.id}` } });
      }
      topupBranchClause = or.length ? { OR: or } : { id: '__no_branch_match__' };
    }

    const topupWhere = {
      status: 'PAID',
      itemDesc: { contains: '商品#' },
      createdAt,
      ...topupBranchClause,
    };
    const salesWhere = {
      status: 'PAID',
      createdAt,
      ...(branchId ? { branchId } : {}),
    };
    // 進出場依 CheckInLog.branchId 篩選（舊資料無分店則僅在「全部分店」時列入）
    const gateWhere = {
      status: 'ACTIVE',
      checkInAt: createdAt,
      ...(branchId ? { branchId } : {}),
    };
    const ptWhere = {
      createdAt,
      ...(branchId
        ? { trainer: { branches: { some: { branchId } } } }
        : {}),
    };

    if (kind === 'overview') {
      const [topupAgg, salesAgg, gateAgg, ptAgg] = await Promise.all([
        prisma.order.aggregate({
          where: topupWhere,
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.saleOrder.aggregate({
          where: salesWhere,
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.checkInLog.aggregate({
          where: gateWhere,
          _sum: { fee: true },
          _count: { _all: true },
        }),
        prisma.pTContract.aggregate({
          where: ptWhere,
          _sum: { pricePaid: true },
          _count: { _all: true },
        }),
      ]);

      const topupAmount = Number(topupAgg._sum.amount) || 0;
      const salesAmount = Number(salesAgg._sum.amount) || 0;
      const gateFee = Number(gateAgg._sum.fee) || 0;
      const ptRevenue = Number(ptAgg._sum.pricePaid) || 0;
      const totalRevenue = topupAmount + salesAmount + gateFee + ptRevenue;

      const rows = [
        { metric: '儲值營收', amount: topupAmount, count: topupAgg._count._all },
        { metric: '商品銷售', amount: salesAmount, count: salesAgg._count._all },
        { metric: '進出場費用', amount: gateFee, count: gateAgg._count._all },
        { metric: '私教合約', amount: ptRevenue, count: ptAgg._count._all },
      ];

      return res.json({
        status: 'success',
        data: {
          kind,
          rows,
          summary: {
            topupAmount,
            topupCount: topupAgg._count._all,
            salesAmount,
            salesCount: salesAgg._count._all,
            gateFee,
            gateCount: gateAgg._count._all,
            ptRevenue,
            ptContractCount: ptAgg._count._all,
            totalRevenue,
          },
        },
      });
    }

    if (kind === 'daily') {
      const [topups, sales, gates, ptContracts] = await Promise.all([
        prisma.order.findMany({
          where: topupWhere,
          select: { amount: true, createdAt: true },
        }),
        prisma.saleOrder.findMany({
          where: salesWhere,
          select: { amount: true, createdAt: true },
        }),
        prisma.checkInLog.findMany({
          where: gateWhere,
          select: { fee: true, checkInAt: true },
        }),
        prisma.pTContract.findMany({
          where: ptWhere,
          select: { pricePaid: true, createdAt: true },
        }),
      ]);

      const map = new Map();
      function bump(date, field, value) {
        const key = dayKey(date);
        if (!key) return;
        if (!map.has(key)) {
          map.set(key, {
            date: key,
            topupAmount: 0,
            salesAmount: 0,
            gateFee: 0,
            ptRevenue: 0,
            total: 0,
          });
        }
        const row = map.get(key);
        row[field] += value;
        row.total += value;
      }

      for (const o of topups) bump(o.createdAt, 'topupAmount', Number(o.amount) || 0);
      for (const s of sales) bump(s.createdAt, 'salesAmount', Number(s.amount) || 0);
      for (const g of gates) bump(g.checkInAt, 'gateFee', Number(g.fee) || 0);
      for (const p of ptContracts) bump(p.createdAt, 'ptRevenue', Number(p.pricePaid) || 0);

      const rows = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
      const summary = {
        dayCount: rows.length,
        totalRevenue: rows.reduce((s, r) => s + r.total, 0),
        topupAmount: rows.reduce((s, r) => s + r.topupAmount, 0),
        salesAmount: rows.reduce((s, r) => s + r.salesAmount, 0),
        gateFee: rows.reduce((s, r) => s + r.gateFee, 0),
        ptRevenue: rows.reduce((s, r) => s + r.ptRevenue, 0),
      };

      return res.json({ status: 'success', data: { kind, rows, summary } });
    }

    if (kind === 'branch') {
      const sales = await prisma.saleOrder.findMany({
        where: salesWhere,
        select: {
          amount: true,
          branchId: true,
          branch: { select: { id: true, name: true, code: true } },
          items: { select: { qty: true } },
        },
      });

      const map = new Map();
      for (const s of sales) {
        const id = s.branchId;
        if (!map.has(id)) {
          map.set(id, {
            branchId: id,
            branchName: staffBranchLabel(s.branch) || `#${id}`,
            salesAmount: 0,
            salesCount: 0,
            itemQty: 0,
          });
        }
        const row = map.get(id);
        row.salesAmount += Number(s.amount) || 0;
        row.salesCount += 1;
        row.itemQty += s.items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
      }

      const rows = [...map.values()].sort((a, b) => b.salesAmount - a.salesAmount);
      const summary = {
        branchCount: rows.length,
        salesAmount: rows.reduce((s, r) => s + r.salesAmount, 0),
        salesCount: rows.reduce((s, r) => s + r.salesCount, 0),
        itemQty: rows.reduce((s, r) => s + r.itemQty, 0),
      };

      return res.json({ status: 'success', data: { kind, rows, summary } });
    }

    if (kind === 'pay-mix') {
      const [topups, sales] = await Promise.all([
        prisma.order.findMany({
          where: topupWhere,
          select: { amount: true, payMethod: true, payBreakdown: true },
        }),
        prisma.saleOrder.findMany({
          where: salesWhere,
          select: { amount: true, payMethod: true, payBreakdown: true },
        }),
      ]);

      const bag = {};
      for (const o of topups) accumulatePayBreakdown(bag, o.payBreakdown, o.payMethod, o.amount);
      for (const s of sales) accumulatePayBreakdown(bag, s.payBreakdown, s.payMethod, s.amount);

      const total = Object.values(bag).reduce((s, n) => s + n, 0);
      const rows = Object.entries(bag)
        .map(([method, amount]) => ({
          method,
          amount,
          share: total > 0 ? Math.round((amount / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.amount - a.amount);

      return res.json({
        status: 'success',
        data: {
          kind,
          rows,
          summary: { totalAmount: total, methodCount: rows.length },
        },
      });
    }

    // products
    const sales = await prisma.saleOrder.findMany({
      where: salesWhere,
      select: {
        items: {
          select: {
            productId: true,
            name: true,
            qty: true,
            lineTotal: true,
          },
        },
      },
    });

    const map = new Map();
    for (const s of sales) {
      for (const item of s.items) {
        const id = item.productId;
        if (!map.has(id)) {
          map.set(id, {
            productId: id,
            name: item.name,
            qty: 0,
            amount: 0,
          });
        }
        const row = map.get(id);
        row.qty += Number(item.qty) || 0;
        row.amount += Number(item.lineTotal) || 0;
      }
    }

    const rows = [...map.values()].sort((a, b) => b.amount - a.amount).slice(0, 50);
    const summary = {
      productCount: rows.length,
      itemQty: rows.reduce((s, r) => s + r.qty, 0),
      salesAmount: rows.reduce((s, r) => s + r.amount, 0),
    };

    return res.json({ status: 'success', data: { kind, rows, summary } });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取銷售分析失敗' });
  }
});

/** GET /api/hq/reports/analytics/yoy?year= — 歷年同月門票銷售比較 */
router.get('/analytics/yoy', requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const months = [];
    for (let m = 1; m <= 12; m += 1) {
      const from = new Date(year, m - 1, 1);
      const to = new Date(year, m, 0, 23, 59, 59, 999);
      const agg = await prisma.order.aggregate({
        where: {
          status: 'PAID',
          createdAt: { gte: from, lte: to },
        },
        _sum: { amount: true },
        _count: { id: true },
      });
      months.push({
        month: m,
        amount: agg._sum.amount || 0,
        count: agg._count.id || 0,
      });
    }
    const prevYear = year - 1;
    const prevMonths = [];
    for (let m = 1; m <= 12; m += 1) {
      const from = new Date(prevYear, m - 1, 1);
      const to = new Date(prevYear, m, 0, 23, 59, 59, 999);
      const agg = await prisma.order.aggregate({
        where: { status: 'PAID', createdAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: { id: true },
      });
      prevMonths.push({ month: m, amount: agg._sum.amount || 0, count: agg._count.id || 0 });
    }
    return res.json({
      status: 'success',
      data: { year, months, prevYear, prevMonths },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: 'error', message: '歷年比較失敗' });
  }
});

/** GET /api/hq/reports/analytics/members — 會員分析 */
router.get('/analytics/members', requireAdmin, async (req, res) => {
  try {
    const range = parseAnalyticsDateRange(req.query);
    const from = range.from;
    const to = range.to;

    const [newMembers, checkIns, activeNow, genderBreakdown] = await Promise.all([
      prisma.member.count({ where: { createdAt: { gte: from, lte: to } } }),
      prisma.checkInLog.findMany({
        where: { checkInAt: { gte: from, lte: to }, status: 'ACTIVE' },
        select: { memberId: true, checkInAt: true, checkOutAt: true },
      }),
      prisma.checkInLog.count({
        where: { status: 'ACTIVE', checkOutAt: null },
      }),
      prisma.member.groupBy({
        by: ['gender'],
        _count: { id: true },
      }),
    ]);

    const uniqueVisitors = new Set(checkIns.map((c) => c.memberId)).size;
    let totalMinutes = 0;
    let completed = 0;
    for (const c of checkIns) {
      if (c.checkOutAt) {
        totalMinutes += (c.checkOutAt - c.checkInAt) / 60000;
        completed += 1;
      }
    }
    const avgStayMinutes = completed > 0 ? Math.round(totalMinutes / completed) : 0;

    const dailyMap = new Map();
    for (const c of checkIns) {
      const key = c.checkInAt.toISOString().slice(0, 10);
      dailyMap.set(key, (dailyMap.get(key) || 0) + 1);
    }
    const dailyVisits = [...dailyMap.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return res.json({
      status: 'success',
      data: {
        from,
        to,
        newMembers,
        uniqueVisitors,
        visitCount: checkIns.length,
        avgStayMinutes,
        currentlyInGym: activeNow,
        dailyVisits,
        genderBreakdown: genderBreakdown.map((g) => ({
          gender: g.gender || 'UNKNOWN',
          count: g._count.id,
        })),
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '會員分析失敗' });
  }
});

/** GET /api/hq/reports/card-subscriptions/batch — 信用卡扣款批次明細 */
router.get('/card-subscriptions/batch', requireDutyOrAbove, async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    const where = {};
    if (range) where.attemptedAt = range;
    const charges = await prisma.cardSubscriptionCharge.findMany({
      where,
      include: {
        subscription: {
          select: {
            id: true,
            memberId: true,
            periodType: true,
            status: true,
            member: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
    });
    const summary = {
      total: charges.length,
      paid: charges.filter((c) => c.status === 'PAID').length,
      failed: charges.filter((c) => c.status === 'FAILED').length,
      pending: charges.filter((c) => c.status === 'PENDING').length,
    };
    return res.json({ status: 'success', data: { charges, summary } });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '扣款批次查詢失敗' });
  }
});

/** GET /api/hq/reports/group-class-crm — 團課 CRM：到課率／請假率／補課／續約代理指標 */
router.get('/group-class-crm', requireOpsOrDuty, async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;
    const classWhere = {
      type: 'GROUP',
      ...(range ? { startAt: range } : {}),
      ...(branchId
        ? { venue: { branchId } }
        : {}),
    };

    const classes = await prisma.class.findMany({
      where: classWhere,
      select: {
        id: true,
        title: true,
        startAt: true,
        capacity: true,
        trainerId: true,
        venue: { select: { branchId: true, name: true, branch: { select: { name: true, code: true } } } },
        trainer: { select: { id: true, displayName: true, name: true } },
        reservations: {
          select: {
            id: true,
            status: true,
            memberId: true,
            classLeave: { select: { id: true, status: true, withinPolicy: true } },
            attendance: { select: { id: true, checkedInAt: true } },
          },
        },
        makeupSlots: {
          select: {
            id: true,
            capacity: true,
            _count: { select: { registrations: true } },
          },
        },
      },
      orderBy: { startAt: 'desc' },
      take: 500,
    });

    const rows = classes.map((c) => {
      const booked = c.reservations.filter((r) =>
        ['PENDING', 'CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(String(r.status || '').toUpperCase()) ||
        r.status,
      );
      const reserved = c.reservations.length;
      const attended = c.reservations.filter((r) => r.attendance).length;
      const left = c.reservations.filter((r) => r.classLeave).length;
      const makeupReg = c.makeupSlots.reduce((s, m) => s + (m._count?.registrations || 0), 0);
      const attendanceRate = reserved > 0 ? Math.round((attended / reserved) * 1000) / 10 : 0;
      const leaveRate = reserved > 0 ? Math.round((left / reserved) * 1000) / 10 : 0;
      return {
        classId: c.id,
        title: c.title,
        startAt: c.startAt,
        capacity: c.capacity,
        branchName: c.venue?.branch?.name || null,
        venueName: c.venue?.name || null,
        trainerName: c.trainer?.displayName || c.trainer?.name || null,
        reserved,
        attended,
        left,
        makeupRegistrations: makeupReg,
        attendanceRate,
        leaveRate,
        fillRate:
          c.capacity > 0 ? Math.round((reserved / c.capacity) * 1000) / 10 : 0,
      };
    });

    // 續課代理：區間內有 GROUP 預約的會員，對照是否另有更新的 PT／購案（簡化）
    const memberIds = [
      ...new Set(
        classes.flatMap((c) =>
          c.reservations.map((r) => r.memberId).filter(Boolean),
        ),
      ),
    ];
    let renewProxy = { membersWithClass: memberIds.length, membersWithNewPurchase: 0, rate: 0 };
    if (memberIds.length) {
      const since = range?.gte || new Date(Date.now() - 90 * 86400000);
      const purchasers = await prisma.order.findMany({
        where: {
          memberId: { in: memberIds },
          status: 'PAID',
          createdAt: { gte: since },
          itemDesc: { contains: '課程' },
        },
        select: { memberId: true },
        distinct: ['memberId'],
      });
      const ptBuyers = await prisma.pTContract.findMany({
        where: {
          memberId: { in: memberIds },
          source: 'PURCHASE',
          createdAt: { gte: since },
        },
        select: { memberId: true },
        distinct: ['memberId'],
      });
      const renewed = new Set([
        ...purchasers.map((p) => p.memberId),
        ...ptBuyers.map((p) => p.memberId),
      ]);
      renewProxy = {
        membersWithClass: memberIds.length,
        membersWithNewPurchase: renewed.size,
        rate:
          memberIds.length > 0
            ? Math.round((renewed.size / memberIds.length) * 1000) / 10
            : 0,
      };
    }

    const summary = {
      classCount: rows.length,
      reserved: rows.reduce((s, r) => s + r.reserved, 0),
      attended: rows.reduce((s, r) => s + r.attended, 0),
      left: rows.reduce((s, r) => s + r.left, 0),
      avgAttendanceRate:
        rows.length > 0
          ? Math.round(
              (rows.reduce((s, r) => s + r.attendanceRate, 0) / rows.length) * 10,
            ) / 10
          : 0,
      avgLeaveRate:
        rows.length > 0
          ? Math.round((rows.reduce((s, r) => s + r.leaveRate, 0) / rows.length) * 10) / 10
          : 0,
      renewProxy,
    };

    return res.json({ status: 'success', data: { rows, summary } });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: 'error', message: '團課 CRM 查詢失敗' });
  }
});

export default router;
