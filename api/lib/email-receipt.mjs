// api/lib/email-receipt.mjs — the payment-receipt e-mail HTML builder (task t11).
//
// The mechanical port of the shipped send-receipt-email function's
// `emailHtml` literal in supabase/functions/send-receipt-email/index.ts:
// every static character and space copied from the shipped source (the line
// breaks are the LF the language gives a template literal, exactly what the
// shipped function sent regardless of the source file's own line endings).
// Only the interpolations change, in the two ways milestone 4 fixes:
//
//   * S10 — every interpolated value passes through api/lib/escape.mjs, so
//     patient data and a free-text payment reference can never inject markup
//     into the receipt (W47);
//   * the Date/Time rows go through api/lib/format.mjs (legacyDate/legacyTime),
//     pinning the UTC en-US rendering the hosted runtime produced.
//
// The object argument is the PostgREST-shaped row api/queries/payment-detail.mjs
// returns — payment plus `invoices.appointments.patients` — so the template
// reads exactly the paths the shipped code did. The query INNER JOINs
// appointments/patients, so `patient` is a resolved object on every row that
// reaches this builder (the ?? fallbacks keep the legacy behaviour for unit
// fixtures).

import { escapeHtml } from './escape.mjs';
import { legacyDate, legacyTime } from './format.mjs';

// receiptNumberFor(payment) / invoiceReferenceFor(invoice): the two display
// numbers the shipped function computed before the template — 'R' + the last
// eight characters of the payment id, upper-cased, and '#' + the last eight
// of the invoice id, upper-cased. Shared with the route, whose subject line
// embeds the receipt number (W45).
export function receiptNumberFor(payment) {
  return `R${payment.id.slice(-8).toUpperCase()}`;
}

export function invoiceReferenceFor(invoice) {
  return `#${invoice.id.slice(-8).toUpperCase()}`;
}

// buildReceiptEmailHtml(payment): the receipt, exactly as the shipped function
// rendered it — modulo the S10 escaping and the pinned date/time.
export function buildReceiptEmailHtml(payment) {
  const invoice = payment.invoices ?? {};
  const appt = invoice.appointments ?? {};
  const patient = appt.patients ?? {};
  const receiptNumber = receiptNumberFor(payment);
  const invoiceNumber = invoiceReferenceFor(invoice);
  return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Receipt</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f5f5f5; }
            .receipt-container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #eee; }
            .receipt-title { color: #2563eb; font-size: 28px; font-weight: bold; margin: 0; }
            .receipt-number { color: #666; margin: 5px 0; }
            .section { margin: 25px 0; }
            .section-title { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #eee; }
            .detail-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
            .detail-row:last-child { border-bottom: none; }
            .detail-label { color: #666; }
            .detail-value { font-weight: 500; }
            .amount-highlight { font-size: 20px; font-weight: bold; color: #059669; }
            .payment-method { background: #f3f4f6; padding: 4px 12px; border-radius: 20px; font-size: 14px; text-transform: capitalize; }
            .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; }
            .footer p { margin: 5px 0; }
          </style>
        </head>
        <body>
          <div class="receipt-container">
            <div class="header">
              <h1 class="receipt-title">Payment Receipt</h1>
              <p class="receipt-number">Receipt ${escapeHtml(receiptNumber)}</p>
            </div>
            
            <div class="section">
              <h2 class="section-title">Receipt Details</h2>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${legacyDate(payment.received_at)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${legacyTime(payment.received_at)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Invoice:</span>
                <span class="detail-value">${escapeHtml(invoiceNumber)}</span>
              </div>
            </div>
            
            <div class="section">
              <h2 class="section-title">Patient Information</h2>
              <div class="detail-row">
                <span class="detail-label">Name:</span>
                <span class="detail-value">${escapeHtml(patient.first_name)} ${escapeHtml(patient.last_name)}</span>
              </div>
              ${patient.email ? `
                <div class="detail-row">
                  <span class="detail-label">Email:</span>
                  <span class="detail-value">${escapeHtml(patient.email)}</span>
                </div>
              ` : ''}
              ${patient.phone ? `
                <div class="detail-row">
                  <span class="detail-label">Phone:</span>
                  <span class="detail-value">${escapeHtml(patient.phone)}</span>
                </div>
              ` : ''}
            </div>
            
            <div class="section">
              <h2 class="section-title">Payment Details</h2>
              <div class="detail-row">
                <span class="detail-label">Payment Method:</span>
                <span class="payment-method">${escapeHtml(payment.method)}</span>
              </div>
              ${payment.reference ? `
                <div class="detail-row">
                  <span class="detail-label">Reference:</span>
                  <span class="detail-value">${escapeHtml(payment.reference)}</span>
                </div>
              ` : ''}
              <div class="detail-row">
                <span class="detail-label">Invoice Total:</span>
                <span class="detail-value">${escapeHtml(invoice.currency_code)} $${escapeHtml(invoice.total.toFixed(2))}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount Paid:</span>
                <span class="detail-value amount-highlight">${escapeHtml(invoice.currency_code)} $${escapeHtml(payment.amount.toFixed(2))}</span>
              </div>
            </div>
            
            <div class="footer">
              <p><strong>Thank you for your payment!</strong></p>
              <p>Please keep this receipt for your records.</p>
            </div>
          </div>
        </body>
      </html>
    `;
}

// The subject the shipped function passed to Resend, unchanged.
export function receiptEmailSubject(payment) {
  return `Payment Receipt ${receiptNumberFor(payment)}`;
}
