import { BRAND } from "@/lib/brand";
import { useAuth } from "@/hooks/useAuth";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { Link } from "react-router-dom";

const Index = () => {
  const { hasRole } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/" />
      <main className="container mx-auto px-4 py-10 text-center">
        <h1 className="text-4xl font-bold mb-4">{BRAND.name}</h1>
        <p className="text-xl text-muted-foreground mb-6">Start at Intake to add patients and manage the waiting queue.</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/intake" className="px-4 py-2 rounded-md border">Go to Intake</Link>
          <Link to="/queue" className="px-4 py-2 rounded-md border">View Queue</Link>
          {(hasRole("admin") || hasRole("moderator")) && (
            <Link to="/billing" className="px-4 py-2 rounded-md border">Billing</Link>
          )}
          {hasRole("admin") && (
            <Link to="/reports" className="px-4 py-2 rounded-md border">Reports</Link>
          )}
          {hasRole("admin") && (
            <Link to="/admin/settings" className="px-4 py-2 rounded-md border">Admin Settings</Link>
          )}
        </div>
        <p className="mt-6 text-sm">
          <Link to="/change-password" className="underline underline-offset-4 text-muted-foreground">Change your password</Link>
        </p>
      </main>
      <AppFooter />
    </div>
  );
};

export default Index;
