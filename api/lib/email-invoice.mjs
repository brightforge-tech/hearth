// api/lib/email-invoice.mjs — the invoice e-mail HTML builder (task t11).
//
// The template below is a MECHANICAL port of the shipped send-invoice-email
// function's `invoiceHtml` literal in supabase/functions/send-invoice-email/
// index.ts: every static character and space is copied from the shipped
// source (the line breaks are the LF the language gives a template literal,
// which is exactly what the shipped function sent regardless of the source
// file's own line endings). Only the interpolations differ, in exactly the
// three ways milestone 4 fixes:
//
//   * S10 — every interpolated value passes through api/lib/escape.mjs, so
//     patient data and the appointment reason can never inject markup or an
//     event handler into the mail (W47);
//   * the two dates go through api/lib/format.mjs (legacyDate), which pins
//     the UTC en-US rendering the hosted runtime produced (W45);
//   * the numbers arrive as JSON numbers from api/queries/invoice-detail.mjs
//     — and each item row there carries its OWN tax_amount/total (S8), so the
//     totals block is the invoice's, while the line data never repeats it.
//
// The object argument is the PostgREST-shaped row the query returns, so the
// template reads the same paths the shipped code did. `patient`/`appt`/
// `invoice_items` are the legacy `invoice.appointment?.patient?`/`invoice
// .appointment?`/`invoice.invoice_items?` chains resolved once; the query
// INNER JOINs appointments and patients, so on every row that reaches this
// builder they are the real objects (the ?? fallbacks exist for unit fixtures
// and keep the legacy truthiness otherwise).

import { CLINIC_NAME } from './brand.mjs';
import { escapeHtml } from './escape.mjs';
import { legacyDate } from './format.mjs';

// buildInvoiceEmailHtml(invoice): the invoice letter, exactly as the shipped
// function rendered it — modulo the S10 escaping and the pinned dates.
export function buildInvoiceEmailHtml(invoice) {
  const appt = invoice.appointment ?? {};
  const patient = appt.patient ?? {};
  const invoice_items = invoice.invoice_items ?? [];
  return `
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
            <h1>${CLINIC_NAME}</h1>
            <h2>Invoice #${escapeHtml(invoice.id.slice(-8))}</h2>
            <p>Date: ${legacyDate(invoice.created_at)}</p>
            <span class="status-badge status-${escapeHtml(invoice.status)}">${escapeHtml(invoice.status)}</span>
          </div>

          <div class="patient-info">
            <h3>Patient Information</h3>
            <p><strong>Name:</strong> ${escapeHtml(patient.first_name)} ${escapeHtml(patient.last_name)}</p>
            ${patient.email ? `<p><strong>Email:</strong> ${escapeHtml(patient.email)}</p>` : ''}
            ${patient.phone ? `<p><strong>Phone:</strong> ${escapeHtml(patient.phone)}</p>` : ''}
            ${patient.address ? `<p><strong>Address:</strong> ${escapeHtml(patient.address)}</p>` : ''}
          </div>

          <div class="invoice-details">
            <h3>Visit Details</h3>
            ${appt.scheduled_start ? `<p><strong>Date:</strong> ${legacyDate(appt.scheduled_start)}</p>` : ''}
            ${appt.reason ? `<p><strong>Reason:</strong> ${escapeHtml(appt.reason)}</p>` : ''}
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
              ${invoice_items.map(item => `
                <tr>
                  <td>${escapeHtml(item.service?.name || item.description)}</td>
                  <td>${escapeHtml(item.quantity)}</td>
                  <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(item.unit_price.toFixed(2))}</td>
                  <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(item.line_total.toFixed(2))}</td>
                </tr>
              `).join('') || '<tr><td colspan="4">No items found</td></tr>'}
            </tbody>
          </table>

          <div class="totals">
            <table>
              <tr>
                <td>Subtotal:</td>
                <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(invoice.subtotal.toFixed(2))}</td>
              </tr>
              ${invoice.tax_enabled ? `
                <tr>
                  <td>Tax (${Number(invoice.tax_rate) || 0}%):</td>
                  <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(invoice.tax_amount.toFixed(2))}</td>
                </tr>
              ` : ''}
              <tr class="total-row">
                <td>Total:</td>
                <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(invoice.total.toFixed(2))}</td>
              </tr>
              <tr>
                <td>Paid:</td>
                <td>${escapeHtml(invoice.currency_code)} $${escapeHtml(invoice.paid_amount.toFixed(2))}</td>
              </tr>
              <tr class="total-row">
                <td>Outstanding:</td>
                <td>${escapeHtml(invoice.currency_code)} $${escapeHtml((invoice.total - invoice.paid_amount).toFixed(2))}</td>
              </tr>
            </table>
          </div>

          <div style="clear: both;"></div>

          <div class="footer">
            <p>Thank you for choosing ${CLINIC_NAME}</p>
            <p>For questions about this invoice, please contact us.</p>
          </div>
        </body>
      </html>
    `;
}

// The subject the shipped function passed to Resend, unchanged.
export function invoiceEmailSubject(invoice) {
  return `Invoice #${invoice.id.slice(-8)} from ${CLINIC_NAME}`;
}
