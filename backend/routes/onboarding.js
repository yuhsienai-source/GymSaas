// routes/onboarding.js — 會員自助：手機查詢／OTP／註冊／合約簽署／裝置綁定
import express from 'express';
import prisma from '../lib/prisma.js';
import { normalizePhone } from '../lib/memberIdentify.js';
import { assertTaiwanMobile, sendPhoneOtp, verifyPhoneOtp } from '../lib/phoneOtp.js';
import {
  issueOnboardingToken,
  issueMemberToken,
  verifyOnboardingToken,
  issueLineBindState,
} from '../lib/onboardingAuth.js';
import {
  ensurePendingSignatures,
  findBiometricsConsentContract,
  listMemberContractHistory,
  serializeSignature,
  syncMemberAllowBiometrics,
} from '../lib/memberContract.js';
import {
  assertMemberReadyToBind,
  evaluateMemberOnboardingGate,
  hasFacePreference,
  loadOnboardingContracts,
} from '../lib/memberOnboardingGate.js';
import {
  getRequestClientMeta,
  hashContractBody,
  writeContractAudit,
} from '../lib/contractAudit.js';
import { allocateUniqueMemberNo } from '../lib/memberNo.js';
import {
  assertSelfRegisterBranchId,
  listSelfRegisterBranches,
  setMemberBranches,
} from '../lib/memberBranch.js';
import {
  deviceBindUpdateIfChanged,
  memberTokenDeviceOpts,
} from '../lib/memberDevice.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
const otpSendLimiter = createRateLimiter({
  keyPrefix: 'onboarding-otp-send',
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyFn: (req) => `${req.ip || 'unknown'}:${String(req.body?.phone || '').trim()}`,
  message: '驗證碼發送過於頻繁，請稍後再試',
});
const otpVerifyLimiter = createRateLimiter({
  keyPrefix: 'onboarding-otp-verify',
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFn: (req) => `${req.ip || 'unknown'}:${String(req.body?.phone || '').trim()}`,
  message: '驗證嘗試過於頻繁，請稍後再試',
});

function getBearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function requireOnboarding(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) {
      return res.status(401).json({ status: 'error', message: '請先完成手機驗證' });
    }
    req.onboarding = verifyOnboardingToken(token);
    next();
  } catch (error) {
    return res.status(error.statusCode || 403).json({
      status: 'error',
      message: error.message || '憑證無效',
    });
  }
}

function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return '會員';
  if (s.length === 1) return '*';
  if (s.length === 2) return `${s[0]}*`;
  return `${s[0]}${'*'.repeat(Math.min(s.length - 2, 4))}${s[s.length - 1]}`;
}

function memberPublic(m) {
  return {
    id: m.id,
    memberNo: m.memberNo || null,
    name: m.name,
    phone: m.phone,
    hasLineBound: Boolean(m.lineId),
    hasDeviceBound: Boolean(m.deviceId),
    faceEnabled: Boolean(m.faceEnabled),
    facePreferenceSet: Boolean(m.facePreferenceSet),
    plan: m.plan,
  };
}

async function buildOnboardingStatus(decoded) {
  const phone = decoded.phone;
  let member = null;
  if (decoded.memberId) {
    member = await prisma.member.findUnique({ where: { id: decoded.memberId } });
  } else {
    member = await prisma.member.findUnique({ where: { phone } });
  }

  const isRegister = decoded.purpose === 'REGISTER';
  const isLogin = decoded.purpose === 'LOGIN';

  if (!member) {
    return {
      phone,
      purpose: decoded.purpose,
      isNew: true,
      member: null,
      faceEnabled: false,
      facePreferenceSet: false,
      contracts: [],
      needContracts: false,
      allContractsSigned: false,
      missingNewMemberContract: false,
      nextStep: isRegister || !decoded.purpose ? 'REGISTER_PROFILE' : 'REGISTER_PROFILE',
    };
  }

  // 新舊會員只要進入 onboarding，皆須：人臉偏好 → 必簽契約 → 再綁定
  if (!isRegister && !isLogin) {
    // 非預期 purpose：仍依 gate 評估，避免略過簽署
  }

  const gate = await evaluateMemberOnboardingGate(member);

  return {
    phone,
    purpose: decoded.purpose,
    isNew: false,
    member: memberPublic(member),
    faceEnabled: gate.faceEnabled,
    facePreferenceSet: gate.facePreferenceReady,
    contracts: gate.contracts,
    needContracts: gate.needContracts,
    allContractsSigned: gate.allContractsSigned,
    missingNewMemberContract: gate.missingNewMemberContract,
    nextStep: gate.nextStep,
  };
}

