// api/routes/query.mjs — POST /api/query: one endpoint for select/insert/
// update/delete/upsert (task t7).
//
// This is the data path the browser shim (task t8) talks to, and the reason
// 12 files can keep `import { supabase } from '@/integrations/supabase/client'`
// unchanged: a supabase-js chain call is a request for a PostgREST operation,
// and this route implements that operation against the local PostgreSQL.
//
//   POST /api/query   Authorization: Bearer <session>       (absent only for the
//                     two shapes on api/lib/authorization.mjs's allow-list)
//   { "table": "invoices",
//     "select": "id, total, appointment:appointments(...), invoice_items(...)",
//     "filters": { "status": { "op": "eq", "value": "issued" } },
//     "or": "status.eq.issued,status.eq.overdue",
//     "order": [{ "column": "created_at", "ascending": false }],
//     "limit": 50, "offset": 0,
//     "verb": "select|insert|update|delete|upsert",
//     "payload": {...} | [...], "onConflict": "appointment_id",
//     "single": true, "maybeSingle": true }
//
//   200  {"data": rows|null, "error": null}
//   200  {"data": null, "error": {"code":"PGRST116", ...}}  a single() that found
//                                                            no row, as PostgREST
//   400  {"error":{"code":"BAD_COLUMN"|"BAD_VALUE"|"BAD_SELECT"|...,...}}
//   401  {"error":{"code":"UNAUTHORIZED",...}}   no session and not allow-listed
//   403  {"error":{"code":"FORBIDDEN",...}}      the ported policy denies it
//
// Order of decisions, and why:
//   1. shape of the request (400) — a malformed body is refused before anything
//      else, so the API never reasons about nonsense;
//   2. session (401) — an anonymous caller is answered before the schema is even
//      consulted, so the existence of a table is not disclosed to the internet
//      and the two allow-listed shapes are the only ones that get further;
//   3. identifiers (400 BAD_COLUMN) — table, columns, order columns and payload
//      keys are looked up in api/lib/catalog.mjs; an unknown name is a bad
//      request, and no SQL has been built yet, so nothing executed (W26);
//   4. role and row policy (403) — api/lib/authorization.mjs;
//   5. one transaction, which is what makes a WITH CHECK failure able to undo
//      the statement it rejects.
//
// How a select becomes SQL: the validated select tree is compiled into one
// json_build_object over the root row, with each embedded resource as a
// correlated subquery — a to-one `(select json_build_object(...) from ... limit 1)`
// (NULL when there is no related row, which is what W25's `appointment: null`
// needs) and a to-many `coalesce(json_agg(...), '[]')`. That is the same
// technique PostgREST uses, so the nested shapes and the value types (numeric ->
// JSON number, timestamptz -> string, jsonb -> object, boolean -> boolean) match
// what the pages read today without any post-processing in this file.
//
// Why the mutations answer 403 and not a silent no-op: RLS makes a filtered-away
// row invisible, so supabase-js sees "0 rows" for a write the policy denied.
// A page would read that as success. Where a row matched the caller's filters
// but the policy predicate hid it, this route answers 403 and rolls the
// statement back (W27's staff payment delete).

import express from 'express';

import { query, tx } from '../db.mjs';
import { allColumns, getCatalog, getColumn, getTable, hasTable, quoteIdent, relationship, coerceIn, CoerceError } from '../lib/catalog.mjs';
import { anonAllow, can, denyReason, readPredicate, renumber } from '../lib/authorization.mjs';
import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { combineAnd, compileFilters, FilterError } from '../lib/filters.mjs';
import { MAX_DEPTH, parseSelect, SpecError } from '../lib/sql-spec.mjs';
import { requireOptionalAuth } from '../lib/session.mjs';
import { AUDITED_WRITE_TABLES, auditMany, clientIp } from '../lib/audit.mjs';

// What a caller may ask for, and how much of it. MAX_ROWS mirrors the hosted
// PostgREST row cap, so a page that silently relied on "all rows" sees the same
// ceiling it has today.
const VERBS = new Set(['select', 'insert', 'update', 'delete', 'upsert']);
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

