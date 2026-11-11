import { BRAND } from "@/lib/brand";
import { useClinicCurrency, formatMoney, DEFAULT_CURRENCY } from "@/lib/currency";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { apiSendInvoiceEmail, apiSendReceiptEmail } from "@/lib/api";
import { useFeatures } from "@/hooks/useFeatures";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { Navigation } from "@/components/Navigation";
import { AppFooter } from "@/components/AppFooter";
import { InvoiceView } from "@/components/InvoiceView";
import { ReceiptView } from "@/components/ReceiptView";
import { Eye, Printer, Mail, Plus } from "lucide-react";

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

export default function Billing() {
  const currency = useClinicCurrency();
  useMeta(
    `Billing & Payments | ${BRAND.name}`, 
    "Manage invoices, record payments, and track outstanding balances.",
    window.location.origin + "/billing"
  );

  const { toast } = useToast();

  // E-mail is optional (features.email); the buttons stay visible but disabled.

  const emailEnabled = useFeatures().email;
  const qc = useQueryClient();
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "transfer">("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [selectedViewInvoiceId, setSelectedViewInvoiceId] = useState<string | null>(null);
  const [selectedEmailInvoiceId, setSelectedEmailInvoiceId] = useState<string | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState("");
  
  // Receipt states
  const [selectedReceiptPaymentId, setSelectedReceiptPaymentId] = useState<string | null>(null);
  const [receiptEmailDialogOpen, setReceiptEmailDialogOpen] = useState(false);
  const [receiptEmailRecipient, setReceiptEmailRecipient] = useState("");

  const invoicesQuery = useQuery({
    queryKey: ["invoices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          id, status, total, paid_amount, currency_code, created_at, subtotal, tax_amount, tax_enabled, tax_rate,
          appointment:appointments(
            scheduled_start, reason,
            patient:patients(first_name, last_name, email, phone, address)
          ),
          invoice_items(
            description, quantity, unit_price, line_total,
            service:services(name)
          )
        `)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const paymentsQuery = useQuery({
    queryKey: ["payments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select(`
          id, amount, method, reference, received_at, invoice_id,
          invoice:invoices(
            id, total, currency_code,
            appointment:appointments(
              patient:patients(first_name, last_name, email, phone, address)
            )
          )
        `)
        .order("received_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as any[];
    },
  });

  // Real-time subscriptions
  useEffect(() => {
    const invoicesChannel = supabase
      .channel('invoices-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'invoices'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["invoices"] });
        }
      )
      .subscribe();

    const paymentsChannel = supabase
      .channel('payments-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'payments'
        },
        () => {
          qc.invalidateQueries({ queryKey: ["payments"] });
          qc.invalidateQueries({ queryKey: ["invoices"] }); // Also refresh invoices as paid amounts change
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(invoicesChannel);
      supabase.removeChannel(paymentsChannel);
    };
  }, [qc]);

  const recordPayment = useMutation({
    mutationFn: async () => {
      if (!selectedInvoiceId || !paymentAmount) throw new Error("Missing invoice or amount");
      
      const { error } = await supabase
        .from("payments")
        .insert({
          invoice_id: selectedInvoiceId,
          amount: parseFloat(paymentAmount),
          method: paymentMethod,
          reference: paymentReference || null,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Payment recorded", description: "Payment has been saved successfully." });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      setSelectedInvoiceId("");
      setPaymentAmount("");
      setPaymentReference("");
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to record payment.", variant: "destructive" as any });
    },
  });

  const sendInvoiceEmail = useMutation({
    mutationFn: async ({ invoiceId, email }: { invoiceId: string; email: string }) => {
      // The ported edge function is now an API endpoint (task t12): the named
      // helper in src/lib/api.ts posts the body to the endpoint with the
      // session's Authorization header and throws the server's message on
      // failure, so the onError toast reads as before. The endpoint path
      // itself lives only in src/lib/api.ts (t16/W61).
      return apiSendInvoiceEmail({
        invoiceId,
        recipientEmail: email,
      });
    },
    onSuccess: () => {
      toast({ title: "Email sent", description: "Invoice has been sent successfully." });
      setEmailDialogOpen(false);
      setEmailRecipient("");
      setSelectedEmailInvoiceId(null);
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to send email.", variant: "destructive" as any });
    },
  });

  // Send receipt email mutation
  const sendReceiptEmail = useMutation({
    mutationFn: async ({ paymentId, email }: { paymentId: string; email: string }) => {
      // Ported send-receipt-email endpoint via the named helper — see the
      // invoice-email mutation above for the contract.
      return apiSendReceiptEmail({ paymentId, recipientEmail: email });
    },
    onSuccess: () => {
      toast({ title: "Receipt sent", description: "Receipt has been emailed successfully." });
      setReceiptEmailDialogOpen(false);
      setReceiptEmailRecipient("");
      setSelectedReceiptPaymentId(null);
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e?.message || "Failed to send receipt email.", variant: "destructive" as any });
    },
  });

  const printReceipt = (paymentId: string) => {
    const payment = paymentsQuery.data?.find(p => p.id === paymentId);
    if (!payment) return;

    const invoice = invoicesQuery.data?.find(inv => inv.id === payment.invoice_id);
    if (!invoice) return;

    const patient = invoice.appointment?.patient;
    if (!patient) return;

    // Set state for receipt components
    setSelectedReceiptPaymentId(paymentId);

    // Small delay to ensure React has rendered the component
    setTimeout(() => {
      window.print();
    }, 100);
  };

  const handlePrintInvoice = (invoiceId: string) => {
    const invoice = invoicesQuery.data?.find(inv => inv.id === invoiceId);
    if (!invoice) return;

    // Create a new window for printing
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast({ title: "Error", description: "Unable to open print window. Please check popup blockers.", variant: "destructive" as any });
      return;
    }

    // Generate print HTML
    const printHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Invoice #${invoice.id.slice(-8)}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 20px; }
            .info-section { margin-bottom: 20px; }
            .info-section h3 { margin-bottom: 10px; color: #333; }
            .patient-info { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            .items-table th, .items-table td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            .items-table th { background-color: #f8f9fa; font-weight: bold; }
            .totals { float: right; width: 300px; margin-top: 20px; }
            .totals table { width: 100%; border-collapse: collapse; }
            .totals td { padding: 8px; border-bottom: 1px solid #eee; }
            .total-row { font-weight: bold; font-size: 1.1em; border-top: 2px solid #333; }
            .status-badge { 
              display: inline-block; 
              padding: 4px 12px; 
              border-radius: 12px; 
              font-size: 0.85em; 
              font-weight: bold;
              text-transform: uppercase;
            }
            .status-paid { background: #d4edda; color: #155724; }
            .status-issued { background: #fff3cd; color: #856404; }
            .status-draft { background: #f8f9fa; color: #6c757d; }
            .footer { margin-top: 40px; text-align: center; color: #666; font-size: 0.9em; clear: both; }
            @media print { body { margin: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${BRAND.name}</h1>
            <h2>Invoice #${invoice.id.slice(-8)}</h2>
            <p>Date: ${new Date(invoice.created_at).toLocaleDateString()}</p>
            <span class="status-badge status-${invoice.status}">${invoice.status}</span>
          </div>

          <div class="patient-info">
            <h3>Patient Information</h3>
            <p><strong>Name:</strong> ${invoice.appointment?.patient?.first_name} ${invoice.appointment?.patient?.last_name}</p>
            ${invoice.appointment?.patient?.email ? `<p><strong>Email:</strong> ${invoice.appointment.patient.email}</p>` : ''}
            ${invoice.appointment?.patient?.phone ? `<p><strong>Phone:</strong> ${invoice.appointment.patient.phone}</p>` : ''}
            ${invoice.appointment?.patient?.address ? `<p><strong>Address:</strong> ${invoice.appointment.patient.address}</p>` : ''}
          </div>

          ${invoice.appointment?.scheduled_start || invoice.appointment?.reason ? `
            <div class="info-section">
              <h3>Visit Details</h3>
              ${invoice.appointment?.scheduled_start ? `<p><strong>Date:</strong> ${new Date(invoice.appointment.scheduled_start).toLocaleDateString()}</p>` : ''}
              ${invoice.appointment?.reason ? `<p><strong>Reason:</strong> ${invoice.appointment.reason}</p>` : ''}
            </div>
          ` : ''}

          <table class="items-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Quantity</th>
                <th>Unit Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${invoice.invoice_items?.map(item => `
                <tr>
                  <td>${item.service?.name || item.description}</td>
                  <td>${item.quantity}</td>
                  <td>${invoice.currency_code} $${item.unit_price.toFixed(2)}</td>
                  <td>${invoice.currency_code} $${item.line_total.toFixed(2)}</td>
                </tr>
              `).join('') || '<tr><td colspan="4">No items found</td></tr>'}
            </tbody>
          </table>

          <div class="totals">
            <table>
              <tr>
                <td>Subtotal:</td>
                <td>${invoice.currency_code} $${invoice.subtotal.toFixed(2)}</td>
              </tr>
              ${invoice.tax_enabled ? `
                <tr>
                  <td>Tax (${invoice.tax_rate}%):</td>
                  <td>${invoice.currency_code} $${invoice.tax_amount.toFixed(2)}</td>
                </tr>
              ` : ''}
              <tr class="total-row">
                <td>Total:</td>
                <td>${invoice.currency_code} $${invoice.total.toFixed(2)}</td>
              </tr>
              <tr>
                <td>Paid:</td>
                <td>${invoice.currency_code} $${invoice.paid_amount.toFixed(2)}</td>
              </tr>
              <tr class="total-row">
                <td>Outstanding:</td>
                <td>${invoice.currency_code} $${(invoice.total - invoice.paid_amount).toFixed(2)}</td>
              </tr>
            </table>
          </div>

          <div class="footer">
            <p>Thank you for choosing ${BRAND.name}</p>
            <p>For questions about this invoice, please contact us.</p>
          </div>
        </body>
      </html>
    `;

    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus();
    
    // Print after a short delay to ensure content is loaded
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  const selectedViewInvoice = selectedViewInvoiceId ? invoicesQuery.data?.find(inv => inv.id === selectedViewInvoiceId) : null;
  const selectedEmailInvoice = invoicesQuery.data?.find(inv => inv.id === selectedEmailInvoiceId);
  
  // Find selected receipt payment with related data
  const selectedReceiptPayment = paymentsQuery.data?.find(payment => payment.id === selectedReceiptPaymentId);
  const selectedReceiptInvoice = selectedReceiptPayment ? 
    invoicesQuery.data?.find(inv => inv.id === selectedReceiptPayment.invoice_id) : null;
  const selectedReceiptPatient = selectedReceiptInvoice?.appointment?.patient;


  const getStatusBadge = (status: string) => {
    switch (status) {
      case "paid":
        return <Badge className="bg-green-100 text-green-800">Paid</Badge>;
      case "issued":
        return <Badge className="bg-yellow-100 text-yellow-800">Issued</Badge>;
      case "draft":
        return <Badge className="bg-gray-100 text-gray-800">Draft</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const unpaidInvoices = invoicesQuery.data?.filter(inv => inv.status !== "paid" && inv.total > inv.paid_amount) || [];
  const paidInvoices = invoicesQuery.data?.filter(inv => inv.status === "paid" || inv.paid_amount >= inv.total) || [];

  if (invoicesQuery.isLoading) return <div>Loading...</div>;

  return (
    <div className="min-h-screen bg-background">
      <Navigation currentPage="/billing" />

      <main className="container mx-auto px-4 py-6">
        <section className="mb-6">
          <h1 className="text-2xl font-bold">Billing & Payments</h1>
          <p className="text-sm text-muted-foreground">Manage invoices and record payments</p>
        </section>

        <Tabs defaultValue="unpaid" className="w-full">
          <TabsList>
            <TabsTrigger value="unpaid">Unpaid ({unpaidInvoices.length})</TabsTrigger>
            <TabsTrigger value="paid">Paid ({paidInvoices.length})</TabsTrigger>
            <TabsTrigger value="payments">Recent Payments</TabsTrigger>
          </TabsList>

          <TabsContent value="unpaid" className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold">Outstanding Invoices</h2>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Record Payment</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Record Payment</DialogTitle>
                    <DialogDescription>Add a payment for an outstanding invoice</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="invoice-select">Invoice</Label>
                      <Select value={selectedInvoiceId} onValueChange={setSelectedInvoiceId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an invoice" />
                        </SelectTrigger>
                        <SelectContent>
                          {unpaidInvoices.map((inv) => (
                            <SelectItem key={inv.id} value={inv.id}>
                              {inv.appointment?.patient?.first_name} {inv.appointment?.patient?.last_name} - 
                              {formatMoney((inv.total - inv.paid_amount), inv.currency_code)} outstanding
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="amount">Amount</Label>
                      <Input
                        id="amount"
                        type="number"
                        step="0.01"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <Label htmlFor="method">Payment Method</Label>
                      <Select value={paymentMethod} onValueChange={(value: any) => setPaymentMethod(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="card">Card</SelectItem>
                          <SelectItem value="transfer">Transfer</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="reference">Reference (optional)</Label>
                      <Input
                        id="reference"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                        placeholder="Transaction reference"
                      />
                    </div>
                    <Button 
                      onClick={() => recordPayment.mutate()} 
                      disabled={recordPayment.isPending || !selectedInvoiceId || !paymentAmount}
                      className="w-full"
                    >
                      {recordPayment.isPending ? "Recording..." : "Record Payment"}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            <div className="grid gap-4">
              {invoicesQuery.isLoading && <div className="text-sm text-muted-foreground">Loading invoices...</div>}
              {unpaidInvoices.map((invoice) => (
                <Card key={invoice.id}>
                  <CardHeader className="pb-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-base">
                          {invoice.appointment?.patient?.first_name} {invoice.appointment?.patient?.last_name}
                        </CardTitle>
                        <CardDescription>
                          Invoice #{invoice.id.slice(-8)} • {new Date(invoice.created_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                      {getStatusBadge(invoice.status)}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="text-sm text-muted-foreground">Total: {formatMoney(invoice.total, invoice.currency_code)}</div>
                        <div className="text-sm text-muted-foreground">Paid: {formatMoney(invoice.paid_amount, invoice.currency_code)}</div>
                        <div className="font-semibold text-red-600">
                          Outstanding: {formatMoney((invoice.total - invoice.paid_amount), invoice.currency_code)}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setSelectedViewInvoiceId(invoice.id)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        View
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handlePrintInvoice(invoice.id)}
                      >
                        <Printer className="h-4 w-4 mr-1" />
                        Print
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        disabled={!emailEnabled}
                        title={emailEnabled ? undefined : "E-mail is not enabled on this server"}
                        onClick={() => {
                          setSelectedEmailInvoiceId(invoice.id);
                          setEmailRecipient(invoice.appointment?.patient?.email || "");
                          setEmailDialogOpen(true);
                        }}
                      >
                        <Mail className="h-4 w-4 mr-1" />
                        Email
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {unpaidInvoices.length === 0 && !invoicesQuery.isLoading && (
                <div className="text-center py-8 text-muted-foreground">
                  No unpaid invoices found
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="paid" className="space-y-4">
            <h2 className="text-lg font-semibold">Paid Invoices</h2>
            <div className="grid gap-4">
              {paidInvoices.map((invoice) => (
                <Card key={invoice.id}>
                  <CardHeader className="pb-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-base">
                          {invoice.appointment?.patient?.first_name} {invoice.appointment?.patient?.last_name}
                        </CardTitle>
                        <CardDescription>
                          Invoice #{invoice.id.slice(-8)} • {new Date(invoice.created_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                      {getStatusBadge(invoice.status)}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="text-sm text-muted-foreground">Total: {formatMoney(invoice.total, invoice.currency_code)}</div>
                        <div className="font-semibold text-green-600">
                          Paid: {formatMoney(invoice.paid_amount, invoice.currency_code)}
                        </div>
                      </div>
                      </div>
                    <div className="flex gap-2 mt-4">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setSelectedViewInvoiceId(invoice.id)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        View
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handlePrintInvoice(invoice.id)}
                      >
                        <Printer className="h-4 w-4 mr-1" />
                        Print
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        disabled={!emailEnabled}
                        title={emailEnabled ? undefined : "E-mail is not enabled on this server"}
                        onClick={() => {
                          setSelectedEmailInvoiceId(invoice.id);
                          setEmailRecipient(invoice.appointment?.patient?.email || "");
                          setEmailDialogOpen(true);
                        }}
                      >
                        <Mail className="h-4 w-4 mr-1" />
                        Email
                      </Button>
                    </div>
                    </CardContent>
                </Card>
              ))}
              {paidInvoices.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No paid invoices found
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="payments" className="space-y-4">
            <h2 className="text-lg font-semibold">Recent Payments</h2>
            <div className="grid gap-4">
              {paymentsQuery.isLoading && <div className="text-sm text-muted-foreground">Loading payments...</div>}
              {paymentsQuery.data?.map((payment) => (
                <Card key={payment.id}>
                  <CardHeader className="pb-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-base">
                          {payment.invoice?.appointment?.patient?.first_name} {payment.invoice?.appointment?.patient?.last_name}
                        </CardTitle>
                        <CardDescription>
                          Payment • {new Date(payment.received_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                      <Badge className="bg-blue-100 text-blue-800 capitalize">{payment.method}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-semibold">{formatMoney(payment.amount, currency)}</div>
                        {payment.reference && (
                          <div className="text-sm text-muted-foreground">Ref: {payment.reference}</div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => printReceipt(payment.id)}
                          className="print-hide"
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!emailEnabled}
                          title={emailEnabled ? undefined : "E-mail is not enabled on this server"}
                          onClick={() => {
                            setSelectedReceiptPaymentId(payment.id);
                            setReceiptEmailDialogOpen(true);
                            // Pre-fill with patient email if available
                            const invoice = invoicesQuery.data?.find(inv => inv.id === payment.invoice_id);
                            const patientEmail = invoice?.appointment?.patient?.email;
                            if (patientEmail) {
                              setReceiptEmailRecipient(patientEmail);
                            }
                          }}
                          className="print-hide"
                        >
                          <Mail className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {paymentsQuery.data?.length === 0 && !paymentsQuery.isLoading && (
                <div className="text-center py-8 text-muted-foreground">
                  No payments found
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Receipt View for Printing */}
        {selectedReceiptPaymentId && selectedReceiptPayment && selectedReceiptInvoice && selectedReceiptPatient && (
          <div className="print-only fixed inset-0 bg-white z-50 hidden">
            <ReceiptView
              payment={selectedReceiptPayment}
              invoice={selectedReceiptInvoice}
              patient={selectedReceiptPatient}
              isPrintMode={true}
            />
          </div>
        )}

        {/* Invoice View Dialog */}
        <Dialog open={!!selectedViewInvoiceId} onOpenChange={(open) => !open && setSelectedViewInvoiceId(null)}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Invoice Details</DialogTitle>
            </DialogHeader>
            {selectedViewInvoice && <InvoiceView invoice={selectedViewInvoice} />}
          </DialogContent>
        </Dialog>

        {/* Email Invoice Dialog */}
        <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send Invoice via Email</DialogTitle>
              <DialogDescription>Enter the recipient's email address to send the invoice</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="email-recipient">Recipient Email</Label>
                <Input
                  id="email-recipient"
                  type="email"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                  placeholder="patient@example.test"
                />
              </div>
              <div className="flex gap-2">
                <Button 
                  onClick={() => {
                    if (selectedEmailInvoiceId && emailRecipient) {
                      sendInvoiceEmail.mutate({ 
                        invoiceId: selectedEmailInvoiceId, 
                        email: emailRecipient 
                      });
                    }
                  }} 
                  disabled={sendInvoiceEmail.isPending || !emailRecipient || !selectedEmailInvoiceId}
                  className="flex-1"
                >
                  {sendInvoiceEmail.isPending ? "Sending..." : "Send Email"}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => setEmailDialogOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Email Receipt Dialog */}
        <Dialog open={receiptEmailDialogOpen} onOpenChange={setReceiptEmailDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send Receipt via Email</DialogTitle>
              <DialogDescription>Enter the recipient's email address to send the payment receipt</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="receipt-email-recipient">Recipient Email</Label>
                <Input
                  id="receipt-email-recipient"
                  type="email"
                  value={receiptEmailRecipient}
                  onChange={(e) => setReceiptEmailRecipient(e.target.value)}
                  placeholder="patient@example.test"
                />
              </div>
              <div className="flex gap-2">
                <Button 
                  onClick={() => {
                    if (selectedReceiptPaymentId && receiptEmailRecipient) {
                      sendReceiptEmail.mutate({ 
                        paymentId: selectedReceiptPaymentId, 
                        email: receiptEmailRecipient 
                      });
                    }
                  }} 
                  disabled={sendReceiptEmail.isPending || !receiptEmailRecipient || !selectedReceiptPaymentId}
                  className="flex-1"
                >
                  {sendReceiptEmail.isPending ? "Sending..." : "Send Receipt"}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => setReceiptEmailDialogOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </main>
      <AppFooter />
    </div>
  );
}
