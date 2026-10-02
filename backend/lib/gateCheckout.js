// lib/gateCheckout.js — 進出場出場結算（閘機／櫃檯補登共用）
import prisma from './prisma.js';
import { memberHasSignedBiometricsConsent } from './memberContract.js';
import { assertMemberBoundGateAccess } from './memberBranch.js';
import { broadcastOccupancy } from './occupancy.js';
import { broadcastGateAlert } from './gateAlert.js';
import { formatGateAccessNo } from './gateAccessNo.js';
import { lockMemberRow, lockActiveCheckInLog } from './dbLocks.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet, roundMoney } from './walletMutation.js';

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
      if (!(await memberHasSignedBiometricsConsent(memberId, tx)) || !member.papagoFaceId) {
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
    const totalFee = roundMoney(durationInMinutes * FEE_PER_MINUTE);
    const availCash = roundMoney(member.cashWallet);
    const availBonus = roundMoney(member.bonusWallet);
    const available = roundMoney(availCash + availBonus);

    // 餘額不足：不扣任何款項、維持在場（防補儲值重刷重複計費），記錄差額、閘機不開門
    if (totalFee > available) {
      const shortfall = roundMoney(totalFee - available);
      const updatedLog = await tx.checkInLog.update({
        where: { id: activeLog.id },
        data: { shortfallAmt: shortfall },
      });
      return {
        member,
        log: updatedLog,
        exitMethod,
        feeDetails: { totalFee, paidByBonus: 0, paidByCash: 0, shortfall },
        remaining: { cash: availCash, bonus: availBonus },
        billingMode: activeLog.billingMode,
        settled: false,
        gateOpen: false,
      };
    }

    // 先運動金後本金，一次全額扣款
    const charged =
      totalFee > 0
        ? await mutateMemberWallet(tx, {
            memberId,
            txType: WALLET_TX.GATE_CHECKOUT,
            mode: WALLET_MODE.WATERFALL_DEDUCT,
            amount: totalFee,
            reason: `計時出場 ${durationInMinutes} 分 × $${FEE_PER_MINUTE}`,
            refType: 'CHECKIN',
            refId: activeLog.id,
            branchId,
          })
        : null;
    const paidByBonus = charged ? -charged.delta.bonus : 0;
    const paidByCash = charged ? -charged.delta.cash : 0;
    const wallets = charged?.after ?? { cash: availCash, bonus: availBonus };

    const updatedLog = await tx.checkInLog.update({
      where: { id: activeLog.id },
      data: {
        checkOutAt: checkOutTime,
        fee: totalFee,
        deductedBonus: paidByBonus,
        deductedCash: paidByCash,
        shortfallAmt: 0,
      },
    });

    return {
      member: { ...member, cashWallet: wallets.cash, bonusWallet: wallets.bonus },
      log: updatedLog,
      exitMethod,
      feeDetails: { totalFee, paidByBonus, paidByCash, shortfall: 0 },
      remaining: { cash: wallets.cash, bonus: wallets.bonus },
      billingMode: activeLog.billingMode,
      settled: true,
      gateOpen: true,
    };
  });
}

export function broadcastCheckOut(result) {
  const shortfall = Number(result.feeDetails?.shortfall) || 0;
  if (result.settled !== false) {
    broadcastOccupancy({ type: 'check-out', memberId: result.member.id }).catch(() => {});
  }
  if (shortfall > 0) {
    try {
      broadcastGateAlert({
        code: 'EXIT_SHORTFALL',
        title: '出場餘額不足',
        severity: 'high',
        message: `計時出場費 $${result.feeDetails.totalFee}，錢包不足 $${shortfall}，未扣款、仍在場，閘機不開門；請引導儲值後再刷出`,
        memberId: result.member.id,
        memberName: result.member.name,
        branchId: result.log?.branchId ?? null,
      });
    } catch {
      /* ignore */
    }
  }
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
        ? `【體育客】餘額不足 $${shortfall}，未扣款、尚未出場，閘機不開門；請儲值後再刷出。`
        : '【體育客】計時出場結算成功！',
    settled: result.settled !== false,
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
