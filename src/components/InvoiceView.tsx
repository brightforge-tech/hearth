import { BRAND } from "@/lib/brand";
import { formatMoney } from "@/lib/currency";
import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/Logo";

interface InvoiceViewProps {
  invoice: {
    id: string;
    total: number;
    paid_amount: number;
    currency_code: string;
    created_at: string;
    status: string;
    subtotal: number;
    tax_amount: number;
    tax_enabled: boolean;
    tax_rate: number;
    appointment?: {
      scheduled_start?: string;
      reason?: string;
      patient?: {
        first_name: string;
        last_name: string;
        email?: string;
        phone?: string;
        address?: string;
      };
    };
    invoice_items?: Array<{
      description: string;
      quantity: number;
      unit_price: number;
      line_total: number;
      service?: {
        name: string;
      };
    }>;
  };
  isPrintMode?: boolean;
}

export function InvoiceView({ invoice, isPrintMode = false }: InvoiceViewProps) {
  const getStatusBadge = (status: string) => {
    const baseClasses = "inline-block px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wide";
    switch (status) {
      case "paid":
        return <span className={`${baseClasses} bg-green-100 text-green-800`}>Paid</span>;
      case "issued":
        return <span className={`${baseClasses} bg-yellow-100 text-yellow-800`}>Issued</span>;
      case "draft":
        return <span className={`${baseClasses} bg-gray-100 text-gray-800`}>Draft</span>;
      default:
        return <span className={baseClasses}>{status}</span>;
    }
  };

  return (
    <div className={`max-w-4xl mx-auto ${isPrintMode ? 'print:max-w-none print:mx-0' : ''}`}>
      {/* Print-specific styles */}
      <style dangerouslySetInnerHTML={{
        __html: `
          @media print {
            body { -webkit-print-color-adjust: exact; }
            .no-print { display: none !important; }
            .print-break { page-break-after: always; }
            .print-break-before { page-break-before: always; }
            img { 
              display: block !important; 
              visibility: visible !important;
              opacity: 1 !important;
              max-width: none !important;
            }
            .logo-container { 
              display: flex !important; 
              justify-content: center !important;
              margin-bottom: 1rem !important;
            }
            .logo-container img { 
              height: 4rem !important; 
              width: auto !important;
              display: block !important;
            }
          }
        `
      }} />

      {/* Header */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4 logo-container">
          <Logo className="h-16 w-auto" showText={false} />
        </div>
        <h2 className="text-xl font-semibold mb-2">Invoice #{invoice.id.slice(-8)}</h2>
        <div className="flex justify-center items-center gap-4 mb-2">
          <span>Date: {new Date(invoice.created_at).toLocaleDateString()}</span>
          {getStatusBadge(invoice.status)}
        </div>
      </div>

      {/* Patient Information */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Patient Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p><strong>Name:</strong> {invoice.appointment?.patient?.first_name} {invoice.appointment?.patient?.last_name}</p>
              {invoice.appointment?.patient?.email && (
                <p><strong>Email:</strong> {invoice.appointment.patient.email}</p>
              )}
              {invoice.appointment?.patient?.phone && (
                <p><strong>Phone:</strong> {invoice.appointment.patient.phone}</p>
              )}
            </div>
            <div>
              {invoice.appointment?.patient?.address && (
                <p><strong>Address:</strong> {invoice.appointment.patient.address}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Visit Details */}
      {(invoice.appointment?.scheduled_start || invoice.appointment?.reason) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Visit Details</CardTitle>
          </CardHeader>
          <CardContent>
            {invoice.appointment?.scheduled_start && (
              <p><strong>Date:</strong> {new Date(invoice.appointment.scheduled_start).toLocaleDateString()}</p>
            )}
            {invoice.appointment?.reason && (
              <p><strong>Reason:</strong> {invoice.appointment.reason}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Invoice Items */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Services & Items</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-4">Service</th>
                  <th className="text-center py-2 px-4">Quantity</th>
                  <th className="text-right py-2 px-4">Unit Price</th>
                  <th className="text-right py-2 px-4">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.invoice_items?.map((item, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-2 px-4">{item.service?.name || item.description}</td>
                    <td className="text-center py-2 px-4">{item.quantity}</td>
                    <td className="text-right py-2 px-4">{formatMoney(item.unit_price, invoice.currency_code)}</td>
                    <td className="text-right py-2 px-4">{formatMoney(item.line_total, invoice.currency_code)}</td>
                  </tr>
                )) || (
                  <tr>
                    <td colSpan={4} className="text-center py-4 text-muted-foreground">No items found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Totals */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex justify-end">
            <div className="w-full max-w-sm">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span>{formatMoney(invoice.subtotal, invoice.currency_code)}</span>
                </div>
                {invoice.tax_enabled && (
                  <div className="flex justify-between">
                    <span>Tax ({invoice.tax_rate}%):</span>
                    <span>{formatMoney(invoice.tax_amount, invoice.currency_code)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Total:</span>
                  <span>{formatMoney(invoice.total, invoice.currency_code)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Paid:</span>
                  <span>{formatMoney(invoice.paid_amount, invoice.currency_code)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg border-t pt-2">
                  <span>Outstanding:</span>
                  <span className={invoice.total - invoice.paid_amount > 0 ? "text-red-600" : "text-green-600"}>
                    {formatMoney((invoice.total - invoice.paid_amount), invoice.currency_code)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-muted-foreground text-sm mt-8">
        <p>Thank you for choosing {BRAND.name}</p>
        <p>For questions about this invoice, please contact us.</p>
      </div>
    </div>
  );
}