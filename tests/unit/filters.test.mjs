// tests/unit/filters.test.mjs — the filter grammar, compiled against a
// catalog-shaped table without a database (task t7).
//
// The table object is built to the same shape api/lib/catalog.mjs hands the
// route, so everything here exercises the real compile path: identifiers are
// validated, every value becomes a bound $n cast to the column's type, and a
// literal that cannot be that type is a FilterError before SQL exists.

import assert from 'node:assert/strict';

import { combineAnd, compileFilter, compileFilters, compileOr, FilterError, parseInList, sqlType } from '../../api/lib/filters.mjs';

function column(table, name, dataType, extra = {}) {
  const col = {
    name,
    table,
    dataType,
    udtName: extra.udtName ?? name,
    udtSchema: extra.udtSchema ?? 'public',
    isNullable: true,
    default: null,
    maxLength: null,
    enumValues: extra.enumValues ?? null,
  };
  col.isEnum = col.enumValues !== null;
  col.isNumeric = ['numeric', 'integer', 'smallint', 'bigint', 'real', 'double precision'].includes(dataType);
  col.isBoolean = dataType === 'boolean';
  col.isTemporal = dataType.endsWith('time zone') || dataType === 'date';
  col.isJson = dataType === 'json' || dataType === 'jsonb';
  col.textType = ['text', 'character varying', 'uuid'].includes(dataType) || col.isEnum;
  return col;
}

function tableOf(spec) {
  const table = { name: spec.name, columns: new Map(), columnNames: [], primaryKey: ['id'], uniqueKeys: [], foreignKeys: [] };
  for (const [name, type, extra] of spec.columns) {
    const col = column(table.name, name, type, extra);
    table.columns.set(name, col);
    table.columnNames.push(name);
  }
  return table;
}

const INVOICES = tableOf({
  name: 'invoices',
  columns: [
    ['id', 'uuid'],
    ['appointment_id', 'uuid'],
    ['status', 'text', { enumValues: ['draft', 'issued', 'paid', 'void'], udtName: 'invoice_status' }],
    ['total', 'numeric'],
    ['paid_amount', 'numeric'],
    ['created_at', 'timestamp with time zone'],
    ['notes', 'text'],
  ],
});

const PATIENTS = tableOf({
  name: 'patients',
  columns: [
    ['id', 'uuid'],
    ['first_name', 'text'],
    ['national_id', 'text'],
  ],
});

function filterError(fn, code) {
  assert.throws(fn, (e) => e instanceof FilterError && (code === undefined || e.code === code));
}

