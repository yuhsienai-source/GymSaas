import { type FormEvent, type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import GateLayout from '../../components/layout/GateLayout';
import { Alert, Button, Card, EmptyState, Field, Input } from '../../components/ui';
import {
  fetchGateFaceStatus,
  fetchGateSyncTime,
  gateCheckIn,
  gateCheckInFace,
  gateCheckOut,
  gateCheckOutFace,
  getApiErrorDetails,
  getErrorMessage,
  isGatePairAuthError,
  pairGateDevice,
} from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import type { GateFlashResult } from '../../components/layout/GateLayout';
import { startGateQrScanLoop } from '../../lib/gateQrFromVideo';
import { parseGatePairQr } from '../../lib/gatePairQr';
import { formatGateAccessNo } from '../../lib/gateAccessNo';
import {
  clearGatePair,
  getGatePair,
  setGatePair,
  type StoredGatePair,
} from '../../lib/storage';
import type { GateDevice, GateLogEntry } from '../../types/api';

type GateMode = 'check-in' | 'check-out';

/** unpaired=無本機憑證；其餘皆保留憑證，網路錯誤不強制重綁 */
type PairPhase = 'unpaired' | 'restoring' | 'ready' | 'network_error' | 'auth_invalid';

function mockFaceImage(memberId: number) {
  return btoa(`MOCK_FACE_${memberId}`);
}

function streamIsLive(stream: MediaStream | null | undefined) {
  return Boolean(stream?.getVideoTracks().some((t) => t.readyState === 'live'));
}

function deviceFromStored(pair: StoredGatePair): GateDevice | null {
  if (!pair.name && !pair.code && !pair.branchLabel) return null;
  return {
    id: 0,
    code: pair.code || pair.deviceCode,
    name: pair.name || pair.deviceCode,
    branchId: 0,
    branchLabel: pair.branchLabel || undefined,
    isActive: true,
  };
}

function PairingForm({
  pairError,
  pairMode,
  setPairMode,
  pairBusy,
  pairScanPaused,
  setPairScanPaused,
  pairCode,
  setPairCode,
  pairKey,
  setPairKey,
  onSubmit,
  onScan,
  banner,
}: {
  pairError: string | null;
  pairMode: 'scan' | 'manual';
  setPairMode: (m: 'scan' | 'manual') => void;
  pairBusy: boolean;
  pairScanPaused: boolean;
  setPairScanPaused: (v: boolean) => void;
  pairCode: string;
  setPairCode: (v: string) => void;
  pairKey: string;
  setPairKey: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onScan: (raw: string) => void;
  banner?: ReactNode;
}) {
  return (
    <Card variant="dark" title="閘機裝置配對" padding="md">
      <p className="text-sm text-muted" style={{ marginTop: 0 }}>
        請掃描總部「進出場裝置」建立／輪替時顯示的<strong>配對 QR</strong>
        ，無需手打長金鑰。配對後本機自動綁定分店，重開瀏覽器會自動還原。
      </p>
      {banner}
      {pairError ? <Alert tone="error">{pairError}</Alert> : null}

      <div className="gate-method" role="tablist" aria-label="配對方式">
        <button
          type="button"
          role="tab"
          aria-selected={pairMode === 'scan'}
          className={`gate-method__btn ${pairMode === 'scan' ? 'is-active' : ''}`}
          onClick={() => {
            setPairMode('scan');
            setPairScanPaused(false);
          }}
        >
          掃碼配對
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pairMode === 'manual'}
          className={`gate-method__btn ${pairMode === 'manual' ? 'is-active' : ''}`}
          onClick={() => setPairMode('manual')}
        >
          手動輸入
        </button>
      </div>

      {pairMode === 'scan' ? (
        <div className="form-stack">
          <div className="scanner-wrap scanner-wrap--compact">
            <Scanner
              onScan={(result) => {
                if (result[0]?.rawValue) onScan(result[0].rawValue);
              }}
              formats={['qr_code']}
              paused={pairBusy || pairScanPaused}
              components={{ finder: true, torch: false, zoom: false }}
            />
            {pairBusy ? <div className="scanner-overlay">配對中…</div> : null}
          </div>
          <p className="text-sm text-muted text-center" style={{ margin: 0 }}>
            對準總部螢幕上的配對 QR
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="form-stack">
          <Field label="裝置代碼">
            <Input
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              placeholder="HP-IN-01"
              required
              autoComplete="off"
            />
          </Field>
          <Field label="裝置金鑰">
            <Input
              value={pairKey}
              onChange={(e) => setPairKey(e.target.value)}
              placeholder="建立時複製的金鑰"
              required
              autoComplete="off"
            />
          </Field>
          <Button type="submit" loading={pairBusy}>
            確認配對
          </Button>
        </form>
      )}
    </Card>
  );
}

