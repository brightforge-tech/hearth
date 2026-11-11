// tests/api/storage.test.mjs — PUT / GET / HEAD /api/storage/<bucket>/<path>
// (task t9, W35: the Visit page's signature upload and everything that guards it).
//
// Same ground rules as the other API suites: a real `node api/server.mjs`
// against a real scratch database, driven over real HTTP, with the uploads root
// pointed at a fresh temporary directory (UPLOAD_DIR) so the bytes this suite
// writes can be inspected on disk — and so the repository's own var/uploads is
// never touched.
//
// Pinned case by case:
//   * W35 happy path: a PNG PUT answers {"Path": "<bucket>/<name>"}, the bytes
//     land under UPLOAD_DIR/<bucket>/..., the storage_objects row carries the
//     metadata (mime, byte count, sha256, owner), and the GET hands back exactly
//     the same bytes with the stored type and an ETag from the stored hash;
//   * the guards, each before anything reaches the disk: 401 without a session
//     (even with a body still arriving), 400 for an unknown bucket, 400 and
//     nothing outside the uploads root for a name that tries to climb out
//     (".." raw and percent-encoded), 415 for a media type this API refuses to
//     store, 413 over 10 MB, 409 for a repeat without x-upsert (and the old
//     object survives that attempt), 404 for a name nothing has uploaded;
//   * DELETE deliberately reaches the API's generic JSON 404 — that assertion
//     lives in tests/api/routing.test.mjs, which already pins it.
//
// The pure half — normalizeObjectName / resolveObject, the whole path policy of
// api/lib/uploads.mjs — is unit-tested without a server too, because every HTTP
// refusal on the path questions is one of those throws.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

import { normalizeObjectName, resolveObject } from '../../api/lib/uploads.mjs';
import { signTestToken as signToken, ensureTestSessions } from '../helpers/session.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t9s';
const JWT_SECRET = 't9-storage-suite-secret-0123456789abcdef';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // the plan's 10 MB cap, restated to assert the boundary

const ID = {
  admin: '00000000-0000-4000-a000-0000000000d1',
  staff: '00000000-0000-4000-a000-0000000000d2',
  roleless: '00000000-0000-4000-a000-0000000000d3',
};

const FIXTURE = [
  `insert into public.app_users (id, email, password_hash) values
     ($1, 'admin@t9s.test', 'scrypt$t9s$fixture$not-a-real-hash'),
     ($2, 'staff@t9s.test', 'scrypt$t9s$fixture$not-a-real-hash'),
     ($3, 'roleless@t9s.test', 'scrypt$t9s$fixture$not-a-real-hash')`,
  [ID.admin, ID.staff, ID.roleless],

  `insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'user')`,
  [ID.admin, ID.staff],
];

// A PNG's first eight bytes plus enough payload to be more than a header: what
// matters here is byte equality end to end (the API stores what the caller
// declared, it does not decode images).
function pngBytes(seed) {
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(String(seed).repeat(60), 'utf8')]);
}
const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

// --- scratch database + uploads directory + server -----------------------------

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

// withApi: a fresh scratch database, a fresh temporary uploads root, the API
// pointed at both, and the two staff accounts committed. `put/get/head` speak
// the storage endpoint; `row` reads storage_objects straight from the database.
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

  const uploadsDir = mkdtempSync(join(tmpdir(), 'hh-t9s-uploads-'));
  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET, UPLOAD_DIR: uploadsDir } });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);
    await ensureTestSessions(db);

    const tokenFor = (which) =>
      signToken({ sub: ID[which], email: `${which}@t9s.test` }, { secret: JWT_SECRET });
    const tokens = { admin: tokenFor('admin'), staff: tokenFor('staff'), roleless: tokenFor('roleless') };

    const api = {
      db,
      tokens,
      uploadsDir,
      log: handle.log,
      // put(path, body, opts): opts.headers rides on top of the PNG default;
      // opts.token: null sends no Authorization at all.
      put: (path, body, { token = tokens.admin, headers = {} } = {}) =>
        request(handle.port, `/api/storage/${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'image/png', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
          body,
          timeoutMs: 30_000,
        }),
      get: (path, { token = tokens.admin, headers = {} } = {}) =>
        request(handle.port, `/api/storage/${path}`, {
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
          timeoutMs: 30_000,
        }),
      head: (path, opts = {}) =>
        request(handle.port, `/api/storage/${path}`, {
          method: 'HEAD',
          headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? tokens.admin}` },
          timeoutMs: 30_000,
        }),
      row(bucket, name) {
        return db
          .query(
            `select "bucket", "name", "owner", "mime", "bytes", "sha256"
               from public."storage_objects" where "bucket" = $1 and "name" = $2`,
            [bucket, name]
          )
          .then((r) => r.rows[0] ?? null);
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
    rmSync(uploadsDir, { recursive: true, force: true });
    const admin = new pg.Client(clientParams(testUrl, 'postgres'));
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${scratch}" with (force)`);
    } finally {
      await admin.end();
    }
  }
}

