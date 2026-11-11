// tests/api/shim.test.mjs — the browser supabase shim (task t8, milestone 3).
//
// The pages now talk to a hand-written supabase-js-shaped client
// (src/integrations/supabase/client.ts + shim/) instead of the old npm
// package. These cases import the SHIM ITSELF — the real .ts sources, loaded
// through node's built-in type stripping — and drive them against a real
// `node api/server.mjs` on a real PostgreSQL scratch database, exactly like
// the query suite. So what is pinned here is the contract between the pages
// and the API *as the pages will execute it*: the chain methods they call,
// the {data, error} shapes they destructure, and the error objects their
// `if (error) throw error` paths surface.
//
//   T8.1  the LandingPage anonymous services select (order + limit) — the
//         public page must keep rendering without any session;
//   T8.2  the Billing nested embed through the chain: to-one objects,
//         `appointment: null`, to-many arrays, JSON value types;
//   T8.3  Exports/RevenueSummary/TodaysSchedule's .gte(col).lte(col) on ONE
//         column — the folding into a single API `or` group must keep the
//         range semantics (the filters map only allows one op per column);
//   T8.4  a user-supplied .or() string passed through verbatim;
//   T8.5  .single() / .maybeSingle() PGRST116 semantics, in the envelope;
//   T8.6  an anonymous write surfaces a real error object (message + code),
//         because every page does `if (error) throw error`;
//   T8.7  staff/admin role plumbing: staff can insert a patient but not
//         touch clinic_settings; update/delete work for the admin;
//   T8.8  Visit.tsx's upsert(payload, {onConflict:'appointment_id'}) pattern;
//   T8.9  AdminSettings' rpc('get_users_with_roles') — rows for the admin,
//         a clean {data, error} 403 for the staff user;
//   T8.10 BAD_COLUMN error mapping (message names the column, so the page's
//         toast is still useful);
//   T8.11 auth: sign-in/session/sign-out events, localStorage persistence
//         across client instances, signUp, wrong-password error shape;
//   T8.12 auth.admin.createUser + the page's follow-up user_roles insert —
//         the W34 add-user flow, i.e. createUser must NOT pre-grant a role;
//   T8.13 the shim exposes no `.functions` member at all (contract line).

import pg from 'pg';
import assert from 'node:assert/strict';

import { startServer } from '../helpers/server.mjs';

const SCRATCH = '_t8';
const JWT_SECRET = 't8-shim-suite-secret-0123456789abcdef';

// The seeded admin/staff accounts are the only loggable identities (fixture
// users carry fake hashes), so the auth cases sign in with them. The server
// seeds them on start-up when SEED_ACCOUNTS is on, which withShim does.
const SEED_ADMIN = { email: 'admin@example.test', password: 'Admin#2025test' };
const SEED_STAFF = { email: 'staff@example.test', password: 'Staff#2025test' };

const ID = {
  ada: '00000000-0000-4000-8000-000000000001',
  noor: '00000000-0000-4000-8000-000000000002',
  appt1: '00000000-0000-4000-8000-000000000003',
  invJan: '00000000-0000-4000-8000-000000000021',
  invFeb: '00000000-0000-4000-8000-000000000022',
  invMar: '00000000-0000-4000-8000-000000000023',
  item1: '00000000-0000-4000-8000-000000000024',
};

const FIXTURE = [
  `insert into public.patients (id, first_name, last_name, date_of_birth, sex, phone, email, address, national_id) values
     ($1, 'Ada', 'Example', '1980-02-02', 'f', '+1-555-0100', 'ada@t8.test', '1 Rose Crescent', 'NID-T8A'),
     ($2, 'Aliki', 'Notreal', null, 'f', '+1-555-0102', 'aliki@t8.test', '2 Laurel Lane', 'NID-T8B')`,
  [ID.ada, ID.noor],

  `insert into public.appointments (id, patient_id, scheduled_start, scheduled_end, duration_minutes, status, reason)
   values ($1, $2, '2026-03-01T10:00:00Z', '2026-03-01T10:30:00Z', 30, 'scheduled', 'annual checkup')`,
  [ID.appt1, ID.ada],

  // three invoices with pinned created_at values, for the range cases
  `insert into public.invoices (id, appointment_id, tax_enabled, tax_rate, status, created_at) values
     ($1, $4, false, 0.00, 'issued', '2026-01-05T12:00:00Z'),
     ($2, $4, false, 0.00, 'issued', '2026-02-05T12:00:00Z'),
     ($3, null, false, 0.00, 'draft',  '2026-03-05T12:00:00Z')`,
  [ID.invJan, ID.invFeb, ID.invMar, ID.appt1],

  `insert into public.invoice_items (id, invoice_id, description, quantity, unit_price, taxable) values
     ($1, $2, 'Dressing', 1, 5.00, false)`,
  [ID.item1, ID.invJan],
];

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
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

