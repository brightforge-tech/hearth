import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Clock } from "lucide-react";
import { format } from "date-fns";
import { cn, orSearchTerm } from "@/lib/utils";

interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment?: any;
  selectedDate?: Date;
  selectedTime?: string;
}

export function AppointmentDialog({ 
  open, 
  onOpenChange, 
  appointment, 
  selectedDate, 
  selectedTime 
}: AppointmentDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [search, setSearch] = useState("");
  const [selectedPatientId, setSelectedPatientId] = useState<string>("");
  const [date, setDate] = useState<Date | undefined>(selectedDate);
  const [time, setTime] = useState(selectedTime || "09:00");
  const [duration, setDuration] = useState("30");
  const [reason, setReason] = useState("");
  const [customerType, setCustomerType] = useState<"walk-in" | "appointment">("appointment");

  // Search patients
  const patientsQuery = useQuery({
    queryKey: ["patients-search", search],
    queryFn: async () => {
      const term = orSearchTerm(search);
      if (!term) return [];
      const { data, error } = await supabase
        .from("patients")
        .select("id, first_name, last_name, phone, email")
        .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%`)
        .limit(10);
      if (error) throw error;
      return data;
    },
    enabled: search.length > 0 && !appointment,
  });

  // Initialize form with existing appointment data
  useEffect(() => {
    if (appointment) {
      setSelectedPatientId(appointment.patient_id);
      setDate(new Date(appointment.scheduled_start));
      setTime(format(new Date(appointment.scheduled_start), "HH:mm"));
      setDuration(appointment.duration_minutes?.toString() || "30");
      setReason(appointment.reason || "");
      setCustomerType(appointment.customer_type || "appointment");
      setSearch(`${appointment.patient?.first_name} ${appointment.patient?.last_name}`);
    } else {
      setDate(selectedDate);
      setTime(selectedTime || "09:00");
    }
  }, [appointment, selectedDate, selectedTime]);

  const saveAppointment = useMutation({
    mutationFn: async (data: any) => {
      const scheduledStart = new Date(`${format(date!, 'yyyy-MM-dd')}T${time}:00`);
      const scheduledEnd = new Date(scheduledStart.getTime() + parseInt(duration) * 60000);

      const appointmentData = {
        patient_id: selectedPatientId,
        scheduled_start: scheduledStart.toISOString(),
        scheduled_end: scheduledEnd.toISOString(),
        duration_minutes: parseInt(duration),
        reason,
        customer_type: customerType,
        status: appointment ? appointment.status : "scheduled"
      };

      if (appointment) {
        const { error } = await supabase
          .from("appointments")
          .update(appointmentData)
          .eq("id", appointment.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("appointments")
          .insert([appointmentData]);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({
        title: appointment ? "Appointment updated" : "Appointment scheduled",
        description: appointment ? "Appointment has been updated successfully." : "New appointment has been scheduled.",
      });
      queryClient.invalidateQueries({ queryKey: ["calendar-appointments"] });
      onOpenChange(false);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save appointment.",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setSearch("");
    setSelectedPatientId("");
    setDate(undefined);
    setTime("09:00");
    setDuration("30");
    setReason("");
    setCustomerType("appointment");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatientId || !date || !time) {
      toast({
        title: "Missing information",
        description: "Please select a patient, date, and time.",
        variant: "destructive",
      });
      return;
    }
    saveAppointment.mutate({});
  };

  const handleClose = () => {
    onOpenChange(false);
    if (!appointment) {
      resetForm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {appointment ? "Edit Appointment" : "Schedule New Appointment"}
          </DialogTitle>
          <DialogDescription>
            {appointment ? "Update appointment details" : "Create a new patient appointment"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Patient Search */}
          <div className="space-y-2">
            <Label htmlFor="patient">Patient</Label>
            <Input
              id="patient"
              placeholder="Search by name or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={!!appointment}
            />
            {patientsQuery.data && patientsQuery.data.length > 0 && (
              <div className="border rounded-md max-h-32 overflow-y-auto">
                {patientsQuery.data.map((patient: any) => (
                  <button
                    key={patient.id}
                    type="button"
                    className="w-full text-left p-2 hover:bg-muted text-sm"
                    onClick={() => {
                      setSelectedPatientId(patient.id);
                      setSearch(`${patient.first_name} ${patient.last_name}`);
                    }}
                  >
                    <div className="font-medium">{patient.first_name} {patient.last_name}</div>
                    <div className="text-muted-foreground">{patient.phone} • {patient.email}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Date */}
          <div className="space-y-2">
            <Label>Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !date && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {date ? format(date, "PPP") : <span>Pick a date</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Time and Duration */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="time">Time</Label>
              <Input
                id="time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="duration">Duration (minutes)</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="45">45 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="90">1.5 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Customer Type */}
          <div className="space-y-2">
            <Label>Visit Type</Label>
            <Select value={customerType} onValueChange={(value: "walk-in" | "appointment") => setCustomerType(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="appointment">Scheduled Appointment</SelectItem>
                <SelectItem value="walk-in">Walk-in</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason for Visit</Label>
            <Textarea
              id="reason"
              placeholder="Describe the reason for this appointment..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex gap-2 pt-4">
            <Button type="button" variant="outline" onClick={handleClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" disabled={saveAppointment.isPending} className="flex-1">
              {saveAppointment.isPending 
                ? "Saving..." 
                : appointment 
                  ? "Update Appointment" 
                  : "Schedule Appointment"
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}