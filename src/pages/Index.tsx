import { BRAND } from "@/lib/brand";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Link } from "react-router-dom";

// Update this page (the content is just a fallback if you fail to update the page)

const Index = () => {
  const { hasRole, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <nav className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Logo />
          <div className="flex gap-2">
            <Link to="/intake" className="underline underline-offset-4">Intake</Link>
            <Link to="/queue" className="underline underline-offset-4">Queue</Link>
            <Link to="/billing" className="underline underline-offset-4">Billing</Link>
            <Link to="/reports" className="underline underline-offset-4">Reports</Link>
            {hasRole("admin") && (
              <Link to="/admin/settings" className="underline underline-offset-4">Admin</Link>
            )}
            <button onClick={() => signOut()} className="underline underline-offset-4">Sign Out</button>
          </div>
        </nav>
      </header>
      <main className="container mx-auto px-4 py-10 text-center">
        <h1 className="text-4xl font-bold mb-4">{BRAND.name}</h1>
        <p className="text-xl text-muted-foreground mb-6">Start at Intake to add patients and manage the waiting queue.</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/intake" className="px-4 py-2 rounded-md border">Go to Intake</Link>
          <Link to="/queue" className="px-4 py-2 rounded-md border">View Queue</Link>
          <Link to="/billing" className="px-4 py-2 rounded-md border">Billing</Link>
          <Link to="/reports" className="px-4 py-2 rounded-md border">Reports</Link>
          {hasRole("admin") && (
            <Link to="/admin/settings" className="px-4 py-2 rounded-md border">Admin Settings</Link>
          )}
        </div>
      </main>
    </div>
  );
};

export default Index;
