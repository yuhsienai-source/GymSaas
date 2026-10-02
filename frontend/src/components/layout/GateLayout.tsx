import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import BrandMark from '../BrandMark';

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
  /** 掃描進行中時鎖定進／出場切換，避免誤觸 */
  modeLocked?: boolean;
  children: ReactNode;
}

export default function GateLayout({
  mode,
  onModeChange,
  lastResult,
  modeLocked = false,
  children,
}: GateLayoutProps) {
  return (
    <div className="gate-app">
      <header className="gate-header">
        <Link to="/portal" className="gate-header__back">
          ← 離開
        </Link>
        <div className="brand brand--gate">
          <BrandMark />
          <span className="brand__text">
            門禁閘機
            <small>進／出場同一會員碼 · 刷臉 · 裝置綁定</small>
          </span>
        </div>
      </header>

      {lastResult && (
        <div className={`gate-flash gate-flash--${lastResult.ok ? 'ok' : 'err'}`}>
          {lastResult.message}
          {lastResult.renewable ? (
            <div className="gate-flash__actions">
              <p className="gate-flash__renew-hint">
                請至<strong>櫃檯</strong>辦理續約／儲值
                {lastResult.memberId != null ? `（會員內部編號 #${lastResult.memberId}）` : ''}
                ，勿在閘機平板登入員工系統。
              </p>
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
          disabled={modeLocked && mode !== 'check-in'}
          onClick={() => {
            if (!modeLocked) onModeChange('check-in');
          }}
        >
          進場
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'check-out'}
          className={`gate-segment__btn ${mode === 'check-out' ? 'is-active' : ''}`}
          disabled={modeLocked && mode !== 'check-out'}
          onClick={() => {
            if (!modeLocked) onModeChange('check-out');
          }}
        >
          出場結算
        </button>
      </div>

      <main className="gate-main">{children}</main>
    </div>
  );
}
