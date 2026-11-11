import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { apiApproveBookingRequest, apiDeclineBookingRequest } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { orSearchTerm } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type BookingStatus = "pending" | "approved" | "declined";

interface BookingRequest {
  id: string;
  status: BookingStatus;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  reason: string | null;
  preferred_date: string | null;
  preferred_time: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  patient_id: string | null;
  appointment_id: string | null;
  decline_reason: string | null;
}

interface PatientMatch {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
}

const STATUSES: BookingStatus[] = ["pending", "approved", "declined"];

const formatDate = (value: string | null) => {
  if (!value) return "—";
  try {
    return format(parseISO(value), "MMM dd, yyyy");
  } catch {
    return value;
  }
};

function useBookingRequests(status: BookingStatus) {
  return useQuery({
    queryKey: ["booking-requests", status],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("booking_requests")
        .select("*")
        .eq("status", status)
        .order(status === "pending" ? "created_at" : "reviewed_at", { ascending: status === "pending" })
        .limit(200);
      if (error) throw error;
      return (data || []) as BookingRequest[];
    },
  });
}

export default function BookingRequests() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<BookingStatus>("pending");
  const [viewing, setViewing] = useState<BookingRequest | null>(null);
  const [approving, setApproving] = useState<BookingRequest | null>(null);
  const [declining, setDeclining] = useState<BookingRequest | null>(null);

  useEffect(() => {
    document.title = `Booking Requests | ${BRAND.name}`;
  }, []);

  const pending = useBookingRequests("pending");
  const approved = useBookingRequests("approved");
  const declined = useBookingRequests("declined");
  const byStatus = { pending, approved, declined };

  // Live updates when a request arrives or another user reviews one.
  useEffect(() => {
    const channel = supabase
      .channel("booking-requests-updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "booking_requests" }, () => {
        qc.invalidateQueries({ queryKey: ["booking-requests"] });
        qc.invalidateQueries({ queryKey: ["booking-requests-pending-count"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["booking-requests"] });
    qc.invalidateQueries({ queryKey: ["booking-requests-pending-count"] });
    qc.invalidateQueries({ queryKey: ["queue-scheduled"] });
    qc.invalidateQueries({ queryKey: ["calendar-appointments"] });
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/bookings" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Booking Requests</h1>
          <p className="text-sm text-muted-foreground">
            Appointment requests from the public website. Approving one creates (or links) the patient and schedules the appointment.
          </p>
        </section>

        <Tabs value={tab} onValueChange={(v) => setTab(v as BookingStatus)} className="w-full">
          <TabsList>
            <TabsTrigger value="pending">Pending ({pending.data?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="declined">Declined</TabsTrigger>
          </TabsList>

          {STATUSES.map((status) => {
            const query = byStatus[status];
            return (
              <TabsContent key={status} value={status} className="space-y-4">
                {query.isLoading && <div className="text-sm text-muted-foreground">Loading requests…</div>}
                {query.error && (
                  <div className="text-sm text-destructive">Could not load requests: {(query.error as Error).message}</div>
                )}
                {query.data?.length === 0 && !query.isLoading && (
                  <Card>
                    <CardHeader>
                      <CardTitle>No {status} requests</CardTitle>
                      <CardDescription>
                        {status === "pending" ? "New requests from the website will appear here." : "Nothing here yet."}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                )}
                <div className="grid gap-4">
                  {query.data?.map((r) => (
                    <Card key={r.id}>
                      <CardHeader className="flex flex-row items-start justify-between gap-4">
                        <div className="space-y-1">
                          <CardTitle className="text-base">
                            {r.first_name} {r.last_name}
                          </CardTitle>
                          <CardDescription>Reason: {r.reason || "—"}</CardDescription>
                          <div className="text-xs text-muted-foreground">
                            Preferred: {formatDate(r.preferred_date)} {r.preferred_time || ""}
                            {" · "}Received: {new Date(r.created_at).toLocaleString()}
                          </div>
                          {r.status === "declined" && r.decline_reason && (
                            <div className="text-xs text-muted-foreground">Decline reason: {r.decline_reason}</div>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 justify-end">
                          <Badge variant={r.status === "pending" ? "secondary" : r.status === "approved" ? "default" : "outline"}>
                            {r.status}
                          </Badge>
                          <Button variant="ghost" size="sm" onClick={() => setViewing(r)}>
                            Details
                          </Button>
                          {r.status === "pending" && (
                            <>
                              <Button variant="outline" size="sm" onClick={() => setDeclining(r)}>
                                Decline
                              </Button>
                              <Button size="sm" onClick={() => setApproving(r)}>
                                Approve
                              </Button>
                            </>
                          )}
                        </div>
                      </CardHeader>
                    </Card>
                  ))}
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
      </main>

      <DetailsDialog request={viewing} onClose={() => setViewing(null)} />
      <ApproveDialog
        request={approving}
        onClose={() => setApproving(null)}
        onDone={() => {
          setApproving(null);
          refresh();
        }}
        toast={toast}
      />
      <DeclineDialog
        request={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          setDeclining(null);
          refresh();
        }}
        toast={toast}
      />
      <AppFooter />
    </div>
  );
}

function DetailsDialog({ request, onClose }: { request: BookingRequest | null; onClose: () => void }) {
  const rows: Array<[string, string]> = request
    ? [
        ["Name", `${request.first_name} ${request.last_name}`],
        ["Email", request.email || "—"],
        ["Phone", request.phone || "—"],
        ["Date of birth", formatDate(request.date_of_birth)],
        ["Reason", request.reason || "—"],
        ["Preferred date", formatDate(request.preferred_date)],
        ["Preferred time", request.preferred_time || "—"],
        ["Received", new Date(request.created_at).toLocaleString()],
        ["Status", request.status],
        ["Reviewed", request.reviewed_at ? new Date(request.reviewed_at).toLocaleString() : "—"],
        ...(request.decline_reason ? ([["Decline reason", request.decline_reason]] as Array<[string, string]>) : []),
      ]
    : [];
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Booking request</DialogTitle>
          <DialogDescription>Submitted through the public website.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="col-span-2 whitespace-pre-wrap break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

type ToastFn = ReturnType<typeof useToast>["toast"];

function ApproveDialog({
  request,
  onClose,
  onDone,
  toast,
}: {
  request: BookingRequest | null;
  onClose: () => void;
  onDone: () => void;
  toast: ToastFn;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [search, setSearch] = useState("");
  const [patient, setPatient] = useState<PatientMatch | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  // Reset the form for each request opened.
  useEffect(() => {
    if (request) {
      setMode("new");
      setSearch(`${request.first_name} ${request.last_name}`);
      setPatient(null);
      setDate(request.preferred_date || "");
      setTime(request.preferred_time || "");
    }
  }, [request]);

  const term = orSearchTerm(search);
  const matches = useQuery({
    queryKey: ["booking-patient-search", term],
    enabled: !!request && mode === "existing" && term.length > 0,
    queryFn: async () => {
      // Each word must match a first or last name ("Ada Example" finds Ada Example).
      const words = term.split(" ").filter(Boolean).slice(0, 3);
      let q = supabase.from("patients").select("id, first_name, last_name, date_of_birth, phone, email");
      if (words.length === 1) {
        q = q.or(`first_name.ilike.%${words[0]}%,last_name.ilike.%${words[0]}%`);
      } else {
        q = q.ilike("first_name", `%${words[0]}%`).ilike("last_name", `%${words[words.length - 1]}%`);
      }
      const { data, error } = await q.order("last_name").limit(10);
      if (error) throw error;
      return (data || []) as PatientMatch[];
    },
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!request) throw new Error("No request selected");
      if (mode === "existing" && !patient) throw new Error("Select the existing patient to link, or choose \"Create new patient\".");
      const changed = date !== (request.preferred_date || "") || time !== (request.preferred_time || "");
      let scheduledStart: string | undefined;
      if (changed) {
        if (!date || !time) throw new Error("Give both a date and a time.");
        const local = new Date(`${date}T${time}:00`);
        if (Number.isNaN(local.getTime())) throw new Error("The date or time is not valid.");
        scheduledStart = local.toISOString();
      }
      return apiApproveBookingRequest(request.id, {
        ...(mode === "existing" && patient ? { patient_id: patient.id } : {}),
        ...(scheduledStart ? { scheduled_start: scheduledStart } : {}),
      });
    },
    onSuccess: () => {
      toast({ title: "Request approved", description: "The appointment has been scheduled." });
      onDone();
    },
    onError: (e: any) => {
      toast({ title: "Could not approve", description: e?.message || "Please try again.", variant: "destructive" });
      if (e?.status === 409) onDone();
    },
  });

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Approve request</DialogTitle>
          <DialogDescription>
            {request ? `${request.first_name} ${request.last_name}` : ""} — choose the patient record and confirm the time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "new" | "existing")} className="space-y-1">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="new" id="approve-new" />
              <Label htmlFor="approve-new">Create new patient from this request</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="existing" id="approve-existing" />
              <Label htmlFor="approve-existing">Link to an existing patient</Label>
            </div>
          </RadioGroup>

          {mode === "existing" && (
            <div className="space-y-2">
              <Label htmlFor="approve-search">Find patient by name</Label>
              <Input
                id="approve-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPatient(null);
                }}
                placeholder="First and/or last name"
              />
              {matches.isLoading && <div className="text-xs text-muted-foreground">Searching…</div>}
              {matches.data && matches.data.length === 0 && (
                <div className="text-xs text-muted-foreground">No matching patients.</div>
              )}
              {matches.data && matches.data.length > 0 && (
                <div className="border rounded-md max-h-40 overflow-y-auto">
                  {matches.data.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`w-full text-left p-2 text-sm hover:bg-muted ${patient?.id === p.id ? "bg-muted" : ""}`}
                      onClick={() => setPatient(p)}
                    >
                      <div className="font-medium">
                        {p.first_name} {p.last_name}
                        {patient?.id === p.id && <Badge className="ml-2">Selected</Badge>}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        DOB {formatDate(p.date_of_birth)} · {p.phone || "no phone"} · {p.email || "no email"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="approve-date">Date</Label>
              <Input id="approve-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="approve-time">Time</Label>
              <Input id="approve-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Defaults to the requested date and time; change them to schedule a different slot.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approve.isPending ? "Approving..." : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({
  request,
  onClose,
  onDone,
  toast,
}: {
  request: BookingRequest | null;
  onClose: () => void;
  onDone: () => void;
  toast: ToastFn;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (request) setReason("");
  }, [request]);

  const decline = useMutation({
    mutationFn: async () => {
      if (!request) throw new Error("No request selected");
      return apiDeclineBookingRequest(request.id, reason.trim() || undefined);
    },
    onSuccess: () => {
      toast({ title: "Request declined" });
      onDone();
    },
    onError: (e: any) => {
      toast({ title: "Could not decline", description: e?.message || "Please try again.", variant: "destructive" });
      if (e?.status === 409) onDone();
    },
  });

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Decline request</DialogTitle>
          <DialogDescription>
            {request ? `${request.first_name} ${request.last_name}` : ""}. Remember to let the person know if they left contact details.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="decline-reason">Reason (optional, kept with the request)</Label>
          <Textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => decline.mutate()} disabled={decline.isPending}>
            {decline.isPending ? "Declining..." : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
