import { useQuery } from "@tanstack/react-query";
import { useClinicCurrency, formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, DollarSign, FileText } from "lucide-react";
import { format, differenceInDays } from "date-fns";

interface UnpaidInvoice {
  id: string;
  created_at: string;
  total: number;
  paid_amount: number;
  status: string;
  currency_code: string;
  appointments: {
    patients: {
      first_name: string;
      last_name: string;
      phone: string;
    };
  } | null;
}

export function UnpaidAging() {
  const currency = useClinicCurrency();
  const { data: unpaidInvoices, isLoading } = useQuery({
    queryKey: ["unpaid-invoices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id,
          created_at,
          total,
          paid_amount,
          status,
          currency_code,
          appointments (
            patients (
              first_name,
              last_name,
              phone
            )
          )
        `)
        .or('status.eq.issued,status.eq.overdue')
        .gt('total', 'paid_amount')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as UnpaidInvoice[];
    },
  });

  const formatCurrency = (amount: number, code: string = currency) => {
    return formatMoney(amount, code || DEFAULT_CURRENCY);
  };

  const getAging = (createdAt: string) => {
    const days = differenceInDays(new Date(), new Date(createdAt));
    
    if (days <= 30) return { category: "0-30 days", severity: "low" };
    if (days <= 60) return { category: "31-60 days", severity: "medium" };
    if (days <= 90) return { category: "61-90 days", severity: "high" };
    return { category: "90+ days", severity: "critical" };
  };

  const getAgingBadge = (severity: string) => {
    const variants = {
      low: "secondary" as const,
      medium: "default" as const,
      high: "destructive" as const,
      critical: "destructive" as const,
    };
    
    return <Badge variant={variants[severity as keyof typeof variants] || "secondary"}>{severity}</Badge>;
  };

  // Calculate aging summary
  const agingSummary = unpaidInvoices?.reduce((acc, invoice) => {
    const outstanding = invoice.total - invoice.paid_amount;
    const aging = getAging(invoice.created_at);
    
    if (!acc[aging.category]) {
      acc[aging.category] = { count: 0, amount: 0 };
    }
    
    acc[aging.category].count += 1;
    acc[aging.category].amount += outstanding;
    
    return acc;
  }, {} as Record<string, { count: number; amount: number }>) || {};

  const totalOutstanding = unpaidInvoices?.reduce((sum, inv) => 
    sum + (inv.total - inv.paid_amount), 0) || 0;

  if (isLoading) {
    return <div>Loading unpaid invoices...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Aging Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {["0-30 days", "31-60 days", "61-90 days", "90+ days"].map((period, index) => {
          const data = agingSummary[period] || { count: 0, amount: 0 };
          const icons = [Clock, AlertTriangle, AlertTriangle, AlertTriangle];
          const Icon = icons[index];
          
          return (
            <Card key={period}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{period}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(data.amount)}</div>
                <p className="text-xs text-muted-foreground">
                  {data.count} invoice{data.count !== 1 ? 's' : ''}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Total Outstanding */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Total Outstanding: {formatCurrency(totalOutstanding)}
          </CardTitle>
          <CardDescription>
            {unpaidInvoices?.length || 0} unpaid invoices requiring attention
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Detailed Aging Table */}
      <Card>
        <CardHeader>
          <CardTitle>Unpaid Invoice Details</CardTitle>
          <CardDescription>
            Detailed breakdown of all outstanding invoices with aging analysis
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unpaidInvoices && unpaidInvoices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Patient</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Age Category</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unpaidInvoices.map((invoice) => {
                  const outstanding = invoice.total - invoice.paid_amount;
                  const aging = getAging(invoice.created_at);
                  const daysOld = differenceInDays(new Date(), new Date(invoice.created_at));
                  
                  return (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          {invoice.id.slice(0, 8)}...
                        </div>
                      </TableCell>
                      <TableCell>
                        {invoice.appointments?.patients ? (
                          <div>
                            <div className="font-medium">
                              {invoice.appointments.patients.first_name} {invoice.appointments.patients.last_name}
                            </div>
                            {invoice.appointments.patients.phone && (
                              <div className="text-sm text-muted-foreground">
                                {invoice.appointments.patients.phone}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">No patient info</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {format(new Date(invoice.created_at), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        {formatCurrency(invoice.total, invoice.currency_code)}
                      </TableCell>
                      <TableCell>
                        {formatCurrency(invoice.paid_amount, invoice.currency_code)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatCurrency(outstanding, invoice.currency_code)}
                      </TableCell>
                      <TableCell>
                        <span className={daysOld > 90 ? "text-red-600 font-medium" : 
                                      daysOld > 60 ? "text-orange-600" : 
                                      daysOld > 30 ? "text-yellow-600" : ""}>
                          {daysOld}
                        </span>
                      </TableCell>
                      <TableCell>
                        {getAgingBadge(aging.severity)}
                      </TableCell>
                      <TableCell>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => window.location.href = `/billing?invoice=${invoice.id}`}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No unpaid invoices found - all caught up! 🎉
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}