// POST /api/onboarding/lookup { phone }
router.post('/lookup', async (req, res) => {
  try {
    const phone = assertTaiwanMobile(req.body?.phone);
    const member = await prisma.member.findUnique({
      where: { phone },
      select: { id: true, name: true, lineId: true, deviceId: true },
    });
    // 排除 LINE 佔位手機，視為新客
    const isPlaceholder = member && String(member.phone || '').startsWith('LINE_');
    const exists = Boolean(member) && !isPlaceholder;
    res.json({
      status: 'success',
      data: {
        exists,
        maskedName: exists ? maskName(member.name) : null,
        hasLineBound: exists ? Boolean(member.lineId) : false,
        hasDeviceBound: exists ? Boolean(member.deviceId) : false,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '查詢失敗',
    });
  }
});

// POST /api/onboarding/otp/send { phone }
router.post('/otp/send', otpSendLimiter, async (req, res) => {
  try {
    const phone = assertTaiwanMobile(req.body?.phone);
    const member = await prisma.member.findUnique({ where: { phone } });
    const isPlaceholder = member && String(member.phone || '').startsWith('LINE_');
    const exists = Boolean(member) && !isPlaceholder;
    const purpose = exists ? 'LOGIN' : 'REGISTER';
    const sent = await sendPhoneOtp(phone, purpose, {
      memberId: exists ? member.id : null,
    });
    res.json({
      status: 'success',
      message: sent.message,
      data: {
        exists,
        purpose,
        expiresInSec: sent.expiresInSec,
        ...(sent.devCode ? { devCode: sent.devCode } : {}),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '發送驗證碼失敗',
    });
  }
});

// POST /api/onboarding/otp/verify { phone, code }
router.post('/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const phone = assertTaiwanMobile(req.body?.phone);
    const member = await prisma.member.findUnique({ where: { phone } });
    const isPlaceholder = member && String(member.phone || '').startsWith('LINE_');
    const exists = Boolean(member) && !isPlaceholder;
    const purpose = exists ? 'LOGIN' : 'REGISTER';
    await verifyPhoneOtp(phone, req.body?.code, purpose);

    const token = issueOnboardingToken({
      phone,
      memberId: exists ? member.id : null,
      purpose,
    });
    const status = await buildOnboardingStatus({
      phone,
      memberId: exists ? member.id : null,
      purpose,
    });

    let memberToken = null;
    if (status.nextStep === 'DONE' && status.member) {
      const m = await prisma.member.findUnique({
        where: { id: status.member.id },
        select: { id: true, deviceId: true, deviceAuthVersion: true },
      });
      memberToken = issueMemberToken(status.member.id, memberTokenDeviceOpts(m));
    }

    res.json({
      status: 'success',
      message: '手機驗證成功',
      data: {
        onboardingToken: token,
        ...status,
        ...(memberToken ? { token: memberToken } : {}),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '驗證失敗',
    });
  }
});

// GET /api/onboarding/status
router.get('/status', requireOnboarding, async (req, res) => {
  try {
    const status = await buildOnboardingStatus(req.onboarding);
    res.json({ status: 'success', data: status });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '讀取狀態失敗',
    });
  }
});

