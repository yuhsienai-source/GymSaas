// lib/purchasing.js — 供應商、採購單、驗收入庫、應付帳款、付款沖銷（唯一定義）
// 採購／驗收／應付一律歸分店所屬營業人；進價為未稅，進項稅 5%（免稅品 0）
import prisma from './prisma.js';
import { applyStockDelta, generatePurchaseId, generateReceiptId, generatePayableId, generateSupplierPaymentId } from './inventory.js';
import { assertTracksInventory } from './productKind.js';
import { isValidTaiwanUbn } from './ezpay.js';
import { normalizeTaxType, TAX_RATE } from './einvoiceRules.js';

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const PO_EDITABLE = ['DRAFT'];
const PO_RECEIVABLE = ['ORDERED', 'PARTIAL'];
export const PAYMENT_TERM_TYPES = ['NET', 'EOM', 'COD'];
export const PAYMENT_METHODS = ['TRANSFER', 'CASH', 'CHECK'];

function posInt(v, label) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `${label} 必須為正整數`);
  return n;
}

function money4(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${label} 必須為非負數字`);
  return Math.round(n * 10000) / 10000;
}

/** 明細金額：未稅小計（四捨五入到元）＋應稅部分 5% 稅 */
export function computePurchaseTotals(lines) {
  let subtotal = 0;
  let taxableBase = 0;
  for (const l of lines) {
    const amt = Math.round(l.qty * Number(l.unitCost));
    subtotal += amt;
    if (normalizeTaxType(l.taxType) === 'TAXABLE') taxableBase += amt;
  }
  const taxAmount = Math.round((taxableBase * TAX_RATE) / 100);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

/** 應付到期日：NET 驗收後 N 日｜EOM 當月底後 N 日｜COD 驗收當日 */
export function computeDueDate(receivedAt, termType, termDays) {
  const d = new Date(receivedAt);
  const days = Math.max(0, parseInt(termDays, 10) || 0);
  if (termType === 'COD') return d;
  if (termType === 'EOM') {
    const eom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 15, 59, 59));
    return new Date(eom.getTime() + days * 86400000);
  }
  return new Date(d.getTime() + days * 86400000);
}

// ─────────────────────────────────────────────────────────────
// 供應商
// ─────────────────────────────────────────────────────────────

export function normalizeSupplierInput(body, { partial = false } = {}) {
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, '供應商名稱必填');
    data.name = name.slice(0, 100);
  }
  if (body.ubn !== undefined) {
    const ubn = String(body.ubn || '').replace(/\D/g, '');
    if (ubn && !isValidTaiwanUbn(ubn)) throw httpError(400, '供應商統編檢查碼錯誤');
    data.ubn = ubn || null;
  }
  for (const k of ['contactName', 'phone', 'email', 'address', 'note']) {
    if (body[k] !== undefined) data[k] = String(body[k] || '').trim().slice(0, 200) || null;
  }
  if (body.paymentTermType !== undefined) {
    const t = String(body.paymentTermType || 'NET').toUpperCase();
    if (!PAYMENT_TERM_TYPES.includes(t)) throw httpError(400, 'paymentTermType 須為 NET／EOM／COD');
    data.paymentTermType = t;
  }
  if (body.paymentTermDays !== undefined) {
    const n = parseInt(body.paymentTermDays, 10);
    if (!Number.isInteger(n) || n < 0 || n > 180) throw httpError(400, 'paymentTermDays 須為 0～180');
    data.paymentTermDays = n;
  }
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  return data;
}

// ─────────────────────────────────────────────────────────────
// 採購單
// ─────────────────────────────────────────────────────────────

async function normalizePoItems(tx, items) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, '採購明細不可為空');
  const seen = new Set();
  const out = [];
  for (const row of items) {
    const productId = posInt(row.productId, 'productId');
    if (seen.has(productId)) throw httpError(400, `商品 #${productId} 重複`);
    seen.add(productId);
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) throw httpError(400, `商品 #${productId} 不存在或已停用`);
    assertTracksInventory(product, '採購');
    out.push({
      productId,
      qtyOrdered: posInt(row.qty ?? row.qtyOrdered, '採購數量'),
      unitCost: money4(row.unitCost, 'unitCost'),
      taxType: normalizeTaxType(row.taxType ?? product.taxType),
    });
  }
  return out;
}

