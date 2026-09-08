import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  getErrorMessage,
  uploadOpsMemberIdPhoto,
  type IdPhotoSide,
} from '../../lib/api';
import type { PosDisplayHostApi } from '../../lib/usePosDisplayHost';
import type { OpsMember } from '../../types/api';

const SIDE_LABEL: Record<IdPhotoSide, string> = {
  front: '證件正面',
  back: '證件反面',
};

const ID_ASSIST_CONSENT_BODY = `身分證件蒐集暨委託代辦聲明書

本人同意委託門市櫃檯人員，於館內受控設備（USB 高拍儀／UVC 攝影機）拍攝本人身分證件正、反面，僅供體育客會籍身分核對之用。

影像僅於記憶體處理並加密儲存，禁止下載、轉傳或以私人手機翻拍後帶入系統。保存至會籍結束後之法定年限；清除須申請並經核准。

本人已當面核對證件正本與拍攝對象為本人，並知悉簽署本聲明後櫃檯始得代為上傳。`;

type Props = {
  member: OpsMember;
  branchCode: string;
  staffId: number | string;
  posDisplay: PosDisplayHostApi;
  onUploaded?: () => void;
};

function applyAssistWatermark(
  dataUrl: string,
  watermarkText: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('無法處理影像'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#083D4F';
      const fontSize = Math.max(18, Math.floor(canvas.width / 36));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 6);
      const step = fontSize * 3.2;
      for (let y = -canvas.height; y < canvas.height; y += step) {
        ctx.fillText(watermarkText, 0, y);
      }
      ctx.restore();
      const out = canvas.toDataURL('image/jpeg', 0.9);
      canvas.width = 0;
      canvas.height = 0;
      resolve(out);
    };
    img.onerror = () => reject(new Error('影像讀取失敗'));
    img.src = dataUrl;
  });
}

/**
 * 臨櫃代辦證件：客顯 CONSENT → 簽章回流 → USB/UVC 記憶體拍攝＋浮水印上傳。
 * 禁止檔案選擇器作為主流程。
 */
