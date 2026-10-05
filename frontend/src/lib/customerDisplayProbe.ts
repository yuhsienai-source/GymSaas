/**
 * 開立 B2B 折讓前確認客顯視窗在線。
 * 只走 BroadcastChannel('pos_display_bus') 的 PING／PONG，並以 probeId 對應本次探測；
 * 心跳 PONG 不含此 id，不能當成客顯已開。
 */
import { createPosDisplayBus, POS_DISPLAY_TYPES } from './posDisplayBus';

export const DISPLAY_PROBE_TIMEOUT_MS = 1500;

export const DISPLAY_PROBE_BLOCKED = {
  title: '請先開啟客顯並確認買受人在場',
  message:
    '此單據開立折讓後須由顧客當場於客顯親簽（開立後不可中止），請先開啟副螢幕客顯視窗並確認顧客在場。',
  tone: 'warning' as const,
};

function newProbeId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `DSP${Date.now().toString(36)}${rand}`;
}

/** 1.5 秒內收到同一 probeId 的客顯 PONG 才算在線 */
export function probeCustomerDisplay(timeoutMs = DISPLAY_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const bus = createPosDisplayBus('host');
    const probeId = newProbeId();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsub();
      bus.close();
      resolve(ok);
    };
    const unsub = bus.subscribe((msg) => {
      if (msg.from === 'host') return;
      if (String(msg.type || '').toUpperCase() !== POS_DISPLAY_TYPES.PONG) return;
      const payload = msg.payload as { probeId?: string } | undefined;
      if (payload?.probeId === probeId) finish(true);
    });
    bus.post(POS_DISPLAY_TYPES.PING, { probeId });
    const timer = window.setTimeout(() => finish(false), timeoutMs);
  });
}