// The casts a select string may request (`total::float`). A fixed allow-list, so
// the text after `::` can never be anything but a type name.
const CASTS = new Map([
  ['text', 'text'], ['uuid', 'uuid'], ['int', 'integer'], ['integer', 'integer'],
  ['bigint', 'bigint'], ['numeric', 'numeric'], ['float', 'double precision'],
  ['double precision', 'double precision'], ['boolean', 'boolean'], ['date', 'date'],
  ['timestamptz', 'timestamp with time zone'], ['timestamp', 'timestamp without time zone'],
  ['json', 'json'], ['jsonb', 'jsonb'],
]);

// --- error plumbing ---------------------------------------------------------

// A 400 in the shared envelope.
function badRequest(message, code = 'BAD_REQUEST') {
  const err = new ApiError(400, message, code);
  return err;
}

// The route's own faults (bad select string, bad filter, bad literal) are 400s
// with the code the module chose; nothing else here is allowed to reach the
// caller verbatim.
function mapError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof SpecError) return badRequest(err.message, 'BAD_SELECT');
  if (err instanceof FilterError) return badRequest(err.message, err.code === 'BAD_COLUMN' ? 'BAD_COLUMN' : err.code === 'BAD_VALUE' ? 'BAD_VALUE' : 'BAD_FILTER');
  if (err instanceof CoerceError) return badRequest(err.message, 'BAD_VALUE');
  const constraint = mapConstraintError(err);
  if (constraint) return constraint;
  return err; // a real fault: the shared handler answers 500 and logs it
}

// Constraint violations are the caller's data problem, not the API's: the
// hosted PostgREST answers them with 4xx and a named code (FKViolation,
// 42P01-style unique -> 409). Mapping them here keeps the envelope honest —
// the page sees a rejection it can show the user, and the transaction has
// already rolled back, so nothing half-wrote.
function mapConstraintError(err) {
  switch (err && err.code) {
    case '23503':
      return badRequest(err.detail ? `foreign key violation: ${err.detail}` : 'foreign key violation', 'FOREIGN_KEY_VIOLATION');
    case '23505':
      return new ApiError(409, err.detail ? `duplicate key value: ${err.detail}` : 'duplicate key value', 'CONFLICT');
    case '23502':
      return badRequest(err.column ? `a value is required for ${JSON.stringify(err.column)} and was not provided` : 'a required value was not provided', 'NOT_NULL_VIOLATION');
    case '23514':
      return badRequest('the row violates a constraint of the table', 'CHECK_VIOLATION');
    default:
      return null;
  }
}

// --- projection: the validated select tree -> json_build_object --------------

// ref(alias, column): a quoted identifier pair. Both sides are validated names.
function ref(alias, column) {
  return `${quoteIdent(alias)}.${quoteIdent(column)}`;
}

