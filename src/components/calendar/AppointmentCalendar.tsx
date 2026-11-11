import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronLeft, ChevronRight, Plus, MoreVertical, Eye } from "lucide-react";
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameMonth, isSameDay, addMonths, subMonths } from "date-fns";
import { AppointmentDialog } from "./AppointmentDialog";
import { PatientVisitHistory } from "@/components/PatientVisitHistory";
import { useNavigate } from "react-router-dom";

export function AppointmentCalendar() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<any>(null);
  const [viewingPatient, setViewingPatient] = useState<any>(null);

  // Get month boundaries for fetching appointments
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);

  // Fetch appointments for the current month view
  const appointmentsQuery = useQuery({
    queryKey: ["calendar-appointments", format(monthStart, 'yyyy-MM')],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("appointments")
        .select(`
          id,
          scheduled_start,
          scheduled_end,
          duration_minutes,
          reason,
          status,
          customer_type,
          patient_id,
          patient:patients(first_name, last_name, phone)
        `)
        .gte('scheduled_start', calendarStart.toISOString())
        .lte('scheduled_start', calendarEnd.toISOString())
        .order('scheduled_start', { ascending: true });
      
      if (error) throw error;
      return data;
    },
  });

  // Check-in appointment mutation
  const checkInAppointment = useMutation({
    mutationFn: async (appointmentId: string) => {
      const { error } = await supabase
        .from("appointments")
        .update({ status: "waiting" })
        .eq("id", appointmentId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Patient checked in", description: "Appointment moved to waiting queue." });
      queryClient.invalidateQueries({ queryKey: ["calendar-appointments"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Cancel appointment mutation
  const cancelAppointment = useMutation({
    mutationFn: async (appointmentId: string) => {
      const { error } = await supabase
        .from("appointments")
        .update({ status: "canceled" })
        .eq("id", appointmentId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Appointment canceled", description: "Appointment has been canceled." });
      queryClient.invalidateQueries({ queryKey: ["calendar-appointments"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const days = [];
    let currentDay = calendarStart;
    
    while (currentDay <= calendarEnd) {
      days.push(new Date(currentDay));
      currentDay = addDays(currentDay, 1);
    }
    
    return days;
  }, [calendarStart, calendarEnd]);

  // Group appointments by date
  const appointmentsByDate = useMemo(() => {
    if (!appointmentsQuery.data) return {};
    
    return appointmentsQuery.data.reduce((acc, appointment) => {
      const date = format(new Date(appointment.scheduled_start), 'yyyy-MM-dd');
      if (!acc[date]) acc[date] = [];
      acc[date].push(appointment);
      return acc;
    }, {} as Record<string, any[]>);
  }, [appointmentsQuery.data]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'scheduled': return 'bg-blue-100 text-blue-800';
      case 'waiting': return 'bg-yellow-100 text-yellow-800';
      case 'in_progress': return 'bg-green-100 text-green-800';
      case 'completed': return 'bg-gray-100 text-gray-800';
      case 'canceled': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const handleNewAppointment = (date: Date, time?: string) => {
    setSelectedDate(date);
    setSelectedTime(time || "");
    setEditingAppointment(null);
    setDialogOpen(true);
  };

  const handleEditAppointment = (appointment: any) => {
    setEditingAppointment(appointment);
    setDialogOpen(true);
  };

  const timeSlots = [
    "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
    "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30"
  ];

  return (
    <div className="space-y-6">
      {/* Calendar Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold">
            {format(currentDate, 'MMMM yyyy')}
          </h2>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentDate(subMonths(currentDate, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentDate(new Date())}
            >
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentDate(addMonths(currentDate, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Button onClick={() => handleNewAppointment(new Date())}>
          <Plus className="h-4 w-4 mr-2" />
          New Appointment
        </Button>
      </div>

      {/* Calendar Grid */}
      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-7 border-b">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div key={day} className="p-3 text-center font-medium text-sm bg-muted">
                {day}
              </div>
            ))}
          </div>
          
          <div className="grid grid-cols-7">
            {calendarDays.map((day) => {
              const dateKey = format(day, 'yyyy-MM-dd');
              const dayAppointments = appointmentsByDate[dateKey] || [];
              const isCurrentMonth = isSameMonth(day, currentDate);
              const isToday = isSameDay(day, new Date());
              
              return (
                <div
                  key={day.toISOString()}
                  className={`min-h-32 p-2 border-r border-b ${
                    !isCurrentMonth ? 'bg-muted/30 text-muted-foreground' : ''
                  } ${isToday ? 'bg-blue-50' : ''}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm font-medium ${isToday ? 'text-blue-600' : ''}`}>
                      {format(day, 'd')}
                    </span>
                    {isCurrentMonth && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                            <Plus className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {timeSlots.map((time) => (
                            <DropdownMenuItem
                              key={time}
                              onClick={() => handleNewAppointment(day, time)}
                            >
                              {time}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  
                  <div className="space-y-1">
                    {dayAppointments.slice(0, 3).map((appointment) => (
                      <div
                        key={appointment.id}
                        className={`text-xs p-1 rounded cursor-pointer group ${getStatusColor(appointment.status)}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="truncate">
                            <div className="font-medium">
                              {format(new Date(appointment.scheduled_start), 'HH:mm')}
                            </div>
                            <div className="truncate">
                              {appointment.patient?.first_name} {appointment.patient?.last_name}
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100">
                                <MoreVertical className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setViewingPatient(appointment)}>
                                <Eye className="h-4 w-4 mr-2" />
                                View History
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleEditAppointment(appointment)}>
                                Edit
                              </DropdownMenuItem>
                              {appointment.status === 'scheduled' && (
                                <DropdownMenuItem onClick={() => checkInAppointment.mutate(appointment.id)}>
                                  Check In
                                </DropdownMenuItem>
                              )}
                              {appointment.status === 'in_progress' && (
                                <DropdownMenuItem onClick={() => navigate(`/visit/${appointment.id}`)}>
                                  Continue Visit
                                </DropdownMenuItem>
                              )}
                              {['scheduled', 'waiting'].includes(appointment.status) && (
                                <DropdownMenuItem 
                                  onClick={() => cancelAppointment.mutate(appointment.id)}
                                  className="text-red-600"
                                >
                                  Cancel
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    ))}
                    {dayAppointments.length > 3 && (
                      <div className="text-xs text-muted-foreground text-center">
                        +{dayAppointments.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Appointment Dialog */}
      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appointment={editingAppointment}
        selectedDate={selectedDate || undefined}
        selectedTime={selectedTime}
      />

      {/* Patient Visit History Dialog */}
      {viewingPatient && (
        <Dialog open={!!viewingPatient} onOpenChange={() => setViewingPatient(null)}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Patient Visit History</DialogTitle>
              <DialogDescription>
                Clinical notes and visit records for {viewingPatient.patient?.first_name} {viewingPatient.patient?.last_name}
              </DialogDescription>
            </DialogHeader>
            <PatientVisitHistory 
              patientId={viewingPatient.patient_id} 
              patientName={`${viewingPatient.patient?.first_name} ${viewingPatient.patient?.last_name}`}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}