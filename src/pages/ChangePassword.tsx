import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BRAND } from "@/lib/brand";
import { supabase } from "@/integrations/supabase/client";
import { apiChangePassword } from "@/lib/api";
import { passwordProblem } from "@/lib/passwordRules";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { PasswordRules } from "@/components/PasswordRules";

/** /change-password: the forced change after an admin-set or temporary
 *  password (must_change_password), and the voluntary change. While the
 *  change is forced, the only other thing on offer is signing out. */
export default function ChangePassword() {
  const { user, mustChangePassword, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = `Change password | ${BRAND.name}`;
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    if (next === current) {
      setError("The new password must be different from the current one.");
      return;
    }
    const problem = passwordProblem(next, user?.email);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const payload = await apiChangePassword({ current_password: current, new_password: next });
      // The answer carries a NEW token; the old one is no longer valid.
      supabase.auth.setSessionFromLogin({ ...payload, must_change_password: false } as never);
      toast({ title: "Password changed", description: "Your new password is now active." });
      setCurrent("");
      setNext("");
      setConfirm("");
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      setError(err?.message || "Could not change the password.");
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <Card className="w-full max-w-md">
      <CardHeader className={mustChangePassword ? "text-center space-y-4" : undefined}>
        {mustChangePassword && <Logo className="h-16 w-auto mx-auto" showText={false} />}
        <div>
          <CardTitle className="text-2xl">Change password</CardTitle>
          <CardDescription>
            {mustChangePassword
              ? "Your password was set by an administrator. Choose a new one to continue."
              : `Signed in as ${user?.email ?? ""}`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <PasswordRules />
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving ? "Saving..." : "Change password"}
            </Button>
            {mustChangePassword ? (
              <Button type="button" variant="outline" onClick={() => signOut()}>
                Sign Out
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );

  if (mustChangePassword) {
    return <div className="min-h-screen flex items-center justify-center bg-background p-4">{form}</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/change-password" />
      <main className="container mx-auto px-4 py-6 flex justify-center">{form}</main>
      <AppFooter />
    </div>
  );
}