// sqlLiteral(text): a SQL string literal. json_build_object's KEYS must be
// string literals — a double-quoted "name" would be an identifier and Postgres
// would evaluate the column and use its VALUE as the JSON key. Column names are
// already validated identifiers, so the quote-doubling is defence in depth.
function sqlLiteral(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

// buildObject(catalog, table, alias, tree): {sql} for one level of the tree.
// `alias` is how the row is named in the enclosing statement (the table's own
// name at the root, the embed's alias inside a subquery).
function buildObject(catalog, table, alias, tree) {
  const parts = [];
  for (const node of tree.fields) {
    if (node.kind === 'all') {
      for (const column of allColumns(table)) {
        parts.push(`${sqlLiteral(column.name)}, ${ref(alias, column.name)}`);
      }
      continue;
    }
    if (node.kind === 'field') {
      const column = table.columns.get(node.column);
      if (!column) throw badRequest(`no column ${JSON.stringify(node.column)} on table ${JSON.stringify(table.name)}`, 'BAD_COLUMN');
      let value = ref(alias, column.name);
      if (node.cast) {
        const type = CASTS.get(node.cast.toLowerCase());
        if (!type) throw new SpecError(`unsupported cast ${JSON.stringify(node.cast)}`);
        value = `(${value})::${type}`;
      }
      parts.push(`${sqlLiteral(node.alias)}, ${value}`);
      continue;
    }
    parts.push(`${sqlLiteral(node.alias)}, ${buildEmbed(catalog, table, alias, node)}`);
  }
  if (parts.length === 0) throw new SpecError('the select list has no fields');
  return { sql: `json_build_object(${parts.join(', ')})` };
}

// buildEmbed: a correlated subquery reproducing PostgREST's embedded resource.
function buildEmbed(catalog, parent, parentAlias, node) {
  const child = getTable(catalog, node.table);
  if (!child) throw badRequest(`no table ${JSON.stringify(node.table)} to embed`, 'BAD_COLUMN');
  if (node.alias === parentAlias) {
    throw new SpecError(`the embedded alias ${JSON.stringify(node.alias)} collides with its parent`);
  }
  const link = relationship(catalog, parent.name, node.table);
  if (!link) {
    throw badRequest(
      `there is no foreign key between ${JSON.stringify(parent.name)} and ${JSON.stringify(node.table)}, so ${JSON.stringify(node.alias)} cannot be embedded`,
      'BAD_RELATION'
    );
  }
  const inner = buildObject(catalog, child, node.alias, node.children);
  // relationship() returns localColumn = the column on THIS table (the parent)
  // and foreignColumn = the column on the embedded table, for both directions.
  const condition = `${ref(parentAlias, link.localColumn)} = ${ref(node.alias, link.foreignColumn)}`;
  const from = `from ${quoteIdent('public')}.${quoteIdent(node.table)} as ${quoteIdent(node.alias)}`;

  if (link.direction === 'toMany') {
    // PostgREST hands an array here, [] when nothing matches — coalesce keeps
    // that, and the order by makes the array stable across requests.
    const orderColumn = child.primaryKey[0] ?? child.columnNames[0];
    const ordered = `select ${inner.sql} as "hh_item" ${from} where ${condition} order by ${ref(node.alias, orderColumn)}`;
    return `coalesce((select json_agg("hh_item") from (${ordered}) as "hh_items"), '[]'::json)`;
  }
  // to-one: the subquery yields NULL when the link points at nothing, which is
  // the `appointment: null` the Billing page already handles (W25).
  return `(select ${inner.sql} ${from} where ${condition} limit 1)`;
}

// projectionSql(catalog, table, tree): the json expression for the root, with
// the root row named after its own table — the name api/lib/authorization.mjs's
// predicates use, so one statement carries both.
function projectionSql(catalog, table, tree) {
  return buildObject(catalog, table, table.name, tree).sql;
}

// validateTree: every identifier the select list names, checked against the
// catalog before role policy is consulted or any SQL is built (step 3 of the
// order in the header). A `foo:bar(...)` whose two tables have no foreign key
// is rejected here too, so the projection can assume every embed has a real
// link and every column exists at every level. The depth cap matches
// api/lib/sql-spec.mjs's MAX_DEPTH — the same "deeper than this means the
// string is not what we think it is" rule walk() enforces.
function validateTree(catalog, table, tree, depth = 0) {
  for (const node of tree.fields) {
    if (node.kind === 'all') continue;
    if (node.kind === 'field') {
      if (!table.columns.has(node.column)) {
        throw badRequest(`no column ${JSON.stringify(node.column)} on table ${JSON.stringify(table.name)}`, 'BAD_COLUMN');
      }
      continue;
    }
    if (!hasTable(catalog, node.table)) {
      throw badRequest(`no table ${JSON.stringify(node.table)} to embed`, 'BAD_COLUMN');
    }
    if (!relationship(catalog, table.name, node.table)) {
      throw badRequest(
        `there is no foreign key between ${JSON.stringify(table.name)} and ${JSON.stringify(node.table)}, so ${JSON.stringify(node.alias)} cannot be embedded`,
        'BAD_RELATION'
      );
    }
    if (depth >= MAX_DEPTH) {
      throw new SpecError(`embedded resources may be nested ${MAX_DEPTH} levels deep at most (found one deeper under ${JSON.stringify(node.alias)})`);
    }
    validateTree(catalog, getTable(catalog, node.table), node.children, depth + 1);
  }
}

// --- request validation ------------------------------------------------------

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${name} must be a non-empty string`, 'BAD_REQUEST');
  }
  return value.trim();
}

function positiveInt(value, name, { max, dflt } = {}) {
  if (value === undefined || value === null) return dflt;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) {
    throw badRequest(`${name} must be an integer between 0 and ${max ?? 'unbounded'}, got ${JSON.stringify(value)}`, 'BAD_REQUEST');
  }
  return n;
}

// validateOrder: order columns are identifiers of the queried table, and the
// direction is a boolean — that is all a caller may choose.
function compileOrder(catalog, table, order) {
  if (order === undefined || order === null) return null;
  const list = Array.isArray(order) ? order : [order];
  const parts = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      throw badRequest('order must be [{column, ascending}]', 'BAD_REQUEST');
    }
    const column = entry.column ?? entry.field;
    if (typeof column !== 'string' || !table.columns.has(column)) {
      throw badRequest(`no column ${JSON.stringify(column)} on table ${JSON.stringify(table.name)} to order by`, 'BAD_COLUMN');
    }
    const ascending = entry.ascending === undefined || entry.ascending === null ? true : entry.ascending === true;
    // `nullsFirst` is the one PostgREST order modifier the pages use; the
    // direction of the NULLs is chosen from a fixed pair, never interpolated.
    const nulls = entry.nullsFirst === true ? ' nulls first' : entry.nullsFirst === false ? ' nulls last' : '';
    parts.push(`${ref(table.name, column)} ${ascending ? 'asc' : 'desc'}${nulls}`);
  }
  return parts.length ? parts.join(', ') : null;
}

// payloadColumns(table, payload): the payload's keys validated as columns, and
// its values coerced to the JS form the driver binds. An unknown key is the
// same 400 as an unknown column: a page that typos a field must hear about it.
function payloadColumns(catalog, table, payload, { allowMany }) {
  const rows = Array.isArray(payload) ? payload : [payload];
  if (rows.length === 0) throw badRequest('payload must hold at least one row', 'BAD_REQUEST');
  if (!allowMany && rows.length !== 1) throw badRequest('this verb takes exactly one payload row', 'BAD_REQUEST');
  const columns = new Map(); // column name -> coerced values, one per row
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw badRequest('payload rows must be objects', 'BAD_REQUEST');
    }
    const keys = Object.keys(row);
    if (keys.length === 0) throw badRequest('payload rows must set at least one column', 'BAD_REQUEST');
    for (const key of keys) {
      const column = getColumn(catalog, table.name, key);
      if (!column) throw badRequest(`no column ${JSON.stringify(key)} on table ${JSON.stringify(table.name)}`, 'BAD_COLUMN');
      if (!columns.has(key)) columns.set(key, []);
      try {
        columns.get(key).push(coerceIn(column, row[key], { label: `${table.name}.${key}` }));
      } catch (e) {
        if (e instanceof CoerceError) throw badRequest(e.message, 'BAD_VALUE');
        throw e;
      }
    }
  }
  // every row must set the same columns, or the VALUES list is ragged
  const names = [...columns.keys()];
  for (const values of columns.values()) {
    if (values.length !== rows.length) {
      throw badRequest('every payload row must set the same columns', 'BAD_REQUEST');
    }
  }
  return { names, rows, columns };
}

// onConflictColumns(catalog, table, onConflict): the conflict target of an
// upsert, validated against the table's real unique/primary keys — a caller
// cannot name an arbitrary column and get an ON CONFLICT that Postgres rejects.
function onConflictColumns(catalog, table, onConflict, payloadNames) {
  if (onConflict === undefined || onConflict === null || onConflict === '') {
    // PostgREST's default conflict target is the primary key.
    if (table.primaryKey.length === 0) throw badRequest(`${table.name} has no primary key: pass onConflict`, 'BAD_REQUEST');
    return table.primaryKey;
  }
  const requested = String(onConflict).split(',').map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) throw badRequest('onConflict must name at least one column', 'BAD_REQUEST');
  for (const name of requested) {
    if (!table.columns.has(name)) throw badRequest(`no column ${JSON.stringify(name)} on table ${JSON.stringify(table.name)}`, 'BAD_COLUMN');
  }
  const match = table.uniqueKeys.find((cols) => cols.length === requested.length && cols.every((c, i) => c === requested[i]));
  if (!match) {
    throw badRequest(
      `${table.name} has no unique constraint on (${requested.join(', ')}); its conflict targets are ${table.uniqueKeys.map((c) => `(${c.join(', ')})`).join(' or ')}`,
      'BAD_CONFLICT'
    );
  }
  return requested;
}

// --- statements --------------------------------------------------------------

// selectStatement: the plain read, with the policy predicate ANDed with the
// caller's filters.
function selectStatement({ catalog, table, tree, where, orderBy, limit, offset }) {
  // `where` is null when the policy narrows nothing and the caller filtered
  // nothing either — the plain "read the whole allow-listed table" case.
  const params = [...(where ? where.params : [])];
  const sql = [`select ${projectionSql(catalog, table, tree)} as "hh_row"`, `from ${quoteIdent('public')}.${quoteIdent(table.name)} as ${quoteIdent(table.name)}`];
  if (where && where.sql) sql.push(`where ${where.sql}`);
  if (orderBy) sql.push(`order by ${orderBy}`);
  if (limit !== undefined && limit !== null) {
    params.push(limit);
    sql.push(`limit $${params.length}`);
  }
  if (offset !== undefined && offset !== null && offset > 0) {
    params.push(offset);
    sql.push(`offset $${params.length}`);
  }
  return { text: sql.join('\n'), params };
}

// --- the handler -------------------------------------------------------------

export async function handleQuery(req, res) {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('a JSON object body is required', 'BAD_REQUEST');
  }

  // 1. shape
  const table = requireString(body.table, 'table');
  const verb = body.verb === undefined || body.verb === null ? 'select' : String(body.verb).trim().toLowerCase();
  if (!VERBS.has(verb)) throw badRequest(`verb must be one of ${[...VERBS].join(', ')}, got ${JSON.stringify(body.verb)}`, 'BAD_REQUEST');
  // upsert is PostgREST's dialect of insert — a merge POST ran the INSERT
  // policy's WITH CHECK on the hosted project — so the role and row policy of
  // an upsert is the insert policy, verbatim.
  const policyVerb = verb === 'upsert' ? 'insert' : verb;
  const single = body.single === true;
  const maybeSingle = body.maybeSingle === true;
  const limit = positiveInt(body.limit, 'limit', { max: MAX_LIMIT, dflt: verb === 'select' ? DEFAULT_LIMIT : undefined });
  const offset = positiveInt(body.offset, 'offset', { dflt: 0 }) ?? 0;

  // 2. session
  const user = req.user ?? null; // requireOptionalAuth: the session, or null
  if (!user && !anonAllow(table, verb)) {
    if (req.authError) throw req.authError;
    throw new ApiError(401, 'A session is required: send Authorization: Bearer <token>', 'UNAUTHORIZED');
  }

  const catalog = await getCatalog();

  // 3. identifiers: the table first, then everything that names a column.
  //    Nothing has been built yet, so a rejection here cannot have executed.
  if (!hasTable(catalog, table)) {
    throw badRequest(`no table ${JSON.stringify(table)} in this database`, 'BAD_COLUMN');
  }
  const meta = getTable(catalog, table);

  //    the select list, parsed then validated against the catalog, and with the
  //    relationship of every embed resolved (a `foo:bar(...)` with no foreign
  //    key between the two tables is a bad request, not a cartesian product).
  let tree;
  try {
    tree = parseSelect(body.select);
    validateTree(catalog, meta, tree);
  } catch (err) {
    throw mapError(err);
  }

  // 4. role and row policy
  if (user && !can(user, table, policyVerb)) {
    throw new ApiError(403, denyReason(user, table, policyVerb), 'FORBIDDEN');
  }
  // user_roles is the one table a session may only see its own rows; everything
  // else a session reaches is role-gated, and the anonymous shapes carry their
  // own predicate. The caller's filters are ANDed with the policy, never
  // allowed to replace it.
  const policyUsing = readPredicate(user, table, policyVerb, { alias: table, when: 'using' });
  const policyCheck = readPredicate(user, table, policyVerb, { alias: table, when: 'check' });

  // 5. the caller's own filters (compiled after validation so a bad literal is
  //    reported before any statement is built)
  let filterWhere = null;
  try {
    filterWhere = compileFilters(meta, { filters: body.filters, or: body.or });
  } catch (err) {
    throw mapError(err);
  }

  const orderBy = compileOrder(catalog, meta, body.order);

  if (verb === 'select') {
    const where = combineAnd([policyUsing, filterWhere]);
    const statement = selectStatement({ catalog, table: meta, tree, where, orderBy, limit, offset });
    const { rows } = await query(statement.text, statement.params);
    if (user && rows.length) {
      await auditRead({ req, user, table, tree, body, where, orderBy, limit, offset, meta, count: rows.length });
    }
    return sendJson(res, 200, shape(await rowsOf(rows), { single, maybeSingle }));
  }

  // writes: one transaction, and the policy's WITH CHECK applied to the rows
  // the statement wrote (see the header).
  const payload = verb === 'delete' ? null : body.payload;
  let prepared = null;
  if (verb !== 'delete') {
    try {
      prepared = payloadColumns(catalog, meta, payload, { allowMany: verb === 'insert' || verb === 'upsert' });
    } catch (err) {
      throw mapError(err);
    }
  }
  const onConflict = verb === 'upsert' && prepared ? onConflictColumns(catalog, meta, body.onConflict, prepared.names) : null;
  if (verb === 'update' && prepared && prepared.names.length === 0) {
    throw badRequest('an update must set at least one column', 'BAD_REQUEST');
  }

  const where = combineAnd([policyUsing, filterWhere]);

  // A write that a policy predicate narrows must say 403 when the caller's
  // filters did match rows, or "you may not touch that row" would look like
  // "there was nothing to do". The pre-count uses the caller's filters alone.
  const guarded = Boolean(policyUsing && policyUsing.sql);
  const result = await tx(async (client) => {
    let matched = null;
    if (guarded) {
      const pre = await client.query(countStatement(meta, filterWhere), [...(filterWhere?.params ?? [])]);
      matched = Number(pre.rows[0]?.n ?? 0);
    }
    const written = await writeStatement(client, { catalog, table: meta, tree, verb, where, filterWhere, prepared, onConflict, policyCheck });
    if (guarded && written.rows.length === 0 && (matched === null || matched > 0)) {
      throw new ApiError(403, denyReason(user, table, policyVerb), 'FORBIDDEN');
    }
    if (written.denied > 0) {
      // The row the caller asked for is outside what the policy permits — the
      // same thing a WITH CHECK violation means in Postgres.
      throw new ApiError(403, denyReason(user, table, policyVerb), 'FORBIDDEN');
    }
    // The audit row is written in the same transaction as the change: a write
    // that is not audited does not happen.
    const entityType = AUDITED_WRITE_TABLES[table];
    if (entityType && written.ids.length) {
      const action = verb === 'delete' ? 'delete' : verb === 'update' ? 'update' : 'create';
      const summary = verb === 'delete' ? null : { fields: prepared?.names ?? [], ...(verb === 'upsert' ? { upsert: true } : {}) };
      await auditMany({ db: client, user, action, entityType, ids: written.ids, ip: clientIp(req), summary });
    }
    return written.rows;
  });

  return sendJson(res, 200, shape(result, { single, maybeSingle }));
}

// rowsOf: the projection column unwrapped, in statement order.
async function rowsOf(rows) {
  return rows.map((row) => row.hh_row);
}

// shape: the {data, error} envelope. `single`/`maybeSingle` follow PostgREST:
// a single() with nothing (or more than one) behind it is an error, a
// maybeSingle() with nothing is a null row.
function shape(rows, { single, maybeSingle }) {
  if (single) {
    if (rows.length !== 1) {
      return {
        data: null,
        error: {
          code: 'PGRST116',
          message: rows.length === 0
            ? 'JSON object requested, multiple (or no) rows returned: no row matched'
            : `JSON object requested, multiple (or no) rows returned: ${rows.length} rows matched`,
        },
      };
    }
    return { data: rows[0], error: null };
  }
  if (maybeSingle) {
    if (rows.length > 1) {
      return { data: null, error: { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned: ${rows.length} rows matched` } };
    }
    return { data: rows.length === 1 ? rows[0] : null, error: null };
  }
  return { data: rows, error: null };
}

