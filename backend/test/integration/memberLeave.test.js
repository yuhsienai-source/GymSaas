// 契約第十二條會員權暫停：送審 → DUTY+ 核准 → 生效（效期順延）／退回；回溯、補證明、排程、凍結天數
import '../helpers/env.js';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePrisma, createMember, createStaffUser, prisma, resetDb } from '../helpers/db.js';
import {
  approveMemberLeave,
  attachLeaveProof,
  endMemberLeaveEarly,
  medicalSuspensionForMember,
  processMemberLeaveQueue,
  rejectMemberLeave,
  submitLeaveApplication,
} from '../../lib/memberLeave.js';
import { UNLIMITED_MEMBER_PLAN } from '../../lib/promotion.js';
import { issueLeaveProofAccess, redeemLeaveProofAccessToken } from '../../lib/leaveProofAccess.js';
import { deleteIdPhotoObject, putIdPhotoObject } from '../../lib/idPhotoStorage.js';

// 2026-10-05（一）10:00 台灣時間
const NOW = new Date('2026-10-05T02:00:00Z');
const DAY = 24 * 3600 * 1000;
const EXPIRE = new Date('2027-01-01T16:00:00Z');
const PROOF = { storageKey: 'leave-proofs/test.jpg', fileName: 'proof.jpg' };

let duty;
let staff;

beforeEach(async () => {
  await resetDb();
  duty = await createStaffUser('DUTY');
  staff = await createStaffUser('STAFF');
});

after(closePrisma);

async function monthlyMember() {
  const m = await createMember();
  return prisma.member.update({ where: { id: m.id }, data: { plan: UNLIMITED_MEMBER_PLAN, expireDate: EXPIRE } });
}

const isError = (statusCode, code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.statusCode, statusCode);
  return true;
};

const submit = (memberId, over = {}) =>
  submitLeaveApplication({
    memberId,
    category: 'MILITARY',
    startDate: '2026-10-05',
    endDate: '2026-10-14',
    proof: PROOF,
    now: NOW,
    ...over,
  });

describe('送審與核准', () => {
  test('會員送件一律 PENDING，不動效期；同時僅一筆未結案', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id);
    assert.equal(leave.status, 'PENDING');
    assert.equal(leave.days, 10);
    assert.equal(leave.source, 'MEMBER');
    assert.equal(leave.reviewDueAt.toISOString(), '2026-10-14T15:59:59.999Z');
    assert.equal((await prisma.member.findUnique({ where: { id: m.id } })).expireDate.getTime(), EXPIRE.getTime());

    await assert.rejects(submit(m.id, { startDate: '2026-11-01', endDate: '2026-11-05' }), isError(409, 'LEAVE_ALREADY_OPEN'));
  });

  test('非月費方案或起日超過效期不得申請', async () => {
    const timed = await createMember();
    await assert.rejects(submit(timed.id), isError(409, 'LEAVE_PLAN_INELIGIBLE'));
    const m = await monthlyMember();
    await assert.rejects(submit(m.id, { startDate: '2027-01-10', endDate: '2027-01-20' }), isError(409, 'LEAVE_MEMBERSHIP_EXPIRED'));
  });

  test('STAFF 不得審核；DUTY+ 核准起日已到 → 生效、效期精確順延 days、閘機擋至 endAt', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id);
    await assert.rejects(approveMemberLeave({ leaveId: leave.id, user: staff, now: NOW }), isError(403, 'DUTY_ROLE_REQUIRED_FOR_LEAVE_REVIEW'));

    const r = await approveMemberLeave({ leaveId: leave.id, user: duty, note: '兵單核對', now: NOW });
    assert.equal(r.scheduled, false);
    assert.equal(r.leave.status, 'ACTIVE');
    assert.equal(r.leave.reviewedByStaffId, duty.id);
    const member = await prisma.member.findUnique({ where: { id: m.id } });
    assert.equal(member.expireDate.getTime(), EXPIRE.getTime() + 10 * DAY);
    assert.equal(member.leaveUntil.getTime(), r.leave.endAt.getTime());
  });

  test('起日未到 → APPROVED，排程於起日生效', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { startDate: '2026-10-20', endDate: '2026-10-29' });
    const r = await approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW });
    assert.equal(r.scheduled, true);
    assert.equal(r.leave.status, 'APPROVED');

    const early = await processMemberLeaveQueue({ now: new Date(leave.startAt.getTime() - 1000) });
    assert.equal(early.activated, 0);
    const due = await processMemberLeaveQueue({ now: new Date(leave.startAt.getTime() + 1000) });
    assert.equal(due.activated, 1);
    assert.equal((await prisma.memberLeave.findUnique({ where: { id: leave.id } })).status, 'ACTIVE');
  });

  test('核准後方案被截斷 → 排程自動退回，不動效期', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { startDate: '2026-10-20', endDate: '2026-10-29' });
    await approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW });
    await prisma.member.update({ where: { id: m.id }, data: { plan: '計時會員', expireDate: NOW } });

    const r = await processMemberLeaveQueue({ now: new Date(leave.startAt.getTime() + 1000) });
    assert.equal(r.autoRejected, 1);
    const row = await prisma.memberLeave.findUnique({ where: { id: leave.id } });
    assert.equal(row.status, 'REJECTED');
    assert.match(row.reviewNote, /系統自動退回/);
  });

  test('退回必填原因；已核准未開始者亦可退回', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { startDate: '2026-10-20', endDate: '2026-10-29' });
    await assert.rejects(rejectMemberLeave({ leaveId: leave.id, user: duty, reason: ' ', now: NOW }), isError(400, 'LEAVE_REJECT_REASON_REQUIRED'));
    await approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW });
    const row = await rejectMemberLeave({ leaveId: leave.id, user: duty, reason: '證明不符', now: NOW });
    assert.equal(row.status, 'REJECTED');
    assert.equal(row.reviewNote, '證明不符');
    await assert.rejects(rejectMemberLeave({ leaveId: leave.id, user: duty, reason: '再退', now: NOW }), isError(409, 'LEAVE_NOT_PENDING'));
  });
});

