// routes/onboarding.js — 會員自助：Email 查詢／OTP／註冊／合約簽署／裝置綁定
import express from 'express';
import prisma from '../lib/prisma.js';
import { assertMemberPhone } from '../lib/phoneOtp.js';
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
import { normalizeEmail, sendEmailOtp, verifyEmailOtp, maskEmail } from '../lib/emailOtp.js';
import {
  normalizeIdPhotoSide,
  uploadMemberIdPhoto,
  getIdPhotoMetaForMember,
} from '../lib/idPhoto.js';
import { assertRequiredIdNumber, normalizeIdNumber } from '../lib/deviceReset.js';
import { requestEmailEnroll, verifyEmailEnroll } from '../lib/emailEnroll.js';

const router = express.Router();
const otpSendLimiter = createRateLimiter({
  keyPrefix: 'onboarding-otp-send',
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyFn: (req) => {
    const id = String(req.body?.identity || req.body?.email || req.body?.phone || '')
      .trim()
      .toLowerCase();
    return `${req.ip || 'unknown'}:${id}`;
  },
  message: '驗證碼發送過於頻繁，請稍後再試',
});
const otpVerifyLimiter = createRateLimiter({
  keyPrefix: 'onboarding-otp-verify',
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFn: (req) => {
    const id = String(req.body?.identity || req.body?.email || req.body?.phone || '')
      .trim()
      .toLowerCase();
    return `${req.ip || 'unknown'}:${id}`;
  },
  message: '驗證嘗試過於頻繁，請稍後再試',
});
const emailEnrollSendLimiter = createRateLimiter({
  keyPrefix: 'onboarding-email-enroll-send',
  windowMs: 10 * 60 * 1000,
  max: 6,
  keyFn: (req) => {
    const phone = String(req.body?.phone || '').trim();
    return `${req.ip || 'unknown'}:${phone}`;
  },
  message: 'Email 補登發送過於頻繁，請稍後再試',
});
const emailEnrollVerifyLimiter = createRateLimiter({
  keyPrefix: 'onboarding-email-enroll-verify',
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyFn: (req) => {
    const phone = String(req.body?.phone || '').trim();
    return `${req.ip || 'unknown'}:${phone}`;
  },
  message: 'Email 補登驗證過於頻繁，請稍後再試',
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
      return res.status(401).json({ status: 'error', message: '請先完成 Email 驗證' });
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
    email: m.email || null,
    hasLineBound: Boolean(m.lineId),
    hasDeviceBound: Boolean(m.deviceId),
    faceEnabled: Boolean(m.faceEnabled),
    facePreferenceSet: Boolean(m.facePreferenceSet),
    plan: m.plan,
  };
}

/** 以已正規化 Email 查會員（多筆則拒） */
async function findMemberByEmail(email) {
  const rows = await prisma.member.findMany({
    where: { email },
    take: 2,
  });
  if (rows.length > 1) {
    const err = new Error('此 Email 對應多筆帳號，請洽櫃檯');
    err.statusCode = 409;
    throw err;
  }
  return rows[0] || null;
}

function isRealMember(member) {
  return Boolean(member) && !String(member.phone || '').startsWith('LINE_');
}

function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length < 7) return '****';
  return `${p.slice(0, 3)}****${p.slice(-3)}`;
}

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

/**
 * 手機＋證件號辨識新舊會員（入口主流程）
 * @returns {Promise<{
 *   kind: 'phone_id',
 *   phone: string,
 *   idNumber: string,
 *   email: string|null,
 *   member: object|null,
 *   exists: boolean,
 * }>}
 */
