// lib/memberContract.js — 會員合約簽署檢查與待簽建立
import prisma from './prisma.js';
import {
  DEFAULT_VERSION_BASE,
  buildVersionLabel,
} from './contractVersionLabel.js';

export const CONTRACT_PURPOSE = {
  GENERAL: 'GENERAL',
  BIOMETRICS_CONSENT: 'BIOMETRICS_CONSENT',
  /** 新會員入會定型化契約（自助註冊必簽；全站至多一份啟用） */
  NEW_MEMBER: 'NEW_MEMBER',
};

export function parseContractIds(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    const err = new Error('contractIds 必須為陣列');
    err.statusCode = 400;
    throw err;
  }
  const ids = [...new Set(raw.map((id) => parseInt(id, 10)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    const err = new Error('contractIds 含無效 ID');
    err.statusCode = 400;
    throw err;
  }
  return ids;
}

/** 取得合約目前最新「啟用中」版本（依 version 數字） */
export async function getCurrentContractVersion(tx, contractId) {
  return tx.membershipContractVersion.findFirst({
    where: { contractId, status: 'ACTIVE' },
    orderBy: { version: 'desc' },
  });
}

export async function assertActiveContracts(tx, contractIds) {
  if (!contractIds.length) return [];
  const rows = await tx.membershipContract.findMany({
    where: { id: { in: contractIds }, status: 'ACTIVE' },
    select: { id: true, title: true },
  });
  if (rows.length !== contractIds.length) {
    const err = new Error('部分合約不存在或已作廢，請重新選擇');
    err.statusCode = 400;
    throw err;
  }
  return rows;
}

/**
 * 方案需簽署合約時，同步 PromotionMembershipContract。
 * requiresMemberContract=false → 清空連結
 * true → 必須至少一筆 ACTIVE 合約
 */
export async function syncPromotionContracts(tx, promotionId, {
  requiresMemberContract,
  contractIds,
}) {
  if (!requiresMemberContract) {
    await tx.promotionMembershipContract.deleteMany({ where: { promotionId } });
    return [];
  }

  const ids = parseContractIds(contractIds);
  if (!ids || ids.length === 0) {
    const err = new Error('勾選需簽署會員合約時，請至少選擇一份合約');
    err.statusCode = 400;
    throw err;
  }

  await assertActiveContracts(tx, ids);
  await tx.promotionMembershipContract.deleteMany({ where: { promotionId } });
  await tx.promotionMembershipContract.createMany({
    data: ids.map((contractId) => ({ promotionId, contractId })),
  });
  return ids;
}

export function mapPromotionContracts(promotion) {
  const links = promotion?.contractLinks || [];
  return links.map((link) => ({
    id: link.contract.id,
    title: link.contract.title,
    shortName: link.contract.shortName || null,
    displayName: link.contract.shortName || link.contract.title,
    status: link.contract.status,
  }));
}

/** 確保會員對指定合約的「目前版本」有 PENDING／SIGNED 紀錄；回傳列並標記 newlyCreated */
export async function ensurePendingSignatures(tx, memberId, contractIds, { staffId } = {}) {
  const created = [];
  const newlyCreated = [];
  for (const contractId of contractIds) {
    const version = await getCurrentContractVersion(tx, contractId);
    if (!version) {
      const err = new Error(`合約 #${contractId} 尚無內容版本`);
      err.statusCode = 400;
      throw err;
    }
    const existing = await tx.memberContractSignature.findUnique({
      where: {
        memberId_contractVersionId: {
          memberId,
          contractVersionId: version.id,
        },
      },
    });
    if (existing) {
      created.push(existing);
      continue;
    }
    const row = await tx.memberContractSignature.create({
      data: {
        memberId,
        contractId,
        contractVersionId: version.id,
        status: 'PENDING',
        staffId: staffId ?? null,
      },
    });
    created.push(row);
    newlyCreated.push(row);
  }
  created.newlyCreated = newlyCreated;
  return created;
}

/** 購案前：檢查方案連結的目前版本皆已 SIGNED */
export async function assertMemberSignedPromotionContracts(memberId, promotionId) {
  const links = await prisma.promotionMembershipContract.findMany({
    where: { promotionId },
    include: {
      contract: { select: { id: true, title: true, shortName: true, status: true } },
    },
  });

  if (links.length === 0) {
    const err = new Error('此方案需簽署合約，但尚未綁定任何合約範本，請洽總部');
    err.statusCode = 400;
    throw err;
  }

  const missing = [];
  for (const link of links) {
    if (link.contract.status !== 'ACTIVE') {
      missing.push(`${link.contract.title}（已作廢）`);
      continue;
    }
    const version = await getCurrentContractVersion(prisma, link.contractId);
    if (!version) {
      missing.push(link.contract.title);
      continue;
    }
    const signed = await prisma.memberContractSignature.findFirst({
      where: {
        memberId,
        contractVersionId: version.id,
        status: 'SIGNED',
      },
    });
    if (!signed) missing.push(link.contract.title);
  }

  if (missing.length) {
    const err = new Error(
      `請先至會員管理完成合約簽署：${missing.join('、')}`,
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 課程方案需簽署合約時，同步 CoursePlanMembershipContract。
 */
export async function syncCoursePlanContracts(tx, coursePlanId, {
  requiresMemberContract,
  contractIds,
}) {
  if (!requiresMemberContract) {
    await tx.coursePlanMembershipContract.deleteMany({ where: { coursePlanId } });
    return [];
  }

  const ids = parseContractIds(contractIds);
  if (!ids || ids.length === 0) {
    const err = new Error('勾選需簽署會員合約時，請至少選擇一份合約');
    err.statusCode = 400;
    throw err;
  }

  await assertActiveContracts(tx, ids);
  await tx.coursePlanMembershipContract.deleteMany({ where: { coursePlanId } });
  await tx.coursePlanMembershipContract.createMany({
    data: ids.map((contractId) => ({ coursePlanId, contractId })),
  });
  return ids;
}

export function mapCoursePlanContracts(coursePlan) {
  const links = coursePlan?.contractLinks || [];
  return links.map((link) => ({
    id: link.contract.id,
    title: link.contract.title,
    shortName: link.contract.shortName || null,
    displayName: link.contract.shortName || link.contract.title,
    status: link.contract.status,
  }));
}

/** 購課前：檢查課程方案連結的目前版本皆已 SIGNED */
export async function assertMemberSignedCoursePlanContracts(memberId, coursePlanId) {
  const links = await prisma.coursePlanMembershipContract.findMany({
    where: { coursePlanId },
    include: {
      contract: { select: { id: true, title: true, shortName: true, status: true } },
    },
  });

  if (links.length === 0) {
    const err = new Error('此課程方案需簽署合約，但尚未綁定任何合約範本，請洽總部');
    err.statusCode = 400;
    throw err;
  }

  const missing = [];
  for (const link of links) {
    if (link.contract.status !== 'ACTIVE') {
      missing.push(`${link.contract.title}（已作廢）`);
      continue;
    }
    const version = await getCurrentContractVersion(prisma, link.contractId);
    if (!version) {
      missing.push(link.contract.title);
      continue;
    }
    const signed = await prisma.memberContractSignature.findFirst({
      where: {
        memberId,
        contractVersionId: version.id,
        status: 'SIGNED',
      },
    });
    if (!signed) missing.push(link.contract.title);
  }

  if (missing.length) {
    const err = new Error(
      `請先至會員管理完成合約簽署：${missing.join('、')}`,
    );
    err.statusCode = 400;
    throw err;
  }
}

/** 被任一「需簽署合約」方案／課程綁定的合約 ID；另含全站「新會員／會員契約」必簽 */
export async function getRequiredContractIdSet() {
  const [promoLinks, courseLinks, newMember] = await Promise.all([
    prisma.promotionMembershipContract.findMany({
      where: { promotion: { requiresMemberContract: true, isActive: true } },
      select: { contractId: true },
    }),
    prisma.coursePlanMembershipContract.findMany({
      where: { coursePlan: { requiresMemberContract: true, isActive: true } },
      select: { contractId: true },
    }),
    findNewMemberContract(),
  ]);
  const ids = new Set([
    ...promoLinks.map((l) => l.contractId),
    ...courseLinks.map((l) => l.contractId),
  ]);
  if (newMember?.id) ids.add(newMember.id);
  return ids;
}

export function isNewMemberContract(contract) {
  if (!contract) return false;
  if (contract.purpose === CONTRACT_PURPOSE.NEW_MEMBER) return true;
  return /新會員/.test(`${contract.title || ''}${contract.shortName || ''}`);
}

/**
 * 啟用中的會員／入會契約（purpose=NEW_MEMBER；相容標題／簡稱含「新會員」）
 */
export async function findNewMemberContract(db = prisma) {
  const include = {
    versions: {
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      take: 1,
    },
  };
  const byPurpose = await db.membershipContract.findMany({
    where: { status: 'ACTIVE', purpose: CONTRACT_PURPOSE.NEW_MEMBER },
    include,
    orderBy: { id: 'asc' },
    take: 1,
  });
  if (byPurpose[0]) return byPurpose[0];

  const active = await db.membershipContract.findMany({
    where: { status: 'ACTIVE' },
    include,
    orderBy: { id: 'asc' },
  });
  return (
    active.find((c) => /新會員/.test(`${c.title || ''}${c.shortName || ''}`)) || null
  );
}

export async function memberHasSignedNewMemberContract(memberId, db = prisma) {
  const contract = await findNewMemberContract(db);
  const version = contract?.versions?.[0];
  if (!version) return true; // 尚未設定範本 → 不擋進場
  const signed = await db.memberContractSignature.findFirst({
    where: {
      memberId,
      contractVersionId: version.id,
      status: 'SIGNED',
    },
    select: { id: true },
  });
  return Boolean(signed);
}

/** 進場／門禁碼：未簽會員契約則拒絕（有啟用中範本時） */
export async function assertMemberSignedNewMemberContract(memberId, db = prisma) {
  const contract = await findNewMemberContract(db);
  if (!contract?.versions?.[0]) return null;
  const ok = await memberHasSignedNewMemberContract(memberId, db);
  if (!ok) {
    const label = contract.shortName || contract.title || '會員契約';
    const err = new Error(
      `⚖️ 請先完成「${label}」電子簽名，始可進場（必簽未簽）`,
    );
    err.statusCode = 403;
    throw err;
  }
  return contract;
}

export function isBiometricsConsentContract(contract) {
  if (!contract) return false;
  if (contract.purpose === CONTRACT_PURPOSE.BIOMETRICS_CONSENT) return true;
  return /生物辨識/.test(`${contract.title || ''}${contract.shortName || ''}`);
}

/**
 * 啟用中的生物辨識同意書（purpose 優先；相容標題／簡稱含「生物辨識」）
 * 以記憶體過濾 purpose，避免 Prisma Client 未 regenerate 時 where 驗證炸掉
 */
export async function findBiometricsConsentContract(db = prisma) {
  const rows = await db.membershipContract.findMany({
    where: { status: 'ACTIVE' },
    include: {
      versions: {
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
    orderBy: { id: 'asc' },
  });
  const byPurpose = rows.find(
    (c) => c.purpose === CONTRACT_PURPOSE.BIOMETRICS_CONSENT,
  );
  if (byPurpose) return byPurpose;
  return (
    rows.find((c) => /生物辨識/.test(`${c.title || ''}${c.shortName || ''}`)) || null
  );
}

export async function memberHasSignedBiometricsConsent(memberId, db = prisma) {
  const contract = await findBiometricsConsentContract(db);
  const version = contract?.versions?.[0];
  if (!version) return false;
  const signed = await db.memberContractSignature.findFirst({
    where: {
      memberId,
      contractVersionId: version.id,
      status: 'SIGNED',
    },
    select: { id: true },
  });
  return Boolean(signed);
}

export async function assertMemberSignedBiometricsConsent(memberId, db = prisma) {
  const contract = await findBiometricsConsentContract(db);
  if (!contract) {
    const err = new Error(
      '尚未設定啟用中的「生物辨識同意書」合約，請洽總部於「合約」建立並標註用途',
    );
    err.statusCode = 400;
    throw err;
  }
  const ok = await memberHasSignedBiometricsConsent(memberId, db);
  if (!ok) {
    const label = contract.shortName || contract.title;
    const err = new Error(
      `⚖️ 請先完成「${label}」電子簽名，始可辦理／使用人臉辨識`,
    );
    err.statusCode = 403;
    throw err;
  }
  return contract;
}

/** 依同意書目前版本簽署狀態同步 Member.allowBiometrics */
export async function syncMemberAllowBiometrics(memberId, db = prisma) {
  const allowed = await memberHasSignedBiometricsConsent(memberId, db);
  return db.member.update({
    where: { id: memberId },
    data: { allowBiometrics: allowed },
  });
}

/** 建立／標註生物辨識同意書時，確保全站僅一份啟用 */
export async function assertUniqueBiometricsConsent(tx, { excludeId } = {}) {
  const rows = await tx.membershipContract.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, title: true, shortName: true, purpose: true },
  });
  const existing = rows.find((c) => {
    if (excludeId && c.id === excludeId) return false;
    if (c.purpose === CONTRACT_PURPOSE.BIOMETRICS_CONSENT) return true;
    return /生物辨識/.test(`${c.title || ''}${c.shortName || ''}`);
  });
  if (existing) {
    const err = new Error(
      `已有啟用中的生物辨識同意書「${existing.shortName || existing.title}」，請先作廢或改為一般合約`,
    );
    err.statusCode = 400;
    throw err;
  }
}

/** 新會員入會契約：全站僅一份啟用（自助註冊必簽） */
export async function assertUniqueNewMemberContract(tx, { excludeId } = {}) {
  const rows = await tx.membershipContract.findMany({
    where: { status: 'ACTIVE', purpose: CONTRACT_PURPOSE.NEW_MEMBER },
    select: { id: true, title: true, shortName: true },
  });
  const existing = rows.find((c) => !(excludeId && c.id === excludeId));
  if (existing) {
    const err = new Error(
      `已有啟用中的新會員契約「${existing.shortName || existing.title}」，請先作廢或改為一般合約`,
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 批次：哪些會員已簽署目前生物辨識同意書版本
 * @returns {Promise<Set<number>>}
 */
export async function getBiometricsSignedMemberIdSet(memberIds, db = prisma) {
  const ids = [...new Set((memberIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Set();
  const contract = await findBiometricsConsentContract(db);
  const versionId = contract?.versions?.[0]?.id;
  if (!versionId) return new Set();
  const rows = await db.memberContractSignature.findMany({
    where: {
      memberId: { in: ids },
      contractVersionId: versionId,
      status: 'SIGNED',
    },
    select: { memberId: true },
  });
  return new Set(rows.map((r) => r.memberId));
}

/**
 * 合約升版後：曾簽署或待簽舊版的會員改對「新版本」建立 PENDING，強制重簽。
 * 並將舊版上殘留的 PENDING 標註清理（改為 VOIDED 狀態欄位不存在於 signature，改刪除未簽舊版列）。
 * @returns {Promise<number[]>} 需重簽的 memberId 列表
 */
export async function enqueueResignForNewVersion(
  tx,
  { contractId, newVersionId, staffId } = {},
) {
  if (!Number.isInteger(contractId) || !Number.isInteger(newVersionId)) {
    return [];
  }

  const prior = await tx.memberContractSignature.findMany({
    where: {
      contractId,
      contractVersionId: { not: newVersionId },
      status: { in: ['SIGNED', 'PENDING'] },
    },
    select: { memberId: true, status: true },
  });
  const memberIds = [...new Set(prior.map((p) => p.memberId))];

  // 清除舊版未完成的 PENDING，避免對已作廢版本誤簽
  await tx.memberContractSignature.deleteMany({
    where: {
      contractId,
      contractVersionId: { not: newVersionId },
      status: 'PENDING',
    },
  });

  if (!memberIds.length) return [];

  const existing = await tx.memberContractSignature.findMany({
    where: {
      contractVersionId: newVersionId,
      memberId: { in: memberIds },
    },
    select: { memberId: true },
  });
  const already = new Set(existing.map((e) => e.memberId));

  const toCreate = memberIds.filter((mid) => !already.has(mid));
  if (toCreate.length) {
    await tx.memberContractSignature.createMany({
      data: toCreate.map((memberId) => ({
        memberId,
        contractId,
        contractVersionId: newVersionId,
        status: 'PENDING',
        staffId: staffId ?? null,
      })),
      skipDuplicates: true,
    });
  }

  return memberIds;
}

/**
 * 會員列表用：列出所有啟用中合約範本 + 該會員目前版本簽署狀態
 * tone: signed(綠) | unsigned(灰) | required(紅＝必需簽但未簽) | resign(紅＝版本異動需重簽)
 * 生物辨識同意書：僅當 Member.faceEnabled=true 時才標 required／resign
 * 會員／入會契約（NEW_MEMBER）：一律必簽，未簽標紅
 */
export async function buildMembersContractBoard(memberIds) {
  const ids = [...new Set((memberIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  const contracts = await prisma.membershipContract.findMany({
    where: { status: 'ACTIVE' },
    include: {
      versions: {
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
    orderBy: { id: 'desc' },
  });

  const requiredIds = await getRequiredContractIdSet();
  const versionIds = contracts
    .map((c) => c.versions[0]?.id)
    .filter((id) => Number.isInteger(id));
  const contractIds = contracts.map((c) => c.id);

  const faceRows = ids.length
    ? await prisma.member.findMany({
        where: { id: { in: ids } },
        select: { id: true, faceEnabled: true },
      })
    : [];
  const faceEnabledByMember = new Map(faceRows.map((m) => [m.id, Boolean(m.faceEnabled)]));

  const signatures = ids.length && versionIds.length
    ? await prisma.memberContractSignature.findMany({
        where: {
          memberId: { in: ids },
          contractVersionId: { in: versionIds },
        },
        select: {
          id: true,
          memberId: true,
          contractId: true,
          contractVersionId: true,
          status: true,
          signedAt: true,
        },
      })
    : [];

  const priorSignedRows =
    ids.length && contractIds.length
      ? await prisma.memberContractSignature.findMany({
          where: {
            memberId: { in: ids },
            contractId: { in: contractIds },
            status: 'SIGNED',
            ...(versionIds.length ? { contractVersionId: { notIn: versionIds } } : {}),
          },
          select: { memberId: true, contractId: true },
        })
      : [];

  const priorSignedKeys = new Set(
    priorSignedRows.map((r) => `${r.memberId}:${r.contractId}`),
  );

  const sigKey = (memberId, versionId) => `${memberId}:${versionId}`;
  const sigMap = new Map();
  for (const s of signatures) {
    sigMap.set(sigKey(s.memberId, s.contractVersionId), s);
  }

  const boardByMember = new Map();
  for (const memberId of ids) {
    const faceEnabled = faceEnabledByMember.get(memberId) === true;
    boardByMember.set(
      memberId,
      contracts.map((c) => {
        const version = c.versions[0] || null;
        const sig = version ? sigMap.get(sigKey(memberId, version.id)) : null;
        const isSigned = sig?.status === 'SIGNED';
        const isBio = isBiometricsConsentContract(c);
        const isNewMember = isNewMemberContract(c);
        const isRequired = isBio
          ? faceEnabled
          : isNewMember || requiredIds.has(c.id);
        let needsResign =
          !isSigned && priorSignedKeys.has(`${memberId}:${c.id}`);
        if (isBio && !faceEnabled) needsResign = false;
        let tone = 'unsigned';
        if (isSigned) tone = 'signed';
        else if (needsResign) tone = 'resign';
        else if (isRequired) tone = 'required';

        const versionBase = c.versionBase || DEFAULT_VERSION_BASE;
        return {
          contractId: c.id,
          title: c.title,
          shortName: c.shortName || null,
          displayName: c.shortName || c.title,
          purpose: c.purpose || CONTRACT_PURPOSE.GENERAL,
          versionId: version?.id ?? null,
          version: version?.version ?? null,
          versionLabel: version
            ? buildVersionLabel(versionBase, version.version)
            : null,
          signatureId: sig?.id ?? null,
          status: isSigned
            ? 'SIGNED'
            : needsResign
              ? sig
                ? 'PENDING'
                : 'NEEDS_RESIGN'
              : sig
                ? 'PENDING'
                : 'UNSIGNED',
          required: isRequired,
          needsResign,
          tone,
          signedAt: sig?.signedAt ?? null,
        };
      }),
    );
  }

  return { contracts, boardByMember, requiredIds };
}

export function serializeSignature(row) {
  const fullTitle = row.contract?.title ?? null;
  const shortName = row.contract?.shortName || null;
  const versionBase = row.contract?.versionBase || DEFAULT_VERSION_BASE;
  const versionNum = row.contractVersion?.version ?? null;
  return {
    id: row.id,
    memberId: row.memberId,
    contractId: row.contractId,
    contractTitle: fullTitle,
    contractShortName: shortName,
    contractDisplayName: shortName || fullTitle,
    contractStatus: row.contract?.status ?? null,
    contractVersionId: row.contractVersionId,
    version: versionNum,
    versionLabel:
      versionNum != null ? buildVersionLabel(versionBase, versionNum) : null,
    body: row.contractVersion?.body ?? null,
    bodyHash: row.bodyHash || row.contractVersion?.bodyHash || null,
    changeNote: row.contractVersion?.changeNote ?? null,
    status: row.status,
    signatureData: row.status === 'SIGNED' ? row.signatureData : null,
    ipAddress: row.ipAddress || null,
    userAgent: row.userAgent || null,
    actorType: row.actorType || null,
    signedAt: row.signedAt,
    staffId: row.staffId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const signatureInclude = {
  contract: {
    select: { id: true, title: true, shortName: true, status: true, versionBase: true },
  },
  contractVersion: {
    select: { id: true, version: true, body: true, changeNote: true },
  },
};

/** 同一合約範本下，該會員各版本簽署列（新→舊） */
export async function listMemberContractHistory(memberId, contractId, db = prisma) {
  const rows = await db.memberContractSignature.findMany({
    where: { memberId, contractId },
    include: signatureInclude,
    orderBy: [{ contractVersion: { version: 'desc' } }, { id: 'desc' }],
  });
  return rows.map(serializeSignature);
}
