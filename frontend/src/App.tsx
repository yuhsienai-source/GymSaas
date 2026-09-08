import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import StaffShell from './components/layout/StaffShell';
import { MemberAuthProvider, useMemberAuth } from './contexts/MemberAuthContext';
import { StaffAuthProvider, useStaffAuth } from './contexts/StaffAuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { getDefaultStaffPath } from './lib/staffPermissions';
import type { StaffPermission } from './lib/storage';

const GateScannerPage = lazy(() => import('./pages/gate/GateScannerPage'));
const BoardPage = lazy(() => import('./pages/board/BoardPage'));
const AuthCallbackPage = lazy(() => import('./pages/member/AuthCallbackPage'));
const MemberDashboardPage = lazy(() => import('./pages/member/MemberDashboardPage'));
const MemberLoginPage = lazy(() => import('./pages/member/MemberLoginPage'));
const MemberProfilePage = lazy(() => import('./pages/member/MemberProfilePage'));
const MemberBookingPage = lazy(() => import('./pages/member/MemberBookingPage'));
const MemberExplorePage = lazy(() => import('./pages/member/MemberExplorePage'));
const MemberRecordsPage = lazy(() => import('./pages/member/MemberRecordsPage'));
const MemberMembershipPage = lazy(() => import('./pages/member/MemberMembershipPage'));
const PayReturnPage = lazy(() => import('./pages/member/PayReturnPage'));
const PortalPage = lazy(() => import('./pages/PortalPage'));
const HqDashboardPage = lazy(() => import('./pages/staff/HqDashboardPage'));
const OpsDashboardPage = lazy(() => import('./pages/staff/OpsDashboardPage'));
const PtDashboardPage = lazy(() => import('./pages/staff/PtDashboardPage'));
const StaffLoginPage = lazy(() => import('./pages/staff/StaffLoginPage'));
const TrainerDashboardPage = lazy(() => import('./pages/staff/TrainerDashboardPage'));
const TxDashboardPage = lazy(() => import('./pages/staff/TxDashboardPage'));
const InventoryOpsPage = lazy(() => import('./pages/staff/InventoryOpsPage'));
const CustomerDisplayPage = lazy(() => import('./pages/staff/CustomerDisplayPage'));

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
      載入中…
    </div>
  );
}

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { isAdmin, staff } = useStaffAuth();
  return (
    <ProtectedRoute isAllowed={isAdmin} redirectTo={getDefaultStaffPath(staff)}>
      {children}
    </ProtectedRoute>
  );
}

function DutyRoute({ children }: { children: ReactNode }) {
  const { canAccessTx, staff } = useStaffAuth();
  return (
    <ProtectedRoute isAllowed={canAccessTx} redirectTo={getDefaultStaffPath(staff)}>
      {children}
    </ProtectedRoute>
  );
}

function PermissionRoute({
  permission,
  children,
}: {
  permission: StaffPermission;
  children: ReactNode;
}) {
  const { hasPermission, staff } = useStaffAuth();
  return (
    <ProtectedRoute isAllowed={hasPermission(permission)} redirectTo={getDefaultStaffPath(staff)}>
      {children}
    </ProtectedRoute>
  );
}

function StaffHomeRedirect() {
  const { staff } = useStaffAuth();
  return <Navigate to={getDefaultStaffPath(staff)} replace />;
}

function AppRoutes() {
  const { isAuthenticated: isMemberAuth } = useMemberAuth();
  const { isAuthenticated: isStaffAuth } = useStaffAuth();

  return (
    <Routes>
      <Route
        path="/"
        element={
          <LazyPage>
            <MemberLoginPage />
          </LazyPage>
        }
      />
      <Route
        path="/portal"
        element={
          <LazyPage>
            <PortalPage />
          </LazyPage>
        }
      />

      {/* 後端 OAuth／金流 302 回流（FRONTEND_*_PATH）— 禁止由 backend 託管 UI */}
      <Route
        path="/auth/callback"
        element={
          <LazyPage>
            <AuthCallbackPage />
          </LazyPage>
        }
      />
      <Route
        path="/pay/return"
        element={
          <LazyPage>
            <PayReturnPage />
          </LazyPage>
        }
      />

      <Route path="/member/login" element={<Navigate to="/" replace />} />
      <Route
        path="/member"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberDashboardPage />
            </LazyPage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/profile"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberProfilePage />
            </LazyPage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/book"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberBookingPage />
            </LazyPage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/explore"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberExplorePage />
            </LazyPage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/records"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberRecordsPage />
            </LazyPage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/membership"
        element={
          <ProtectedRoute isAllowed={isMemberAuth} redirectTo="/">
            <LazyPage>
              <MemberMembershipPage />
            </LazyPage>
          </ProtectedRoute>
        }
      />

      <Route
        path="/gate"
        element={
          <LazyPage>
            <GateScannerPage />
          </LazyPage>
        }
      />
      <Route path="/scanner" element={<Navigate to="/gate" replace />} />
      <Route
        path="/board"
        element={
          <LazyPage>
            <BoardPage />
          </LazyPage>
        }
      />
      {/* 客顯副螢幕：免登入（與閘機／看板相同），靠 pos_display_bus 與主機通訊 */}
      <Route
        path="/staff/customer-display"
        element={
          <LazyPage>
            <CustomerDisplayPage />
          </LazyPage>
        }
      />

      <Route
        path="/staff/login"
        element={
          <LazyPage>
            <StaffLoginPage />
          </LazyPage>
        }
      />
      <Route
        path="/staff"
        element={
          <ProtectedRoute isAllowed={isStaffAuth} redirectTo="/staff/login">
            <StaffShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<StaffHomeRedirect />} />
        <Route
          path="ops"
          element={
            <PermissionRoute permission="ops">
              <LazyPage>
                <OpsDashboardPage />
              </LazyPage>
            </PermissionRoute>
          }
        />
        <Route
          path="orders"
          element={
            <PermissionRoute permission="ops">
              <Navigate to="/staff/ops" replace />
            </PermissionRoute>
          }
        />
        <Route
          path="hq"
          element={
            <AdminRoute>
              <LazyPage>
                <HqDashboardPage />
              </LazyPage>
            </AdminRoute>
          }
        />
        <Route
          path="pt"
          element={
            <PermissionRoute permission="pt">
              <LazyPage>
                <PtDashboardPage />
              </LazyPage>
            </PermissionRoute>
          }
        />
        <Route
          path="trainer"
          element={
            <PermissionRoute permission="trainer">
              <LazyPage>
                <TrainerDashboardPage />
              </LazyPage>
            </PermissionRoute>
          }
        />
        <Route
          path="tx"
          element={
            <DutyRoute>
              <LazyPage>
                <TxDashboardPage />
              </LazyPage>
            </DutyRoute>
          }
        />
        <Route
          path="inventory"
          element={
            <DutyRoute>
              <LazyPage>
                <InventoryOpsPage />
              </LazyPage>
            </DutyRoute>
          }
        />
      </Route>

      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <MemberAuthProvider>
          <StaffAuthProvider>
            <AppRoutes />
          </StaffAuthProvider>
        </MemberAuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
