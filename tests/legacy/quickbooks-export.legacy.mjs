// tests/legacy/quickbooks-export.legacy.mjs — VERBATIM reference builders for
// the shipped QuickBooks export edge function (task t13; feeds the S29
// contract suite in tests/contract/).
//
// Every string below — both csvHeaders arrays, both row-building arrays, the
// csvContent seeds and both Content-Disposition templates — is copied byte for
// byte from supabase/functions/quickbooks-export/index.ts (the invoices section
// lines 42-81, the payments section lines 110-136, the disposition templates on
// lines 87 and 142), CRLF line endings and trailing whitespace included, so
// tests/contract/legacy-source.test.mjs finds every template literal and array
// here verbatim in the shipped file. Do not "clean up" this file: if either the
// shipped function or this reference drifts alone, the source-verbatim proof
// fails — that is the point.
//
// The only differences from the shipped file, all sanctioned by task t13:
//   * the Deno serve + createClient + PostgREST harness is replaced by injected
//     arguments — buildInvoicesCsv/buildPaymentsCsv take the nested PostgREST-
//     shaped rows the shipped .select() returned, exactly as tests/fixtures/
//     invoices-*.json and payments.json describe them;
//   * new Date(x).toLocaleDateString() becomes the pinned legacyDate(x) from
//     api/lib/format.mjs — the same UTC en-US characters the hosted Deno runtime
//     produced (the contract runner pins TZ=UTC);
//   * the (invoice: any) / (item: any) TypeScript parameter annotations drop
//     their ": any", which is not valid JavaScript; nothing else on those lines.
//
// This reference must NOT apply csvCell escaping, formula neutralisation,
// per-line tax or any other S6/S8 fix — reproducing the shipped behaviour, bugs
// included, is its whole purpose. The ported endpoint in
// api/routes/quickbooks-export.mjs carries the fixes; the contract tests diff
// the two over the fixtures and expect ONLY the fixes to show up (tax-free:
// byte-identical; taxed: the Tax Amount / Total cells only; hostile: quote
// doubling and the formula-injection prefix only).
//
// Fidelity note, the Currency cell: the shipped row array quotes the currency
// code — `${invoice.currency_code}` — so the reference emits "USD". The ported
// endpoint must emit the same quoted cell; a bare USD there is a port defect
// against W54/W55 byte-identity, not a defect of this reference.

import { legacyDate } from '../../api/lib/format.mjs';

// buildInvoicesCsv(invoices, { startDate, endDate }): the shipped function's
// invoices branch verbatim — the header line, then one CSV row per invoice item,
// in the argument's order. The returned string is exactly what the shipped code
// handed to new Response(csvContent, ...).
export function buildInvoicesCsv(invoices, { startDate, endDate }) {
      const csvHeaders = [
        "Date",
        "Customer",
        "Customer Email", 
        "Invoice Number",
        "Item Description",
        "Quantity",
        "Rate",
        "Amount",
        "Taxable",
        "Tax Amount",
        "Total",
        "Currency"
      ];

      let csvContent = csvHeaders.join(",") + "\n";

      invoices?.forEach((invoice) => {
        const customer = `${invoice.appointment?.patient?.first_name || ""} ${invoice.appointment?.patient?.last_name || ""}`.trim();
        const email = invoice.appointment?.patient?.email || "";
        const date = legacyDate(invoice.created_at);
        
        invoice.invoice_items?.forEach((item) => {
          const row = [
            `"${date}"`,
            `"${customer}"`,
            `"${email}"`,
            `"INV-${invoice.id.slice(-8)}"`,
            `"${item.description}"`,
            item.quantity,
            item.unit_price,
            item.line_total,
            item.taxable ? "Y" : "N",
            invoice.tax_amount || 0,
            invoice.total,
            `"${invoice.currency_code}"`
          ];
          csvContent += row.join(",") + "\n";
        });
      });
  return csvContent;
}

// buildPaymentsCsv(payments, { startDate, endDate }): the shipped function's
// payments branch verbatim — one CSV row per payment, in the argument's order.
export function buildPaymentsCsv(payments, { startDate, endDate }) {
      const csvHeaders = [
        "Date",
        "Customer", 
        "Invoice Number",
        "Payment Method",
        "Amount",
        "Reference",
        "Payment ID"
      ];

      let csvContent = csvHeaders.join(",") + "\n";

      payments?.forEach((payment) => {
        const customer = `${payment.invoice?.appointment?.patient?.first_name || ""} ${payment.invoice?.appointment?.patient?.last_name || ""}`.trim();
        const date = legacyDate(payment.received_at);
        
        const row = [
          `"${date}"`,
          `"${customer}"`,
          `"INV-${payment.invoice?.id?.slice(-8) || ""}"`,
          `"${payment.method}"`,
          payment.amount,
          `"${payment.reference || ""}"`,
          `"PAY-${payment.id.slice(-8)}"`
        ];
        csvContent += row.join(",") + "\n";
      });
  return csvContent;
}

// The attachment filename the shipped function built from the RAW request
// strings (its Content-Disposition templates, shipped lines 87 and 142,
// verbatim) — the contract tests assert the endpoint's header matches it.
export function invoicesDisposition({ startDate, endDate }) {
  return `attachment; filename="quickbooks-invoices-${startDate}-to-${endDate}.csv"`;
}

export function paymentsDisposition({ startDate, endDate }) {
  return `attachment; filename="quickbooks-payments-${startDate}-to-${endDate}.csv"`;
}
