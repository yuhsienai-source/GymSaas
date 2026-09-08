// lib/memberIdentify.js — 臨櫃會員辨識（ops／pt 共用）
import prisma from './prisma.js';
import { verifyGateQrToken } from './qrToken.js';
import { identifyFace, getSimilarityThreshold } from './papago.js';
import { memberHasSignedBiometricsConsent } from './memberContract.js';
import { parseMemberIdentityQrPayload } from './memberIdentityQr.js';
import { isValidMemberNo } from './memberNo.js';

export function normalizePhone(phone) {
  return String(phone || '')
    .replace(/[\s\-()]/g, '')
    .replace(/^\+/, '')
    .trim();
}

export function toCounterMemberView(member) {
  const branches = Array.isArray(member.branches)
    ? member.branches.map((b) => {
        if (b?.branch) {
          return {
            branchId: b.branchId ?? b.branch.id,
            branch: {
              id: b.branch.id,
              name: b.branch.name,
              code: b.branch.code || null,
            },
          };
        }
        if (b?.branchId && b?.id) {
          return {
            branchId: b.branchId,
            branch: { id: b.id, name: b.name, code: b.code || null },
          };
        }
        return b;
      })
    : [];
  return {
    id: member.id,
    memberNo: member.memberNo || null,
    name: member.name,
    phone: member.phone,
    email: member.email || null,
    idNumber: member.idNumber || null,
    emergencyContact: member.emergencyContact || null,
    emergencyContactPhone: member.emergencyContactPhone || null,
    plan: member.plan,
    planName: member.planName || member.plan,
    expireDate: member.expireDate,
    cashWallet: member.cashWallet,
    bonusWallet: member.bonusWallet,
    allowBiometrics: member.allowBiometrics,
    faceEnabled: Boolean(member.faceEnabled),
    isAlert: member.isAlert,
    lineId: member.lineId || null,
    deviceId: member.deviceId || null,
    hasFaceBound: Boolean(member.papagoFaceId),
    hasDeviceBound: Boolean(member.deviceId),
    hasLineBound: Boolean(member.lineId),
    branches,
    branchIds: branches.map((b) => b.branchId).filter(Boolean),
  };
}

export async function lookupMemberByPhone(rawPhone) {
  if (!rawPhone) {
    const err = new Error('請提供手機號碼 phone');
    err.statusCode = 400;
    throw err;
  }

  const phone = normalizePhone(rawPhone);
  if (phone.length < 4) {
    const err = new Error('手機號碼過短，請至少輸入 4 碼');
    err.statusCode = 400;
    throw err;
  }

  const exact = await prisma.member.findUnique({ where: { phone } });
  if (exact) {
    return {
      status: 'success',
      message: '找到會員（精確符合）',
      data: { method: 'PHONE', match: 'exact', member: toCounterMemberView(exact), candidates: [] },
    };
  }

  const candidates = await prisma.member.findMany({
    where: { phone: { contains: phone } },
    take: 10,
    orderBy: { id: 'asc' },
  });

  if (candidates.length === 0) {
    const err = new Error(`查無手機含「${phone}」的會員`);
    err.statusCode = 404;
    throw err;
  }

  if (candidates.length === 1) {
    return {
      status: 'success',
      message: '找到會員',
      data: {
        method: 'PHONE',
        match: 'partial',
        member: toCounterMemberView(candidates[0]),
        candidates: [],
      },
    };
  }

  return {
    status: 'success',
    message: `找到 ${candidates.length} 筆相近門號，請選擇正確會員`,
    data: {
      method: 'PHONE',
      match: 'multiple',
      member: null,
      candidates: candidates.map(toCounterMemberView),
    },
  };
}