describe('證明文件', () => {
  test('一般事由未附證明 400；傷病可先送件，補附前不得核准', async () => {
    const m = await monthlyMember();
    await assert.rejects(submit(m.id, { category: 'RELOCATION', proof: null }), isError(400, 'LEAVE_PROOF_REQUIRED'));

    const leave = await submit(m.id, { category: 'MEDICAL', proof: null });
    assert.equal(leave.proofDueAt.toISOString(), '2026-11-04T16:00:00.000Z');
    assert.equal(leave.reviewDueAt, null);
    await assert.rejects(approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW }), isError(409, 'LEAVE_PROOF_REQUIRED'));

    const later = new Date(NOW.getTime() + 3 * DAY);
    const withProof = await attachLeaveProof({ leaveId: leave.id, memberId: m.id, proof: PROOF, now: later });
    assert.equal(withProof.proofDueAt, null);
    assert.ok(withProof.reviewDueAt > later);
    await assert.rejects(attachLeaveProof({ leaveId: leave.id, memberId: m.id + 999, proof: PROOF, now: later }), isError(404, 'LEAVE_NOT_FOUND'));
  });

  test('逾期未補證明 → 排程自動退回', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { category: 'EPIDEMIC', proof: null });
    const r = await processMemberLeaveQueue({ now: new Date(leave.proofDueAt.getTime() + 1000) });
    assert.equal(r.proofExpired, 1);
    assert.equal((await prisma.memberLeave.findUnique({ where: { id: leave.id } })).status, 'REJECTED');
  });
});

describe('回溯補辦', () => {
  test('回溯期間有月費進場 → 409 LEAVE_OVERLAPS_CHECKIN', async () => {
    const m = await monthlyMember();
    await prisma.checkInLog.create({
      data: { memberId: m.id, billingMode: '月費通行', checkInAt: new Date('2026-09-25T02:00:00Z'), checkOutAt: new Date('2026-09-25T03:00:00Z') },
    });
    await assert.rejects(
      submit(m.id, { category: 'MEDICAL', startDate: '2026-09-20', endDate: '2026-10-10' }),
      isError(409, 'LEAVE_OVERLAPS_CHECKIN'),
    );
    // 已取消之進出場不算
    await prisma.checkInLog.updateMany({ where: { memberId: m.id }, data: { status: 'CANCELLED' } });
    const leave = await submit(m.id, { category: 'MEDICAL', startDate: '2026-09-20', endDate: '2026-10-10' });
    assert.equal(leave.status, 'PENDING');
  });

  test('已期滿之回溯暫停核准即結案：效期順延、frozenDays＝days、不擋閘機', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { category: 'MEDICAL', startDate: '2026-09-10', endDate: '2026-09-30' });
    const r = await approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW });
    assert.equal(r.leave.status, 'ENDED');
    assert.equal(r.leave.frozenDays, 21);
    const member = await prisma.member.findUnique({ where: { id: m.id } });
    assert.equal(member.expireDate.getTime(), EXPIRE.getTime() + 21 * DAY);
    assert.equal(member.leaveUntil, null);
  });
});

describe('七工作日審核期限排除國定假日', () => {
  test('未建立假日曆之年度回退 laborLaw 預設；已建立則以 HQ 假日曆為準', async () => {
    const m = await monthlyMember();
    // 2026-10-08（四）起：10/9、10/12～10/16、10/19；10/10 國慶為週六不影響
    const thu = new Date('2026-10-08T02:00:00Z');
    const a = await submit(m.id, { startDate: '2026-10-08', endDate: '2026-10-14', now: thu });
    assert.equal(a.reviewDueAt.toISOString(), '2026-10-19T15:59:59.999Z');
    await rejectMemberLeave({ leaveId: a.id, user: duty, reason: '測試退回', now: thu });

    await prisma.publicHoliday.create({ data: { date: new Date('2026-10-09T00:00:00Z'), name: '國慶補假' } });
    const b = await submit(m.id, { startDate: '2026-10-08', endDate: '2026-10-14', now: thu });
    assert.equal(b.reviewDueAt.toISOString(), '2026-10-20T15:59:59.999Z');
  });
});

