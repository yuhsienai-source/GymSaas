// routes/contracts.js — 總部電子合約範本（CRUD／不可變升版／稽核軌跡）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import {
  CONTRACT_PURPOSE,
  assertUniqueBiometricsConsent,
  assertUniqueNewMemberContract,
  enqueueResignForNewVersion,
  syncMemberAllowBiometrics,
} from '../lib/memberContract.js';
import {
  DEFAULT_VERSION_BASE,
  buildVersionLabel,
  normalizeVersionBase,
} from '../lib/contractVersionLabel.js';
import {
  getRequestClientMeta,
  hashContractBody,
  writeContractAudit,
} from '../lib/contractAudit.js';
import { GYM_CONTRACT_PRESETS } from '../lib/gymContractPresets.js';

const router = express.Router();
router.use(verifyStaff, requireAdmin);

const CHANGE_NOTE_MAX = 200;

function parsePurpose(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const p = String(raw).trim().toUpperCase();
  if (
    p !== CONTRACT_PURPOSE.GENERAL &&
    p !== CONTRACT_PURPOSE.BIOMETRICS_CONSENT &&
    p !== CONTRACT_PURPOSE.NEW_MEMBER
  ) {
    const err = new Error('purpose 僅允許 GENERAL、NEW_MEMBER 或 BIOMETRICS_CONSENT');
    err.statusCode = 400;
    throw err;
  }
  return p;
}

function requireChangeReason(raw) {
  const note = String(raw ?? '').trim();
  if (!note) {
    const err = new Error('合約異動須填寫原因');
    err.statusCode = 400;
    throw err;
  }
  if (note.length > CHANGE_NOTE_MAX) {
    const err = new Error(`異動原因請勿超過 ${CHANGE_NOTE_MAX} 字`);
    err.statusCode = 400;
    throw err;
  }
  return note;
}

function serializeVersion(v, versionBase) {
  const base = versionBase || DEFAULT_VERSION_BASE;
  return {
    id: v.id,
    version: v.version,
    versionLabel: buildVersionLabel(base, v.version),
    body: v.body,
    bodyHash: v.bodyHash || null,
    changeNote: v.changeNote,
    status: v.status || 'ACTIVE',
    createdByStaffId: v.createdByStaffId,
    createdAt: v.createdAt,
  };
}

function serializeChangeLog(row, versionBase) {
  const base = versionBase || DEFAULT_VERSION_BASE;
  const ver = row.version;
  return {
    id: row.id,
    action: row.action,
    changeNote: row.changeNote,
    summary: row.summary || null,
    versionId: row.versionId ?? null,
    version: ver?.version ?? null,
    versionLabel:
      ver?.version != null ? buildVersionLabel(base, ver.version) : null,
    createdByStaffId: row.createdByStaffId,
    createdAt: row.createdAt,
  };
}

function serializeAudit(row) {
  return {
    id: row.id,
    contractId: row.contractId,
    memberId: row.memberId,
    signatureId: row.signatureId,
    versionId: row.versionId,
    action: row.action,
    summary: row.summary,
    changeNote: row.changeNote,
    detail: row.detail,
    actorStaffId: row.actorStaffId,
    actorType: row.actorType,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  };
}

