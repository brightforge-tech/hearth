// api/routes/realtime.mjs — GET /api/realtime: the change feed as SSE (task t9).
//
// What this replaces: the hosted project's Realtime, which pushed
// `postgres_changes` events over a websocket to the channels in Queue.tsx,
// Billing.tsx, Visit.tsx and AdminSettings.tsx. Those pages still call
// `supabase.channel(...).on('postgres_changes', {table}, cb)`: the shim (task t8)
// turns that into one long-lived fetch of this route and reads `data:` lines.
//
//   GET /api/realtime?tables=invoices,payments&filter=payments:id=eq.<uuid>
//       Authorization: Bearer <session>            (required — 401 without one)
//       Accept: text/event-stream
//   ->  200 text/event-stream, then, in id order, one event per outbox row:
//         data:{"id":17,"table":"payments","action":"INSERT",
//               "record_id":"<uuid>","payload":{...the row...},"created_at":"…"}
//       and a ": ping" comment every 15 s so an idle stream survives a proxy
//       that closes quiet connections.
//       400 BAD_TABLE an unknown table (or no tables at all),
//       400 BAD_FILTER a filter the grammar does not allow,
//       401 no session / a forged one, 403 a session with no role.
//
// Where the events come from: public.hh_outbox (0007_outbox.sql), which an AFTER
// row trigger on each of the eight subscribed tables fills with
// {table_name, action, record_id, payload}. Polling that queue — rather than
// LISTEN/NOTIFY — is what makes delivery survive a reconnect: a listener that
// blips misses its notifications, while a queue is still there when the client
// comes back. The queue also gives a total order (its identity column), which is
// what the "per-connection id watermark" below is a watermark of.
//
// The watermark: each connection remembers the last outbox id it delivered and
// asks for `id > that`. A new stream starts at the queue's current high-water
// mark, because a page always fetches its data before it subscribes, so replaying
// a month of history would be noise (and a memory spike) — the initial fetch is
// the snapshot, the stream is the delta after it. A client that wants to resume
// where it left off passes `since=<id>`; missed rows come back in order.
//
// Authorization: the table allow-list is decided here, and the row scope comes
// from the same module the query API uses (api/lib/authorization.mjs, its
// streamPredicate). A staff session therefore does not get told about rows it
// could never read: for a table whose ported policy narrows staff (patients,
// visit_notes, invoices, payments, user_roles) each event is checked against
// that predicate as it is read out of the queue. The one widening: user_roles
// events reach an ADMIN in full, because the only page subscribed to it is
// AdminSettings' admin-only Users panel, which lists every user through the
// SECURITY DEFINER get_users_with_roles anyway — a self-scoped stream would
// leave that panel permanently stale. Deletes are the other caveat: the row is
// already gone, so the check is impossible and the event is dropped for a
// scoped caller rather than passed through on a guess.
//
// Tuning, both off by default and both read per stream: REALTIME_POLL_MS
// (default 250, how often the queue is drained) and REALTIME_PING_MS (default
// 15000, the heartbeat interval). The regression suite shortens them so it does
// not have to wait fifteen seconds for a comment line.

import express from 'express';

import { query } from '../db.mjs';
import { streamPredicate } from '../lib/authorization.mjs';
import { getCatalog, getTable, quoteIdent } from '../lib/catalog.mjs';
import { FilterError, combineAnd, compileFilters, rebase } from '../lib/filters.mjs';
import { ApiError, asyncHandler } from '../lib/http.mjs';
import { requireAuth } from '../lib/session.mjs';

// The eight tables the pages subscribe to. AdminSettings.tsx:145 is the reason
// user_roles is on the list: the admin Users panel refetches when a role grant
// changes, and a subscription that silently did nothing would look like a
// stale page rather than a missing table.
export const TABLE_ALLOW = Object.freeze([
  'appointments',
  'services',
  'invoices',
  'payments',
  'clinic_settings',
  'patients',
  'visit_notes',
  'user_roles',
]);

// One page's worth of events per poll: a burst (a bulk insert) drains over
// several polls instead of building one enormous response.
const BATCH_SIZE = 200;
const DEFAULT_POLL_MS = 250;
const DEFAULT_PING_MS = 15_000;
const MIN_POLL_MS = 50;
const MAX_BACKOFF_MS = 5_000;

// --- the request --------------------------------------------------------------

// parseTables(raw): tables=a,b (or repeated tables= params) -> the de-duplicated
// list, in the order the caller named them. Anything outside the allow-list is a
// 400 that says what is allowed: a typo in a page's channel setup should be
// visible, not a stream that quietly never fires.
function parseTables(raw) {
  const requested = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new ApiError(400, `tables= must name at least one of ${TABLE_ALLOW.join(', ')}`, 'BAD_TABLE');
  }
  const out = [];
  for (const table of requested) {
    if (!TABLE_ALLOW.includes(table)) {
      throw new ApiError(400, `this stream does not carry ${JSON.stringify(table)}; it carries ${TABLE_ALLOW.join(', ')}`, 'BAD_TABLE');
    }
    if (!out.includes(table)) out.push(table);
  }
  return out;
}

