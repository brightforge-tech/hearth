// api/queries/invoice-detail.mjs — the invoice email's nested query as
// hand-written SQL (task t11).
//
// The shipped send-invoice-email function asked PostgREST for one row:
//
//   invoices(id, total, paid_amount, currency_code, created_at, status,
//     subtotal, tax_amount, tax_enabled, tax_rate,
//     appointment:appointments(scheduled_start, reason,
//       patient:patients(first_name, last_name, email, phone, address)),
//     invoice_items(description, quantity, unit_price, line_total,
//       service:services(name)))
//   .eq("id", invoiceId).single()
//
// This file reproduces exactly that shape over the local Postgres, with the
// two fidelity decisions the port documents:
//
//   * the appointment and patient joins are INNER, not LEFT: milestone W46 —
//     an invoice whose appointment_id is null yields no row and the route
//     answers the legacy 'Invoice not found' JSON, instead of mailing a letter
//     addressed to "undefined undefined" the way the shipped optional
//     chaining did. That is the port's one intentional behavioural deviation
//     from the legacy function, recorded in the delivery notes.
//   * the invoice_items embed keeps PostgREST's array shape (empty array,
//     never null) and, on top of the embedded columns, carries PER-LINE
//     tax_amount and total (line_total + line tax, computed exactly like
//     recalc_invoice_totals and like api/queries/exports.mjs) — so line data
//     in this port never repeats the invoice-level figures (S8). The shipped
//     template only renders quantity/price/line_total, so the HTML stays
//     byte-compatible while the rows carry the correct per-line figures.
//
// Every value is bound as $1; the id is uuid-validated first so a non-uuid
// cannot raise a 22P02 through the route — a non-uuid is simply "no row", the
// same answer PostgREST gave for an id that does not exist.

import { query } from '../db.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVOICE_DETAIL_SQL = `
select i.id,
       i.total,
       i.paid_amount,
       i.currency_code,
       i.created_at,
       i.status::text as status,
       i.subtotal,
       i.tax_amount,
       i.tax_enabled,
       i.tax_rate,
       a.scheduled_start,
       a.reason,
       p.first_name as patient_first_name,
       p.last_name  as patient_last_name,
       p.email      as patient_email,
       p.phone      as patient_phone,
       p.address    as patient_address,
       coalesce(items.invoice_items, '[]'::json) as invoice_items
  from public.invoices i
  join public.appointments a on a.id = i.appointment_id
  join public.patients p     on p.id = a.patient_id
  left join lateral (
         select json_agg(
                   json_build_object(
                     'description',  it.description,
                     'quantity',     it.quantity,
                     'unit_price',   it.unit_price,
                     'line_total',   it.line_total,
                     'taxable',      it.taxable,
                     'service_name', s.name
                   ) order by it.created_at, it.id
                 ) as invoice_items
           from public.invoice_items it
           left join public.services s on s.id = it.service_id
          where it.invoice_id = i.id
       ) items on true
 where i.id = $1::uuid`;

// The two-decimal rounding recalc_invoice_totals applies; shared with the
// per-line figures so a line's total never carries a float artefact.
function round2(value) {
  return Math.round(value * 100) / 100;
}

// mapInvoiceRow(row): the flat SQL row -> the PostgREST-shaped object the
// legacy code read (invoice.appointment.patient / invoice.invoice_items[]).
// Numeric columns become JSON numbers so `.toFixed(2)` and `${tax_rate}`
// render the same characters PostgREST's JSON produced ('10.00' -> 10 -> '10').
// Exported for the unit tests; the rows it maps are exactly what pg returns.
export function mapInvoiceRow(row) {
  const taxRate = row.tax_rate === null ? 0 : Number(row.tax_rate);
  const items = (row.invoice_items ?? []).map((item) => {
    const lineTotal = Number(item.line_total);
    // S8: the line's own tax and total — charged only when the invoice
    // enables tax AND the line is taxable, exactly like recalc_invoice_totals.
    const lineTax = row.tax_enabled && item.taxable ? round2((lineTotal * taxRate) / 100) : 0;
    return {
      description: item.description,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      line_total: lineTotal,
      taxable: item.taxable,
      tax_amount: lineTax,
      total: round2(lineTotal + lineTax),
      service: item.service_name === null || item.service_name === undefined ? null : { name: item.service_name },
    };
  });

  return {
    id: row.id,
    total: Number(row.total),
    paid_amount: Number(row.paid_amount),
    currency_code: row.currency_code,
    created_at: row.created_at,
    status: row.status,
    subtotal: Number(row.subtotal),
    tax_amount: Number(row.tax_amount),
    tax_enabled: row.tax_enabled,
    tax_rate: taxRate,
    appointment: {
      scheduled_start: row.scheduled_start,
      reason: row.reason,
      patient: {
        first_name: row.patient_first_name,
        last_name: row.patient_last_name,
        email: row.patient_email,
        phone: row.patient_phone,
        address: row.patient_address,
      },
    },
    invoice_items: items,
  };
}

// fetchInvoiceDetail(invoiceId): the PostgREST-shaped invoice, or null when no
// row matches — which includes a non-uuid id and an invoice whose appointment
// (or the appointment's patient) cannot be resolved.
export async function fetchInvoiceDetail(invoiceId) {
  if (typeof invoiceId !== 'string' || !UUID_RE.test(invoiceId)) return null;
  const { rows } = await query(INVOICE_DETAIL_SQL, [invoiceId]);
  const row = rows[0];
  return row ? mapInvoiceRow(row) : null;
}
