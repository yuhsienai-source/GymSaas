import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import BrandMark from '../BrandMark';
import { Badge, Button } from '../ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import type { StaffPermission } from '../../lib/storage';
import { DUTY_STATE_META } from '../../lib/hrFormat';
import StaffCommandPalette from '../staff/StaffCommandPalette';
import StaffAvatar from '../staff/StaffAvatar';
import StaffDutyBanner from '../staff/StaffDutyBanner';

const SIDEBAR_COLLAPSE_KEY = 'gymsaas.staff.sidebarCollapsed';

const navItems: {
  to: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  dutyOrAbove?: boolean;
  managerOrAbove?: boolean;
  offRequest?: boolean;
  permission?: StaffPermission;
  /** 非值勤仍可用（員工自助） */
  selfService?: boolean;
}[] = [
  { to: '/staff/ops', label: '櫃檯維運', icon: '🏪', permission: 'ops' },
  { to: '/staff/pt', label: '團課服務台', icon: '🗓️', permission: 'pt' },
  { to: '/staff/inventory', label: '進銷存', icon: '📦', dutyOrAbove: true },
  { to: '/staff/roster', label: '場務排班', icon: '📅', managerOrAbove: true },
  { to: '/staff/my-roster', label: '我的排班', icon: '🗓', offRequest: true, selfService: true },
  { to: '/staff/my-attendance', label: '我的出勤', icon: '🕘', selfService: true },
  { to: '/staff/hq', label: '總部 HQ', icon: '🏢', adminOnly: true },
  { to: '/staff/trainer', label: '教練服務台', icon: '🏋️', permission: 'trainer' },
  { to: '/staff/tx', label: '交易異動', icon: '🔁', dutyOrAbove: true },
];

export default function StaffShell() {
  const { staff, isAdmin, canAccessTx, canManageRoster, canRequestOff, hasPermission, isOffDuty, duty, logout } =
    useStaffAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  /** 記錄開啟選單時的路徑；換頁後自動視為關閉 */
  const [mobileMenuPath, setMobileMenuPath] = useState<string | null>(null);
  const mobileMenuOpen = mobileMenuPath === location.pathname;
  const setMobileMenuOpen = (open: boolean) => setMobileMenuPath(open ? location.pathname : null);
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuPath(null);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (isOffDuty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOffDuty]);

  const visibleNav = navItems.filter((item) => {
    if (isOffDuty && !item.selfService) return false;
    if (item.adminOnly) return isAdmin;
    if (item.dutyOrAbove) return canAccessTx;
    if (item.managerOrAbove) return canManageRoster;
    if (item.offRequest) return canRequestOff;
    if (item.permission) return hasPermission(item.permission);
    return true;
  });

  const activeLabel =
    visibleNav.find((n) => location.pathname.startsWith(n.to))?.label || '後台';

  /** 手機抽屜開啟時一律顯示完整標籤；桌面收合改由 CSS hover 展開 */
  const forceLabels = mobileMenuOpen;

  return (
    <div className={`staff-app ${collapsed && !mobileMenuOpen ? 'staff-app--collapsed' : ''}`}>
      {mobileMenuOpen ? (
        <button
          type="button"
          className="staff-sidebar-backdrop"
          aria-label="關閉選單"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      <aside
        className={`staff-sidebar ${collapsed && !mobileMenuOpen ? 'staff-sidebar--collapsed' : ''} ${
          mobileMenuOpen ? 'is-open' : ''
        } ${forceLabels ? 'staff-sidebar--labels' : ''}`}
      >
        <div className="staff-sidebar__head">
          <Link to="/portal" className="brand brand--compact" title="體育客員工後台">
            <BrandMark />
            <span className="brand__text">
              體育客
              <small>員工後台</small>
            </span>
          </Link>
          <button
            type="button"
            className="staff-sidebar__collapse staff-sidebar__collapse--desktop"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? '展開側邊欄' : '收起側邊欄'}
            title={collapsed ? '展開' : '收起'}
          >
            {collapsed ? '»' : '«'}
          </button>
          <button
            type="button"
            className="staff-sidebar__collapse staff-sidebar__collapse--mobile"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="關閉選單"
          >
            ✕
          </button>
        </div>

        <nav className="staff-sidebar__nav" aria-label="員工功能選單">
          {visibleNav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`staff-sidebar__link ${
                location.pathname.startsWith(item.to) ? 'is-active' : ''
              }`}
              title={item.label}
            >
              <span className="staff-sidebar__icon" aria-hidden>
                {item.icon}
              </span>
              <span className="staff-sidebar__label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="staff-sidebar__footer">
          <div className="staff-user">
            {staff ? (
              <StaffAvatar staffId={staff.id} name={staff.name} version={staff.photoUpdatedAt} source="self" />
            ) : (
              <div className="avatar avatar--sm">?</div>
            )}
            <div className="staff-user__meta">
              <strong>{staff?.name}</strong>
              <span>
                {staff?.role}
                {staff?.branchName ? ` · ${staff.branchName}` : ''}
              </span>
              {duty && !duty.exempt && (
                <Badge tone={DUTY_STATE_META[duty.state].tone} dot>
                  {DUTY_STATE_META[duty.state].label}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="staff-sidebar__logout-btn w-full"
            title="登出"
          >
            <span className="staff-sidebar__logout-icon-only" aria-hidden>
              ⎋
            </span>
            <span className="staff-sidebar__logout-label">登出</span>
          </Button>
        </div>
      </aside>

      <div className="staff-content">
        <header className="staff-topbar">
          <div className="staff-topbar__left">
            <button
              type="button"
              className="staff-topbar__toggle"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="開啟選單"
              aria-expanded={mobileMenuOpen}
            >
              ☰
            </button>
            <button
              type="button"
              className="staff-topbar__toggle staff-topbar__toggle--desktop"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? '展開側邊欄' : '收起側邊欄'}
            >
              ☰
            </button>
            <h1>{activeLabel}</h1>
          </div>
          <div className="staff-topbar__right">
            {!isOffDuty && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCmdOpen(true)}
                title="全域搜尋 (Ctrl/⌘ K)"
              >
                搜尋
                <kbd className="staff-topbar__kbd">⌘K</kbd>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="staff-topbar__logout"
              title="登出"
            >
              登出
            </Button>
            <Link to="/portal" className="text-muted text-sm staff-topbar__portal">
              入口
            </Link>
          </div>
        </header>
        <main className="staff-main">
          <StaffDutyBanner />
          <Outlet />
        </main>
      </div>

      <nav className="staff-mobile-nav" aria-label="手機快捷導覽">
        {visibleNav.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`staff-mobile-nav__item ${
              location.pathname.startsWith(item.to) ? 'is-active' : ''
            }`}
          >
            <span>{item.icon}</span>
            <small>{item.label}</small>
          </Link>
        ))}
        <button
          type="button"
          className="staff-mobile-nav__item staff-mobile-nav__logout"
          onClick={logout}
        >
          <span>⎋</span>
          <small>登出</small>
        </button>
      </nav>

      <StaffCommandPalette open={cmdOpen && !isOffDuty} onClose={() => setCmdOpen(false)} />
    </div>
  );
}
