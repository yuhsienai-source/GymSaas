// lib/memberOnboardingGate.js — 會員自助：先簽署（＋人臉偏好）再綁定 LINE／裝置
import prisma from './prisma.js';
import {
  CONTRACT_PURPOSE,
  findBiometricsConsentContract,
  isBiometricsConsentContract,
} from './memberContract.js';
import { buildVersionLabel, DEFAULT_VERSION_BASE } from './contractVersionLabel.js';

/** 自助必簽：新會員入會契約（purpose=NEW_MEMBER；相容標題／簡稱含「新會員」） */
export async function loadNewMemberContract(db = prisma) {
  const include = {
    versions: {
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' },
      take: 1,
    },
  };
  const byPurpose = await db.membershipContract.findMany({
    where: {
      status: 'ACTIVE',
      purpose: CONTRACT_PURPOSE.NEW_MEMBER,
    },
    include,
    orderBy: { id: 'asc' },
    take: 1,
  });
  if (byPurpose.length) return byPurpose;

  const active = await db.membershipContract.findMany({
    where: { status: 'ACTIVE', purpose: CONTRACT_PURPOSE.GENERAL },
    include,
    orderBy: { id: 'asc' },
  });
  const legacy = active.filter((c) =>
    /新會員/.test(`${c.title || ''}${c.shortName || ''}`),
  );
  return legacy.slice(0, 1);
}

/**
 * 簽署清單：入會契約＋（includeBiometrics 時）生物辨識同意書
 * @param {{ includeBiometrics?: boolean }} opts
 */
export async function loadOnboardingContracts(opts = {}, db = prisma) {
  const includeBiometrics = Boolean(opts.includeBiometrics);
  const list = await loadNewMemberContract(db);
  if (!includeBiometrics) return list;

  const bio = await findBiometricsConsentContract(db);
  if (bio && !list.some((c) => c.id === bio.id)) {
    list.push(bio);
  }
  return list;
}

/** 是否已回答過「是否啟用人臉」（含既有已啟用／已綁臉／已簽同意書視為已回答） */
export function hasFacePreference(member) {
  if (!member) return false;
  if (member.facePreferenceSet) return true;
  if (member.faceEnabled || member.allowBiometrics || member.papagoFaceId) return true;
  return false;
}

/**
 * 評估會員是否可進入綁定／發 JWT（一律：人臉偏好 → 必簽契約 → 綁定）
 * @returns {{
 *   faceEnabled: boolean,
 *   facePreferenceReady: boolean,
 *   contracts: object[],
 *   needContracts: boolean,
 *   allContractsSigned: boolean,
 *   missingNewMemberContract: boolean,
 *   nextStep: string,
 *   canBind: boolean,
 * }}
 */
export async function evaluateMemberOnboardingGate(member, db = prisma) {
  if (!member) {
    return {
      faceEnabled: false,
      facePreferenceReady: false,
      contracts: [],
      needContracts: false,
      allContractsSigned: false,
      missingNewMemberContract: false,
      nextStep: 'REGISTER_PROFILE',
      canBind: false,
    };
  }

  const faceEnabled = Boolean(member.faceEnabled);
  const facePreferenceReady = hasFacePreference(member);
  const contracts = await loadOnboardingContracts(
    { includeBiometrics: facePreferenceReady && faceEnabled },
    db,
  );

  const versionIds = contracts.map((c) => c.versions[0]?.id).filter(Boolean);
  const sigs = versionIds.length
    ? await db.memberContractSignature.findMany({
        where: { memberId: member.id, contractVersionId: { in: versionIds } },
        select: { contractId: true, status: true, contractVersionId: true },
      })
    : [];
  const sigByContract = new Map(sigs.map((s) => [s.contractId, s]));
  const contractsStatus = contracts.map((c) => {
    const v = c.versions[0];
    const sig = sigByContract.get(c.id);
    const signed = sig?.status === 'SIGNED';
    return {
      contractId: c.id,
      title: c.title,
      shortName: c.shortName,
      displayName: c.shortName || c.title,
      purpose: c.purpose || null,
      isBiometrics: isBiometricsConsentContract(c),
      versionLabel: v
        ? buildVersionLabel(c.versionBase || DEFAULT_VERSION_BASE, v.version)
        : null,
      signed,
    };
  });

  // 必有入會契約範本且全部簽完，才算完成簽署（禁止無契約時略過直奔綁定）
  const missingNewMemberContract = contracts.length === 0;
  const needContracts = true;
  const allContractsSigned =
    contractsStatus.length > 0 && contractsStatus.every((c) => c.signed);

  const mustBindLine = !member.lineId;
  let nextStep = 'DONE';
  if (!facePreferenceReady) {
    nextStep = 'CHOOSE_FACE';
  } else if (!allContractsSigned) {
    nextStep = 'SIGN_CONTRACTS';
  } else if (mustBindLine) {
    nextStep = 'BIND_LINE';
  } else if (!member.deviceId) {
    nextStep = 'BIND_DEVICE';
  }

  const canBind = facePreferenceReady && allContractsSigned;

  return {
    faceEnabled,
    facePreferenceReady,
    contracts: contractsStatus,
    needContracts,
    allContractsSigned,
    missingNewMemberContract,
    nextStep,
    canBind,
  };
}

/** 綁定 LINE／裝置前強制檢查；未完成則 throw statusCode 400 */
export async function assertMemberReadyToBind(member, db = prisma) {
  const gate = await evaluateMemberOnboardingGate(member, db);
  if (!gate.canBind) {
    const err = new Error(
      gate.nextStep === 'CHOOSE_FACE'
        ? '請先選擇是否使用生物辨識功能，並完成會員契約簽署後再綁定'
        : gate.missingNewMemberContract
          ? '尚未設定啟用中的「新會員」入會契約，請洽櫃檯／總部建立後再繼續'
          : '請先完成會員契約簽署後再綁定 LINE／裝置',
    );
    err.statusCode = 400;
    err.gate = gate;
    throw err;
  }
  return gate;
}

/**
 * LINE 登入發 JWT 前：契約未完成則拒絕（須改走手機驗證完成簽署）
 * 僅缺裝置時仍可登入（needDevice）
 */
export async function assertMemberReadyForLineLogin(member, db = prisma) {
  const gate = await evaluateMemberOnboardingGate(member, db);
  if (gate.nextStep === 'CHOOSE_FACE' || gate.nextStep === 'SIGN_CONTRACTS') {
    const err = new Error(
      gate.nextStep === 'CHOOSE_FACE'
        ? '請先以手機號碼驗證，選擇是否使用生物辨識並完成會員契約簽署後，再使用 LINE 登入'
        : '請先以手機號碼驗證並完成會員契約簽署後，再使用 LINE 登入',
    );
    err.statusCode = 403;
    err.gate = gate;
    throw err;
  }
  return gate;
}
