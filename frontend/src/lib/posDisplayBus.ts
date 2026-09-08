/**
 * 客顯通訊層：BroadcastChannel('pos_display_bus') 為主，
 * localStorage + storage 事件為跨進程／跨視窗備援心跳。
 */
const CHANNEL = 'pos_display_bus';
const STORAGE_KEY = 'gymsaas_pos_display_bus_v1';
const HEARTBEAT_KEY = 'gymsaas_pos_display_hb';

export const POS_DISPLAY_TYPES = {
  IDLE: 'IDLE',
  CART: 'CART',
  CART_UPDATE: 'CART_UPDATE',
  CONSENT: 'CONSENT',
  SIGNATURE_COMPLETED: 'SIGNATURE_COMPLETED',
  PING: 'PING',
  PONG: 'PONG',
  RESET: 'RESET',
} as const;

export type PosDisplayType = (typeof POS_DISPLAY_TYPES)[keyof typeof POS_DISPLAY_TYPES] | string;

export type PosDisplayCartLine = {
  kind?: string;
  name: string;
  qty: number;
  unitPrice?: number;
  lineTotal: number;
  /** 本行附贈運動金（SC） */
  bonusSc?: number;
};

export type PosDisplayCartPayload = {
  lines: PosDisplayCartLine[];
  subtotal?: number;
  bonusTotal?: number;
  payableTotal?: number;
  memberName?: string;
  currency?: string;
};

export type PosDisplayConsentPayload = {
  /** ID_PHOTO_ASSIST | CONTRACT | … */
  purpose: string;
  title: string;
  body: string;
  /** 主螢幕預先產生，簽完回傳同一 ID */
  consentSignatureId: string;
  memberName?: string;
  branchLabel?: string;
};

export type PosDisplaySignaturePayload = {
  purpose: string;
  consentSignatureId: string;
  signatureDataUrl: string;
  signedAt: string;
};

export type PosDisplayMessage = {
  type: PosDisplayType;
  payload?: unknown;
  ts?: number;
  from?: 'host' | 'display' | string;
};

type Handler = (msg: PosDisplayMessage) => void;

function canUseBroadcastChannel() {
  return typeof BroadcastChannel !== 'undefined';
}

function canUseLocalStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function createPosDisplayBus(role: 'host' | 'display' = 'host') {
  const handlers = new Set<Handler>();
  let bc: BroadcastChannel | null = null;
  let closed = false;

  if (canUseBroadcastChannel()) {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (ev) => {
        const data = ev.data as PosDisplayMessage;
        if (!data || typeof data !== 'object') return;
        handlers.forEach((h) => h(data));
      };
    } catch {
      bc = null;
    }
  }

  const onStorage = (ev: StorageEvent) => {
    // 訊息本體 + heartbeat 鍵皆可觸發備援（部分瀏覽器同鍵覆寫不發 storage）
    if (ev.key !== STORAGE_KEY && ev.key !== HEARTBEAT_KEY) return;
    if (ev.key === HEARTBEAT_KEY) {
      // heartbeat 僅喚醒；實際內容仍讀 STORAGE_KEY
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw) as PosDisplayMessage;
        if (!data || typeof data !== 'object') return;
        handlers.forEach((h) => h(data));
      } catch {
        /* ignore */
      }
      return;
    }
    if (!ev.newValue) return;
    try {
      const data = JSON.parse(ev.newValue) as PosDisplayMessage;
      if (!data || typeof data !== 'object') return;
      handlers.forEach((h) => h(data));
    } catch {
      /* ignore */
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  function post(type: string, payload?: unknown) {
    if (closed) return;
    const msg: PosDisplayMessage = {
      type,
      payload,
      ts: Date.now(),
      from: role,
    };
    try {
      bc?.postMessage(msg);
    } catch {
      /* BC 可能已關 */
    }
    if (canUseLocalStorage()) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
        localStorage.setItem(HEARTBEAT_KEY, String(msg.ts));
      } catch {
        /* quota / private mode */
      }
    }
  }

  function subscribe(handler: Handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  let hbTimer: ReturnType<typeof setInterval> | null = null;
  function startHeartbeat(intervalMs = 5000) {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      post(role === 'host' ? POS_DISPLAY_TYPES.PING : POS_DISPLAY_TYPES.PONG, { role });
    }, intervalMs);
  }
  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
  }

  function close() {
    closed = true;
    stopHeartbeat();
    try {
      bc?.close();
    } catch {
      /* ignore */
    }
    bc = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
    handlers.clear();
  }

  return {
    post,
    subscribe,
    startHeartbeat,
    stopHeartbeat,
    close,
    channel: CHANNEL,
    role,
  };
}

/** 計算購物車應付與運動金合計（客顯／主螢幕共用） */
export function summarizePosDisplayCart(cart: PosDisplayCartPayload | null | undefined) {
  const lines = Array.isArray(cart?.lines) ? cart!.lines : [];
  const subtotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
  const bonusTotal = lines.reduce((s, l) => s + (Number(l.bonusSc) || 0), 0);
  const payableTotal =
    cart?.payableTotal != null && Number.isFinite(Number(cart.payableTotal))
      ? Number(cart.payableTotal)
      : subtotal;
  return {
    lines,
    subtotal: cart?.subtotal != null ? Number(cart.subtotal) : subtotal,
    bonusTotal: cart?.bonusTotal != null ? Number(cart.bonusTotal) : bonusTotal,
    payableTotal,
    memberName: cart?.memberName,
  };
}
