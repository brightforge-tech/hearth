// api/lib/catalog.mjs — information_schema cache: validation + JSON coercion (task t7).
//
// Every identifier in a request comes from the browser: the table name, the
// select list, the filter columns, the order columns, the payload keys. The one
// rule that keeps this safe (and that the plan calls the SQL-injection
// mitigation) is that nothing is ever interpolated into SQL before it has been
// looked up in this cache. What the cache holds is a snapshot of
// information_schema for the public schema:
//
//   tables   name -> { name, columns: Map<name, column>, columnNames[],
//                       primaryKey[], uniqueKeys[], foreignKeys[] }
//   column        { name, dataType, udtName, udtSchema, isNullable,
//                   enumValues[], isNumeric, isTemporal, jsonType, textType }
//   enums    'public.invoice_status' -> ['draft','issued','paid','void']
//   fks      the child -> parent links, which is what tells an embedded
//            resource whether it is a to-one (invoices.appointment_id ->
//            appointments.id) or a to-many (invoice_items.invoice_id ->
//            invoices.id) relation, and on which columns to correlate it.
//
// The same metadata drives the response types (the plan's "numeric->number,
// timestamptz/date->string, uuid/text/enum->string, jsonb->object,
// boolean->boolean"): the query route builds its rows as json_build_object, so
// Postgres does the encoding — but filters still need to know a column's type
// (a non-numeric literal against a numeric column is a 400, not a crash) and
// payload values still need coercing, so both helpers live here next to the
// information they come from.
//
// The cache is loaded once, on first use, and may be invalidated with
// resetCatalog() (the migration runner and the tests call it; the API itself
// does not, because nothing at runtime changes the schema). Loading is a
// single round trip and is de-duplicated between concurrent callers.

import { query as poolQuery } from '../db.mjs';

const SCHEMA = 'public';

let cache = null; // Promise<catalog> | null

// quoteIdent(name): the only identifier quoting in the API. Callers must pass a
// name that already passed `hasTable`/`hasColumn` — this function makes the
// quoting safe against reserved words and mixed case, not against injection.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// loadCatalog({query}): fetch the snapshot now (a fresh load replaces the cache).
export async function loadCatalog({ query = poolQuery } = {}) {
  const [columns, enums, primaryKeys, uniqueKeys, foreignKeys] = await Promise.all([
    query(
      `select table_name, column_name, ordinal_position, data_type, udt_schema, udt_name,
              is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale
         from information_schema.columns
        where table_schema = $1
        order by table_name, ordinal_position`,
      [SCHEMA]
    ),
    query(
      `select n.nspname as schema_name, t.typname as type_name, e.enumlabel as label
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1
        order by t.typname, e.enumsortorder`,
      [SCHEMA]
    ),
    query(
      `select r.relname as table_name, a.attname as column_name
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
         join unnest(c.conkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = r.oid and a.attnum = k.attnum
        where c.contype = 'p' and n.nspname = $1
        order by r.relname, k.ord`,
      [SCHEMA]
    ),
    query(
      `select r.relname as table_name, conname as constraint_name,
              array_agg(a.attname::text order by k.ord) as column_names
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
         join unnest(c.conkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = r.oid and a.attnum = k.attnum
        where c.contype in ('u', 'p') and n.nspname = $1
        group by r.relname, conname
        order by r.relname, conname`,
      [SCHEMA]
    ),
    query(
      `select r.relname as table_name, a.attname as column_name,
              rt.relname as foreign_table, rf.attname as foreign_column,
              c.conname as constraint_name
         from pg_constraint c
         join pg_class r on r.oid = c.conrelid
         join pg_namespace n on n.oid = r.relnamespace
         join pg_class rt on rt.oid = c.confrelid
         join unnest(c.conkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = r.oid and a.attnum = k.attnum
         join unnest(c.confkey) with ordinality as kf(attnum, ord) on kf.ord = k.ord
         join pg_attribute rf on rf.attrelid = rt.oid and rf.attnum = kf.attnum
        where c.contype = 'f' and n.nspname = $1
        order by r.relname, c.conname, k.ord`,
      [SCHEMA]
    ),
  ]);

  const enumValues = new Map();
  for (const row of enums.rows) {
    const key = `${row.schema_name}.${row.type_name}`;
    if (!enumValues.has(key)) enumValues.set(key, []);
    enumValues.get(key).push(row.label);
  }

  const tables = new Map();
  const tableOf = (name) => {
    if (!tables.has(name)) {
      tables.set(name, {
        name,
        schema: SCHEMA,
        columns: new Map(),
        columnNames: [],
        primaryKey: [],
        uniqueKeys: [],
        foreignKeys: [],
      });
    }
    return tables.get(name);
  };

  for (const row of columns.rows) {
    const table = tableOf(row.table_name);
    if (table.columns.has(row.column_name)) continue;
    const col = {
      name: row.column_name,
      table: row.table_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      udtSchema: row.udt_schema,
      isNullable: row.is_nullable === 'YES',
      default: row.column_default,
      maxLength: row.character_maximum_length,
      enumValues: enumValues.get(`${row.udt_schema}.${row.udt_name}`) ?? null,
    };
    col.isEnum = col.enumValues !== null;
    col.isNumeric = col.dataType === 'numeric' || col.dataType === 'integer' || col.dataType === 'smallint' ||
      col.dataType === 'bigint' || col.dataType === 'real' || col.dataType === 'double precision';
    col.isBoolean = col.dataType === 'boolean';
    col.isTemporal = col.dataType === 'timestamp with time zone' || col.dataType === 'timestamp without time zone' ||
      col.dataType === 'date' || col.dataType === 'time with time zone' || col.dataType === 'time without time zone';
    col.isJson = col.dataType === 'json' || col.dataType === 'jsonb';
    col.textType = col.dataType === 'text' || col.dataType === 'character varying' || col.dataType === 'character' ||
      col.dataType === 'uuid' || col.isEnum;
    table.columns.set(col.name, col);
    table.columnNames.push(col.name);
  }
  for (const row of primaryKeys.rows) tableOf(row.table_name).primaryKey.push(row.column_name);
  for (const row of uniqueKeys.rows) tableOf(row.table_name).uniqueKeys.push(row.column_names);
  for (const row of foreignKeys.rows) {
    tableOf(row.table_name).foreignKeys.push({
      column: row.column_name,
      foreignTable: row.foreign_table,
      foreignColumn: row.foreign_column,
      constraint: row.constraint_name,
    });
  }

  return { tables, enums: enumValues, loadedAt: new Date().toISOString(), schema: SCHEMA };
}