export async function createPurchaseOrder({ branchId, supplierId, items, expectedAt = null, note = null, staffId = null }) {
  return prisma.$transaction(async (tx) => {
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { isActive: true, legalEntityId: true, name: true } });
    if (!branch?.isActive) throw httpError(404, '分店不存在或已停用');
    if (!branch.legalEntityId) throw httpError(409, `分店「${branch.name}」尚未綁定營業人`, 'LEGAL_ENTITY_REQUIRED');
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier?.isActive) throw httpError(404, '供應商不存在或已停用');
    const lines = await normalizePoItems(tx, items);
    const totals = computePurchaseTotals(lines.map((l) => ({ qty: l.qtyOrdered, unitCost: l.unitCost, taxType: l.taxType })));
    return tx.purchaseOrder.create({
      data: {
        id: generatePurchaseId(),
        legalEntityId: branch.legalEntityId,
        branchId,
        supplierId,
        status: 'DRAFT',
        expectedAt: expectedAt ? new Date(expectedAt) : null,
        note: note ? String(note).slice(0, 500) : null,
        createdByStaffId: staffId,
        ...totals,
        items: { create: lines },
      },
      include: PO_INCLUDE,
    });
  });
}

export const PO_INCLUDE = {
  items: { include: { product: { select: { id: true, sku: true, name: true, unit: true } } } },
  supplier: { select: { id: true, name: true, ubn: true } },
  branch: { select: { id: true, name: true, code: true } },
  legalEntity: { select: { id: true, code: true, name: true, ubn: true } },
  receipts: { select: { id: true, receivedAt: true, total: true, supplierInvoiceNo: true } },
};

async function lockPo(tx, id) {
  const rows = await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw httpError(404, '採購單不存在');
  return tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
}

export async function updatePurchaseOrderDraft(id, { items, expectedAt, note, supplierId }) {
  return prisma.$transaction(async (tx) => {
    const po = await lockPo(tx, id);
    if (!PO_EDITABLE.includes(po.status)) throw httpError(409, '僅草稿可修改', 'PO_NOT_EDITABLE');
    const data = {};
    if (supplierId !== undefined) {
      const s = await tx.supplier.findUnique({ where: { id: posInt(supplierId, 'supplierId') } });
      if (!s?.isActive) throw httpError(404, '供應商不存在或已停用');
      data.supplierId = s.id;
    }
    if (expectedAt !== undefined) data.expectedAt = expectedAt ? new Date(expectedAt) : null;
    if (note !== undefined) data.note = note ? String(note).slice(0, 500) : null;
    if (items !== undefined) {
      const lines = await normalizePoItems(tx, items);
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      await tx.purchaseOrderItem.createMany({ data: lines.map((l) => ({ ...l, purchaseOrderId: id })) });
      Object.assign(
        data,
        computePurchaseTotals(lines.map((l) => ({ qty: l.qtyOrdered, unitCost: l.unitCost, taxType: l.taxType }))),
      );
    }
    return tx.purchaseOrder.update({ where: { id }, data, include: PO_INCLUDE });
  });
}

export async function transitionPurchaseOrder(id, action, { reason = null } = {}) {
  return prisma.$transaction(async (tx) => {
    const po = await lockPo(tx, id);
    const data = {};
    if (action === 'order') {
      if (po.status !== 'DRAFT') throw httpError(409, '僅草稿可送出採購', 'PO_INVALID_STATE');
      Object.assign(data, { status: 'ORDERED', orderedAt: new Date() });
    } else if (action === 'cancel') {
      if (!['DRAFT', 'ORDERED'].includes(po.status)) throw httpError(409, '已有驗收之採購單不可取消，請改為結案', 'PO_INVALID_STATE');
      const r = String(reason || '').trim();
      if (!r) throw httpError(400, '取消採購單必填原因');
      Object.assign(data, { status: 'CANCELLED', cancelReason: r.slice(0, 200), closedAt: new Date() });
    } else if (action === 'close') {
      if (po.status !== 'PARTIAL') throw httpError(409, '僅部分到貨之採購單可結案（短交）', 'PO_INVALID_STATE');
      Object.assign(data, { status: 'CLOSED', closedAt: new Date(), cancelReason: reason ? String(reason).slice(0, 200) : null });
    } else {
      throw httpError(400, '未知動作');
    }
    return tx.purchaseOrder.update({ where: { id }, data, include: PO_INCLUDE });
  });
}