function countStatement(table, filterWhere) {
  const from = `from ${quoteIdent('public')}.${quoteIdent(table.name)} as ${quoteIdent(table.name)}`;
  return `select count(*)::int as n ${from}${filterWhere && filterWhere.sql ? `\n where ${filterWhere.sql}` : ''}`;
}

// writeStatement: the write, its WITH CHECK, and its projection — one statement.
//
//   with "hh_written" as (<dml> returning *),
//        "hh_denied"   as (select count(*)::int as n from "hh_written" as "<table>"
//                           where not (<policy WITH CHECK>)),
//        "hh_rows"     as (select <projection> as hh_row from "hh_written" as "<table>")
//   select (select coalesce(max(n), 0) from "hh_denied") as "hh_denied",
//          coalesce((select json_agg(hh_row) from "hh_rows"), '[]'::json) as "hh_rows"
//
// The CTE is aliased as the table's own name so the policy fragment — which
// refers to "invoices"."appointment_id" and the like — reads the row the caller
// actually tried to write, defaults included.
async function writeStatement(client, { catalog, table, tree, verb, where, filterWhere, prepared, onConflict, policyCheck }) {
  const alias = table.name;
  const target = `${quoteIdent('public')}.${quoteIdent(table.name)}`;
  const params = [];

  let dml;
  if (verb === 'delete') {
    dml = `delete from ${target} as ${quoteIdent(alias)}`;
  } else if (verb === 'update') {
    const sets = prepared.names.map((name) => {
      params.push(prepared.columns.get(name)[0]);
      return `${quoteIdent(name)} = $${params.length}`;
    });
    dml = `update ${target} as ${quoteIdent(alias)}\n set ${sets.join(', ')}`;
  } else {
    const { names, columns } = prepared;
    const tuples = prepared.rows.map((_row, rowIndex) => {
      const values = names.map((name) => {
        params.push(columns.get(name)[rowIndex]);
        return `$${params.length}`;
      });
      return `(${values.join(', ')})`;
    });
    dml = `insert into ${target} (${names.map(quoteIdent).join(', ')})\n values ${tuples.join(',\n ')}`;
    if (verb === 'upsert') {
      const conflict = onConflict.map(quoteIdent).join(', ');
      const updates = names
        .filter((name) => !onConflict.includes(name))
        .map((name) => `${quoteIdent(name)} = ${quoteIdent('excluded')}.${quoteIdent(name)}`);
      dml += updates.length
        ? `\n on conflict (${conflict}) do update set ${updates.join(', ')}`
        : `\n on conflict (${conflict}) do nothing`;
    }
  }

  // The write sees the caller's filters and the policy's USING clause. Insert
  // and upsert have no existing rows to scope, so only WITH CHECK applies.
  // The payload's placeholders were numbered $1..$p while building the DML, so
  // the WHERE fragment — compiled on its own, from $1 — is rebased to start
  // after them, and the statement's parameter list is payload, filter, check.
  const scoped = verb === 'insert' || verb === 'upsert' ? filterWhere : where;
  const whereFragment = scoped && scoped.sql ? renumber(scoped, params.length) : null;
  dml += whereFragment ? `\n where ${whereFragment.sql}` : '';
  const statementParams = [...params, ...(whereFragment ? whereFragment.params : [])];

  const ctes = [`"hh_written" as (${dml}\n returning *)`];
  if (policyCheck && policyCheck.sql) {
    const check = renumber(policyCheck, statementParams.length);
    ctes.push(`"hh_denied" as (select count(*)::int as n from "hh_written" as ${quoteIdent(alias)} where not (${check.sql}))`);
    statementParams.push(...check.params);
  }
  ctes.push(`"hh_rows" as (select ${projectionSql(catalog, table, tree)} as "hh_row" from "hh_written" as ${quoteIdent(alias)})`);
  const hasId = table.columns.has('id');

  // With no WITH CHECK fragment there is no "hh_denied" CTE, and the answer is
  // a compile-time zero.
  const deniedExpr = policyCheck && policyCheck.sql
    ? `(select coalesce(max(n), 0) from "hh_denied")`
    : `0::int`;
  const text = `with ${ctes.join(',\n')}\n` +
    `select ${deniedExpr} as "hh_denied",\n` +
    `       coalesce((select json_agg("hh_row") from "hh_rows"), '[]'::json) as "hh_rows"` +
    (hasId ? `,\n       coalesce((select json_agg("id") from "hh_written"), '[]'::json) as "hh_ids"` : '');
  const result = await client.query(text, statementParams);
  const row = result.rows[0] ?? {};
  return {
    denied: Number(row.hh_denied ?? 0),
    rows: Array.isArray(row.hh_rows) ? row.hh_rows : [],
    ids: Array.isArray(row.hh_ids) ? row.hh_ids : [],
  };
}