// parseFilters(raw, tables): each `filter` parameter is one PostgREST realtime
// filter, optionally table-qualified the way the shim sends them
// (`appointments:id=eq.<uuid>`). The column is validated against the catalog and
// the value is bound as a parameter by api/lib/filters.mjs — the same compiler
// the query API uses, so a realtime filter cannot mean anything a query filter
// could not.
//
// An unqualified filter applies to the one table it was asked for; naming it for
// a table outside this stream's list is a 400, because silently ignoring it
// would deliver events the caller filtered away.
function parseFilters(raw, tables, catalog) {
  const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  const byTable = new Map(tables.map((table) => [table, null]));
  for (const entry of entries) {
    const text = entry.trim();
    if (text === '') continue;

    let table = null;
    let expression = text;
    const colon = text.indexOf(':');
    const equals = text.indexOf('=');
    if (colon !== -1 && colon < equals) {
      table = text.slice(0, colon).trim();
      expression = text.slice(colon + 1).trim();
      if (!tables.includes(table)) {
        throw new ApiError(400, `the filter ${JSON.stringify(text)} names ${JSON.stringify(table)}, which this stream does not carry`, 'BAD_FILTER');
      }
    } else if (tables.length !== 1) {
      throw new ApiError(400, `the filter ${JSON.stringify(text)} must name its table, as "table:column=op.value"`, 'BAD_FILTER');
    } else {
      table = tables[0];
    }

    // column=op.value — the value may itself contain '=' (a timestamp), so only
    // the first two separators are taken as structure.
    const at = expression.indexOf('=');
    const dot = expression.indexOf('.', at + 1);
    if (at < 1 || dot < at) {
      throw new ApiError(400, `the filter ${JSON.stringify(text)} is not "column=op.value"`, 'BAD_FILTER');
    }
    const column = expression.slice(0, at).trim();
    const op = expression.slice(at + 1, dot).trim().toLowerCase();
    const value = expression.slice(dot + 1);
    if (value === '') {
      throw new ApiError(400, `the filter ${JSON.stringify(text)} has no value`, 'BAD_FILTER');
    }

    const meta = getTable(catalog, table);
    let compiled;
    try {
      compiled = compileFilters(meta, { filters: { [column]: { op, value } } });
    } catch (e) {
      if (e instanceof FilterError) throw new ApiError(400, e.message, e.code === 'BAD_COLUMN' ? 'BAD_COLUMN' : 'BAD_FILTER');
      throw e;
    }
    if (!compiled) throw new ApiError(400, `the filter ${JSON.stringify(text)} says nothing`, 'BAD_FILTER');
    byTable.set(table, byTable.get(table) ? combineAnd([byTable.get(table), compiled]) : compiled);
  }
  return byTable;
}

// parseSince(raw): the watermark to resume from, or null for "start now".
function parseSince(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^\d{1,19}$/.test(text)) {
    throw new ApiError(400, `since must be a non-negative integer outbox id, got ${JSON.stringify(raw)}`, 'BAD_REQUEST');
  }
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null; // an id past 2^53 cannot be a real watermark
}

// --- the statement ------------------------------------------------------------

// buildStatement: one drain of the queue.
//
// Per table there is one branch: the queue rows for that table, narrowed (a) by
// the caller's filter and (b) by the ported read policy for that table. Both are
// evaluated against the live row, joined on record_id — the queue is a log, so
// it does not carry the columns a predicate needs, and the row it names does.
//
// The policy check has one consequence worth stating: a row that is deleted
// between the event and this read is invisible to a scoped caller, so a scoped
// caller does not hear about deletes on a narrowed table. It refetches for any
// other event on that table anyway, and an unscoped caller (admin, or a table
// with no staff predicate) does get the delete.
function buildStatement(user, catalog, tables, filters, cursor, limit) {
  const params = [cursor];
  const branches = [];

  for (const table of tables) {
    params.push(table);
    let sql = `("o"."table_name" = $${params.length})`;

    const scoped = combineAnd([filters.get(table), streamPredicate(user, table, 'select', { alias: table })]);
    if (scoped) {
      const shifted = rebase(scoped, params.length);
      params.push(...shifted.params);
      sql += ` and exists (select 1 from public.${quoteIdent(table)} as ${quoteIdent(table)}
                            where ${quoteIdent(table)}.${quoteIdent('id')} = "o"."record_id"
                              and (${shifted.sql}))`;
    }
    branches.push(sql);
  }

  params.push(limit);
  return {
    text: `select "o"."id",
                  "o"."table_name" as "table",
                  "o"."action",
                  "o"."record_id",
                  "o"."payload",
                  "o"."created_at"
             from public.${quoteIdent('hh_outbox')} as "o"
            where "o"."id" > $1
              and (${branches.join(' or ')})
            order by "o"."id"
            limit $${params.length}`,
    params,
  };
}