// ─────────────────────────────────────────────────────────────
// 驗收入庫（可依採購單或直接進貨）→ 庫存＋移動平均＋應付
// ─────────────────────────────────────────────────────────────

/**
 * @param {{ purchaseOrderId?, branchId?, supplierId?, items: Array<{ poItemId?, productId?, qty, unitCost? }>, supplierInvoiceNo?, supplierInvoiceDate?, note?, staffId? }} input
 */
export async function receivePurchase(input) {
  return prisma.$transaction(async (tx) => {
    let po = null;
    let branchId;
    let supplierId;
    let legalEntityId;
    if (input.purchaseOrderId) {
      po = await lockPo(tx, String(input.purchaseOrderId));
      if (!PO_RECEIVABLE.includes(po.status)) {
        throw httpError(409, `採購單狀態 ${po.status} 不可驗收（須先送出採購）`, 'PO_INVALID_STATE');
      }
      ({ branchId, supplierId, legalEntityId } = po);
    } else {
      branchId = posInt(input.branchId, 'branchId');
      supplierId = posInt(input.supplierId, 'supplierId');
      const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { legalEntityId: true, name: true, isActive: true } });
      if (!branch?.isActive) throw httpError(404, '分店不存在或已停用');
      if (!branch.legalEntityId) throw httpError(409, `分店「${branch.name}」尚未綁定營業人`, 'LEGAL_ENTITY_REQUIRED');
      legalEntityId = branch.legalEntityId;
    }
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw httpError(404, '供應商不存在');

    if (!Array.isArray(input.items) || !input.items.length) throw httpError(400, '驗收明細不可為空');
    const lines = [];
    for (const row of input.items) {
      const qty = posInt(row.qty, '驗收數量');
      let poItem = null;
      let productId;
      let unitCost;
      let taxType;
      if (po) {
        poItem = po.items.find((i) => i.id === parseInt(row.poItemId, 10) || (!row.poItemId && i.productId === parseInt(row.productId, 10)));
        if (!poItem) throw httpError(400, '驗收品項不在採購單內');
        productId = poItem.productId;
        unitCost = row.unitCost !== undefined ? money4(row.unitCost, 'unitCost') : Number(poItem.unitCost);
        taxType = poItem.taxType;
        const ok = await tx.purchaseOrderItem.updateMany({
          where: { id: poItem.id, qtyReceived: { lte: poItem.qtyOrdered - qty } },
          data: { qtyReceived: { increment: qty } },
        });
        if (!ok.count) {
          throw httpError(409, `商品 #${productId} 驗收數量超過未到貨數（訂 ${poItem.qtyOrdered}／已收 ${poItem.qtyReceived}）`, 'RECEIPT_EXCEEDS_ORDER');
        }
      } else {
        productId = posInt(row.productId, 'productId');
        unitCost = money4(row.unitCost, 'unitCost');
        const product = await tx.product.findUnique({ where: { id: productId } });
        if (!product) throw httpError(404, `商品 #${productId} 不存在`);
        taxType = normalizeTaxType(row.taxType ?? product.taxType);
      }
      const product = await tx.product.findUnique({ where: { id: productId } });
      assertTracksInventory(product, '進貨入庫');
      lines.push({ poItemId: poItem?.id ?? null, productId, qty, unitCost, taxType });
    }

    const totals = computePurchaseTotals(lines);
    const receiptId = generateReceiptId();
    const receivedAt = new Date();
    const invoiceNo = input.supplierInvoiceNo ? String(input.supplierInvoiceNo).trim().toUpperCase().slice(0, 20) : null;
    if (invoiceNo) {
      const dup = await tx.supplierPayable.findFirst({ where: { supplierId, supplierInvoiceNo: invoiceNo } });
      if (dup) throw httpError(409, `供應商發票 ${invoiceNo} 已登錄於應付 ${dup.id}`, 'SUPPLIER_INVOICE_DUPLICATE');
    }
    const receipt = await tx.purchaseReceipt.create({
      data: {
        id: receiptId,
        purchaseOrderId: po?.id ?? null,
        legalEntityId,
        branchId,
        supplierId,
        supplierInvoiceNo: invoiceNo,
        supplierInvoiceDate: input.supplierInvoiceDate ? new Date(input.supplierInvoiceDate) : null,
        ...totals,
        receivedAt,
        staffId: input.staffId ?? null,
        note: input.note ? String(input.note).slice(0, 500) : null,
        items: { create: lines },
      },
      include: { items: true },
    });

    for (const item of receipt.items) {
      await applyStockDelta(tx, {
        branchId,
        productId: item.productId,
        delta: item.qty,
        refType: 'RECEIPT',
        refId: receiptId,
        refLineId: item.id,
        reason: `驗收 ${receiptId}${po ? `（${po.id}）` : ''}`,
        staffId: input.staffId ?? null,
        unitCost: Number(item.unitCost),
      });
    }

    const payable = await tx.supplierPayable.create({
      data: {
        id: generatePayableId(),
        legalEntityId,
        supplierId,
        receiptId,
        type: 'PURCHASE',
        supplierInvoiceNo: invoiceNo,
        amount: totals.total,
        dueDate: computeDueDate(receivedAt, supplier.paymentTermType, supplier.paymentTermDays),
        status: totals.total === 0 ? 'PAID' : 'OPEN',
      },
    });

    if (po) {
      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
      const done = items.every((i) => i.qtyReceived >= i.qtyOrdered);
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status: done ? 'RECEIVED' : 'PARTIAL', ...(done ? { closedAt: new Date() } : {}) },
      });
    }

    return { receipt, payable };
  });
}