// getCatalog(): the cached snapshot, loaded on first call (concurrent callers
// share one load).
export function getCatalog() {
  if (!cache) cache = loadCatalog();
  return cache;
}

// resetCatalog(): drop the cache (after a migration, or in a test that rebuilt
// the schema).
export function resetCatalog() {
  cache = null;
}

// --- lookups ---------------------------------------------------------------

export function hasTable(catalog, name) {
  return typeof name === 'string' && catalog.tables.has(name);
}

export function getTable(catalog, name) {
  return catalog.tables.get(name);
}

export function getColumn(catalog, tableName, columnName) {
  const table = catalog.tables.get(tableName);
  if (!table) return undefined;
  return table.columns.get(columnName);
}

// allColumns(table): every column of a table, in declaration order — what a
// `select *` expands to.
export function allColumns(table) {
  return table.columnNames.map((name) => table.columns.get(name));
}

// relationship(parent, childTable): how `childTable` relates to `parent`,
// deciding the shape of an embedded resource:
//
//   { direction: 'toOne',  localColumn, foreignTable, foreignColumn }
//        the parent holds the FK  (invoices.appointment_id -> appointments.id)
//   { direction: 'toMany', localColumn, foreignTable, foreignColumn }
//        the child holds the FK   (invoice_items.invoice_id -> invoices.id)
//   null when there is no foreign key between the two, which is what makes
//   `foo:bar(...)` in a select string a 400 rather than a cartesian product.
export function relationship(catalog, parentTable, childTable) {
  const parent = catalog.tables.get(parentTable);
  const child = catalog.tables.get(childTable);
  if (!parent || !child) return null;
  const outgoing = parent.foreignKeys.find((fk) => fk.foreignTable === child.name);
  if (outgoing) {
    return { direction: 'toOne', localColumn: outgoing.column, foreignTable: child.name, foreignColumn: outgoing.foreignColumn };
  }
  const incoming = child.foreignKeys.find((fk) => fk.foreignTable === parent.name);
  if (incoming) {
    return { direction: 'toMany', localColumn: incoming.foreignColumn, foreignTable: child.name, foreignColumn: incoming.column };
  }
  return null;
}

// --- value handling --------------------------------------------------------

