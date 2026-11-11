// api/lib/filters.mjs — the filter grammar compiled to bound-parameter SQL (task t7).
//
// The shim sends the filters a page built through the supabase-js chain —
// `.eq('status','issued')`, `.ilike('first_name','%ali%')`, `.in('status',
// ['issued','overdue'])`, `.is('signed_at', null)` — as data:
//
//   { "status": { "op": "eq", "value": "issued" },
//     "total":  { "op": "gt", "value": "paid_amount" } }
//   "or": "status.eq.issued,status.eq.overdue"
//
// and this module turns them into a SQL boolean expression plus the parameter
// values. Two rules make it safe once self-hosted, and they are the plan's
// stated mitigation for SQL injection through the query layer:
//
//   1. Identifiers (columns) are checked against the catalog before they are
//      used, and a validated column is the ONLY thing ever interpolated into
//      the expression — which is also what makes the column-vs-column form
//      below safe: the right-hand identifier went through the same check.
//   2. Every value is a bound $n parameter, cast to the column's own type
//      (`$2::numeric`), so a value can never be parsed as SQL. Injection
//      attempts (`1;drop table payments--`, `'); delete from app_users;--`)
//      are therefore ordinary (non-matching) literals; where they are not even
//      valid as the column's type, they are refused with a 400 here, before
//      anything runs.
//
// Column-vs-column (PostgREST behaviour, W30): for the comparison operators
// eq/neq/gt/gte/lt/lte, a bare string value that names another column of the
// same table is read as a column reference — `gt('total','paid_amount')`
// compares the two columns, which is what the unpaid-aging report on the
// Reports page relies on. Anything else (a quoted "value", a value that is not
// an identifier, a value that is not a column of this table) is a literal.
//
// Type checking: a non-numeric literal against a numeric column, a non-boolean
// for a boolean column or a malformed date is a FilterError (400 BAD_VALUE/400
// BAD_FILTER), never a Postgres 22P02 (the plan's "yields a 400, not a crash").
//
// Enum columns are the one exception on the READ side: a filter on an enum is
// compiled against the column's `::text` form, so a value outside the enum's
// labels simply never matches instead of erroring. PostgREST casts the literal
// to the enum and fails the whole request, which is why UnpaidAging.tsx's
// `or('status.eq.issued,status.eq.overdue')` — 'overdue' is not an
// invoice_status label — must answer with rows here, not with a 400. (Writes
// still validate enum labels through coerceIn, so bad data cannot be stored.)
//
// Operators accepted (the subset of PostgREST's the app uses):
//   eq neq gt gte lt lte like ilike nlike nilike in is isdistinct contains
//   and the `not.` prefix on any of them.

import { CoerceError, coerceIn, numericLiteral, quoteIdent } from './catalog.mjs';
import { splitTopLevel } from './sql-spec.mjs';

export class FilterError extends Error {
  constructor(message, code = 'BAD_FILTER') {
    super(message);
    this.name = 'FilterError';
    this.code = code;
  }
}

// The operator table: each name -> the SQL comparison it stands for. `nulls`
// marks the ones that take a null/true/false test instead of a value; `cast`
// marks the ones that compare text forms (like/ilike) rather than the column's
// own type.
const OPERATORS = new Map([
  ['eq', { sql: '=', value: true }],
  ['neq', { sql: '<>', value: true }],
  ['gt', { sql: '>', value: true }],
  ['gte', { sql: '>=', value: true }],
  ['lt', { sql: '<', value: true }],
  ['lte', { sql: '<=', value: true }],
  ['like', { sql: 'like', text: true, value: true }],
  ['nlike', { sql: 'not like', text: true, value: true }],
  ['ilike', { sql: 'ilike', text: true, value: true }],
  ['nilike', { sql: 'not ilike', text: true, value: true }],
  ['exact', { sql: '=', cast: 'text', value: true }],
  ['contains', { sql: '@>', json: true, value: true }],
  ['isdistinct', { sql: 'is distinct from', value: true }],
  ['is', { isTest: true }],
  ['in', { inList: true, value: true }],
]);

// The operators for which a bare column name means the other column (W30).
const COMPARISONS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