export async function identifyMember({ method, phone, qrToken, faceImage }) {
  const mode = String(method || '').toUpperCase();

  if (!['PHONE', 'QR', 'FACE'].includes(mode)) {
    const err = new Error('method 必須為 PHONE、QR 或 FACE');
    err.statusCode = 400;
    throw err;
  }

  let member = null;
  let meta = {};

  if (mode === 'PHONE') {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      const err = new Error('請提供 phone');
      err.statusCode = 400;
      throw err;
    }

    member = await prisma.member.findUnique({ where: { phone: normalized } });
    if (!member) {
      const candidates = await prisma.member.findMany({
        where: { phone: { contains: normalized } },
        take: 10,
      });
      if (candidates.length === 0) {
        const err = new Error('查無此手機號碼會員');
        err.statusCode = 404;
        throw err;
      }
      if (candidates.length > 1) {
        return {
          status: 'success',
          message: `找到 ${candidates.length} 筆相近門號，請選擇`,
          data: {
            method: 'PHONE',
            match: 'multiple',
            member: null,
            candidates: candidates.map(toCounterMemberView),
          },
        };
      }
      member = candidates[0];
      meta.match = 'partial';
    } else {
      meta.match = 'exact';
    }
  }

  if (mode === 'QR') {
    if (!qrToken) {
      const err = new Error('請掃描或貼上會員查詢碼／門禁 QR');
      err.statusCode = 400;
      throw err;
    }

    // 1) 靜態查詢碼（GYMSAAS:MEMBER:XXXXXX 或純 6 碼會員編號）
    const identityNo = parseMemberIdentityQrPayload(qrToken);
    if (identityNo) {
      member = await prisma.member.findUnique({ where: { memberNo: identityNo } });
      if (!member) {
        const err = new Error('查詢碼對應的會員不存在');
        err.statusCode = 404;
        throw err;
      }
      meta = { match: 'member_no', memberNo: identityNo };
    } else {
      // 2) 門禁動態 QR（HMAC）
      let decoded;
      try {
        decoded = verifyGateQrToken(qrToken);
      } catch (verifyError) {
        // 若看起來像會員編號但無效，給更明確訊息
        const maybeNo = String(qrToken).trim().toUpperCase();
        if (isValidMemberNo(maybeNo) || maybeNo.startsWith('GYMSAAS:MEMBER:')) {
          const err = new Error('查詢碼格式無效');
          err.statusCode = 400;
          throw err;
        }
        const err = new Error(verifyError.message);
        err.statusCode = verifyError.code === 'QR_MISSING' ? 400 : 403;
        throw err;
      }

      member = await prisma.member.findUnique({ where: { id: decoded.memberId } });
      if (!member) {
        const err = new Error('QR 對應的會員不存在');
        err.statusCode = 404;
        throw err;
      }
      meta = { match: 'qr', deviceId: decoded.deviceId || null };
    }
  }

  if (mode === 'FACE') {
    if (!faceImage) {
      const err = new Error('請提供 faceImage（人臉影像 base64）');
      err.statusCode = 400;
      throw err;
    }

    const identification = await identifyFace({ imageBase64: faceImage });

    if (!identification.livenessPassed) {
      const err = new Error('⛔ 活體檢測失敗：請以真實人臉面對鏡頭');
      err.statusCode = 403;
      throw err;
    }

    if (!identification.faceId) {
      const err = new Error(
        `人臉無法匹配已註冊會員（信心度 ${(identification.confidence * 100).toFixed(1)}%，門檻 ${(getSimilarityThreshold() * 100).toFixed(0)}%）`,
      );
      err.statusCode = 404;
      throw err;
    }

    member = await prisma.member.findUnique({
      where: { papagoFaceId: identification.faceId },
    });

    if (!member) {
      const err = new Error('辨識到人臉但未綁定會員，請先臨櫃註冊人臉');
      err.statusCode = 404;
      throw err;
    }

    if (!(await memberHasSignedBiometricsConsent(member.id))) {
      const err = new Error('⚖️ 此會員未簽署生物辨識同意書，依法不得以人臉查詢');
      err.statusCode = 403;
      throw err;
    }

    meta = {
      match: 'face',
      confidence: identification.confidence,
      faceId: identification.faceId,
    };
  }

  return {
    status: 'success',
    message: `臨櫃辨認成功：${member.name}`,
    data: {
      method: mode,
      ...meta,
      member: toCounterMemberView(member),
      candidates: [],
    },
  };
}
