import React from "react";
import { formatMoney } from "@/lib/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/Logo";

interface Payment {
  id: string;
  amount: number;
  method: string;
  reference?: string;
  received_at: string;
}

interface Patient {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  address?: string;
}

interface Invoice {
  id: string;
  total: number;
  currency_code: string;
  created_at: string;
  status: string;
}

interface ReceiptViewProps {
  payment: Payment;
  invoice: Invoice;
  patient: Patient;
  isPrintMode?: boolean;
}

export function ReceiptView({ payment, invoice, patient, isPrintMode = false }: ReceiptViewProps) {
  const receiptNumber = `R${payment.id.slice(-8).toUpperCase()}`;
  
  return (
    <div className={`receipt-container ${isPrintMode ? 'print-mode' : ''}`}>
      <style>{`
        @media print {
          .print-only {
            display: block !important;
          }
          
          .receipt-container {
            max-width: none !important;
            box-shadow: none !important;
            border: none !important;
          }
          
          .print-hide {
            display: none !important;
          }
          
          .logo-container img {
            display: block !important;
            max-height: 60px !important;
            width: auto !important;
            -webkit-print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          
          body * {
            visibility: hidden;
          }
          
          .print-only, .print-only * {
            visibility: visible;
          }
          
          .print-only .receipt-container, .print-only .receipt-container * {
            visibility: visible;
          }
          
          .print-only .receipt-container {
            position: absolute;
            left: 0;
            top: 0;
            width: 100% !important;
          }
        }
      `}</style>
      
      <Card className="max-w-md mx-auto">
        <CardHeader className="text-center space-y-4">
          <div className="logo-container flex justify-center">
            <Logo />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold">Payment Receipt</CardTitle>
            <p className="text-muted-foreground">Receipt #{receiptNumber}</p>
          </div>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {/* Receipt Details */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Date:</span>
              <span>{new Date(payment.received_at).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Time:</span>
              <span>{new Date(payment.received_at).toLocaleTimeString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Invoice:</span>
              <span>#{invoice.id.slice(-8).toUpperCase()}</span>
            </div>
          </div>
          
          <Separator />
          
          {/* Patient Information */}
          <div className="space-y-2">
            <h3 className="font-semibold">Patient Information</h3>
            <div className="text-sm space-y-1">
              <div>{patient.first_name} {patient.last_name}</div>
              {patient.email && <div className="text-muted-foreground">{patient.email}</div>}
              {patient.phone && <div className="text-muted-foreground">{patient.phone}</div>}
            </div>
          </div>
          
          <Separator />
          
          {/* Payment Details */}
          <div className="space-y-4">
            <h3 className="font-semibold">Payment Details</h3>
            
            <div className="space-y-2">
              <div className="flex justify-between">
                <span>Payment Method:</span>
                <Badge variant="outline" className="capitalize">{payment.method}</Badge>
              </div>
              
              {payment.reference && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Reference:</span>
                  <span>{payment.reference}</span>
                </div>
              )}
              
              <div className="flex justify-between">
                <span>Invoice Total:</span>
                <span>{formatMoney(invoice.total, invoice.currency_code)}</span>
              </div>
              
              <div className="flex justify-between font-semibold text-lg">
                <span>Amount Paid:</span>
                <span>{formatMoney(payment.amount, invoice.currency_code)}</span>
              </div>
            </div>
          </div>
          
          <Separator />
          
          {/* Footer */}
          <div className="text-center text-sm text-muted-foreground">
            <p>Thank you for your payment!</p>
            <p className="mt-2">Please keep this receipt for your records.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}