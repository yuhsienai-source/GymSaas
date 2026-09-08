import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPosDisplayBus,
  POS_DISPLAY_TYPES,
  type PosDisplayCartPayload,
  type PosDisplayConsentPayload,
  type PosDisplayMessage,
  type PosDisplaySignaturePayload,
} from './posDisplayBus';

export type PosDisplayHostApi = {
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
 * Ops 主螢幕客顯 host：單一 bus、鏡像 CART、派發 CONSENT、收 SIGNATURE_COMPLETED。
 */
export function usePosDisplayHost(): PosDisplayHostApi {
  const busRef = useRef<ReturnType<typeof createPosDisplayBus> | null>(null);
  const [displayLinked, setDisplayLinked] = useState(false);
  const [pendingConsentId, setPendingConsentId] = useState<string | null>(null);
  const [lastSignature, setLastSignature] = useState<PosDisplaySignaturePayload | null>(null);

  useEffect(() => {
    const bus = createPosDisplayBus('host');
    busRef.current = bus;
    bus.startHeartbeat(5000);

    const unsub = bus.subscribe((msg: PosDisplayMessage) => {
      if (msg.from === 'host') return;
      const type = String(msg.type || '').toUpperCase();

      if (type === POS_DISPLAY_TYPES.PONG || type === POS_DISPLAY_TYPES.PING) {
        setDisplayLinked(true);
        return;
      }
      if (type !== POS_DISPLAY_TYPES.SIGNATURE_COMPLETED) return;

      const payload = (msg.payload || {}) as PosDisplaySignaturePayload;
      if (!payload?.consentSignatureId || !payload?.signatureDataUrl) return;
      setLastSignature(payload);
      setPendingConsentId((cur) =>
        cur && cur === payload.consentSignatureId ? null : cur,
      );
      setDisplayLinked(true);
    });

    return () => {
      unsub();
      bus.close();
      busRef.current = null;
    };
  }, []);

  const openDisplayWindow = useCallback(() => {
    window.open('/staff/customer-display', 'gymsaas_customer_display', 'noopener,noreferrer');
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