async function resolvePhoneIdLookup(body) {
  let phone;
  try {
    phone = assertMemberPhone(body?.phone);
  } catch {
    throw httpError('請輸入有效手機號碼（台灣 09 開頭，或含國碼國際門號）', 400);
  }
  const idNumber = normalizeIdNumber(body?.idNumber);
  if (!idNumber) {
    throw httpError('請輸入有效的身分證／居留證／護照／國籍證件號碼', 400);
  }

  const member = await prisma.member.findUnique({ where: { phone } });

  if (!isRealMember(member)) {
    const idTaken = await prisma.member.findUnique({ where: { idNumber } });
    if (idTaken && isRealMember(idTaken)) {
      throw httpError(
        '此證件號已有會員資料，請確認手機是否正確，或洽櫃檯',
        409,
        'ID_NUMBER_TAKEN',
      );
    }
    return {
      kind: 'phone_id',
      phone,
      idNumber,
      email: null,
      member: null,
      exists: false,
    };
  }

  const storedId = member.idNumber ? normalizeIdNumber(member.idNumber) : null;
  if (!storedId || storedId !== idNumber) {
    throw httpError('手機與證件資料不符，請確認後再試或洽櫃檯', 400, 'IDENTITY_MISMATCH');
  }

  let email = null;
  if (member.email) {
    try {
      email = normalizeEmail(member.email);
    } catch {
      email = null;
    }
  }

  return {
    kind: 'phone_id',
    phone,
    idNumber,
    email,
    member,
    exists: true,
  };
}

/**
 * 解析查詢鍵：Email 或台灣手機（body.identity｜email｜phone）
 * @returns {Promise<{ kind: 'email'|'phone', email: string|null, phone: string|null, member: object|null }>}
 */
async function resolveAccountLookup(body) {
  const raw = String(body?.identity || body?.email || body?.phone || '').trim();
  if (!raw) {
    throw httpError('請輸入手機號碼或 Email');
  }

  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    const member = await findMemberByEmail(email);
    return {
      kind: 'email',
      email,
      phone: member?.phone || null,
      member,
    };
  }

  const phone = assertMemberPhone(raw);
  const member = await prisma.member.findUnique({ where: { phone } });
  let email = null;
  if (member?.email) {
    try {
      email = normalizeEmail(member.email);
    } catch {
      email = null;
    }
  }
  return {
    kind: 'phone',
    email,
    phone,
    member,
  };
}

/**
 * 決定 OTP 寄送目標 Email（舊會員用檔案 Email；新客須直接輸入 Email）
 */
async function resolveOtpTarget(body) {
  const looked = await resolveAccountLookup(body);
  const exists = isRealMember(looked.member);

  if (exists) {
    if (!looked.email) {
      throw httpError(
        '此會員尚未登記 Email，請洽櫃檯補登後再登入，或改用 LINE 登入（若已綁定）',
        400,
        'EMAIL_MISSING',
      );
    }
    const gate = await evaluateMemberOnboardingGate(looked.member);
    const incomplete = gate.nextStep !== 'DONE';
    return {
      ...looked,
      exists: true,
      otpEmail: looked.email,
      /** 未完成註冊一律走 REGISTER，完成後才 LOGIN */
      purpose: incomplete ? 'REGISTER' : 'LOGIN',
      registrationComplete: !incomplete,
      nextStep: gate.nextStep,
    };
  }

  if (looked.kind !== 'email' || !looked.email) {
    throw httpError('查無此手機對應會員。新客請改以 Email 註冊', 404, 'MEMBER_NOT_FOUND');
  }

  return {
    ...looked,
    exists: false,
    otpEmail: looked.email,
    purpose: 'REGISTER',
    registrationComplete: false,
    nextStep: 'REGISTER_PROFILE',
  };
}