function serializeContract(row) {
  const versions = [...(row.versions || [])].sort((a, b) => b.version - a.version);
  const current =
    versions.find((v) => (v.status || 'ACTIVE') === 'ACTIVE') || null;
  const versionBase = row.versionBase || DEFAULT_VERSION_BASE;
  const changeLogs = [...(row.changeLogs || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
  return {
    id: row.id,
    title: row.title,
    shortName: row.shortName || null,
    displayName: row.shortName || row.title,
    purpose: row.purpose || 'GENERAL',
    versionBase,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    currentVersion: current ? serializeVersion(current, versionBase) : null,
    versionCount: versions.length,
    versions: versions.map((v) => serializeVersion(v, versionBase)),
    changeLogs: changeLogs.map((l) => serializeChangeLog(l, versionBase)),
  };
}

const versionInclude = {
  versions: { orderBy: { version: 'desc' } },
  changeLogs: {
    orderBy: { createdAt: 'desc' },
    include: {
      version: { select: { id: true, version: true, status: true } },
    },
  },
};

async function writeChangeLog(tx, {
  contractId,
  versionId,
  action,
  changeNote,
  summary,
  staffId,
}) {
  return tx.membershipContractChangeLog.create({
    data: {
      contractId,
      versionId: versionId ?? null,
      action,
      changeNote,
      summary: summary || null,
      createdByStaffId: staffId ?? null,
    },
  });
}

/** 條文異動：前版 VOIDED → 新版 ACTIVE + bodyHash；禁止覆寫已發布條文 */
async function bumpContractBody(tx, {
  contractId,
  versionBase,
  text,
  changeReason,
  staffId,
}) {
  await tx.membershipContractVersion.updateMany({
    where: { contractId, status: 'ACTIVE' },
    data: { status: 'VOIDED' },
  });
  const maxVer = await tx.membershipContractVersion.findFirst({
    where: { contractId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const versionNum = (maxVer?.version || 0) + 1;
  const created = await tx.membershipContractVersion.create({
    data: {
      contractId,
      version: versionNum,
      body: text,
      bodyHash: hashContractBody(text),
      changeNote: changeReason,
      status: 'ACTIVE',
      createdByStaffId: staffId ?? null,
    },
  });
  const resignMemberIds = await enqueueResignForNewVersion(tx, {
    contractId,
    newVersionId: created.id,
    staffId: staffId ?? null,
  });
  return {
    created,
    versionNum,
    versionLabel: buildVersionLabel(versionBase || DEFAULT_VERSION_BASE, versionNum),
    resignMemberIds,
  };
}

// GET /api/hq/contracts/presets — 健身房專業範本
router.get('/presets', async (_req, res) => {
  res.json({
    status: 'success',
    data: GYM_CONTRACT_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      purpose: p.purpose,
      shortName: p.shortName,
      title: p.title,
      versionBase: p.versionBase,
      body: p.body,
    })),
  });
});

// GET /api/hq/contracts?status=ACTIVE|VOIDED|ALL
router.get('/', async (req, res) => {
  try {
    const statusRaw = String(req.query.status || 'ALL').trim().toUpperCase();
    const where =
      statusRaw === 'ALL' || statusRaw === '*'
        ? {}
        : { status: statusRaw === 'VOIDED' ? 'VOIDED' : 'ACTIVE' };

    const rows = await prisma.membershipContract.findMany({
      where,
      include: versionInclude,
      orderBy: { id: 'desc' },
    });

    res.json({
      status: 'success',
      data: rows.map(serializeContract),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取電子合約列表失敗' });
  }
});

// GET /api/hq/contracts/:id/audit
router.get('/:id/audit', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ status: 'error', message: '無效的合約 ID' });
    }
    const exists = await prisma.membershipContract.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      return res.status(404).json({ status: 'error', message: '找不到此電子合約' });
    }
    const take = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const rows = await prisma.contractAuditLog.findMany({
      where: { contractId: id },
      orderBy: { createdAt: 'desc' },
      take,
    });
    res.json({ status: 'success', data: rows.map(serializeAudit) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取稽核軌跡失敗' });
  }
});

// GET /api/hq/contracts/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ status: 'error', message: '無效的合約 ID' });
    }
    const row = await prisma.membershipContract.findUnique({
      where: { id },
      include: versionInclude,
    });
    if (!row) {
      return res.status(404).json({ status: 'error', message: '找不到此電子合約' });
    }
    res.json({ status: 'success', data: serializeContract(row) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取電子合約失敗' });
  }
});

// POST /api/hq/contracts  { title, shortName?, body, changeNote?/versionBase?, purpose?, presetKey? }
router.post('/', async (req, res) => {
  const clientMeta = getRequestClientMeta(req);
  const title = String(req.body?.title || '').trim();
  const shortNameRaw = String(req.body?.shortName || '').trim();
  const shortName = shortNameRaw || null;
  const body = String(req.body?.body || '').trim();
  const versionBase = normalizeVersionBase(
    req.body?.versionBase ?? req.body?.changeNote,
  );
  if (versionBase.length > 40) {
    return res.status(400).json({ status: 'error', message: '版本備註請勿超過 40 字' });
  }
  let purpose;
  try {
    purpose = parsePurpose(req.body?.purpose) || CONTRACT_PURPOSE.GENERAL;
  } catch (error) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }

  if (!title) {
    return res.status(400).json({ status: 'error', message: '合約標題必填' });
  }
  if (shortName && shortName.length > 20) {
    return res.status(400).json({ status: 'error', message: '簡稱請勿超過 20 字' });
  }
  if (!body) {
    return res.status(400).json({ status: 'error', message: '合約內容必填' });
  }

  const presetKey = req.body?.presetKey ? String(req.body.presetKey).trim() : null;

  try {
    const row = await prisma.$transaction(async (tx) => {
      if (purpose === CONTRACT_PURPOSE.BIOMETRICS_CONSENT) {
        await assertUniqueBiometricsConsent(tx);
      }
      if (purpose === CONTRACT_PURPOSE.NEW_MEMBER) {
        await assertUniqueNewMemberContract(tx);
      }
      const contract = await tx.membershipContract.create({
        data: { title, shortName, purpose, versionBase, status: 'ACTIVE' },
      });
      const label = buildVersionLabel(versionBase, 1);
      const bodyHash = hashContractBody(body);
      const version = await tx.membershipContractVersion.create({
        data: {
          contractId: contract.id,
          version: 1,
          body,
          bodyHash,
          changeNote: label,
          status: 'ACTIVE',
          createdByStaffId: req.user?.id ?? null,
        },
      });
      await writeChangeLog(tx, {
        contractId: contract.id,
        versionId: version.id,
        action: 'CREATE',
        changeNote: `初版建立（${label}）`,
        summary: '建立電子合約與初版內容',
        staffId: req.user?.id ?? null,
      });
      await writeContractAudit(tx, {
        contractId: contract.id,
        versionId: version.id,
        action: 'CREATE',
        summary: `建立電子合約「${shortName || title}」${label}`,
        changeNote: `初版建立（${label}）`,
        detail: {
          title,
          shortName,
          purpose,
          versionBase,
          bodyHash,
          presetKey,
          bodyLength: body.length,
        },
        actorStaffId: req.user?.id ?? null,
        actorType: 'ADMIN',
        ...clientMeta,
      });
      return tx.membershipContract.findUnique({
        where: { id: contract.id },
        include: versionInclude,
      });
    });

    res.status(201).json({
      status: 'success',
      message: `電子合約 [${shortName || title}] 已建立（${buildVersionLabel(versionBase, 1)}）`,
      data: serializeContract(row),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '建立電子合約失敗' });
  }
});

