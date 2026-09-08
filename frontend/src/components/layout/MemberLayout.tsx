import { Link } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { Button } from '../ui';

interface MemberLayoutProps {
  name?: string;
  plan?: string;
  /** 點個人圖示進入詳細資料；未傳則連到 /member/profile */
  profileTo?: string;
  onRefresh?: () => void;
  onLogout?: () => void;
  children: ReactNode;
  /** 目前頁籤 */
  activeTab?: 'home' | 'explore' | 'book' | 'records' | 'membership' | 'profile';
}

const TAB_ITEMS: {
  key: NonNullable<MemberLayoutProps['activeTab']>;
  to: string;
  label: string;
  icon: ReactNode;
}[] = [
  {
    key: 'home',
    to: '/member',
    label: '首頁',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M12 3.2 4 10v10h5.5v-6h5v6H20V10l-8-6.8z" />
      </svg>
    ),
  },
  {
    key: 'explore',
    to: '/member/explore',
    label: '探索',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm3.7 6.3-1.4 4.4-4.4 1.4 1.4-4.4 4.4-1.4z" />
      </svg>
    ),
  },
  {
    key: 'book',
    to: '/member/book',
    label: '約課',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M7 2h2v2h6V2h2v2h3v18H4V4h3V2zm13 8H6v10h14V10zM8 12h4v4H8v-4z" />
      </svg>
    ),
  },
  {
    key: 'records',
    to: '/member/records',
    label: '紀錄',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M4 4h16v2H4V4zm0 5h16v2H4V9zm0 5h10v2H4v-2zm0 5h12v2H4v-2z" />
      </svg>
    ),
  },
  {
    key: 'membership',
    to: '/member/membership',
    label: '會籍',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11zM5 8v2h14V8H5zm0 4v5.5c0 .28.22.5.5.5h13a.5.5 0 0 0 .5-.5V12H5z" />
      </svg>
    ),
  },
  {
    key: 'profile',
    to: '/member/profile',
    label: '個人',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z" />
      </svg>
    ),
  },
];

export default function MemberLayout({
  name = '會員',
  plan,
  profileTo = '/member/profile',
  onRefresh,
  onLogout,
  children,
  activeTab = 'home',
}: MemberLayoutProps) {
  const initial = name.charAt(0).toUpperCase();

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') ?? '#083D4F';
    meta?.setAttribute('content', '#083D4F');
    document.documentElement.classList.add('member-root');
    return () => {
      meta?.setAttribute('content', prev);
      document.documentElement.classList.remove('member-root');
    };
  }, []);

  return (
    <div className="member-app">
      <header className="member-header">
        <div className="member-header__profile">
          <Link
            to={profileTo}
            className="avatar avatar--profile"
            aria-label="個人資料"
            title="個人資料"
          >
            <span className="avatar__initial">{initial}</span>
            <span className="avatar__line-badge" aria-hidden title="個人">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z" />
              </svg>
            </span>
          </Link>
          <div className="member-header__meta">
            <h1>{name}</h1>
            {plan && <span className="member-header__plan">{plan}</span>}
          </div>
        </div>
        <div className="member-header__actions">
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              aria-label="重新整理"
              className="member-header__icon-btn"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
                <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 1 1-4.9 6.08l-1.42 1.42A7 7 0 1 0 17.65 6.35z" />
              </svg>
            </Button>
          )}
          {onLogout && (
            <Button variant="ghost" size="sm" onClick={onLogout} className="member-header__logout">
              登出
            </Button>
          )}
        </div>
      </header>
      <main className="member-main">{children}</main>
      <nav className="member-tabbar" aria-label="會員導覽">
        <div className="member-tabbar__inner">
          {TAB_ITEMS.map((t) => (
            <Link
              key={t.key}
              to={t.to}
              className={`member-tabbar__item${activeTab === t.key ? ' is-active' : ''}`}
              aria-current={activeTab === t.key ? 'page' : undefined}
            >
              <span className="member-tabbar__icon">{t.icon}</span>
              <span className="member-tabbar__label">{t.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
