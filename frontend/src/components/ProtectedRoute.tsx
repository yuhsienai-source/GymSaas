import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

interface ProtectedRouteProps {
  isAllowed: boolean;
  redirectTo: string;
  children: ReactNode;
}

export default function ProtectedRoute({ isAllowed, redirectTo, children }: ProtectedRouteProps) {
  const location = useLocation();

  if (!isAllowed) {
    return <Navigate to={redirectTo} replace state={{ from: location.pathname }} />;
  }

  return children;
}
