/**
 * Unit tests for the CSV escaper (api/lib/csv.mjs), milestone 5 (t14).
 *
 * These four helpers are what make `tests/contract/quickbooks-export.test.mjs`
 * byte-identical to the shipped edge function while fixing its S6 defect. The
 * QuickBooks importer is exactly where a formula injection turns into code
 * execution on someone's desktop, so the rules are pinned here one cell at a
 * time:
 *
 *   - a leading =, +, -, @, tab or CR makes Excel/Sheets evaluate the cell, so
 *     the cell is prefixed with a single quote (Excel's own escape),
 *   - every non-number cell is RFC-quoted with embedded quotes doubled — the
 *     legacy template quoted every text column (`"${patient.name}"`), so the
 *     byte-exact port quotes them too, and the guard goes *inside* the quotes,
 *   - a null/undefined cell becomes the empty quoted cell, never `null`,
 *   - numbers join unquoted in plain String() formatting (what PostgREST's
 *     JSON did: numeric 10.00 arrived as 10 and joined as "10"),
 *   - csvRaw marks the one cell the legacy wrote bare (Taxable `Y`/`N`) and
 *     the marker cannot be forged from row data.
 */

import assert from 'node:assert/strict';

import { csvCell, csvHeaderRow, csvRaw, csvRow } from '../../api/lib/csv.mjs';

export default [
  {
    name: 'csvCell: numbers render unquoted, exactly as PostgREST JSON joined them',
    async fn() {
      assert.equal(csvCell(5), '5');
      assert.equal(csvCell(2.25), '2.25');
      assert.equal(csvCell(0), '0');
      assert.equal(csvCell(10.00), '10'); // numeric 10.00 arrives as the number 10
      assert.equal(csvCell(-4), '-4'); // a number's minus sign stays a number
      assert.equal(csvCell(NaN), '""'); // not CSV-safe: empty quoted cell
      assert.equal(csvCell(Infinity), '""');
    },
  },

  {
    name: 'csvCell: text is RFC-quoted, quotes doubled, nullish empty (legacy quoting kept)',
    async fn() {
      assert.equal(csvCell('plain'), '"plain"');
      assert.equal(csvCell('Health & Wellness, LLC'), '"Health & Wellness, LLC"');
      assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
      assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
      assert.equal(csvCell('  spaced  '), '"  spaced  "');
      assert.equal(csvCell(null), '""');
      assert.equal(csvCell(undefined), '""');
      assert.equal(csvCell(''), '""');
    },
  },

  {
    name: 'csvCell: formula injection is neutralized by a leading apostrophe',
    async fn() {
      // The payload set from the hostile contract fixture, plus the DDE tab
      // vector. The quote goes before the trigger character, inside the cell's
      // RFC quotes, so a spreadsheet shows the text and never evaluates it.
      const triggers = ['=1+1', '=HYPERLINK("http://evil","x")', '+1+1', '-1+1',
        "@SUM(1+1)*cmd|' /C calc'!A0", '\tcmd', '\r'];
      for (const payload of triggers) {
        const cell = csvCell(payload);
        assert.ok(cell.startsWith('"\''), `${JSON.stringify(payload)} must be quote-prefixed inside the RFC quotes`);
        assert.ok(['=', '+', '-', '@', '\t', '\r'].includes(cell[2]),
          `${JSON.stringify(payload)} -> ${JSON.stringify(cell)}: apostrophe goes before the trigger char`);
      }

      // Exact bytes for the fixture's DDE vector: apostrophe inserted, the
      // embedded double quotes doubled, the whole cell wrapped.
      assert.equal(csvCell('="a,b"'), '"\'=""a,b"""');
      assert.equal(csvCell('=1+1'), '"\'=1+1"');
    },
  },

  {
    name: 'csvCell: the guard never breaks the column layout',
    async fn() {
      // A cell containing a newline, a comma and quotes must occupy exactly
      // one CSV field: unwrap the RFC quoting and the original text is back,
      // the injected apostrophe removed.
      const original = 'a,b\nc,"d"';
      const cell = csvCell(original);
      assert.equal(cell, '"a,b\nc,""d"""');
      assert.equal(cell.slice(1, -1).replace(/""/g, '"'), original);
      // and for a guarded cell the same unwrap + strip-one-char restores it
      const guarded = csvCell('="x,y"');
      assert.equal(guarded.slice(1, -1).replace(/""/g, '"').slice(1), '="x,y"');
    },
  },

  {
    name: 'csvRow: joins escaped cells; csvRaw emits the Taxable-style token verbatim',
    async fn() {
      assert.equal(csvRow([5, 'Consultation', 1, 10.00, csvRaw('Y')]),
        '5,"Consultation",1,10,Y');
      assert.equal(csvRow(['INV-2025-001']), '"INV-2025-001"'); // legacy quoted the id cells
      assert.equal(csvRow([csvRaw('=not-guarded')]), '=not-guarded');
      assert.equal(csvRow([]), '');
    },
  },

  {
    name: 'csvRaw: the verbatim marker cannot be forged from row data',
    async fn() {
      // csvRow only trusts genuine csvRaw() markers; the same text as a plain
      // string or a look-alike object still goes through csvCell escaping.
      assert.equal(csvRow([{ text: '=SUM(1)' }]), '"[object Object]"'); // stringified, marker text lost
      assert.equal(csvRow(['=SUM(1)']), '"\'=SUM(1)"');
    },
  },

  {
    name: 'csvHeaderRow: static names joined unquoted with the trailing newline, as legacy',
    async fn() {
      assert.equal(csvHeaderRow(['Invoice Number', 'Invoice Date']), 'Invoice Number,Invoice Date\n');
      // byte-identical to the shipped `csvHeaders.join(",") + "\n"`
      assert.equal(csvHeaderRow(['A']), 'A\n');
    },
  },
];
