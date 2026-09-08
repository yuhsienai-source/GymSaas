// lib/gateCheckout.js — 進出場出場結算（閘機／櫃檯補登共用）
import prisma from './prisma.js';
import { memberHasSignedBiometricsConsent } from './memberContract.js';
import { assertMemberBoundGateAccess } from './memberBranch.js';
import { broadcastOccupancy } from './occupancy.js';
import { broadcastGateAlert } from './gateAlert.js';
import { formatGateAccessNo } from './gateAccessNo.js';
import {
  lockMemberRow,
  lockActiveCheckInLog,
  decrementWalletsAtomic,
} from './dbLocks.js';

const FEE_PER_MINUTE = 1.3;

function httpError(message, statusCode, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (extra.code) err.code = extra.code;
  if (extra.memberId != null) err.memberId = extra.memberId;
  return err;
}

/**
 * 依進場快照結算出場（禁止再讀 Member.plan）
 * @param {{ memberId: number, exitMethod: string, branchId: number, logId?: number }} opts
 */
export async function processCheckOut({ memberId, exitMethod, branchId, logId = null }) {
  const checkOutTime = new Date();

  return prisma.$transaction(async (tx) => {
    // 悲觀鎖：先鎖 Member，再鎖 ACTIVE CheckInLog，避免雙重出場／雙重扣款
    const lockedMember = await lockMemberRow(tx, memberId);
    if (!lockedMember) throw httpError('無此會員', 404);

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

    const lockedLog = await lockActiveCheckInLog(tx, { memberId, logId });
    if (!lockedLog) {
      queueMicrotask(() => {
        try {
          broadcastGateAlert({
            code: 'NO_ACTIVE_CHECKIN',
            title: '異常滯留',
            severity: 'high',
            message: `出場刷卡但查無在場紀錄（疑似尾隨進場或重複刷出），請現場查驗`,
            memberId: member.id,
            memberName: member.name,
            branchId,
          });
        } catch {
          /* ignore */
        }
      });
      throw httpError(
        '⛔ 出場失敗：查無在場紀錄（疑似尾隨進場或重複刷出）。閘機不開門，請現場工作人員查驗。',
        409,
        { code: 'NO_ACTIVE_CHECKIN', memberId },
      );
    }

    const activeLog = await tx.checkInLog.findUnique({ where: { id: lockedLog.id } });
    if (!activeLog || activeLog.checkOutAt || activeLog.status !== 'ACTIVE') {
      throw httpError(
        '⛔ 出場失敗：查無在場紀錄（疑似尾隨進場或重複刷出）。閘機不開門，請現場工作人員查驗。',
        409,
        { code: 'NO_ACTIVE_CHECKIN', memberId },
      );
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
        feeDetails: { totalFee: 0, paidByBonus: 0, paidByCash: 0, shortfall: 0 },
        remaining: { cash: member.cashWallet, bonus: member.bonusWallet },
        billingMode: activeLog.billingMode,
      };
    }

    const durationInMinutes = Math.ceil(
      (checkOutTime - new Date(activeLog.checkInAt)) / (1000 * 60),
    );
    const totalFee = parseFloat((durationInMinutes * FEE_PER_MINUTE).toFixed(1));

    // 在鎖內依目前餘額 clamp，絕不寫負數（配合 DB CHECK + 條件式 UPDATE）
    const bonusBal = Number(member.bonusWallet) || 0;
    const cashBal = Number(member.cashWallet) || 0;
    const deductBonus = Math.min(bonusBal, totalFee);
    const needCash = parseFloat((totalFee - deductBonus).toFixed(1));
    const deductCash = Math.min(cashBal, needCash);
    const shortfall = parseFloat((needCash - deductCash).toFixed(1));

    const updatedLog = await tx.checkInLog.update({
      where: { id: activeLog.id },
      data: { checkOutAt: checkOutTime, fee: totalFee },
    });

    const wallets = await decrementWalletsAtomic(tx, memberId, deductBonus, deductCash);
    if (!wallets) {
      throw httpError('⛔ 出場扣款失敗：錢包餘額衝突，請重試或臨櫃處理。', 409, {
        code: 'WALLET_DEDUCT_CONFLICT',
        memberId,
      });
    }

    return {
      member: { ...member, cashWallet: wallets.cashWallet, bonusWallet: wallets.bonusWallet },
      log: updatedLog,
      exitMethod,
      feeDetails: {
        totalFee,
        paidByBonus: deductBonus,
        paidByCash: deductCash,
        shortfall,
      },
      remaining: {
        cash: wallets.cashWallet,
        bonus: wallets.bonusWallet,
      },
      billingMode: activeLog.billingMode,
      // 餘額不足：結算仍完成（釋放在場），但閘機應拒開門／櫃檯介入
      gateOpen: shortfall <= 0,
    };
  });
}

export function broadcastCheckOut(result) {
  broadcastOccupancy({ type: 'check-out', memberId: result.member.id }).catch(() => {});
}

export function checkOutSuccessPayload(result) {
  const { member, feeDetails, remaining, exitMethod, billingMode, log } = result;
  const isMonthly = billingMode === '月費通行';
  const shortfall = Number(feeDetails?.shortfall) || 0;
  const gateOpen = result.gateOpen !== false && shortfall <= 0;
  return {
    status: 'success',
    message: isMonthly
      ? '【體育客】月卡會員出場成功 (本次 0 元)！'
      : shortfall > 0
        ? '【體育客】計時出場已結算，但餘額不足待補扣，閘機不開門。'
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
    gateOpen,
  };
}
