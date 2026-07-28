// lib/lineNotify.js — LINE Messaging API 推播（約課等通知）
/**
 * 需設定 LINE_CHANNEL_ACCESS_TOKEN（Messaging API Channel access token）。
 * 收件人為 Member.lineId（LINE Login 綁定後的 userId）；學員須已加官方帳號好友。
 *
 * 開通（2024/09/04 起）：不可再於 Developers Console 直接新建 Messaging API Channel。
 * 請於 Official Account Manager → 設定 → Messaging API → 啟用，再回 Developers 取 Token。
 *
 * 推播失敗不拋錯阻斷主流程，回傳 { ok, skipped?, reason?, error? }。
 */

function getAccessToken() {
  return String(process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim() || null;
}

/**
 * @param {string} lineUserId
 * @param {string} text
 */
export async function pushLineText(lineUserId, text) {
  const token = getAccessToken();
  if (!token) {
    return { ok: false, skipped: true, reason: '未設定 LINE_CHANNEL_ACCESS_TOKEN' };
  }
  const to = String(lineUserId || '').trim();
  if (!to) {
    return { ok: false, skipped: true, reason: '會員尚未綁定 LINE' };
  }
  const body = String(text || '').trim().slice(0, 4900);
  if (!body) {
    return { ok: false, skipped: true, reason: '訊息內容為空' };
  }

  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: 'text', text: body }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`LINE push 失敗 ${res.status}:`, errText.slice(0, 500));
      return {
        ok: false,
        skipped: false,
        reason: `LINE 回應 ${res.status}`,
        error: errText.slice(0, 200),
      };
    }
    return { ok: true };
  } catch (err) {
    console.error('LINE push 例外:', err.message);
    return { ok: false, skipped: false, reason: err.message || 'LINE 連線失敗' };
  }
}

function formatTaipeiRange(startAt, endAt) {
  const optsDay = {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  };
  const optsTime = {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const s = new Date(startAt);
  const e = new Date(endAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '—';
  const day = s.toLocaleDateString('zh-TW', optsDay);
  const t0 = s.toLocaleTimeString('zh-TW', optsTime);
  const t1 = e.toLocaleTimeString('zh-TW', optsTime);
  return `${day} ${t0}–${t1}`;
}

/**
 * 約課成功通知學員
 * @param {{
 *   lineId?: string|null,
 *   memberName?: string|null,
 *   classTitle: string,
 *   startAt: Date|string,
 *   endAt: Date|string,
 *   branchName?: string|null,
 *   venueName?: string|null,
 *   stationName?: string|null,
 *   trainerName?: string|null,
 *   bookedBy?: 'trainer'|'member',
 * }} opts
 */
export async function notifyClassBooked(opts) {
  const {
    lineId,
    memberName,
    classTitle,
    startAt,
    endAt,
    branchName,
    venueName,
    stationName,
    trainerName,
    bookedBy = 'trainer',
  } = opts || {};

  const place = [branchName, venueName].filter(Boolean).join(' · ');
  const station = stationName ? `／${stationName}` : '';
  const intro =
    bookedBy === 'member'
      ? `${memberName || '學員'} 您好，您已成功預約課程：`
      : `${memberName || '學員'} 您好，教練已為您完成約課：`;

  let manageHint = '請準時到場；若需改期請聯繫教練或櫃檯。';
  try {
    const { buildFrontendRedirect } = await import('./frontendUrl.js');
    const bookUrl = buildFrontendRedirect('/member/book');
    manageHint = `請準時到場；可至 ${bookUrl} 查看／管理預約。`;
  } catch {
    /* FRONTEND_URL 未設定時略過連結 */
  }

  const lines = [
    '【體育客】約課成功通知',
    '',
    intro,
    `課程：${classTitle || '—'}`,
    `時段：${formatTaipeiRange(startAt, endAt)}`,
    place ? `地點：${place}${station}` : null,
    trainerName ? `教練：${trainerName}` : null,
    '',
    manageHint,
  ].filter((x) => x != null);

  return pushLineText(lineId, lines.join('\n'));
}
