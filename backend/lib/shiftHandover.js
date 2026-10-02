// lib/shiftHandover.js — 櫃檯交接班：早／晚兩班次＋少輸入對帳
import prisma from './prisma.js';
import { positionLabel } from './orgStructure.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function generateShiftId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `SHF${dateStr}${randomStr}`;
}

/** @typedef {'MORNING'|'EVENING'|'MIDDAY'} ShiftSlot */

/** 可開班班別（兩班制） */
export const SHIFT_SLOTS = [
  { key: 'MORNING', label: '早班', short: '早', hint: '07:00–15:30' },
  { key: 'EVENING', label: '晚班', short: '晚', hint: '15:30–00:00' },
];

/** 歷史中班紀錄仍可顯示標籤 */
const LEGACY_SLOT_LABELS = {
  MIDDAY: { key: 'MIDDAY', label: '中班（舊）', short: '中', hint: '歷史班別' },
};

const SLOT_KEYS = new Set(['MORNING', 'EVENING']);

/** 支付方式顯示順序與中文標籤（分欄固定，金額 0 也列出） */
export const PAY_METHOD_COLUMNS = [
  { key: 'CASH', label: '現金' },
  { key: 'YIPAY', label: '乙禾現場刷卡' },
  { key: 'CARD', label: 'PayUNi 刷卡／定期' },
  { key: 'LINEPAY', label: 'LinePay' },
  { key: 'WALLET_CASH', label: '零錢包' },
  { key: 'VOUCHER', label: '抵用券' },
];

/** 台幣常用面額（超商式點鈔） */
export const CASH_DENOMINATIONS = [1000, 500, 200, 100, 50, 10, 5, 1];

export function normalizeCashDenominations(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const counts = {};
  let total = 0;
  for (const d of CASH_DENOMINATIONS) {
    const n = Math.max(0, Math.floor(Number(src[d] ?? src[String(d)]) || 0));
    counts[d] = n;
    total = roundMoney(total + n * d);
  }
  return { counts, total, rows: CASH_DENOMINATIONS.map((d) => ({ denom: d, count: counts[d], subtotal: counts[d] * d })) };
}

export const CLOSE_CHECKLIST_KEYS = [
  { key: 'cashCounted', label: '錢櫃現金已逐面額清點' },
  { key: 'cardSettled', label: '刷卡／信用卡班報已核對' },
  { key: 'voucherChecked', label: '抵用券／禮券已清點' },
  { key: 'drawerReady', label: '錢櫃已歸位、交班單已確認' },
];

export function normalizeCloseChecklist(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const item of CLOSE_CHECKLIST_KEYS) {
    out[item.key] = src[item.key] === true || src[item.key] === 'true';
  }
  return out;
}

export function formatShiftOperator(name, role) {
  const n = String(name || '員工').trim() || '員工';
  const roleZh = positionLabel(role) || '員工';
  return `${n}（${roleZh}）`.slice(0, 80);
}

export function normalizePayMixColumns(payMix) {
  const src = payMix && typeof payMix === 'object' ? payMix : {};
  const known = new Set(PAY_METHOD_COLUMNS.map((c) => c.key));
  const rows = PAY_METHOD_COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    amount: roundMoney(src[c.key] || 0),
  }));
  for (const [k, v] of Object.entries(src)) {
    if (known.has(k)) continue;
    const n = roundMoney(v);
    if (n === 0) continue;
    rows.push({ key: k, label: k, amount: n });
  }
  return rows;
}

export function normalizeShiftSlot(raw) {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  if (!SLOT_KEYS.has(v)) {
    const err = new Error('請選擇班別：早班／晚班（MORNING｜EVENING）');
    err.statusCode = 400;
    throw err;
  }
  return /** @type {ShiftSlot} */ (v);
}

export function shiftSlotLabel(slot) {
  const key = String(slot || '').toUpperCase();
  const found = SHIFT_SLOTS.find((s) => s.key === key) || LEGACY_SLOT_LABELS[key];
  return found?.label || slot || '—';
}

