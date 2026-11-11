// tests/legacy/send-invoice-email.legacy.mjs — VERBATIM reference builders for
// the shipped invoice e-mail edge function (task t13; feeds the S29 contract
// suite in tests/contract/).
//
// The invoiceHtml statement below (its comment line included) is copied byte
// for byte from supabase/functions/send-invoice-email/index.ts lines 79-189,
// and the subject template from line 195 — CRLF line endings and trailing
// whitespace included — so tests/contract/legacy-source.test.mjs finds every
// template literal here verbatim in the shipped file. Do not "clean up" this
// file: drift on either side alone must fail that proof.
//
// The only difference from the shipped file, sanctioned by task t13: the two
// new Date(x).toLocaleDateString() interpolations become the pinned
// legacyDate(x) of api/lib/format.mjs (the same UTC en-US characters the hosted
// Deno runtime produced; the contract runner pins TZ=UTC). The Deno serve +
// createClient + Resend harness is replaced by the injected invoice argument —
// the nested PostgREST-shaped row the shipped .select() returned, exactly as
// tests/fixtures/invoices-*.json describe it.
//
// This reference must NOT apply escapeHtml or any other S10 fix: rendering
// patient data exactly as the shipped template did — unescaped — is its whole
// purpose. api/lib/email-invoice.mjs escapes; the contract tests diff the two
// and expect only the escaped values to differ (byte-identical otherwise,
// same totals block, same subject).

import { legacyDate } from '../../api/lib/format.mjs';

// buildInvoiceHtml(invoice): the shipped invoiceHtml template literal verbatim.
export function buildInvoiceHtml(invoice) {
    // Generate HTML email content
    const invoiceHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; }
            .header { text-align: center; margin-bottom: 30px; }
            .invoice-details { margin-bottom: 30px; }
            .patient-info { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            .items-table th, .items-table td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            .items-table th { background-color: #f8f9fa; font-weight: bold; }
            .totals { float: right; width: 300px; }
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
            .footer { margin-top: 40px; text-align: center; color: #666; font-size: 0.9em; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Harbourview Medical Centre</h1>
            <h2>Invoice #${invoice.id.slice(-8)}</h2>
            <p>Date: ${legacyDate(invoice.created_at)}</p>
            <span class="status-badge status-${invoice.status}">${invoice.status}</span>
          </div>

          <div class="patient-info">
            <h3>Patient Information</h3>
            <p><strong>Name:</strong> ${invoice.appointment?.patient?.first_name} ${invoice.appointment?.patient?.last_name}</p>
            ${invoice.appointment?.patient?.email ? `<p><strong>Email:</strong> ${invoice.appointment?.patient.email}</p>` : ''}
            ${invoice.appointment?.patient?.phone ? `<p><strong>Phone:</strong> ${invoice.appointment?.patient.phone}</p>` : ''}
            ${invoice.appointment?.patient?.address ? `<p><strong>Address:</strong> ${invoice.appointment?.patient.address}</p>` : ''}
          </div>

          <div class="invoice-details">
            <h3>Visit Details</h3>
            ${invoice.appointment?.scheduled_start ? `<p><strong>Date:</strong> ${legacyDate(invoice.appointment.scheduled_start)}</p>` : ''}
            ${invoice.appointment?.reason ? `<p><strong>Reason:</strong> ${invoice.appointment.reason}</p>` : ''}
          </div>

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

          <div style="clear: both;"></div>

          <div class="footer">
            <p>Thank you for choosing Harbourview Medical Centre</p>
            <p>For questions about this invoice, please contact us.</p>
          </div>
        </body>
      </html>
    `;
  return invoiceHtml;
}

// The subject the shipped function passed to Resend (shipped line 195, verbatim).
export function invoiceEmailSubject(invoice) {
  return `Invoice #${invoice.id.slice(-8)} from Harbourview Medical Centre`;
}