async function highWaterMark() {
  const { rows } = await query('select coalesce(max("id"), 0)::bigint as "n" from public."hh_outbox"');
  return Number(rows[0]?.n ?? 0);
}

// --- the stream ---------------------------------------------------------------

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function handleStream(req, res, { env = process.env, log = console.error } = {}) {
  const catalog = await getCatalog();
  const tables = parseTables(req.query.tables);
  const filters = parseFilters(req.query.filter, tables, catalog);
  const since = parseSince(req.query.since);
  const pollMs = Math.max(MIN_POLL_MS, Number(env.REALTIME_POLL_MS) || DEFAULT_POLL_MS);
  const pingMs = Math.max(1000, Number(env.REALTIME_PING_MS) || DEFAULT_PING_MS);
  const statement = buildStatement(req.user, catalog, tables, filters, 0, BATCH_SIZE);

  let cursor = since !== null ? since : await highWaterMark();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer a stream
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  // Only the response is watched, deliberately: `res` 'close' means the client
  // is gone (or the response finished), which is exactly when this loop should
  // end. `req` 'close' fires for other reasons on some Node versions, and a
  // stream that stopped on one of those would look like a page that silently
  // stopped updating.
  res.on('close', stop);
  res.on('error', stop);

  // A browser's fetch() resolves as soon as the headers are flushed, and a
  // comment line says which stream it is attached to and where in the queue it
  // starts. Comments are ignored by EventSource, and the shim reads them for one
  // thing: the watermark. It keeps that number, so a reconnect — or the second
  // channel of a page sharing the stream — resumes from here with `since=`
  // instead of jumping to the queue's new high-water mark and losing whatever
  // changed while no stream was attached.
  let lastWrite = Date.now();
  const send = async (chunk) => {
    if (stopped || res.writableEnded || res.destroyed) return false;
    lastWrite = Date.now();
    if (res.write(chunk)) return true;
    // Backpressure: the client is not reading (a background tab, a slow link).
    // Wait for it instead of queueing events without bound.
    return new Promise((resolveSend) => {
      const done = (alive) => {
        res.removeListener('drain', onDrain);
        res.removeListener('close', onClose);
        resolveSend(alive);
      };
      const onDrain = () => done(true);
      const onClose = () => {
        stopped = true;
        done(false);
      };
      res.once('drain', onDrain);
      res.once('close', onClose);
    });
  };

  if (!(await send(`: realtime stream on ${tables.join(',')} cursor=${cursor}\n\n`))) return undefined;

  let failures = 0;
  while (!stopped && !res.writableEnded) {
    let rows = [];
    try {
      statement.params[0] = cursor;
      const result = await query(statement.text, statement.params);
      rows = result.rows;
      failures = 0;
    } catch (e) {
      // The database hiccuped. The client must not see a broken stream over it,
      // and must not be told nothing happened either, so the cause is logged and
      // the poll backs off. (A stream that cannot read the queue at all ends when
      // its client gives up, which is the only honest end it can have.)
      failures += 1;
      if (failures === 1 || failures % 20 === 0) {
        log(`realtime: draining hh_outbox failed (${failures} in a row): ${e.message}`);
      }
      await sleep(Math.min(pollMs * 2 ** Math.min(failures, 5), MAX_BACKOFF_MS));
      continue;
    }

    for (const row of rows) {
      cursor = Number(row.id);
      const event = {
        id: Number(row.id),
        table: row.table,
        action: row.action,
        record_id: row.record_id ?? null,
        payload: row.payload ?? null,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? null,
      };
      if (!(await send(`data: ${JSON.stringify(event)}\n\n`))) break;
    }

    if (stopped || res.writableEnded) break;

    // A full batch means there is probably more: go round again immediately, so
    // a burst drains as fast as the client will read it.
    if (rows.length === BATCH_SIZE) continue;

    if (Date.now() - lastWrite >= pingMs && !(await send(': ping\n\n'))) break;
    await sleep(pollMs);
  }

  return undefined;
}

// The router. GET only, and the guard is attached to that route rather than to
// the router, so an unimplemented verb under /api/realtime still reaches the
// API's JSON 404.
export function createRealtimeRouter({ env = process.env, log = console.error } = {}) {
  const router = express.Router();
  router.get('/', requireAuth, asyncHandler((req, res) => handleStream(req, res, { env, log })));
  return router;
}

export const router = createRealtimeRouter();
export default createRealtimeRouter;
