
import { BRAND } from "@/lib/brand";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Navigation } from "@/components/Navigation";

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

export default function Intake() {
  useMeta(
    `Patient Intake and Scheduling | ${BRAND.name}`,
    "Create new or returning patient appointments, check-in now or schedule future visits.",
    window.location.origin + "/intake"
  );

  const navigate = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [patientType, setPatientType] = useState<"new" | "returning">("returning");
  const [search, setSearch] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [when, setWhen] = useState<"now" | "future">("now");
  const [futureDateTime, setFutureDateTime] = useState<string>("");
  const [customerType, setCustomerType] = useState<"walk-in" | "appointment">("walk-in");

  // New patient fields
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    date_of_birth: "",
    sex: undefined as string | undefined,
    phone: "",
    email: "",
    address: "",
    national_id: "",
    drivers_permit: "",
    reason: "",
  });

  const debounced = useMemo(() => search.trim(), [search]);

  const patientsQuery = useQuery({
    queryKey: ["patients-search", debounced],
    queryFn: async () => {
      if (!debounced) return [] as any[];
      const { data, error } = await supabase
        .from("patients")
        .select("id, first_name, last_name, national_id, drivers_permit")
        .or(
          `first_name.ilike.%${debounced}%,last_name.ilike.%${debounced}%,national_id.ilike.%${debounced}%,drivers_permit.ilike.%${debounced}%`
        )
        .limit(10);
      if (error) throw error;
      return data as any[];
    },
    enabled: patientType === "returning" && !!debounced,
  });

  const validateForm = () => {
    if (patientType === "new") {
      // Check mandatory fields
      if (!form.first_name.trim()) throw new Error("First name is required");
      if (!form.last_name.trim()) throw new Error("Last name is required");
      if (!form.date_of_birth) throw new Error("Date of birth is required");
      if (!form.sex) throw new Error("Sex is required");
      if (!form.phone.trim()) throw new Error("Phone is required");
      if (!form.email.trim()) throw new Error("Email is required");
      if (!form.address.trim()) throw new Error("Address is required");
      
      // Check that either National ID or Driver's Permit is provided
      if (!form.national_id.trim() && !form.drivers_permit.trim()) {
        throw new Error("Either National ID or Driver's Permit is required");
      }
    }
    
    if (!form.reason.trim()) throw new Error("Please enter a reason/complaint");
  };

  const createAppointment = useMutation({
    mutationFn: async () => {
      validateForm();
      
      let patientId = selectedPatientId;
      if (patientType === "new") {
        const { data: p, error: pe } = await supabase
          .from("patients")
          .insert({
            first_name: form.first_name,
            last_name: form.last_name,
            date_of_birth: form.date_of_birth || null,
            sex: form.sex || null,
            phone: form.phone || null,
            email: form.email || null,
            address: form.address || null,
            national_id: form.national_id || null,
            drivers_permit: form.drivers_permit || null,
          })
          .select("id")
          .maybeSingle();
        if (pe) throw pe;
        if (!p) throw new Error("Failed to create patient");
        patientId = p.id;
      }

      if (!patientId) throw new Error("Select a patient");

      const scheduled_start = when === "now" ? new Date().toISOString() : new Date(futureDateTime).toISOString();
      const status = when === "now" ? "waiting" : "scheduled";

      const { error: ae } = await supabase.from("appointments").insert({
        patient_id: patientId,
        scheduled_start,
        status,
        reason: form.reason,
        customer_type: customerType,
      });
      if (ae) throw ae;
    },
    onSuccess: () => {
      toast({ title: "Saved", description: when === "now" ? "Patient checked in and added to queue." : "Appointment scheduled." });
      qc.invalidateQueries({ queryKey: ["queue-waiting"] });
      if (when === "now") navigate("/queue");
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Could not save.", variant: "destructive" as any });
    },
  });

  return (
    <div>
      <Navigation currentPage="/intake" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Patient Intake and Scheduling</h1>
          <p className="text-sm text-muted-foreground">Register new patients or find returning ones, then check-in now or schedule a future visit.</p>
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Patient Type</CardTitle>
              <CardDescription>Select new or returning patient</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant={patientType === "returning" ? "default" : "outline"} onClick={() => setPatientType("returning")}>Returning</Button>
                <Button variant={patientType === "new" ? "default" : "outline"} onClick={() => setPatientType("new")}>New</Button>
              </div>

              {patientType === "returning" ? (
                <div>
                  <Label htmlFor="search">Search patient</Label>
                  <Input id="search" placeholder="Name, National ID, Driver's Permit" value={search} onChange={(e) => setSearch(e.target.value)} />
                  {debounced && (
                    <div className="mt-2 border rounded-md divide-y">
                      {patientsQuery.isLoading && <div className="p-3 text-sm">Searching…</div>}
                      {patientsQuery.data?.length === 0 && !patientsQuery.isLoading && (
                        <div className="p-3 text-sm text-muted-foreground">No matches</div>
                      )}
                      {patientsQuery.data?.map((p: any) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedPatientId(p.id)}
                          className={`w-full text-left p-3 hover:bg-muted ${selectedPatientId === p.id ? "bg-muted" : ""}`}
                        >
                          <div className="font-medium">{p.first_name} {p.last_name}</div>
                          <div className="text-xs text-muted-foreground">{p.national_id || p.drivers_permit || ""}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedPatientId && (
                    <div className="text-xs text-muted-foreground mt-2">Selected patient ID: {selectedPatientId}</div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="first_name">First name *</Label>
                    <Input id="first_name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
                  </div>
                  <div>
                    <Label htmlFor="last_name">Last name *</Label>
                    <Input id="last_name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
                  </div>
                  <div>
                    <Label htmlFor="dob">Date of birth *</Label>
                    <Input id="dob" type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} required />
                  </div>
                  <div>
                    <Label>Sex *</Label>
                    <Select value={form.sex} onValueChange={(v) => setForm({ ...form, sex: v })} required>
                      <SelectTrigger>
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="M">Male</SelectItem>
                        <SelectItem value="F">Female</SelectItem>
                        <SelectItem value="Other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone *</Label>
                    <Input id="phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
                  </div>
                  <div>
                    <Label htmlFor="email">Email *</Label>
                    <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                  </div>
                  <div className="md:col-span-2">
                    <Label htmlFor="address">Address *</Label>
                    <Input id="address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
                  </div>
                  <div>
                    <Label htmlFor="national_id">National ID</Label>
                    <Input id="national_id" value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} />
                    <p className="text-xs text-muted-foreground mt-1">Either National ID or Driver's Permit required</p>
                  </div>
                  <div>
                    <Label htmlFor="drivers_permit">Driver's Permit</Label>
                    <Input id="drivers_permit" value={form.drivers_permit} onChange={(e) => setForm({ ...form, drivers_permit: e.target.value })} />
                    <p className="text-xs text-muted-foreground mt-1">Either National ID or Driver's Permit required</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Visit Details</CardTitle>
              <CardDescription>Reason and timing</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="reason">Reason / Complaint *</Label>
                <Textarea id="reason" placeholder="Short description for triage" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
              </div>

              <div>
                <Label>Customer Type *</Label>
                <div className="flex gap-2">
                  <Button type="button" variant={customerType === "walk-in" ? "default" : "outline"} onClick={() => setCustomerType("walk-in")}>Walk-in</Button>
                  <Button type="button" variant={customerType === "appointment" ? "default" : "outline"} onClick={() => setCustomerType("appointment")}>Appointment</Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Walk-in for immediate care, Appointment for scheduled visits</p>
              </div>

              <div className="flex gap-2">
                <Button variant={when === "now" ? "default" : "outline"} onClick={() => setWhen("now")}>Check-in now</Button>
                <Button variant={when === "future" ? "default" : "outline"} onClick={() => setWhen("future")}>Schedule</Button>
              </div>

              {when === "future" && (
                <div>
                  <Label htmlFor="datetime">Date & Time</Label>
                  <Input id="datetime" type="datetime-local" value={futureDateTime} onChange={(e) => setFutureDateTime(e.target.value)} />
                  <p className="text-xs text-muted-foreground mt-1">Default duration is applied automatically.</p>
                </div>
              )}

              <div className="pt-2">
                <Button onClick={() => createAppointment.mutate()} disabled={createAppointment.isPending}>
                  {createAppointment.isPending ? "Saving…" : when === "now" ? "Check In" : "Schedule"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
