import { useAuth } from "@/hooks/useAuth";
import { Navigate, useLocation } from "react-router-dom";

const CHANGE_PASSWORD_PATH = "/change-password";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  /** when set, the user needs at least one of these roles */
  roles?: string[];
}

export function ProtectedRoute({ children, requireAdmin = false, roles }: ProtectedRouteProps) {
  const { user, loading, hasRole, mustChangePassword } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // A pending password change locks every other page (the API answers 403
  // PASSWORD_CHANGE_REQUIRED to everything else anyway).
  if (mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }

  const allowed =
    (!requireAdmin || hasRole("admin")) &&
    (!roles || roles.length === 0 || roles.some((role) => hasRole(role)));

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground">
            {requireAdmin ? "You need admin permissions to view this page." : "Your role does not have access to this page."}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
