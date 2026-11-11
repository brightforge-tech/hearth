// api/queries/payment-detail.mjs — the receipt email's nested query as
// hand-written SQL (task t11).
//
// The shipped send-receipt-email function asked PostgREST for:
//
//   payments(*) + invoices!inner(*, appointments!inner(patient_id,
//     patients!inner(first_name, last_name, email, phone, address)))
//   .eq("id", paymentId).single()
//
// — and then read payment.invoices and invoice.appointments.patients off the
// result. The `!inner` markers are what this port turns into INNER JOINs
// directly: a payment whose invoice has no appointment, or an appointment
// whose patient row is gone, yields NO row and the route answers the legacy
// 'Payment not found' JSON (milestone W46) instead of mailing a receipt
// addressed to "undefined undefined". (payments.invoice_id is NOT NULL with a
// live FK, so the invoice leg always resolves; the appointment/patient legs
// are the ones that can be missing.)
//
// The shape returned is the PostgREST shape the legacy route read: the payment
// row plus an `invoices` object (all its columns plus `appointments`, which
// carries patient_id and the `patients` object). Numeric columns become JSON
// numbers so `${invoice.total.toFixed(2)}` renders the same characters
// PostgREST's JSON produced.

import { query } from '../db.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAYMENT_DETAIL_SQL = `
select p.id,
       p.invoice_id,
       p.amount,
       p.method::text as method,
       p.reference,
       p.received_at,
       p.created_at,
       p.updated_at,
       i.id             as invoice_pk,
       i.appointment_id as invoice_appointment_id,
       i.currency_code  as invoice_currency_code,
       i.tax_enabled    as invoice_tax_enabled,
       i.tax_rate       as invoice_tax_rate,
       i.subtotal       as invoice_subtotal,
       i.tax_amount     as invoice_tax_amount,
       i.total          as invoice_total,
       i.paid_amount    as invoice_paid_amount,
       i.status::text   as invoice_status,
       i.created_at     as invoice_created_at,
       i.updated_at     as invoice_updated_at,
       a.id             as appointment_pk,
       a.patient_id     as appointment_patient_id,
       pt.first_name    as patient_first_name,
       pt.last_name     as patient_last_name,
       pt.email         as patient_email,
       pt.phone         as patient_phone,
       pt.address       as patient_address
  from public.payments p
  join public.invoices i     on i.id = p.invoice_id
  join public.appointments a on a.id = i.appointment_id
  join public.patients pt    on pt.id = a.patient_id
 where p.id = $1::uuid`;

const num = (v) => (v === null ? null : Number(v));

// mapPaymentRow(row): the flat SQL row -> the PostgREST `payments` row with
// its `invoices.appointments.patients` embeds. Exported for the unit tests.
export function mapPaymentRow(row) {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    amount: num(row.amount),
    method: row.method,
    reference: row.reference,
    received_at: row.received_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    invoices: {
      id: row.invoice_pk,
      appointment_id: row.invoice_appointment_id,
      currency_code: row.invoice_currency_code,
      tax_enabled: row.invoice_tax_enabled,
      tax_rate: num(row.invoice_tax_rate),
      subtotal: num(row.invoice_subtotal),
      tax_amount: num(row.invoice_tax_amount),
      total: num(row.invoice_total),
      paid_amount: num(row.invoice_paid_amount),
      status: row.invoice_status,
      created_at: row.invoice_created_at,
      updated_at: row.invoice_updated_at,
      appointments: {
        id: row.appointment_pk,
        patient_id: row.appointment_patient_id,
        patients: {
          first_name: row.patient_first_name,
          last_name: row.patient_last_name,
          email: row.patient_email,
          phone: row.patient_phone,
          address: row.patient_address,
        },
      },
    },
  };
}

// fetchPaymentDetail(paymentId): the PostgREST-shaped payment, or null when no
// row matches — a non-uuid, an unknown payment, or one whose invoice has no
// appointment/patient.
export async function fetchPaymentDetail(paymentId) {
  if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) return null;
  const { rows } = await query(PAYMENT_DETAIL_SQL, [paymentId]);
  const row = rows[0];
  return row ? mapPaymentRow(row) : null;
}
