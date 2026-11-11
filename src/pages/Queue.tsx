import { BRAND } from "@/lib/brand";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { PatientVisitHistory } from "@/components/PatientVisitHistory";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

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

export default function Queue() {
  useMeta(
    `Waiting Queue | ${BRAND.name}`,
    "Live queue of patients checked in and waiting to be seen.",
    window.location.origin + "/queue"
  );

  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const waitingQuery = useQuery({
    queryKey: ["queue-waiting"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("id, scheduled_start, created_at, reason, intake_notes, patient_id, status, patient:patients(first_name,last_name)")
        .eq("status", "waiting")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as any[];
    },
  });

  const inProgressQuery = useQuery({
    queryKey: ["queue-in-progress"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("id, scheduled_start, created_at, reason, intake_notes, patient_id, status, patient:patients(first_name,last_name)")
        .eq("status", "in_progress")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as any[];
    },
  });

  const scheduledQuery = useQuery({
    queryKey: ["queue-scheduled"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("id, scheduled_start, created_at, reason, intake_notes, patient_id, status, customer_type, patient:patients(first_name,last_name)")
        .eq("status", "scheduled")
        .order("scheduled_start", { ascending: true });
      if (error) throw error;
      return data as any[];
    },
  });

  // Real-time subscriptions for live updates
  useEffect(() => {
    const channel = supabase
      .channel('queue-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'appointments'
        },
        () => {
          // Invalidate queries to refetch data when appointments change
          qc.invalidateQueries({ queryKey: ["queue-waiting"] });
          qc.invalidateQueries({ queryKey: ["queue-in-progress"] });
          qc.invalidateQueries({ queryKey: ["queue-scheduled"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const startVisit = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("appointments").update({ status: "in_progress" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      toast({ title: "Visit started", description: "Patient moved to in-progress." });
      qc.invalidateQueries({ queryKey: ["queue-waiting"] });
      qc.invalidateQueries({ queryKey: ["queue-in-progress"] });
      qc.invalidateQueries({ queryKey: ["queue-scheduled"] });
      navigate(`/visit/${id}`);
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not update.", variant: "destructive" as any }),
  });

  const checkInAppointment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("appointments").update({ status: "waiting" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Patient checked in", description: "Appointment moved to waiting queue." });
      qc.invalidateQueries({ queryKey: ["queue-waiting"] });
      qc.invalidateQueries({ queryKey: ["queue-scheduled"] });
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not check in.", variant: "destructive" as any }),
  });

  const cancelAppointment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("appointments").update({ status: "canceled" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Appointment cancelled", description: "Appointment has been cancelled." });
      qc.invalidateQueries({ queryKey: ["queue-waiting"] });
      qc.invalidateQueries({ queryKey: ["queue-scheduled"] });
      qc.invalidateQueries({ queryKey: ["queue-in-progress"] });
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not cancel appointment.", variant: "destructive" as any }),
  });

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/queue" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Patient Queue</h1>
          <p className="text-sm text-muted-foreground">Manage waiting and active patient visits.</p>
        </section>

        <Tabs defaultValue="scheduled" className="w-full">
          <TabsList>
            <TabsTrigger value="scheduled">
              Scheduled ({scheduledQuery.data?.length || 0})
            </TabsTrigger>
            <TabsTrigger value="waiting">
              Waiting ({waitingQuery.data?.length || 0})
            </TabsTrigger>
            <TabsTrigger value="in-progress">
              In Progress ({inProgressQuery.data?.length || 0})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="scheduled" className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">Scheduled Appointments</h2>
              <Badge variant="outline">{scheduledQuery.data?.length || 0} scheduled</Badge>
            </div>

            <div className="grid gap-4">
              {scheduledQuery.isLoading && <div className="text-sm text-muted-foreground">Loading scheduled appointments…</div>}
              {scheduledQuery.data?.length === 0 && !scheduledQuery.isLoading && (
                <Card>
                  <CardHeader>
                    <CardTitle>No scheduled appointments</CardTitle>
                    <CardDescription>Scheduled appointments will appear here.</CardDescription>
                  </CardHeader>
                </Card>
              )}

              {scheduledQuery.data?.map((a: any) => (
                <Card key={a.id}>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">
                        {a.patient?.first_name} {a.patient?.last_name}
                      </CardTitle>
                      <CardDescription>Reason: {a.reason || "—"}</CardDescription>
                      {a.intake_notes && (
                        <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                          <span className="font-medium">Intake notes:</span> {a.intake_notes}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Badge variant="secondary">{a.customer_type}</Badge>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            View History
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                          <DialogHeader>
                            <DialogTitle>Patient Visit History</DialogTitle>
                            <DialogDescription>
                              Clinical notes and visit records for {a.patient?.first_name} {a.patient?.last_name}
                            </DialogDescription>
                          </DialogHeader>
                          <PatientVisitHistory 
                            patientId={a.patient_id} 
                            patientName={`${a.patient?.first_name} ${a.patient?.last_name}`}
                          />
                        </DialogContent>
                      </Dialog>
                      <Button variant="outline" size="sm" onClick={() => cancelAppointment.mutate(a.id)} disabled={cancelAppointment.isPending}>
                        {cancelAppointment.isPending ? "Cancelling…" : "Cancel"}
                      </Button>
                      <Button onClick={() => checkInAppointment.mutate(a.id)} disabled={checkInAppointment.isPending}>
                        {checkInAppointment.isPending ? "Checking In…" : "Check In"}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">
                      Scheduled: {new Date(a.scheduled_start).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Created: {new Date(a.created_at).toLocaleString()}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="waiting" className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">Waiting Patients</h2>
              <Badge variant="outline">{waitingQuery.data?.length || 0} patients</Badge>
            </div>

            <div className="grid gap-4">
              {waitingQuery.isLoading && <div className="text-sm text-muted-foreground">Loading queue…</div>}
              {waitingQuery.data?.length === 0 && !waitingQuery.isLoading && (
                <Card>
                  <CardHeader>
                    <CardTitle>No patients waiting</CardTitle>
                    <CardDescription>Go to Intake to check-in a patient.</CardDescription>
                  </CardHeader>
                </Card>
              )}

              {waitingQuery.data?.map((a: any) => (
                <Card key={a.id}>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">
                        {a.patient?.first_name} {a.patient?.last_name}
                      </CardTitle>
                      <CardDescription>Reason: {a.reason || "—"}</CardDescription>
                      {a.intake_notes && (
                        <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                          <span className="font-medium">Intake notes:</span> {a.intake_notes}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            View History
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                          <DialogHeader>
                            <DialogTitle>Patient Visit History</DialogTitle>
                            <DialogDescription>
                              Clinical notes and visit records for {a.patient?.first_name} {a.patient?.last_name}
                            </DialogDescription>
                          </DialogHeader>
                          <PatientVisitHistory 
                            patientId={a.patient_id} 
                            patientName={`${a.patient?.first_name} ${a.patient?.last_name}`}
                          />
                        </DialogContent>
                      </Dialog>
                      <Button variant="outline" size="sm" onClick={() => cancelAppointment.mutate(a.id)} disabled={cancelAppointment.isPending}>
                        {cancelAppointment.isPending ? "Cancelling…" : "Cancel"}
                      </Button>
                      <Button onClick={() => startVisit.mutate(a.id)} disabled={startVisit.isPending}>
                        {startVisit.isPending ? "Starting…" : "Start Visit"}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">
                      Checked-in: {new Date(a.created_at).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Scheduled: {new Date(a.scheduled_start).toLocaleString()}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="in-progress" className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">Active Visits</h2>
              <Badge variant="outline">{inProgressQuery.data?.length || 0} active</Badge>
            </div>

            <div className="grid gap-4">
              {inProgressQuery.isLoading && <div className="text-sm text-muted-foreground">Loading active visits…</div>}
              {inProgressQuery.data?.length === 0 && !inProgressQuery.isLoading && (
                <Card>
                  <CardHeader>
                    <CardTitle>No active visits</CardTitle>
                    <CardDescription>Start a visit from the waiting queue.</CardDescription>
                  </CardHeader>
                </Card>
              )}

              {inProgressQuery.data?.map((a: any) => (
                <Card key={a.id} className="border-blue-200 bg-blue-50">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">
                        {a.patient?.first_name} {a.patient?.last_name}
                      </CardTitle>
                      <CardDescription>Reason: {a.reason || "—"}</CardDescription>
                      {a.intake_notes && (
                        <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                          <span className="font-medium">Intake notes:</span> {a.intake_notes}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Badge className="bg-blue-100 text-blue-800">In Progress</Badge>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            View History
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                          <DialogHeader>
                            <DialogTitle>Patient Visit History</DialogTitle>
                            <DialogDescription>
                              Clinical notes and visit records for {a.patient?.first_name} {a.patient?.last_name}
                            </DialogDescription>
                          </DialogHeader>
                          <PatientVisitHistory 
                            patientId={a.patient_id} 
                            patientName={`${a.patient?.first_name} ${a.patient?.last_name}`}
                          />
                        </DialogContent>
                      </Dialog>
                      <Button variant="outline" size="sm" onClick={() => cancelAppointment.mutate(a.id)} disabled={cancelAppointment.isPending}>
                        {cancelAppointment.isPending ? "Cancelling…" : "Cancel"}
                      </Button>
                      <Button onClick={() => navigate(`/visit/${a.id}`)}>
                        Continue Visit
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">
                      Started: {new Date(a.created_at).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Scheduled: {new Date(a.scheduled_start).toLocaleString()}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </main>
      <AppFooter />
    </div>
  );
}