export default function OpsIdPhotoAssistPanel({
  member,
  branchCode,
  staffId,
  posDisplay,
  onUploaded,
}: Props) {
  const { toast } = useToast();
  const [assistConsentId, setAssistConsentId] = useState<string | null>(null);
  const [consentOk, setConsentOk] = useState(false);
  const [cameraSide, setCameraSide] = useState<IdPhotoSide | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [busySide, setBusySide] = useState<IdPhotoSide | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const toastedConsentRef = useRef<string | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }

  useEffect(() => {
    setAssistConsentId(null);
    setConsentOk(false);
    setCameraSide(null);
    toastedConsentRef.current = null;
    stopCamera();
  }, [member.id]);

  useEffect(() => {
    const sig = posDisplay.lastSignature;
    if (!sig || !assistConsentId) return;
    if (sig.purpose !== 'ID_PHOTO_ASSIST') return;
    if (sig.consentSignatureId !== assistConsentId) return;
    setConsentOk(true);
    if (toastedConsentRef.current !== assistConsentId) {
      toastedConsentRef.current = assistConsentId;
      toast('客顯委託簽署完成，可開始拍攝證件', 'success');
    }
  }, [posDisplay.lastSignature, assistConsentId, toast]);

  useEffect(() => {
    if (!cameraSide) {
      stopCamera();
      return;
    }
    let cancelled = false;
    void (async () => {
      setCameraError('');
      setCameraReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraReady(true);
      } catch {
        setCameraError('無法開啟相機／高拍儀，請檢查瀏覽器權限與受控設備連線。');
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraSide]);

  function dispatchConsent() {
    posDisplay.openDisplayWindow();
    const today = new Date().toISOString().slice(0, 10);
    const id = posDisplay.requestConsent({
      purpose: 'ID_PHOTO_ASSIST',
      title: '身分證件蒐集暨委託代辦聲明書',
      body: ID_ASSIST_CONSENT_BODY,
      memberName: member.name,
      branchLabel: String(branchCode),
    });
    setAssistConsentId(id);
    setConsentOk(false);
    toast(`已派送客顯委託書（${today}）`, 'info');
  }

  async function captureAndUpload() {
    const side = cameraSide;
    const video = videoRef.current;
    if (!side || !video || !assistConsentId) return;
    if (!consentOk) {
      toast('須先完成客顯委託簽署', 'error');
      return;
    }
    setBusySide(side);
    try {
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('無法擷取畫面');
      ctx.drawImage(video, 0, 0, w, h);
      const raw = canvas.toDataURL('image/jpeg', 0.92);
      canvas.width = 0;
      canvas.height = 0;

      const today = new Date().toISOString().slice(0, 10);
      const watermarkText = [
        '僅供體育客會籍查驗｜他用無效',
        `分店代碼：${branchCode}`,
        `經辦人員：${staffId}`,
        `日期：${today}`,
      ].join('｜');
      const image = await applyAssistWatermark(raw, watermarkText);

      const res = await uploadOpsMemberIdPhoto(member.id, {
        image,
        side,
        consentSignatureId: assistConsentId,
        branchCode: String(branchCode),
      });
      if (res.status !== 'success') {
        toast(res.message || '上傳失敗', 'error');
        return;
      }
      toast(res.message || `${SIDE_LABEL[side]}已上傳`, 'success');
      setCameraSide(null);
      onUploaded?.();
    } catch (err) {
      toast(getErrorMessage(err, '臨櫃證件上傳失敗'), 'error');
    } finally {
      setBusySide(null);
    }
  }

  const waiting = Boolean(assistConsentId && !consentOk);

  return (
    <Card title="臨櫃代辦證件上傳" subtitle="授權簽署先行 → 受控設備拍攝 → 記憶體浮水印上傳">
      <Alert tone="info">
        嚴禁私人手機翻拍後經 LINE／AirDrop／檔案選擇器帶入。須先派送客顯委託書取得親簽。
        {posDisplay.displayLinked ? ' · 客顯已連線' : ' · 客顯尚未回報連線'}
      </Alert>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
        <Button type="button" variant="secondary" onClick={() => posDisplay.openDisplayWindow()}>
          開啟客顯
        </Button>
        <Button type="button" onClick={dispatchConsent} disabled={!!busySide}>
          派送客顯委託書
        </Button>
        {consentOk && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAssistConsentId(null);
              setConsentOk(false);
              posDisplay.clearSignature();
              posDisplay.clearPendingConsent();
              posDisplay.postIdle();
              setCameraSide(null);
            }}
          >
            結束代辦
          </Button>
        )}
      </div>

      {waiting && (
        <div style={{ marginTop: '0.75rem' }}>
          <Alert tone="warning">等待會員於客顯簽署委託書…（consentSignatureId 已產生）</Alert>
        </div>
      )}
      {consentOk && (
        <div style={{ marginTop: '0.75rem' }}>
          <Alert tone="success">委託簽署已回流，請以高拍儀／相機依序拍攝正、反面。</Alert>
        </div>
      )}

      {consentOk && (
        <div className="id-photo-grid" style={{ marginTop: '0.75rem' }}>
          {(['front', 'back'] as IdPhotoSide[]).map((side) => (
            <div className="id-photo-side" key={side}>
              <p className="id-photo-side__title">{SIDE_LABEL[side]}</p>
              <div className="id-photo-side__actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!!busySide}
                  loading={busySide === side}
                  onClick={() => setCameraSide(side)}
                >
                  開啟高拍儀／相機
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {cameraSide && (
        <div className="id-photo-camera" style={{ marginTop: '0.75rem' }}>
          <p className="id-photo-side__title">拍攝{SIDE_LABEL[cameraSide]}（導引框置中）</p>
          {cameraError ? (
            <Alert tone="danger">{cameraError}</Alert>
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="id-photo-camera__video"
              style={{
                width: '100%',
                maxHeight: 320,
                objectFit: 'cover',
                borderRadius: 'var(--radius-sm)',
                background: '#000',
              }}
            />
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button
              type="button"
              disabled={!cameraReady || !!busySide}
              loading={!!busySide}
              onClick={() => void captureAndUpload()}
            >
              擷取並上傳
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!!busySide}
              onClick={() => setCameraSide(null)}
            >
              取消拍攝
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
