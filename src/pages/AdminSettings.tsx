import { BRAND } from "@/lib/brand";
import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Search, Calendar, User } from "lucide-react";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { PasswordRules } from "@/components/PasswordRules";
import { passwordProblem } from "@/lib/passwordRules";
import { apiAdminResetPassword } from "@/lib/api";
import { PRODUCT } from "@/lib/brand";
import { useToast } from "@/hooks/use-toast";

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

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  moderator: "Billing / Front office",
  user: "Clinical staff",
};

export default function AdminSettings() {
  useMeta(
    `Admin Settings | ${BRAND.name}`,
    "Configure clinic settings, working hours, tax rates, and service pricing.",
    window.location.origin + "/admin/settings"
  );

  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["clinic-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clinic_settings")
        .select("*")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const servicesQuery = useQuery({
    queryKey: ["services-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .order("name");
      if (error) throw error;
      return data as any[];
    },
  });

  const usersQuery = useQuery({
    queryKey: ["users-admin"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_users_with_roles');
      if (error) throw error;
      return data as Array<{
        user_id: string;
        email: string;
        created_at: string;
        role: "admin" | "moderator" | "user";
        is_doctor: boolean;
        must_change_password?: boolean;
        last_login_at?: string | null;
      }>;
    },
  });

  const patientsQuery = useQuery({
    queryKey: ["patients-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select(`
          *,
          appointments(
            id,
            reason,
            status,
            scheduled_start,
            visit_notes(notes)
          )
        `)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  // Real-time subscriptions for admin data
  useEffect(() => {
    const settingsChannel = supabase
      .channel('settings-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'clinic_settings'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["clinic-settings"] });
        }
      )
      .subscribe();

    const servicesChannel = supabase
      .channel('admin-services-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'services'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["services-admin"] });
        }
      )
      .subscribe();

    const usersChannel = supabase
      .channel('users-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_roles'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["users-admin"] });
        }
      )
      .subscribe();

    const patientsChannel = supabase
      .channel('patients-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'patients'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["patients-admin"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(settingsChannel);
      supabase.removeChannel(servicesChannel);
      supabase.removeChannel(usersChannel);
      supabase.removeChannel(patientsChannel);
    };
  }, [qc]);

  const updateSettings = useMutation({
    mutationFn: async (settings: any) => {
      const { error } = await supabase
        .from("clinic_settings")
        .update(settings)
        .eq("singleton", true);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Settings updated", description: "Clinic settings saved successfully." });
      qc.invalidateQueries({ queryKey: ["clinic-settings"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to save settings.", variant: "destructive" as any });
    },
  });

  const updateService = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const { error } = await supabase
        .from("services")
        .update(data)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Service updated", description: "Service saved successfully." });
      qc.invalidateQueries({ queryKey: ["services-admin"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to save service.", variant: "destructive" as any });
    },
  });

  const deleteService = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("services")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Service deleted", description: "Service removed successfully." });
      qc.invalidateQueries({ queryKey: ["services-admin"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to delete service.", variant: "destructive" as any });
    },
  });

  const addService = useMutation({
    mutationFn: async (data: any) => {
      const { error } = await supabase
        .from("services")
        .insert([data]);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Service added", description: "New service created successfully." });
      qc.invalidateQueries({ queryKey: ["services-admin"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to add service.", variant: "destructive" as any });
    },
  });

  const addUser = useMutation({
    mutationFn: async (data: { email: string; password: string; role: "user" | "admin" | "moderator" }) => {
      const problem = passwordProblem(data.password, data.email);
      if (problem) throw new Error(problem);
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: true,
      });
      if (authError) throw authError;

      if (authData.user) {
        const { error: roleError } = await supabase
          .from("user_roles")
          .insert({ user_id: authData.user.id, role: data.role });
        if (roleError) throw roleError;
      }
    },
    onSuccess: () => {
      toast({ title: "User added", description: "New user created. They must choose a new password at first sign-in." });
      qc.invalidateQueries({ queryKey: ["users-admin"] });
      setNewUser({ email: "", password: "", role: "user" });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to add user.", variant: "destructive" as any });
    },
  });

  const updateUserRole = useMutation({
    mutationFn: async ({ userId, newRole, isDoctor }: { userId: string; newRole: "user" | "admin" | "moderator"; isDoctor?: boolean }) => {
      // admin_update_user_role replaces the user's roles with this one role
      // plus the doctor flag, server-side.
      const { error } = await supabase.rpc('admin_update_user_role', {
        target_user_id: userId,
        new_role: newRole,
        new_is_doctor: isDoctor || false
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Role updated", description: "User role changed successfully." });
      qc.invalidateQueries({ queryKey: ["users-admin"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to update role.", variant: "destructive" as any });
    },
  });

  // One-time display of a temporary password after an admin reset.
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ user_id: string; email: string } | null>(null);

  const resetPassword = useMutation({
    mutationFn: async (target: { user_id: string; email: string }) => {
      const result = await apiAdminResetPassword(target.user_id);
      return { email: target.email, password: result.temporary_password };
    },
    onSuccess: (result) => {
      setResetTarget(null);
      setTempPassword(result);
      qc.invalidateQueries({ queryKey: ["users-admin"] });
    },
    onError: (e: any) => {
      setResetTarget(null);
      toast({ title: "Error", description: e?.message || "Failed to reset the password.", variant: "destructive" as any });
    },
  });

  const copyTempPassword = async () => {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword.password);
      toast({ title: "Copied", description: "Temporary password copied to the clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the password and copy it by hand.", variant: "destructive" as any });
    }
  };

  const [newService, setNewService] = useState({
    code: "",
    name: "",
    description: "",
    price: "",
    taxable: true,
  });

  const [newUser, setNewUser] = useState<{
    email: string;
    password: string;
    role: "user" | "admin" | "moderator";
  }>({
    email: "",
    password: "",
    role: "user",
  });

  // Patient management state
  const [patientSearch, setPatientSearch] = useState("");
  const [patientFilter, setPatientFilter] = useState("all"); // all, recent_visits, has_issues
  const [selectedPatient, setSelectedPatient] = useState<any>(null);

  const updatePatient = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const { error } = await supabase
        .from("patients")
        .update(data)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Patient updated", description: "Patient information saved successfully." });
      qc.invalidateQueries({ queryKey: ["patients-admin"] });
      setSelectedPatient(null);
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to update patient.", variant: "destructive" as any });
    },
  });

  // Filter and search patients
  const filteredPatients = useMemo(() => {
    if (!patientsQuery.data) return [];

    let filtered = patientsQuery.data;

    // Apply search filter
    if (patientSearch) {
      const search = patientSearch.toLowerCase();
      filtered = filtered.filter(patient =>
        patient.first_name?.toLowerCase().includes(search) ||
        patient.last_name?.toLowerCase().includes(search) ||
        patient.email?.toLowerCase().includes(search) ||
        patient.phone?.includes(search) ||
        patient.national_id?.includes(search)
      );
    }

    // Apply category filter
    if (patientFilter === "recent_visits") {
      filtered = filtered.filter(patient =>
        patient.appointments?.some((apt: any) =>
          new Date(apt.scheduled_start) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
        )
      );
    } else if (patientFilter === "has_issues") {
      filtered = filtered.filter(patient =>
        patient.appointments?.some((apt: any) =>
          apt.reason && apt.reason.toLowerCase().includes("pain") ||
          apt.reason && apt.reason.toLowerCase().includes("issue") ||
          apt.visit_notes?.some((note: any) => note.notes && note.notes.length > 50)
        )
      );
    }

    return filtered;
  }, [patientsQuery.data, patientSearch, patientFilter]);

  // Get common issues from appointment reasons
  const commonIssues = useMemo(() => {
    if (!patientsQuery.data) return [];

    const reasons: string[] = [];
    patientsQuery.data.forEach(patient => {
      patient.appointments?.forEach((apt: any) => {
        if (apt.reason) reasons.push(apt.reason);
      });
    });

    // Count occurrences and return top 5
    const reasonCounts: Record<string, number> = {};
    reasons.forEach(reason => {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    });

    return Object.entries(reasonCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
  }, [patientsQuery.data]);

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/admin/settings" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Admin Settings</h1>
          <p className="text-sm text-muted-foreground">Configure clinic settings and manage services.</p>
        </section>

        <Tabs defaultValue="settings" className="w-full">
          <TabsList>
            <TabsTrigger value="settings">Clinic Settings</TabsTrigger>
            <TabsTrigger value="services">Services</TabsTrigger>
            <TabsTrigger value="patients">Patient Management</TabsTrigger>
            <TabsTrigger value="users">User Management</TabsTrigger>
            <TabsTrigger value="hours">Working Hours</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>General Settings</CardTitle>
                <CardDescription>Configure basic clinic information and tax settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {settingsQuery.data && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);
                      updateSettings.mutate({
                        currency_code: formData.get("currency_code"),
                        tax_enabled: formData.get("tax_enabled") === "on",
                        tax_name: formData.get("tax_name"),
                        tax_rate: parseFloat(formData.get("tax_rate") as string) || 0,
                        default_appointment_duration_minutes: parseInt(formData.get("duration") as string) || 30,
                      });
                    }}
                    className="space-y-4"
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="currency_code">Currency Code</Label>
                        <Input id="currency_code" name="currency_code" defaultValue={settingsQuery.data.currency_code} />
                      </div>
                      <div>
                        <Label htmlFor="duration">Default Appointment Duration (minutes)</Label>
                        <Input id="duration" name="duration" type="number" defaultValue={settingsQuery.data.default_appointment_duration_minutes} />
                      </div>
                    </div>

                    <div className="flex items-center space-x-2">
                      <Switch id="tax_enabled" name="tax_enabled" defaultChecked={settingsQuery.data.tax_enabled} />
                      <Label htmlFor="tax_enabled">Enable Tax</Label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="tax_name">Tax Name</Label>
                        <Input id="tax_name" name="tax_name" defaultValue={settingsQuery.data.tax_name} />
                      </div>
                      <div>
                        <Label htmlFor="tax_rate">Tax Rate (%)</Label>
                        <Input id="tax_rate" name="tax_rate" type="number" step="0.01" defaultValue={settingsQuery.data.tax_rate} />
                      </div>
                    </div>

                    <Button type="submit" disabled={updateSettings.isPending}>
                      {updateSettings.isPending ? "Saving..." : "Save Settings"}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="services" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Add New Service</CardTitle>
                <CardDescription>Create a new billable service</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addService.mutate({
                      code: newService.code,
                      name: newService.name,
                      description: newService.description,
                      price: parseFloat(newService.price) || 0,
                      taxable: newService.taxable,
                    });
                    setNewService({ code: "", name: "", description: "", price: "", taxable: true });
                  }}
                  className="grid grid-cols-1 md:grid-cols-2 gap-4"
                >
                  <div>
                    <Label htmlFor="new-code">Code</Label>
                    <Input
                      id="new-code"
                      value={newService.code}
                      onChange={(e) => setNewService({ ...newService, code: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-name">Name</Label>
                    <Input
                      id="new-name"
                      value={newService.name}
                      onChange={(e) => setNewService({ ...newService, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Label htmlFor="new-description">Description</Label>
                    <Input
                      id="new-description"
                      value={newService.description}
                      onChange={(e) => setNewService({ ...newService, description: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-price">Price</Label>
                    <Input
                      id="new-price"
                      type="number"
                      step="0.01"
                      value={newService.price}
                      onChange={(e) => setNewService({ ...newService, price: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="new-taxable"
                      checked={newService.taxable}
                      onCheckedChange={(checked) => setNewService({ ...newService, taxable: checked })}
                    />
                    <Label htmlFor="new-taxable">Taxable</Label>
                  </div>
                  <div className="md:col-span-2">
                    <Button type="submit" disabled={addService.isPending}>
                      {addService.isPending ? "Adding..." : "Add Service"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Existing Services</CardTitle>
                <CardDescription>Edit or remove services</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {servicesQuery.data?.map((service) => (
                    <div key={service.id} className="border rounded-md p-4">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const formData = new FormData(e.currentTarget);
                          updateService.mutate({
                            id: service.id,
                            data: {
                              code: formData.get(`code-${service.id}`),
                              name: formData.get(`name-${service.id}`),
                              description: formData.get(`description-${service.id}`),
                              price: parseFloat(formData.get(`price-${service.id}`) as string) || 0,
                              taxable: formData.get(`taxable-${service.id}`) === "on",
                              active: formData.get(`active-${service.id}`) === "on",
                              show_on_landing: formData.get(`show_on_landing-${service.id}`) === "on",
                            },
                          });
                        }}
                        className="grid grid-cols-1 md:grid-cols-3 gap-4"
                      >
                        <div>
                          <Label htmlFor={`code-${service.id}`}>Code</Label>
                          <Input id={`code-${service.id}`} name={`code-${service.id}`} defaultValue={service.code} />
                        </div>
                        <div>
                          <Label htmlFor={`name-${service.id}`}>Name</Label>
                          <Input id={`name-${service.id}`} name={`name-${service.id}`} defaultValue={service.name} />
                        </div>
                        <div>
                          <Label htmlFor={`price-${service.id}`}>Price</Label>
                          <Input id={`price-${service.id}`} name={`price-${service.id}`} type="number" step="0.01" defaultValue={service.price} />
                        </div>
                        <div className="md:col-span-2">
                          <Label htmlFor={`description-${service.id}`}>Description</Label>
                          <Input id={`description-${service.id}`} name={`description-${service.id}`} defaultValue={service.description} />
                        </div>
                        <div className="flex items-center space-x-4">
                          <div className="flex items-center space-x-2">
                            <Switch id={`taxable-${service.id}`} name={`taxable-${service.id}`} defaultChecked={service.taxable} />
                            <Label htmlFor={`taxable-${service.id}`}>Taxable</Label>
                          </div>
                        <div className="flex items-center space-x-2">
                          <Switch
                            id={`show_on_landing-${service.id}`}
                            name={`show_on_landing-${service.id}`}
                            defaultChecked={service.show_on_landing}
                          />
                          <Label htmlFor={`show_on_landing-${service.id}`}>Show on Landing Page</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Switch id={`active-${service.id}`} name={`active-${service.id}`} defaultChecked={service.active} />
                            <Label htmlFor={`active-${service.id}`}>Active</Label>
                          </div>
                        </div>
                        <div className="md:col-span-3 flex gap-2">
                          <Button type="submit" size="sm" disabled={updateService.isPending}>
                            {updateService.isPending ? "Saving..." : "Save"}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              if (confirm("Are you sure you want to delete this service?")) {
                                deleteService.mutate(service.id);
                              }
                            }}
                            disabled={deleteService.isPending}
                          >
                            Delete
                          </Button>
                        </div>
                      </form>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="patients" className="space-y-6">
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <User className="h-5 w-5" />
                      Patient Management
                    </CardTitle>
                    <CardDescription>
                      Search and manage patient records, view visit history and common issues
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-4 items-center">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Search patients by name, email, phone, or ID..."
                          value={patientSearch}
                          onChange={(e) => setPatientSearch(e.target.value)}
                          className="pl-10"
                        />
                      </div>
                      <Select value={patientFilter} onValueChange={setPatientFilter}>
                        <SelectTrigger className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Patients</SelectItem>
                          <SelectItem value="recent_visits">Recent Visits (30 days)</SelectItem>
                          <SelectItem value="has_issues">With Recorded Issues</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-3 max-h-96 overflow-y-auto">
                      {filteredPatients.map((patient) => (
                        <div
                          key={patient.id}
                          className="border rounded-lg p-4 hover:bg-muted/50 transition-colors cursor-pointer"
                          onClick={() => setSelectedPatient(patient)}
                        >
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <h3 className="font-medium">
                                {patient.first_name} {patient.last_name}
                              </h3>
                              <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                                {patient.email && <span>{patient.email}</span>}
                                {patient.phone && <span>• {patient.phone}</span>}
                                {patient.date_of_birth && (
                                  <span>• Age: {new Date().getFullYear() - new Date(patient.date_of_birth).getFullYear()}</span>
                                )}
                              </div>
                              {patient.appointments && patient.appointments.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  <Badge variant="secondary" className="text-xs">
                                    {patient.appointments.length} visit{patient.appointments.length !== 1 ? 's' : ''}
                                  </Badge>
                                  {patient.appointments.slice(0, 2).map((apt: any, idx: number) => (
                                    apt.reason && (
                                      <Badge key={idx} variant="outline" className="text-xs">
                                        {apt.reason}
                                      </Badge>
                                    )
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="text-right text-sm text-muted-foreground">
                              <div>ID: {patient.national_id || 'N/A'}</div>
                              <div className="flex items-center gap-1 mt-1">
                                <Calendar className="h-3 w-3" />
                                {new Date(patient.created_at).toLocaleDateString()}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {filteredPatients.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        {patientSearch || patientFilter !== "all" ? "No patients match your criteria" : "No patients found"}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Patient Overview</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4 text-sm">
                      <div className="flex justify-between">
                        <span>Total Patients:</span>
                        <span className="font-medium">{patientsQuery.data?.length || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Recent Visits (30d):</span>
                        <span className="font-medium">
                          {patientsQuery.data?.filter(p =>
                            p.appointments?.some((apt: any) =>
                              new Date(apt.scheduled_start) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                            )
                          ).length || 0}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>With Recorded Issues:</span>
                        <span className="font-medium">
                          {patientsQuery.data?.filter(p =>
                            p.appointments?.some((apt: any) => apt.reason)
                          ).length || 0}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Common Issues</CardTitle>
                    <CardDescription>Most frequently reported concerns</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {commonIssues.map(({ reason, count }, idx) => (
                        <div key={idx} className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground truncate">{reason}</span>
                          <Badge variant="secondary" className="text-xs">
                            {count}
                          </Badge>
                        </div>
                      ))}
                      {commonIssues.length === 0 && (
                        <div className="text-sm text-muted-foreground text-center py-4">
                          No recorded issues yet
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Patient Details Dialog */}
            <Dialog open={!!selectedPatient} onOpenChange={(open) => !open && setSelectedPatient(null)}>
              <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                {selectedPatient ? (
                  <>
                    <DialogHeader>
                      <DialogTitle>
                        {selectedPatient.first_name} {selectedPatient.last_name}
                      </DialogTitle>
                      <DialogDescription>
                        Patient information and visit history
                      </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-6">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const formData = new FormData(e.currentTarget);
                        updatePatient.mutate({
                          id: selectedPatient.id,
                          data: {
                            first_name: formData.get("first_name"),
                            last_name: formData.get("last_name"),
                            email: formData.get("email"),
                            phone: formData.get("phone"),
                            address: formData.get("address"),
                            national_id: formData.get("national_id"),
                            drivers_permit: formData.get("drivers_permit"),
                            date_of_birth: formData.get("date_of_birth") || null,
                            sex: formData.get("sex") || null,
                          },
                        });
                      }}
                      className="space-y-4"
                    >
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="first_name">First Name</Label>
                          <Input
                            id="first_name"
                            name="first_name"
                            defaultValue={selectedPatient.first_name}
                            required
                          />
                        </div>
                        <div>
                          <Label htmlFor="last_name">Last Name</Label>
                          <Input
                            id="last_name"
                            name="last_name"
                            defaultValue={selectedPatient.last_name}
                            required
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="email">Email</Label>
                          <Input
                            id="email"
                            name="email"
                            type="email"
                            defaultValue={selectedPatient.email || ""}
                          />
                        </div>
                        <div>
                          <Label htmlFor="phone">Phone</Label>
                          <Input
                            id="phone"
                            name="phone"
                            defaultValue={selectedPatient.phone || ""}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="address">Address</Label>
                        <Input
                          id="address"
                          name="address"
                          defaultValue={selectedPatient.address || ""}
                        />
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <Label htmlFor="date_of_birth">Date of Birth</Label>
                          <Input
                            id="date_of_birth"
                            name="date_of_birth"
                            type="date"
                            defaultValue={selectedPatient.date_of_birth || ""}
                          />
                        </div>
                        <div>
                          <Label htmlFor="sex">Sex</Label>
                          <Select name="sex" defaultValue={selectedPatient.sex || undefined}>
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
                          <Label htmlFor="national_id">National ID</Label>
                          <Input
                            id="national_id"
                            name="national_id"
                            defaultValue={selectedPatient.national_id || ""}
                          />
                        </div>
                      </div>

                      <div>
                        <Label htmlFor="drivers_permit">Driver's Permit</Label>
                        <Input
                          id="drivers_permit"
                          name="drivers_permit"
                          defaultValue={selectedPatient.drivers_permit || ""}
                        />
                      </div>

                      <Button type="submit" disabled={updatePatient.isPending}>
                        {updatePatient.isPending ? "Saving..." : "Save Changes"}
                      </Button>
                    </form>

                    {selectedPatient.appointments && selectedPatient.appointments.length > 0 && (
                      <div>
                        <h3 className="font-medium mb-3">Visit History</h3>
                        <div className="space-y-3 max-h-64 overflow-y-auto">
                          {selectedPatient.appointments
                            .sort((a: any, b: any) => new Date(b.scheduled_start).getTime() - new Date(a.scheduled_start).getTime())
                            .map((appointment: any) => (
                              <div key={appointment.id} className="border rounded-md p-3">
                                <div className="flex items-start justify-between">
                                  <div>
                                    <div className="font-medium text-sm">
                                      {new Date(appointment.scheduled_start).toLocaleDateString()}
                                    </div>
                                    {appointment.reason && (
                                      <div className="text-sm text-muted-foreground mt-1">
                                        Reason: {appointment.reason}
                                      </div>
                                    )}
                                    {appointment.visit_notes?.length > 0 && (
                                      <div className="text-sm text-muted-foreground mt-1">
                                        Notes: {appointment.visit_notes[0].notes?.substring(0, 100)}
                                        {appointment.visit_notes[0].notes?.length > 100 && "..."}
                                      </div>
                                    )}
                                  </div>
                                  <Badge variant={appointment.status === "completed" ? "default" : "secondary"}>
                                    {appointment.status}
                                  </Badge>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                     )}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    No patient selected
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="users" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Add New User</CardTitle>
                <CardDescription>Create a new user with role assignment</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addUser.mutate(newUser);
                  }}
                  className="grid grid-cols-1 md:grid-cols-3 gap-4"
                >
                  <div>
                    <Label htmlFor="new-email">Email</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newUser.email}
                      onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-password">Password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      value={newUser.password}
                      onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="new-role">Role</Label>
                    <Select value={newUser.role} onValueChange={(value: "user" | "admin" | "moderator") => setNewUser({ ...newUser, role: value })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">Clinical staff</SelectItem>
                        <SelectItem value="moderator">Billing / Front office</SelectItem>
                        <SelectItem value="admin">Administrator</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-3">
                    <PasswordRules className="mb-1" />
                    <p className="text-xs text-muted-foreground">
                      The new user must choose their own password at first sign-in.
                    </p>
                  </div>
                  <div className="md:col-span-3">
                    <Button type="submit" disabled={addUser.isPending}>
                      {addUser.isPending ? "Adding..." : "Add User"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>User Management</CardTitle>
                <CardDescription>View all users, manage their roles, and assign doctor privileges</CardDescription>
              </CardHeader>
              <CardContent>
                {usersQuery.isLoading ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Loading users...
                  </div>
                ) : usersQuery.error ? (
                  <div className="text-center py-8 text-destructive">
                    Error loading users: {(usersQuery.error as any)?.message}
                  </div>
                ) : (
                  <div className="space-y-4">
                     {usersQuery.data?.map((user) => (
                       <div key={user.user_id} className="border rounded-lg p-4">
                         <div className="flex flex-wrap items-center justify-between gap-4">
                           <div className="space-y-1">
                             <div className="flex flex-wrap items-center gap-2">
                               <p className="font-medium">{user.email}</p>
                               <Badge variant={user.role === 'admin' ? 'default' : user.role === 'moderator' ? 'secondary' : 'outline'}>
                                 {ROLE_LABELS[user.role] ?? user.role}
                               </Badge>
                               {user.is_doctor && (
                                 <Badge variant="destructive" className="text-xs">
                                   Doctor
                                 </Badge>
                               )}
                               {user.must_change_password && (
                                 <Badge variant="outline" className="text-xs">
                                   Password change pending
                                 </Badge>
                               )}
                             </div>
                             <p className="text-sm text-muted-foreground">
                               Created: {new Date(user.created_at).toLocaleDateString()}
                               {" · "}Last sign-in: {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "never"}
                             </p>
                             <p className="text-xs text-muted-foreground">
                               ID: {user.user_id}
                             </p>
                           </div>
                           <div className="flex flex-wrap items-center gap-4">
                             <div className="flex items-center gap-2">
                               <Label htmlFor={`role-${user.user_id}`} className="text-sm">
                                 Role:
                               </Label>
                               <Select
                                 value={user.role}
                                 onValueChange={(newRole: "user" | "admin" | "moderator") => {
                                   if (newRole !== user.role) {
                                     updateUserRole.mutate({
                                       userId: user.user_id,
                                       newRole,
                                       isDoctor: user.is_doctor
                                     });
                                   }
                                 }}
                               >
                                 <SelectTrigger className="w-48" id={`role-${user.user_id}`}>
                                   <SelectValue />
                                 </SelectTrigger>
                                 <SelectContent>
                                   <SelectItem value="user">Clinical staff</SelectItem>
                                   <SelectItem value="moderator">Billing / Front office</SelectItem>
                                   <SelectItem value="admin">Administrator</SelectItem>
                                 </SelectContent>
                               </Select>
                             </div>
                             <div className="flex items-center gap-2">
                               <Label htmlFor={`doctor-${user.user_id}`} className="text-sm">
                                 Doctor:
                               </Label>
                               <Switch
                                 id={`doctor-${user.user_id}`}
                                 checked={user.is_doctor || false}
                                 onCheckedChange={(isDoctor) => {
                                   updateUserRole.mutate({
                                     userId: user.user_id,
                                     newRole: user.role,
                                     isDoctor
                                   });
                                 }}
                               />
                             </div>
                             <Button
                               variant="outline"
                               size="sm"
                               disabled={resetPassword.isPending || user.user_id === currentUser?.id}
                               title={user.user_id === currentUser?.id ? "Use Change password for your own account" : undefined}
                               onClick={() => setResetTarget({ user_id: user.user_id, email: user.email })}
                             >
                               Reset password
                             </Button>
                           </div>
                         </div>
                       </div>
                    ))}
                    {usersQuery.data?.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        No users found
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hours" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Working Hours</CardTitle>
                <CardDescription>Configure clinic operating hours for each day of the week</CardDescription>
              </CardHeader>
              <CardContent>
                {settingsQuery.data && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const formData = new FormData(e.currentTarget);

                      const workingHours = {
                        mon: {
                          enabled: formData.get("mon-enabled") === "on",
                          start: formData.get("mon-start") || "09:00",
                          end: formData.get("mon-end") || "17:00"
                        },
                        tue: {
                          enabled: formData.get("tue-enabled") === "on",
                          start: formData.get("tue-start") || "09:00",
                          end: formData.get("tue-end") || "17:00"
                        },
                        wed: {
                          enabled: formData.get("wed-enabled") === "on",
                          start: formData.get("wed-start") || "09:00",
                          end: formData.get("wed-end") || "17:00"
                        },
                        thu: {
                          enabled: formData.get("thu-enabled") === "on",
                          start: formData.get("thu-start") || "09:00",
                          end: formData.get("thu-end") || "17:00"
                        },
                        fri: {
                          enabled: formData.get("fri-enabled") === "on",
                          start: formData.get("fri-start") || "09:00",
                          end: formData.get("fri-end") || "17:00"
                        },
                        sat: {
                          enabled: formData.get("sat-enabled") === "on",
                          start: formData.get("sat-start") || "09:00",
                          end: formData.get("sat-end") || "17:00"
                        },
                        sun: {
                          enabled: formData.get("sun-enabled") === "on",
                          start: formData.get("sun-start") || "09:00",
                          end: formData.get("sun-end") || "17:00"
                        }
                      };

                      updateSettings.mutate({ working_hours: workingHours });
                    }}
                    className="space-y-4"
                  >
                    {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, index) => {
                      const dayKey = day.toLowerCase().slice(0, 3);
                      const currentHours = settingsQuery.data.working_hours?.[dayKey] || { enabled: false, start: "09:00", end: "17:00" };

                      return (
                        <div key={day} className="border rounded-md p-4">
                          <div className="flex items-center justify-between mb-3">
                            <Label className="text-base font-medium">{day}</Label>
                            <div className="flex items-center space-x-2">
                              <Switch
                                id={`${dayKey}-enabled`}
                                name={`${dayKey}-enabled`}
                                defaultChecked={currentHours.enabled}
                              />
                              <Label htmlFor={`${dayKey}-enabled`}>Open</Label>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <Label htmlFor={`${dayKey}-start`}>Start Time</Label>
                              <Input
                                id={`${dayKey}-start`}
                                name={`${dayKey}-start`}
                                type="time"
                                defaultValue={currentHours.start}
                              />
                            </div>
                            <div>
                              <Label htmlFor={`${dayKey}-end`}>End Time</Label>
                              <Input
                                id={`${dayKey}-end`}
                                name={`${dayKey}-end`}
                                type="time"
                                defaultValue={currentHours.end}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    <Button type="submit" disabled={updateSettings.isPending}>
                      {updateSettings.isPending ? "Saving..." : "Save Working Hours"}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="about" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>About {PRODUCT.name}</CardTitle>
                <CardDescription>{PRODUCT.name} by {PRODUCT.vendor}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>
                  {PRODUCT.name} is open-source clinic practice-management software by {PRODUCT.vendor}, licensed under the
                  GNU Affero General Public License v3.0 (AGPL-3.0).
                </p>
                <p>
                  <strong>Not a medical device.</strong> {PRODUCT.name} records administrative and clinical information entered
                  by staff; it does not provide diagnosis, treatment recommendations or any other clinical decision support.
                </p>
                <p>
                  The clinic operating this installation ({BRAND.name}) is the data controller for all patient and staff data
                  stored in it, and is responsible for its lawful use, retention and security.
                </p>
                <p>
                  Source code:{" "}
                  <a href={PRODUCT.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                    {PRODUCT.url}
                  </a>
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={!!resetTarget} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Reset password</DialogTitle>
              <DialogDescription>
                Reset the password of {resetTarget?.email}? Their current sessions are signed out and they must choose a new
                password at their next sign-in.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResetTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={resetPassword.isPending}
                onClick={() => resetTarget && resetPassword.mutate(resetTarget)}
              >
                {resetPassword.isPending ? "Resetting..." : "Reset password"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={!!tempPassword} onOpenChange={(open) => { if (!open) setTempPassword(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Temporary password</DialogTitle>
              <DialogDescription>
                For {tempPassword?.email}. It is shown only once: copy it now and hand it over securely. The user must change
                it at their next sign-in.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Input readOnly value={tempPassword?.password ?? ""} className="font-mono" onFocus={(e) => e.target.select()} aria-label="Temporary password" />
              <Button onClick={copyTempPassword}>Copy</Button>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setTempPassword(null)}>Done</Button>
            </div>
          </DialogContent>
        </Dialog>
      </main>
      <AppFooter />
    </div>
  );
}