// GET /api/onboarding/branches — 自助註冊可選分店（僅 HP／FD；回傳正式名稱）
router.get('/branches', requireOnboarding, async (req, res) => {
  try {
    const branches = await listSelfRegisterBranches();
    if (branches.length === 0) {
      return res.status(503).json({
        status: 'error',
        message: '目前無可選分店，請洽櫃檯協助開卡',
      });
    }
    res.json({ status: 'success', data: { branches } });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '讀取分店失敗',
    });
  }
});

// POST /api/onboarding/register
// Body: { name, emergencyContact, emergencyContactPhone, faceEnabled?, branchId }
router.post('/register', requireOnboarding, async (req, res) => {
  try {
    const { phone, purpose, memberId } = req.onboarding;
    if (purpose !== 'REGISTER' || memberId) {
      return res.status(400).json({
        status: 'error',
        message: '此步驟僅供新會員建立資料',
      });
    }

    const name = String(req.body?.name || '').trim();
    const emergencyContact = String(req.body?.emergencyContact || '').trim();
    const emergencyContactPhone = normalizePhone(req.body?.emergencyContactPhone || '');
    const faceEnabled = Boolean(req.body?.faceEnabled);
    const branch = await assertSelfRegisterBranchId(req.body?.branchId);

    if (!name || name.length < 2) {
      return res.status(400).json({ status: 'error', message: '請填寫真實姓名（至少 2 字）' });
    }
    if (!emergencyContact) {
      return res.status(400).json({ status: 'error', message: '請填寫緊急聯絡人' });
    }
    if (!/^09\d{8}$/.test(emergencyContactPhone)) {
      return res.status(400).json({
        status: 'error',
        message: '請填寫有效的緊急聯絡人手機（09 開頭 10 碼）',
      });
    }

    if (faceEnabled) {
      const bio = await findBiometricsConsentContract();
      if (!bio?.versions?.[0]) {
        return res.status(400).json({
          status: 'error',
          message:
            '尚未設定啟用中的「生物辨識同意書」，無法啟用人臉功能，請洽櫃檯或總部建立後再試',
        });
      }
    }

    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing && !String(existing.phone).startsWith('LINE_')) {
      return res.status(409).json({ status: 'error', message: '此手機已註冊，請改走舊會員登入' });
    }

    const memberNo = await allocateUniqueMemberNo();
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          memberNo,
          name,
          phone,
          emergencyContact,
          emergencyContactPhone,
          plan: '計時會員',
          role: 'MEMBER',
          faceEnabled,
          facePreferenceSet: true,
          allowBiometrics: false,
        },
      });
      await setMemberBranches(created.id, [branch.id], tx);
      return created;
    });

    const contracts = await loadOnboardingContracts({ includeBiometrics: faceEnabled });
    if (contracts.length) {
      await prisma.$transaction(async (tx) => {
        await ensurePendingSignatures(
          tx,
          member.id,
          contracts.map((c) => c.id),
          {},
        );
      });
    }

    const token = issueOnboardingToken({
      phone,
      memberId: member.id,
      purpose: 'REGISTER',
    });
    const status = await buildOnboardingStatus({
      phone,
      memberId: member.id,
      purpose: 'REGISTER',
    });

    res.status(201).json({
      status: 'success',
      message: '會員資料已建立，請簽署合約',
      data: { onboardingToken: token, ...status },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ status: 'error', message: '此手機已被使用' });
    }
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '註冊失敗',
    });
  }
});

