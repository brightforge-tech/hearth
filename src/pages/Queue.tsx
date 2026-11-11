import { BRAND } from "@/lib/brand";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
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

export default function Queue() {
  useMeta(
    `Waiting Queue | ${BRAND.name}`,
    "Live queue of patients checked in and waiting to be seen.",
    window.location.origin + "/queue"
  );

  const { toast } = useToast();
  const { signOut } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const waitingQuery = useQuery({
    queryKey: ["queue-waiting"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select("id, scheduled_start, created_at, reason, patient_id, status, patient:patients(first_name,last_name)")
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
        .select("id, scheduled_start, created_at, reason, patient_id, status, patient:patients(first_name,last_name)")
        .eq("status", "in_progress")
        .order("created_at", { ascending: true });
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
      navigate(`/visit/${id}`);
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message || "Could not update.", variant: "destructive" as any }),
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <nav className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Logo />
          <div className="flex gap-2">
            <Button variant="ghost" asChild><a href="/intake">Intake</a></Button>
            <Button variant="ghost" asChild><a href="/queue">Queue</a></Button>
            <Button variant="ghost" asChild><a href="/billing">Billing</a></Button>
            <Button variant="outline" onClick={() => signOut()}>Sign Out</Button>
          </div>
        </nav>
      </header>

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Patient Queue</h1>
          <p className="text-sm text-muted-foreground">Manage waiting and active patient visits.</p>
        </section>

        <Tabs defaultValue="waiting" className="w-full">
          <TabsList>
            <TabsTrigger value="waiting">
              Waiting ({waitingQuery.data?.length || 0})
            </TabsTrigger>
            <TabsTrigger value="in-progress">
              In Progress ({inProgressQuery.data?.length || 0})
            </TabsTrigger>
          </TabsList>

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
                    </div>
                    <Button onClick={() => startVisit.mutate(a.id)} disabled={startVisit.isPending}>
                      {startVisit.isPending ? "Starting…" : "Start Visit"}
                    </Button>
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
                    </div>
                    <div className="flex gap-2">
                      <Badge className="bg-blue-100 text-blue-800">In Progress</Badge>
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
    </div>
  );
}
