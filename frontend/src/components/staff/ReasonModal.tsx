import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { Button, Field, Modal } from '../ui';

/** 需填寫原因之確認視窗（拒絕、撤銷、更正等稽核動作）；原因必填與否以後端為準 */
export default function ReasonModal({
  title,
  label = '原因',
  confirmLabel = '確認',
  danger = false,
  children,
  onSubmit,
  onClose,
}: {
  title: string;
  label?: string;
  confirmLabel?: string;
  danger?: boolean;
  children?: ReactNode;
  onSubmit: (reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current || !reason.trim()) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      if (await onSubmit(reason.trim())) onClose();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open title={title} onClose={onClose}>
      <form onSubmit={submit} className="reason-modal">
        {children}
        <Field label={label}>
          <textarea
            className="input"
            rows={3}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <div className="reason-modal__actions">
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!reason.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
