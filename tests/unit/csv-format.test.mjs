// tests/unit/csv-format.test.mjs — unit tests for the two small builders of
// the QuickBooks port (task t10): api/lib/csv.mjs and api/lib/format.mjs.
//
// csv.mjs is the S6 fix made testable on its own: the shipped template's two
// holes — embedded quotes breaking the column layout, and =/+/-/@/tab/CR
// values becoming spreadsheet formulas — must be closed by csvCell, while the
// cells the legacy template itself wrote unquoted (numbers, the Taxable Y/N
// token) must stay unquoted, because that is what the milestone pins
// (`...,Y,2,22,USD`, never `"Y"`).
//
// format.mjs pins the calendar the hosted Deno runtime produced: the en-US
// short date and medium time in UTC, independent of this process's locale
// (run.mjs pins TZ=UTC; these tests additionally pin the locale-free API).

import assert from 'node:assert/strict';

import { csvCell, csvHeaderRow, csvRaw, csvRow } from '../../api/lib/csv.mjs';
import { legacyDate, legacyTime } from '../../api/lib/format.mjs';

export default [
  {
    name: 'csvHeaderRow joins unquoted and appends exactly one newline',
    fn() {
      assert.equal(csvHeaderRow(['A', 'B', 'C']), 'A,B,C\n');
      // the shipped invoices header line, byte for byte
      const shipped = [
        'Date', 'Customer', 'Customer Email', 'Invoice Number', 'Item Description',
        'Quantity', 'Rate', 'Amount', 'Taxable', 'Tax Amount', 'Total', 'Currency',
      ];
      assert.equal(
        csvHeaderRow(shipped),
        'Date,Customer,Customer Email,Invoice Number,Item Description,Quantity,Rate,Amount,Taxable,Tax Amount,Total,Currency\n'
      );
    },
  },
  {
    name: 'csvCell quotes strings and doubles embedded quotes (the O"Neil, Bob case)',
    fn() {
      assert.equal(csvCell('plain'), '"plain"');
      assert.equal(csvCell(''), '""');
      assert.equal(csvCell('8/5/2025'), '"8/5/2025"'); // the legacy quoted Date cell
      // milestone W43: a name with a quote and a comma survives as one cell
      assert.equal(csvCell('O"Neil, Bob'), '"O""Neil, Bob"');
      assert.equal(csvCell('ends with a quote"'), '"ends with a quote"""');
      // null/undefined render as the empty quoted cell
      assert.equal(csvCell(null), '""');
      assert.equal(csvCell(undefined), '""');
    },
  },
  {
    name: 'csvCell neutralises formula injection with a leading single quote',
    fn() {
      // milestone W43, byte for byte
      assert.equal(csvCell("=cmd|' /C calc'!A0"), '"\'=cmd|\' /C calc\'!A0"');
      assert.equal(csvCell('+15123456789'), '"\'+15123456789"'); // phone-shaped numbers as text
      assert.equal(csvCell('-1'), '"\'-1"'); // a string starting '-' is neutralised...
      assert.equal(csvCell('-1.5'), '"\'-1.5"');
      assert.equal(csvCell('@SUM(A1:A9)'), '"\'@SUM(A1:A9)"');
      assert.equal(csvCell('\t1234'), '"\'\t1234"');
      assert.equal(csvCell('\r1234'), '"\'\r1234"');
      // the quote goes inside the RFC quoting and only once...
      assert.equal(csvCell('=1+1'), '"\'=1+1"');
      // ...and only on the FIRST character: a value that merely contains them
      // later is a normal cell, exactly like the legacy text minus the hole.
      assert.equal(csvCell('a=1'), '"a=1"');
      assert.equal(csvCell('1-2'), '"1-2"');
    },
  },
  {
    name: 'csvCell renders finite numbers unquoted via String(), like PostgREST JSON',
    fn() {
      assert.equal(csvCell(10), '10');
      assert.equal(csvCell(0), '0');
      assert.equal(csvCell(2.5), '2.5');
      // the whole point for the CSV: numeric(12,2) '10.00' arrives as the JSON
      // number 10 (Number('10.00')) and must print '10', not '10.00' and not
      // a quoted cell.
      assert.equal(csvCell(Number('10.00')), '10');
      assert.equal(csvCell(Number('22.00')), '22');
      // non-finite numbers cannot be CSV cells: the empty cell, not NaN
      assert.equal(csvCell(Number.NaN), '""');
      assert.equal(csvCell(Number.POSITIVE_INFINITY), '""');
    },
  },
  {
    name: 'csvRaw/csvRow: only raw-marked cells are emitted verbatim',
    fn() {
      const row = [
        '8/5/2025', //                quoted by csvCell (legacy `"${date}"`)
        csvRaw('Y'), //               the legacy bare Taxable token
        csvRaw('USD'), //             the legacy bare currency code
        22, //                        numeric, unquoted
        '=1+1', //                    neutralised by csvCell inside csvRow
      ];
      assert.equal(csvRow(row), '"8/5/2025",Y,USD,22,"\'=1+1"');
      // never "Y"/"N": the milestone pins those two cells unquoted
      assert.doesNotMatch(csvRow([csvRaw('N')]), /"N"/);
      // a plain string is never emitted raw, however innocent
      assert.equal(csvRow(['Y']), '"Y"');
      // empty row -> empty line body
      assert.equal(csvRow([]), '');
    },
  },
  {
    name: 'legacyDate pins the en-US short date in UTC (8/5/2025)',
    fn() {
      // milestone W39/W40: created_at 2025-08-05T14:30:00Z -> '8/5/2025'
      assert.equal(legacyDate('2025-08-05T14:30:00Z'), '8/5/2025');
      // the UTC instant is what counts, not the string: 23:30Z is still that day
      assert.equal(legacyDate('2025-08-05T23:30:00Z'), '8/5/2025');
      // and after midnight UTC it is the next day, which the legacy function
      // (running in UTC) would also have shown
      assert.equal(legacyDate('2025-08-05T14:30:00+00:00'), '8/5/2025');
      assert.equal(legacyDate('2025-08-06T00:30:00Z'), '8/6/2025');
      // a Date object (what the pg driver hands back) formats identically
      assert.equal(legacyDate(new Date('2025-08-05T14:30:00Z')), '8/5/2025');
      // single-digit month/day with no padding — toLocaleDateString's en-US short form
      assert.equal(legacyDate('2025-01-02T00:00:00Z'), '1/2/2025');
      // an offset is resolved to UTC first, exactly like the hosted session
      assert.equal(legacyDate('2025-08-05T20:00:00+05:30'), '8/5/2025'); // 14:30Z
      assert.equal(legacyDate('2025-08-05T20:00:00-05:00'), '8/6/2025'); // next day in UTC
      // invalid input is the empty string, never 'Invalid Date'
      assert.equal(legacyDate(null), '');
      assert.equal(legacyDate(undefined), '');
      assert.equal(legacyDate('not a date'), '');
    },
  },
  {
    name: 'legacyTime pins the en-US medium time in UTC (2:30:00 PM)',
    fn() {
      // the interface contract: legacyTime('2025-08-05T14:30:00Z') === '2:30:00 PM'
      assert.equal(legacyTime('2025-08-05T14:30:00Z'), '2:30:00 PM');
      assert.equal(legacyTime('2025-08-05T00:00:00Z'), '12:00:00 AM');
      assert.equal(legacyTime('2025-08-05T12:00:00Z'), '12:00:00 PM');
      assert.equal(legacyTime('2025-08-05T09:05:03Z'), '9:05:03 AM');
      assert.equal(legacyTime(new Date('2025-08-05T14:30:00Z')), '2:30:00 PM');
      assert.equal(legacyTime(null), '');
    },
  },
];
