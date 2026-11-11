import React, { createContext, useContext, useEffect, useState } from "react";
import type { User, Session } from "@/integrations/supabase/shim/types";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  userRoles: string[];
  /** the "Doctor" tag (user_roles.is_doctor) */
  isDoctor: boolean;
  /** true while the account must replace its password (/change-password) */
  mustChangePassword: boolean;
  hasRole: (role: string) => boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [isDoctor, setIsDoctor] = useState(false);

  useEffect(() => {
    // Roles and the doctor tag: the session route reports both (roles also
    // come with the login answer). Only what is missing is read from
    // user_roles — and never while a password change is pending, since every
    // other API call answers 403 PASSWORD_CHANGE_REQUIRED until then.
    const fetchUserRoles = async (sessionUser: User) => {
      const knownRoles = Array.isArray(sessionUser.roles) ? sessionUser.roles : null;
      const knownDoctor = typeof sessionUser.is_doctor === "boolean" ? sessionUser.is_doctor : null;
      if (knownRoles) setUserRoles(knownRoles);
      if (knownDoctor !== null) setIsDoctor(knownDoctor);
      if ((knownRoles && knownDoctor !== null) || sessionUser.must_change_password) return;
      try {
        const { data, error } = await supabase
          .from("user_roles")
          .select("role, is_doctor")
          .eq("user_id", sessionUser.id);

        if (error) throw error;
        if (!knownRoles) setUserRoles(data?.map((r: { role: string }) => r.role) || []);
        if (knownDoctor === null) setIsDoctor(data?.some((r: { is_doctor?: boolean }) => r.is_doctor) || false);
      } catch (err) {
        console.error("Error fetching user roles:", err);
        if (!knownRoles) setUserRoles([]);
        if (knownDoctor === null) setIsDoctor(false);
      }
    };

    const apply = (next: Session | null) => {
      setSession(next);
      setUser(next?.user ?? null);
      if (next?.user) {
        const sessionUser = next.user;
        // Defer role fetch to avoid recursion
        setTimeout(() => {
          fetchUserRoles(sessionUser);
        }, 0);
      } else {
        setUserRoles([]);
        setIsDoctor(false);
      }
    };

    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        apply(next);
        setLoading(false);
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session: initial } }) => {
      apply(initial);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const hasRole = (role: string) => userRoles.includes(role);
  const mustChangePassword = user?.must_change_password === true;

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, userRoles, isDoctor, mustChangePassword, hasRole, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