/** 補登供應商發票號（驗收後才收到發票） */
export async function setReceiptSupplierInvoice(receiptId, { supplierInvoiceNo, supplierInvoiceDate }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.purchaseReceipt.findUnique({ where: { id: receiptId }, include: { payable: true } });
    if (!r) throw httpError(404, '驗收單不存在');
    const no = String(supplierInvoiceNo || '').trim().toUpperCase().slice(0, 20) || null;
    if (no) {
      const dup = await tx.supplierPayable.findFirst({ where: { supplierId: r.supplierId, supplierInvoiceNo: no, NOT: { receiptId } } });
      if (dup) throw httpError(409, `供應商發票 ${no} 已登錄於應付 ${dup.id}`, 'SUPPLIER_INVOICE_DUPLICATE');
    }
    await tx.purchaseReceipt.update({
      where: { id: receiptId },
      data: { supplierInvoiceNo: no, supplierInvoiceDate: supplierInvoiceDate ? new Date(supplierInvoiceDate) : r.supplierInvoiceDate },
    });
    if (r.payable) await tx.supplierPayable.update({ where: { id: r.payable.id }, data: { supplierInvoiceNo: no } });
    return tx.purchaseReceipt.findUnique({ where: { id: receiptId }, include: { payable: true } });
  });
}

// ─────────────────────────────────────────────────────────────
// 付款沖銷
// ─────────────────────────────────────────────────────────────

function payableStatus(amount, paid) {
  if (paid === 0) return 'OPEN';
  if (paid === amount) return 'PAID';
  return 'PARTIAL';
}

/**
 * @param {{ legalEntityId, supplierId, amount, method, paidAt?, reference?, note?, allocations: Array<{ payableId, amount }>, staffId? }} input
 */
