// lib/gateCheckout.js — 進出場出場結算（閘機／櫃檯補登共用）
import prisma from './prisma.js';
import { memberHasSignedBiometricsConsent } from './memberContract.js';
import { assertMemberBoundGateAccess } from './memberBranch.js';
import { broadcastOccupancy } from './occupancy.js';
import { formatGateAccessNo } from './gateAccessNo.js';

const FEE_PER_MINUTE = 1.3;

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * 依進場快照結算出場（禁止再讀 Member.plan）
 * @param {{ memberId: number, exitMethod: string, branchId: number, logId?: number }} opts
 */
export async function processCheckOut({ memberId, exitMethod, branchId, logId = null }) {
  const checkOutTime = new Date();

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!member) throw httpError('無此會員', 404);

    if (member.isAlert && exitMethod === 'QR') {
      throw httpError(
        '🚨 警示帳號：動態 QR Code 已失效！強制要求人工查驗或限用實名生物辨識出場。',
        403,
      );
    }

    if (exitMethod === 'FACE') {
      if (!(await memberHasSignedBiometricsConsent(memberId)) || !member.papagoFaceId) {
        throw httpError('⛔ 人臉出場失敗：尚未完成生物辨識授權或人臉綁定。', 403);
      }
    }

    if (!branchId) {
      throw httpError('未指定分店，無法出場', 400);
    }
    await assertMemberBoundGateAccess(memberId, branchId, tx);

    const activeLog = await tx.checkInLog.findFirst({
      where: {
        ...(logId ? { id: logId } : {}),
        memberId,
        checkOutAt: null,
        status: 'ACTIVE',
      },
    });
    if (!activeLog) {
      throw httpError('⛔ 出場失敗：查無在場紀錄，請確認是否已進場。', 400);
    }

    if (activeLog.billingMode === '月費通行') {
      const updatedLog = await tx.checkInLog.update({
        where: { id: activeLog.id },
        data: { checkOutAt: checkOutTime, fee: 0 },
      });

      return {
        member,
        log: updatedLog,
        exitMethod,
        feeDetails: { totalFee: 0, paidByBonus: 0, paidByCash: 0 },
        remaining: { cash: member.cashWallet, bonus: member.bonusWallet },
        billingMode: activeLog.billingMode,
      };
    }

    const durationInMinutes = Math.ceil(
      (checkOutTime - new Date(activeLog.checkInAt)) / (1000 * 60),
    );
    const totalFee = parseFloat((durationInMinutes * FEE_PER_MINUTE).toFixed(1));

    let deductBonus;
    let deductCash = 0;
    if (member.bonusWallet >= totalFee) {
      deductBonus = totalFee;
    } else {
      deductBonus = member.bonusWallet;
      deductCash = totalFee - member.bonusWallet;
    }

    const updatedLog = await tx.checkInLog.update({
      where: { id: activeLog.id },
      data: { checkOutAt: checkOutTime, fee: totalFee },
    });

    const updatedMember = await tx.member.update({
      where: { id: memberId },
      data: {
        bonusWallet: { decrement: deductBonus },
        cashWallet: { decrement: deductCash },
      },
    });

    return {
      member: updatedMember,
      log: updatedLog,
      exitMethod,
      feeDetails: { totalFee, paidByBonus: deductBonus, paidByCash: deductCash },
      remaining: {
        cash: updatedMember.cashWallet,
        bonus: updatedMember.bonusWallet,
      },
      billingMode: activeLog.billingMode,
    };
  });
}

export function broadcastCheckOut(result) {
  broadcastOccupancy({ type: 'check-out', memberId: result.member.id }).catch(() => {});
}

export function checkOutSuccessPayload(result) {
  const { member, feeDetails, remaining, exitMethod, billingMode, log } = result;
  const isMonthly = billingMode === '月費通行';
  return {
    status: 'success',
    message: isMonthly
      ? '【體育客】月卡會員出場成功 (本次 0 元)！'
      : '【體育客】計時出場結算成功！',
    memberName: member.name,
    memberId: member.id,
    exitMethod,
    billingMode,
    checkOutAt: log.checkOutAt,
    gateLogId: log.id,
    gateAccessNo: formatGateAccessNo(log.checkInAt),
    feeDetails,
    remaining,
  };
}
