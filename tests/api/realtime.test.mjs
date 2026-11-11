// tests/api/realtime.test.mjs — GET /api/realtime: the SSE change feed (task t9).
//
// Like the query suite, every case runs the way the operator runs it: a real
// `node api/server.mjs` against a real PostgreSQL scratch database (created by
// the suite, migrated by the server's own start-up, dropped afterwards), driven
// over real HTTP. Here "driven over HTTP" includes one long-lived request per
// case: the stream itself, parsed with the same framing rules the browser shim
// (app/js/lib/supabase-shim.js) applies — blocks separated by a blank line,
// `data:` lines as JSON, `:` lines as comments.
//
// The events themselves come from public.hh_outbox (0007_outbox.sql): a row
// trigger on each of the eight subscribed tables writes one queue row per
// INSERT/UPDATE/DELETE. The cases below pin what the pages (Queue, Billing,
// Visit, AdminSettings) rely on:
//
//   * a session is required — 401 before a single table name is parsed;
//   * tables outside the eight, and malformed filters, are 400s that say so,
//     with the JSON envelope (not a stream);
//   * a write to a subscribed table reaches an open stream within a poll cycle,
//     in outbox order, across tables, carrying the row as its payload;
//   * a fresh stream does not replay history (it starts at the queue's
//     high-water mark), but `since=<id>` resumes exactly where a stream died;
//   * the row policy is honoured: staff never hear about rows they could never
//     read; user_roles stays self-scoped for staff, while an admin hears every
//     grant (the AdminSettings Users panel is admin-only and lists all users
//     through get_users_with_roles, so a self-scoped admin stream would leave
//     it stale); with the documented consequence that deletes on a scoped table
//     cannot be checked and are therefore not streamed to that caller;
//   * ": ping" comments keep an idle stream alive through a buffering proxy.
//
// The server for this suite starts with REALTIME_POLL_MS=100 (delivery check
// every 100 ms instead of 250) and REALTIME_PING_MS=1000 (the minimum the route
// allows) so the heartbeat case does not sit idle for fifteen seconds.

import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, sleep, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t9r';
const JWT_SECRET = 't9-realtime-suite-secret-0123456789abcdef';
const PATH = '/api/realtime';

// Fixed ids so every case can name the rows it means.
const ID = {
  admin: '00000000-0000-4000-9000-0000000000d1',
  staff: '00000000-0000-4000-9000-0000000000d2',
  roleless: '00000000-0000-4000-9000-0000000000d3',
  ada: '00000000-0000-4000-9000-000000000001',
  appt1: '00000000-0000-4000-9000-000000000002',
};

const FIXTURE = [
  `insert into public.app_users (id, email, password_hash) values
     ($1, 'admin@t9r.test', 'scrypt$t9r$fixture$not-a-real-hash'),
     ($2, 'staff@t9r.test', 'scrypt$t9r$fixture$not-a-real-hash'),
     ($3, 'roleless@t9r.test', 'scrypt$t9r$fixture$not-a-real-hash')`,
  [ID.admin, ID.staff, ID.roleless],

  `insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'user')`,
  [ID.admin, ID.staff],

  // Ada has an appointment, so staff's patients policy can see her; that is what
  // makes the row-scoping case two-sided (a visible row and an invisible one).
  `insert into public.patients (id, first_name, last_name, national_id) values
     ($1, 'Ada', 'Example', 'NID-T9R-ADA')`,
  [ID.ada],

  `insert into public.appointments (id, patient_id, scheduled_start, scheduled_end, duration_minutes, status, reason)
   values ($1, $2, '2026-03-01T10:00:00Z', '2026-03-01T10:30:00Z', 30, 'scheduled', 'annual checkup')`,
  [ID.appt1, ID.ada],
];

// --- scratch database + server, exactly as the query suite does it --------------

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function scratchDsn(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  return swapDb(testUrl, `${base}${SCRATCH}`);
}

function clientParams(url, database) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : '',
    database,
    connectionTimeoutMillis: 5000,
  };
}