// POST /api/onboarding/face-preference { faceEnabled: boolean }
// 舊會員（或尚未回答者）選擇是否啟用人臉；回答後才進入契約／綁定
router.post('/face-preference', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    if (!memberId) {
      return res.status(400).json({
        status: 'error',
        message: '請先完成基本資料或手機驗證',
      });
    }
    if (req.body?.faceEnabled === undefined) {
      return res.status(400).json({
        status: 'error',
        message: '請選擇是否使用生物辨識功能',
      });
    }
    const faceEnabled = Boolean(req.body.faceEnabled);

    if (faceEnabled) {
      const bio = await findBiometricsConsentContract();
      if (!bio?.versions?.[0]) {
        return res.status(400).json({
          status: 'error',
          message:
            '尚未設定啟用中的「生物辨識同意書」，無法啟用人臉功能，請洽櫃檯或總部建立後再試',
        });
      }
    }

    const member = await prisma.$transaction(async (tx) => {
      const updated = await tx.member.update({
        where: { id: memberId },
        data: {
          faceEnabled,
          facePreferenceSet: true,
        },
      });
      const contracts = await loadOnboardingContracts({
        includeBiometrics: faceEnabled,
      });
      if (contracts.length) {
        await ensurePendingSignatures(
          tx,
          memberId,
          contracts.map((c) => c.id),
          {},
        );
      }
      return updated;
    });

    const status = await buildOnboardingStatus({
      ...req.onboarding,
      memberId: member.id,
    });

    res.json({
      status: 'success',
      message: faceEnabled
        ? '已啟用人臉，請完成契約與生物辨識同意書簽署'
        : '已記錄暫不使用人臉，請完成會員契約簽署',
      data: status,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '儲存人臉偏好失敗',
    });
  }
});

// GET /api/onboarding/contracts
router.get('/contracts', requireOnboarding, async (req, res) => {
  try {
    if (!req.onboarding.memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料填寫' });
    }
    const status = await buildOnboardingStatus(req.onboarding);
    res.json({ status: 'success', data: { contracts: status.contracts } });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '讀取合約失敗',
    });
  }
});

// POST /api/onboarding/contracts/open { contractId }
router.post('/contracts/open', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    const purpose = req.onboarding.purpose;
    if (purpose !== 'REGISTER' && purpose !== 'LOGIN') {
      return res.status(400).json({ status: 'error', message: '目前階段無需簽署契約' });
    }
    if (!memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料填寫' });
    }
    const contractId = parseInt(req.body?.contractId, 10);
    if (!Number.isInteger(contractId)) {
      return res.status(400).json({ status: 'error', message: '無效的合約 ID' });
    }

    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        faceEnabled: true,
        facePreferenceSet: true,
        allowBiometrics: true,
        papagoFaceId: true,
      },
    });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到會員' });
    }
    if (!hasFacePreference(member)) {
      return res.status(400).json({
        status: 'error',
        message: '請先選擇是否使用生物辨識功能',
      });
    }

    const allowed = await loadOnboardingContracts({
      includeBiometrics: Boolean(member.faceEnabled),
    });
    if (!allowed.some((c) => c.id === contractId)) {
      return res.status(400).json({ status: 'error', message: '此合約不在入會簽署清單' });
    }

    const row = await prisma.$transaction(async (tx) => {
      await ensurePendingSignatures(tx, memberId, [contractId], {});
      const version = await tx.membershipContractVersion.findFirst({
        where: { contractId, status: 'ACTIVE' },
        orderBy: { version: 'desc' },
      });
      return tx.memberContractSignature.findUnique({
        where: {
          memberId_contractVersionId: {
            memberId,
            contractVersionId: version.id,
          },
        },
        include: {
          contract: {
            select: { id: true, title: true, shortName: true, status: true, versionBase: true },
          },
          contractVersion: {
            select: { id: true, version: true, body: true, changeNote: true, status: true },
          },
        },
      });
    });

    const history = await listMemberContractHistory(memberId, contractId);
    res.json({
      status: 'success',
      data: {
        signature: serializeSignature(row),
        history,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '開啟合約失敗',
    });
  }
});

