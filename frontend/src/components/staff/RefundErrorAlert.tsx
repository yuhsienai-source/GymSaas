import type { ReactNode } from 'react';
import { Alert } from '../ui';
import type { RefundErrorInfo } from '../../lib/refundErrors';

/** 退費錯誤警示框：標題＋後端訊息＋處置建議（不吞錯、不以 toast 代替） */
export default function RefundErrorAlert({
  error,
  onDismiss,
  children,
}: {
  error: RefundErrorInfo | null;
  onDismiss?: () => void;
  children?: ReactNode;
}) {
  if (!error) return null;
  return (
    <Alert tone={error.tone} onDismiss={onDismiss}>
      <strong>{error.title}</strong>
      {error.message && error.message !== error.title ? <div>{error.message}</div> : null}
      {error.hint ? <div className="text-sm" style={{ marginTop: 4 }}>{error.hint}</div> : null}
      {error.code ? <div className="text-muted mono" style={{ fontSize: 11, marginTop: 4 }}>{error.code}</div> : null}
      {children ? <div className="btn-row" style={{ marginTop: 8 }}>{children}</div> : null}
    </Alert>
  );
}
