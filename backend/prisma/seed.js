// prisma/seed.js — 體育客系統種子資料（可重複執行）
import 'dotenv/config';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { allocateUniqueMemberNo, backfillMissingMemberNos } from '../lib/memberNo.js';

async function main() {
  console.log('🌱 開始灌入體育客種子資料...');

  // 1. 分店（以代碼為穩定鍵，避免正式名稱變更造成重複列）
  let branch = await prisma.branch.findUnique({ where: { code: 'HP' } });
  if (!branch) {
    branch = await prisma.branch.findFirst({
      where: { OR: [{ name: '和平店' }, { name: '體育客和平店' }] },
      orderBy: { id: 'asc' },
    });
  }
  if (branch) {
    branch = await prisma.branch.update({
      where: { id: branch.id },
      data: {
        name: branch.name.includes('和平') ? branch.name : '和平店',
        code: 'HP',
        address: '台北市信義區和平東路三段333號B1',
        isActive: true,
      },
    });
  } else {
    branch = await prisma.branch.create({
      data: {
        name: '和平店',
        code: 'HP',
        address: '台北市信義區和平東路三段333號B1',
        isActive: true,
      },
    });
  }

  // 1b. 共享分店：HR（私教與 HP 共享）、AC（進出場與 HP 共享）
  async function upsertBranchByCode({ code, name, address }) {
    let row = await prisma.branch.findUnique({ where: { code } });
    if (!row) {
      row = await prisma.branch.findFirst({ where: { name }, orderBy: { id: 'asc' } });
    }
    if (row) {
      return prisma.branch.update({
        where: { id: row.id },
        data: { name, code, address, isActive: true },
      });
    }
    return prisma.branch.create({
      data: { name, code, address, isActive: true },
    });
  }
  const branchHr = await upsertBranchByCode({
    code: 'HR',
    name: '華榮店',
    address: '台北市（示範）華榮店',
  });
  const branchAc = await upsertBranchByCode({
    code: 'AC',
    name: '安和店',
    address: '台北市（示範）安和店',
  });
  for (const b of [branchHr, branchAc]) {
    const vName = b.code === 'HR' ? '私教區' : '訓練區';
    const existingV = await prisma.venue.findFirst({
      where: { branchId: b.id, name: vName },
    });
    if (!existingV) {
      await prisma.venue.create({ data: { branchId: b.id, name: vName } });
    }
  }

  // 2. 場地（依分店 + 名稱查詢後 upsert）
  const existingVenue = await prisma.venue.findFirst({
    where: { branchId: branch.id, name: '私教區' },
  });
  const venue = existingVenue
    ? existingVenue
    : await prisma.venue.create({
        data: { branchId: branch.id, name: '私教區' },
      });

  // 3. 促銷商品
  const promoDefs = [
    { name: '一般儲值', price: 100, bonusGiven: 0, usageType: 'TIMED', planMode: 'STANDING' },
    { name: '500贈100', price: 1000, bonusGiven: 200, usageType: 'TIMED', planMode: 'STANDING' },
    {
      name: '30日月卡',
      price: 950,
      bonusGiven: 0,
      usageType: 'UNLIMITED',
      planMode: 'STANDING',
      unitDays: 30,
      periodCount: 1,
      durationDays: 30,
      requiresMemberContract: true,
      enableCardRecurring: false,
    },
  ];
  for (const p of promoDefs) {
    const found = await prisma.promotion.findFirst({
      where: { branchId: branch.id, name: p.name },
    });
    if (found) {
      await prisma.promotion.update({
        where: { id: found.id },
        data: {
          price: p.price,
          bonusGiven: p.bonusGiven,
          usageType: p.usageType,
          planMode: p.planMode,
          unitDays: p.unitDays ?? null,
          periodCount: p.periodCount ?? null,
          durationDays: p.durationDays ?? null,
          requiresMemberContract: p.requiresMemberContract ?? false,
          enableCardRecurring: p.enableCardRecurring ?? false,
          isActive: true,
        },
      });
    } else {
      await prisma.promotion.create({
        data: {
          ...p,
          branchId: branch.id,
          isActive: true,
        },
      });
    }
  }

  // 4. 教練 + 分店指派
  const trainer = await prisma.trainer.upsert({
    where: { phone: '0911000001' },
    update: { name: '李教練', displayName: '匿名', role: 'NORMAL', isActive: true },
    create: {
      name: '李教練',
      displayName: '匿名',
      phone: '0911000001',
      role: 'NORMAL',
      isActive: true,
    },
  });
  await prisma.trainerBranch.upsert({
    where: {
      trainerId_branchId: { trainerId: trainer.id, branchId: branch.id },
    },
    update: {},
    create: { trainerId: trainer.id, branchId: branch.id },
  });
  // HP 教練亦可在 HR 上私教（場地共享）
  await prisma.trainerBranch.upsert({
    where: {
      trainerId_branchId: { trainerId: trainer.id, branchId: branchHr.id },
    },
    update: {},
    create: { trainerId: trainer.id, branchId: branchHr.id },
  });

  // 5. 總部 ADMIN 員工帳號（密碼：admin1234）
  const hashed = await bcrypt.hash('admin1234', 10);
  const staff = await prisma.staff.upsert({
    where: { account: 'admin' },
    update: { password: hashed, name: '總部管理員', displayName: '匿名', role: 'ADMIN', isActive: true },
    create: {
      account: 'admin',
      password: hashed,
      name: '總部管理員',
      displayName: '匿名',
      role: 'ADMIN',
      isActive: true,
    },
  });

  // 5. 示範櫃檯員工（和平店 · 僅櫃檯權限）
  const counterHash = await bcrypt.hash('staff1234', 10);
  const counterStaff = await prisma.staff.upsert({
    where: { account: 'counter' },
    update: {
      password: counterHash,
      name: '和平店櫃檯',
      displayName: '匿名',
      role: 'STAFF',
      branchId: branch.id,
      permissions: ['ops'],
      isActive: true,
    },
    create: {
      account: 'counter',
      password: counterHash,
      name: '和平店櫃檯',
      displayName: '匿名',
      role: 'STAFF',
      branchId: branch.id,
      permissions: ['ops'],
      isActive: true,
    },
  });

  // 5b. 示範值星（DUTY · 可進交易異動）
  const dutyHash = await bcrypt.hash('duty1234', 10);
  const dutyStaff = await prisma.staff.upsert({
    where: { account: 'duty' },
    update: {
      password: dutyHash,
      name: '和平店值星',
      displayName: '匿名',
      role: 'DUTY',
      branchId: branch.id,
      permissions: ['ops'],
      isActive: true,
    },
    create: {
      account: 'duty',
      password: dutyHash,
      name: '和平店值星',
      displayName: '匿名',
      role: 'DUTY',
      branchId: branch.id,
      permissions: ['ops'],
      isActive: true,
    },
  });

  // 6. 示範會員（含現金錢包供 POS 測試）
  const demoMemberNo = (await prisma.member.findUnique({ where: { phone: '0912345678' } }))
    ?.memberNo;
  const member = await prisma.member.upsert({
    where: { phone: '0912345678' },
    update: { name: '示範會員', plan: '計時會員', cashWallet: 1000, bonusWallet: 200 },
    create: {
      memberNo: demoMemberNo || (await allocateUniqueMemberNo()),
      name: '示範會員',
      phone: '0912345678',
      plan: '計時會員',
      role: 'MEMBER',
      cashWallet: 1000,
      bonusWallet: 200,
      allowBiometrics: false,
    },
  });
  // 示範會員綁定和平店（進出場驗證）
  await prisma.memberBranch.upsert({
    where: {
      memberId_branchId: { memberId: member.id, branchId: branch.id },
    },
    update: {},
    create: { memberId: member.id, branchId: branch.id },
  });

  // 示範閘機裝置（和平店進場；金鑰僅開發用）
  const DEMO_GATE_CODE = 'HP-IN-01';
  const DEMO_GATE_KEY = 'gymsaas-demo-gate-key-hp-in-01';
  const demoKeyHash = crypto.createHash('sha256').update(DEMO_GATE_KEY, 'utf8').digest('hex');
  const existingGate = await prisma.gateDevice.findUnique({ where: { code: DEMO_GATE_CODE } });
  if (existingGate) {
    await prisma.gateDevice.update({
      where: { id: existingGate.id },
      data: {
        name: '和平店進場閘（示範）',
        branchId: branch.id,
        keyHash: demoKeyHash,
        keyPrefix: DEMO_GATE_KEY.slice(0, 8),
        isActive: true,
      },
    });
  } else {
    await prisma.gateDevice.create({
      data: {
        code: DEMO_GATE_CODE,
        name: '和平店進場閘（示範）',
        branchId: branch.id,
        keyHash: demoKeyHash,
        keyPrefix: DEMO_GATE_KEY.slice(0, 8),
        isActive: true,
      },
    });
  }

  const backfilled = await backfillMissingMemberNos();
  if (backfilled > 0) {
    console.log(`✅ 已為 ${backfilled} 位既有會員補上會員編號`);
  }

  // 7. 示範進銷存商品（和平店，可立即 POS 測試）
  const productDefs = [
    { sku: 'DR-WA-001', name: '波爾水', price: 15, cost: 7, stockQty: 100 },
    { sku: 'TO2026-BK', name: '運動毛巾', price: 150, cost: 80, stockQty: 100 },
  ];
  for (const p of productDefs) {
    const found = await prisma.product.findFirst({
      where: { branchId: branch.id, sku: p.sku },
    });
    if (found) {
      await prisma.product.update({
        where: { id: found.id },
        data: {
          name: p.name,
          price: p.price,
          cost: p.cost,
          stockQty: p.stockQty,
          isActive: true,
        },
      });
    } else {
      await prisma.product.create({
        data: { ...p, branchId: branch.id, isActive: true },
      });
    }
  }

  console.log('✅ 種子資料完成');
  console.log(`   分店: ${branch.name} (#${branch.id})`);
  console.log(`   場地: ${venue.name} (#${venue.id})`);
  console.log(`   教練: ${trainer.name} (#${trainer.id})`);
  console.log(`   員工登入: account=admin / password=admin1234 (role=${staff.role})`);
  console.log(`   櫃檯示範: account=counter / password=staff1234 (STAFF · 無交易異動)`);
  console.log(`   值星示範: account=duty / password=duty1234 (DUTY · 可交易異動 · ${dutyStaff.name})`);
  console.log(`   示範會員: ${member.name} / ${member.phone} / ${member.memberNo || '(待補號)'}`);
  console.log(`   閘機示範: code=${DEMO_GATE_CODE} / key=${DEMO_GATE_KEY} → /gate 配對`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('❌ 種子失敗:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
