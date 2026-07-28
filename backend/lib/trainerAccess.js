// lib/trainerAccess.js — 教練個人工作區範圍（資料不共享；ADMIN 全開）
import prisma from './prisma.js';
import { isAdminUser } from './staffAccess.js';

export async function findTrainerByStaffId(staffId) {
  if (!staffId) return null;
  return prisma.trainer.findFirst({
    where: { staffId, isActive: true },
    include: {
      branches: {
        select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
      },
    },
  });
}

/**
 * 解析教練工作區作用對象：
 * - ADMIN：可指定 viewAsTrainerId；未指定則不鎖定（總覽／代排需再指定）
 * - 一般帳號：強制本人綁定的 Trainer；未綁定則 403
 */
export async function resolveTrainerWorkspace(req, { viewAsTrainerId } = {}) {
  if (isAdminUser(req.user)) {
    const raw =
      viewAsTrainerId !== undefined && viewAsTrainerId !== null && viewAsTrainerId !== ''
        ? parseInt(viewAsTrainerId, 10)
        : null;
    if (raw != null) {
      if (!Number.isInteger(raw) || raw <= 0) {
        const err = new Error('viewAsTrainerId 無效');
        err.statusCode = 400;
        throw err;
      }
      const trainer = await prisma.trainer.findUnique({
        where: { id: raw },
        include: {
          branches: {
            select: { branchId: true, branch: { select: { id: true, name: true, code: true } } },
          },
        },
      });
      if (!trainer || !trainer.isActive) {
        const err = new Error('找不到此教練或已停用');
        err.statusCode = 404;
        throw err;
      }
      return { trainer, isAdmin: true, canSwitch: true };
    }
    return { trainer: null, isAdmin: true, canSwitch: true };
  }

  const trainer = await findTrainerByStaffId(req.user?.id);
  if (!trainer) {
    const err = new Error('此帳號尚未綁定教練檔案，請洽總部於「員工管理」連結');
    err.statusCode = 403;
    throw err;
  }
  return { trainer, isAdmin: false, canSwitch: false };
}

/** 非 ADMIN 禁止操作他人 trainerId */
export function assertOwnsTrainerOrAdmin(req, trainerId, linkedTrainerId) {
  if (isAdminUser(req.user)) return;
  const tid = parseInt(trainerId, 10);
  if (!Number.isInteger(tid) || tid !== linkedTrainerId) {
    const err = new Error('⛔ 僅能操作本人教練資料');
    err.statusCode = 403;
    throw err;
  }
}
