import { BRAND } from "@/lib/brand";
import { useClinicCurrency, formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { apiQuickBooksExport } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, FileText, DollarSign } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";

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

export default function Exports() {
  const currency = useClinicCurrency();
  useMeta(
    `QuickBooks Exports | ${BRAND.name}`,
    "Export invoices and payments to QuickBooks-compatible CSV formats.",
    window.location.origin + "/exports"
  );

  const { toast } = useToast();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [exportType, setExportType] = useState<"invoices" | "payments">("invoices");
  const [isExporting, setIsExporting] = useState(false);

  // Set default dates (current month)
  useEffect(() => {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    setStartDate(firstDay.toISOString().split('T')[0]);
    setEndDate(lastDay.toISOString().split('T')[0]);
  }, []);

  const statsQuery = useQuery({
    queryKey: ["export-stats", startDate, endDate],
    queryFn: async () => {
      if (!startDate || !endDate) return null;

      const [invoicesResponse, paymentsResponse] = await Promise.all([
        supabase
          .from("invoices")
          .select("id, total, status")
          .gte("created_at", startDate)
          .lte("created_at", endDate + "T23:59:59"),
        
        supabase
          .from("payments")
          .select("id, amount")
          .gte("received_at", startDate)
          .lte("received_at", endDate + "T23:59:59")
      ]);

      if (invoicesResponse.error || paymentsResponse.error) {
        throw invoicesResponse.error || paymentsResponse.error;
      }

      const invoices = invoicesResponse.data || [];
      const payments = paymentsResponse.data || [];

      return {
        totalInvoices: invoices.length,
        totalInvoiceAmount: invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
        issuedInvoices: invoices.filter(inv => inv.status === "issued").length,
        totalPayments: payments.length,
        totalPaymentAmount: payments.reduce((sum, pay) => sum + (pay.amount || 0), 0)
      };
    },
    enabled: !!startDate && !!endDate
  });

  const handleExport = async () => {
    if (!startDate || !endDate) {
      toast({
        title: "Error",
        description: "Please select start and end dates",
        variant: "destructive"
      });
      return;
    }

    setIsExporting(true);
    try {
      // Ported edge function (task t12): the QuickBooks CSV now comes from
      // our own API through the named helper in src/lib/api.ts, which attaches
      // the session's Authorization header (the endpoint is gated, W42) and
      // returns the raw CSV text; the endpoint path lives only there
      // (t16/W61). A failing range or export type throws the server's
      // message, which the catch below turns into the same toast.
      const csv = await apiQuickBooksExport({
        exportType,
        startDate: startDate + "T00:00:00",
        endDate: endDate + "T23:59:59"
      });

      // Create download link
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `quickbooks-${exportType}-${startDate}-to-${endDate}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Export successful",
        description: `${exportType} exported to CSV file`
      });
    } catch (error: any) {
      toast({
        title: "Export failed",
        description: error?.message || "Failed to export data",
        variant: "destructive"
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/exports" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">QuickBooks Exports</h1>
          <p className="text-sm text-muted-foreground">Export invoices and payments to QuickBooks-compatible CSV format</p>
        </section>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Export Configuration */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Download className="h-5 w-5" />
                  Export Configuration
                </CardTitle>
                <CardDescription>
                  Select date range and export type for QuickBooks import
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="start-date">Start Date</Label>
                    <Input
                      id="start-date"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="end-date">End Date</Label>
                    <Input
                      id="end-date"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="export-type">Export Type</Label>
                  <Select value={exportType} onValueChange={(value: any) => setExportType(value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                  <SelectItem value="invoices">Invoices</SelectItem>
                  <SelectItem value="payments">Payments</SelectItem>
                  <SelectItem value="expenses">Expenses</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button 
                  onClick={handleExport} 
                  disabled={isExporting || !startDate || !endDate}
                  className="w-full"
                >
                  {isExporting ? "Exporting..." : `Export ${exportType} to CSV`}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Statistics */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Period Overview
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {statsQuery.isLoading && (
                  <div className="text-sm text-muted-foreground">Loading stats...</div>
                )}
                {statsQuery.data && (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Total Invoices:</span>
                      <Badge variant="outline">{statsQuery.data.totalInvoices}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Issued Invoices:</span>
                      <Badge>{statsQuery.data.issuedInvoices}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Invoice Total:</span>
                      <span className="font-medium">{formatMoney(statsQuery.data.totalInvoiceAmount, currency)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Total Payments:</span>
                      <Badge variant="outline">{statsQuery.data.totalPayments}</Badge>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm">Payment Total:</span>
                      <span className="font-medium">{formatMoney(statsQuery.data.totalPaymentAmount, currency)}</span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Export Formats</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div>
                  <strong>Invoices CSV:</strong> Contains customer data, line items, tax amounts - ready for QuickBooks invoice import.
                </div>
                <div>
                  <strong>Payments CSV:</strong> Contains payment records with methods and references for reconciliation.
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <AppFooter />
    </div>
  );
}