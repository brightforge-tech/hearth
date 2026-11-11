import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Link } from "react-router-dom";

interface NavigationProps {
  currentPage?: string;
}

export function Navigation({ currentPage }: NavigationProps) {
  const { signOut, hasRole } = useAuth();

  const navItems = [
    { href: "/intake", label: "Intake", roles: ["admin", "user", "moderator"] },
    { href: "/queue", label: "Queue", roles: ["admin", "user", "moderator"] },
    { href: "/billing", label: "Billing", roles: ["admin", "moderator"] },
    { href: "/reports", label: "Reports", roles: ["admin"] },
    { href: "/exports", label: "Exports", roles: ["admin"] },
    { href: "/admin/settings", label: "Settings", roles: ["admin"] },
  ];

  const visibleItems = navItems.filter(item => 
    item.roles.some(role => hasRole(role))
  );

  return (
    <header className="border-b">
      <nav className="container mx-auto px-4 py-3 flex items-center justify-between">
        <Logo />
        <div className="flex gap-2">
          {visibleItems.map((item) => (
            <Button 
              key={item.href}
              variant={currentPage === item.href ? "default" : "ghost"} 
              asChild
            >
              <Link to={item.href}>{item.label}</Link>
            </Button>
          ))}
          <Button variant="outline" onClick={() => signOut()}>
            Sign Out
          </Button>
        </div>
      </nav>
    </header>
  );
}