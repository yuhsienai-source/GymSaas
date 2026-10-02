// lib/staffNotificationScheduler.js — 員工通知排程：排班／排假提醒＋LINE 推播失敗重試
import { runRosterReminders } from './rosterService.js';
import { dispatchStaffNotifications } from './staffNotificationService.js';

let timer = null;

/** 預設每 10 分鐘（STAFF_NOTIFY_TICK_MS 可調） */
export function startStaffNotificationScheduler(intervalMs) {
  if (timer) return;
  const ms = Number(intervalMs) || Number(process.env.STAFF_NOTIFY_TICK_MS) || 10 * 60 * 1000;
  const tick = async () => {
    try {
      const r = await runRosterReminders();
      const total = r.ackReminders + r.offReminders + r.offClosed;
      if (total > 0) {
        console.log(`[員工通知] 確認提醒 ${r.ackReminders}、排假提醒 ${r.offReminders}、排假截止彙整 ${r.offClosed}`);
      }
    } catch (error) {
      console.error('[員工通知] 提醒排程例外:', error.message);
    }
    try {
      await dispatchStaffNotifications({ retryFailed: true });
    } catch (error) {
      console.error('[員工通知] 派送排程例外:', error.message);
    }
  };
  void tick();
  timer = setInterval(() => void tick(), ms);
  if (typeof timer.unref === 'function') timer.unref();
}
