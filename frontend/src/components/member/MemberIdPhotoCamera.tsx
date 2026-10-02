import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '../ui';

export type MemberIdPhotoSide = 'front' | 'back';

type Props = {
  side: MemberIdPhotoSide;
  sideLabel: string;
  disabled?: boolean;
  busy?: boolean;
  alreadyDone?: boolean;
  onCaptured: (dataUrl: string) => void | Promise<void>;
  onCancel?: () => void;
};

/**
 * 會員證件：僅瀏覽器相機（getUserMedia）→ Canvas JPEG。
 * 禁止檔案選擇器／HEIC 相簿匯入（避免格式被後端拒收）。
 */
export default function MemberIdPhotoCamera({
  side,
  sideLabel,
  disabled,
  busy,
  alreadyDone,
  onCaptured,
  onCancel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stop() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setError('');
      setReady(false);
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setReady(true);
      } catch {
        setError('無法開啟相機。請允許瀏覽器相機權限，或改用手機 Safari／Chrome 重試。');
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [open, side]);

  async function shoot() {
    const video = videoRef.current;
    if (!video || !ready || busy) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    if (w < 8 || h < 8) {
      setError('相機畫面尚未就緒，請稍候再拍');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('無法擷取畫面');
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    canvas.width = 0;
    canvas.height = 0;
    await onCaptured(dataUrl);
    setOpen(false);
    onCancel?.();
  }

  return (
    <div className="id-photo-side">
      <p className="id-photo-side__title">
        {sideLabel}
        {alreadyDone ? ' · 已上傳' : ' · 必填'}
      </p>
      {!open ? (
        <div className="id-photo-side__actions">
          <Button
            type="button"
            variant="secondary"
            className="id-photo-touch-btn"
            disabled={disabled || busy}
            loading={busy}
            onClick={() => setOpen(true)}
          >
            {alreadyDone ? '重新拍攝' : '開啟相機拍攝'}
          </Button>
        </div>
      ) : (
        <div className="id-photo-camera">
          {error ? (
            <Alert tone="error">{error}</Alert>
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="id-photo-camera__video"
            />
          )}
          <div className="id-photo-side__actions" style={{ marginTop: '0.5rem' }}>
            <Button
              type="button"
              disabled={!ready || busy || Boolean(error)}
              loading={busy}
              className="id-photo-touch-btn"
              onClick={() => void shoot()}
            >
              拍攝並上傳
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="id-photo-touch-btn"
              onClick={() => {
                setOpen(false);
                setError('');
                onCancel?.();
              }}
            >
              取消
            </Button>
          </div>
          <p className="text-muted text-sm" style={{ marginTop: '0.35rem' }}>
            僅能現場拍照（自動轉成 JPG），無法從相簿選檔。
          </p>
        </div>
      )}
    </div>
  );
}
