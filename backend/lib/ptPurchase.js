// lib/ptPurchase.js — 私教課程方案查價與履約（合併結帳／PT 購案共用）
import {
  assertCoursePlanSellable,
  SECOND_PERSON_ON_SITE_LABEL,
} from './coursePlan.js';
import { assertMemberSignedCoursePlanContracts } from './memberContract.js';
import { staffBranchLabel } from './branchLabel.js';
import { isManagerTrainer } from './orgStructure.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function generateOrderId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `TYK${dateStr}${randomStr}`;
}

/**
 * 查價私教課程購物車列（CUSTOM_PT）
 * @returns {{ lines, amount, itemDesc, trainer }}
 */
export async function buildPtCheckoutLines(tx, {
  memberId,
  trainerId,
  courseDraft,
  memberName,
}) {
  if (!Array.isArray(courseDraft) || courseDraft.length === 0) {
    return { lines: [], amount: 0, itemDesc: '', trainer: null };
  }

  const trainer = await tx.trainer.findUnique({
    where: { id: trainerId },
    include: { branches: { select: { branchId: true } } },
  });
  if (!trainer || !trainer.isActive) {
    throw httpError('找不到此教練或教練已停用', 404);
  }
  const trainerBranchIds = new Set(trainer.branches.map((b) => b.branchId));
  const isManager = isManagerTrainer(trainer);

  const lines = [];
  let amount = 0;
  const descParts = [];
  const noteParts = [];

  for (const row of courseDraft) {
    const plan = await tx.coursePlan.findUnique({
      where: { id: row.coursePlanId },
      include: { branch: { select: { id: true, name: true, code: true } } },
    });
    if (!plan || plan.planType !== 'CUSTOM_PT') {
      throw httpError('找不到客製化私教方案，或方案類型不符', 404);
    }
    assertCoursePlanSellable(plan);
    if (!Number.isInteger(plan.sessions) || plan.sessions <= 0) {
      throw httpError(`方案 [${plan.name}] 未設定堂數`, 400);
    }
    if (!isManager && !trainerBranchIds.has(plan.branchId)) {
      throw httpError(
        `教練無權販售分店「${staffBranchLabel(plan.branch) || plan.branchId}」的方案`,
        403,
      );
    }
    if (plan.requiresMemberContract) {
      await assertMemberSignedCoursePlanContracts(memberId, plan.id, tx);
    }

    const secondPersonOnSite = Boolean(plan.enableSecondPerson) && Boolean(row.secondPersonOnSite);
    if (row.secondPersonOnSite && !plan.enableSecondPerson) {
      throw httpError(`方案 [${plan.name}] 未開放課程第二人選項`, 400);
    }
    const giftLabel = plan.giftLabel ? String(plan.giftLabel).trim() : null;

    const totalSessions = plan.sessions * row.qty;
    // 第二人 $500、加贈禮皆不計入結帳應付（第二人為當日現場支付）
    const lineTotal = plan.price * row.qty;
    amount += lineTotal;
    descParts.push(`${plan.name}x${row.qty}(${totalSessions}堂)`);
    if (secondPersonOnSite) noteParts.push(SECOND_PERSON_ON_SITE_LABEL);
    if (giftLabel) noteParts.push(`加贈禮:${giftLabel}`);
    lines.push({
      coursePlanId: plan.id,
      name: plan.name,
      qty: row.qty,
      unitPrice: plan.price,
      lineTotal,
      sessions: plan.sessions,
      totalSessions,
      branchId: plan.branchId,
      secondPersonOnSite,
      secondPersonNote: secondPersonOnSite ? SECOND_PERSON_ON_SITE_LABEL : null,
      giftLabel: giftLabel || null,
      giftLineTotal: giftLabel ? 0 : null,
    });
  }

  const who = memberName || `會員#${memberId}`;
  const notes = noteParts.length ? ` | ${noteParts.join(' · ')}` : '';
  return {
    lines,
    amount,
    itemDesc: `私教 | ${trainer.name} | ${descParts.join(', ')}${notes} | ${who}`.slice(0, 240),
    trainer,
  };
}

/**
 * 建立 PTContract + 可選帳務 Order（須在 transaction 內）
 * @param {{ skipOrders?: boolean, checkoutSessionId?: string, payMethod?: string, status?: string }} opts
 */
export async function fulfillPtCheckoutLines(tx, {
  memberId,
  trainerId,
  lines,
  memberName,
  trainerName,
  opts = {},
}) {
  if (!lines?.length) return [];

  const status = opts.status || 'PAID';
  const payMethod = opts.payMethod || 'CASH';
  const created = [];

  for (const line of lines) {
    let orderId = null;
    if (!opts.skipOrders) {
      orderId = generateOrderId();
      await tx.order.create({
        data: {
          id: orderId,
          memberId,
          amount: line.lineTotal,
          itemDesc:
            `私教購案 | ${line.name} ×${line.qty}` +
            ` | 方案#${line.coursePlanId} | ${trainerName} × ${line.totalSessions} 堂` +
            ` | 學員 ${memberName || memberId}`,
          payMethod,
          status,
          branchId: line.branchId ?? null,
          checkoutSessionId: opts.checkoutSessionId || null,
        },
      });
    }

    const contract = await tx.pTContract.create({
      data: {
        memberId,
        trainerId,
        totalSessions: line.totalSessions,
        usedSessions: 0,
        pricePaid: line.lineTotal,
        isActive: true,
        source: 'PURCHASE',
        orderId,
        ...(line.coursePlanId ? { coursePlanId: line.coursePlanId } : {}),
        ...(line.branchId ? { branchId: line.branchId } : {}),
      },
    });

    created.push({ contractId: contract.id, orderId, ...line });
  }

  return created;
}