export async function createSupplierPayment(input) {
  const legalEntityId = posInt(input.legalEntityId, 'legalEntityId');
  const supplierId = posInt(input.supplierId, 'supplierId');
  const amount = parseInt(input.amount, 10);
  if (!Number.isInteger(amount) || amount <= 0) throw httpError(400, '付款金額必須為正整數');
  const method = String(input.method || 'TRANSFER').toUpperCase();
  if (!PAYMENT_METHODS.includes(method)) throw httpError(400, 'method 須為 TRANSFER／CASH／CHECK');
  const allocs = Array.isArray(input.allocations) ? input.allocations : [];
  if (!allocs.length) throw httpError(400, '付款須沖銷至少一筆應付');
  const sum = allocs.reduce((s, a) => s + (parseInt(a.amount, 10) || 0), 0);
  if (sum !== amount) throw httpError(400, `沖銷合計 $${sum} 須等於付款金額 $${amount}`);

  return prisma.$transaction(async (tx) => {
    const paymentId = generateSupplierPaymentId();
    for (const a of allocs) {
      const amt = parseInt(a.amount, 10);
      if (!Number.isInteger(amt) || amt === 0) throw httpError(400, '沖銷金額不可為 0');
      const rows = await tx.$queryRaw`SELECT id FROM "SupplierPayable" WHERE id = ${String(a.payableId)} FOR UPDATE`;
      if (!rows.length) throw httpError(404, `應付 ${a.payableId} 不存在`);
      const p = await tx.supplierPayable.findUnique({ where: { id: String(a.payableId) } });
      if (p.legalEntityId !== legalEntityId || p.supplierId !== supplierId) {
        throw httpError(409, `應付 ${p.id} 不屬於此營業人／供應商`, 'PAYABLE_SCOPE_MISMATCH');
      }
      if (p.status === 'VOID' || p.status === 'PAID') throw httpError(409, `應付 ${p.id} 狀態 ${p.status} 不可沖銷`);
      const next = p.paidAmount + amt;
      const within = p.amount >= 0 ? next >= 0 && next <= p.amount : next <= 0 && next >= p.amount;
      if (!within) throw httpError(409, `應付 ${p.id} 沖銷後超過應付金額（應付 $${p.amount}、已付 $${p.paidAmount}）`, 'PAYMENT_EXCEEDS_PAYABLE');
      await tx.supplierPayable.update({
        where: { id: p.id },
        data: { paidAmount: next, status: payableStatus(p.amount, next) },
      });
    }
    return tx.supplierPayment.create({
      data: {
        id: paymentId,
        legalEntityId,
        supplierId,
        amount,
        method,
        paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
        reference: input.reference ? String(input.reference).slice(0, 100) : null,
        note: input.note ? String(input.note).slice(0, 500) : null,
        staffId: input.staffId ?? null,
        allocations: { create: allocs.map((a) => ({ payableId: String(a.payableId), amount: parseInt(a.amount, 10) })) },
      },
      include: { allocations: true },
    });
  });
}

/** 作廢應付（僅未付款；必填原因） */
export async function voidPayable(id, reason) {
  const r = String(reason || '').trim();
  if (!r) throw httpError(400, '作廢應付必填原因');
  const p = await prisma.supplierPayable.findUnique({ where: { id } });
  if (!p) throw httpError(404, '應付不存在');
  if (p.paidAmount !== 0) throw httpError(409, '已有付款沖銷之應付不可作廢', 'PAYABLE_HAS_PAYMENT');
  if (p.status === 'VOID') return p;
  return prisma.supplierPayable.update({ where: { id }, data: { status: 'VOID', voidReason: r.slice(0, 200) } });
}

/** 應付帳齡彙總（依營業人×供應商） */
export async function payableAging({ legalEntityId = null } = {}) {
  const rows = await prisma.supplierPayable.findMany({
    where: { status: { in: ['OPEN', 'PARTIAL'] }, ...(legalEntityId ? { legalEntityId } : {}) },
    include: { supplier: { select: { id: true, name: true } }, legalEntity: { select: { id: true, code: true, name: true } } },
  });
  const now = Date.now();
  const map = new Map();
  for (const p of rows) {
    const key = `${p.legalEntityId}:${p.supplierId}`;
    if (!map.has(key)) {
      map.set(key, { legalEntity: p.legalEntity, supplier: p.supplier, notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 });
    }
    const g = map.get(key);
    const open = p.amount - p.paidAmount;
    const overdue = Math.floor((now - new Date(p.dueDate).getTime()) / 86400000);
    if (overdue <= 0) g.notDue += open;
    else if (overdue <= 30) g.d30 += open;
    else if (overdue <= 60) g.d60 += open;
    else if (overdue <= 90) g.d90 += open;
    else g.over90 += open;
    g.total += open;
  }
  return [...map.values()];
}
