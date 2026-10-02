import { POS_DISPLAY_CHANNEL } from './posDisplayBus';
import {
  ALLOWANCE_BUS_VERSION,
  isAllowanceBusMessage,
  type AllowanceBusMessage,
  type AllowanceBusOutgoing,
} from '../types/posDisplayBus';

/**
 * 折讓簽署專用傳輸：只走 BroadcastChannel（結構化複製可直傳 Blob）。
 * 刻意不使用 posDisplayBus 的 localStorage 備援——簽名影像與顧客資料不得落入 Web Storage。
 * 不支援 BroadcastChannel 時 `supported=false`，由呼叫端明示改用同一瀏覽器開啟客顯。
 */
export function openAllowanceSignChannel(role: 'host' | 'display') {
  const handlers = new Set<(msg: AllowanceBusMessage) => void>();
  let bc: BroadcastChannel | null = null;
  try {
    bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(POS_DISPLAY_CHANNEL) : null;
  } catch {
    bc = null;
  }
  if (bc) {
    bc.onmessage = (ev: MessageEvent) => {
      const data: unknown = ev.data;
      if (!isAllowanceBusMessage(data) || data.from === role) return;
      handlers.forEach((h) => h(data));
    };
  }

  return {
    supported: bc != null,
    post(msg: AllowanceBusOutgoing): boolean {
      if (!bc) return false;
      try {
        bc.postMessage({ ...msg, v: ALLOWANCE_BUS_VERSION, ts: Date.now() });
        return true;
      } catch {
        return false;
      }
    },
    subscribe(handler: (msg: AllowanceBusMessage) => void) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      handlers.clear();
      try {
        bc?.close();
      } catch {
        /* ignore */
      }
      bc = null;
    },
  };
}

export type AllowanceSignChannel = ReturnType<typeof openAllowanceSignChannel>;