// POST /api/onboarding/contracts/:signId/sign { signatureData }
router.post('/contracts/:signId/sign', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    const signId = parseInt(req.params.signId, 10);
    const signatureData = String(req.body?.signatureData || '').trim();
    const purpose = req.onboarding.purpose;
    if (purpose !== 'REGISTER' && purpose !== 'LOGIN') {
      return res.status(400).json({ status: 'error', message: '目前階段無需簽署契約' });
    }
    if (!memberId || !Number.isInteger(signId)) {
      return res.status(400).json({ status: 'error', message: '無效的參數' });
    }
    if (!signatureData.startsWith('data:image/') || !signatureData.includes('base64,')) {
      return res.status(400).json({ status: 'error', message: '簽名格式無效' });
    }
    if (signatureData.length > 1_500_000) {
      return res.status(400).json({ status: 'error', message: '簽名圖檔過大' });
    }

    const existing = await prisma.memberContractSignature.findFirst({
      where: { id: signId, memberId },
      include: {
        contract: { select: { id: true, purpose: true, status: true, title: true } },
        contractVersion: {
          select: { id: true, status: true, body: true, bodyHash: true, version: true },
        },
      },
    });
    if (!existing) {
      return res.status(404).json({ status: 'error', message: '找不到簽署紀錄' });
    }
    if (existing.contract.status !== 'ACTIVE' || existing.contractVersion.status !== 'ACTIVE') {
      return res.status(400).json({ status: 'error', message: '合約版本已作廢' });
    }
    const memberRow = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        faceEnabled: true,
        facePreferenceSet: true,
        allowBiometrics: true,
        papagoFaceId: true,
      },
    });
    if (!hasFacePreference(memberRow)) {
      return res.status(400).json({
        status: 'error',
        message: '請先選擇是否使用生物辨識功能',
      });
    }
    const allowed = await loadOnboardingContracts({
      includeBiometrics: Boolean(memberRow?.faceEnabled),
    });
    if (!allowed.some((c) => c.id === existing.contract.id)) {
      return res.status(400).json({ status: 'error', message: '此合約不在入會簽署清單' });
    }
    if (existing.status === 'SIGNED') {
      return res.status(400).json({ status: 'error', message: '此合約已簽署' });
    }

    const clientMeta = getRequestClientMeta(req);
    const versionBody = existing.contractVersion?.body || '';
    const bodyHash =
      existing.contractVersion?.bodyHash || hashContractBody(versionBody);

    const updated = await prisma.$transaction(async (tx) => {
      if (!existing.contractVersion?.bodyHash && existing.contractVersionId) {
        await tx.membershipContractVersion.update({
          where: { id: existing.contractVersionId },
          data: { bodyHash },
        });
      }

      const signed = await tx.memberContractSignature.update({
        where: { id: signId },
        data: {
          status: 'SIGNED',
          signatureData,
          bodyHash,
          ipAddress: clientMeta.ipAddress,
          userAgent: clientMeta.userAgent,
          actorType: 'MEMBER',
          signedAt: new Date(),
          staffId: null,
        },
        include: {
          contract: {
            select: { id: true, title: true, shortName: true, status: true, versionBase: true },
          },
          contractVersion: {
            select: {
              id: true,
              version: true,
              body: true,
              bodyHash: true,
              changeNote: true,
              status: true,
            },
          },
        },
      });

      await writeContractAudit(tx, {
        contractId: signed.contractId,
        memberId,
        signatureId: signed.id,
        versionId: signed.contractVersionId,
        action: 'SIGN',
        summary: `會員自助簽署電子合約：${signed.contract?.title || signed.contractId}`,
        detail: {
          bodyHash,
          signatureBytes: signatureData.length,
          version: signed.contractVersion?.version ?? null,
          channel: 'ONBOARDING',
        },
        actorStaffId: null,
        actorType: 'MEMBER',
        ...clientMeta,
      });

      return signed;
    });

    await syncMemberAllowBiometrics(memberId);
    const status = await buildOnboardingStatus(req.onboarding);

    res.json({
      status: 'success',
      message: '合約已簽署',
      data: {
        signature: serializeSignature(updated),
        ...status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '簽署失敗',
    });
  }
});