// The identifier shape a column name must have. Checked by the caller too, but
// a filter column is used as text in SQL, so it is checked again here.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// sqlType(column): the type name a parameter must be cast to so the comparison
// happens in the column's own type. Enum columns cast to their enum type, so a
// bad label is rejected by Postgres' enum input function — after this module
// already rejected it by name.
export function sqlType(column) {
  if (column.isEnum) return `${quoteIdent(column.udtSchema)}.${quoteIdent(column.udtName)}`;
  switch (column.dataType) {
    case 'numeric': return 'numeric';
    case 'integer': return 'integer';
    case 'smallint': return 'smallint';
    case 'bigint': return 'bigint';
    case 'real': return 'real';
    case 'double precision': return 'double precision';
    case 'boolean': return 'boolean';
    case 'date': return 'date';
    case 'timestamp with time zone': return 'timestamp with time zone';
    case 'timestamp without time zone': return 'timestamp without time zone';
    case 'uuid': return 'uuid';
    case 'json': return 'json';
    case 'jsonb': return 'jsonb';
    default: return 'text';
  }
}

// compileColumn(table, column): the qualified, quoted column reference.
function compileColumn(table, column) {
  return `${quoteIdent(table.name)}.${quoteIdent(column.name)}`;
}

// isOtherColumn(table, value): the column-vs-column test (W30). Only a string
// that is exactly one identifier AND a column of the queried table counts —
// that is also the reason the interpolated name cannot be anything but a
// column this request was already allowed to see.
function isOtherColumn(table, value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!IDENT.test(text)) return null;
  return table.columns.has(text) ? text : null;
}

// compileFilter(table, columnName, spec): one `{column: {op, value}}` or
// `{column: value}` (which is eq) into {sql, params}.
export function compileFilter(table, columnName, spec) {
  const column = table.columns.get(columnName);
  if (!column) {
    throw new FilterError(`no column ${JSON.stringify(columnName)} on table ${JSON.stringify(table.name)}`, 'BAD_COLUMN');
  }
  let op = 'eq';
  let value = spec;
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec) && ('op' in spec || 'value' in spec)) {
    if (!('op' in spec) || typeof spec.op !== 'string') throw new FilterError(`filter on ${JSON.stringify(columnName)} needs an "op"`, 'BAD_FILTER');
    if (!('value' in spec)) throw new FilterError(`filter on ${JSON.stringify(columnName)} needs a "value"`, 'BAD_FILTER');
    op = spec.op.trim().toLowerCase();
    value = spec.value;
  }
  if (typeof op !== 'string' || op === '') throw new FilterError(`invalid filter operator ${JSON.stringify(spec?.op)} on ${JSON.stringify(columnName)}`, 'BAD_FILTER');

  // `not.` prefix (PostgREST's `.not.eq.x`): every operator can be negated.
  let negate = false;
  if (op.startsWith('not.')) {
    negate = true;
    op = op.slice('not.'.length);
  }

  const def = OPERATORS.get(op);
  if (!def) throw new FilterError(`unsupported filter operator ${JSON.stringify(op)} on ${JSON.stringify(columnName)}`, 'BAD_FILTER');

  const ref = compileColumn(table, column);
  let params = [];
  let sql;

  if (def.isTest) {
    // is.null / is.true / is.false — the only forms PostgREST's .is() needs here.
    const text = value === null ? 'null' : String(value).trim().toLowerCase();
    if (text === 'null') sql = `${ref} is null`;
    else if (text === 'true') sql = `${ref} is true`;
    else if (text === 'false') sql = `${ref} is false`;
    else throw new FilterError(`is on ${JSON.stringify(columnName)} expects null, true or false, got ${JSON.stringify(value)}`, 'BAD_VALUE');
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }

  if (def.inList) {
    const items = parseInList(value, columnName);
    if (items.length === 0) {
      // `in ()` matches nothing, exactly as PostgREST's empty list does.
      sql = 'false';
      if (negate) sql = 'true';
      return { sql, params };
    }
    if (column.isEnum) {
      // enum reads compare on the text form (see the header): a label outside
      // the enum simply never matches, it does not fail the request.
      params = [items.map((item) => String(item))];
      sql = `(${ref})::text = any($${1}::text[])`;
    } else {
      const cast = sqlType(column);
      const bound = items.map((item) => coerceOr400(column, item, `${table.name}.${column.name}`));
      params = [bound];
      sql = `${ref} = any($${1}::${cast}[])`;
    }
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }

  if (def.text) {
    // like/ilike compare text forms of whatever the column is.
    const pattern = likePattern(value, columnName);
    params = [pattern];
    sql = `(${ref})::text ${def.sql} $${1}`;
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }

  if (def.json) {
    params = [JSON.stringify(value ?? null)];
    sql = `${ref} ${def.sql} $${1}::jsonb`;
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }

  // A plain comparison: column-vs-column, or a bound literal.
  const other = COMPARISONS.has(op) ? isOtherColumn(table, value) : null;
  if (other !== null) {
    sql = `${ref} ${def.sql} ${quoteIdent(table.name)}.${quoteIdent(other)}`;
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }

  // A double-quoted value is always a literal, even when it names a column —
  // that is how a caller says "compare against the string 'status'".
  const literal = unquoteLiteral(value);
  if (column.isEnum) {
    // enum reads compare on the text form (see the header): a value outside
    // the enum's labels never matches instead of failing the whole request,
    // which is what UnpaidAging's 'status.eq.overdue' term needs.
    params = [literal === undefined || literal === null ? literal : String(literal)];
    sql = `(${ref})::text ${def.sql} $${1}::text`;
    if (negate) sql = `not (${sql})`;
    return { sql, params };
  }
  const cast = sqlType(column);
  params = [coerceOr400(column, literal, `${table.name}.${column.name}`)];
  sql = `${ref} ${def.sql} $${1}::${cast}`;
  if (negate) sql = `not (${sql})`;
  return { sql, params };
}

