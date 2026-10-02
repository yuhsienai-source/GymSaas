import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  deleteHqStaffPhoto,
  fetchHqStaffFaceConsent,
  getErrorMessage,
  revokeHqStaffFace,
  signHqStaffFaceConsent,
  uploadHqStaffPhoto,
} from '../../lib/api';
import type { StaffAccount, StaffFaceConsent, StaffPhotoStatus } from '../../types/api';
import StaffAvatar from './StaffAvatar';
import StaffFaceConsentSection from './StaffFaceConsentSection';

const MAX_EDGE = 1280;

/** 任意來源影像 → 長邊 ≤1280 JPEG data URL（僅存記憶體，不落盤） */
function toJpegDataUrl(source: CanvasImageSource, w: number, h: number, mirror = false): string {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('無法處理影像');
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

function readFileAsJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        resolve(toJpegDataUrl(img, img.naturalWidth, img.naturalHeight));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('無法讀取影像，請改用 JPG／PNG'));
    };
    img.src = objectUrl;
  });
}

type Props = {
  staff: StaffAccount;
  onChanged: (status: StaffPhotoStatus) => void | Promise<void>;
};

export default function StaffPhotoPanel({ staff, onChanged }: Props) {
  const { toast } = useToast();
  const inFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [enrollFace, setEnrollFace] = useState(true);
  const [consent, setConsent] = useState<StaffFaceConsent | null>(null);
  const [consentLoading, setConsentLoading] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetchHqStaffFaceConsent(staff.id)
      .then((res) => {
        if (alive) setConsent(res.data ?? null);
      })
      .catch(() => {
        if (alive) setConsent(null);
      })
      .finally(() => {
        if (alive) setConsentLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [staff.id]);

  useEffect(() => {
    if (!cameraOpen) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      setCameraError('');
      setCameraReady(false);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false,
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraReady(true);
      } catch {
        setCameraError('無法開啟相機，請允許瀏覽器相機權限，或改用「選擇檔案」。');
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setCameraReady(false);
    };
  }, [cameraOpen]);

  function shoot() {
    const video = videoRef.current;
    if (!video || !cameraReady) return;
    try {
      setPreview(toJpegDataUrl(video, video.videoWidth || 1280, video.videoHeight || 960, true));
      setCameraOpen(false);
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : '擷取失敗');
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPreview(await readFileAsJpeg(file));
      setCameraOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : '無法讀取影像', 'error');
    }
  }

  async function run(task: () => Promise<{ message?: string; data?: StaffPhotoStatus }>, fallback: string) {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await task();
      if (res.data) {
        toast(res.message || '已更新', res.data.warning ? 'info' : 'success');
        setPreview(null);
        await onChanged(res.data);
      }
      return true;
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
      return false;
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function signConsent(signatureData: string, bodyHash: string) {
    return run(async () => {
      const res = await signHqStaffFaceConsent(staff.id, signatureData, bodyHash);
      const latest = await fetchHqStaffFaceConsent(staff.id);
      setConsent(latest.data ?? null);
      return {
        message: res.message,
        data: {
          id: staff.id,
          photoUpdatedAt: staff.photoUpdatedAt ?? null,
          faceEnrolledAt: staff.faceEnrolledAt ?? null,
          faceConsentAt: res.data?.signedAt ?? null,
        },
      };
    }, '簽署生物辨識同意書失敗');
  }

  function revokeConsent() {
    if (!window.confirm('確定撤回此員工的生物辨識同意？將刪除人臉特徵（保留頭像），日後須重新簽署。')) return;
    void run(async () => {
      const res = await revokeHqStaffFace(staff.id);
      setConsent(null);
      return res;
    }, '撤回生物辨識同意失敗');
  }

  const hasPhoto = Boolean(staff.photoUpdatedAt);
  const consentValid = Boolean(consent?.current);
  const willEnroll = consentValid && enrollFace;

  return (
    <div className="staff-photo-panel">
      <div className="staff-photo-panel__head">
        <StaffAvatar
          staffId={staff.id}
          name={staff.name}
          version={staff.photoUpdatedAt}
          src={preview}
          size="lg"
        />
        <div className="staff-photo-panel__status">
          <strong>員工照片</strong>
          <div className="staff-photo-panel__badges">
            <Badge tone={hasPhoto ? 'success' : 'neutral'}>{hasPhoto ? '已上傳' : '尚未上傳'}</Badge>
            <Badge tone={staff.faceEnrolledAt ? 'info' : 'neutral'}>
              {staff.faceEnrolledAt ? '人臉辨識已註冊' : '人臉辨識未啟用'}
            </Badge>
            {preview && <Badge tone="warning">預覽中・尚未儲存</Badge>}
          </div>
          <span className="text-muted text-sm">請拍攝正面、無遮蔽、光線充足的大頭照；同時用於頭像與人臉辨識。</span>
        </div>
      </div>

      {cameraOpen && (
        <div className="staff-photo-panel__camera">
          {cameraError ? (
            <Alert tone="error">{cameraError}</Alert>
          ) : (
            <div className="staff-photo-panel__viewport">
              <video ref={videoRef} playsInline muted autoPlay />
              <div className="staff-photo-panel__guide" aria-hidden />
            </div>
          )}
          <div className="staff-photo-panel__actions">
            <Button type="button" disabled={!cameraReady || busy} onClick={shoot}>拍攝</Button>
            <Button type="button" variant="ghost" onClick={() => setCameraOpen(false)}>取消</Button>
          </div>
        </div>
      )}

      {!cameraOpen && (
        <div className="staff-photo-panel__actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setCameraOpen(true)}>
            {hasPhoto || preview ? '重新拍攝' : '開啟相機拍攝'}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            選擇檔案
          </Button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFile} />
        </div>
      )}

      <StaffFaceConsentSection
        staffName={staff.name}
        consent={consent}
        loading={consentLoading}
        busy={busy}
        onSign={signConsent}
        onRevoke={revokeConsent}
      />

      <label className="checkbox-item staff-photo-panel__consent">
        <input
          type="checkbox"
          checked={willEnroll}
          disabled={busy || !consentValid}
          onChange={(e) => setEnrollFace(e.target.checked)}
        />
        以此照片註冊人臉辨識
      </label>
      <span className="text-muted text-sm">
        {consentValid
          ? '未勾選則僅作頭像使用；更換照片時若取消勾選，將一併刪除既有人臉特徵。'
          : '須先由員工本人簽署生物辨識電子同意書，才可註冊人臉；目前僅能上傳頭像。'}
      </span>

      <div className="staff-photo-panel__actions">
        <Button
          type="button"
          disabled={!preview || busy}
          loading={busy}
          onClick={() =>
            preview &&
            void run(() => uploadHqStaffPhoto(staff.id, preview, willEnroll), '上傳員工照片失敗')
          }
        >
          儲存照片
        </Button>
        {preview && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
            放棄預覽
          </Button>
        )}
        {hasPhoto && !preview && (
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('確定刪除員工照片？人臉特徵將一併刪除（同意書保留，重拍可直接註冊）。')) return;
              void run(() => deleteHqStaffPhoto(staff.id), '刪除員工照片失敗');
            }}
          >
            刪除照片
          </Button>
        )}
      </div>
    </div>
  );
}