/** 台北日曆 YYYY-MM-DD */
export function taipeiYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date instanceof Date ? date : new Date(date));
}

/** 台北當日 0 點（UTC Date）與隔日 0 點 */
export function taipeiDayRange(ymd = taipeiYmd()) {
  const start = new Date(`${ymd}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, ymd };
}

/** 依台北時間建議班別：早班 07:00–15:30；晚班 15:30–07:00（含午夜後） */
export function suggestShiftSlot(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const mins = hour * 60 + minute;
  const morningStart = 7 * 60; // 07:00
  const eveningStart = 15 * 60 + 30; // 15:30
  if (mins >= morningStart && mins < eveningStart) return 'MORNING';
  return 'EVENING';
}

export function accumulatePayBreakdown(target, breakdown, fallbackMethod, amount) {
  if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
    for (const [method, raw] of Object.entries(breakdown)) {
      const n = Number(raw) || 0;
      if (n <= 0) continue;
      target[method] = roundMoney((target[method] || 0) + n);
    }
    return;
  }
  const method = String(fallbackMethod || 'OTHER').split('+')[0] || 'OTHER';
  const n = Number(amount) || 0;
  if (n > 0) target[method] = roundMoney((target[method] || 0) + n);
}

/**
 * 彙總分店時段內已付款交易（錢櫃對帳用）
 * carryFrom＝上一班交班時間：上一班建立、交班後才完成付款（乙禾確認、線上刷卡回呼）之交易併入本班。
 */
export async function buildShiftSummary({ branchId, from, to, carryFrom = null } = {}, db = prisma) {
  const bid = Number(branchId);
  if (!Number.isInteger(bid) || bid <= 0) {
    const err = new Error('請指定分店 branchId');
    err.statusCode = 400;
    throw err;
  }
  const fromAt = from instanceof Date ? from : new Date(from);
  const toAt = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime())) {
    const err = new Error('時間區間無效');
    err.statusCode = 400;
    throw err;
  }
  if (fromAt > toAt) {
    const err = new Error('開始時間不可晚於結束時間');
    err.statusCode = 400;
    throw err;
  }

  const range = { gte: fromAt, lte: toAt };
  const carryAt = carryFrom ? new Date(carryFrom) : null;
  const paidInWindow =
    carryAt && !Number.isNaN(carryAt.getTime()) && carryAt < fromAt
      ? {
          OR: [
            { updatedAt: range },
            { updatedAt: { gt: carryAt, lt: fromAt }, createdAt: { lte: carryAt } },
          ],
        }
      : { updatedAt: range };

  const [sessions, orphanSales, cashRefunds, orphanTopups] = await Promise.all([
    db.checkoutSession.findMany({
      where: {
        branchId: bid,
        status: 'PAID',
        ...paidInWindow,
      },
      select: {
        id: true,
        amount: true,
        payMethod: true,
        payBreakdown: true,
        saleOrderId: true,
        orderId: true,
        itemDesc: true,
      },
    }),
    // 退費單退貨之銷貨仍計入原收款班（退款另列 cashRefund 扣除）
    db.saleOrder.findMany({
      where: {
        branchId: bid,
        OR: [{ status: 'PAID' }, { status: 'CANCELLED', refundedAmount: { gt: 0 } }],
        checkoutSessionId: null,
        createdAt: range,
      },
      select: {
        id: true,
        amount: true,
        payMethod: true,
        payBreakdown: true,
      },
    }),
    // 退費單之現金退款腿（交易內綁定進行中班次；依退款完成時間歸屬）
    db.refundPayment.findMany({
      where: {
        method: 'CASH',
        status: 'REFUNDED',
        refundedAt: range,
        refund: { branchId: bid },
      },
      select: { id: true, amount: true, refundId: true },
    }),
    // 單獨臨櫃儲值／購案（POST /ops/topup，不經合併結帳）
    db.order.findMany({
      where: {
        branchId: bid,
        checkoutSessionId: null,
        itemDesc: { startsWith: '臨櫃' },
        OR: [
          { status: 'PAID', ...paidInWindow },
          { status: 'REFUNDED', refundedAmount: { gt: 0 }, createdAt: range },
        ],
      },
      select: { id: true, amount: true, payMethod: true, payBreakdown: true },
    }),
  ]);

  const linkedOrderIds = sessions.map((s) => s.orderId).filter(Boolean);

  let linkedOrders = [];
  if (linkedOrderIds.length) {
    linkedOrders = await db.order.findMany({
      where: { id: { in: linkedOrderIds }, status: 'PAID' },
      select: { id: true, amount: true, payMethod: true, payBreakdown: true },
    });
  }

  const payMix = {};
  let checkoutAmount = 0;
  let checkoutCount = 0;
  let salesCount = 0;
  let topupAmount = 0;
  let topupCount = 0;

  for (const s of sessions) {
    checkoutCount += 1;
    checkoutAmount = roundMoney(checkoutAmount + (Number(s.amount) || 0));
    accumulatePayBreakdown(payMix, s.payBreakdown, s.payMethod, s.amount);
    if (s.saleOrderId) salesCount += 1;
    if (s.orderId) topupCount += 1;
  }

  let orphanSaleAmount = 0;
  for (const sale of orphanSales) {
    salesCount += 1;
    orphanSaleAmount = roundMoney(orphanSaleAmount + (Number(sale.amount) || 0));
    accumulatePayBreakdown(payMix, sale.payBreakdown, sale.payMethod, sale.amount);
  }
  let salesAmount = orphanSaleAmount;

  for (const o of linkedOrders) {
    topupAmount = roundMoney(topupAmount + (Number(o.amount) || 0));
  }

  let orphanTopupAmount = 0;
  for (const o of orphanTopups) {
    topupCount += 1;
    orphanTopupAmount = roundMoney(orphanTopupAmount + (Number(o.amount) || 0));
    accumulatePayBreakdown(payMix, o.payBreakdown, o.payMethod, o.amount);
  }
  topupAmount = roundMoney(topupAmount + orphanTopupAmount);
  const sessionSaleIds = sessions.map((s) => s.saleOrderId).filter(Boolean);
  if (sessionSaleIds.length) {
    const linkedSales = await db.saleOrder.findMany({
      where: { id: { in: sessionSaleIds } },
      select: { amount: true },
    });
    for (const s of linkedSales) {
      salesAmount = roundMoney(salesAmount + (Number(s.amount) || 0));
    }
  }

  const cashIn = roundMoney(payMix.CASH || 0);
  const yipayIn = roundMoney(payMix.YIPAY || 0);
  const cardIn = roundMoney(payMix.CARD || 0);
  const linePayIn = roundMoney(payMix.LINEPAY || 0);
  const voucherIn = roundMoney(payMix.VOUCHER || 0);
  const walletIn = roundMoney(payMix.WALLET_CASH || 0);

  const cashRefund = roundMoney(cashRefunds.reduce((s, r) => s + (Number(r.amount) || 0), 0));

  const payMixFull = {
    CASH: cashIn,
    YIPAY: yipayIn,
    CARD: cardIn,
    LINEPAY: linePayIn,
    VOUCHER: voucherIn,
    WALLET_CASH: walletIn,
    ...Object.fromEntries(
      Object.entries(payMix).filter(
        ([k]) => !['CASH', 'YIPAY', 'CARD', 'LINEPAY', 'VOUCHER', 'WALLET_CASH'].includes(k),
      ),
    ),
  };

  return {
    branchId: bid,
    from: fromAt.toISOString(),
    to: toAt.toISOString(),
    payMix: payMixFull,
    payMixColumns: normalizePayMixColumns(payMixFull),
    cashIn,
    cashRefund,
    totals: {
      checkoutCount,
      checkoutAmount: roundMoney(checkoutAmount),
      salesCount,
      salesAmount: roundMoney(salesAmount),
      topupCount,
      topupAmount: roundMoney(topupAmount),
      paidTxnCount: checkoutCount + orphanSales.length + orphanTopups.length,
      paidTxnAmount: roundMoney(checkoutAmount + orphanSaleAmount + orphanTopupAmount),
    },
    refunds: {
      count: cashRefunds.length,
      cashOut: cashRefund,
      note: '退費單現金退款已自應有現金扣除（線上／乙禾退款不經錢櫃）',
    },
    gateNote: '進出場費用由零錢包扣除，不計入錢櫃現金',
  };
}

export async function getOpenShift(branchId) {
  return prisma.shiftHandover.findFirst({
    where: { branchId: Number(branchId), status: 'OPEN' },
    orderBy: { startedAt: 'desc' },
  });
}

export const SHIFT_NOT_OPEN_MESSAGE = '尚未開班：請先至「交接班結算」開班並確認備用金後再結帳';

function shiftConflict(code, message) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

/**
 * 臨櫃收款前置：須在建立訂單／銷貨之交易內呼叫。
 * 以 FOR SHARE 鎖定分店進行中班次；交班以 FOR UPDATE 互斥，
 * 收款不是在交班前提交（計入該班），就是等交班完成後因無進行中班次被拒。
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 */
export async function lockOpenShiftForSale(tx, branchId) {
  const bid = Number(branchId);
  if (!Number.isInteger(bid) || bid <= 0) {
    throw shiftConflict('SHIFT_BRANCH_REQUIRED', '無法判定收款分店，不能確認開班狀態；請指定分店後再結帳');
  }
  const rows = await tx.$queryRaw`
    SELECT id FROM "ShiftHandover"
    WHERE "branchId" = ${bid} AND status = 'OPEN'
    ORDER BY "startedAt" DESC
    LIMIT 1
    FOR SHARE
  `;
  if (!rows[0]) throw shiftConflict('SHIFT_NOT_OPEN', SHIFT_NOT_OPEN_MESSAGE);
  return rows[0].id;
}

/** 同分店上一班交班時間（本班開班前），供 buildShiftSummary carryFrom */
export async function previousShiftEnd(shift, db = prisma) {
  const prev = await db.shiftHandover.findFirst({
    where: {
      branchId: shift.branchId,
      status: 'CLOSED',
      id: { not: shift.id },
      endedAt: { not: null, lte: shift.startedAt },
    },
    orderBy: { endedAt: 'desc' },
    select: { endedAt: true },
  });
  return prev?.endedAt ?? null;
}

export async function getLastClosedShift(branchId) {
  return prisma.shiftHandover.findFirst({
    where: { branchId: Number(branchId), status: 'CLOSED' },
    orderBy: { endedAt: 'desc' },
  });
}

/** 今日各班別是否已交班／進行中 */
export async function getTodaySlotStatus(branchId, now = new Date()) {
  const bid = Number(branchId);
  const { start, end, ymd } = taipeiDayRange(taipeiYmd(now));
  const rows = await prisma.shiftHandover.findMany({
    where: {
      branchId: bid,
      startedAt: { gte: start, lt: end },
    },
    orderBy: { startedAt: 'asc' },
  });
  const bySlot = {};
  for (const s of SHIFT_SLOTS) {
    bySlot[s.key] = { key: s.key, label: s.label, status: 'AVAILABLE', shiftId: null };
  }
  for (const row of rows) {
    const key = row.slot && SLOT_KEYS.has(row.slot) ? row.slot : null;
    if (!key) continue;
    bySlot[key] = {
      key,
      label: shiftSlotLabel(key),
      status: row.status === 'OPEN' ? 'OPEN' : 'CLOSED',
      shiftId: row.id,
    };
  }
  return { businessDate: ymd, slots: SHIFT_SLOTS.map((s) => bySlot[s.key]) };
}

/**
 * 建議開班底金＝上一班交班實點（無則 0）
 * 不採信前端隨意輸入，避免抄寫錯誤
 */
export async function resolveSuggestedOpeningFloat(branchId) {
  const last = await getLastClosedShift(branchId);
  if (!last) return { openingFloat: 0, fromShiftId: null, source: 'NONE' };
  const amt =
    last.countedCash != null && Number.isFinite(Number(last.countedCash))
      ? roundMoney(last.countedCash)
      : last.expectedCash != null
        ? roundMoney(last.expectedCash)
        : 0;
  return { openingFloat: amt, fromShiftId: last.id, source: 'PREV_COUNTED' };
}

export async function openShift({
  branchId,
  staffId,
  staffName,
  staffRole,
  slot,
  note,
  now = new Date(),
} = {}) {
  const bid = Number(branchId);
  const normalizedSlot = normalizeShiftSlot(slot);
  const existing = await getOpenShift(bid);
  if (existing) {
    const err = new Error(`分店已有進行中班次 ${existing.id}，請先交班結算`);
    err.statusCode = 409;
    throw err;
  }

  const today = await getTodaySlotStatus(bid, now);
  const slotState = today.slots.find((s) => s.key === normalizedSlot);
  if (slotState?.status === 'CLOSED') {
    const err = new Error(`今日${shiftSlotLabel(normalizedSlot)}已交班，不可再開同一班別`);
    err.statusCode = 409;
    throw err;
  }

  const { openingFloat } = await resolveSuggestedOpeningFloat(bid);
  const operator = formatShiftOperator(staffName, staffRole);

  return prisma.shiftHandover.create({
    data: {
      id: generateShiftId(),
      branchId: bid,
      openedByStaffId: staffId,
      openedByName: operator,
      startedAt: now,
      status: 'OPEN',
      slot: normalizedSlot,
      openingFloat,
      note: note ? String(note).trim().slice(0, 500) : null,
      summarySnapshot: {
        openOperator: {
          staffId,
          name: String(staffName || '').slice(0, 80),
          role: String(staffRole || '').toUpperCase() || null,
          at: now.toISOString(),
        },
      },
    },
  });
}

export async function closeShift({
  shiftId,
  staffId,
  staffName,
  staffRole,
  countedCash,
  matchExpected = false,
  note,
  cashDenominations,
  closeChecklist,
  now = new Date(),
  /** 呼叫端已確認為店長以上時傳 true；差額交班必填 */
  allowVariance = false,
} = {}) {
  return prisma.$transaction(
    (tx) =>
      closeShiftLocked(tx, {
        shiftId,
        staffId,
        staffName,
        staffRole,
        countedCash,
        matchExpected,
        note,
        cashDenominations,
        closeChecklist,
        now,
        allowVariance,
      }),
    { timeout: 20000 },
  );
}

async function closeShiftLocked(
  tx,
  {
    shiftId,
    staffId,
    staffName,
    staffRole,
    countedCash,
    matchExpected,
    note,
    cashDenominations,
    closeChecklist,
    now,
    allowVariance,
  },
) {
  // 等待進行中的收款交易（FOR SHARE）提交後才結算，避免漏計
  await tx.$queryRaw`SELECT id FROM "ShiftHandover" WHERE id = ${String(shiftId)} FOR UPDATE`;
  const shift = await tx.shiftHandover.findUnique({ where: { id: shiftId } });
  if (!shift) {
    const err = new Error('找不到班次');
    err.statusCode = 404;
    throw err;
  }
  if (shift.status !== 'OPEN') {
    const err = new Error('此班次已交班');
    err.statusCode = 400;
    throw err;
  }

  // 取得鎖後才定交班時間：等待中的收款可能晚於呼叫時間才寫入
  const closeAt = new Date(Math.max(now.getTime(), Date.now()));
  const summary = await buildShiftSummary({
    branchId: shift.branchId,
    from: shift.startedAt,
    to: closeAt,
    carryFrom: await previousShiftEnd(shift, tx),
  }, tx);
  const expectedCash = roundMoney(shift.openingFloat + summary.cashIn - summary.cashRefund);

  const denom = cashDenominations != null ? normalizeCashDenominations(cashDenominations) : null;
  const checklist = normalizeCloseChecklist(closeChecklist);

  let counted;
  const wantMatch = matchExpected === true || matchExpected === 'true';
  if (wantMatch) {
    counted = expectedCash;
  } else if (denom) {
    counted = denom.total;
    if (countedCash != null && countedCash !== '' && roundMoney(countedCash) !== counted) {
      const err = new Error(`面額合計 $${counted} 與實點 $${roundMoney(countedCash)} 不符，請重新點鈔`);
      err.statusCode = 400;
      throw err;
    }
  } else {
    counted = roundMoney(countedCash);
    if (!Number.isFinite(counted) || counted < 0) {
      const err = new Error('請填寫實點現金（≥ 0），完成面額點鈔，或改用「帳面相符一鍵交班」');
      err.statusCode = 400;
      throw err;
    }
  }

  const variance = roundMoney(counted - expectedCash);
  if (variance !== 0) {
    if (!allowVariance) {
      const err = new Error('有差額之交班僅限店長（MANAGER）或總部（ADMIN）操作；一般人員請使用帳面相符一鍵交班，或請店長處理');
      err.statusCode = 403;
      throw err;
    }
    const noteText = note != null ? String(note).trim() : '';
    if (!noteText) {
      const err = new Error('實點與應有現金不符時，請填寫差額原因（店長級操作）');
      err.statusCode = 400;
      throw err;
    }
  }

  const operator = formatShiftOperator(staffName, staffRole);
  const prevSnap =
    shift.summarySnapshot && typeof shift.summarySnapshot === 'object'
      ? shift.summarySnapshot
      : {};

  return tx.shiftHandover.update({
    where: { id: shift.id },
    data: {
      status: 'CLOSED',
      endedAt: closeAt,
      closedByStaffId: staffId,
      closedByName: operator,
      expectedCash,
      countedCash: counted,
      variance,
      payMixSnapshot: summary.payMix,
      summarySnapshot: {
        ...prevSnap,
        totals: summary.totals,
        cashIn: summary.cashIn,
        cashRefund: summary.cashRefund,
        payMix: summary.payMix,
        payMixColumns: normalizePayMixColumns(summary.payMix),
        refunds: summary.refunds,
        from: summary.from,
        to: summary.to,
        slot: shift.slot,
        openingFloat: shift.openingFloat,
        expectedCash,
        countedCash: counted,
        variance,
        cashDenominations: denom,
        closeChecklist: checklist,
        closeOperator: {
          staffId,
          name: String(staffName || '').slice(0, 80),
          role: String(staffRole || '').toUpperCase() || null,
          at: closeAt.toISOString(),
          matchExpected: wantMatch,
          variance,
        },
      },
      note: note
        ? `${shift.note ? `${shift.note}｜` : ''}${String(note).trim()}`.slice(0, 500)
        : shift.note,
    },
  });
}

export async function listShifts({ branchId, take = 20 } = {}) {
  return prisma.shiftHandover.findMany({
    where: { branchId: Number(branchId) },
    orderBy: { startedAt: 'desc' },
    take: Math.min(50, take),
  });
}

/** 開班前預覽：建議班別、底金、今日狀態 */
export async function getShiftOpenPreview(branchId, now = new Date()) {
  const bid = Number(branchId);
  const [open, floatInfo, today] = await Promise.all([
    getOpenShift(bid),
    resolveSuggestedOpeningFloat(bid),
    getTodaySlotStatus(bid, now),
  ]);
  return {
    openShift: open,
    suggestedSlot: suggestShiftSlot(now),
    suggestedOpeningFloat: floatInfo.openingFloat,
    openingFloatSource: floatInfo.source,
    previousShiftId: floatInfo.fromShiftId,
    today,
    slots: SHIFT_SLOTS,
    payMethodColumns: PAY_METHOD_COLUMNS,
  };
}
