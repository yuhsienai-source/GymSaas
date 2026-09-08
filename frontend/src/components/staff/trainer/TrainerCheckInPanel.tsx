import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Alert, Button, Card, EmptyState } from '../../ui';
import { useToast } from '../../../contexts/ToastContext';
import { createTrainerClassCheckInToken, getErrorMessage } from '../../../lib/api';
import type { TrainerDashboardClass } from '../../../types/api';

const CHECK_IN_PREFIX = 'GYMSAAS:CLASS:';

type Props = {
  classItem: TrainerDashboardClass | null;
  viewAsTrainerId?: number;
};

export default function TrainerCheckInPanel({ classItem, viewAsTrainerId }: Props) {
  const { toast } = useToast();
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = useCallback(async () => {
    if (!classItem) return;
    setLoading(true);
    try {
      const kind = classItem.type === 'PRIVATE' ? 'PRIVATE' : 'GROUP_VENUE';
      const res = await createTrainerClassCheckInToken(classItem.id, {
        kind,
        viewAsTrainerId,
      });
      if (res.status === 'success' && res.data?.token) {
        setToken(res.data.token);
        setExpiresAt(res.data.expiresAt);
        toast('QR 簽到碼已產生', 'success');
      } else {
        toast(res.message || '產生失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, '產生 QR 失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [classItem, viewAsTrainerId, toast]);

  useEffect(() => {
    setToken('');
    setExpiresAt(null);
  }, [classItem?.id]);

  if (!classItem) {
    return (
      <EmptyState icon="📱" title="選擇課程" desc="從課表點選課程後可產生 QR 簽到碼" />
    );
  }

  const qrValue = token ? `${CHECK_IN_PREFIX}${token}` : '';

  return (
    <Card title="QR 簽到" subtitle={`${classItem.title} · ${classItem.type}`}>
      <p className="text-muted text-sm">
        學員掃描後由後端驗證 token 與預約。團課／私教皆可產生 15 分鐘有效碼。
      </p>
      <Button onClick={() => void generate()} loading={loading}>
        產生簽到 QR
      </Button>
      {token && (
        <>
          <div className="member-qr-wrap" style={{ marginTop: '1rem' }}>
            <QRCodeSVG value={qrValue} size={200} level="M" />
          </div>
          {expiresAt && (
            <Alert tone="info">
              有效至 {new Date(expiresAt).toLocaleTimeString('zh-TW')}
            </Alert>
          )}
          <p className="text-muted text-sm" style={{ wordBreak: 'break-all' }}>
            Token: {token}
          </p>
        </>
      )}
    </Card>
  );
}
