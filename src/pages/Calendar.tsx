import { useEffect } from "react";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { AppointmentCalendar } from "@/components/calendar/AppointmentCalendar";
import { BRAND } from "@/lib/brand";

export default function Calendar() {
  useEffect(() => {
    document.title = `Appointment Calendar | ${BRAND.name}`;
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/calendar" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Appointment Calendar</h1>
          <p className="text-sm text-muted-foreground">View and manage patient appointments in calendar format.</p>
        </section>

        <AppointmentCalendar />
      </main>
      <AppFooter />
    </div>
  );
}