export default [
  {
    name: 'eq: the bare-value shorthand and the {op, value} form compile the same way',
    fn: () => {
      for (const spec of ['issued', { op: 'eq', value: 'issued' }]) {
        const { sql, params } = compileFilter(INVOICES, 'status', spec);
        // an enum column compares on its ::text form — a label outside the
        // enum then simply never matches instead of failing the request
        assert.equal(sql, `("invoices"."status")::text = $1::text`);
        assert.deepEqual(params, ['issued']);
      }
    },
  },
  {
    name: 'the six comparison operators render their SQL token',
    fn: () => {
      const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      for (const [op, token] of Object.entries(ops)) {
        const { sql, params } = compileFilter(INVOICES, 'total', { op, value: 250 });
        assert.equal(sql, `"invoices"."total" ${token} $1::numeric`);
        assert.deepEqual(params, [250]);
      }
    },
  },
  {
    name: 'column-vs-column (W30): gt("total","paid_amount") compares the two columns',
    fn: () => {
      const { sql, params } = compileFilter(INVOICES, 'total', { op: 'gt', value: 'paid_amount' });
      assert.equal(sql, `"invoices"."total" > "invoices"."paid_amount"`);
      assert.deepEqual(params, []);
      // a quoted value is always a literal, even when it names a column
      const lit = compileFilter(INVOICES, 'status', { op: 'eq', value: '"issued"' });
      assert.equal(lit.sql, `("invoices"."status")::text = $1::text`);
      assert.deepEqual(lit.params, ['issued']);
      // non-comparison operators never take the column reading
      const txt = compileFilter(INVOICES, 'notes', { op: 'like', value: 'total' });
      assert.equal(txt.sql, `("invoices"."notes")::text like $1`);
    },
  },
  {
    name: 'a bad literal is 400 BAD_VALUE at compile time, never a Postgres crash',
    fn: () => {
      filterError(() => compileFilter(INVOICES, 'total', { op: 'gt', value: 'hello' }), 'BAD_VALUE');
      filterError(() => compileFilter(INVOICES, 'total', { op: 'gt', value: '1;drop table payments--' }), 'BAD_VALUE');
      // an enum filter compares on ::text: a label outside the enum is a plain
      // non-matching literal, NOT a 400 — UnpaidAging's 'status.eq.overdue'
      // ('overdue' is no invoice_status label) must answer with rows
      const away = compileFilter(INVOICES, 'status', { op: 'eq', value: 'not-a-status' });
      assert.equal(away.sql, `("invoices"."status")::text = $1::text`);
      assert.deepEqual(away.params, ['not-a-status']);
      // a malformed timestamp against a timestamptz column
      filterError(() => compileFilter(INVOICES, 'created_at', { op: 'gt', value: 'yesterday-ish' }), 'BAD_VALUE');
    },
  },
  {
    name: 'unknown filter columns are BAD_COLUMN; so is a column name that is not an identifier',
    fn: () => {
      filterError(() => compileFilter(INVOICES, 'nope', 'x'), 'BAD_COLUMN');
      filterError(() => compileFilters(INVOICES, { filters: { 'tot; al': 1 } }), 'BAD_COLUMN');
    },
  },
  {
    name: 'like/ilike: * becomes %, matching happens on the text form, and negation works',
    fn: () => {
      assert.deepEqual(compileFilter(PATIENTS, 'first_name', { op: 'ilike', value: '%ali%' }), {
        sql: `("patients"."first_name")::text ilike $1`,
        params: ['%ali%'],
      });
      // the shim sends PostgREST's '*' spelling; both arrive here
      assert.deepEqual(compileFilter(PATIENTS, 'first_name', { op: 'ilike', value: '*ali*' }).params, ['%ali%']);
      assert.match(compileFilter(PATIENTS, 'first_name', { op: 'nilike', value: 'x' }).sql, /not ilike/);
      assert.match(compileFilter(PATIENTS, 'first_name', { op: 'not.ilike', value: 'x' }).sql, /^not \(/);
    },
  },
  {
    name: 'in: JSON array, PostgREST list text, empty list, and every value bound',
    fn: () => {
      const a = compileFilter(INVOICES, 'status', { op: 'in', value: ['issued', 'paid'] });
      assert.equal(a.sql, `("invoices"."status")::text = any($1::text[])`);
      assert.deepEqual(a.params, [['issued', 'paid']]);
      const b = compileFilter(INVOICES, 'status', { op: 'in', value: '("issued","paid")' });
      assert.deepEqual(b.params, [['issued', 'paid']]);
      // an out-of-enum in-list label never matches either: it must not 400
      assert.deepEqual(compileFilter(INVOICES, 'status', { op: 'in', value: ['issued', 'overdue'] }).params, [['issued', 'overdue']]);
      assert.equal(compileFilter(INVOICES, 'status', { op: 'in', value: [] }).sql, 'false');
      assert.equal(compileFilter(INVOICES, 'status', { op: 'not.in', value: [] }).sql, 'true');
      // in-list values go through the same type check as everything else
      filterError(() => compileFilter(INVOICES, 'total', { op: 'in', value: ['10', 'hot'] }), 'BAD_VALUE');
      assert.deepEqual(parseInList('("a,b",c)', 'x'), ['a,b', 'c']);
    },
  },
  {
    name: 'is / is distinct / contains',
    fn: () => {
      assert.deepEqual(compileFilter(INVOICES, 'appointment_id', { op: 'is', value: null }), { sql: `"invoices"."appointment_id" is null`, params: [] });
      assert.match(compileFilter(INVOICES, 'appointment_id', { op: 'not.is', value: null }).sql, /^not \("invoices"."appointment_id" is null\)$/);
      assert.match(compileFilter(INVOICES, 'total', { op: 'isdistinct', value: 0 }).sql, /is distinct from \$1::numeric/);
      filterError(() => compileFilter(INVOICES, 'notes', { op: 'is', value: 'sunny' }), 'BAD_VALUE');
    },
  },
  {
    name: 'or() grammar: flat terms, values with dots, nested and(...), and a bad column',
    fn: () => {
      // W31's exact shape (two ilike terms) — the parameters must be distinct,
      // so each term keeps its own pattern even when the text is the same.
      const o = compileOr(PATIENTS, 'first_name.ilike.%ali%,national_id.ilike.%ali%');
      assert.equal(o.sql, `(("patients"."first_name")::text ilike $1) or (("patients"."national_id")::text ilike $2)`);
      assert.deepEqual(o.params, ['%ali%', '%ali%']);

      // a value that legitimately contains dots (a timestamp) is not re-split
      const ts = compileOr(INVOICES, 'created_at.gt.2026-01-02T03:04:05Z');
      assert.equal(ts.sql, `"invoices"."created_at" > $1::timestamp with time zone`);
      assert.deepEqual(ts.params, ['2026-01-02T03:04:05Z']);

      // nested groups
      const nest = compileOr(INVOICES, 'and(total.gt.100,paid_amount.lt.total),status.eq.void');
      assert.match(nest.sql, /and .* or /s);
      assert.deepEqual(nest.params, [100, 'void']);

      filterError(() => compileOr(INVOICES, 'nope.eq.1'), 'BAD_COLUMN');
      filterError(() => compileOr(INVOICES, ''), 'BAD_FILTER');
    },
  },
  {
    name: 'every value is bound: an injection payload is just a non-matching literal',
    fn: () => {
      const evil = compileFilter(PATIENTS, 'first_name', { op: 'eq', value: "a'; delete from app_users;--" });
      assert.equal(evil.sql, `"patients"."first_name" = $1::text`);
      assert.deepEqual(evil.params, [`a'; delete from app_users;--`]);
    },
  },
  {
    name: 'multiple filters AND together with one contiguous, correct parameter list',
    fn: () => {
      // Each fragment numbers itself from $1; the combiner must renumber so the
      // values appear in SQL order ($1, $2, $3...) and in params in the same
      // order — `is null` contributes SQL but no parameter.
      const where = compileFilters(INVOICES, {
        filters: { status: 'issued', total: { op: 'gt', value: 100 } },
        or: 'paid_amount.is.null,paid_amount.lt.10',
      });
      const numbers = [...where.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      assert.deepEqual(numbers, [1, 2, 3], `sql renumbering wrong: ${where.sql}`);
      assert.deepEqual(where.params, ['issued', 100, 10]);
      assert.match(where.sql, / and /);
      assert.match(where.sql, / or /);
    },
  },
  {
    name: 'sqlType maps the catalog types, enums included',
    fn: () => {
      assert.equal(sqlType(INVOICES.columns.get('total')), 'numeric');
      assert.equal(sqlType(INVOICES.columns.get('created_at')), 'timestamp with time zone');
      assert.equal(sqlType(INVOICES.columns.get('status')), '"public"."invoice_status"');
      assert.equal(sqlType(PATIENTS.columns.get('first_name')), 'text');
    },
  },
  {
    name: 'combineAnd over fragments with their own $1 numbers them contiguously',
    fn: () => {
      const one = compileFilter(INVOICES, 'status', 'draft');
      const two = compileFilter(INVOICES, 'total', { op: 'lt', value: 5 });
      const joined = combineAnd([one, two]);
      assert.match(joined.sql, /\("invoices"\."status"\)::text = \$1::text\) and \("invoices"\."total" < \$2::numeric/);
      assert.deepEqual(joined.params, ['draft', 5]);
      assert.equal(combineAnd([null, one]).sql, one.sql);
      assert.equal(combineAnd([null, null]), null);
    },
  },
];