async function withApi({ root, testUrl }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  {
    const admin = new pg.Client(clientParams(testUrl, 'postgres'));
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${scratch}" with (force)`);
      await admin.query(`create database "${scratch}"`);
    } finally {
      await admin.end();
    }
  }

  const handle = startServer({
    root,
    databaseUrl: dsn,
    env: { JWT_SECRET, REALTIME_POLL_MS: '100', REALTIME_PING_MS: '1000' },
  });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);

    const tokenFor = (which) =>
      signToken({ sub: ID[which], email: `${which}@t9r.test` }, { secret: JWT_SECRET });
    const tokens = { admin: tokenFor('admin'), staff: tokenFor('staff'), roleless: tokenFor('roleless') };

    const api = {
      db,
      tokens,
      port: handle.port,
      log: handle.log,
      async q(body, token = tokens.admin) {
        return request(handle.port, '/api/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
      },
      get(queryString, token) {
        return request(handle.port, `${PATH}?${queryString}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
      },
    };
    try {
      return await fn(api);
    } catch (e) {
      e.message += `\n--- server log ---\n${handle.log()}`;
      throw e;
    }
  } finally {
    try { await db.end(); } catch { /* already gone */ }
    await handle.stop();
    const admin = new pg.Client(clientParams(testUrl, 'postgres'));
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${scratch}" with (force)`);
    } finally {
      await admin.end();
    }
  }
}

// --- the SSE client -------------------------------------------------------------

// openStream(port, queryString, token) -> a live GET of the stream. Frames are
// split on the blank line the SSE spec uses; `data:` lines are parsed as JSON
// into `events`, comment lines into `comments`. The stream is open until close()
// — every case closes what it opens.
function openStream(port, queryString, token) {
  const events = [];
  const comments = [];
  const state = { status: null, headers: null, error: null };
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: `${PATH}?${queryString}`,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      timeout: 60_000,
    },
    (res) => {
      state.status = res.statusCode;
      state.headers = res.headers;
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()));
            else if (line.startsWith(':')) comments.push(line.slice(1).trim());
          }
        }
      });
      res.on('error', (e) => { state.error = e; });
    }
  );
  req.on('timeout', () => req.destroy(new Error('stream went idle past its timeout')));
  req.on('error', (e) => { state.error = e; });
  req.end();
  return {
    events,
    comments,
    state,
    /** ids delivered so far, in arrival order */
    ids: () => events.map((e) => e.id),
    close() {
      req.destroy();
    },
  };
}

async function until(cond, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(25);
  }
}

// The stream sends one comment frame as soon as it has taken its watermark;
// waiting for it is how a case synchronises "open now, insert after".
async function awaitOpen(stream) {
  await until(() => stream.comments.length > 0, 5000, 'the stream to open');
}

// --- tiny assertion helpers (same envelope contract as the query suite) ---------

