import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export type GateFlashResult = {
  ok: boolean;
  message: string;
  memberId?: number;
  code?: string;
  renewable?: boolean;
};

interface GateLayoutProps {
  mode: 'check-in' | 'check-out';
  onModeChange: (mode: 'check-in' | 'check-out') => void;
  lastResult?: GateFlashResult | null;
  children: ReactNode;
}

export default function GateLayout({
  mode,
  onModeChange,
  lastResult,
  children,
}: GateLayoutProps) {
  const renewHref =
    lastResult?.renewable && lastResult.memberId
      ? `/staff/ops?tab=checkout&memberId=${lastResult.memberId}`
      : null;

  return (
    <div className="gate-app">
      <header className="gate-header">
        <Link to="/portal" className="gate-header__back">
          ← 離開
        </Link>
        <div className="brand brand--gate">
          <span className="brand__mark">體</span>
          <span className="brand__text">
            門禁閘機
            <small>進／出場同一會員碼 · 刷臉 · 裝置綁定</small>
          </span>
        </div>
      </header>

      {lastResult && (
        <div className={`gate-flash gate-flash--${lastResult.ok ? 'ok' : 'err'}`}>
          {lastResult.message}
          {renewHref ? (
            <div className="gate-flash__actions">
              <Link className="btn btn--primary btn--sm" to={renewHref}>
                櫃檯續約／儲值
              </Link>
            </div>
          ) : null}
        </div>
      )}

      <div className="gate-segment" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'check-in'}
          className={`gate-segment__btn ${mode === 'check-in' ? 'is-active' : ''}`}
          onClick={() => onModeChange('check-in')}
        >
          進場
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'check-out'}
          className={`gate-segment__btn ${mode === 'check-out' ? 'is-active' : ''}`}
          onClick={() => onModeChange('check-out')}
        >
          出場結算
        </button>
      </div>

      <main className="gate-main">{children}</main>
    </div>
  );
}
