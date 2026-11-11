import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link, useNavigate } from "react-router-dom";
import { takeAuthNotice } from "@/integrations/supabase/shim/auth";
import { useFeatures } from "@/hooks/useFeatures";
import { Logo } from "@/components/Logo";

function useMeta(title: string, description: string, canonical: string) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector('meta[name="description"]') || document.createElement("meta");
    meta.setAttribute("name", "description");
    meta.setAttribute("content", description);
    if (!meta.parentNode) document.head.appendChild(meta);
    let link: HTMLLinkElement | null = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", canonical);
  }, [title, description, canonical]);
}

export default function Auth() {
  useMeta(
    `Login | ${BRAND.name}`,
    "Sign in to access the medical practice management system.",
    window.location.origin + "/auth"
  );

  const navigate = useNavigate();
  const { toast } = useToast();
  const features = useFeatures();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A one-shot notice left by the app when it dropped a dead session.
  const [notice] = useState<string | null>(() => takeAuthNotice());

  useEffect(() => {
    // Check if user is already logged in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate(session.user?.must_change_password ? "/change-password" : "/dashboard");
      }
    });
  }, [navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      if (data.session?.user?.must_change_password) {
        toast({ title: "Password change required", description: "Please choose a new password to continue." });
        navigate("/change-password");
        return;
      }
      toast({ title: "Success", description: "Signed in successfully!" });
      navigate("/dashboard");
    } catch (error: any) {
      // LOGIN_LOCKED (429) and INVALID_CREDENTIALS carry the server's own
      // message; show it as is.
      const message = error?.message || "Failed to sign in";
      setError(message);
      toast({
        title: error?.code === "LOGIN_LOCKED" ? "Too many attempts" : "Error",
        description: message,
        variant: "destructive" as any,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <Logo className="h-16 w-auto mx-auto" showText={false} />
          <div>
            <CardTitle className="text-2xl">Welcome Back</CardTitle>
            <CardDescription>Sign in to {BRAND.name}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {notice && (
            <Alert className="mb-4">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <Label htmlFor="signin-email">Email</Label>
              <Input
                id="signin-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="signin-password">Password</Label>
              <Input
                id="signin-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-muted-foreground space-y-1">
            {features.password_reset_email && (
              <p>
                <Link to="/reset-password" className="underline underline-offset-4">Forgot password?</Link>
              </p>
            )}
            <p>Staff accounts are created by a clinic administrator.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
