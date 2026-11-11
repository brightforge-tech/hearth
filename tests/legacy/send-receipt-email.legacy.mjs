// tests/legacy/send-receipt-email.legacy.mjs — VERBATIM reference builders for
// the shipped payment-receipt e-mail edge function (task t13; feeds the S29
// contract suite in tests/contract/).
//
// The const invoice / const patient accessor lines, the receiptNumber and
// invoiceNumber lines and the whole emailHtml statement (their comment line
// included) are copied byte for byte from supabase/functions/send-receipt-email/
// index.ts lines 67-68 and 73-174, and the subject template from line 180 — CRLF
// line endings and trailing whitespace included — so tests/contract/
// legacy-source.test.mjs finds every template literal here verbatim in the
// shipped file. Do not "clean up" this file: drift on either side alone must
// fail that proof.
//
// The only differences from the shipped file, all sanctioned by task t13:
//   * the Date/Time interpolations, new Date(payment.received_at).toLoc-
//     aleDateString() / .toLocaleTimeString(), become the pinned legacyDate/
//     legacyTime of api/lib/format.mjs (the same UTC en-US characters the hosted
//     Deno runtime produced; the contract runner pins TZ=UTC);
//   * const receiptNumber / const invoiceNumber read let: in the shipped code
//     they were per-request locals of the handler; here they are locals of
//     buildReceiptHtml, and receiptEmailSubject recomputes the receipt number
//     with the shipped template line verbatim — the declaration keyword is the
//     only change to those lines;
//   * the Deno serve + createClient + Resend harness is replaced by the injected
//     payment argument — the nested PostgREST-shaped row the shipped .select()
//     returned, exactly as tests/fixtures/receipt.json describes it.
//
// This reference must NOT apply escapeHtml or any other S10 fix: rendering the
// patient and reference data exactly as the shipped template did — unescaped —
// is its whole purpose. api/lib/email-receipt.mjs escapes; the contract tests
// diff the two and expect only the escaped values to differ (byte-identical
// otherwise, same numbers, same subject).

import { legacyDate, legacyTime } from '../../api/lib/format.mjs';

// buildReceiptHtml(payment): the shipped invoice/patient accessors, the
// receiptNumber + invoiceNumber lines and the emailHtml template literal
// verbatim, from the shipped payment row.
export function buildReceiptHtml(payment) {
    const invoice = payment.invoices;
    const patient = invoice.appointments.patients;

    let receiptNumber = `R${payment.id.slice(-8).toUpperCase()}`;
    let invoiceNumber = `#${invoice.id.slice(-8).toUpperCase()}`;

    // Generate receipt email HTML
    const emailHtml = `
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
              <p class="receipt-number">Receipt ${receiptNumber}</p>
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
                <span class="detail-value">${invoiceNumber}</span>
              </div>
            </div>
            
            <div class="section">
              <h2 class="section-title">Patient Information</h2>
              <div class="detail-row">
                <span class="detail-label">Name:</span>
                <span class="detail-value">${patient.first_name} ${patient.last_name}</span>
              </div>
              ${patient.email ? `
                <div class="detail-row">
                  <span class="detail-label">Email:</span>
                  <span class="detail-value">${patient.email}</span>
                </div>
              ` : ''}
              ${patient.phone ? `
                <div class="detail-row">
                  <span class="detail-label">Phone:</span>
                  <span class="detail-value">${patient.phone}</span>
                </div>
              ` : ''}
            </div>
            
            <div class="section">
              <h2 class="section-title">Payment Details</h2>
              <div class="detail-row">
                <span class="detail-label">Payment Method:</span>
                <span class="payment-method">${payment.method}</span>
              </div>
              ${payment.reference ? `
                <div class="detail-row">
                  <span class="detail-label">Reference:</span>
                  <span class="detail-value">${payment.reference}</span>
                </div>
              ` : ''}
              <div class="detail-row">
                <span class="detail-label">Invoice Total:</span>
                <span class="detail-value">${invoice.currency_code} $${invoice.total.toFixed(2)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount Paid:</span>
                <span class="detail-value amount-highlight">${invoice.currency_code} $${payment.amount.toFixed(2)}</span>
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
  return emailHtml;
}

// The subject the shipped function passed to Resend: the same receiptNumber the
// template got, computed with the shipped line 73 verbatim, interpolated with
// the shipped subject template (shipped line 180).
export function receiptEmailSubject(payment) {
  let receiptNumber = `R${payment.id.slice(-8).toUpperCase()}`;
  return `Payment Receipt ${receiptNumber}`;
}
