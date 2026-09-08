import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandMark from '../BrandMark';

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
  /** 會員表面用亮色；員工／入口／看板維持品牌深色 */
  const memberSurface =
    pathname === '/' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/pay');

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const next = memberSurface ? '#F3F6F8' : '#083D4F';
    const prev = meta.getAttribute('content');
    meta.setAttribute('content', next);
    return () => {
      if (prev) meta.setAttribute('content', prev);
    };
  }, [memberSurface]);

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
    <div
      className={`landing${fitViewport ? ' landing--fit' : ''}${
        memberSurface ? ' landing--member' : ' landing--staff'
      }`}
    >
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
          <BrandMark />
          <span className="brand__text">
            1st FITNESS
            <small>體育客 GymSaaS</small>
          </span>
        </Link>
      </header>
      <main className="landing__main">{children}</main>
      <footer className="landing__footer landing__footer--minimal">
        <p>© 1st FITNESS</p>
      </footer>
    </div>
  );
}
