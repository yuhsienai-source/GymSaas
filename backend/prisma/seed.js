// prisma/seed.js — 體育客系統種子資料（可重複執行）
import 'dotenv/config';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { allocateUniqueMemberNo, backfillMissingMemberNos } from '../lib/memberNo.js';
import { DEFAULT_PUBLIC_HOLIDAYS } from '../lib/laborLaw.js';

async function main() {
  console.log('🌱 開始灌入體育客種子資料...');

  // 1. 分店（依組織圖；代碼為穩定鍵，舊代碼／名稱自動改名）
  async function upsertBranch({ code, name, type, parentId = null, address, ubn, legacy = [] }) {
    const legacyKeys = legacy.flatMap((k) => [{ code: k }, { name: k }]);
    let row =
      (await prisma.branch.findFirst({ where: { name } })) ||
      (await prisma.branch.findUnique({ where: { code } })) ||
      (legacyKeys.length
        ? await prisma.branch.findFirst({ where: { OR: legacyKeys }, orderBy: { id: 'asc' } })
        : null);
    const conflicts = await prisma.branch.findMany({
      where: { OR: [{ code }, { name }], ...(row ? { NOT: { id: row.id } } : {}) },
    });
    for (const c of conflicts) {
      await prisma.branch.update({
        where: { id: c.id },
        data: { code: null, name: `${c.name}（停用#${c.id}）`, parentId: null, isActive: false },
      });
    }
    // 一店一統編＝一營業人（ezPay 商店）；MerchantID／HashKey 另於 HQ／env 設定
    const entity = ubn
      ? await prisma.legalEntity.upsert({
          where: { ubn },
          create: { code, name: `體育客 ${name}`, ubn, address, isActive: true },
          update: {},
        })
      : null;
    const data = { name, code, type, parentId, address, legalEntityId: entity?.id ?? null, isActive: true };
    return row
      ? prisma.branch.update({ where: { id: row.id }, data })
      : prisma.branch.create({ data });
  }

  const branch = await upsertBranch({
    code: 'HP',
    name: '和平店',
    type: 'GYM',
    address: '台北市信義區和平東路三段333號B1',
    ubn: '24747555',
    legacy: ['體育客和平店'],
  });
  const branchHr = await upsertBranch({
    code: 'HR',
    name: '熱河教室',
    type: 'CLASS',
    parentId: branch.id,
    address: '台北市（示範）熱河教室',
    ubn: '83122541',
  });
  const branchAc = await upsertBranch({
    code: 'AC',
    name: '體適能學院',
    type: 'ACADEMY',
    address: '台北市大安區和平東路二段（總部培訓基地）',
    ubn: '83004468',
    legacy: ['ACADEMY'],
  });
  const branchFd = await upsertBranch({
    code: 'FD',
    name: '輔大店',
    type: 'GYM',
    address: '新北市新莊區中正路510號',
    ubn: '52555000',
    legacy: ['FJU'],
  });
  for (const b of [branchHr, branchAc, branchFd]) {
    const vName = b.type === 'ACADEMY' ? '學院培訓場' : '重訓區';
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

  // 4. 教練陣容（金牌 GOLD / 銀牌 SILVER；指派和平店、輔大店、體適能學院）
  async function upsertDemoTrainer({ phone, name, role = 'NORMAL', level = 'SILVER', branchIds = [] }) {
    const t = await prisma.trainer.upsert({
      where: { phone },
      update: { name, displayName: '匿名', role, level, isActive: true },
      create: { name, displayName: '匿名', phone, role, level, isActive: true },
    });
    for (const bId of branchIds) {
      await prisma.trainerBranch.upsert({
        where: { trainerId_branchId: { trainerId: t.id, branchId: bId } },
        update: {},
        create: { trainerId: t.id, branchId: bId },
      });
    }
    return t;
  }

  // 和平店教練
  const hpGoldTrainer = await upsertDemoTrainer({
    phone: '0911000001',
    name: '李教練（和平金牌）',
    role: 'NORMAL',
    level: 'GOLD',
    branchIds: [branch.id, branchHr.id],
  });
  await upsertDemoTrainer({
    phone: '0911000002',
    name: '陳教練（和平銀牌）',
    role: 'NORMAL',
    level: 'SILVER',
    branchIds: [branch.id],
  });

  // 輔大店教練
  await upsertDemoTrainer({
    phone: '0911000003',
    name: '張教練（輔大金牌）',
    role: 'NORMAL',
    level: 'GOLD',
    branchIds: [branchFd.id],
  });
  await upsertDemoTrainer({
    phone: '0911000004',
    name: '林教練（輔大銀牌）',
    role: 'NORMAL',
    level: 'SILVER',
    branchIds: [branchFd.id],
  });

  // 體適能學院教練
  await upsertDemoTrainer({
    phone: '0911000005',
    name: '趙教官（學院金牌）',
    role: 'MANAGER',
    level: 'GOLD',
    branchIds: [branchAc.id],
  });
  await upsertDemoTrainer({
    phone: '0911000006',
    name: '孫助教（學院銀牌）',
    role: 'NORMAL',
    level: 'SILVER',
    branchIds: [branchAc.id],
  });

  // 5. 組織架構各級主管與員工帳號（依體育客組織階層圖）
  const passHash = await bcrypt.hash('admin1234', 10);
  const commonPass = await bcrypt.hash('staff1234', 10);

  // 5a. 總公司 (ADMIN)
  const staff = await prisma.staff.upsert({
    where: { account: 'admin' },
    update: { password: passHash, name: '總部管理員', displayName: '匿名', role: 'ADMIN', isActive: true },
    create: { account: 'admin', password: passHash, name: '總部管理員', displayName: '匿名', role: 'ADMIN', isActive: true },
  });

  // 5b. 管理層：GM 店務部主管、FM 教練部主管
  await prisma.staff.upsert({
    where: { account: 'gm' },
    update: { password: commonPass, name: '王大強（店務部主管）', displayName: '匿名', role: 'GM', branchId: null, permissions: ['ops', 'pt'], isActive: true },
    create: { account: 'gm', password: commonPass, name: '王大強（店務部主管）', displayName: '匿名', role: 'GM', branchId: null, permissions: ['ops', 'pt'], isActive: true },
  });

  await prisma.staff.upsert({
    where: { account: 'fm' },
    update: { password: commonPass, name: '林家豪（教練部主管）', displayName: '匿名', role: 'FM', branchId: null, permissions: ['pt', 'trainer'], isActive: true },
    create: { account: 'fm', password: commonPass, name: '林家豪（教練部主管）', displayName: '匿名', role: 'FM', branchId: null, permissions: ['pt', 'trainer'], isActive: true },
  });

  // 5c. 和平店（熱河教室由和平店督導支援）：店長、值班、一般場務
  await prisma.staff.upsert({
    where: { account: 'hp_mgr' },
    update: { password: commonPass, name: '張和平（和平店長）', displayName: '匿名', role: 'STORE_MANAGER', branchId: branch.id, permissions: ['ops', 'pt'], isActive: true },
    create: { account: 'hp_mgr', password: commonPass, name: '張和平（和平店長）', displayName: '匿名', role: 'STORE_MANAGER', branchId: branch.id, permissions: ['ops', 'pt'], isActive: true },
  });
  const counterHash = commonPass;
  await prisma.staff.upsert({
    where: { account: 'counter' },
    update: { password: counterHash, name: '和平店櫃檯', displayName: '匿名', role: 'STAFF', branchId: branch.id, permissions: ['ops'], isActive: true },
    create: { account: 'counter', password: counterHash, name: '和平店櫃檯', displayName: '匿名', role: 'STAFF', branchId: branch.id, permissions: ['ops'], isActive: true },
  });
  const dutyHash = await bcrypt.hash('duty1234', 10);
  const dutyStaff = await prisma.staff.upsert({
    where: { account: 'duty' },
    update: { password: dutyHash, name: '和平店值星', displayName: '匿名', role: 'DUTY', branchId: branch.id, permissions: ['ops'], isActive: true },
    create: { account: 'duty', password: dutyHash, name: '和平店值星', displayName: '匿名', role: 'DUTY', branchId: branch.id, permissions: ['ops'], isActive: true },
  });

  // 5d. 輔大店：店長、值班、一般場務（舊 fju_* 帳號改名為 fd_*）
  for (const suffix of ['mgr', 'duty', 'staff']) {
    const legacy = await prisma.staff.findUnique({ where: { account: `fju_${suffix}` } });
    const current = await prisma.staff.findUnique({ where: { account: `fd_${suffix}` } });
    if (legacy && !current) {
      await prisma.staff.update({ where: { id: legacy.id }, data: { account: `fd_${suffix}` } });
    }
  }
  const fdStaffDefs = [
    { account: 'fd_mgr', name: '郭輔大（輔大店長）', role: 'STORE_MANAGER', permissions: ['ops', 'pt'] },
    { account: 'fd_duty', name: '輔大店值班', role: 'DUTY', permissions: ['ops'] },
    { account: 'fd_staff', name: '輔大店場務', role: 'STAFF', permissions: ['ops'] },
  ];
  for (const d of fdStaffDefs) {
    const data = { ...d, password: commonPass, displayName: '匿名', branchId: branchFd.id, isActive: true };
    await prisma.staff.upsert({ where: { account: d.account }, update: data, create: data });
  }

  // 5e. 體適能學院：教練帳號（TRAINER，綁定孫助教教練檔案）
  const acCoachData = {
    account: 'ac_coach',
    password: commonPass,
    name: '孫助教（學院教練）',
    displayName: '匿名',
    role: 'TRAINER',
    branchId: branchAc.id,
    permissions: ['trainer'],
    isActive: true,
  };
  const acCoach = await prisma.staff.upsert({
    where: { account: 'ac_coach' },
    update: acCoachData,
    create: acCoachData,
  });
  await prisma.trainer.update({ where: { phone: '0911000006' }, data: { staffId: acCoach.id } });

  // 5f. 和平／輔大四週變形排班：週期錨點（週一）＋早晚班各 2 名場務；補足示範排班人力（場務＋實習教練）
  for (const [b, prefix, label] of [[branch, 'hp', '和平'], [branchFd, 'fd', '輔大']]) {
    await prisma.branchRosterConfig.upsert({
      where: { branchId: b.id },
      update: {},
      create: { branchId: b.id, cycleAnchorDate: new Date('2026-01-05T00:00:00Z'), morningHeadcount: 2, eveningHeadcount: 2 },
    });
    const rosterDefs = [
      ...[1, 2, 3].map((n) => ({ account: `${prefix}_floor${n}`, name: `${label}場務${n}`, role: 'STAFF', permissions: ['ops'], employmentType: 'FULL_TIME' })),
      ...[1, 2].map((n) => ({ account: `${prefix}_intern${n}`, name: `${label}實習教練${n}`, role: 'TRAINER', permissions: ['trainer'], employmentType: 'INTERN', weeklyHours: 24 })),
    ];
    for (const d of rosterDefs) {
      await prisma.staff.upsert({
        where: { account: d.account },
        update: {},
        create: { ...d, password: commonPass, displayName: '匿名', branchId: b.id, isActive: true, hireDate: new Date('2026-03-02T00:00:00Z') },
      });
    }
  }

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

  // 7. 示範進銷存：商品主檔（全公司 SKU）＋和平店期初庫存（經 StockMovement OPENING 留痕）
  const productDefs = [
    { sku: 'DR-WA-001', name: '波爾水', listPrice: 15, avgCost: 7, opening: 100 },
    { sku: 'TO2026-BK', name: '運動毛巾', listPrice: 150, avgCost: 80, opening: 100 },
  ];
  for (const p of productDefs) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      create: { sku: p.sku, name: p.name, listPrice: p.listPrice, isActive: true },
      update: { name: p.name, listPrice: p.listPrice, isActive: true },
    });
    const stock = await prisma.branchStock.findUnique({
      where: { branchId_productId: { branchId: branch.id, productId: product.id } },
    });
    if (!stock) {
      await prisma.$transaction(async (tx) => {
        await tx.branchStock.create({
          data: { branchId: branch.id, productId: product.id, onHand: p.opening, avgCost: p.avgCost, isListed: true },
        });
        await tx.stockMovement.create({
          data: {
            branchId: branch.id,
            productId: product.id,
            qtyDelta: p.opening,
            balanceAfter: p.opening,
            unitCost: p.avgCost,
            refType: 'OPENING',
            reason: '種子期初庫存',
          },
        });
      });
    }
  }

  const holidays = await prisma.publicHoliday.createMany({
    data: DEFAULT_PUBLIC_HOLIDAYS.map(([date, name]) => ({ date: new Date(`${date}T00:00:00Z`), name })),
    skipDuplicates: true,
  });
  console.log(`📅 國定假日曆：新增 ${holidays.count} 筆`);

  console.log('✅ 種子資料完成');
  console.log(`   分店: ${branch.name} (#${branch.id})`);
  console.log(`   場地: ${venue.name} (#${venue.id})`);
  console.log(`   教練: ${hpGoldTrainer.name} (#${hpGoldTrainer.id}) 等金銀牌教練已就位`);
  console.log(`   員工登入: account=admin / password=admin1234 (role=${staff.role})`);
  console.log(`   主管示範: account=gm / password=staff1234 (GM 店務主管)`);
  console.log(`   主管示範: account=fm / password=staff1234 (FM 教練主管)`);
  console.log(`   店長示範: account=hp_mgr (和平店長), account=fd_mgr (輔大店長)`);
  console.log(`   教練示範: account=ac_coach / password=staff1234 (TRAINER · 體適能學院)`);
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
