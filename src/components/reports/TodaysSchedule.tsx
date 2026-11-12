import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar, Clock, Users, User } from "lucide-react";

interface Appointment {
  id: string;
  scheduled_start: string;
  scheduled_end: string;
  duration_minutes: number;
  reason: string;
  status: string;
  customer_type: string;
  patients: {
    first_name: string;
    last_name: string;
    phone: string;
  };
}

export function TodaysSchedule() {
  const today = new Date().toISOString().split('T')[0];

  const { data: appointments, isLoading } = useQuery({
    queryKey: ["todays-appointments", today],
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
          patients (
            first_name,
            last_name,
            phone
          )
        `)
        .gte('scheduled_start', `${today}T00:00:00`)
        .lt('scheduled_start', `${today}T23:59:59`)
        .order('scheduled_start', { ascending: true });

      if (error) throw error;
      return data as Appointment[];
    },
  });

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      scheduled: { variant: "secondary" as const, label: "Scheduled" },
      waiting: { variant: "default" as const, label: "Waiting" },
      in_progress: { variant: "destructive" as const, label: "In Progress" },
      completed: { variant: "outline" as const, label: "Completed" },
      canceled: { variant: "secondary" as const, label: "Canceled" },
      cancelled: { variant: "secondary" as const, label: "Canceled" }, // Handle both spellings
      no_show: { variant: "destructive" as const, label: "No Show" },
    };
    
    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.scheduled;
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const stats = {
    total: appointments?.length || 0,
    waiting: appointments?.filter(apt => apt.status === 'waiting').length || 0,
    inProgress: appointments?.filter(apt => apt.status === 'in_progress').length || 0,
    completed: appointments?.filter(apt => apt.status === 'completed').length || 0,
    canceled: appointments?.filter(apt => apt.status === 'canceled' || apt.status === 'cancelled').length || 0,
    noShow: appointments?.filter(apt => apt.status === 'no_show').length || 0,
    walkIns: appointments?.filter(apt => apt.customer_type === 'walk-in').length || 0,
    scheduledAppts: appointments?.filter(apt => apt.customer_type === 'appointment').length || 0,
  };

  if (isLoading) {
    return <div>Loading today's schedule...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Appointments</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Waiting</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.waiting}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">In Progress</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.inProgress}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.completed}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Canceled</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.canceled}</div>
          </CardContent>
        </Card>
      </div>

      {/* Customer Type Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">No Shows</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{stats.noShow}</div>
            <p className="text-xs text-muted-foreground">Missed appointments</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Walk-ins</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.walkIns}</div>
            <p className="text-xs text-muted-foreground">Immediate care visits</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Scheduled Appointments</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.scheduledAppts}</div>
            <p className="text-xs text-muted-foreground">Pre-booked visits</p>
          </CardContent>
        </Card>
      </div>

      {/* Schedule Table */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule Details</CardTitle>
          <CardDescription>
            All appointments for {format(new Date(), 'MMMM d, yyyy')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {appointments && appointments.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Patient</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {appointments.map((appointment) => (
                  <TableRow key={appointment.id}>
                    <TableCell className="font-medium">
                      {format(new Date(appointment.scheduled_start), 'h:mm a')}
                      {appointment.scheduled_end && (
                        <span className="text-muted-foreground">
                          {' - '}
                          {format(new Date(appointment.scheduled_end), 'h:mm a')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {appointment.patients.first_name} {appointment.patients.last_name}
                    </TableCell>
                    <TableCell>{appointment.patients.phone || '-'}</TableCell>
                    <TableCell>{appointment.reason || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={appointment.customer_type === 'walk-in' ? 'secondary' : 'outline'}>
                        {appointment.customer_type === 'walk-in' ? 'Walk-in' : 'Appointment'}
                      </Badge>
                    </TableCell>
                    <TableCell>{appointment.duration_minutes} min</TableCell>
                    <TableCell>{getStatusBadge(appointment.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No appointments scheduled for today
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}