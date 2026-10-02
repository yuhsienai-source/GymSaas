// routes/staffNotifications.js — 員工本人通知匣＋LINE 推播綁定（身分一律取自員工 JWT）
// GET  /                 通知匣（最近 50 筆＋未讀數）
// POST /read { ids? }    標記已讀（省略 ids＝全部）
// GET  /line             綁定狀態
// POST /line/bind-url    產生 LINE Login 授權網址（state 綁本人 staffId）
// POST /line/bind { code, state }
// PATCH /line { notifyEnabled } · DELETE /line · POST /line/test
import express from 'express';
import { verifyStaff } from '../middleware/jwtAuth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import {
  bindStaffLine,
  createStaffLineBindUrl,
  getStaffLineStatus,
  setStaffLineNotify,
  unbindStaffLine,
} from '../lib/staffLineBinding.js';
import {
  dispatchStaffNotifications,
  listMyNotifications,
  markNotificationsRead,
  notifyStaff,
} from '../lib/staffNotificationService.js';

function sendErr(res, error, fallback) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', code: error.code || undefined, message: error.message });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

const byStaff = (req) => `staff:${req.user?.id}`;
const bindLimiter = createRateLimiter({
  keyPrefix: 'staff-line-bind',
  windowMs: 10 * 60_000,
  max: 10,
  keyFn: byStaff,
  message: 'LINE 綁定操作過於頻繁，請稍後再試',
});
const testLimiter = createRateLimiter({
  keyPrefix: 'staff-line-test',
  windowMs: 10 * 60_000,
  max: 3,
  keyFn: byStaff,
  message: '測試推播過於頻繁，請稍後再試',
});

export const staffNotificationsRouter = express.Router();
staffNotificationsRouter.use(verifyStaff);

staffNotificationsRouter.get('/', async (req, res) => {
  try {
    const data = await listMyNotifications(req.user.id, { limit: req.query.limit });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取通知失敗');
  }
});

staffNotificationsRouter.post('/read', async (req, res) => {
  try {
    const data = await markNotificationsRead(req.user.id, req.body?.ids);
    res.json({ status: 'success', message: '已標記已讀', data });
  } catch (error) {
    sendErr(res, error, '標記已讀失敗');
  }
});

staffNotificationsRouter.get('/line', async (req, res) => {
  try {
    res.json({ status: 'success', data: await getStaffLineStatus(req.user.id) });
  } catch (error) {
    sendErr(res, error, '讀取 LINE 綁定狀態失敗');
  }
});

staffNotificationsRouter.post('/line/bind-url', bindLimiter, (req, res) => {
  try {
    res.json({ status: 'success', data: createStaffLineBindUrl(req.user.id) });
  } catch (error) {
    sendErr(res, error, '無法產生 LINE 綁定網址');
  }
});

staffNotificationsRouter.post('/line/bind', bindLimiter, async (req, res) => {
  try {
    const data = await bindStaffLine(req.user.id, {
      code: req.body?.code ? String(req.body.code) : '',
      state: req.body?.state ? String(req.body.state) : '',
    });
    res.json({ status: 'success', message: '已綁定 LINE 推播', data });
  } catch (error) {
    sendErr(res, error, 'LINE 綁定失敗');
  }
});

staffNotificationsRouter.patch('/line', async (req, res) => {
  try {
    const data = await setStaffLineNotify(req.user.id, req.body?.notifyEnabled);
    res.json({ status: 'success', message: data.notifyEnabled ? '已開啟 LINE 推播' : '已關閉 LINE 推播', data });
  } catch (error) {
    sendErr(res, error, '更新推播設定失敗');
  }
});

staffNotificationsRouter.delete('/line', async (req, res) => {
  try {
    const data = await unbindStaffLine(req.user.id);
    res.json({ status: 'success', message: '已解除 LINE 綁定', data });
  } catch (error) {
    sendErr(res, error, '解除綁定失敗');
  }
});

staffNotificationsRouter.post('/line/test', testLimiter, async (req, res) => {
  try {
    await notifyStaff([req.user.id], {
      type: 'TEST',
      title: '測試通知',
      body: '這是一則測試推播；收到代表 LINE 通知設定完成。',
      link: '/staff/my-attendance',
    });
    await dispatchStaffNotifications();
    const data = await listMyNotifications(req.user.id, { limit: 1 });
    const latest = data.items[0] || null;
    res.json({
      status: 'success',
      message:
        latest?.status === 'SENT'
          ? '已送出測試推播'
          : latest?.status === 'PENDING'
            ? '測試推播排隊中'
            : '已寫入站內通知（LINE 未送出）',
      data: { notification: latest },
    });
  } catch (error) {
    sendErr(res, error, '測試推播失敗');
  }
});
