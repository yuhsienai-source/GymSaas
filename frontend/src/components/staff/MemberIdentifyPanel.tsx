import { useCallback, useEffect, useRef, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { Alert, Button, Field, Input, Modal } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  getErrorMessage,
  identifyOpsMember,
  lookupOpsMemberByPhone,
} from '../../lib/api';
import type { OpsMember } from '../../types/api';

type IdentifyMode = 'phone' | 'qr' | 'face';

interface MemberIdentifyPanelProps {
  selectedMember: OpsMember | null;
  onSelect: (member: OpsMember | null) => void;
  label?: string;
  hint?: string;
  /** 預設 ops（櫃檯）；私教頁傳 pt；教練工作區傳 trainer */
  scope?: 'ops' | 'pt' | 'trainer';
  /** 教練代約等場景可關閉人臉 */
  allowFace?: boolean;
}

function memberLabel(m: OpsMember) {
  return `${m.memberNo || `#${m.id}`} ${m.name} · ${m.phone}`;
}

export default function MemberIdentifyPanel({
  selectedMember,
  onSelect,
  label = '會員',
  hint,
  scope = 'ops',
  allowFace = true,
}: MemberIdentifyPanelProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<IdentifyMode>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [candidates, setCandidates] = useState<OpsMember[]>([]);
  const [qrTokenInput, setQrTokenInput] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrScanning, setQrScanning] = useState(true);
  const [faceOpen, setFaceOpen] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const effectiveMode = !allowFace && mode === 'face' ? 'phone' : mode;

  const applyMember = useCallback(
    (member: OpsMember | null, message?: string) => {
      onSelect(member);
      setCandidates([]);
      if (member && message) toast(message, 'success');
    },
    [onSelect, toast],
  );

  async function handlePhoneLookup() {
    const phone = phoneInput.trim();
    if (phone.length < 4) {
      toast('請至少輸入 4 碼電話', 'error');
      return;
    }
    setPhoneBusy(true);
    setCandidates([]);
    try {
      const result = await lookupOpsMemberByPhone(phone, scope);
      if (result.status !== 'success' || !result.data) {
        toast(result.message || '查無會員', 'error');
        return;
      }
      const { member, candidates: list } = result.data;
      if (member) {
        applyMember(member, result.message || `已選取 ${member.name}`);
        return;
      }
      if (list.length > 0) {
        setCandidates(list);
        toast(result.message || '請從候選名單選擇', 'info');
      }
    } catch (err) {
      toast(getErrorMessage(err, '電話查詢失敗'), 'error');
    } finally {
      setPhoneBusy(false);
    }
  }

  async function handleQrIdentify(token: string) {
    const qrToken = token.trim();
    if (!qrToken) return;
    setQrBusy(true);
    setQrScanning(false);
    try {
      const result = await identifyOpsMember({ method: 'QR', qrToken }, scope);
      if (result.status === 'success' && result.data?.member) {
        applyMember(result.data.member, result.message || 'QR 辨識成功');
        setQrTokenInput('');
      } else {
        toast(result.message || 'QR 辨識失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, 'QR 辨識失敗'), 'error');
    } finally {
      setQrBusy(false);
      window.setTimeout(() => setQrScanning(true), 1500);
    }
  }

  const openFaceModal = useCallback(async () => {
    setFaceOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      toast('無法開啟鏡頭，請確認 HTTPS 權限', 'error');
      setFaceOpen(false);
    }
  }, [toast]);

  const closeFaceModal = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setFaceOpen(false);
  }, []);

  async function captureAndIdentify() {
    if (!videoRef.current || !canvasRef.current) return;
    setFaceBusy(true);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const faceImage = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

    try {
      const result = await identifyOpsMember({ method: 'FACE', faceImage }, scope);
      if (result.status === 'success' && result.data?.member) {
        applyMember(result.data.member, result.message || '人臉辨識成功');
        closeFaceModal();
      } else {
        toast(result.message || '人臉辨識失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, '人臉辨識失敗'), 'error');
    } finally {
      setFaceBusy(false);
    }
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="member-identify">
      <Field label={label} hint={hint}>
        {selectedMember ? (
          <div className="member-identify__selected">
            <div>
              <strong>{memberLabel(selectedMember)}</strong>
              <div className="text-muted text-sm">
                零錢包 ${selectedMember.cashWallet} · 運動金 ${selectedMember.bonusWallet}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => applyMember(null)}>
              清除
            </Button>
          </div>
        ) : (
          <p className="text-muted text-sm">尚未選擇會員</p>
        )}
      </Field>

      <div className="identify-segment" role="tablist" aria-label="會員辨識方式">
        {(
          allowFace
            ? ([
                { key: 'phone' as const, label: '📞 電話' },
                { key: 'qr' as const, label: '📷 QR' },
                { key: 'face' as const, label: '🙂 人臉' },
              ])
            : ([
                { key: 'phone' as const, label: '📞 電話' },
                { key: 'qr' as const, label: '📷 QR' },
              ])
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={effectiveMode === tab.key}
            className={`identify-segment__btn ${effectiveMode === tab.key ? 'is-active' : ''}`}
            onClick={() => setMode(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {effectiveMode === 'phone' && (
        <div className="form-stack">
          <Field label="手機號碼" hint="支援完整門號或後幾碼查詢">
            <div className="bind-row">
              <Input
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                inputMode="tel"
                placeholder="0912345678"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handlePhoneLookup();
                }}
              />
              <Button onClick={handlePhoneLookup} loading={phoneBusy}>
                查詢
              </Button>
            </div>
          </Field>
          {candidates.length > 0 && (
            <div className="candidate-list">
              <p className="text-sm text-muted">找到多筆，請點選正確會員：</p>
              {candidates.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="candidate-list__item"
                  onClick={() => applyMember(m, `已選取 ${m.name}`)}
                >
                  {memberLabel(m)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {effectiveMode === 'qr' && (
        <div className="form-stack">
          <div className="scanner-wrap scanner-wrap--compact">
            <Scanner
              onScan={(result) => {
                if (result[0]?.rawValue && !qrBusy) void handleQrIdentify(result[0].rawValue);
              }}
              formats={['qr_code']}
              paused={!qrScanning || qrBusy}
            />
            {qrBusy && <div className="scanner-overlay">辨識中…</div>}
          </div>
          <Field label="或貼上查詢碼／門禁 Token" hint="優先掃會員頁「查詢用會員碼」">
            <div className="bind-row">
              <Input
                value={qrTokenInput}
                onChange={(e) => setQrTokenInput(e.target.value)}
                placeholder="6 碼編號或 GYMSAAS:MEMBER:…"
                className="mono"
              />
              <Button
                variant="secondary"
                onClick={() => void handleQrIdentify(qrTokenInput)}
                loading={qrBusy}
                disabled={!qrTokenInput.trim()}
              >
                查詢
              </Button>
            </div>
          </Field>
          <Alert tone="info">
            請會員出示 App「查詢用會員碼」（固定）；門禁動態 QR 亦可辨識，僅供臨櫃查詢備用。
          </Alert>
        </div>
      )}

      {allowFace && effectiveMode === 'face' && (
        <div className="form-stack">
          <Alert tone="info">依法須已簽署「生物辨識同意書」合約且完成臨櫃人臉註冊。</Alert>
          <Button onClick={() => void openFaceModal()}>開啟鏡頭辨識</Button>
        </div>
      )}

      {allowFace ? (
      <Modal
        open={faceOpen}
        title="人臉辨識選取會員"
        onClose={closeFaceModal}
        footer={
          <>
            <Button variant="ghost" onClick={closeFaceModal} disabled={faceBusy}>
              取消
            </Button>
            <Button onClick={captureAndIdentify} loading={faceBusy}>
              拍攝並辨識
            </Button>
          </>
        }
      >
        <video ref={videoRef} autoPlay playsInline muted className="face-video" />
        <canvas ref={canvasRef} hidden />
      </Modal>
      ) : null}
    </div>
  );
}
