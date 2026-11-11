import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigation } from "@/components/Navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Search, User, Calendar, FileText, Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { format, parseISO } from "date-fns";
import { AppFooter } from "@/components/AppFooter";

interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  date_of_birth?: string;
  address?: string;
  sex?: string;
  national_id?: string;
  drivers_permit?: string;
  created_at: string;
}

interface Appointment {
  id: string;
  scheduled_start: string;
  status: string;
  reason?: string;
  intake_notes?: string | null;
  duration_minutes?: number;
}

interface VisitNote {
  id: string;
  notes?: string;
  signed_at?: string;
  created_at: string;
  appointment_id: string;
}

const PatientManagement = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const { isDoctor } = useAuth();

  const { data: patients = [], isLoading } = useQuery({
    queryKey: ["patients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as Patient[];
    }
  });

  const { data: patientAppointments = [], isLoading: appointmentsLoading } = useQuery({
    queryKey: ["patient-appointments", selectedPatient?.id],
    queryFn: async () => {
      if (!selectedPatient) return [];
      
      const { data, error } = await supabase
        .from("appointments")
        .select("*")
        .eq("patient_id", selectedPatient.id)
        .order("scheduled_start", { ascending: false });
      
      if (error) throw error;
      return data as Appointment[];
    },
    enabled: !!selectedPatient
  });

  const { data: visitNotes = [], isLoading: notesLoading } = useQuery({
    queryKey: ["visit-notes", selectedPatient?.id, patientAppointments.length],
    queryFn: async () => {
      if (!selectedPatient || !isDoctor) return [];
      
      const appointmentIds = patientAppointments.map(apt => apt.id);
      if (appointmentIds.length === 0) return [];

      const { data, error } = await supabase
        .from("visit_notes")
        .select("*")
        .in("appointment_id", appointmentIds)
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data as VisitNote[];
    },
    enabled: !!selectedPatient && !!isDoctor && patientAppointments.length > 0
  });

  const filteredPatients = patients.filter(patient =>
    `${patient.first_name} ${patient.last_name}`
      .toLowerCase()
      .includes(searchTerm.toLowerCase()) ||
    patient.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    patient.phone?.includes(searchTerm) ||
    patient.national_id?.includes(searchTerm)
  );

  const handleViewPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    setIsDetailDialogOpen(true);
  };

  const calculateAge = (dateOfBirth: string) => {
    const today = new Date();
    const birthDate = parseISO(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    
    return age;
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      scheduled: { variant: "default" as const, label: "Scheduled" },
      completed: { variant: "default" as const, label: "Completed" },
      cancelled: { variant: "destructive" as const, label: "Cancelled" },
      canceled: { variant: "destructive" as const, label: "Cancelled" },
      no_show: { variant: "secondary" as const, label: "No Show" },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || 
                   { variant: "outline" as const, label: status };

    return (
      <Badge variant={config.variant}>
        {config.label}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/patients" />
      
      <main className="container mx-auto px-4 py-6">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Patient Management</h2>
            <p className="text-muted-foreground">
              View and manage patient information and visit history
            </p>
          </div>
        </div>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Patient Directory
              </CardTitle>
              <CardDescription>
                Search and view patient information
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center space-x-2 mb-4">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, phone, or ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
              </div>

              {isLoading ? (
                <div className="text-center py-4">Loading patients...</div>
              ) : filteredPatients.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm ? "No patients found matching your search." : "No patients registered yet."}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Age</TableHead>
                      <TableHead>ID Numbers</TableHead>
                      <TableHead>Registered</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPatients.map((patient) => (
                      <TableRow key={patient.id}>
                        <TableCell>
                          <div>
                            <div className="font-medium">
                              {patient.first_name} {patient.last_name}
                            </div>
                            {patient.sex && (
                              <div className="text-sm text-muted-foreground">
                                {patient.sex}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {patient.email && (
                              <div className="text-sm">{patient.email}</div>
                            )}
                            {patient.phone && (
                              <div className="text-sm text-muted-foreground">{patient.phone}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {patient.date_of_birth ? (
                            <div>
                              <div>{calculateAge(patient.date_of_birth)} years</div>
                              <div className="text-sm text-muted-foreground">
                                {format(parseISO(patient.date_of_birth), 'MMM dd, yyyy')}
                              </div>
                            </div>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {patient.national_id && (
                              <div className="text-sm">ID: {patient.national_id}</div>
                            )}
                            {patient.drivers_permit && (
                              <div className="text-sm text-muted-foreground">DL: {patient.drivers_permit}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {format(new Date(patient.created_at), 'MMM dd, yyyy')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewPatient(patient)}
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                {selectedPatient ? `${selectedPatient.first_name} ${selectedPatient.last_name}` : "Patient Details"}
              </DialogTitle>
              <DialogDescription>
                Complete patient information and visit history
              </DialogDescription>
            </DialogHeader>
            
            {selectedPatient && (
              <div className="space-y-6">
                {/* Patient Information */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Patient Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-muted-foreground">Full Name</label>
                        <div className="text-sm">{selectedPatient.first_name} {selectedPatient.last_name}</div>
                      </div>
                      
                      {selectedPatient.email && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Email</label>
                          <div className="text-sm">{selectedPatient.email}</div>
                        </div>
                      )}
                      
                      {selectedPatient.phone && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Phone</label>
                          <div className="text-sm">{selectedPatient.phone}</div>
                        </div>
                      )}
                      
                      {selectedPatient.date_of_birth && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Date of Birth</label>
                          <div className="text-sm">
                            {format(parseISO(selectedPatient.date_of_birth), 'MMMM dd, yyyy')} 
                            ({calculateAge(selectedPatient.date_of_birth)} years old)
                          </div>
                        </div>
                      )}
                      
                      {selectedPatient.sex && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Sex</label>
                          <div className="text-sm">{selectedPatient.sex}</div>
                        </div>
                      )}
                      
                      {selectedPatient.address && (
                        <div className="md:col-span-2">
                          <label className="text-sm font-medium text-muted-foreground">Address</label>
                          <div className="text-sm">{selectedPatient.address}</div>
                        </div>
                      )}
                      
                      {selectedPatient.national_id && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">National ID</label>
                          <div className="text-sm">{selectedPatient.national_id}</div>
                        </div>
                      )}
                      
                      {selectedPatient.drivers_permit && (
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Driver's Permit</label>
                          <div className="text-sm">{selectedPatient.drivers_permit}</div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Appointment History */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Calendar className="h-5 w-5" />
                      Appointment History
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {appointmentsLoading ? (
                      <div className="text-center py-4">Loading appointments...</div>
                    ) : patientAppointments.length === 0 ? (
                      <div className="text-center py-4 text-muted-foreground">
                        No appointments found for this patient.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {patientAppointments.map((appointment) => (
                          <div key={appointment.id} className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                <div>
                                  <div className="font-medium">
                                    {format(new Date(appointment.scheduled_start), 'MMM dd, yyyy')}
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    {format(new Date(appointment.scheduled_start), 'h:mm a')}
                                    {appointment.duration_minutes && ` (${appointment.duration_minutes} min)`}
                                  </div>
                                </div>
                                <div>
                                  {getStatusBadge(appointment.status)}
                                </div>
                              </div>
                              {appointment.reason && (
                                <div className="text-sm text-muted-foreground mt-1">
                                  Reason: {appointment.reason}
                                </div>
                              )}
                              {appointment.intake_notes && (
                                <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                                  Intake notes: {appointment.intake_notes}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Visit Notes - Doctor Only */}
                {isDoctor && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <FileText className="h-5 w-5" />
                        Visit Notes
                        <Badge variant="secondary" className="ml-2">Doctor Only</Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {notesLoading ? (
                        <div className="text-center py-4">Loading visit notes...</div>
                      ) : visitNotes.length === 0 ? (
                        <div className="text-center py-4 text-muted-foreground">
                          No visit notes found for this patient.
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {visitNotes.map((note) => {
                            const appointment = patientAppointments.find(apt => apt.id === note.appointment_id);
                            return (
                              <div key={note.id} className="p-4 border rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="font-medium">
                                    Visit: {appointment && format(new Date(appointment.scheduled_start), 'MMM dd, yyyy')}
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    {format(new Date(note.created_at), 'MMM dd, yyyy h:mm a')}
                                  </div>
                                </div>
                                {note.notes && (
                                  <div className="text-sm whitespace-pre-wrap">
                                    {note.notes}
                                  </div>
                                )}
                                {note.signed_at && (
                                  <div className="text-xs text-green-600 mt-2">
                                    ✓ Signed on {format(new Date(note.signed_at), 'MMM dd, yyyy h:mm a')}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {!isDoctor && (
                  <Card>
                    <CardContent className="text-center py-8">
                      <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                      <h3 className="text-lg font-medium mb-2">Visit Notes Restricted</h3>
                      <p className="text-muted-foreground">
                        Visit notes and medical details are only available to authorized doctors.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </main>
      <AppFooter />
    </div>
  );
};

export default PatientManagement;