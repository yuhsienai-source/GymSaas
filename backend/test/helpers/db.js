// 整合測試資料庫：清表與 fixture（錢包一律經 mutateMemberWallet 入帳，不直寫餘額）
import crypto from 'node:crypto';
import prisma, { closePrisma } from '../../lib/prisma.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from '../../lib/walletMutation.js';

export { prisma, closePrisma };

export async function resetDb() {
  const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`;
  if (!String(db).endsWith('_test')) throw new Error(`拒絕清除非測試庫 ${db}`);
  const rows = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (!rows.length) return;
  await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

const rand = () => crypto.randomBytes(4).toString('hex').toUpperCase();
export const testId = (prefix) => `${prefix}TEST${rand()}`;
export const idempotencyKey = () => crypto.randomBytes(12).toString('hex');

export async function createStaffUser(role = 'ADMIN') {
  const staff = await prisma.staff.create({ data: { account: `t-${rand()}`, password: 'x', name: '測試經辦', role } });
  return { id: staff.id, role, branchIds: [] };
}

export function createBranch(name = `測試店${rand()}`) {
  return prisma.branch.create({ data: { name } });
}

export async function createMember({ cash = 0, bonus = 0 } = {}) {
  const member = await prisma.member.create({ data: { name: '測試會員', phone: `+8869${Date.now() % 1e8}${rand()}` } });
  if (cash || bonus) {
    await prisma.$transaction((tx) =>
      mutateMemberWallet(tx, {
        memberId: member.id,
        txType: WALLET_TX.TOPUP_GRANT,
        mode: WALLET_MODE.CREDIT_BUCKETS,
        cashDelta: cash,
        bonusDelta: bonus,
        reason: '測試入帳',
      }),
    );
  }
  return member;
}

export function walletOf(memberId) {
  return prisma.member.findUnique({ where: { id: memberId }, select: { cashWallet: true, bonusWallet: true } });
}

/** 已付款計時儲值單（現金付款、含入帳快照） */
export function createTimedTopupOrder({ memberId, branchId, amount = 1000, grantedCash = amount, grantedBonus = 100 }) {
  return prisma.order.create({
    data: {
      id: testId('TYK'),
      memberId,
      branchId,
      amount,
      status: 'PAID',
      payMethod: 'CASH',
      itemDesc: `計時儲值 | TIMED | 測試方案`,
      grantedCash,
      grantedBonus,
    },
  });
}