async function buildOnboardingStatus(decoded) {
  const email = decoded.email ? String(decoded.email).toLowerCase() : null;
  const phone = decoded.phone || null;
  let member = null;
  if (decoded.memberId) {
    member = await prisma.member.findUnique({ where: { id: decoded.memberId } });
  } else if (email) {
    member = await findMemberByEmail(email);
  } else if (phone) {
    member = await prisma.member.findUnique({ where: { phone } });
  }

  const isRegister = decoded.purpose === 'REGISTER';
  const isLogin = decoded.purpose === 'LOGIN';

  if (!member || !isRealMember(member)) {
    return {
      email,
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

  if (!isRegister && !isLogin) {
    // 非預期 purpose：仍依 gate 評估，避免略過簽署
  }

  const gate = await evaluateMemberOnboardingGate(member);

  return {
    email: member.email || email,
    phone: member.phone || phone,
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
    lineOptional: true,
    hasLineBound: gate.hasLineBound,
    idPhotosReady: gate.idPhotosReady,
  };
}

function nextStepLabel(nextStep) {
  switch (String(nextStep || '')) {
    case 'REGISTER_PROFILE':
      return '尚未完成基本資料';
    case 'CHOOSE_FACE':
      return '尚未選擇是否使用生物辨識';
    case 'SIGN_CONTRACTS':
      return '尚未完成契約簽署';
    case 'UPLOAD_ID_PHOTOS':
      return '尚未上傳證件正／反面';
    case 'BIND_LINE':
      return '尚未綁定 LINE（選用）';
    case 'BIND_DEVICE':
      return '尚未綁定本機裝置';
    case 'DONE':
      return '註冊流程已完成';
    default:
      return '註冊流程未完成';
  }
}

// POST /api/onboarding/lookup
// 主流程：{ phone, idNumber } 辨識新舊；相容舊客戶端 { identity｜email｜phone }
router.post('/lookup', async (req, res) => {
  try {
    const body = req.body || {};
    const usePhoneId = Boolean(String(body.phone || '').trim() && String(body.idNumber || '').trim());

    let looked;
    if (usePhoneId) {
      looked = await resolvePhoneIdLookup(body);
    } else {
      const legacy = await resolveAccountLookup(body);
      looked = {
        ...legacy,
        idNumber: null,
        exists: isRealMember(legacy.member),
      };
    }

    const exists = Boolean(looked.exists && isRealMember(looked.member));
    const hasEmail = Boolean(exists && looked.email);
    const hasIdNumber = Boolean(
      exists ? looked.member.idNumber : looked.idNumber || looked.kind === 'phone_id',
    );
    /** 無 Email、有手機、檔案已有證件 → 可自助補登 Email */
    const canEmailEnroll = Boolean(exists && !hasEmail && looked.member.phone && hasIdNumber);
    /** 新客（手機＋證件尚無帳號）→ 須先綁定並驗證 Email */
    const needsEmail = Boolean(!exists && usePhoneId);
    const canStartRegister = needsEmail;
    const canSendOtp = exists ? hasEmail : looked.kind === 'email' && Boolean(looked.email);

    let registrationComplete = false;
    let nextStep = null;
    let nextStepHint = null;
    let gateSnapshot = null;

    if (exists) {
      const gate = await evaluateMemberOnboardingGate(looked.member);
      registrationComplete = gate.nextStep === 'DONE';
      nextStep = gate.nextStep;
      nextStepHint = nextStepLabel(gate.nextStep);
      gateSnapshot = {
        facePreferenceReady: gate.facePreferenceReady,
        allContractsSigned: gate.allContractsSigned,
        idPhotosReady: gate.idPhotosReady,
        hasLineBound: Boolean(looked.member.lineId),
        hasDeviceBound: Boolean(looked.member.deviceId),
        missingNewMemberContract: gate.missingNewMemberContract,
      };
    }

    let hint = '';
    /** 前端分頁：未完成註冊一律導向 register；已完成導向 login；新客導向 register */
    let suggestedAuthMode = 'register';
    if (exists && hasEmail) {
      if (registrationComplete) {
        suggestedAuthMode = 'login';
        hint = `歡迎回來，${maskName(looked.member.name)}。驗證碼將寄至 ${maskEmail(looked.email)}`;
      } else {
        suggestedAuthMode = 'register';
        hint = `歡迎回來，${maskName(looked.member.name)}。註冊尚未完成（${nextStepHint}），請先驗證 Email 後繼續填寫會員資料。驗證碼將寄至 ${maskEmail(looked.email)}`;
      }
    } else if (exists && !hasEmail) {
      suggestedAuthMode = registrationComplete ? 'login' : 'register';
      if (canEmailEnroll) {
        hint = registrationComplete
          ? `歡迎回來，${maskName(looked.member.name)}。尚未綁定 Email，請先補登並驗證 Email`
          : `歡迎回來，${maskName(looked.member.name)}。註冊尚未完成（${nextStepHint}），且尚未綁定 Email。請先補登並驗證 Email，再完成會員資料`;
      } else {
        hint = registrationComplete
          ? '此帳號尚未登記 Email，且無法自助核身。請洽櫃檯補登，或改用已綁定的 LINE 登入'
          : `此帳號註冊尚未完成（${nextStepHint}），且尚未登記 Email。請洽櫃檯補登後再繼續，或改用已綁定的 LINE 登入`;
      }
    } else if (needsEmail) {
      suggestedAuthMode = 'register';
      hint = '查無此會員。請先綁定並驗證 Email，再完成註冊資料（LINE 為選用，可於之後綁定）';
    } else if (looked.kind === 'phone') {
      suggestedAuthMode = 'register';
      hint = '查無此手機對應會員。請改以手機＋證件號開始註冊，或輸入 Email';
    } else {
      suggestedAuthMode = 'register';
      hint = '尚未註冊，下一步將寄送註冊驗證碼至此 Email';
    }

    res.json({
      status: 'success',
      data: {
        exists,
        lookupKind: looked.kind,
        maskedName: exists ? maskName(looked.member.name) : null,
        maskedEmail: hasEmail
          ? maskEmail(looked.email)
          : looked.kind === 'email'
            ? maskEmail(looked.email)
            : null,
        maskedPhone:
          exists && looked.member.phone
            ? maskPhone(looked.member.phone)
            : looked.phone
              ? maskPhone(looked.phone)
              : null,
        phone: looked.phone || null,
        hasEmail,
        hasIdNumber,
        canEmailEnroll,
        canSendOtp,
        canStartRegister,
        needsEmail,
        hasLineBound: exists ? Boolean(looked.member.lineId) : false,
        hasDeviceBound: exists ? Boolean(looked.member.deviceId) : false,
        registrationComplete,
        nextStep,
        nextStepHint,
        registration: gateSnapshot,
        suggestedAuthMode,
        hint,
        otpEmail: canSendOtp ? looked.email : null,
        enrollPhone: canEmailEnroll
          ? looked.member.phone
          : needsEmail
            ? looked.phone
            : null,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || undefined,
      message: error.message || '查詢失敗',
    });
  }
});

// POST /api/onboarding/email-enroll/request { phone, idNumber, email }
// 舊會員無 Email：手機＋檔案證件相符後，寄補登驗證碼至新 Email（尚未寫入 DB）
router.post('/email-enroll/request', emailEnrollSendLimiter, async (req, res) => {
  try {
    const data = await requestEmailEnroll(req.body || {});
    res.json({
      status: 'success',
      message: data.message,
      data: {
        maskedEmail: data.maskedEmail,
        otpEmail: data.otpEmail,
        expiresInSec: data.expiresInSec,
        ...(data.devCode ? { devCode: data.devCode } : {}),
        ...(data.mock ? { mock: true } : {}),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || undefined,
      message: error.message || '無法寄送 Email 補登驗證碼',
    });
  }
});

// POST /api/onboarding/email-enroll/verify { phone, idNumber, email, code }
// 驗證通過後寫入 Member.email，發 onboarding JWT，並回傳註冊完成度／未完步驟
router.post('/email-enroll/verify', emailEnrollVerifyLimiter, async (req, res) => {
  try {
    const data = await verifyEmailEnroll(req.body || {}, buildOnboardingStatus);
    res.json({
      status: 'success',
      message: data.message,
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || undefined,
      message: error.message || 'Email 補登驗證失敗',
    });
  }
});

// POST /api/onboarding/otp/send { identity｜email｜phone }
router.post('/otp/send', otpSendLimiter, async (req, res) => {
  try {
    const target = await resolveOtpTarget(req.body || {});
    const sent = await sendEmailOtp(target.otpEmail, target.purpose, {
      memberId: target.exists ? target.member.id : null,
    });
    res.json({
      status: 'success',
      message: sent.message,
      data: {
        exists: target.exists,
        purpose: target.purpose,
        registrationComplete: target.registrationComplete ?? null,
        nextStep: target.nextStep || null,
        lookupKind: target.kind,
        maskedEmail: sent.maskedEmail,
        otpEmail: target.otpEmail,
        expiresInSec: sent.expiresInSec,
        ...(sent.devCode ? { devCode: sent.devCode } : {}),
        ...(sent.mock ? { mock: true } : {}),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || undefined,
      message: error.message || '發送驗證碼失敗',
    });
  }
});

// POST /api/onboarding/otp/verify { identity｜email｜phone, code }
router.post('/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const target = await resolveOtpTarget(req.body || {});
    await verifyEmailOtp(target.otpEmail, req.body?.code, target.purpose);

    const token = issueOnboardingToken({
      email: target.otpEmail,
      phone: target.exists ? target.member.phone : target.phone,
      memberId: target.exists ? target.member.id : null,
      purpose: target.purpose,
    });
    const status = await buildOnboardingStatus({
      email: target.otpEmail,
      phone: target.exists ? target.member.phone : target.phone,
      memberId: target.exists ? target.member.id : null,
      purpose: target.purpose,
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
      message: 'Email 驗證成功',
      data: {
        onboardingToken: token,
        ...status,
        ...(memberToken ? { token: memberToken } : {}),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      code: error.code || undefined,
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
// Body: { name, phone, emergencyContact, emergencyContactPhone, faceEnabled?, branchId, idNumber }
// email 取自 onboarding JWT（Email OTP 已驗證），禁止前端另傳改寫
// phone、idNumber 必填；外國客 idNumber 可填居留證或護照
router.post('/register', requireOnboarding, async (req, res) => {
  try {
    const { email: tokenEmail, purpose, memberId } = req.onboarding;
    if (purpose !== 'REGISTER' || memberId) {
      return res.status(400).json({
        status: 'error',
        message: '此步驟僅供新會員建立資料',
      });
    }

    const email = normalizeEmail(tokenEmail);
    const name = String(req.body?.name || '').trim();
    let phone;
    try {
      phone = assertMemberPhone(req.body?.phone);
    } catch (e) {
      return res.status(400).json({
        status: 'error',
        message: e.message || '請填寫有效的手機號碼',
      });
    }
    const emergencyContact = String(req.body?.emergencyContact || '').trim();
    let emergencyContactPhone;
    try {
      emergencyContactPhone = assertMemberPhone(req.body?.emergencyContactPhone);
    } catch (e) {
      return res.status(400).json({
        status: 'error',
        message: e.message || '請填寫有效的緊急聯絡人手機',
      });
    }
    const faceEnabled = Boolean(req.body?.faceEnabled);
    const branch = await assertSelfRegisterBranchId(req.body?.branchId);

    let idNumber;
    try {
      idNumber = assertRequiredIdNumber(req.body?.idNumber);
    } catch (e) {
      return res.status(400).json({
        status: 'error',
        message: e.message || '請填寫有效證件號（身分證／居留證／護照）',
      });
    }

    if (!name || name.length < 2) {
      return res.status(400).json({ status: 'error', message: '請填寫真實姓名（至少 2 字）' });
    }
    if (!emergencyContact) {
      return res.status(400).json({ status: 'error', message: '請填寫緊急聯絡人' });
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

    const emailTaken = await findMemberByEmail(email);
    if (isRealMember(emailTaken)) {
      return res.status(409).json({ status: 'error', message: '此 Email 已註冊，請改走登入' });
    }

    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing && !String(existing.phone).startsWith('LINE_')) {
      return res.status(409).json({ status: 'error', message: '此手機已註冊，請洽櫃檯或改走登入' });
    }

    const idTaken = await prisma.member.findUnique({ where: { idNumber } });
    if (idTaken) {
      return res.status(409).json({ status: 'error', message: '此證件號已註冊，請洽櫃檯' });
    }

    const memberNo = await allocateUniqueMemberNo();
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.member.create({
        data: {
          memberNo,
          name,
          phone,
          email,
          idNumber,
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
      email,
      phone,
      memberId: member.id,
      purpose: 'REGISTER',
    });
    const status = await buildOnboardingStatus({
      email,
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
      return res.status(409).json({ status: 'error', message: '此手機或 Email 已被使用' });
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
        message: '請先完成基本資料或 Email 驗證',
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
      const contracts = await loadOnboardingContracts(
        { includeBiometrics: faceEnabled },
        tx,
      );
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

// POST /api/onboarding/id-photo — 註冊必傳證件正／反面（onboarding JWT）
// Body: { image|dataUrl, side?: front|back, consent: true }
router.post('/id-photo', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    if (!memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料' });
    }
    if (req.body?.consent !== true && req.body?.consent !== 'true') {
      return res.status(400).json({
        status: 'error',
        message: '請確認已閱讀證件蒐集告知並同意後再上傳',
      });
    }

    const statusBefore = await buildOnboardingStatus(req.onboarding);
    if (!statusBefore.allContractsSigned || statusBefore.nextStep === 'CHOOSE_FACE') {
      return res.status(400).json({
        status: 'error',
        message: '請先完成人臉偏好與會員契約簽署後再上傳證件',
      });
    }

    const side = normalizeIdPhotoSide(req.body?.side || 'front');
    const saved = await uploadMemberIdPhoto(
      memberId,
      req.body?.image || req.body?.dataUrl,
      side,
      req,
    );
    const status = await buildOnboardingStatus(req.onboarding);
    res.json({
      status: 'success',
      message: side === 'back' ? '證件反面已上傳' : '證件正面已上傳',
      data: {
        ...status,
        side,
        bytes: saved.bytes,
        photoId: saved.photoId,
        retentionUntil: saved.retentionUntil,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '上傳證件失敗',
    });
  }
});

// GET /api/onboarding/id-photo/meta
router.get('/id-photo/meta', requireOnboarding, async (req, res) => {
  try {
    const memberId = req.onboarding.memberId;
    if (!memberId) {
      return res.status(400).json({ status: 'error', message: '請先完成基本資料' });
    }
    const meta = await getIdPhotoMetaForMember(memberId);
    const status = await buildOnboardingStatus(req.onboarding);
    res.json({
      status: 'success',
      data: { ...meta, idPhotosReady: status.idPhotosReady, nextStep: status.nextStep },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '讀取證件狀態失敗',
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
    if (
      !statusBefore.allContractsSigned ||
      statusBefore.nextStep === 'CHOOSE_FACE' ||
      statusBefore.nextStep === 'UPLOAD_ID_PHOTOS'
    ) {
      return res.status(400).json({
        status: 'error',
        message: statusBefore.missingNewMemberContract
          ? '尚未設定啟用中的「新會員」入會契約，請洽櫃檯／總部建立後再繼續'
          : statusBefore.nextStep === 'UPLOAD_ID_PHOTOS'
            ? '請先上傳證件正／反面後再綁定裝置'
            : '請先選擇是否使用生物辨識並完成會員契約簽署',
      });
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到會員' });
    }
    await assertMemberReadyToBind(member);
    if (member.deviceId && member.deviceId !== deviceId) {
      return res.status(403).json({
        status: 'error',
        message: '此帳號已綁定其他裝置，請洽櫃檯解除後再綁定',
      });
    }

    const bindPatch = deviceBindUpdateIfChanged(member.deviceId, deviceId, memberId);
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

    // 契約完成＋本機裝置 → 發會員 JWT（LINE 選用，外國客可略過）
    let memberToken = null;
    if (updated.deviceId) {
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
    if (
      !status.allContractsSigned ||
      status.nextStep === 'CHOOSE_FACE' ||
      status.nextStep === 'UPLOAD_ID_PHOTOS'
    ) {
      return res.status(400).json({
        status: 'error',
        message: status.missingNewMemberContract
          ? '尚未設定啟用中的「新會員」入會契約，請洽櫃檯／總部建立後再繼續'
          : status.nextStep === 'UPLOAD_ID_PHOTOS'
            ? '請先上傳證件正／反面後再綁定 LINE'
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
      email: req.onboarding.email,
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
