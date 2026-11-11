// api/queries/exports.mjs — the two PostgREST embeds of the QuickBooks export,
// rewritten as hand-written SQL against the local Postgres (task t10).
//
// The shipped edge function asked PostgREST for nested objects:
//
//   invoices select id, created_at, total, tax_amount, subtotal, currency_code,
//     status, appointment:appointments(patient:patients(first_name, last_name,
//     email)), invoice_items(description, quantity, unit_price, line_total,
//     taxable)   + gte/lte created_at + eq status 'issued' + order created_at
//
//   payments   select id, amount, method, received_at, reference,
//     invoice:invoices(id, total, appointment:appointments(
//       patient:patients(first_name, last_name)))   + gte/lte received_at +
//     order received_at
//
// These queries reproduce both, and hand the route the SAME nested shapes
// PostgREST returned (invoice.appointment.patient, invoice.invoice_items[],
// payment.invoice.appointment.patient) so the port's row-building stays the
// legacy template. Fidelity notes:
//
//   * M2O embeds (`appointment`, `patient`, `invoice`) are LEFT joins: a null
//     FK yields null, never a dropped row — the legacy template then renders
//     the Customer cell from `?.first_name || ""`, i.e. blank, exactly as
//     milestone criterion W40 pins for a payment whose invoice has no patient;
//   * the O2M `invoice_items` embed becomes a json_agg, so the row comes back
//     as an array (empty array, never null, like PostgREST) — one entry per
//     item, which is what keeps the legacy row multiplicity: one CSV row per
//     item. The service name rides along in the item object; the CSV ignores
//     it and it costs nothing.
//   * items are ordered by created_at, id — PostgREST's O2M embed order is
//     unspecified, and a CSV the operator diffs between runs needs one;
//   * numerics come back as JSON numbers (PostgREST rendered `10.00` as 10),
//     timestamps as Date objects, enums as text.
//
// The range: the browser sends naive 'YYYY-MM-DDTHH:mm:ss' strings and the
// hosted PostgREST session ran with TimeZone=UTC, so they compared as UTC
// instants. parseDateRange() pins that reading regardless of this server's own
// time zone (appending an explicit Z to a naive value), and the SQL binds the
// result as $n::timestamptz — always a bound parameter, never interpolated.

import { query } from '../db.mjs';

// A naive date-time — no 'Z' and no ±hh:mm — as it arrives from the Exports
// page. Date-only gets midnight, per the hosted behaviour of a date cast.
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// parseDateRange(startDate, endDate): null when either bound is missing or is
// not a date, or when endDate is earlier than startDate (the 400 the route
// answers — "and creates nothing": this module only reads). Otherwise the two
// bounds as explicit-UTC ISO strings for binding.
export function parseDateRange(startDate, endDate) {
  const start = toUtcIso(startDate);
  const end = toUtcIso(endDate);
  if (start === null || end === null) return null;
  if (Date.parse(start) > Date.parse(end)) return null;
  return { start, end };
}

function toUtcIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string') return null;
  let iso = value.trim();
  if (iso === '') return null;
  if (DATE_ONLY.test(iso)) iso += 'T00:00:00Z';
  else if (NAIVE_DATETIME.test(iso)) iso = `${iso.replace(' ', 'T')}Z`;
  // else: it already carries Z or ±hh:mm — keep it and let the Date parse decide
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const INVOICE_EXPORT_SQL = `
select i.id,
       i.created_at,
       i.currency_code,
       i.status,
       i.tax_enabled,
       i.tax_rate,
       p.first_name as patient_first_name,
       p.last_name  as patient_last_name,
       p.email      as patient_email,
       coalesce(items.invoice_items, '[]'::json) as invoice_items
  from public.invoices i
  left join public.appointments a on a.id = i.appointment_id
  left join public.patients p     on p.id = a.patient_id
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
 where i.status = 'issued'::public.invoice_status
   and i.created_at >= $1::timestamptz
   and i.created_at <= $2::timestamptz
 order by i.created_at, i.id`;

// fetchInvoiceExport({start, end}): the PostgREST-shaped invoice rows — one row
// per issued invoice in the range (created_at asc), each with appointment
// (nullable) and invoice_items (array, possibly empty).
export async function fetchInvoiceExport({ start, end }) {
  const { rows } = await query(INVOICE_EXPORT_SQL, [start, end]);
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    currency_code: row.currency_code,
    status: row.status,
    tax_enabled: row.tax_enabled,
    tax_rate: row.tax_rate === null ? null : Number(row.tax_rate),
    appointment:
      row.patient_first_name === null && row.patient_last_name === null
        ? null
        : {
            patient: {
              first_name: row.patient_first_name,
              last_name: row.patient_last_name,
              email: row.patient_email,
            },
          },
    // json_agg/json_build_object already arrive parsed as JSON: numerics are
    // JSON numbers (PostgREST parity), booleans booleans.
    invoice_items: row.invoice_items,
  }));
}

const PAYMENT_EXPORT_SQL = `
select p.id,
       p.amount,
       p.method,
       p.received_at,
       p.reference,
       i.id    as invoice_id,
       i.total as invoice_total,
       pt.first_name as patient_first_name,
       pt.last_name  as patient_last_name
  from public.payments p
  left join public.invoices i     on i.id = p.invoice_id
  left join public.appointments a on a.id = i.appointment_id
  left join public.patients pt    on pt.id = a.patient_id
 where p.received_at >= $1::timestamptz
   and p.received_at <= $2::timestamptz
 order by p.received_at, p.id`;

// fetchPaymentExport({start, end}): the PostgREST-shaped payment rows — one
// row per payment in the range (received_at asc), each with invoice
// (non-null by the FK, but shaped nullable exactly like the embed) and its
// appointment/patient, which may be null and blank the Customer cell.
export async function fetchPaymentExport({ start, end }) {
  const { rows } = await query(PAYMENT_EXPORT_SQL, [start, end]);
  return rows.map((row) => ({
    id: row.id,
    amount: row.amount === null ? null : Number(row.amount),
    method: row.method,
    received_at: row.received_at,
    reference: row.reference,
    invoice:
      row.invoice_id === null
        ? null
        : {
            id: row.invoice_id,
            total: row.invoice_total === null ? null : Number(row.invoice_total),
            appointment:
              row.patient_first_name === null && row.patient_last_name === null
                ? null
                : {
                    patient: {
                      first_name: row.patient_first_name,
                      last_name: row.patient_last_name,
                    },
                  },
          },
  }));
}

// fetchExpenseExport({start, end}): expenses whose expense_date falls in the
// range (the date part of each bound; both inclusive).
export async function fetchExpenseExport({ start, end }) {
  const { rows } = await query(
    `select id, expense_date::text as expense_date, category, description, amount, reference, notes
       from public.expenses
      where expense_date >= ($1::timestamptz)::date and expense_date <= ($2::timestamptz)::date
      order by expense_date, created_at`,
    [start, end]
  );
  return rows;
}
