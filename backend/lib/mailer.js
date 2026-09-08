// lib/mailer.js — 交易／通知 MAIL（SMTP 未設定時僅寫 log + NotificationLog）
import prisma from './prisma.js';

const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
// 相容 EMAIL_FROM（Elastic Email 等慣用名）
const MAIL_FROM = (
  process.env.MAIL_FROM ||
  process.env.EMAIL_FROM ||
  SMTP_USER ||
  'noreply@gymsaas.local'
).trim();
const STAFF_INBOX = (process.env.STAFF_INBOX || '').trim();

export function isMailConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/**
 * @param {{ to: string; subject: string; html?: string; text?: string; memberId?: number; kind?: string; omitBodyFromLog?: boolean }} opts
 */
export async function sendMail(opts) {
  const to = String(opts.to || '').trim();
  if (!to) {
    return { ok: false, message: '缺少收件人' };
  }

  const subject = String(opts.subject || '').trim();
  const html = opts.html || opts.text || '';
  const kind = opts.kind || 'GENERAL';
  const omitBody = Boolean(opts.omitBodyFromLog);
  const logBody = omitBody ? '[redacted]' : html;

  if (!isMailConfigured()) {
    // 即使 mock 也禁止把 OTP 明碼寫進 console
    console.log(`[MAIL:mock] to=${to} subject=${subject}${omitBody ? ' body=redacted' : ''}`);
    if (opts.memberId) {
      await prisma.notificationLog.create({
        data: {
          memberId: opts.memberId,
          channel: 'EMAIL',
          kind,
          subject,
          body: logBody,
          status: 'MOCK',
        },
      });
    }
    return { ok: true, mock: true };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      requireTLS: SMTP_PORT === 587 || SMTP_PORT === 2525,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transport.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      html: opts.html || undefined,
      text: opts.text || undefined,
    });
    console.info(`[MAIL:sent] to=${to} from=${MAIL_FROM} kind=${kind}`);
    if (opts.memberId) {
      await prisma.notificationLog.create({
        data: {
          memberId: opts.memberId,
          channel: 'EMAIL',
          kind,
          subject,
          body: logBody,
          status: 'SENT',
        },
      });
    }
    return { ok: true };
  } catch (err) {
    console.error('[MAIL]', err.message);
    return { ok: false, message: err.message };
  }
}

export async function notifyStaffInbox(subject, html) {
  if (!STAFF_INBOX) {
    console.log(`[MAIL:staff-inbox-mock] ${subject}`);
    return { ok: true, mock: true };
  }
  return sendMail({ to: STAFF_INBOX, subject, html, kind: 'STAFF_ALERT' });
}

export async function sendInvoiceAndContractMail(member, { invoiceNumber, contractTitle }) {
  const email = member?.email?.trim();
  if (!email) return { ok: false, message: '會員未填 email' };
  const lines = [
    `<p>親愛的 ${member.name} 您好，</p>`,
    invoiceNumber ? `<p>電子發票號碼：${invoiceNumber}</p>` : '',
    contractTitle ? `<p>電子契約：${contractTitle}（請至會員專區查閱）</p>` : '',
    '<p>體育客 GymSaaS</p>',
  ].filter(Boolean);
  return sendMail({
    to: email,
    memberId: member.id,
    kind: 'INVOICE',
    subject: '體育客 — 付款完成通知',
    html: lines.join('\n'),
  });
}
