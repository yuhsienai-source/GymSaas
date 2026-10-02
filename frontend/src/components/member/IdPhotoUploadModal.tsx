import { useState } from 'react';
import { Alert, Button, Modal } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  getErrorMessage,
  requestMemberIdPhotoDelete,
  uploadMemberIdPhoto,
  type IdPhotoSide,
} from '../../lib/api';
import MemberIdPhotoCamera from './MemberIdPhotoCamera';

const SIDE_LABEL: Record<IdPhotoSide, string> = {
  front: '證件正面',
  back: '證件反面',
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** 開啟時預選要上傳的面；null＝兩面皆可操作 */
  initialSide?: IdPhotoSide | null;
  onUploaded?: (side: IdPhotoSide) => void;
  onDeleteRequested?: () => void;
};

/**
 * 會員證件正／反面：僅相機拍攝（JPEG）＋申請清除。禁止相簿／檔案選擇器。
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
  const [done, setDone] = useState<Record<IdPhotoSide, boolean>>({
    front: false,
    back: false,
  });
  const [deleteBusy, setDeleteBusy] = useState(false);

  function handleClose() {
    if (busySide) return;
    setConsent(false);
    setDone({ front: false, back: false });
    onClose();
  }

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
      setDone((d) => ({ ...d, [side]: true }));
      onUploaded?.(side);
    } catch (err) {
      toast(getErrorMessage(err, '上傳證件失敗'), 'error');
    } finally {
      setBusySide(null);
    }
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
      title="證件拍攝上傳"
      onClose={handleClose}
      footer={
        <Button type="button" variant="ghost" disabled={!!busySide} onClick={handleClose}>
          關閉
        </Button>
      }
    >
      <Alert tone="info">
        證件影像僅供會籍核對。請用本機相機現場拍攝（自動轉 JPG），無法從相簿選檔。
      </Alert>

      <label className="id-photo-consent id-photo-modal__gap">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>我已了解蒐集目的與保存期間，同意拍攝證件正／反面供會籍核對。</span>
      </label>

      {!consent && (
        <div className="id-photo-modal__gap">
          <Alert tone="warning">未勾選同意前，無法開啟相機</Alert>
        </div>
      )}

      <div className="id-photo-grid id-photo-modal__gap">
        {sides.map((side) => (
          <MemberIdPhotoCamera
            key={side}
            side={side}
            sideLabel={SIDE_LABEL[side]}
            disabled={!consent}
            busy={busySide === side}
            alreadyDone={done[side]}
            onCaptured={(dataUrl) => void uploadDataUrl(side, dataUrl)}
          />
        ))}
      </div>

      <Button
        type="button"
        variant="danger"
        className="id-photo-touch-btn id-photo-modal__gap"
        disabled={deleteBusy || !!busySide}
        loading={deleteBusy}
        onClick={() => void handleRequestClear(initialSide === 'front' || initialSide === 'back' ? initialSide : 'both')}
      >
        申請清除證件影像（須櫃檯核准）
      </Button>
    </Modal>
  );
}
