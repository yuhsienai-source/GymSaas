// lib/yipayCapture.js — 乙禾端末成功後、後端認列前的暫存池（防孤兒交易）
import prisma from './prisma.js';

function httpError(message, statusCode = 400, code = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function newId() {
  return `YCAP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 自 payBreakdown／payMethod 取出 YIPAY 金額；非乙禾回 0 */
export function extractYipayAmount(row) {
  const breakdown =
    row?.payBreakdown && typeof row.payBreakdown === 'object' && !Array.isArray(row.payBreakdown)
      ? row.payBreakdown
      : {};
  const fromBreakdown = Number(breakdown.YIPAY) || 0;
  if (fromBreakdown > 0) return roundMoney(fromBreakdown);
  const pay = String(row?.payMethod || '').toUpperCase();
  if (pay.includes('YIPAY')) return roundMoney(row?.amount);
  return 0;
}

/**
 * 端末顯示成功後立刻寫入暫存（confirm 前／斷線可對帳）
 */
export async function stageYipayCapture({
  targetType,
  targetId,
  amount,
  rrn = null,
  authCode = null,
  cardLast4 = null,
  branchId = null,
  staffId = null,
  terminalRef = null,
  raw = null,
}) {
  const type = String(targetType || '').toUpperCase();
  const id = String(targetId || '').trim();
  if (!['ORDER', 'SALE', 'CHECKOUT'].includes(type) || !id) {
    throw httpError('targetType/targetId 無效');
  }
  const amt = Number(amount);
  if (!(amt > 0)) throw httpError('amount 必須 > 0');

  if (rrn) {
    const dup = await prisma.yipayTerminalCapture.findFirst({
      where: { rrn: String(rrn), status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
    });
    if (dup) return dup;
  }

  return prisma.yipayTerminalCapture.create({
    data: {
      id: newId(),
      targetType: type,
      targetId: id,
      amount: amt,
      rrn: rrn ? String(rrn) : null,
      authCode: authCode ? String(authCode) : null,
      cardLast4: cardLast4 ? String(cardLast4).slice(-4) : null,
      branchId: branchId != null ? Number(branchId) : null,
      staffId: staffId != null ? Number(staffId) : null,
      terminalRef: terminalRef ? String(terminalRef).slice(0, 120) : null,
      status: 'PENDING_CONFIRM',
      raw: raw && typeof raw === 'object' ? raw : undefined,
    },
  });
}

/** confirm 成功後標記對應暫存為 CONFIRMED */
export async function markYipayCaptureConfirmed({ targetType, targetId, terminalRef = null }) {
  const type = String(targetType || '').toUpperCase();
  const id = String(targetId || '').trim();
  const pending = await prisma.yipayTerminalCapture.findMany({
    where: {
      targetType: type,
      targetId: id,
      status: 'PENDING_CONFIRM',
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  if (!pending.length && terminalRef) {
    const byRef = await prisma.yipayTerminalCapture.findMany({
      where: { terminalRef: String(terminalRef), status: 'PENDING_CONFIRM' },
      take: 5,
    });
    pending.push(...byRef);
  }
  for (const row of pending) {
    await prisma.yipayTerminalCapture.update({
      where: { id: row.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
  }
  return pending.length;
}

export async function listYipayCaptures({ status, branchId, take = 50 } = {}) {
  return prisma.yipayTerminalCapture.findMany({
    where: {
      ...(status ? { status: String(status).toUpperCase() } : {}),
      ...(branchId != null ? { branchId: Number(branchId) } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Number(take) || 50),
  });
}

/**
 * 彙總當日系統已認列 YIPAY（CHK／獨立 SAL／ORDER，避免雙計合併結帳子單）
 */
async function loadSystemYipayPaid(start, end, branchId) {
  const branchFilter = branchId != null ? { branchId: Number(branchId) } : {};
  const timeFilter = { gte: start, lte: end };

  const [sessions, sales, orders] = await Promise.all([
    prisma.checkoutSession.findMany({
      where: { status: 'PAID', createdAt: timeFilter, ...branchFilter },
      select: {
        id: true,
        amount: true,
        payMethod: true,
        payBreakdown: true,
        createdAt: true,
        merchantNo: true,
      },
    }),
    prisma.saleOrder.findMany({
      where: {
        status: 'PAID',
        createdAt: timeFilter,
        checkoutSessionId: null,
        ...branchFilter,
      },
      select: {
        id: true,
        amount: true,
        payMethod: true,
        payBreakdown: true,
        createdAt: true,
        merchantNo: true,
      },
    }),
    prisma.order.findMany({
      where: {
        status: 'PAID',
        createdAt: timeFilter,
        checkoutSessionId: null,
        ...(branchId != null
          ? {
              OR: [
                { itemDesc: { contains: `分店#${branchId}` } },
                { merchantNo: { startsWith: 'YIPAY:' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        amount: true,
        payMethod: true,
        payBreakdown: true,
        createdAt: true,
        merchantNo: true,
      },
      take: 500,
    }),
  ]);

  const items = [];
  for (const row of sessions) {
    const amt = extractYipayAmount(row);
    if (amt > 0) {
      items.push({
        kind: 'CHECKOUT',
        id: row.id,
        amount: amt,
        createdAt: row.createdAt,
        merchantNo: row.merchantNo,
      });
    }
  }
  for (const row of sales) {
    const amt = extractYipayAmount(row);
    if (amt > 0) {
      items.push({
        kind: 'SALE',
        id: row.id,
        amount: amt,
        createdAt: row.createdAt,
        merchantNo: row.merchantNo,
      });
    }
  }
  for (const row of orders) {
    const amt = extractYipayAmount(row);
    if (amt > 0) {
      items.push({
        kind: 'ORDER',
        id: row.id,
        amount: amt,
        createdAt: row.createdAt,
        merchantNo: row.merchantNo,
      });
    }
  }

  const amount = roundMoney(items.reduce((s, i) => s + i.amount, 0));
  return { count: items.length, amount, items };
}

