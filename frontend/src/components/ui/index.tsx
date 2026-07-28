import { useState, type CSSProperties, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

interface CardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'elevated' | 'glass' | 'dark';
  padding?: 'md' | 'lg';
}

export function Card({
  title,
  subtitle,
  children,
  className = '',
  variant = 'default',
  padding = 'md',
}: CardProps) {
  return (
    <section
      className={`card card--${variant} card--pad-${padding} ${className}`.trim()}
    >
      {(title || subtitle) && (
        <header className="card__header">
          {title && <h2 className="card__title">{title}</h2>}
          {subtitle && <p className="card__subtitle">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  dot,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  dot?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'line' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${loading ? 'is-loading' : ''}`.trim()}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <span className="btn__spinner" />}
      {children}
    </button>
  );
}

export function Alert({
  children,
  tone = 'error',
  onDismiss,
}: {
  children: ReactNode;
  tone?: 'error' | 'info' | 'success' | 'warning';
  onDismiss?: () => void;
}) {
  return (
    <div className={`alert alert--${tone}`} role="alert">
      <div className="alert__body">{children}</div>
      {onDismiss && (
        <button type="button" className="alert__close" onClick={onDismiss} aria-label="關閉">
          ×
        </button>
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Input({ className = '', readOnly, disabled, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const locked = Boolean(readOnly || disabled);
  return (
    <input
      className={`input${locked ? ' input--locked' : ''} ${className}`.trim()}
      readOnly={readOnly}
      disabled={disabled}
      {...props}
    />
  );
}

/** 密碼欄位：右側開關眼顯示／隱藏明文 */
export function PasswordInput({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`password-input ${className}`.trim()}>
      <input
        className="input password-input__field"
        type={visible ? 'text' : 'password'}
        {...props}
      />
      <button
        type="button"
        className="password-input__toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '隱藏密碼' : '顯示密碼'}
        aria-pressed={visible}
        tabIndex={0}
      >
        {visible ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9.3 3.1 11 7.5a11.5 11.5 0 01-4.2 5.1M6.1 6.1A11.5 11.5 0 001 12.5C2.7 16.9 7 20 12 20c1.7 0 3.3-.4 4.7-1"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M1 12.5C2.7 8.1 7 5 12 5s9.3 3.1 11 7.5C21.3 16.9 17 20 12 20S2.7 16.9 1 12.5z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input input--select" {...props} />;
}

export function StatCard({
  label,
  value,
  tone = 'default',
  suffix,
}: {
  label: string;
  value: string | number;
  tone?: 'cash' | 'bonus' | 'default';
  suffix?: string;
}) {
  return (
    <div className={`stat-card stat-card--${tone}`}>
      <span className="stat-card__label">{label}</span>
      <strong className="stat-card__value">
        {value}
        {suffix && <small>{suffix}</small>}
      </strong>
    </div>
  );
}

export function EmptyState({ icon, title, desc }: { icon: string; title: string; desc?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">{icon}</span>
      <strong>{title}</strong>
      {desc && <p>{desc}</p>}
    </div>
  );
}

export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className}`.trim()} style={style} />;
}

export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal__header">
          <h3 id="modal-title">{title}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function PageSection({
  title,
  desc,
  action,
  children,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page-section">
      <div className="page-section__head">
        <div>
          <h2>{title}</h2>
          {desc && <p>{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ProgressRing({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className="progress-ring"
      style={{ '--pct': `${pct}%` } as CSSProperties}
      aria-label={`${value} 秒`}
    >
      <span>{value}</span>
    </div>
  );
}
