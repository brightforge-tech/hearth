import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthFailure } from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";
import { setAuthNotice, SESSION_EXPIRED_NOTICE } from "@/integrations/supabase/shim/auth";
import { useToast } from "@/hooks/use-toast";

const PUBLIC_PATHS = ["/", "/auth", "/reset-password"];

/** Reacts to the two answers that end normal work (reported by apiFetch and
 *  by the react-query caches in App.tsx):
 *    401 SESSION_EXPIRED          -> sign out, back to /auth with a notice;
 *    403 PASSWORD_CHANGE_REQUIRED -> to /change-password.
 *  Rendered once, inside the router. */
export function AuthFailureHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const busy = useRef(false);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    return onAuthFailure((error) => {
      if (busy.current) return;
      const path = pathRef.current;
      if (error.code === "SESSION_EXPIRED") {
        if (PUBLIC_PATHS.includes(path)) return;
        busy.current = true;
        setAuthNotice(SESSION_EXPIRED_NOTICE);
        supabase.auth
          .signOut()
          .catch(() => undefined)
          .finally(() => {
            busy.current = false;
            navigate("/auth", { replace: true });
          });
        return;
      }
      if (error.code === "PASSWORD_CHANGE_REQUIRED" && path !== "/change-password") {
        toast({ title: "Password change required", description: "Please choose a new password to continue." });
        navigate("/change-password", { replace: true });
      }
    });
  }, [navigate, toast]);

  return null;
}

export default AuthFailureHandler;