// coerceOr400: catalog coercion, with the catalog's CoerceError reported as a
// 400 BAD_VALUE naming the column (the plan's "a non-numeric literal against a
// numeric column yields a 400, not a crash").
function coerceOr400(column, value, label) {
  if (column.isNumeric && value !== null && !numericLiteral(value)) {
    throw new FilterError(`${label} expects a number, got ${JSON.stringify(value)}`, 'BAD_VALUE');
  }
  try {
    return coerceIn(column, value, { label });
  } catch (e) {
    if (e instanceof CoerceError) throw new FilterError(e.message, 'BAD_VALUE');
    throw e;
  }
}

// unquoteLiteral: strip one layer of SQL-style double quotes (the "escape
// hatch" that forces the literal reading).
function unquoteLiteral(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  return value;
}

// likePattern: the ilike/like argument as Postgres wants it. PostgREST writes
// '*' where SQL wants '%', and both spellings arrive here (the shim's `.ilike`
// and the raw `or('col.ilike.*ali*')` grammar), so '*' becomes '%' and '%'
// passes through; an empty pattern would match only the empty string, which is
// what an empty filter means.
export function likePattern(value, columnName) {
  if (value === null || value === undefined) {
    throw new FilterError(`a like/ilike filter on ${JSON.stringify(columnName)} needs a pattern`, 'BAD_VALUE');
  }
  return String(value).replace(/\*/g, '%');
}

// parseInList: the values of an `in` filter, from a JSON array, from
// PostgREST's `("a","b")` list, or from a bare comma-separated string.
export function parseInList(value, columnName) {
  if (Array.isArray(value)) return value.map((v) => unquoteLiteral(v));
  const text = String(value ?? '').trim();
  let inner = text;
  if (text.startsWith('(') && text.endsWith(')')) inner = text.slice(1, -1);
  if (inner.trim() === '') return [];
  return splitTopLevel(inner, ',').map((part) => unquoteLiteral(part.trim()));
}

// compileFilters(table, {filters, or}): the whole WHERE expression (without the
// keyword), or null when there is nothing to restrict.
export function compileFilters(table, { filters, or } = {}) {
  const parts = [];

  if (filters !== undefined && filters !== null) {
    if (typeof filters !== 'object' || Array.isArray(filters)) {
      throw new FilterError('filters must be an object of column -> {op, value}', 'BAD_FILTER');
    }
    for (const [column, spec] of Object.entries(filters)) {
      if (!IDENT.test(column)) throw new FilterError(`invalid filter column ${JSON.stringify(column)}`, 'BAD_COLUMN');
      parts.push(compileFilter(table, column, spec));
    }
  }

  if (or !== undefined && or !== null && or !== '') {
    if (typeof or !== 'string') throw new FilterError('or must be a string in the "column.op.value,..." grammar', 'BAD_FILTER');
    parts.push(compileOr(table, or));
  }

  if (parts.length === 0) return null;
  return combineAnd(parts);
}

