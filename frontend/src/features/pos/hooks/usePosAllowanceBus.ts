import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { fetchAllowanceSignPreview, submitRefundSignature } from '../../../lib/api';
import { openAllowanceSignChannel, type AllowanceSignChannel } from '../../../lib/allowanceSignChannel';
import { describeRefundError, type RefundErrorInfo } from '../../../lib/refundErrors';
import type { RefundRecord } from '../../../types/api';
import {
  ALLOWANCE_BUS_TYPES,
  MIN_SIGNATURE_PATH_PX,
  MIN_SIGNATURE_POINTS,
  MIN_SIGNATURE_STROKES,
  type AllowanceSignCompleteMsg,
  type AllowanceSignPreview,
} from '../../../types/posDisplayBus';

/** 推送後等客顯 ALLOWANCE_VIEW_ACK（渲染後才回）；逾時視為客顯未開啟 */
export const DISPLAY_ACK_TIMEOUT_MS = 1500;
const MAX_SIGNATURE_BYTES = 512 * 1024;
/** 須重新取預覽才可再簽的後端錯誤 */
const RESTART_CODES = new Set([
  'PREVIEW_EXPIRED',
  'PREVIEW_STALE',
  'PREVIEW_TOKEN_INVALID',
  'SIGNATURE_EXISTS',
  'REFUND_NOT_SIGNABLE',
  'NO_ALLOWANCE',
]);
const BC_SUPPORTED = typeof BroadcastChannel !== 'undefined';

export type AllowanceBusPhase =
  | 'idle'
  | 'preparing'
  | 'waiting_ack'
  | 'no_display'
  | 'viewing'
  | 'uploading'
  | 'finalized'
  | 'cancelled'
  | 'failed';

type Active = { refundId: string; preview: AllowanceSignPreview; acked: boolean; finalized: boolean };

/**
 * 主機端折讓客顯簽署：取後端預覽 → 推 ALLOWANCE_SIGN_REQUEST → 1.5 秒內等 ALLOWANCE_VIEW_ACK →
 * 收 ALLOWANCE_SIGN_COMPLETE（signatureBlob）→ 以呼叫端 refundInFlightRef 同步鎖 multipart 上傳 → 回 ALLOWANCE_SIGN_FINALIZED。
 * refundInFlightRef 須與退費單其他寫入動作共用，確保簽名歸檔與重試／中止等不會同時送出。
 */
