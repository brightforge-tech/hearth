import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface NavigationProps {
  currentPage?: string;
}

const STAFF = ["admin", "user", "moderator"];

export function Navigation({ currentPage }: NavigationProps) {
  const { signOut, hasRole, userRoles } = useAuth();
  const isStaff = STAFF.some((role) => userRoles.includes(role));

  // Pending booking requests, for the badge on "Bookings". One small query,
  // refreshed every minute; a failure just hides the badge.
  const pendingBookingsQuery = useQuery({
    queryKey: ["booking-requests-pending-count"],
    enabled: isStaff,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("booking_requests")
        .select("id")
        .eq("status", "pending")
        .limit(100);
      if (error) throw error;
      return (data as unknown[] | null)?.length ?? 0;
    },
  });
  const pendingBookings = pendingBookingsQuery.data ?? 0;

  const navItems = [
    { href: "/intake", label: "Intake", roles: STAFF },
    { href: "/queue", label: "Queue", roles: STAFF },
    { href: "/calendar", label: "Calendar", roles: STAFF },
    { href: "/patients", label: "Patients", roles: STAFF },
    { href: "/bookings", label: "Bookings", roles: STAFF },
    { href: "/billing", label: "Billing", roles: ["admin", "moderator"] },
    { href: "/expenses", label: "Expenses", roles: ["admin", "moderator"] },
    { href: "/reports", label: "Reports", roles: ["admin"] },
    { href: "/exports", label: "Exports", roles: ["admin"] },
    { href: "/admin/audit", label: "Audit log", roles: ["admin"] },
    { href: "/admin/settings", label: "Settings", roles: ["admin"] },
  ];

  const visibleItems = navItems.filter(item =>
    item.roles.some(role => hasRole(role))
  );

  return (
    <header className="border-b">
      <nav className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <Logo />
        <div className="flex flex-wrap gap-2 justify-end">
          {visibleItems.map((item) => (
            <Button
              key={item.href}
              variant={currentPage === item.href ? "default" : "ghost"}
              asChild
            >
              <Link to={item.href}>
                {item.label}
                {item.href === "/bookings" && pendingBookings > 0 && (
                  <Badge variant="destructive" className="ml-2 px-1.5 py-0 text-xs" aria-label={`${pendingBookings} pending`}>
                    {pendingBookings >= 100 ? "99+" : pendingBookings}
                  </Badge>
                )}
              </Link>
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
