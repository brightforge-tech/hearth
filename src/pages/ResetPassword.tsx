import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BRAND } from "@/lib/brand";
import { apiPasswordResetConfirm, apiPasswordResetRequest } from "@/lib/api";
import { passwordProblem } from "@/lib/passwordRules";
import { useFeatures } from "@/hooks/useFeatures";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { PasswordRules } from "@/components/PasswordRules";

/** /reset-password            -> ask for a reset link by e-mail
 *  /reset-password?token=...  -> choose a new password with the e-mailed token */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const features = useFeatures();
  const [email, setEmail] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = `Reset password | ${BRAND.name}`;
  }, []);

  const requestLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPasswordResetRequest(email.trim());
      setDone("If an account exists for that address, a reset link is on its way.");
    } catch (err: any) {
      setError(err?.message || "Could not request a reset link.");
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    const problem = passwordProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await apiPasswordResetConfirm({ token, new_password: next });
      setDone("Your password has been reset. You can now sign in with the new password.");
    } catch (err: any) {
      setError(err?.message || "Could not reset the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <Logo className="h-16 w-auto mx-auto" showText={false} />
          <div>
            <CardTitle className="text-2xl">Reset password</CardTitle>
            <CardDescription>{BRAND.name}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {done ? (
            <Alert>
              <AlertDescription>{done}</AlertDescription>
            </Alert>
          ) : token ? (
            <form onSubmit={confirmReset} className="space-y-4">
              <div>
                <Label htmlFor="reset-new">New password</Label>
                <Input id="reset-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="reset-confirm">Confirm new password</Label>
                <Input id="reset-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </div>
              <PasswordRules />
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Saving..." : "Set new password"}
              </Button>
            </form>
          ) : features.password_reset_email ? (
            <form onSubmit={requestLink} className="space-y-4">
              <div>
                <Label htmlFor="reset-email">Email</Label>
                <Input id="reset-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending..." : "Send reset link"}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Password reset by e-mail is not enabled. Please ask a clinic administrator to reset your password.
            </p>
          )}
          <p className="text-center text-sm">
            <Link to="/auth" className="underline underline-offset-4">Back to sign in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