describe('證明調閱（特種個資）稽核', () => {
  const req = { headers: { 'user-agent': 'node-test', 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' }, ip: '203.0.113.7' };
  const storageKey = `leave-proofs/test-${process.pid}.jpg`;

  test('STAFF 403、原因不足 400；DUTY+ 簽發短效 URL 並寫 ISSUE、兌換寫 REDEEM；稽核不可改刪', async () => {
    await putIdPhotoObject(storageKey, Buffer.from('fake-jpeg'));
    try {
      const m = await monthlyMember();
      const leave = await submit(m.id, { proof: { storageKey, fileName: 'cert.jpg' } });
      const dutyUser = { ...duty, branchId: 7 };

      await assert.rejects(issueLeaveProofAccess({ leaveId: leave.id, user: staff, reason: '審核申請', req }), isError(403, 'DUTY_ROLE_REQUIRED_FOR_LEAVE_PROOF'));
      await assert.rejects(issueLeaveProofAccess({ leaveId: leave.id, user: dutyUser, reason: '看', req }), isError(400, 'REASON_REQUIRED'));
      assert.equal(await prisma.leaveProofAccessLog.count(), 0);

      const access = await issueLeaveProofAccess({ leaveId: leave.id, user: dutyUser, reason: '審核暫停申請', req });
      assert.equal(access.mode, 'local_token');
      assert.ok(access.expiresIn >= 180 && access.expiresIn <= 300);
      const [issued] = await prisma.leaveProofAccessLog.findMany();
      assert.equal(issued.action, 'ISSUE');
      assert.equal(issued.leaveId, leave.id);
      assert.equal(issued.memberId, m.id);
      assert.equal(issued.staffId, duty.id);
      assert.equal(issued.branchId, 7);
      assert.equal(issued.reason, '審核暫停申請');
      assert.ok(issued.ipAddress);

      const token = access.url.split('/').pop();
      const file = await redeemLeaveProofAccessToken(token, req);
      assert.equal(file.buf.toString(), 'fake-jpeg');
      const redeem = await prisma.leaveProofAccessLog.findFirst({ where: { action: 'REDEEM' } });
      assert.equal(redeem.staffId, duty.id);

      const [body, sig] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), lid: leave.id + 1 })).toString('base64url');
      await assert.rejects(redeemLeaveProofAccessToken(`${forged}.${sig}`, req), isError(403, 'ACCESS_TOKEN_INVALID'));

      await assert.rejects(prisma.leaveProofAccessLog.update({ where: { id: issued.id }, data: { reason: 'x' } }), /append-only/);
      await assert.rejects(prisma.leaveProofAccessLog.delete({ where: { id: issued.id } }), /append-only/);
    } finally {
      await deleteIdPhotoObject(storageKey).catch(() => {});
    }
  });
});

describe('凍結天數與傷病累計', () => {
  test('提早銷假只計實際凍結天數，效期扣回未休天數', async () => {
    const m = await monthlyMember();
    const leave = await submit(m.id, { category: 'MEDICAL' });
    await approveMemberLeave({ leaveId: leave.id, user: duty, now: NOW });

    const endAt = new Date(NOW.getTime() + 4 * DAY);
    await endMemberLeaveEarly({ memberId: m.id, leaveId: leave.id, reason: '提早康復', now: endAt });
    const row = await prisma.memberLeave.findUnique({ where: { id: leave.id } });
    assert.equal(row.status, 'ENDED');
    assert.ok(row.frozenDays >= 4 && row.frozenDays <= 5, `frozenDays=${row.frozenDays}`);
    const member = await prisma.member.findUnique({ where: { id: m.id } });
    assert.equal(member.expireDate.getTime(), EXPIRE.getTime() + row.frozenDays * DAY);
    assert.deepEqual(await medicalSuspensionForMember(prisma, m.id, endAt), { days: row.frozenDays, exemptEligible: false });
  });

  test('傷病已結束暫停累計 ≥180 日 → exemptEligible', async () => {
    const m = await monthlyMember();
    const base = { memberId: m.id, category: 'MEDICAL', status: 'ENDED', startAt: new Date('2025-01-01T16:00:00Z'), endAt: new Date('2025-07-01T16:00:00Z') };
    await prisma.memberLeave.create({ data: { ...base, days: 120, frozenDays: 120 } });
    await prisma.memberLeave.create({ data: { ...base, days: 90, frozenDays: 60 } });
    await prisma.memberLeave.create({ data: { ...base, category: 'OVERSEAS', days: 90, frozenDays: 90 } });
    await prisma.memberLeave.create({ data: { ...base, status: 'REJECTED', days: 90 } });
    assert.deepEqual(await medicalSuspensionForMember(prisma, m.id, NOW), { days: 180, exemptEligible: true });
  });
});
