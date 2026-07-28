import { useRef, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

const SECRET_CLICKS = 3;
const SECRET_WINDOW_MS = 900;

export default function LandingLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const clicksRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 僅會員首頁提供隱形入口；右上角連點 3 下進入系統入口 */
  const enableSecretEntry = pathname === '/';
  /** 短表單頁鎖視窗高度；員工登入不鎖，避免手機鍵盤遮住送出鈕 */
  const fitViewport = pathname === '/' || pathname.startsWith('/auth/');

  function onSecretCorner() {
    clicksRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      clicksRef.current = 0;
    }, SECRET_WINDOW_MS);
    if (clicksRef.current >= SECRET_CLICKS) {
      clicksRef.current = 0;
      if (timerRef.current) clearTimeout(timerRef.current);
      navigate('/portal');
    }
  }

  return (
    <div className={`landing${fitViewport ? ' landing--fit' : ''}`}>
      {enableSecretEntry && (
        <button
          type="button"
          className="landing__secret-entry"
          aria-label="系統入口"
          tabIndex={-1}
          onClick={onSecretCorner}
        />
      )}
      <header className="landing__header">
        <Link to="/" className="brand brand--compact">
          <span className="brand__mark">體</span>
          <span className="brand__text">
            體育客
            <small>GymSaaS</small>
          </span>
        </Link>
      </header>
      <main className="landing__main">{children}</main>
      <footer className="landing__footer">
        <p>連鎖健身 SaaS · 雙錢包 · 動態門禁 · 私教合約</p>
      </footer>
    </div>
  );
}
