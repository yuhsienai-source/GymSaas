// lib/emailOtpTemplate.js — Email OTP 信件版型（table 排版，相容常見信箱）
const BRAND = '#083D4F';
const BRAND_NAME = '1st FITNESS';
const MUTED = '#5B6B73';
const SURFACE = '#F3F6F8';
const WHITE = '#FFFFFF';
const BORDER = '#D7E0E5';

const PURPOSE_LABEL = {
  LOGIN: {
    subject: `【${BRAND_NAME}】登入驗證碼`,
    eyebrow: 'MEMBER LOGIN',
    title: '登入驗證碼',
    lead: '請輸入以下驗證碼以完成會員登入。',
    kind: 'LOGIN_OTP',
  },
  REGISTER: {
    subject: `【${BRAND_NAME}】註冊驗證碼`,
    eyebrow: 'MEMBER REGISTER',
    title: '註冊驗證碼',
    lead: '請輸入以下驗證碼以繼續完成會員註冊。',
    kind: 'REGISTER_OTP',
  },
  EMAIL_ENROLL: {
    subject: `【${BRAND_NAME}】Email 補登驗證碼`,
    eyebrow: 'EMAIL ENROLL',
    title: 'Email 補登驗證碼',
    lead: '請輸入以下驗證碼以完成舊會員 Email 補登與驗證。',
    kind: 'EMAIL_ENROLL_OTP',
  },
  DEVICE_RESET: {
    subject: `【${BRAND_NAME}】換機驗證碼`,
    eyebrow: 'DEVICE RESET',
    title: '換機驗證碼',
    lead: '請輸入以下驗證碼以完成裝置換綁。',
    kind: 'DEVICE_RESET_OTP',
  },
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brandLogoUrl() {
  const base = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  if (!base) return null;
  return `${base}/logo-icon.png`;
}

/**
 * @param {{ purpose: string, code: string, expiresInMin?: number }} opts
 */
export function buildOtpMailCopy(opts) {
  const purpose = String(opts.purpose || '').toUpperCase();
  const meta = PURPOSE_LABEL[purpose] || PURPOSE_LABEL.LOGIN;
  const code = String(opts.code || '').trim();
  const expiresInMin = Number(opts.expiresInMin) || 4;
  const logoUrl = brandLogoUrl();

  const text = [
    `${BRAND_NAME} ${meta.title}`,
    '',
    meta.lead,
    '',
    `驗證碼：${code}`,
    '',
    `請於 ${expiresInMin} 分鐘內輸入。錯誤達 3 次將作廢。`,
    '若非本人操作，請忽略此信。',
    '',
    `— ${BRAND_NAME}`,
  ].join('\n');

  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="${escapeHtml(BRAND_NAME)}" style="display:block;border:0;outline:none;width:48px;height:48px;" />`
    : `<div style="width:48px;height:48px;border-radius:10px;background:${BRAND};color:${WHITE};font:700 14px/48px Arial,sans-serif;text-align:center;">1st</div>`;

  const digits = code
    .split('')
    .map(
      (d) =>
        `<td style="width:40px;height:52px;background:${SURFACE};border:1px solid ${BORDER};border-radius:8px;text-align:center;vertical-align:middle;font:700 22px/52px 'Courier New',Courier,monospace;color:${BRAND};letter-spacing:0;">${escapeHtml(d)}</td>`,
    )
    .join('<td style="width:8px;"></td>');

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(meta.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC','PingFang TC',Arial,sans-serif;color:${BRAND};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SURFACE};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:${WHITE};border:1px solid ${BORDER};border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:${BRAND};padding:22px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="56" valign="middle">${logoBlock}</td>
                  <td valign="middle" style="padding-left:14px;">
                    <div style="font:700 18px/1.2 Arial,sans-serif;color:${WHITE};">${escapeHtml(BRAND_NAME)}</div>
                    <div style="margin-top:6px;font:600 11px/1 Arial,sans-serif;letter-spacing:0.14em;color:rgba(255,255,255,0.72);">${escapeHtml(meta.eyebrow)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 8px;">
              <h1 style="margin:0 0 10px;font:700 22px/1.3 Arial,sans-serif;color:${BRAND};">${escapeHtml(meta.title)}</h1>
              <p style="margin:0;font:400 15px/1.6 Arial,sans-serif;color:${MUTED};">${escapeHtml(meta.lead)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                <tr>${digits}</tr>
              </table>
              <p style="margin:18px 0 0;text-align:center;font:700 28px/1.2 'Courier New',Courier,monospace;letter-spacing:0.28em;color:${BRAND};">${escapeHtml(code)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SURFACE};border-radius:12px;">
                <tr>
                  <td style="padding:16px 18px;font:400 13px/1.7 Arial,sans-serif;color:${MUTED};">
                    <strong style="color:${BRAND};">有效時間</strong>：${expiresInMin} 分鐘內輸入<br />
                    <strong style="color:${BRAND};">安全提醒</strong>：錯誤達 3 次將立即作廢；請勿轉傳驗證碼<br />
                    若非本人操作，請忽略此信，帳號不會受影響。
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid ${BORDER};padding:18px 28px;font:400 12px/1.5 Arial,sans-serif;color:${MUTED};">
              © ${escapeHtml(BRAND_NAME)}&#12288;會員中心驗證信&#12288;請勿直接回覆
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: meta.subject,
    text,
    html,
    kind: meta.kind,
  };
}