/**
 * 日結：系統已認列 YIPAY vs 暫存／孤兒；可帶 EDC 結算單筆數／金額比對
 */
export async function reconcileYipayDay(
  dayIso,
  { branchId = null, edcCount = null, edcAmount = null } = {},
) {
  const day = dayIso ? new Date(dayIso) : new Date();
  if (Number.isNaN(day.getTime())) throw httpError('日期無效');
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);

  const whereBase = {
    createdAt: { gte: start, lte: end },
    ...(branchId != null ? { branchId: Number(branchId) } : {}),
  };

  const [pending, confirmedRows, orphans, system] = await Promise.all([
    prisma.yipayTerminalCapture.findMany({
      where: { ...whereBase, status: 'PENDING_CONFIRM' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.yipayTerminalCapture.findMany({
      where: { ...whereBase, status: 'CONFIRMED' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.yipayTerminalCapture.findMany({
      where: { ...whereBase, status: 'ORPHAN' },
      orderBy: { createdAt: 'asc' },
    }),
    loadSystemYipayPaid(start, end, branchId),
  ]);

  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const staleIds = pending.filter((p) => p.createdAt < staleBefore).map((p) => p.id);
  if (staleIds.length) {
    await prisma.yipayTerminalCapture.updateMany({
      where: { id: { in: staleIds } },
      data: { status: 'ORPHAN' },
    });
  }

  const refreshedPending = await prisma.yipayTerminalCapture.findMany({
    where: { ...whereBase, status: 'PENDING_CONFIRM' },
    orderBy: { createdAt: 'asc' },
  });
  const refreshedOrphans = await prisma.yipayTerminalCapture.findMany({
    where: { ...whereBase, status: 'ORPHAN' },
    orderBy: { createdAt: 'asc' },
  });

  const confirmedAmount = roundMoney(confirmedRows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const pendingAmount = roundMoney(
    refreshedPending.reduce((s, r) => s + (Number(r.amount) || 0), 0),
  );

  const hints = [];
  if (refreshedPending.length) {
    hints.push(
      `有 ${refreshedPending.length} 筆端末成功但尚未 opsConfirmYipay（$${pendingAmount}），請補登認列`,
    );
  }
  if (refreshedOrphans.length) {
    hints.push(`有 ${refreshedOrphans.length} 筆標記為 ORPHAN，請主管查核刷卡機結算單`);
  }

  const edcC = edcCount != null && edcCount !== '' ? Number(edcCount) : null;
  const edcA = edcAmount != null && edcAmount !== '' ? Number(edcAmount) : null;
  let edcCompare = null;
  if (edcC != null && Number.isFinite(edcC) && edcA != null && Number.isFinite(edcA)) {
    const countDiff = edcC - system.count;
    const amountDiff = roundMoney(edcA - system.amount);
    edcCompare = {
      edcCount: edcC,
      edcAmount: roundMoney(edcA),
      systemCount: system.count,
      systemAmount: system.amount,
      countDiff,
      amountDiff,
      matched: countDiff === 0 && Math.abs(amountDiff) < 0.01,
    };
    if (countDiff > 0 || amountDiff > 0.01) {
      hints.push(
        `刷卡機結算單多於系統（筆數差 ${countDiff}／金額差 $${amountDiff}）：疑似 EDC 成功但系統無單，請主管補登`,
      );
    } else if (countDiff < 0 || amountDiff < -0.01) {
      hints.push(
        `系統多於刷卡機結算單（筆數差 ${countDiff}／金額差 $${amountDiff}）：請核對是否重複認列或錯選支付方式`,
      );
    }
  }

  return {
    day: start.toISOString().slice(0, 10),
    branchId: branchId != null ? Number(branchId) : null,
    system,
    captures: {
      confirmedCount: confirmedRows.length,
      confirmedAmount,
      pendingCount: refreshedPending.length,
      pendingAmount,
      orphanCount: refreshedOrphans.length,
      pending: refreshedPending,
      orphans: refreshedOrphans,
      confirmed: confirmedRows,
    },
    // 相容舊欄位
    confirmedCount: confirmedRows.length,
    pendingCount: refreshedPending.length,
    orphanCount: refreshedOrphans.length,
    pending: refreshedPending,
    orphans: refreshedOrphans,
    edcCompare,
    hints,
    needsAttention:
      refreshedPending.length > 0 ||
      refreshedOrphans.length > 0 ||
      (edcCompare ? !edcCompare.matched : false),
  };
}

export async function markYipayCaptureOrphan(captureId, note = null) {
  return prisma.yipayTerminalCapture.update({
    where: { id: String(captureId) },
    data: {
      status: 'ORPHAN',
      raw: note ? { note } : undefined,
    },
  });
}