// COERCE: the Postgres-to-JSON mapping the plan fixes. Values the API *writes*
// go through coerceIn (a JSON payload is not a Postgres literal); values the
// API *reads* are encoded by json_build_object in SQL, so the same table is the
// documentation of what the caller receives.
export const COERCE = Object.freeze({
  numeric: 'number',
  integer: 'number',
  smallint: 'number',
  bigint: 'number',
  real: 'number',
  'double precision': 'number',
  'timestamp with time zone': 'string',
  'timestamp without time zone': 'string',
  date: 'string',
  'time with time zone': 'string',
  'time without time zone': 'string',
  uuid: 'string',
  text: 'string',
  'character varying': 'string',
  character: 'string',
  json: 'object',
  jsonb: 'object',
  boolean: 'boolean',
  enum: 'string',
});

// jsonTypeOf(column): 'number' | 'string' | 'boolean' | 'object'.
export function jsonTypeOf(column) {
  if (!column) return 'string';
  if (column.isEnum) return 'string';
  return COERCE[column.dataType] ?? 'string';
}

const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 with an optional time and zone: what the pages send and what we
// hand back, and the only form accepted for a temporal column.
const TEMPORAL_RE = /^\d{4}-\d{2}-\d{2}([T ][0-2]\d:[0-5]\d(:[0-5]\d(\.\d+)?)?(([Zz])|([+-][0-2]\d:?[0-5]\d))?)?$/;
const BOOLEAN_RE = /^(true|false|t|f|yes|no|1|0)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// coerceIn(column, value): the JS value to bind for a column, or a
// CoerceError describing why the request is wrong. It never guesses: a
// malformed literal is an error, which is what turns "total gt hello" into a
// 400 instead of a Postgres 22P02 crash (the plan's explicit requirement).
export class CoerceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoerceError';
    this.code = 'BAD_VALUE';
  }
}

export function coerceIn(column, value, { label } = {}) {
  const where = label ?? `${column.table}.${column.name}`;
  if (value === null) return null;
  if (column.isEnum) {
    const text = String(value);
    if (!column.enumValues.includes(text)) {
      throw new CoerceError(`${where} must be one of ${column.enumValues.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`);
    }
    return text;
  }
  switch (column.dataType) {
    case 'numeric':
    case 'integer':
       case 'smallint':
    case 'bigint':
    case 'real':
    case 'double precision': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new CoerceError(`${where} expects a number, got ${JSON.stringify(value)}`);
      }
      if ((column.dataType === 'integer' || column.dataType === 'smallint' || column.dataType === 'bigint') && !Number.isInteger(n)) {
        throw new CoerceError(`${where} expects a whole number, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (!BOOLEAN_RE.test(String(value).trim())) {
        throw new CoerceError(`${where} expects true or false, got ${JSON.stringify(value)}`);
      }
      return /^(true|t|yes|1)$/i.test(String(value).trim());
    }
    case 'date': {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (!DATE_RE.test(String(value).trim())) {
        throw new CoerceError(`${where} expects a calendar date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
      }
      return String(value).trim();
    }
    case 'timestamp with time zone':
    case 'timestamp without time zone': {
      if (value instanceof Date) return value.toISOString();
      const text = String(value).trim();
      if (!TEMPORAL_RE.test(text) || Number.isNaN(Date.parse(text))) {
        throw new CoerceError(`${where} expects an ISO 8601 date or timestamp, got ${JSON.stringify(value)}`);
      }
      return text;
    }
    case 'uuid': {
      if (!UUID_RE.test(String(value).trim())) {
        throw new CoerceError(`${where} expects a uuid, got ${JSON.stringify(value)}`);
      }
      return String(value).trim();
    }
    case 'json':
    case 'jsonb': {
      if (value !== null && typeof value === 'object') return JSON.stringify(value);
      throw new CoerceError(`${where} expects a JSON object or array, got ${JSON.stringify(value)}`);
    }
    default: {
      // text/varchar/char and anything unexpected: the driver binds a string.
      if (typeof value === 'object') {
        throw new CoerceError(`${where} expects a string, got an object or array`);
      }
      return String(value);
    }
  }
}

// isNumericColumn(column): filters need this to reject `gt('total','hello')`.
export function isNumericColumn(column) {
  return Boolean(column) && column.isNumeric;
}

// numericLiteral(value): true when the text is a plain number, i.e. when a
// numeric comparison against it is well-formed. Used before binding so a bad
// literal is a 400 the caller can read, not a 500 in the log.
export function numericLiteral(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return NUMERIC_RE.test(String(value).trim());
}

export default getCatalog;