export default function GateScannerPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<GateMode>('check-in');
  const [logs, setLogs] = useState<GateLogEntry[]>([]);
  const [isScanning, setIsScanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<GateFlashResult | null>(null);
  const [pair, setPair] = useState<StoredGatePair | null>(() => getGatePair());
  const [pairPhase, setPairPhase] = useState<PairPhase>(() =>
    getGatePair() ? 'restoring' : 'unpaired',
  );
  const [deviceInfo, setDeviceInfo] = useState<GateDevice | null>(() => {
    const stored = getGatePair();
    return stored ? deviceFromStored(stored) : null;
  });
  const [pairCode, setPairCode] = useState('');
  const [pairKey, setPairKey] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairMode, setPairMode] = useState<'scan' | 'manual'>('scan');
  const [pairScanPaused, setPairScanPaused] = useState(false);
  const [mockMode, setMockMode] = useState(false);
  const [mockMemberId, setMockMemberId] = useState('1');
  const [camError, setCamError] = useState<string | null>(null);
  const [faceReady, setFaceReady] = useState(false);
  const [cameraEpoch, setCameraEpoch] = useState(0);
  const [pairRetryToken, setPairRetryToken] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isScanningRef = useRef(isScanning);
  const busyRef = useRef(busy);
  isScanningRef.current = isScanning;
  busyRef.current = busy;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const persistPair = useCallback(
    (next: StoredGatePair | null, info?: GateDevice | null) => {
      if (!next) {
        stopCamera();
        setFaceReady(false);
        setCamError(null);
        clearGatePair();
        setPair(null);
        setDeviceInfo(null);
        setPairPhase('unpaired');
        setPairError(null);
        return;
      }
      const enriched: StoredGatePair = {
        deviceCode: next.deviceCode.trim().toUpperCase(),
        deviceKey: next.deviceKey.trim(),
        name: info?.name ?? next.name ?? null,
        code: info?.code ?? next.code ?? next.deviceCode,
        branchLabel: info?.branchLabel ?? next.branchLabel ?? null,
      };
      setGatePair(enriched);
      setPair(enriched);
      if (info) setDeviceInfo(info);
    },
    [stopCamera],
  );

  const retryPairVerify = useCallback(() => {
    setPairPhase('restoring');
    setPairRetryToken((n) => n + 1);
  }, []);

  const savePairInfo = useEffectEvent((info: GateDevice) => {
    if (pair) persistPair(pair, info);
  });

  const pairDeviceCode = pair?.deviceCode;
  const pairDeviceKey = pair?.deviceKey;

  // 還原／驗證本機配對：網路失敗保留憑證並自動重試；僅金鑰失效才要求重綁
  // 解除配對一律經 persistPair(null)，該處已重設 phase／deviceInfo
  useEffect(() => {
    if (!pairDeviceCode || !pairDeviceKey) return;
    let cancelled = false;
    let retryTimer: number | undefined;

    void (async () => {
      try {
        const res = await pairGateDevice(pairDeviceCode, pairDeviceKey);
        if (cancelled) return;
        if (res.status !== 'success' || !res.data) {
          throw new Error(res.message || '裝置配對失敗');
        }
        const info = res.data as GateDevice;
        savePairInfo(info);
        setDeviceInfo(info);
        setPairError(null);
        setPairPhase('ready');
      } catch (err) {
        if (cancelled) return;
        const msg = getErrorMessage(err, '裝置配對驗證失敗');
        setPairError(msg);
        setFaceReady(false);
        setCamError(null);
        if (isGatePairAuthError(err)) {
          setPairPhase('auth_invalid');
          return;
        }
        setPairPhase('network_error');
        retryTimer = window.setTimeout(() => {
          if (!cancelled) retryPairVerify();
        }, 4000);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [pairDeviceCode, pairDeviceKey, pairRetryToken, retryPairVerify]);

  useEffect(() => {
    if (pairPhase !== 'ready' || !pair) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchGateFaceStatus();
        if (cancelled) return;
        setMockMode(Boolean(res.data?.mockMode));
      } catch {
        if (!cancelled) setMockMode(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair, pairPhase]);

  const logClockIssue = useEffectEvent((msg: string) => addLog(msg, true));

  // 時鐘校準：每 5 分鐘對齊伺服器時間（本機 skew 供診斷；驗票仍以後端為準）
  useEffect(() => {
    if (pairPhase !== 'ready') return;
    let cancelled = false;
    const sync = async () => {
      try {
        const res = await fetchGateSyncTime();
        if (cancelled) return;
        const skew = Math.abs(res.offsetMs || 0);
        if (skew > 5000) {
          logClockIssue(`🟠 本機時鐘偏差約 ${Math.round(skew / 1000)} 秒，已與伺服器校準`);
        }
      } catch {
        if (!cancelled) logClockIssue('🟠 網路通訊重試中：時間校準失敗');
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pairPhase]);

  /** 優先前鏡頭（刷臉）；失敗再退後鏡頭／任意鏡頭（仍同路解 QR） */
  const openGateStream = useCallback(async (): Promise<MediaStream> => {
    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      { video: { facingMode: 'user' } },
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      { video: true },
    ];
    let lastErr: unknown;
    for (let round = 0; round < 3; round += 1) {
      for (const constraints of attempts) {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          lastErr = err;
        }
      }
      await new Promise((r) => window.setTimeout(r, 280 * (round + 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error('getUserMedia failed');
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    // 離開 ready 的路徑（persistPair(null)、驗證失敗）已重設 faceReady／camError
    if (pairPhase !== 'ready' || !pair || !deviceInfo) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let video: HTMLVideoElement | null = null;
    const markReady = () => {
      if (!cancelled && video && video.videoWidth > 0) setFaceReady(true);
    };

    void (async () => {
      setCamError(null);
      if (!streamIsLive(streamRef.current)) setFaceReady(false);
      try {
        for (let i = 0; i < 20 && !videoRef.current; i += 1) {
          await new Promise((r) => window.setTimeout(r, 50));
          if (cancelled) return;
        }
        video = videoRef.current;
        if (!video) {
          if (!cancelled) setCamError('鏡頭元件未就緒，請按「重試鏡頭」');
          return;
        }

        let stream = streamRef.current;
        if (!streamIsLive(stream)) {
          stream = await openGateStream();
          if (cancelled) {
            if (!streamIsLive(streamRef.current)) streamRef.current = stream;
            else stream.getTracks().forEach((t) => t.stop());
            return;
          }
          if (streamIsLive(streamRef.current) && streamRef.current !== stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = streamRef.current;
          } else {
            streamRef.current = stream;
          }
        }

        video = videoRef.current;
        if (!video || !stream) return;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        if (video.srcObject !== stream) video.srcObject = stream;
        video.addEventListener('loadedmetadata', markReady);
        video.addEventListener('playing', markReady);
        try {
          await video.play();
        } catch {
          /* ignore */
        }
        if (!cancelled && video.videoWidth > 0) setFaceReady(true);
        else if (!cancelled) {
          window.setTimeout(markReady, 300);
          window.setTimeout(markReady, 900);
        }
      } catch {
        if (!cancelled) {
          setFaceReady(false);
          setCamError('無法開啟鏡頭：請允許相機權限後按「重試鏡頭」');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (video) {
        video.removeEventListener('loadedmetadata', markReady);
        video.removeEventListener('playing', markReady);
      }
    };
  }, [pair, pairPhase, deviceInfo, cameraEpoch, stopCamera, openGateStream]);

  async function handlePairSubmit(e: FormEvent) {
    e.preventDefault();
    await applyPairCredentials(pairCode.trim(), pairKey.trim());
  }

  async function applyPairCredentials(deviceCode: string, deviceKey: string) {
    setPairBusy(true);
    setPairError(null);
    setPairScanPaused(true);
    try {
      const res = await pairGateDevice(deviceCode, deviceKey);
      if (res.status !== 'success' || !res.data) {
        throw new Error(res.message || '配對失敗');
      }
      const info = res.data as GateDevice;
      persistPair(
        {
          deviceCode: deviceCode.trim().toUpperCase(),
          deviceKey: deviceKey.trim(),
        },
        info,
      );
      setDeviceInfo(info);
      setPairPhase('ready');
      setPairCode('');
      setPairKey('');
    } catch (err) {
      setPairError(getErrorMessage(err, '配對失敗'));
      setPairScanPaused(false);
    } finally {
      setPairBusy(false);
    }
  }

  async function handlePairQrScan(raw: string) {
    if (pairBusy || pairScanPaused) return;
    const parsed = parseGatePairQr(raw);
    if (!parsed) {
      setPairError('不是有效的閘機配對 QR，請掃描總部「進出場裝置」顯示的碼');
      return;
    }
    await applyPairCredentials(parsed.deviceCode, parsed.deviceKey);
  }

  function addLog(msg: string, isError = false) {
    const time = new Date().toLocaleTimeString('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    setLogs((prev) => [{ time, msg, isError }, ...prev].slice(0, 10));
  }

  function cooldown(ms = 2800) {
    window.setTimeout(() => {
      setIsScanning(true);
      setBusy(false);
      setLastResult(null);
    }, ms);
  }

  function applyGateResult(result: {
    status?: string;
    message?: string;
    memberName?: unknown;
    gateLogId?: unknown;
    gateAccessNo?: unknown;
    checkInAt?: unknown;
    feeDetails?: unknown;
    gateOpen?: unknown;
  }) {
    if (result.status !== 'success') return;
    const name = result.memberName as string;
    const accessNo =
      (result.gateAccessNo != null && String(result.gateAccessNo)) ||
      formatGateAccessNo(
        result.checkInAt != null ? String(result.checkInAt) : null,
        result.gateLogId != null ? String(result.gateLogId) : null,
      );
    const idTag = accessNo && accessNo !== '—' ? ` · 單號 ${accessNo}` : '';
    const gateOpen = result.gateOpen !== false;
    let msg: string;
    if (mode === 'check-in') {
      msg = `歡迎 ${name} 進場${idTag}`;
      addLog(`🟢 ${result.message}（${name}${idTag}）`);
      setLastResult({ ok: true, message: msg });
      toast(msg, 'success');
      return;
    }
    const fee = result.feeDetails as
      | { totalFee?: number; shortfall?: number }
      | undefined;
    if (!gateOpen || (fee?.shortfall != null && fee.shortfall > 0)) {
      msg = `${name} 餘額不足${fee?.shortfall ? ` $${fee.shortfall}` : ''}，尚未出場 · 請儲值後再刷出${idTag}`;
      addLog(`🟠 ${result.message || msg}（${name}${idTag}）`, true);
      setLastResult({ ok: false, message: msg, renewable: true });
      toast(msg, 'error');
      return;
    }
    msg =
      fee?.totalFee != null
        ? `${name} 出場 · $${fee.totalFee}${idTag}`
        : `${name} 出場成功${idTag}`;
    addLog(`🟢 ${result.message}（${name}${idTag}）`);
    setLastResult({ ok: true, message: msg });
    toast(msg, 'success');
  }

  function applyGateError(err: unknown, fallback: string) {
    const details = getApiErrorDetails(err);
    const isTimeout =
      (typeof err === 'object' &&
        err &&
        'code' in err &&
        (err as { code?: string }).code === 'ECONNABORTED') ||
      /timeout/i.test(String(details.message || fallback));
    const isNetwork =
      isTimeout ||
      (typeof err === 'object' &&
        err &&
        'message' in err &&
        /network/i.test(String((err as { message?: string }).message)));
    const msg = isNetwork
      ? '網路通訊重試中：請確認外網後再刷一次（閘機配對仍保留）'
      : details.message || getErrorMessage(err, fallback);
    const renewable =
      details.code === 'EXPIRED_BALANCE' || details.code === 'BALANCE_INSUFFICIENT';
    const noCheckIn = details.code === 'NO_ACTIVE_CHECKIN';
    const contractRequired =
      details.code === 'CONTRACT_REQUIRED' || details.code === 'CONTRACT_UNSIGNED';
    addLog(`🔴 ${msg}`, true);
    setLastResult({
      ok: false,
      message: noCheckIn
        ? `異常滯留：${msg}`
        : contractRequired
          ? `契約未簽：${msg}`
          : msg,
      memberId: details.memberId,
      code: details.code,
      renewable: Boolean(renewable && details.memberId),
    });
    toast(msg, 'error', {
      action:
        renewable && details.memberId
          ? {
              label: '續約／儲值',
              onClick: () => {
                window.location.assign(
                  `/staff/ops?tab=checkout&memberId=${details.memberId}`,
                );
              },
            }
          : noCheckIn && details.memberId
            ? {
                label: '櫃檯進場列表',
                onClick: () => {
                  window.location.assign(
                    `/staff/ops?tab=checkins&memberId=${details.memberId}`,
                  );
                },
              }
            : undefined,
    });
  }

  async function handleScan(scannedText: string) {
    if (!isScanningRef.current || busyRef.current) return;
    if (parseGatePairQr(scannedText)) return;
    setIsScanning(false);
    setBusy(true);
    setLastResult(null);
    try {
      if (!pair) throw new Error('請先配對閘機裝置');
      const auth = { deviceCode: pair.deviceCode, deviceKey: pair.deviceKey };
      const result =
        mode === 'check-in'
          ? await gateCheckIn(scannedText, auth)
          : await gateCheckOut(scannedText, auth);
      applyGateResult(result);
    } catch (err) {
      applyGateError(err, '掃描連線失敗');
    }
    cooldown();
  }

  const handleScanRef = useRef(handleScan);
  handleScanRef.current = handleScan;

  /** 同一路鏡頭連續解 QR，不必再開第二路相機 */
  useEffect(() => {
    if (pairPhase !== 'ready' || !pair || !deviceInfo || !faceReady) return;
    const video = videoRef.current;
    if (!video) return;
    return startGateQrScanLoop({
      video,
      enabled: () => isScanningRef.current && !busyRef.current,
      onCode: (raw) => {
        void handleScanRef.current(raw);
      },
    });
  }, [pair, pairPhase, deviceInfo, faceReady, cameraEpoch]);

  async function submitFace(faceImage: string) {
    if (busy || !pair) return;
    setBusy(true);
    setIsScanning(false);
    setLastResult(null);
    try {
      const auth = { deviceCode: pair.deviceCode, deviceKey: pair.deviceKey };
      const result =
        mode === 'check-in'
          ? await gateCheckInFace(faceImage, auth)
          : await gateCheckOutFace(faceImage, auth);
      applyGateResult(result);
    } catch (err) {
      applyGateError(err, '人臉辨識失敗');
    }
    cooldown();
  }

  async function captureAndSubmitFace() {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video.videoWidth) {
      const ok = await new Promise<boolean>((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (video.videoWidth > 0) {
            resolve(true);
            return;
          }
          if (Date.now() - start > 1200) {
            resolve(false);
            return;
          }
          window.requestAnimationFrame(tick);
        };
        tick();
      });
      if (!ok) {
        setLastResult({ ok: false, message: '鏡頭尚未就緒，請等畫面出現後再拍' });
        return;
      }
      setFaceReady(true);
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const faceImage = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    await submitFace(faceImage);
  }

  async function submitMockFace() {
    const id = Number(mockMemberId);
    if (!Number.isInteger(id) || id <= 0) {
      setLastResult({ ok: false, message: '請輸入有效會員 ID（僅 Mock）' });
      return;
    }
    await submitFace(mockFaceImage(id));
  }

  const pairingFormProps = {
    pairError,
    pairMode,
    setPairMode,
    pairBusy,
    pairScanPaused,
    setPairScanPaused,
    pairCode,
    setPairCode,
    pairKey,
    setPairKey,
    onSubmit: handlePairSubmit,
    onScan: (raw: string) => void handlePairQrScan(raw),
  };

  if (pairPhase === 'unpaired') {
    return (
      <GateLayout mode={mode} onModeChange={setMode} lastResult={null}>
        <PairingForm {...pairingFormProps} />
      </GateLayout>
    );
  }

  if (pairPhase === 'restoring' || pairPhase === 'network_error') {
    const label = deviceInfo?.name || pair?.deviceCode || '閘機裝置';
    return (
      <GateLayout mode={mode} onModeChange={setMode} lastResult={null}>
        <Card variant="dark" title="還原閘機配對" padding="md">
          <p className="text-sm" style={{ marginTop: 0 }}>
            本機已記住 <strong>{label}</strong>
            {deviceInfo?.branchLabel ? `（${deviceInfo.branchLabel}）` : ''}
            ，無需重新掃描配對 QR。
          </p>
          {pairPhase === 'restoring' ? (
            <Alert tone="info">正在向伺服器驗證裝置…</Alert>
          ) : (
            <Alert tone="error">
              {pairError || '暫時無法連線驗證裝置'}
              <div className="btn-row" style={{ marginTop: '0.75rem' }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setPairError(null);
                    retryPairVerify();
                  }}
                >
                  立即重試
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('清除本機配對並重新掃描？')) persistPair(null);
                  }}
                >
                  清除並重綁
                </Button>
              </div>
            </Alert>
          )}
        </Card>
      </GateLayout>
    );
  }

  if (pairPhase === 'auth_invalid') {
    return (
      <GateLayout mode={mode} onModeChange={setMode} lastResult={null}>
        <PairingForm
          {...pairingFormProps}
          banner={
            <Alert tone="error">
              本機憑證已失效（金鑰錯誤或裝置停用）。請向總部重新取得配對 QR，或
              <Button
                size="sm"
                variant="ghost"
                className="mt-sm"
                onClick={() => {
                  if (window.confirm('清除本機舊憑證？')) persistPair(null);
                }}
              >
                清除舊配對
              </Button>
            </Alert>
          }
        />
      </GateLayout>
    );
  }

  return (
      <GateLayout mode={mode} onModeChange={setMode} lastResult={lastResult} modeLocked={busy}>
      <Card variant="dark" padding="md">
        <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{deviceInfo?.name || pair?.deviceCode}</strong>
            <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
              {deviceInfo?.code || pair?.deviceCode}
              {deviceInfo?.branchLabel ? ` · ${deviceInfo.branchLabel}` : ''}
              {mockMode ? ' · Face Mock' : ''}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm('解除本機裝置配對？')) persistPair(null);
            }}
          >
            解除配對
          </Button>
        </div>
      </Card>

      <Card variant="dark" padding="md" className="gate-stage-card">
        {camError ? <Alert tone="error">{camError}</Alert> : null}

        <div className="gate-stage" aria-label="閘機鏡頭（刷臉與掃 QR）">
          <video ref={videoRef} autoPlay playsInline muted className="gate-stage__face" />
          <canvas ref={canvasRef} hidden />
          <div className="gate-stage__face-hint">
            {mockMode ? 'Mock：請用下方模擬刷臉' : '刷臉或掃進出場門禁碼 · 同一鏡頭'}
          </div>
          <div className="gate-stage__qr-frame" aria-hidden />
          {(busy || !isScanning) && !camError ? (
            <div className="gate-stage__qr-overlay">驗證中…</div>
          ) : null}
          <div className="gate-stage__actions gate-stage__actions--full">
            <Button
              onClick={() => void captureAndSubmitFace()}
              loading={busy}
              disabled={!!camError || !faceReady || mockMode}
              title={mockMode ? 'Mock 模式不接受真實相機影像' : undefined}
            >
              {mockMode
                ? '實拍已停用（Mock）'
                : !faceReady && !camError
                  ? '鏡頭啟動中…'
                  : mode === 'check-in'
                    ? '拍攝並進場'
                    : '拍攝並出場'}
            </Button>
            {camError ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  stopCamera();
                  setCamError(null);
                  setFaceReady(false);
                  setCameraEpoch((n) => n + 1);
                }}
              >
                重試鏡頭
              </Button>
            ) : null}
          </div>
        </div>

        <p className="text-sm text-muted text-center" style={{ margin: '0.75rem 0 0' }}>
          只開一路相機：畫面中出現會員「進出場門禁碼」會自動通行（進場／出場依上方模式）；刷臉請按下方拍攝。
        </p>

        {mockMode ? (
          <div className="form-stack" style={{ marginTop: '0.85rem' }}>
            <Alert tone="warning">
              <strong>PAPAGO Mock</strong>
              ：目前 <code>PAPAGO_MOCK_MODE=true</code>，真實相機照片不會辨識。請輸入已綁臉會員
              ID 按「模擬刷臉」（須已臨櫃註冊人臉＋簽生物辨識同意書）。要測實拍請關 Mock 並接
              Face8。
            </Alert>
            <Field label="Mock 會員 ID">
              <div className="bind-row">
                <Input
                  value={mockMemberId}
                  onChange={(e) => setMockMemberId(e.target.value)}
                  inputMode="numeric"
                  placeholder="1"
                />
                <Button variant="secondary" loading={busy} onClick={() => void submitMockFace()}>
                  模擬刷臉
                </Button>
              </div>
            </Field>
          </div>
        ) : null}
      </Card>

      <Card variant="dark" title="閘機日誌" padding="md">
        {logs.length === 0 ? (
          <EmptyState icon="📷" title="等待通行" desc="對準臉部拍攝，或將會員進出場門禁碼對準畫面" />
        ) : (
          <ul className="gate-log-list">
            {logs.map((log, i) => (
              <li key={i} className={log.isError ? 'is-err' : 'is-ok'}>
                <span className="gate-log-list__time">{log.time}</span>
                {log.msg}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </GateLayout>
  );
}
