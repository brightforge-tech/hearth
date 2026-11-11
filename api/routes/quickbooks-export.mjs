// api/routes/quickbooks-export.mjs — the QuickBooks CSV export, ported from
// supabase/functions/quickbooks-export (task t10).
//
// The response contract stays what Exports.tsx (and, until the cutover, the
// shipped function) produced: a CSV body with the exact header lines, the
// legacy `INV-`/`PAY-` + last-eight-characters id cells, one CSV row per
// invoice item (a legacy quirk the QuickBooks template depends on), the
// `attachment; filename="quickbooks-<type>-<start>-to-<end>.csv"` header, and
// on failure the flat `{"error": "<message>"}` JSON with the legacy status —
// `Invalid export type` as a 500 exactly as the shipped throw produced.
//
// What changes with the port (the milestone-4 fixes):
//
//   * S27 — the endpoint is no longer reachable by anyone: requireAuth plus
//     requireRole('admin','moderator','user') gate it before any SQL runs. A
//     missing/forged/expired session answers 401 and a roleless session 403
//     with the standard error envelope; a user with no role never sees a CSV.
//   * S6 — every cell goes through api/lib/csv.mjs: embedded quotes are
//     doubled (the legacy `"${customer}"` template broke the layout on a name
//     like O"Neil, Bob), and a string starting = + - @ tab or CR is prefixed
//     with a single quote so no spreadsheet evaluates it as a formula. The
//     only raw cell is the Taxable Y/N token, the one cell the legacy
//     template itself wrote unquoted (`item.taxable ? "Y" : "N"`); the
//     Currency code the legacy wrote QUOTED — `"${invoice.currency_code}"` —
//     so it goes through csvCell and stays quoted.
//   * S8 — the legacy row repeated the INVOICE-level tax_amount and total on
//     every item line (`invoice.tax_amount || 0`, `invoice.total`), so a
//     three-item invoice imported into QuickBooks with tripled tax. The port
//     computes tax and total per line: tax = line_total x tax_rate% for a
//     taxable line (0 otherwise, honouring the invoice's tax_enabled flag,
//     exactly like recalc_invoice_totals), total = line_total + tax.
//   * the Date cell pins timeZone UTC through api/lib/format.mjs instead of
//     following whatever locale the runtime happened to have.
//
// The date range is validated first: an endDate earlier than startDate is a
// 400 `{"error":"Invalid date range"}` and runs no query — the legacy function
// would have handed the inverted range to PostgREST.
//
// The two PostgREST embeds the shipped code used are reproduced as
// hand-written SQL in api/queries/exports.mjs; everything above that stays the
// legacy row-building template, so the columns, their order and the row
// multiplicity are unchanged.

import { Router } from 'express';
import { clientIp, recordAudit } from '../lib/audit.mjs';

import { asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { csvRaw, csvHeaderRow, csvRow } from '../lib/csv.mjs';
import { legacyDate } from '../lib/format.mjs';
import { fetchInvoiceExport, fetchPaymentExport, fetchExpenseExport, parseDateRange } from '../queries/exports.mjs';

// The header arrays, copied from the shipped function (the join+newline now
// lives in csvHeaderRow).
export const INVOICE_CSV_HEADERS = [
  'Date',
  'Customer',
  'Customer Email',
  'Invoice Number',
  'Item Description',
  'Quantity',
  'Rate',
  'Amount',
  'Taxable',
  'Tax Amount',
  'Total',
  'Currency',
];

export const PAYMENT_CSV_HEADERS = [
  'Date',
  'Customer',
  'Invoice Number',
  'Payment Method',
  'Amount',
  'Reference',
  'Payment ID',
];

// round2: the two-decimal rounding recalc_invoice_totals applies in SQL; a CSV
// cell must never show a float artefact like 2.0099999999999998.
function round2(value) {
  return Math.round(value * 100) / 100;
}

// buildInvoicesCsv(rows, startDate, endDate): the shipped function's body —
// same interpolation, same row order — with the S6/S8 fixes applied through
// the csv/format helpers. One CSV row per invoice item (legacy multiplicity).
export function buildInvoicesCsv(invoices, { startDate, endDate }) {
  let csvContent = csvHeaderRow(INVOICE_CSV_HEADERS);

  for (const invoice of invoices ?? []) {
    const customer = `${invoice.appointment?.patient?.first_name || ''} ${invoice.appointment?.patient?.last_name || ''}`.trim();
    const email = invoice.appointment?.patient?.email || '';
    const date = legacyDate(invoice.created_at);
    const taxRate = Number(invoice.tax_rate) || 0;

    for (const item of invoice.invoice_items ?? []) {
      // S8: per-line figures. recalc_invoice_totals charges tax only when the
      // invoice enables tax AND the line is taxable; the line's total then
      // carries its own tax, never the invoice's.
      const lineTotal = Number(item.line_total);
      const lineTax = invoice.tax_enabled && item.taxable ? round2((lineTotal * taxRate) / 100) : 0;
      const row = [
        date, //                       legacy: `"${date}"`            -> quoted
        customer, //                   legacy: `"${customer}"`        -> quoted, now escaped
        email, //                      legacy: `"${email}"`           -> quoted, now escaped
        `INV-${invoice.id.slice(-8)}`, // legacy: quoted id cell      -> stays quoted
        item.description, //           legacy: `"${item.description}"`-> quoted, now escaped + neutralised
        Number(item.quantity), //      legacy: bare number            -> unquoted
        Number(item.unit_price), //    legacy: bare number            -> unquoted
        lineTotal, //                  legacy: item.line_total        -> unquoted
        csvRaw(item.taxable ? 'Y' : 'N'), // legacy: bare Y/N literal -> stays raw, never "Y"
        lineTax, //                    S8 fix: was invoice.tax_amount -> unquoted
        round2(lineTotal + lineTax), // S8 fix: was invoice.total     -> unquoted
        invoice.currency_code, //         legacy: `"${...}"` quoted   -> quoted, now escaped
      ];
      csvContent += csvRow(row) + '\n';
    }
  }

  return csvContent;
}

// buildExpensesCsv(rows): one row per expense. Unlike the hosted version
// (which repeated the category in the Vendor column) the vendor is left for
// the accountant; every text cell goes through csvCell (formula-safe).
export const EXPENSE_CSV_HEADERS = ['Date', 'Category', 'Description', 'Amount', 'Reference', 'Notes'];
export function buildExpensesCsv(expenses) {
  let csvContent = csvHeaderRow(EXPENSE_CSV_HEADERS);
  for (const e of expenses ?? []) {
    const day = String(e.expense_date ?? '').slice(0, 10);
    const [y, m, d] = day.split('-');
    const date = y && m && d ? `${Number(m)}/${Number(d)}/${y}` : '';
    csvContent += csvRow([date, e.category ?? '', e.description ?? '', Number(e.amount), e.reference || '', e.notes || '']) + '\n';
  }
  return csvContent;
}

// buildPaymentsCsv(rows, startDate, endDate): the shipped function's payments
// body, same fixes. One row per payment.
export function buildPaymentsCsv(payments, { startDate, endDate }) {
  let csvContent = csvHeaderRow(PAYMENT_CSV_HEADERS);

  for (const payment of payments ?? []) {
    const customer = `${payment.invoice?.appointment?.patient?.first_name || ''} ${payment.invoice?.appointment?.patient?.last_name || ''}`.trim();
    const date = legacyDate(payment.received_at);
    const row = [
      date, //                          legacy: `"${date}"`   -> quoted
      customer, //                      legacy: `"${customer}"` (blank when there is no patient)
      `INV-${payment.invoice?.id?.slice(-8) || ''}`, // legacy: quoted id cell -> stays quoted
      payment.method, //                legacy: `"${payment.method}"` -> quoted
      Number(payment.amount), //        legacy: bare number           -> unquoted
      payment.reference || '', //       legacy: `"${reference || ""}"`-> quoted, now escaped
      `PAY-${payment.id.slice(-8)}`, // legacy: quoted id cell        -> stays quoted
    ];
    csvContent += csvRow(row) + '\n';
  }

  return csvContent;
}

// sendCsv(res, {startDate, endDate, exportType, csv}): the legacy Response
// headers — text/csv with the attachment filename built from the RAW body
// strings, exactly as the shipped template interpolated them.
function sendCsv(res, { startDate, endDate, exportType, csv }) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="quickbooks-${exportType}-${startDate}-to-${endDate}.csv"`);
  res.status(200).end(csv);
}

export const router = Router();

router.post(
  '/',
  requireAuth,
  // Financial exports are for the finance roles (the Exports page is
  // admin-only in the UI); clinical staff have no business bulk-exporting.
  requireRole('admin', 'moderator'),
  asyncHandler(async (req, res) => {
    // The shipped function read the whole body as JSON and destructured these
    // three; a missing key is undefined and lands in the same branch below.
    const { exportType, startDate, endDate } = req.body ?? {};

    // Legacy order of decisions: the export type is checked first, exactly as
    // the shipped if/else threw 'Invalid export type' as a 500.
    if (exportType !== 'invoices' && exportType !== 'payments' && exportType !== 'expenses') {
      return sendJson(res, 500, { error: 'Invalid export type' });
    }

    // New in the port (milestone W41): an inverted or unparsable range is a
    // 400 and the query never runs.
    const range = parseDateRange(startDate, endDate);
    if (!range) return sendJson(res, 400, { error: 'Invalid date range' });

    let csv;
    try {
      if (exportType === 'invoices') {
        const invoices = await fetchInvoiceExport(range);
        csv = buildInvoicesCsv(invoices, { startDate, endDate });
      } else if (exportType === 'payments') {
        const payments = await fetchPaymentExport(range);
        csv = buildPaymentsCsv(payments, { startDate, endDate });
      } else {
        const expenses = await fetchExpenseExport(range);
        csv = buildExpensesCsv(expenses);
      }
      await recordAudit({ user: req.user, action: 'export', entityType: exportType, ip: clientIp(req), summary: { startDate: String(startDate).slice(0, 30), endDate: String(endDate).slice(0, 30), lines: csv.split('\n').length - 2 } });
    } catch (e) {
      // Legacy contract: an unexpected failure answers 500 with the flat
      // {"error": "<message>"} body the shipped catch wrote.
      return sendJson(res, 500, { error: e?.message ? String(e.message) : 'Export failed' });
    }

    return sendCsv(res, { startDate, endDate, exportType, csv });
  })
);

export default router;