function errorBody(res, status, code) {
  assert.equal(typeof res.json, 'object', `expected JSON, got ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(typeof res.json.error, 'object');
  assert.equal(res.json.error.code, code, `expected code ${code}, got ${JSON.stringify(res.json.error)}`);
  assert.ok(typeof res.json.error.message === 'string' && res.json.error.message.length > 0);
  return res.json.error;
}

const byTable = (stream, table) => stream.events.filter((e) => e.table === table);

// --- the cases -------------------------------------------------------------------

export default [
  {
    name: 'the stream needs a session: 401 before the tables are even parsed',
    fn: async (ctx) => withApi(ctx, async ({ get, tokens }) => {
      errorBody(await get('tables=patients', null), 401, 'UNAUTHORIZED');
      // a forged token is no caller at all
      errorBody(await get('tables=patients', 'not.a.token'), 401, 'UNAUTHORIZED');
      // a token signed with the wrong secret: same answer
      const forged = signToken({ sub: ID.admin, email: 'admin@t9r.test' }, { secret: 'a-different-secret-0123456789ab' });
      errorBody(await get('tables=patients', forged), 401, 'UNAUTHORIZED');
      // an account with no role is refused its own way: it has a valid session,
      // but nothing the feed could scope it to — the session layer answers 403
      errorBody(await get('tables=patients', tokens.roleless), 403, 'NO_ROLE');
      // auth comes first: an unauthenticated caller with a garbage table list
      // learns nothing about which tables exist
      errorBody(await get('tables=no_such_table', null), 401, 'UNAUTHORIZED');
    }),
  },
  {
    name: 'tables= must name the eight subscribed tables: 400 BAD_TABLE with the JSON envelope, not a stream',
    fn: async (ctx) => withApi(ctx, async ({ get, port, tokens }) => {
      const bad = errorBody(await get('tables=no_such_table', tokens.admin), 400, 'BAD_TABLE');
      assert.match(bad.message, /no_such_table/);
      // nothing at all is just as unusable
      errorBody(await get('tables=', tokens.admin), 400, 'BAD_TABLE');
      // and one good name does not smuggle a bad one in
      errorBody(await get('tables=invoices,no_such_table', tokens.admin), 400, 'BAD_TABLE');
      // the eight pages actually subscribe to are all accepted (headers flush,
      // the stream opens) — closed again immediately
      const stream = openStream(port, 'tables=appointments,services,invoices,payments,clinic_settings,patients,visit_notes,user_roles', tokens.admin);
      try {
        await awaitOpen(stream);
        assert.equal(stream.state.status, 200);
        assert.match(stream.state.headers['content-type'] ?? '', /^text\/event-stream/);
      } finally {
        stream.close();
      }
    }),
  },
  {
    name: 'filters and since are validated with the same care as the query API: 400s, not a silently wider stream',
    fn: async (ctx) => withApi(ctx, async ({ get, tokens }) => {
      // a bare filter cannot be aimed when the stream carries several tables
      const multi = errorBody(await get('tables=invoices,patients&filter=id=eq.1', tokens.admin), 400, 'BAD_FILTER');
      assert.match(multi.message, /must name its table/);
      // a filter aimed at a table this stream does not carry is refused, not ignored
      const stray = errorBody(await get(`tables=appointments&filter=invoices:id=eq.${ID.appt1}`, tokens.admin), 400, 'BAD_FILTER');
      assert.match(stray.message, /invoices/);
      // not "column=op.value" at all
      errorBody(await get('tables=appointments&filter=appointments:id', tokens.admin), 400, 'BAD_FILTER');
      // an empty value would silently become "id = ''", i.e. match nothing forever
      errorBody(await get('tables=appointments&filter=appointments:id=eq.', tokens.admin), 400, 'BAD_FILTER');
      // the column is checked against the real catalog, exactly like /api/query
      errorBody(await get('tables=appointments&filter=appointments:nope=eq.x', tokens.admin), 400, 'BAD_COLUMN');
      // since must be an outbox id
      errorBody(await get('tables=patients&since=abc', tokens.admin), 400, 'BAD_REQUEST');
      errorBody(await get('tables=patients&since=-5', tokens.admin), 400, 'BAD_REQUEST');
    }),
  },
  {
    name: 'an insert on a subscribed table reaches an open stream: table, action, record_id, the row as payload',
    fn: async (ctx) => withApi(ctx, async ({ db, port, tokens }) => {
      const stream = openStream(port, 'tables=patients', tokens.admin);
      try {
        await awaitOpen(stream);
        const ins = await db.query(
          `insert into public.patients (first_name, last_name, national_id)
           values ('Grace', 'Hopper', 'NID-T9R-GRACE') returning id`
        );
        await until(() => stream.events.length >= 1, 3000, 'the patients INSERT event');

        const event = stream.events[0];
        assert.equal(event.table, 'patients');
        assert.equal(event.action, 'INSERT');
        assert.equal(event.record_id, ins.rows[0].id);
        // the payload is the written row — what the shim hands to the page callback
        assert.equal(event.payload.first_name, 'Grace');
        assert.equal(event.payload.last_name, 'Hopper');
        assert.equal(typeof event.id, 'number');
        assert.ok(event.id > 0);
        assert.match(String(event.created_at), /^\d{4}-\d{2}-\d{2}T/); // ISO 8601, not a Date dump
      } finally {
        stream.close();
      }
    }),
  },
  {
    name: 'outbox order across tables; a fresh stream replays nothing, since=<id> replays exactly what was missed',
    fn: async (ctx) => withApi(ctx, async ({ db, port, tokens }) => {
      const stream = openStream(port, 'tables=patients,appointments', tokens.admin);
      try {
        await awaitOpen(stream);
        // two tables, written in a known order: the stream must keep the queue's order
        const p2 = await db.query(
          `insert into public.patients (first_name, last_name, national_id)
           values ('Alan', 'Turing', 'NID-T9R-ALAN') returning id`
        );
        const a2 = await db.query(
          `insert into public.appointments (patient_id, scheduled_start, scheduled_end, duration_minutes, status)
           values ($1, '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', 30, 'scheduled') returning id`,
          [p2.rows[0].id]
        );
        await until(() => stream.events.length >= 2, 3000, 'both events');

        const first = stream.events[0];
        const second = stream.events[1];
        assert.deepEqual([first.table, second.table], ['patients', 'appointments']);
        assert.equal(first.record_id, p2.rows[0].id);
        assert.equal(second.record_id, a2.rows[0].id);
        assert.ok(first.id < second.id, 'ids must be strictly increasing');
        const p2id = first.id;

        // a reconnect with no since starts at the queue head, not at history:
        // the pages fetch their data first, so old events would be noise
        stream.close();
        let p3;
        const resumed = openStream(port, 'tables=patients,appointments', tokens.admin);
        try {
          await awaitOpen(resumed);
          await sleep(400);
          assert.deepEqual(resumed.events.map((e) => e.record_id), [], 'a fresh stream must replay nothing');

          p3 = await db.query(
            `insert into public.patients (first_name, last_name, national_id)
             values ('Barbara', 'Liskov', 'NID-T9R-BARBARA') returning id`
          );
          await until(() => resumed.events.length >= 1, 3000, 'the event after the reconnect');
          assert.equal(resumed.events[0].record_id, p3.rows[0].id);
        } finally {
          resumed.close();
        }

        // since=<last delivered id> is the resume the shim uses after a dropped
        // connection: everything after the watermark, in order, exactly once
        const replay = openStream(port, `tables=patients,appointments&since=${p2id}`, tokens.admin);
        try {
          await until(() => replay.events.length >= 2, 3000, 'the two events after the watermark');
          assert.deepEqual(
            replay.events.map((e) => [e.table, e.record_id]),
            [['appointments', a2.rows[0].id], ['patients', p3.rows[0].id]]
          );
          assert.ok(replay.events[0].id < replay.events[1].id);
        } finally {
          replay.close();
        }
      } finally {
        stream.close();
      }
    }),
  },
  {
    name: 'staff only hear about patients rows their policy can read; admin hears everything, deletes included',
    fn: async (ctx) => withApi(ctx, async ({ db, port, tokens }) => {
      const staffStream = openStream(port, 'tables=patients', tokens.staff);
      const adminStream = openStream(port, 'tables=patients', tokens.admin);
      try {
        await awaitOpen(staffStream);
        await awaitOpen(adminStream);

        // invisible: never booked, so staff's patients policy hides it
        const hidden = await db.query(
          `insert into public.patients (first_name, last_name, national_id)
           values ('Hidden', 'Patient', 'NID-T9R-HIDDEN') returning id`
        );
        // visible: booked during this case, so the policy admits it
        const seen = await db.query(
          `insert into public.patients (first_name, last_name, national_id)
           values ('Seen', 'Patient', 'NID-T9R-SEEN') returning id`
        );
        await db.query(
          `insert into public.appointments (patient_id, scheduled_start, scheduled_end, duration_minutes, status)
           values ($1, '2026-03-03T10:00:00Z', '2026-03-03T10:30:00Z', 30, 'scheduled')`,
          [seen.rows[0].id]
        );

        await until(() => byTable(adminStream, 'patients').length >= 2, 3000, 'both events for admin');
        assert.deepEqual(
          byTable(adminStream, 'patients').map((e) => e.record_id).sort(),
          [hidden.rows[0].id, seen.rows[0].id].sort()
        );

        await until(() => byTable(staffStream, 'patients').length >= 1, 3000, 'the visible event for staff');
        await sleep(500); // and give the hidden one time to arrive if it were going to
        assert.deepEqual(
          byTable(staffStream, 'patients').map((e) => e.record_id),
          [seen.rows[0].id],
          'staff must not be told about a patient row they could never read'
        );

        // The documented consequence of evaluating the policy against the live
        // row: a DELETE has no live row, so it cannot be checked and is not
        // streamed to a scoped caller — while admin, whose predicate is "all
        // rows", receives it with the row as it was before the delete.
        await db.query('delete from public.patients where id = $1', [seen.rows[0].id]);
        await until(
          () => byTable(adminStream, 'patients').some((e) => e.action === 'DELETE' && e.record_id === seen.rows[0].id),
          3000,
          'the DELETE event for admin'
        );
        const adminDelete = byTable(adminStream, 'patients').find((e) => e.action === 'DELETE');
        assert.equal(adminDelete.payload.last_name, 'Patient'); // the row as it was, per 0007_outbox.sql
        await sleep(500);
        assert.deepEqual(
          byTable(staffStream, 'patients').filter((e) => e.action === 'DELETE').map((e) => e.record_id),
          [],
          'a scoped caller is not passed a delete it could not be checked against'
        );
      } finally {
        staffStream.close();
        adminStream.close();
      }
    }),
  },
  {
    name: 'user_roles: an admin hears every grant (the Users panel needs it); staff stay self-scoped',
    fn: async (ctx) => withApi(ctx, async ({ db, port, tokens }) => {
      // The Users panel in AdminSettings.tsx is admin-only and lists every
      // user through get_users_with_roles (SECURITY DEFINER). Its channel
      // exists to refresh that list when someone else's grant changes, so a
      // self-scoped admin stream ("Read own roles" only) would leave it
      // permanently stale — the milestone criterion is an event within two
      // seconds of an admin inserting a user_roles row, for any user. Staff
      // have no such view, so their stream keeps the self-scope.
      const adminStream = openStream(port, 'tables=user_roles', tokens.admin);
      const staffStream = openStream(port, 'tables=user_roles', tokens.staff);
      try {
        await awaitOpen(adminStream);
        await awaitOpen(staffStream);

        // a grant for someone else — the exact case the review reproduced:
        // admin inserts user_roles for a new user and the stream must fire
        const other = await db.query(
          `insert into public.user_roles (user_id, role) values ($1, 'user') returning id`,
          [ID.roleless]
        );
        // a grant for staff themselves — the one user_roles row staff's policy
        // can read (the role enum is admin/moderator/user; staff already has
        // 'user', so this adds the other role)
        const own = await db.query(
          `insert into public.user_roles (user_id, role) values ($1, 'moderator') returning id`,
          [ID.staff]
        );

        await until(
          () => adminStream.events.some((e) => e.record_id === other.rows[0].id),
          3000,
          'the other user\'s grant in admin\'s stream'
        );
        await until(
          () => adminStream.events.some((e) => e.record_id === own.rows[0].id),
          3000,
          'staff\'s grant in admin\'s stream too'
        );
        await until(
          () => staffStream.events.some((e) => e.record_id === own.rows[0].id),
          3000,
          'the staff-grant event in staff\'s own stream'
        );

        await sleep(500); // staff have had their chance at the other user's grant
        assert.deepEqual(
          adminStream.events.map((e) => [e.action, e.table, e.payload.user_id]),
          [
            ['INSERT', 'user_roles', ID.roleless],
            ['INSERT', 'user_roles', ID.staff],
          ],
          'admin hears every grant, each exactly once'
        );
        assert.deepEqual(
          staffStream.events.map((e) => e.record_id),
          [own.rows[0].id],
          'staff must still hear only about their own user_roles rows'
        );
      } finally {
        adminStream.close();
        staffStream.close();
      }
    }),
  },
  {
    name: 'a row filter narrows the stream to the row the page is watching',
    fn: async (ctx) => withApi(ctx, async ({ db, port, tokens }) => {
      // exactly the shape AdminSettings/Billing build when they watch one entity
      const stream = openStream(port, `tables=appointments&filter=appointments:id=eq.${ID.appt1}`, tokens.admin);
      try {
        await awaitOpen(stream);

        await db.query(`update public.appointments set reason = 'follow-up' where id = $1`, [ID.appt1]);
        await until(() => stream.events.length >= 1, 3000, 'the filtered UPDATE event');
        const event = stream.events[0];
        assert.equal(event.table, 'appointments');
        assert.equal(event.action, 'UPDATE');
        assert.equal(event.record_id, ID.appt1);
        assert.equal(event.payload.reason, 'follow-up');

        // another appointment written and changed: the stream must not hear it
        const other = await db.query(
          `insert into public.appointments (patient_id, scheduled_start, scheduled_end, duration_minutes, status)
           values ($1, '2026-03-04T10:00:00Z', '2026-03-04T10:30:00Z', 30, 'scheduled') returning id`,
          [ID.ada]
        );
        await db.query(`update public.appointments set reason = 'not for this stream' where id = $1`, [other.rows[0].id]);
        await sleep(600);
        assert.deepEqual(
          stream.events.map((e) => e.record_id),
          [ID.appt1],
          'the filter must hold for both inserts and updates'
        );
      } finally {
        stream.close();
      }
    }),
  },
  {
    name: '": ping" keeps an idle stream alive through a buffering proxy',
    fn: async (ctx) => withApi(ctx, async ({ port, tokens }) => {
      // this suite starts the server with REALTIME_PING_MS=1000 (the route's
      // floor); production default is 15000, matching the plan's fifteen seconds.
      const stream = openStream(port, 'tables=clinic_settings', tokens.admin);
      try {
        await awaitOpen(stream);
        await until(() => stream.comments.some((c) => c.includes('ping')), 5000, 'a ": ping" comment');
        // comments are comments: they must never have been parsed as events
        assert.deepEqual(stream.events, []);
      } finally {
        stream.close();
      }
    }),
  },
];
