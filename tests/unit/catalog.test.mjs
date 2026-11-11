// tests/unit/catalog.test.mjs — the catalog module's pure half (task t7).
//
// loadCatalog() is exercised by the API suite against a real database; what
// belongs here is everything the route depends on that needs no server:
// identifier quoting, the to-one/to-many decision behind every embedded
// resource, the JSON type table, and the value coercions that turn a JSON
// payload into something the driver can bind — with a bad value arriving as a
// CoerceError (a 400) rather than a Postgres error.

import assert from 'node:assert/strict';

import {
  allColumns,
  CoerceError,
  coerceIn,
  getColumn,
  getTable,
  hasTable,
  jsonTypeOf,
  numericLiteral,
  quoteIdent,
  relationship,
} from '../../api/lib/catalog.mjs';

function makeColumn(table, name, dataType, extra = {}) {
  return {
    name,
    table,
    dataType,
    udtName: extra.udtName ?? dataType,
    udtSchema: 'public',
    isNullable: true,
    default: null,
    maxLength: null,
    enumValues: extra.enumValues ?? null,
    isEnum: extra.enumValues != null,
    isNumeric: ['numeric', 'integer'].includes(dataType),
    isBoolean: dataType === 'boolean',
    isTemporal: dataType === 'date' || dataType.startsWith('timestamp'),
    isJson: dataType === 'jsonb',
    textType: ['text', 'uuid'].includes(dataType) || extra.enumValues != null,
  };
}

function makeTable(name, columnDefs, { primaryKey = ['id'], foreignKeys = [] } = {}) {
  const table = { name, schema: 'public', columns: new Map(), columnNames: [], primaryKey, uniqueKeys: [primaryKey], foreignKeys };
  for (const [col, type, extra] of columnDefs) {
    table.columns.set(col, makeColumn(name, col, type, extra));
    table.columnNames.push(col);
  }
  return table;
}

// The slice of the real schema this module's decisions care about.
const catalog = {
  tables: new Map([
    ['patients', makeTable('patients', [['id', 'uuid'], ['first_name', 'text']])],
    ['appointments', makeTable('appointments', [['id', 'uuid'], ['patient_id', 'uuid']], { foreignKeys: [{ column: 'patient_id', foreignTable: 'patients', foreignColumn: 'id', constraint: 'a_p_fkey' }] })],
    ['invoices', makeTable('invoices', [['id', 'uuid'], ['appointment_id', 'uuid'], ['total', 'numeric'], ['metadata', 'jsonb'], ['paid', 'boolean'], ['issued_on', 'date'], ['created_at', 'timestamp with time zone']], { foreignKeys: [{ column: 'appointment_id', foreignTable: 'appointments', foreignColumn: 'id', constraint: 'i_a_fkey' }] })],
    ['invoice_items', makeTable('invoice_items', [['id', 'uuid'], ['invoice_id', 'uuid'], ['service_id', 'uuid']], { foreignKeys: [{ column: 'invoice_id', foreignTable: 'invoices', foreignColumn: 'id', constraint: 'ii_i_fkey' }, { column: 'service_id', foreignTable: 'services', foreignColumn: 'id', constraint: 'ii_s_fkey' }] })],
    ['services', makeTable('services', [['id', 'uuid'], ['name', 'text'], ['price', 'numeric']])],
    ['statuses', makeTable('statuses', [['id', 'uuid'], ['label', 'text', { enumValues: ['draft', 'issued', 'paid', 'void'], udtName: 'invoice_status' }]], { primaryKey: [] })],
  ]),
  enums: new Map(),
  loadedAt: '',
  schema: 'public',
};

