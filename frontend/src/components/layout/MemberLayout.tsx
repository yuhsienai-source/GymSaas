import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Button } from '../ui';

interface MemberLayoutProps {
  name?: string;
  plan?: string;
  /** 點個人圖示進入詳細資料；未傳則連到 /member/profile */
  profileTo?: string;
  onRefresh?: () => void;
  onLogout?: () => void;
  children: ReactNode;
  /** 目前頁籤：home | book | profile */
  activeTab?: 'home' | 'book' | 'profile';
}

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
            <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="重新整理">
              ↻
            </Button>
          )}
          {onLogout && (
            <Button variant="ghost" size="sm" onClick={onLogout}>
              登出
            </Button>
          )}
        </div>
      </header>
      <main className="member-main">{children}</main>
      <nav className="member-tabbar">
        <Link
          to="/member"
          className={`member-tabbar__item${activeTab === 'home' ? ' is-active' : ''}`}
        >
          <span>首頁</span>
        </Link>
        <Link
          to="/member/book"
          className={`member-tabbar__item${activeTab === 'book' ? ' is-active' : ''}`}
        >
          <span>約課</span>
        </Link>
        <Link
          to="/member/profile"
          className={`member-tabbar__item${activeTab === 'profile' ? ' is-active' : ''}`}
        >
          <span>個人</span>
        </Link>
      </nav>
    </div>
  );
}