// --- audited reads -----------------------------------------------------------
//
// Opening an individual patient record, a visit note or an appointment's
// intake notes is recorded in the audit log ('view'). List screens that only
// show names are not logged row by row (that would bury the log); a read is
// "individual" when it asks for one row (single/maybeSingle) or filters on the
// id. Clinical notes are logged whenever they are read.

function treeHasColumn(tree, column) {
  return tree.fields.some((n) => n.kind === 'all' || (n.kind === 'field' && n.column === column));
}

function treeEmbeds(tree, table) {
  return tree.fields.some((n) => n.kind !== 'all' && n.kind !== 'field' && (n.table === table || treeEmbeds(n.children, table)));
}

function filtersOnId(body) {
  const f = body.filters;
  if (!f || typeof f !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(f, 'id');
}

export async function auditRead({ req, user, table, tree, body, where, orderBy, limit, offset, meta, count }) {
  const individual = body.single === true || body.maybeSingle === true || filtersOnId(body);
  const targets = [];
  if (table === 'patients' && individual) targets.push({ entityType: 'patient', summary: null });
  if (table === 'visit_notes') targets.push({ entityType: 'visit_note', summary: null });
  if (table === 'appointments' && treeHasColumn(tree, 'intake_notes') && count > 0) {
    targets.push({ entityType: 'intake_note', summary: individual ? null : { list: true } });
  }
  if (table === 'appointments' && treeEmbeds(tree, 'visit_notes')) {
    targets.push({ entityType: 'visit_note', summary: { via: 'appointments' } });
  }
  if (table === 'patients' && individual && treeEmbeds(tree, 'appointments')) {
    targets.push({ entityType: 'patient_history', summary: null });
  }
  if (!targets.length || !meta.columns.has('id')) return;
  // the ids of exactly the rows the caller received (same where/order/page)
  const params = [...(where ? where.params : [])];
  const sql = [`select ${quoteIdent(table)}.${quoteIdent('id')} as id from ${quoteIdent('public')}.${quoteIdent(table)} as ${quoteIdent(table)}`];
  if (where && where.sql) sql.push(`where ${where.sql}`);
  if (orderBy) sql.push(`order by ${orderBy}`);
  if (limit !== undefined && limit !== null) {
    params.push(limit);
    sql.push(`limit $${params.length}`);
  }
  if (offset) {
    params.push(offset);
    sql.push(`offset $${params.length}`);
  }
  const { rows } = await query(sql.join('\n'), params);
  const ids = rows.map((r) => r.id);
  for (const t of targets) {
    await auditMany({ user, action: 'view', entityType: t.entityType, ids, ip: clientIp(req), summary: t.summary, cap: 25 });
  }
}

// The router: one POST, behind requireOptionalAuth so a session is read when
// there is one and an anonymous request is answered by the route (which consults
// the allow-list) rather than by the session layer.
export function createQueryRouter() {
  const router = express.Router();
  router.use(requireOptionalAuth);
  router.post('/', asyncHandler(async (req, res) => {
    try {
      await handleQuery(req, res);
    } catch (err) {
      const mapped = mapError(err);
      if (res.headersSent) throw mapped;
      if (!res.headersSent) {
        const status = mapped instanceof ApiError ? mapped.status : 500;
        if (status >= 500) console.error(`query: ${mapped.stack ?? mapped}`);
        sendJson(res, status, {
          error: {
            code: mapped.code ?? (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
            message: status >= 500 ? 'Internal server error' : mapped.message,
          },
        });
      }
    }
  }));
  return router;
}

export const router = createQueryRouter();
export default createQueryRouter;