export default [
  {
    name: 'quoteIdent: reserved words and mixed case survive; embedded quotes double',
    fn: () => {
      assert.equal(quoteIdent('select'), '"select"');
      assert.equal(quoteIdent('Total'), '"Total"');
      assert.equal(quoteIdent('a"b'), '"a""b"');
    },
  },
  {
    name: 'relationship(): parent-held FK is to-one, child-held FK is to-many',
    fn: () => {
      const invToAppt = relationship(catalog, 'invoices', 'appointments');
      assert.deepEqual({ direction: invToAppt.direction, localColumn: invToAppt.localColumn, foreignColumn: invToAppt.foreignColumn },
        { direction: 'toOne', localColumn: 'appointment_id', foreignColumn: 'id' });
      const invToItems = relationship(catalog, 'invoices', 'invoice_items');
      assert.deepEqual({ direction: invToItems.direction, localColumn: invToItems.localColumn, foreignColumn: invToItems.foreignColumn },
        { direction: 'toMany', localColumn: 'id', foreignColumn: 'invoice_id' });
      // the FK always correlates parent.id with the child's key column, either way
      assert.deepEqual({ lc: invToAppt.localColumn, fc: invToAppt.foreignColumn }, { lc: 'appointment_id', fc: 'id' });
    },
  },
  {
    name: 'relationship(): no FK, or a name the catalog does not know, is null — the 400 path',
    fn: () => {
      assert.equal(relationship(catalog, 'invoices', 'services'), null); // no FK between them
      assert.equal(relationship(catalog, 'invoices', 'nope'), null);
      assert.equal(relationship(catalog, 'constructor', 'invoices'), null);
    },
  },
  {
    name: 'lookups: hasTable / getTable / getColumn / allColumns',
    fn: () => {
      assert.equal(hasTable(catalog, 'invoices'), true);
      assert.equal(hasTable(catalog, 'constructor'), false); // never through Object.prototype
      assert.equal(getTable(catalog, 'invoices').columnNames[0], 'id');
      assert.equal(getColumn(catalog, 'invoices', 'total').dataType, 'numeric');
      assert.equal(getColumn(catalog, 'nope', 'total'), undefined);
      assert.deepEqual(allColumns(getTable(catalog, 'services')).map((c) => c.name), ['id', 'name', 'price']);
    },
  },
  {
    name: 'jsonTypeOf is the plan\u2019s coercion table (what the JSON response carries)',
    fn: () => {
      const t = getTable(catalog, 'invoices');
      assert.equal(jsonTypeOf(t.columns.get('total')), 'number');
      assert.equal(jsonTypeOf(t.columns.get('created_at')), 'string'); // timestamptz -> string
      assert.equal(jsonTypeOf(t.columns.get('issued_on')), 'string'); // date -> string
      assert.equal(jsonTypeOf(t.columns.get('id')), 'string'); // uuid -> string
      assert.equal(jsonTypeOf(t.columns.get('metadata')), 'object'); // jsonb -> object
      assert.equal(jsonTypeOf(t.columns.get('paid')), 'boolean');
      assert.equal(jsonTypeOf(getColumn(catalog, 'statuses', 'label')), 'string'); // enum -> string
    },
  },
  {
    name: 'coerceIn: numbers, booleans, dates, timestamps, uuids, enums, jsonb',
    fn: () => {
      const t = getTable(catalog, 'invoices');
      assert.equal(coerceIn(t.columns.get('total'), '250.50'), 250.5);
      assert.equal(coerceIn(t.columns.get('total'), 250.5), 250.5);
      assert.equal(coerceIn(t.columns.get('total'), null), null);
      assert.equal(coerceIn(t.columns.get('paid'), 'true'), true);
      assert.equal(coerceIn(t.columns.get('paid'), false), false);
      assert.equal(coerceIn(t.columns.get('issued_on'), '2026-01-31'), '2026-01-31');
      assert.equal(coerceIn(t.columns.get('created_at'), '2026-01-31T10:00:00Z'), '2026-01-31T10:00:00Z');
      assert.equal(coerceIn(t.columns.get('metadata'), { a: 1 }), '{"a":1}'); // jsonb is bound as text
      assert.equal(coerceIn(getColumn(catalog, 'statuses', 'label'), 'issued'), 'issued');
    },
  },
  {
    name: 'coerceIn refuses to guess: every rejection is a CoerceError BAD_VALUE',
    fn: () => {
      const t = getTable(catalog, 'invoices');
      const bad = (column, value) => assert.throws(() => coerceIn(column, value), (e) => e instanceof CoerceError && e.code === 'BAD_VALUE');
      bad(t.columns.get('total'), 'three hundred');
      bad(t.columns.get('total'), {});
      bad(t.columns.get('paid'), 'maybe');
      bad(t.columns.get('issued_on'), '31/01/2026');
      bad(t.columns.get('created_at'), 'yesterday');
      bad(t.columns.get('metadata'), 'not json');
      bad(getColumn(catalog, 'statuses', 'label'), 'underway'); // an enum label not in the list
      // integer columns demand whole numbers — and the real catalog carries those cases too
      const ints = makeTable('ints', [['n', 'integer']]).columns.get('n');
      assert.equal(coerceIn(ints, '42'), 42);
      bad(ints, 4.5);
    },
  },
  {
    name: 'numericLiteral guards the numeric comparisons before anything binds',
    fn: () => {
      assert.equal(numericLiteral(10), true);
      assert.equal(numericLiteral('-3.5'), true);
      assert.equal(numericLiteral('1e3'), true);
      assert.equal(numericLiteral('0x10'), false);
      assert.equal(numericLiteral('10; drop table payments--'), false);
      assert.equal(numericLiteral(Infinity), false);
      assert.equal(numericLiteral(''), false);
    },
  },
];
