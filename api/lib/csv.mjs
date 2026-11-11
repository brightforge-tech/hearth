// api/lib/csv.mjs — CSV cells for the ported QuickBooks export (task t10).
//
// The shipped edge function built every line by hand as
//
//   [`"${date}"`, `"${customer}"`, ..., item.quantity, invoice.total, `"${code}"`].join(",")
//
// which is the S6 defect this port fixes: a patient name containing a quote or
// a comma breaks the column layout, and a value beginning `=`, `+`, `-`, `@`
// becomes a spreadsheet formula when the CSV is opened (formula injection).
// These four helpers are the whole CSV grammar of the API — the three ported
// export endpoints are their only callers (milestone-4 convention) — and they
// implement the fixed contract:
//
//   csvHeaderRow(names)  the header line: names joined with ',' + '\n', unquoted,
//                        byte-identical to the legacy `csvHeaders.join(",") + "\n"`;
//   csvCell(value)       a number renders as String(value) unquoted — that is
//                        what PostgREST JSON did (numeric `10.00` arrived as the
//                        number 10 and joined as "10"); anything else renders as
//                        the RFC-quoted form with every embedded " doubled, and
//                        with a single leading ' when the string starts with
//                        = + - @ tab or CR, so Excel and Sheets refuse to
//                        evaluate it (S6);
//   csvRaw(text)         marks a cell to be emitted verbatim. Used only for the
//                        Taxable `Y`/`N` token — the single cell the shipped
//                        template wrote unquoted as a bare literal
//                        (`item.taxable ? "Y" : "N"`), which the acceptance
//                        contract keeps unquoted. The `INV-`/`PAY-` id cells
//                        and the Currency code WERE quoted by the legacy
//                        template (`"INV-${...}"`, `"${invoice.currency_code}"`)
//                        and therefore go through csvCell and stay quoted;
//   csvRow(values)       maps a row's values through csvCell/csvRaw and joins
//                        them with ',' (the caller appends the newline, as the
//                        legacy template did).
//
// Nothing here knows about invoices: it is the quoting/escaping grammar only.

// Characters that make a spreadsheet evaluate a cell as a formula. A leading
// single quote neutralises them while leaving the text visible.
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

// RawCell: the wrapper csvRow looks for to emit a cell verbatim. Deliberately
// not exported by name — csvRaw() is the way to make one, so the marker cannot
// be forged from a plain string or object in row data.
class RawCell {
  constructor(text) {
    this.text = String(text);
  }
}

// csvHeaderRow(names): the header line, exactly as the legacy functions wrote
// it: `csvHeaders.join(",") + "\n"`, never quoted.
export function csvHeaderRow(names) {
  return names.join(',') + '\n';
}

// csvCell(value): one cell, quoted and escaped (see the header comment).
export function csvCell(value) {
  if (typeof value === 'number') {
    // Numbers join unquoted, String(value) — PostgREST rendered numeric `10.00`
    // as the JSON number 10, so the CSV cell read "10". NaN/Infinity are not
    // CSV-safe at all; emit them as the empty cell rather than the token.
    return Number.isFinite(value) ? String(value) : '""';
  }
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIX_RE.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// csvRaw(text): a cell that must be emitted exactly as written — the legacy
// template's bare `Y`/`N` Taxable token.
export function csvRaw(text) {
  return new RawCell(text);
}

// csvRow(values): the joined row without the trailing newline (the caller adds
// it, as the legacy `csvContent += row.join(",") + "\n"` did).
export function csvRow(values) {
  return values.map((cell) => (cell instanceof RawCell ? cell.text : csvCell(cell))).join(',');
}