// --- tiny assertion helpers ------------------------------------------------------

function errorBody(res, status, code) {
  assert.equal(typeof res.json, 'object', `expected JSON, got ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(typeof res.json.error, 'object');
  assert.equal(res.json.error.code, code, `expected code ${code}, got ${JSON.stringify(res.json.error)}`);
  assert.ok(typeof res.json.error.message === 'string' && res.json.error.message.length > 0);
  return res.json.error;
}
const badPath = (raw) =>
  assert.throws(
    () => normalizeObjectName(raw),
    (e) => e.status === 400 && e.code === 'BAD_PATH',
    `expected BAD_PATH for ${JSON.stringify(raw)}`
  );

// --- the cases -------------------------------------------------------------------

export default [
  {
    name: 'normalizeObjectName: the names the route accepts, and every way of climbing out it refuses',
    fn: async () => {
      // the shape Visit.tsx builds: appointment_<id>/<timestamp>.png
      assert.equal(normalizeObjectName('appointment_7/1700000000000.png'), 'appointment_7/1700000000000.png');
      // "." segments and doubled slashes normalise away: they cannot escape anything
      assert.equal(normalizeObjectName('./a//b.png'), 'a/b.png');
      assert.equal(normalizeObjectName('/leading/slashes.csv'), 'leading/slashes.csv');

      // the escape attempts: refused by name, not cleaned up behind the caller's back
      badPath('..');
      badPath('a/../b.png');
      badPath('a/..');
      badPath('../../etc/passwd');
      // backslash is a separator on Windows, so "a\\b" is a climb waiting to happen
      badPath('a\\b.png');
      // control characters and NUL: the truncated-path trap on every filesystem
      badPath('a\nb.png');
      badPath('a\u0000b.png');
      badPath('tab\there.png');
      // Windows-reserved stems: "con.png" would look like a server error otherwise
      badPath('con.png');
      badPath('folder/COM1.log');
      badPath('nul');
      // nothing there, or far too much of it
      badPath('');
      badPath('/');
      badPath('x'.repeat(1025));
      badPath('d/'.repeat(16) + 'deep.png'); // 17 folders
    },
  },
  {
    name: 'resolveObject: two buckets only, and the resolved path stays strictly inside its bucket',
    fn: async () => {
      const root = resolve('.');
      for (const bucket of ['signatures', 'exports']) {
        const t = resolveObject(bucket, 'a/b.png', { root });
        assert.equal(t.name, 'a/b.png');
        assert.equal(t.filePath, resolve(root, bucket, 'a', 'b.png'));
        assert.equal(t.bucketDirPath, resolve(root, bucket));
      }
      assert.throws(
        () => resolveObject('avatars', 'x.png', { root }),
        (e) => e.status === 400 && e.code === 'BAD_BUCKET',
        'a third bucket is not creatable by URL'
      );
      assert.throws(
        () => resolveObject('../signatures', 'x.png', { root }),
        (e) => e.status === 400 && e.code === 'BAD_BUCKET',
        'the bucket slot itself may not climb'
      );
      // percent-encoding is the router's business: by the time uploads.mjs sees a
      // name, express has decoded it — and a second decode would corrupt a
      // legitimate "%". The unit below pins that raw ".." (decoded form) is what
      // gets refused.
      assert.throws(
        () => resolveObject('signatures', '../exports/other.csv', { root }),
        (e) => e.status === 400 && e.code === 'BAD_PATH',
        'one bucket may not write into another'
      );
    },
  },
  {
    name: 'W35 the signature round trip: PUT stores the bytes and the row, GET and HEAD serve them back byte-identical',
    fn: async (ctx) => withApi(ctx, async ({ put, get, head, row, uploadsDir, tokens }) => {
      const bytes = pngBytes('t9-signature');
      const name = 'appointment_42/1762600000000.png';

      const res = await put(`signatures/${name}`, bytes, { headers: { 'x-upsert': 'true' } });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
      assert.deepEqual(res.json, { Path: `signatures/${name}` }); // the legacy storage contract

      // the bytes on disk, under the bucket directory, at the normalised name
      const onDisk = join(uploadsDir, 'signatures', 'appointment_42', '1762600000000.png');
      assert.ok(existsSync(onDisk), 'the file is where UPLOAD_DIR says it is');
      assert.ok(readFileSync(onDisk).equals(bytes), 'the file on disk is the upload, byte for byte');

      // the row in storage_objects — the local twin of the hosted storage.objects
      const r = await row('signatures', name);
      assert.ok(r, 'a storage_objects row names the object');
      assert.equal(r.mime, 'image/png');
      assert.equal(Number(r.bytes), bytes.length);
      assert.equal(r.sha256, sha256Hex(bytes));
      assert.equal(r.owner, ID.admin);

      // the GET: same bytes, stored type, hash as ETag, and nothing cacheable
      const fetched = await get(`signatures/${name}`);
      assert.equal(fetched.status, 200);
      assert.ok(fetched.body.equals(bytes), 'GET returns the exact bytes uploaded');
      assert.match(fetched.headers['content-type'] ?? '', /^image\/png/);
      assert.equal(fetched.headers.etag, `"${sha256Hex(bytes)}"`);
      assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
      assert.match(String(fetched.headers['cache-control']), /private/);
      assert.equal(Number(fetched.headers['content-length']), bytes.length);

      // HEAD: the headers of the GET, no body
      const checked = await head(`signatures/${name}`);
      assert.equal(checked.status, 200);
      assert.equal(checked.text, '');
      assert.equal(Number(checked.headers['content-length']), bytes.length);
      assert.match(checked.headers['content-type'] ?? '', /^image\/png/);

      // and a staff session can read it too — the bucket is private to signed-in
      // users, not reserved for the uploader
      const staffGet = await get(`signatures/${name}`, { token: tokens.staff });
      assert.ok(staffGet.status === 200 && staffGet.body.equals(bytes));
    }),
  },
  {
    name: 'a repeat PUT without x-upsert is refused 409 before it can clobber; with x-upsert it replaces, one row',
    fn: async (ctx) => withApi(ctx, async ({ put, get, row, uploadsDir, db }) => {
      const path = 'signatures/appointment_9/first.png';
      const name = 'appointment_9/first.png';
      const first = pngBytes('first');
      const second = pngBytes('second');

      assert.equal((await put(path, first)).status, 200); // the very first upload needs no x-upsert

      // the collision, refused: same name, no x-upsert header
      const clash = await put(path, second);
      errorBody(clash, 409, 'CONFLICT');
      assert.match(clash.json.error.message, /x-upsert/);
      // ...and the old object is still exactly what it was
      assert.ok((await get(path)).body.equals(first));
      assert.ok(readFileSync(join(uploadsDir, 'signatures', name)).equals(first));
      assert.equal((await row('signatures', name)).sha256, sha256Hex(first));

      // the replacement that was actually asked for
      assert.equal((await put(path, second, { headers: { 'x-upsert': 'true' } })).status, 200);
      assert.ok((await get(path)).body.equals(second));
      assert.equal((await row('signatures', name)).sha256, sha256Hex(second));
      // replacing is updating: not a second row for the same name
      const all = await db.query(
        `select count(*)::int as n from public."storage_objects" where "bucket" = 'signatures' and "name" = $1`,
        [name]
      );
      assert.equal(all.rows[0].n, 1);
    }),
  },
  {
    name: 'every refusal happens before a byte lands: 401, bad bucket, traversal, reserved name, 415, 413',
    fn: async (ctx) => withApi(ctx, async ({ put, uploadsDir, tokens, db }) => {
      const body = pngBytes('never-stored');
      const outside = resolve(uploadsDir, '..'); // where a successful traversal would land

      // 401 — and not a socket accident: the guard answers while the body is still arriving
      const naked = await put('signatures/naked.png', body, { token: null });
      errorBody(naked, 401, 'UNAUTHORIZED');
      // an account with a valid session but no role is refused a different way: 403
      errorBody(await put('signatures/norole.png', body, { token: tokens.roleless }), 403, 'NO_ROLE');

      // 400 BAD_BUCKET: buckets are provisioned (0006_storage.sql), not invented by URL
      errorBody(await put('avatars/x.png', body), 400, 'BAD_BUCKET');

      // 400 BAD_PATH — the raw climb and its percent-encoded twin (express
      // decodes route params before the router sees them, so both arrive as "..")
      errorBody(await put('signatures/../../escape.png', body), 400, 'BAD_PATH');
      errorBody(await put('signatures/%2e%2e%2f%2e%2e%2fescape2.png', body), 400, 'BAD_PATH');
      // and nothing actually landed next to or above the uploads root
      assert.ok(!existsSync(join(outside, 'escape.png')), 'the traversal wrote nothing outside the uploads root');
      assert.ok(!existsSync(join(outside, 'escape2.png')));
      // a Windows-reserved stem is a bad name on this platform, refused as such
      errorBody(await put('signatures/con.png', body), 400, 'BAD_PATH');

      // 415: storing an arbitrary type is how an upload endpoint becomes a
      // phishing host, because the GET serves the stored type straight back
      const html = await put('signatures/phish.png', Buffer.from('<script>alert(1)</script>'), {
        headers: { 'content-type': 'text/html' },
      });
      errorBody(html, 415, 'UNSUPPORTED_MEDIA_TYPE');
      assert.match(html.json.error.message, /image\/png/); // and it says what IS allowed

      // 413: 10 MB + 1 KiB, refused while still arriving (express.raw's limit)
      const huge = await put('signatures/huge.png', Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41));
      errorBody(huge, 413, 'PAYLOAD_TOO_LARGE');

      // not one of the refused objects exists — neither as bytes nor as a row
      for (const name of ['naked.png', 'norole.png', 'escape.png', 'escape2.png', 'con.png', 'phish.png', 'huge.png']) {
        assert.ok(!existsSync(join(uploadsDir, 'signatures', name)), `${name} was never written`);
      }
      const rows = await db.query('select count(*)::int as n from public."storage_objects"');
      assert.equal(rows.rows[0].n, 0);
    }),
  },
  {
    name: 'reads need a session; nothing there is 404, an unknown bucket is 400, a climb is 400',
    fn: async (ctx) => withApi(ctx, async ({ get, head, put, tokens }) => {
      // the hosted buckets are private, so an anonymous GET must not be able to
      // walk them and read patients' signatures
      const missing = await get('signatures/never-uploaded.png', { token: null });
      errorBody(missing, 401, 'UNAUTHORIZED');
      errorBody(await get('signatures/never-uploaded.png', { token: tokens.roleless }), 403, 'NO_ROLE');
      // a HEAD carries no body, so its guard can only be asserted by status
      assert.equal((await head('signatures/never-uploaded.png', { token: null })).status, 401);

      // signed in, but nothing by that name — the envelope, not express HTML
      errorBody(await get('signatures/never-uploaded.png'), 404, 'NOT_FOUND');
      assert.equal((await head('signatures/never-uploaded.png')).status, 404);

      // the path rules guard the read side too
      errorBody(await get('nope/x.png'), 400, 'BAD_BUCKET');
      errorBody(await get('signatures/../../etc/passwd'), 400, 'BAD_PATH');

      // an object uploaded into exports is reachable there (per-bucket storage,
      // no cross-bucket reads by accident)
      assert.equal((await put('exports/report.csv', Buffer.from('a,b\n1,2\n'), { headers: { 'content-type': 'text/csv' } })).status, 200);
      errorBody(await get('signatures/report.csv'), 404, 'NOT_FOUND');
    }),
  },
  {
    name: 'the exports bucket and a media type with a charset parameter',
    fn: async (ctx) => withApi(ctx, async ({ put, get, row }) => {
      const csv = Buffer.from('name,amount\nAda,22.00\n', 'utf8');
      // "; charset=utf-8" is the same declared type — the route canonicalises it
      const res = await put('exports/billing/2026-03.csv', csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
      assert.deepEqual(res.json, { Path: 'exports/billing/2026-03.csv' });

      const fetched = await get('exports/billing/2026-03.csv');
      assert.equal(fetched.status, 200);
      assert.ok(fetched.body.equals(csv));
      assert.match(fetched.headers['content-type'] ?? '', /^text\/csv/); // stored canonical form, no charset surprise
      assert.equal((await row('exports', 'billing/2026-03.csv')).mime, 'text/csv');
    }),
  },
];
