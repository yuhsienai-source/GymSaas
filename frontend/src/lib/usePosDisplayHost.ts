import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPosDisplayBus,
  POS_DISPLAY_HEARTBEAT_MS,
  POS_DISPLAY_LINK_TIMEOUT_MS,
  POS_DISPLAY_TYPES,
  type PosDisplayCartPayload,
  type PosDisplayConsentPayload,
  type PosDisplayMessage,
  type PosDisplaySignatureAckPayload,
  type PosDisplaySignaturePayload,
} from './posDisplayBus';

export type PosDisplayHostApi = {
  /** 近期有收到客顯心跳／訊息 */
  displayLinked: boolean;
  pendingConsentId: string | null;
  lastSignature: PosDisplaySignaturePayload | null;
  openDisplayWindow: () => void;
  postCart: (payload: PosDisplayCartPayload) => void;
  postIdle: () => void;
  requestConsent: (
    payload: Omit<PosDisplayConsentPayload, 'consentSignatureId'> & {
      consentSignatureId?: string;
    },
  ) => string;
  clearSignature: () => void;
  clearPendingConsent: () => void;
};

/**
 * Ops 主螢幕客顯 host：單一 bus、鏡像 CART、派發 CONSENT、收 SIGNATURE_COMPLETED 並回 ACK。
 * displayLinked 依心跳逾時自動降級，避免假陽性「已連線」。
 */
export function usePosDisplayHost(): PosDisplayHostApi {
  const busRef = useRef<ReturnType<typeof createPosDisplayBus> | null>(null);
  const lastPeerAtRef = useRef(0);
  const [displayLinked, setDisplayLinked] = useState(false);
  const [pendingConsentId, setPendingConsentId] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<PosDisplaySignaturePayload | null>(null);

  const touchPeer = useCallback(() => {
    lastPeerAtRef.current = Date.now();
    setDisplayLinked(true);
  }, []);

  useEffect(() => {
    const bus = createPosDisplayBus('host');
    busRef.current = bus;
    bus.startHeartbeat(POS_DISPLAY_HEARTBEAT_MS);

    const unsub = bus.subscribe((msg: PosDisplayMessage) => {
      if (msg.from === 'host') return;
      const type = String(msg.type || '').toUpperCase();

      if (type === POS_DISPLAY_TYPES.PONG || type === POS_DISPLAY_TYPES.PING) {
        touchPeer();
        return;
      }

      // 任何客顯業務訊息也算活著
      if (
        type === POS_DISPLAY_TYPES.SIGNATURE_COMPLETED ||
        type === POS_DISPLAY_TYPES.CART ||
        type === POS_DISPLAY_TYPES.CART_UPDATE
      ) {
        touchPeer();
      }

      if (type !== POS_DISPLAY_TYPES.SIGNATURE_COMPLETED) return;

      const payload = (msg.payload || {}) as PosDisplaySignaturePayload;
      if (!payload?.consentSignatureId || !payload?.signatureDataUrl) return;

      setLastSignature(payload);
      setPendingConsentId((cur) =>
        cur && cur === payload.consentSignatureId ? null : cur,
      );

      const ack: PosDisplaySignatureAckPayload = {
        consentSignatureId: payload.consentSignatureId,
        ok: true,
      };
      bus.post(POS_DISPLAY_TYPES.SIGNATURE_ACK, ack);
    });

    const watch = window.setInterval(() => {
      const last = lastPeerAtRef.current;
      if (!last) {
        setDisplayLinked(false);
        return;
      }
      setDisplayLinked(Date.now() - last <= POS_DISPLAY_LINK_TIMEOUT_MS);
    }, 1000);

    return () => {
      window.clearInterval(watch);
      unsub();
      bus.close();
      busRef.current = null;
    };
  }, [touchPeer]);

  const openDisplayWindow = useCallback(() => {
    window.open('/staff/customer-display', 'gymsaas_customer_display', 'noopener,noreferrer');
    // 開窗後立刻 ping，加速連線指示
    busRef.current?.post(POS_DISPLAY_TYPES.PING, { role: 'host', wake: true });
  }, []);

  const postCart = useCallback((payload: PosDisplayCartPayload) => {
    busRef.current?.post(POS_DISPLAY_TYPES.CART_UPDATE, payload);
  }, []);

  const postIdle = useCallback(() => {
    busRef.current?.post(POS_DISPLAY_TYPES.IDLE);
  }, []);

  const requestConsent = useCallback(
    (
      payload: Omit<PosDisplayConsentPayload, 'consentSignatureId'> & {
        consentSignatureId?: string;
      },
    ) => {
      const consentSignatureId =
        payload.consentSignatureId?.trim() ||
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `consent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
      setPendingConsentId(consentSignatureId);
      setLastSignature(null);
      busRef.current?.post(POS_DISPLAY_TYPES.CONSENT, {
        ...payload,
        consentSignatureId,
      } satisfies PosDisplayConsentPayload);
      return consentSignatureId;
    },
    [],
  );

  const clearSignature = useCallback(() => setLastSignature(null), []);
  const clearPendingConsent = useCallback(() => setPendingConsentId(null), []);

  return {
    displayLinked,
    pendingConsentId,
    lastSignature,
    openDisplayWindow,
    postCart,
    postIdle,
    requestConsent,
    clearSignature,
    clearPendingConsent,
  };
}
