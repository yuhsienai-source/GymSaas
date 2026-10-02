import { useState } from 'react';
import { Alert, Badge, Button } from '../ui';
import { fetchStaffBiometricsConsentTemplate, getErrorMessage } from '../../lib/api';
import type { StaffConsentTemplate, StaffFaceConsent } from '../../types/api';
import SignaturePad from './SignaturePad';

type Props = {
  staffName: string;
  consent: StaffFaceConsent | null;
  loading: boolean;
  busy: boolean;
  onSign: (signatureData: string, bodyHash: string) => Promise<boolean>;
  onRevoke: () => void;
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

/** 員工生物辨識電子同意書：員工本人閱讀並於此裝置親簽 */
export default function StaffFaceConsentSection({ staffName, consent, loading, busy, onSign, onRevoke }: Props) {
  const [template, setTemplate] = useState<StaffConsentTemplate | null>(null);
  const [signing, setSigning] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [agree, setAgree] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(false);

  async function openSign() {
    setLoadError('');
    setAgree(false);
    setSignature(null);
    setShowRecord(false);
    setSigning(true);
    try {
      const res = await fetchStaffBiometricsConsentTemplate();
      setTemplate(res.data ?? null);
    } catch (err) {
      setLoadError(getErrorMessage(err, '無法載入同意書條文'));
    }
  }

  async function submit() {
    if (!template || !signature || !agree) return;
    const ok = await onSign(signature, template.bodyHash);
    if (ok) setSigning(false);
  }

  const statusBadge = loading ? (
    <Badge tone="neutral">讀取中…</Badge>
  ) : !consent ? (
    <Badge tone="warning">未簽署</Badge>
  ) : consent.current ? (
    <Badge tone="success">已簽署（{consent.version}）</Badge>
  ) : (
    <Badge tone="warning">條文已更新・須重簽</Badge>
  );

  return (
    <div className="staff-consent">
      <div className="staff-consent__head">
        <strong>生物辨識電子同意書</strong>
        {statusBadge}
      </div>

      {consent && !signing && (
        <span className="text-muted text-sm">
          {consent.signerName} 於 {formatDateTime(consent.signedAt)} 親簽
          {consent.witnessName ? `・經辦 ${consent.witnessName}` : ''}
        </span>
      )}

      {showRecord && consent?.signatureData && !signing && (
        <img className="staff-consent__signature" src={consent.signatureData} alt="員工簽名" draggable={false} />
      )}

      {!signing && (
        <div className="staff-photo-panel__actions">
          <Button type="button" variant="secondary" disabled={busy || loading} onClick={() => void openSign()}>
            {consent ? '重新簽署' : '請員工簽署同意書'}
          </Button>
          {consent?.signatureData && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setShowRecord((v) => !v)}>
              {showRecord ? '隱藏簽名' : '查看簽名'}
            </Button>
          )}
          {consent && (
            <Button type="button" variant="secondary" disabled={busy} onClick={onRevoke}>
              撤回同意
            </Button>
          )}
        </div>
      )}

      {signing && (
        <div className="staff-consent__form">
          {loadError && <Alert tone="error">{loadError}</Alert>}
          {!template && !loadError && <span className="text-muted text-sm">載入條文中…</span>}
          {template && (
            <>
              <Alert tone="info">請將裝置交由員工本人閱讀並親自簽名，經辦人不得代簽。</Alert>
              <div className="staff-consent__body" tabIndex={0} aria-label={template.title}>
                <strong>{template.title}（{template.version}）</strong>
                <pre>{template.body}</pre>
              </div>
              <label className="checkbox-item">
                <input type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
                本人 {staffName} 已閱讀、瞭解並同意上述內容
              </label>
              <SignaturePad onChange={setSignature} disabled={busy} />
            </>
          )}
          <div className="staff-photo-panel__actions">
            <Button
              type="button"
              disabled={!template || !agree || !signature || busy}
              loading={busy}
              onClick={() => void submit()}
            >
              確認簽署
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setSigning(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