export function usePosAllowanceBus({
  refundInFlightRef,
  onFinalized,
}: {
  refundInFlightRef: RefObject<boolean>;
  onFinalized?: (record: RefundRecord, message?: string) => void;
}) {
  const [phase, setPhase] = useState<AllowanceBusPhase>('idle');
  const [preview, setPreview] = useState<AllowanceSignPreview | null>(null);
  const [error, setError] = useState<RefundErrorInfo | null>(null);
  const channelRef = useRef<AllowanceSignChannel | null>(null);
  const activeRef = useRef<Active | null>(null);
  const ackTimerRef = useRef<number | null>(null);
  const prepLockRef = useRef(false);
  const onFinalizedRef = useRef(onFinalized);

  useEffect(() => {
    onFinalizedRef.current = onFinalized;
  }, [onFinalized]);

  const clearAckTimer = useCallback(() => {
    if (ackTimerRef.current != null) window.clearTimeout(ackTimerRef.current);
    ackTimerRef.current = null;
  }, []);

  useEffect(() => {
    const ch = openAllowanceSignChannel('host');
    channelRef.current = ch;

    const finalize = (requestId: string, ok: boolean, extra: { restartRequired?: boolean; message?: string } = {}) =>
      ch.post({ type: ALLOWANCE_BUS_TYPES.SIGN_FINALIZED, from: 'host', requestId, ok, ...extra });

    const handleComplete = async (msg: AllowanceSignCompleteMsg) => {
      const a = activeRef.current;
      if (!a || msg.requestId !== a.preview.requestId) return;
      if (a.finalized) {
        finalize(msg.requestId, true);
        return;
      }
      if (msg.previewToken !== a.preview.previewToken || msg.payloadHash !== a.preview.payloadHash) {
        finalize(msg.requestId, false, { restartRequired: true, message: '簽署資料不符' });
        return;
      }
      if (!Number.isInteger(msg.strokePoints) || msg.strokePoints < MIN_SIGNATURE_POINTS) {
        finalize(msg.requestId, false, { message: '簽名筆跡不足，請清除後重簽' });
        return;
      }
      if (!Number.isInteger(msg.strokeCount) || msg.strokeCount < MIN_SIGNATURE_STROKES || !(msg.pathLength >= MIN_SIGNATURE_PATH_PX)) {
        finalize(msg.requestId, false, { message: '簽名筆跡過短，請清除後重簽' });
        return;
      }
      const blob = msg.signatureBlob;
      if (blob.type !== 'image/png' || !blob.size || blob.size > MAX_SIGNATURE_BYTES) {
        finalize(msg.requestId, false, { message: '簽名影像無效，請清除後重簽' });
        return;
      }
      if (refundInFlightRef.current) {
        finalize(msg.requestId, false, { message: '櫃檯正在處理中，請稍候再送一次' });
        return;
      }
      refundInFlightRef.current = true;
      setPhase('uploading');
      setError(null);
      try {
        const res = await submitRefundSignature(a.refundId, {
          previewToken: a.preview.previewToken,
          requestId: a.preview.requestId,
          payloadHash: a.preview.payloadHash,
          pointCount: msg.strokePoints,
          strokeCount: msg.strokeCount,
          pathLength: msg.pathLength,
          signatureBlob: blob,
        });
        a.finalized = true;
        finalize(msg.requestId, true);
        setPhase('finalized');
        if (res.data) onFinalizedRef.current?.(res.data, res.message);
      } catch (err) {
        const info = describeRefundError(err, '簽名歸檔失敗');
        const restartRequired = Boolean(info.code && RESTART_CODES.has(info.code));
        finalize(msg.requestId, false, {
          restartRequired,
          message: restartRequired ? '簽署資料已失效' : info.title,
        });
        setError(info);
        setPhase('failed');
      } finally {
        refundInFlightRef.current = false;
      }
    };

    const unsub = ch.subscribe((msg) => {
      const a = activeRef.current;
      if (!a || msg.requestId !== a.preview.requestId) return;
      if (msg.type === ALLOWANCE_BUS_TYPES.VIEW_ACK) {
        a.acked = true;
        clearAckTimer();
        setPhase((p) => (p === 'waiting_ack' || p === 'no_display' ? 'viewing' : p));
      } else if (msg.type === ALLOWANCE_BUS_TYPES.SIGN_CANCEL) {
        clearAckTimer();
        activeRef.current = null;
        setPreview(null);
        setPhase('cancelled');
        setError({
          title: '顧客於客顯選擇「有疑問，請櫃檯協助」',
          message: '請向顧客說明折讓內容後，再重新推送客顯簽名。',
          tone: 'warning',
        });
      } else if (msg.type === ALLOWANCE_BUS_TYPES.SIGN_COMPLETE) {
        void handleComplete(msg);
      }
    });

    return () => {
      clearAckTimer();
      const a = activeRef.current;
      if (a && !a.finalized) {
        ch.post({ type: ALLOWANCE_BUS_TYPES.SIGN_CANCEL, from: 'host', requestId: a.preview.requestId, reason: 'HOST_CLOSED' });
      }
      activeRef.current = null;
      unsub();
      ch.close();
      channelRef.current = null;
    };
  }, [clearAckTimer, refundInFlightRef]);

  const push = useCallback(() => {
    const a = activeRef.current;
    const ch = channelRef.current;
    if (!a || !ch) return;
    a.acked = false;
    if (!ch.post({ type: ALLOWANCE_BUS_TYPES.SIGN_REQUEST, from: 'host', requestId: a.preview.requestId, preview: a.preview })) {
      setPhase('no_display');
      return;
    }
    setPhase('waiting_ack');
    clearAckTimer();
    const requestId = a.preview.requestId;
    ackTimerRef.current = window.setTimeout(() => {
      ackTimerRef.current = null;
      const cur = activeRef.current;
      if (cur && cur.preview.requestId === requestId && !cur.acked) setPhase('no_display');
    }, DISPLAY_ACK_TIMEOUT_MS);
  }, [clearAckTimer]);

  /** 取後端預覽（新 requestId／previewToken）並推送客顯 */
  const start = useCallback(
    async (refundId: string) => {
      if (!BC_SUPPORTED) {
        setPhase('failed');
        setError({
          title: '此瀏覽器不支援客顯簽署通道',
          message: '折讓簽名須以 BroadcastChannel 傳送，請以同一瀏覽器（同一設定檔）開啟客顯視窗。',
          tone: 'error',
        });
        return;
      }
      if (prepLockRef.current || refundInFlightRef.current) return;
      prepLockRef.current = true;
      setPhase('preparing');
      setError(null);
      try {
        const res = await fetchAllowanceSignPreview(refundId);
        if (!res.data) throw new Error(res.message || '產生客顯預覽失敗');
        const prev = activeRef.current;
        if (prev && !prev.finalized && prev.preview.requestId !== res.data.requestId) {
          channelRef.current?.post({
            type: ALLOWANCE_BUS_TYPES.SIGN_CANCEL,
            from: 'host',
            requestId: prev.preview.requestId,
            reason: 'SUPERSEDED',
          });
        }
        activeRef.current = { refundId, preview: res.data, acked: false, finalized: false };
        setPreview(res.data);
        push();
      } catch (err) {
        setError(describeRefundError(err, '產生客顯預覽失敗'));
        setPhase('failed');
      } finally {
        prepLockRef.current = false;
      }
    },
    [push, refundInFlightRef],
  );

  /** 客顯未回 ACK 時重推同一預覽；預覽已逾時則重新取號 */
  const resend = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.finalized) return;
    if (Date.parse(a.preview.expiresAt) <= Date.now()) {
      void start(a.refundId);
      return;
    }
    push();
  }, [push, start]);

  /** 主機撤回：客顯關閉簽署畫面 */
  const cancel = useCallback(() => {
    clearAckTimer();
    const a = activeRef.current;
    if (a && !a.finalized) {
      channelRef.current?.post({ type: ALLOWANCE_BUS_TYPES.SIGN_CANCEL, from: 'host', requestId: a.preview.requestId, reason: 'HOST_CANCEL' });
    }
    activeRef.current = null;
    setPreview(null);
    setPhase('idle');
    setError(null);
  }, [clearAckTimer]);

  const clearError = useCallback(() => setError(null), []);

  return {
    phase,
    preview,
    error,
    supported: BC_SUPPORTED,
    /** 推送中／等待中／上傳中 */
    active: phase === 'preparing' || phase === 'waiting_ack' || phase === 'no_display' || phase === 'viewing' || phase === 'uploading',
    start,
    resend,
    cancel,
    clearError,
  };
}