// compileOr(table, expr): PostgREST's `or('a.eq.1,b.gt.2')` grammar, including
// the nested and(...)/or(...) groups the shim may send. The operator names come
// from the same fixed allow-list as everywhere else; the column is validated;
// only the value is free text, and it always becomes a bound parameter.
export function compileOr(table, expr) {
  const text = String(expr).trim();
  if (text === '') throw new FilterError('or() needs at least one filter', 'BAD_FILTER');
  const terms = splitTopLevel(text, ',');
  const parts = terms.map((term) => compileOrTerm(table, term.trim()));
  return combineOr(parts);
}

function compileOrTerm(table, term) {
  if (term === '') throw new FilterError('or() has an empty term', 'BAD_FILTER');

  // nested group: and(...) / or(...)
  const open = term.indexOf('(');
  if (open !== -1) {
    const head = term.slice(0, open).trim().toLowerCase();
    if (!term.endsWith(')')) throw new FilterError(`unbalanced parentheses in or() term ${JSON.stringify(term)}`, 'BAD_FILTER');
    const inner = term.slice(open + 1, -1);
    if (head === 'and') return compileAndGroup(table, inner);
    if (head === 'or') return compileOr(table, inner);
    // otherwise it is a filter whose VALUE contains parentheses, e.g.
    // status.in.(a,b) — fall through to the normal parser.
  }

  const segments = splitTopLevel(term, '.');
  if (segments.length < 2) {
    throw new FilterError(`or() term ${JSON.stringify(term)} is not column.op.value`, 'BAD_FILTER');
  }
  const [columnName, opName, ...rest] = segments;
  if (!IDENT.test(columnName)) throw new FilterError(`or() has an invalid column ${JSON.stringify(columnName)}`, 'BAD_COLUMN');

  // `in` may carry its list in parentheses, which splitTopLevel only un-nests
  // at the top level: re-join the remainder for every other operator, because
  // a value may legitimately contain dots (a timestamp, a dotted e-mail).
  let op = opName.trim().toLowerCase();
  let value;
  if (op === 'in' || op === 'not.in') {
    value = rest.join('.');
  } else {
    value = rest.length === 1 ? rest[0] : rest.join('.');
  }
  if (op === 'is' && value === undefined) value = 'null';
  if (value === undefined) throw new FilterError(`or() term ${JSON.stringify(term)} has no value`, 'BAD_FILTER');
  return compileFilter(table, columnName, { op, value: unquoteLiteral(value) });
}

function compileAndGroup(table, inner) {
  const terms = splitTopLevel(inner, ',');
  const parts = terms.map((term) => compileOrTerm(table, term.trim()));
  return combineAnd(parts);
}

// combineAnd / combineOr: join compiled parts and renumber their parameters so
// the result has one contiguous $1..$n sequence.
export function combineAnd(parts) {
  return joinParts(parts, ' and ');
}
export function combineOr(parts) {
  return joinParts(parts, ' or ');
}

function joinParts(parts, joiner) {
  const sql = [];
  const params = [];
  for (const part of parts) {
    if (!part || part.sql === undefined) continue;
    // Each fragment was compiled on its own and numbers its parameters $1..$n;
    // the combined expression shares one parameter list, so every fragment is
    // renumbered to continue where the previous one stopped.
    const shifted = rebase(part, params.length);
    sql.push(`(${shifted.sql})`);
    params.push(...shifted.params);
  }
  if (sql.length === 0) return null;
  // A lone fragment needs no wrapper of its own; joined fragments KEEP theirs,
  // because dropping the parentheses around an `and(...)` group inside an or()
  // would silently change the operator precedence the caller asked for.
  if (sql.length === 1) return { sql: sql[0].slice(1, -1), params };
  return { sql: sql.join(joiner), params };
}

// rebase(fragment, offset): a compiled {sql, params} with $1..$n shifted to
// start at `offset + 1`. This is how the route ANDs a policy predicate, a
// filter expression and the order/limit parameters into one statement.
export function rebase(fragment, offset) {
  if (!fragment || offset <= 0) return fragment;
  return {
    sql: fragment.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + offset}`),
    params: fragment.params,
  };
}

export default compileFilters;