// POST /api/onboarding/bind-device { deviceId }
router.post('/bind-device', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    if (!memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料' });
    }
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({ status: 'error', message: '裝置識別碼無效' });
    }

    const statusBefore = await buildOnboardingStatus(req.onboarding);
    if (!statusBefore.allContractsSigned || statusBefore.nextStep === 'CHOOSE_FACE') {
      return res.status(400).json({
        status: 'error',
        message: statusBefore.missingNewMemberContract
          ? '尚未設定啟用中的「新會員」入會契約，請洽櫃檯／總部建立後再繼續'
          : '請先選擇是否使用生物辨識並完成會員契約簽署',
      });
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到會員' });
    }
    await assertMemberReadyToBind(member);
    if (!member.lineId) {
      return res.status(400).json({
        status: 'error',
        message: '請先綁定 LINE（綁定 LINE 時會一併綁定本機裝置）',
        data: { nextStep: 'BIND_LINE' },
      });
    }
    if (member.deviceId && member.deviceId !== deviceId) {
      return res.status(403).json({
        status: 'error',
        message: '此帳號已綁定其他裝置，請洽櫃檯解除後再綁定',
      });
    }

    const bindPatch = deviceBindUpdateIfChanged(member.deviceId, deviceId);
    const updated = bindPatch
      ? await prisma.member.update({
          where: { id: memberId },
          data: bindPatch,
        })
      : member;

    const status = await buildOnboardingStatus({
      ...req.onboarding,
      memberId: updated.id,
    });

    // LINE + 裝置皆完成 → 發會員 JWT（內嵌目前裝置碼，改綁後舊票失效）
    let memberToken = null;
    if (updated.lineId && updated.deviceId) {
      memberToken = issueMemberToken(updated.id, memberTokenDeviceOpts(updated));
    }

    res.json({
      status: 'success',
      message: bindPatch ? '裝置已綁定' : '裝置已綁定（本機）',
      data: {
        ...status,
        ...(memberToken ? { token: memberToken } : {}),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '綁定裝置失敗',
    });
  }
});

// GET /api/onboarding/line-login-url — 回傳帶 line_bind state 的 LINE 授權網址
router.get('/line-login-url', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    if (!memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料' });
    }
    const status = await buildOnboardingStatus(req.onboarding);
    if (!status.allContractsSigned || status.nextStep === 'CHOOSE_FACE') {
      return res.status(400).json({
        status: 'error',
        message: status.missingNewMemberContract
          ? '尚未設定啟用中的「新會員」入會契約，請洽櫃檯／總部建立後再繼續'
          : '請先選擇是否使用生物辨識並完成會員契約簽署',
      });
    }

    const channelId = process.env.LINE_CHANNEL_ID;
    const callback = process.env.LINE_CALLBACK_URL;
    if (!channelId || !callback) {
      return res.status(500).json({ status: 'error', message: 'LINE OAuth 未設定' });
    }

    const state = issueLineBindState({
      memberId,
      phone: req.onboarding.phone,
    });
    const url =
      `https://access.line.me/oauth2/v2.1/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(channelId)}` +
      `&redirect_uri=${encodeURIComponent(callback)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent('profile openid')}`;

    res.json({
      status: 'success',
      data: { url, state, exchangeEndpoint: '/api/auth/line/token' },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '無法產生 LINE 授權網址',
    });
  }
});

// POST /api/onboarding/complete — 若已綁 LINE+裝置，發會員 JWT
router.post('/complete', requireOnboarding, async (req, res) => {
  try {
    const status = await buildOnboardingStatus(req.onboarding);
    if (status.nextStep !== 'DONE' || !status.member) {
      return res.status(400).json({
        status: 'error',
        message: '尚未完成註冊／綁定流程',
        data: status,
      });
    }
    const row = await prisma.member.findUnique({
      where: { id: status.member.id },
      select: { id: true, deviceId: true, deviceAuthVersion: true },
    });
    const token = issueMemberToken(status.member.id, memberTokenDeviceOpts(row));
    res.json({
      status: 'success',
      message: '登入完成',
      data: { token, ...status },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '完成失敗',
    });
  }
});

export default router;
