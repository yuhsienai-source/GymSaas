import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  getErrorMessage,
  requestMemberIdPhotoDelete,
  uploadMemberIdPhoto,
  type IdPhotoSide,
} from '../../lib/api';

const BRAND = '#083D4F';

const SIDE_LABEL: Record<IdPhotoSide, string> = {
  front: '證件正面',
  back: '證件反面',
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** 開啟時預選要上傳的面；null＝兩面皆可操作 */
  initialSide?: IdPhotoSide | null;
  onUploaded?: (side: IdPhotoSide) => void;
  onDeleteRequested?: () => void;
};

/**
 * 會員證件正／反面上傳（鏡頭或選檔）＋申請清除。
 * 禁止傳 memberId；一律走 api.ts → JWT。
 */
export default function IdPhotoUploadModal({
  open,
  onClose,
  initialSide = null,
  onUploaded,
  onDeleteRequested,
}: Props) {
  const { toast } = useToast();
  const [consent, setConsent] = useState(false);
  const [busySide, setBusySide] = useState<IdPhotoSide | null>(null);
  const [cameraSide, setCameraSide] = useState<IdPhotoSide | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileFrontRef = useRef<HTMLInputElement | null>(null);
  const fileBackRef = useRef<HTMLInputElement | null>(null);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }

  useEffect(() => {
    if (!open) {
      setConsent(false);
      setCameraSide(null);
      setCameraError('');
      stopCamera();
    }
  }, [open]);

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
        setCameraError('無法開啟相機，請改用選取本機檔案，或檢查瀏覽器權限。');
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraSide]);

  async function uploadDataUrl(side: IdPhotoSide, dataUrl: string) {
    if (!consent) {
      toast('請先勾選同意證件蒐集告知', 'error');
      return;
    }
    setBusySide(side);
    try {
      const res = await uploadMemberIdPhoto(dataUrl, side, { consent: true });
      if (res.status !== 'success') {
        toast(res.message || '上傳失敗', 'error');
        return;
      }
      toast(res.message || `${SIDE_LABEL[side]}已上傳`, 'success');
      onUploaded?.(side);
      setCameraSide(null);
    } catch (err) {
      toast(getErrorMessage(err, '上傳證件失敗'), 'error');
    } finally {
      setBusySide(null);
    }
  }

  async function handleFile(side: IdPhotoSide, file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await uploadDataUrl(side, dataUrl);
    } catch (err) {
      toast(getErrorMessage(err, '讀取檔案失敗'), 'error');
    }
  }

  async function captureFromCamera() {
    const side = cameraSide;
    const video = videoRef.current;
    if (!side || !video) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      toast('無法擷取畫面', 'error');
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    await uploadDataUrl(side, canvas.toDataURL('image/jpeg', 0.92));
  }

  async function handleRequestClear(side: IdPhotoSide | 'both') {
    setDeleteBusy(true);
    try {
      const res = await requestMemberIdPhotoDelete(side, '會員自助申請清除');
      if (res.status !== 'success') {
        toast(res.message || '申請失敗', 'error');
        return;
      }
      toast(
        res.message || '已送出清除申請，須待櫃檯審核通過後才會刪除存檔',
        'info',
      );
      onDeleteRequested?.();
    } catch (err) {
      toast(getErrorMessage(err, '申請清除失敗'), 'error');
    } finally {
      setDeleteBusy(false);
    }
  }

  const sides: IdPhotoSide[] =
    initialSide === 'front' || initialSide === 'back' ? [initialSide] : ['front', 'back'];

  return (
    <Modal
      open={open}
      title="證件上傳"
      onClose={() => {
        if (busySide) return;
        onClose();
      }}
      footer={
        <Button type="button" variant="ghost" disabled={!!busySide} onClick={onClose}>
          關閉
        </Button>
      }
    >
      <Alert tone="info">
        證件影像僅供會籍核對使用；保存期間依館方政策（會籍結束＋法定年限）。上傳前請詳閱並勾選同意。
      </Alert>

      <label className="id-photo-consent id-photo-modal__gap">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>我已了解蒐集目的與保存期間，同意上傳證件正／反面供會籍核對。</span>
      </label>

      {!consent && (
        <div className="id-photo-modal__gap">
          <Alert tone="warning">未勾選同意前，拍攝／選檔按鈕無法使用</Alert>
        </div>
      )}

      <div className="id-photo-grid id-photo-modal__gap">
        {sides.map((side) => {
          const busy = busySide === side;
          const fileRef = side === 'front' ? fileFrontRef : fileBackRef;
          return (
            <div className="id-photo-side" key={side}>
              <p className="id-photo-side__title">{SIDE_LABEL[side]}</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                tabIndex={-1}
                disabled={busy || !consent}
                onChange={(e) => {
                  void handleFile(side, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="id-photo-side__actions">
                <Button
                  type="button"
                  variant="secondary"
                  className="id-photo-touch-btn"
                  disabled={!consent || busy}
                  loading={busy && cameraSide !== side}
                  onClick={() => fileRef.current?.click()}
                >
                  選取檔案
                </Button>
                <Button
                  type="button"
                  className="id-photo-touch-btn"
                  disabled={!consent || busy}
                  style={{ background: BRAND }}
                  onClick={() => setCameraSide(side)}
                >
                  開啟鏡頭
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="id-photo-touch-btn"
                  disabled={deleteBusy || busy}
                  onClick={() => void handleRequestClear(side)}
                >
                  申請清除此面
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {sides.length > 1 && (
        <Button
          type="button"
          variant="danger"
          className="id-photo-touch-btn id-photo-modal__gap"
          style={{ width: '100%' }}
          disabled={deleteBusy || !!busySide}
          loading={deleteBusy}
          onClick={() => void handleRequestClear('both')}
        >
          申請清除正反面紀錄
        </Button>
      )}

      <Modal
        open={cameraSide !== null}
        title={cameraSide ? `拍照・${SIDE_LABEL[cameraSide]}` : '拍照'}
        onClose={() => {
          if (busySide) return;
          setCameraSide(null);
        }}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              className="id-photo-touch-btn"
              disabled={!!busySide}
              onClick={() => setCameraSide(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="id-photo-touch-btn"
              loading={!!busySide}
              disabled={!consent || !cameraReady || !!cameraError}
              onClick={() => void captureFromCamera()}
            >
              拍攝並上傳
            </Button>
          </>
        }
      >
        {cameraError ? (
          <Alert tone="error">{cameraError}</Alert>
        ) : (
          <div className="id-photo-camera">
            <video ref={videoRef} playsInline muted autoPlay className="id-photo-camera__video" />
            {!cameraReady && <p className="text-sm">正在開啟相機…</p>}
          </div>
        )}
      </Modal>
    </Modal>
  );
}