// The shim is plain erasable TypeScript, so node imports the SAME files the
// browser bundle ships (the loader's default type-stripping handles them).
let shim = null;
async function loadShim() {
  if (!shim) shim = await import('../../src/integrations/supabase/client.ts');
  return shim;
}

// A localStorage stand-in: the shim persists sessions there in the browser;
// tests hand each client one explicitly so instances can share or isolate.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

// withShim({root, testUrl}, fn): scratch database + running API + a `client()`
// factory producing isolated shim clients pointed at that API. `signIn(client,
// who)` performs the real POST /api/auth/login through the shim's own auth.
async function withShim({ root, testUrl }, fn) {
  const mod = await loadShim();
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const dsn = swapDb(testUrl, `${base}${SCRATCH}`);
  const scratch = `${base}${SCRATCH}`;
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

  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET, SEED_ACCOUNTS: '1' } });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);

    const api = {
      db,
      log: handle.log,
      baseUrl: `http://127.0.0.1:${handle.port}`,
      client(opts = {}) {
        const storage = opts.storage ?? fakeStorage();
        // auth.ts reads globalThis.localStorage at client-creation time.
        globalThis.localStorage = storage;
        const client = mod.createSupabaseClient({ baseUrl: `http://127.0.0.1:${handle.port}` });
        globalThis.localStorage = undefined;
        client.__storage = storage;
        return client;
      },
      async signIn(client, who) {
        const creds = who === 'staff' ? SEED_STAFF : SEED_ADMIN;
        const { data, error } = await client.auth.signInWithPassword(creds);
        assert.equal(error, null, `sign-in as ${who} failed: ${error?.message}`);
        return data.session;
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

// --- the cases -----------------------------------------------------------------

export default [
  {
    name: 'T8.1 anonymous LandingPage select: services order+limit without any session',
    fn: async (ctx) => withShim(ctx, async ({ client }) => {
      const anon = client(); // never signed in: no Authorization header at all
      const { data, error } = await anon
        .from('services')
        .select('*')
        .order('name', { ascending: true })
        .limit(3);
      assert.equal(error, null, `anonymous services select failed: ${error?.message}`);
      assert.ok(Array.isArray(data) && data.length === 3, `expected 3 services, got ${JSON.stringify(data)?.slice(0, 200)}`);
      const names = data.map((s) => s.name);
      assert.deepEqual(names, [...names].sort(), `expected name-ordered rows, got ${names.join(', ')}`);
      assert.equal(anon.auth.getToken(), null, 'an untouched client must hold no token');
    }),
  },

  {
    name: 'T8.2 Billing nested embed via the chain: to-one, null, to-many arrays, value types',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');
      const { data, error } = await admin
        .from('invoices')
        .select(
          'id, status, total, tax_enabled, created_at, ' +
          'appointment:appointments(reason, patient:patients(first_name, last_name)), ' +
          'invoice_items(description)'
        )
        .order('id', { ascending: true });
      assert.equal(error, null, error?.message);
      assert.deepEqual(data.map((r) => r.id), [ID.invJan, ID.invFeb, ID.invMar]);

      const jan = data[0];
      assert.equal(jan.appointment.reason, 'annual checkup');
      assert.equal(jan.appointment.patient.first_name, 'Ada');
      assert.deepEqual(jan.invoice_items, [{ description: 'Dressing' }]); // to-many stays an array
      assert.equal(typeof jan.total, 'number'); // numeric -> JSON number
      assert.equal(typeof jan.tax_enabled, 'boolean');
      assert.equal(typeof jan.created_at, 'string');

      const mar = data[2];
      assert.equal(mar.appointment, null, 'to-one with no FK row must be null, not []');
    }),
  },

  {
    name: 'T8.3 .gte(col).lte(col) on one column (the Exports/RevenueSummary date-range pattern)',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');

      // The pattern from Exports.tsx: both bounds on created_at. The API's
      // filters map allows one op per column, so the shim folds the pair into
      // one and() group — the result set must be exactly the range.
      const { data, error } = await admin
        .from('invoices')
        .select('id, created_at')
        .gte('created_at', '2026-01-20T00:00:00Z')
        .lte('created_at', '2026-02-20T23:59:59Z')
        .order('id');
      assert.equal(error, null, error?.message);
      assert.deepEqual(data.map((r) => r.id), [ID.invFeb], 'range must contain only February');

      // and combined with a plain eq filter (RevenueSummary adds status filters
      // on top of the range): still exactly the intersection.
      const both = await admin
        .from('invoices')
        .select('id, status')
        .gte('created_at', '2026-01-01T00:00:00Z')
        .lte('created_at', '2026-02-28T23:59:59Z')
        .eq('status', 'issued');
      assert.equal(both.error, null, both.error?.message);
      assert.deepEqual(both.data.map((r) => r.id).sort(), [ID.invJan, ID.invFeb]);
    }),
  },

  {
    name: 'T8.4 user .or() string passes through and unions across columns',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');
      const { data, error } = await admin
        .from('patients')
        .select('id')
        .or('first_name.eq.Ada,last_name.eq.Notreal')
        .order('id');
      assert.equal(error, null, error?.message);
      assert.deepEqual(data.map((r) => r.id), [ID.ada, ID.noor]);
    }),
  },

  {
    name: 'T8.5 single() / maybeSingle(): PGRST116 in the envelope, maybeSingle null-without-error',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');

      const hit = await admin.from('patients').select('id').eq('id', ID.ada).single();
      assert.equal(hit.error, null, hit.error?.message);
      assert.equal(hit.data.id, ID.ada); // single() unwraps the array — the pages read fields off it directly

      const miss = await admin.from('patients').select('id').eq('id', ID.appt1).single();
      assert.equal(miss.data, null);
      assert.equal(miss.error.code, 'PGRST116', `expected PGRST116, got ${JSON.stringify(miss.error)}`);

      const maybeMiss = await admin.from('patients').select('id').eq('id', ID.appt1).maybeSingle();
      assert.equal(maybeMiss.error, null, 'maybeSingle on zero rows must not error');
      assert.equal(maybeMiss.data, null);

      const many = await admin.from('invoices').select('id').maybeSingle(); // 3 rows
      assert.equal(many.data, null);
      assert.equal(many.error.code, 'PGRST116');
    }),
  },

  {
    name: 'T8.6 anonymous write yields a throw-able error object (every page does `if (error) throw error`)',
    fn: async (ctx) => withShim(ctx, async ({ client }) => {
      const anon = client();
      // appointments are not on the anonymous allow-list (patients and the
      // landing services read are) — so this write must be refused.
      const { data, error } = await anon
        .from('appointments')
        .insert({ patient_id: ID.ada, scheduled_start: '2026-04-01T10:00:00Z', scheduled_end: '2026-04-01T10:30:00Z', duration_minutes: 30, status: 'scheduled', reason: 'sneaky' });
      assert.equal(data, null);
      assert.ok(error instanceof Error, 'the shim must hand back a real Error (pages do throw error)');
      assert.ok(error.message.length > 0);
      assert.ok(error.code && String(error.code).length > 0, `expected an error code, got ${JSON.stringify(error)}`);
      assert.notEqual(error.code, 'FETCH_ERROR', 'the API did answer — this is a policy refusal, not a connection problem');
    }),
  },

  {
    name: 'T8.7 role plumbing: staff can insert patients but not clinic_settings; admin can update and delete',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const staff = client();
      await signIn(staff, 'staff');

      const inserted = await staff
        .from('patients')
        .insert({ first_name: 'Nadia', last_name: 'T8', date_of_birth: '1991-01-01', sex: 'f', phone: '+1-555-0999', email: null, address: null, national_id: 'NID-T8S' })
        .select('id, first_name')
        .single();
      assert.equal(inserted.error, null, inserted.error?.message);
      assert.equal(inserted.data.first_name, 'Nadia');

      const settings = await staff.from('clinic_settings').update({ tax_rate: 99 }).eq('singleton', true);
      assert.equal(settings.data, null, 'the policy-hidden update must not report success');
      assert.equal(settings.error.code, 'FORBIDDEN', `expected a FORBIDDEN, got ${JSON.stringify(settings.error)}`);

      const admin = client();
      await signIn(admin, 'admin');
      const upd = await admin.from('patients').update({ phone: '+1-555-0101' }).eq('id', ID.ada).select('phone').single();
      assert.equal(upd.error, null, upd.error?.message);
      assert.equal(upd.data.phone, '+1-555-0101');

      const del = await admin.from('patients').delete().eq('id', inserted.data.id);
      assert.equal(del.error, null, del.error?.message);
      const gone = await admin.from('patients').select('id').eq('id', inserted.data.id).maybeSingle();
      assert.equal(gone.error, null, gone.error?.message);
      assert.equal(gone.data, null);
    }),
  },

  {
    name: 'T8.8 Visit.tsx upsert(payload, {onConflict}) pattern and a bad conflict target',
    fn: async (ctx) => withShim(ctx, async ({ db, client, signIn }) => {
      const staff = client();
      await signIn(staff, 'staff');

      const payload = { appointment_id: ID.appt1, notes: 'v1' };
      const first = await staff.from('visit_notes').upsert(payload, { onConflict: 'appointment_id' });
      assert.equal(first.error, null, first.error?.message);
      const second = await staff.from('visit_notes').upsert({ ...payload, notes: 'v2' }, { onConflict: 'appointment_id' });
      assert.equal(second.error, null, second.error?.message);

      const rows = await db.query('select notes from public.visit_notes where appointment_id = $1', [ID.appt1]);
      assert.equal(rows.rows.length, 1, 'the on-conflict target must keep the row unique');
      assert.equal(rows.rows[0].notes, 'v2');

      const bad = await staff.from('visit_notes').upsert(payload, { onConflict: 'notes' });
      assert.equal(bad.data, null);
      assert.ok(bad.error, 'a non-unique conflict target must error, not write');
    }),
  },

  {
    name: 'T8.9 AdminSettings rpc(): rows for the admin, clean 403 envelope for staff',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');
      const { data, error } = await admin.rpc('get_users_with_roles');
      assert.equal(error, null, error?.message);
      assert.ok(Array.isArray(data), `expected the bare rows array, got ${JSON.stringify(data)?.slice(0, 120)}`);
      const adminRow = data.find((u) => u.email === SEED_ADMIN.email);
      assert.ok(adminRow, `the seeded admin is missing from ${data.map((u) => u.email).join(', ')}`);
      assert.ok(JSON.stringify(adminRow.roles ?? adminRow).includes('admin'));

      const staff = client();
      await signIn(staff, 'staff');
      const denied = await staff.rpc('get_users_with_roles');
      assert.equal(denied.data, null);
      assert.ok(denied.error instanceof Error);
      assert.equal(denied.error.code, 'FORBIDDEN', `expected a FORBIDDEN, got ${JSON.stringify(denied.error)}`);
    }),
  },

  {
    name: 'T8.10 unknown column maps to a useful BAD_COLUMN error (page toasts name the column)',
    fn: async (ctx) => withShim(ctx, async ({ client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');
      const { data, error } = await admin.from('patients').select('id, nope');
      assert.equal(data, null);
      assert.equal(error.code, 'BAD_COLUMN', `expected BAD_COLUMN, got ${JSON.stringify(error)}`);
      assert.ok(error.message.includes('nope'), `message should name the offending column: ${error.message}`);
    }),
  },

  {
    name: 'T8.11 auth: sign-in/session/sign-out events, storage persistence across instances, wrong password',
    fn: async (ctx) => withShim(ctx, async ({ db, client, baseUrl }) => {
      const storage = fakeStorage();
      const first = client({ storage });

      const events = [];
      first.auth.onAuthStateChange((event, session) => events.push([event, session?.user?.email ?? null]));

      const { data, error } = await first.auth.signInWithPassword(SEED_STAFF);
      assert.equal(error, null, error?.message);
      assert.ok(data.session.access_token.length > 20);
      assert.equal(data.user.email, SEED_STAFF.email);
      assert.ok(events.some(([e]) => e === 'SIGNED_IN'), `expected a SIGNED_IN event, got ${JSON.stringify(events)}`);

      // the token is persisted where the browser keeps it, under the shim key
      const persisted = storage.map.get('hh.session');
      assert.ok(persisted && persisted.includes(data.session.access_token.slice(0, 12)), 'session must be persisted for reload');

      // a fresh client (a page reload) on the SAME storage resumes the session
      const second = client({ storage });
      const resumed = await second.auth.getSession();
      assert.equal(resumed.error, null, resumed.error?.message);
      assert.equal(resumed.data.session.user.email, SEED_STAFF.email);

      // getSession verifies the stored token against the API before trusting it
      const bogus = client();
      bogus.__storage.map.set('hh.session', JSON.stringify({ access_token: 'not.a.jwt', user: { id: 'x', email: 'ghost@t8.test' } }));
      const ghost = await bogus.auth.getSession();
      assert.equal(ghost.data.session, null, 'a rejected token must be dropped, not reported as a session');
      assert.equal(bogus.__storage.map.has('hh.session'), false, 'the dead session must be removed from storage');

      // sign-out clears storage and announces itself (events are per-client —
      // like the old library, the client that acts is the one that emits)
      const secondEvents = [];
      second.auth.onAuthStateChange((event, session) => secondEvents.push([event, session?.user?.email ?? null]));
      const out = await second.auth.signOut();
      assert.equal(out.error, null);
      assert.equal(second.auth.getToken(), null);
      assert.equal(second.__storage.map.has('hh.session'), false);
      assert.equal(secondEvents.filter(([e]) => e === 'SIGNED_OUT').length, 1);

      // wrong password: the old client answered INVALID_LOGIN with data.session null
      const wrong = await client().auth.signInWithPassword({ email: SEED_STAFF.email, password: 'wrong-password' });
      assert.equal(wrong.data.session, null);
      assert.ok(wrong.error instanceof Error);
      assert.equal(wrong.error.code, 'INVALID_CREDENTIALS', `expected INVALID_CREDENTIALS, got ${JSON.stringify(wrong.error)}`);
      assert.ok(wrong.error.message.length > 0);

      // self sign-up is off by default: staff accounts are created by an admin
      const { data: up, error: upErr } = await client().auth.signUp({ email: 'newpatient@t8.test', password: 'NewPatient#2025' });
      assert.ok(upErr, 'signUp must fail while ALLOW_SELF_SIGNUP is off');
      assert.equal(up.session ?? null, null);
      const row = await db.query('select count(*)::int as n from public.app_users where email = $1', ['newpatient@t8.test']);
      assert.equal(row.rows[0].n, 0);
      void baseUrl;
    }),
  },

  {
    name: 'T8.12 W34 add-user flow: auth.admin.createUser leaves the role to the page (user_roles insert then works)',
    fn: async (ctx) => withShim(ctx, async ({ db, client, signIn }) => {
      const admin = client();
      await signIn(admin, 'admin');

      const { data, error } = await admin.auth.admin.createUser({
        email: 'newstaff@t8.test',
        password: 'NewStaff#2025t8',
        email_confirm: true,
      });
      assert.equal(error, null, error?.message);
      assert.ok(data.user?.id, `expected the created user, got ${JSON.stringify(data)}`);

      // what the old hosted flow guaranteed: no role grant yet
      const roles = await db.query('select count(*)::int as n from public.user_roles where user_id = $1', [data.user.id]);
      assert.equal(roles.rows[0].n, 0, 'createUser must NOT pre-grant a role — the page inserts user_roles itself');

      // the page's follow-up insert (AdminSettings) must therefore not 409
      const grant = await admin.from('user_roles').insert({ user_id: data.user.id, role: 'user' });
      assert.equal(grant.error, null, `the page's role insert failed: ${JSON.stringify(grant.error)}`);

      // and the account is then usable: it appears in get_users_with_roles (the
      // page's Users list) and it can actually sign in with its password
      const listed = await admin.rpc('get_users_with_roles');
      assert.equal(listed.error, null, listed.error?.message);
      const mine = listed.data.filter((u) => u.user_id === data.user.id);
      assert.ok(mine.length, 'the created user must appear in get_users_with_roles');
      assert.deepEqual(mine.map((u) => u.role).sort(), ['user']);

      const fresh = client();
      const login = await fresh.auth.signInWithPassword({ email: 'newstaff@t8.test', password: 'NewStaff#2025t8' });
      assert.equal(login.error, null, login.error?.message);
      assert.ok(login.data.session?.access_token, 'the created account must be able to sign in');
    }),
  },

  {
    name: 'T8.13 the shim exposes no .functions member (the contract says there is none)',
    fn: async (ctx) => withShim(ctx, async ({ client }) => {
      const anon = client();
      assert.equal('functions' in anon, false, 'the shim must not grow a .functions surface before those endpoints exist');
    }),
  },
];