// PATCH /api/hq/contracts/:id
// 任何異動皆須 changeNote；條文異動一律升版（不可覆寫已發布版本）
router.patch('/:id', async (req, res) => {
  const clientMeta = getRequestClientMeta(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ status: 'error', message: '無效的合約 ID' });
  }

  if (req.body?.versionBase !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '版本備註於建立後不可更改',
    });
  }

  const { title, shortName, body, status } = req.body || {};
  const bumpVersion = Boolean(req.body?.bumpVersion);
  let purpose;
  try {
    purpose = parsePurpose(req.body?.purpose);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }

  try {
    const current = await prisma.membershipContract.findUnique({
      where: { id },
      include: {
        versions: {
          where: { status: 'ACTIVE' },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });
    if (!current) {
      return res.status(404).json({ status: 'error', message: '找不到此電子合約' });
    }

    const metaChanging =
      title !== undefined ||
      shortName !== undefined ||
      purpose !== null ||
      status !== undefined;
    const bodyProvided = body !== undefined;
    if (!metaChanging && !bodyProvided && !bumpVersion) {
      return res.status(400).json({ status: 'error', message: '沒有變更' });
    }

    let changeReason;
    try {
      changeReason = requireChangeReason(req.body?.changeNote);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    }

    const row = await prisma.$transaction(async (tx) => {
      let resignMemberIds = [];
      let action = 'UPDATE';
      const summaryParts = [];
      const data = {};

      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) {
          const err = new Error('合約標題不可為空');
          err.statusCode = 400;
          throw err;
        }
        if (t !== current.title) {
          data.title = t;
          summaryParts.push('標題');
        }
      }
      if (shortName !== undefined) {
        const s = String(shortName || '').trim();
        if (s.length > 20) {
          const err = new Error('簡稱請勿超過 20 字');
          err.statusCode = 400;
          throw err;
        }
        const nextShort = s || null;
        if (nextShort !== (current.shortName || null)) {
          data.shortName = nextShort;
          summaryParts.push('簡稱');
        }
      }
      if (purpose !== null && purpose !== current.purpose) {
        data.purpose = purpose;
        summaryParts.push('用途');
      }
      if (status !== undefined) {
        const s = String(status).trim().toUpperCase();
        if (s !== 'ACTIVE' && s !== 'VOIDED') {
          const err = new Error('status 僅允許 ACTIVE 或 VOIDED');
          err.statusCode = 400;
          throw err;
        }
        if (s !== current.status) {
          data.status = s;
          action = s === 'VOIDED' ? 'VOID_CONTRACT' : 'REACTIVATE';
          summaryParts.push(s === 'VOIDED' ? '作廢合約' : '重新啟用');
        }
      }

      const nextPurpose =
        data.purpose !== undefined ? data.purpose : current.purpose;
      const nextStatus = data.status !== undefined ? data.status : current.status;
      if (
        nextPurpose === CONTRACT_PURPOSE.BIOMETRICS_CONSENT &&
        nextStatus === 'ACTIVE'
      ) {
        await assertUniqueBiometricsConsent(tx, { excludeId: id });
      }
      if (
        nextPurpose === CONTRACT_PURPOSE.NEW_MEMBER &&
        nextStatus === 'ACTIVE'
      ) {
        await assertUniqueNewMemberContract(tx, { excludeId: id });
      }

      if (Object.keys(data).length) {
        await tx.membershipContract.update({ where: { id }, data });
      }

      let activeVersionId = current.versions[0]?.id ?? null;
      let newBodyHash = null;

      if (body !== undefined) {
        const text = String(body).trim();
        if (!text) {
          const err = new Error('合約內容不可為空');
          err.statusCode = 400;
          throw err;
        }
        const latest = current.versions[0] || null;
        const prevBody = latest?.body || '';

        if (!latest) {
          const versionBase = current.versionBase || DEFAULT_VERSION_BASE;
          const label = buildVersionLabel(versionBase, 1);
          newBodyHash = hashContractBody(text);
          const created = await tx.membershipContractVersion.create({
            data: {
              contractId: id,
              version: 1,
              body: text,
              bodyHash: newBodyHash,
              changeNote: changeReason,
              status: 'ACTIVE',
              createdByStaffId: req.user?.id ?? null,
            },
          });
          activeVersionId = created.id;
          summaryParts.push(`建立初版內容（${label}）`);
        } else if (text !== prevBody) {
          // 電子合約：條文異動一律升版留痕，禁止覆寫已發布版本
          const bumped = await bumpContractBody(tx, {
            contractId: id,
            versionBase: current.versionBase,
            text,
            changeReason,
            staffId: req.user?.id ?? null,
          });
          activeVersionId = bumped.created.id;
          newBodyHash = bumped.created.bodyHash;
          action = 'BUMP_VERSION';
          summaryParts.push(`條文升版（前版作廢→${bumped.versionLabel}）`);
          resignMemberIds = bumped.resignMemberIds;
        } else if (bumpVersion) {
          const err = new Error('內容未變更，無需建立新版本');
          err.statusCode = 400;
          throw err;
        }
      } else if (bumpVersion) {
        const err = new Error('建立新版本須一併提供合約內容');
        err.statusCode = 400;
        throw err;
      }

      if (!summaryParts.length && !Object.keys(data).length) {
        const err = new Error('沒有變更');
        err.statusCode = 400;
        throw err;
      }

      const summary = summaryParts.join('、') || '電子合約異動';
      await writeChangeLog(tx, {
        contractId: id,
        versionId: activeVersionId,
        action,
        changeNote: changeReason,
        summary,
        staffId: req.user?.id ?? null,
      });

      const auditAction =
        action === 'VOID_CONTRACT'
          ? 'VOID'
          : action === 'REACTIVATE'
            ? 'REACTIVATE'
            : action === 'BUMP_VERSION'
              ? 'BUMP_VERSION'
              : 'UPDATE';

      await writeContractAudit(tx, {
        contractId: id,
        versionId: activeVersionId,
        action: auditAction,
        summary,
        changeNote: changeReason,
        detail: {
          fields: Object.keys(data),
          bodyChanged: body !== undefined && summaryParts.some((p) => p.includes('升版') || p.includes('初版')),
          bodyHash: newBodyHash,
          resignCount: resignMemberIds.length,
          before: {
            title: current.title,
            shortName: current.shortName,
            purpose: current.purpose,
            status: current.status,
          },
          after: {
            title: data.title !== undefined ? data.title : current.title,
            shortName: data.shortName !== undefined ? data.shortName : current.shortName,
            purpose: nextPurpose,
            status: nextStatus,
          },
        },
        actorStaffId: req.user?.id ?? null,
        actorType: 'ADMIN',
        ...clientMeta,
      });

      const updated = await tx.membershipContract.findUnique({
        where: { id },
        include: versionInclude,
      });
      return { updated, resignMemberIds, action };
    });

    const { updated: contractRow, resignMemberIds, action } = row;

    if (resignMemberIds.length) {
      await Promise.all(
        resignMemberIds.map((memberId) => syncMemberAllowBiometrics(memberId)),
      );
    }

    const bumped =
      action === 'BUMP_VERSION'
        ? `（新版本 ${buildVersionLabel(contractRow.versionBase || DEFAULT_VERSION_BASE, contractRow.versions?.find((v) => v.status === 'ACTIVE')?.version || 1)}；前版已作廢）`
        : '';
    const resignNote =
      resignMemberIds.length > 0
        ? `；${resignMemberIds.length} 位已簽會員需重新簽署`
        : '';
    res.json({
      status: 'success',
      message: `電子合約 [${contractRow.shortName || contractRow.title}] 已更新${bumped}${resignNote}`,
      data: serializeContract(contractRow),
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新電子合約失敗' });
  }
});

export default router;
