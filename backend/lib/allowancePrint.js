// lib/allowancePrint.js — 折讓單列印資料（純 JSON；A4 四聯式／80mm 熱感由前端排版，後端禁止產生 HTML／PDF）
import prisma from './prisma.js';
import { allowanceScopeWhere } from './invoiceAllowance.js';
import { loadSignatureDataUrl } from './refundSignature.js';
import { clientIp } from './memberDeviceAudit.js';

const FALLBACK_SELLER_NAME = '體育客';

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const TAX_TYPE_LABEL = { 1: '應稅', 2: '零稅率', 3: '免稅' };

const PRINT_PURPOSES = ['print', 'display', 'view'];

/**
 * GET /api/ops/allowances/:id/print-payload?purpose=print|display（id＝IAL… 或折讓號）
 * 不在可見範圍者一律 404；每次調閱寫 TransactionAuditLog（ALLOWANCE_PRINT）；僅 purpose=print 遞增列印次數
 */
export async function getAllowancePrintPayload(user, idOrNo, req = null, { purpose } = {}) {
  const usage = PRINT_PURPOSES.includes(String(purpose || '').toLowerCase()) ? String(purpose).toLowerCase() : 'view';
  const key = String(idOrNo || '').trim();
  if (!key) throw httpError(400, 'ALLOWANCE_REQUIRED', '請提供折讓單 id 或折讓號');
  const row = await prisma.invoiceAllowance.findFirst({
    where: { OR: [{ id: key }, { allowanceNo: key }], ...allowanceScopeWhere(user) },
    include: {
      items: { orderBy: { lineNo: 'asc' } },
      legalEntity: { select: { name: true, ubn: true, address: true, phone: true } },
      einvoice: {
        select: {
          branchId: true,
          issuedAt: true,
          periodKey: true,
          category: true,
          buyerUbn: true,
          buyerName: true,
          taxType: true,
          totalAmount: true,
          allowanceTotal: true,
        },
      },
    },
  });
  if (!row) throw httpError(404, 'ALLOWANCE_NOT_FOUND', '找不到折讓單');

  const branchId = row.branchId ?? row.einvoice?.branchId ?? null;
  const [branch, member] = await Promise.all([
    branchId != null
      ? prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, name: true, code: true, address: true } })
      : null,
    row.memberId ? prisma.member.findUnique({ where: { id: row.memberId }, select: { memberNo: true } }) : null,
  ]);
  const category = row.category || row.einvoice?.category || 'B2C';
  const invoiceNumber = String(row.invoiceNumber || '');
  const taxType = row.items[0]?.taxType || row.einvoice?.taxType || '1';
  const items = row.items.length
    ? row.items.map((it) => ({
        lineNo: it.lineNo,
        name: it.name,
        qty: it.qty,
        unit: it.unit,
        unitPrice: it.unitPrice,
        amount: it.amount,
        taxAmt: it.taxAmt,
        grossAmount: it.grossAmount,
        taxType: it.taxType,
      }))
    : [
        {
          lineNo: 1,
          name: row.itemDesc || '折讓',
          qty: 1,
          unit: '式',
          unitPrice: row.untaxedAmt,
          amount: row.untaxedAmt,
          taxAmt: row.taxAmt,
          grossAmount: row.totalAmt,
          taxType,
        },
      ];
  const signature = row.signatureId ? await loadSignatureDataUrl(row.signatureId) : null;

  let printState = { printCount: row.printCount ?? 0, lastPrintedAt: row.lastPrintedAt ?? null };
  if (usage === 'print') {
    printState = await prisma.invoiceAllowance.update({
      where: { id: row.id },
      data: { printCount: { increment: 1 }, lastPrintedAt: new Date(), lastPrintedByStaffId: user?.id ?? null },
      select: { printCount: true, lastPrintedAt: true },
    });
  }

  await prisma.transactionAuditLog
    .create({
      data: {
        action: 'ALLOWANCE_PRINT',
        refundId: row.refundId || null,
        refType: 'ALLOWANCE',
        refId: row.id,
        staffId: user?.id ?? null,
        staffRole: user?.role ?? null,
        branchId,
        clientIp: req ? clientIp(req) : null,
        after: { purpose: usage, printCount: printState.printCount },
      },
    })
    .catch((e) => console.error('折讓單調閱紀錄寫入失敗:', e.message));

  return {
    allowance: {
      id: row.id,
      allowanceNo: row.allowanceNo,
      status: row.status,
      issuedAt: row.createdAt,
      source: row.source,
      refundId: row.refundId || null,
      subOrderId: row.subOrderId || row.saleOrderId || row.orderId || null,
      reason: row.reason || null,
      staffId: row.staffId ?? null,
    },
    seller: {
      name: row.sellerName || row.legalEntity?.name || FALLBACK_SELLER_NAME,
      ubn: row.sellerUbn || row.legalEntity?.ubn || null,
      address: row.sellerAddress || row.legalEntity?.address || null,
      phone: row.legalEntity?.phone || null,
      branchName: branch?.name || null,
      branchCode: branch?.code || null,
      branchAddress: branch?.address || null,
    },
    buyer: {
      category,
      ubn: category === 'B2B' ? row.buyerUbn || row.einvoice?.buyerUbn || null : null,
      name: category === 'B2B' ? row.buyerName || row.einvoice?.buyerName || null : null,
      memberName: row.memberName || null,
      memberNo: member?.memberNo || null,
      email: row.buyerEmail || null,
    },
    originalInvoice: {
      invoiceNumber,
      track: invoiceNumber.slice(0, 2),
      number: invoiceNumber.slice(2),
      issuedAt: row.invoiceIssuedAt || row.einvoice?.issuedAt || null,
      periodKey: row.invoicePeriodKey || row.einvoice?.periodKey || null,
      taxType,
      taxTypeLabel: TAX_TYPE_LABEL[taxType] || '應稅',
      totalAmount: row.einvoice?.totalAmount ?? null,
    },
    items,
    amounts: {
      untaxed: row.untaxedAmt,
      tax: row.taxAmt,
      total: row.totalAmt,
      remainAmt: row.remainAmt ?? null,
    },
    signature: {
      required: category === 'B2B',
      signed: Boolean(row.signatureId),
      signatureId: row.signatureId || null,
      signedAt: signature?.signedAt || null,
      intact: signature?.intact ?? null,
      dataUrl: signature?.dataUrl || null,
    },
    print: {
      count: printState.printCount,
      isReprint: printState.printCount > 1,
      lastPrintedAt: printState.lastPrintedAt,
    },
    formats: ['A4_FOUR_PART', 'THERMAL_80MM'],
  };
}
