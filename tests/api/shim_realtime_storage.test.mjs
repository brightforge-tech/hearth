// tests/api/shim_realtime_storage.test.mjs — the realtime and storage halves
// of the t8 shim, against local stub servers instead of api/server.mjs.
//
// Why stubs: the routes these shims target — GET /api/realtime (SSE) and
// PUT /api/storage/<bucket>/<path> — are task t9's deliverable. What t8 owns
// is the CLIENT behavior against their documented contract: the query string
// the stream is opened with, event filtering, reconnect vs. stop rules,
// channel teardown, and the exact bytes/headers of an upload. A stub is the
// only way to pin those before the server side exists, and it survives t9
// landing because it pins the contract, not our implementation of it.

import assert from 'node:assert/strict';
import http from 'node:http';

let shim = null;
async function loadShim() {
  if (!shim) shim = await import('../../src/integrations/supabase/client.ts');
  return shim;
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

// startStub(handler) -> {port, close()}: an http server on a free port.
function startStub(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A client whose auth token is 'stub-token', without touching a login route.
function clientWithToken(baseUrl) {
  const storage = fakeStorage({ 'hh.session': JSON.stringify({ access_token: 'stub-token', user: { id: 'u', email: 'x@t8.test' } }) });
  globalThis.localStorage = storage;
  const mod = shim;
  const client = mod.createSupabaseClient({ baseUrl });
  globalThis.localStorage = undefined;
  return client;
}

// --- the cases -----------------------------------------------------------------

export default [
  {
    name: 'T8.14 realtime subscribe: tables+filter query string, table/event/filter delivery, junk lines ignored',
    fn: async () => {
      const mod = await loadShim();
      void mod;
      const APPT = '00000000-0000-4000-8000-000000000003';
      const seen = [];
      const held = [];
      const stub = await startStub((req, res) => {
        const u = new URL(req.url, 'http://stub');
        seen.push({ path: u.pathname, tables: u.searchParams.get('tables'), filter: u.searchParams.get('filter'), auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(':ping\n\n'); // SSE comment line: must be ignored
        res.write('data: this is not json\n\n'); // malformed: must be ignored
        res.write(`data:${JSON.stringify({ id: 1, table: 'appointments', action: 'INSERT', record_id: 'match', payload: { record: { id: APPT, status: 'waiting' } } })}\n\n`);
        res.write(`data:${JSON.stringify({ id: 2, table: 'appointments', action: 'UPDATE', record_id: 'other', payload: { record: { id: 'other-appt', status: 'done' } } })}\n\n`);
        res.write(`data:${JSON.stringify({ id: 3, table: 'services', action: 'DELETE', record_id: 's', payload: { old_record: { id: 's' } } })}\n\n`);
        held.push(res);
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        const apptEvents = [];
        const svcEvents = [];
        const statuses = [];
        const channel = client
          .channel('queue-updates')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `id=eq.${APPT}` }, (p) => apptEvents.push(p))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, (p) => svcEvents.push(p))
          .subscribe((status) => statuses.push(status));
        void channel;

        await sleep(500); // let the stream open and all buffered events land

        assert.equal(seen.length, 1, `expected exactly one stream request, saw ${seen.length}`);
        assert.equal(seen[0].path, '/api/realtime');
        assert.equal(seen[0].tables, 'appointments,services');
        assert.equal(seen[0].filter, `appointments:id=eq.${APPT}`);
        assert.equal(seen[0].auth, 'Bearer stub-token', 'the stream must carry the session token');
        assert.ok(statuses.includes('SUBSCRIBED'), `expected a SUBSCRIBED status, got ${JSON.stringify(statuses)}`);

        assert.equal(apptEvents.length, 1, `the row-filter must drop non-matching records, got ${JSON.stringify(apptEvents)}`);
        assert.equal(apptEvents[0].eventType, 'INSERT');
        assert.equal(apptEvents[0].table, 'appointments');
        assert.equal(apptEvents[0].new.id, APPT);
        assert.equal(svcEvents.length, 1);
        assert.equal(svcEvents[0].eventType, 'DELETE');
        assert.equal(svcEvents[0].old.id, 's', 'DELETE must expose the old record as .old');
      } finally {
        for (const res of held) res.end();
        await stub.close();
      }
    },
  },

  {
    name: 'T8.15 realtime removeChannel: the page effect-cleanup stops the stream (server sees the close)',
    fn: async () => {
      await loadShim();
      let reqClosed;
      const closed = new Promise((r) => { reqClosed = r; });
      const stub = await startStub((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data:{"table":"appointments","action":"INSERT","payload":{"record":{"id":"1"}}}\n\n');
        req.on('close', reqClosed);
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        const got = [];
        const channel = client
          .channel('t')
          .on('postgres_changes', { event: '*', table: 'appointments' }, (p) => got.push(p))
          .subscribe();

        await sleep(300);
        assert.equal(got.length, 1);

        client.removeChannel(channel); // exactly what the pages' useEffect cleanup calls
        await Promise.race([closed, sleep(3000).then(() => { throw new Error('server never saw the stream close'); })]);

        // a post-teardown push must not reach the page
        const before = got.length;
        assert.equal(client.removeChannel(channel).error, null, 'removeChannel is idempotent');
        await sleep(200);
        assert.equal(got.length, before);
      } finally {
        await stub.close();
      }
    },
  },

  {
    name: 'T8.16 realtime auth refusal stops retrying (401 -> CHANNEL_ERROR, no reconnect storm)',
    fn: async () => {
      await loadShim();
      let attempts = 0;
      const stub = await startStub((req, res) => {
        attempts += 1;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }));
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        const statuses = [];
        client
          .channel('t')
          .on('postgres_changes', { event: '*', table: 'patients' }, () => {})
          .subscribe((s) => statuses.push(s));

        await sleep(900); // backoff starts at 500ms: a retry storm would show several attempts
        assert.equal(attempts, 1, `401 must stop the loop, saw ${attempts} attempts`);
        assert.ok(statuses.includes('CHANNEL_ERROR'), `expected CHANNEL_ERROR, got ${JSON.stringify(statuses)}`);
      } finally {
        await stub.close();
      }
    },
  },

  {
    name: 'T8.17 storage upload: PUT bytes/bucket/path with content-type and x-upsert (the Visit.tsx signature flow)',
    fn: async () => {
      await loadShim();
      const seen = [];
      const stub = await startStub((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          seen.push({
            method: req.method,
            url: req.url,
            contentType: req.headers['content-type'],
            upsert: req.headers['x-upsert'],
            auth: req.headers.authorization,
            body: Buffer.concat(chunks),
          });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ bucket: 'signatures', path: 'appointment_1/1700.png' }));
        });
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
        const { data, error } = await client.storage
          .from('signatures')
          .upload('appointment_1/1700.png', new Blob([png]), { contentType: 'image/png', upsert: true });

        assert.equal(error, null, `upload failed: ${JSON.stringify(error)}`);
        assert.equal(data.fullPath, 'signatures/appointment_1/1700.png'); // the page stores this on the visit note

        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, 'PUT');
        assert.equal(seen[0].url, '/api/storage/signatures/appointment_1/1700.png');
        assert.equal(seen[0].contentType, 'image/png');
        assert.equal(seen[0].upsert, 'true');
        assert.equal(seen[0].auth, 'Bearer stub-token');
        assert.deepEqual(seen[0].body, Buffer.from(png), 'the raw upload bytes must arrive untouched');
      } finally {
        await stub.close();
      }
    },
  },

  {
    name: 'T8.18 storage error mapping (envelope -> {data: null, error}) and getPublicUrl encoding',
    fn: async () => {
      await loadShim();
      const stub = await startStub((req, res) => {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'the signature exceeds the 10MB limit', code: 'PAYLOAD_TOO_LARGE' } }));
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        const { data, error } = await client.storage.from('signatures').upload('big.png', new Blob([new Uint8Array(10)]), { contentType: 'image/png' });
        assert.equal(data, null);
        assert.ok(error instanceof Error, 'Visit.tsx does `if (upErr) throw upErr` — must be throw-able');
        assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
        assert.ok(error.message.includes('10MB'));

        assert.equal(
          client.storage.from('signatures').getPublicUrl('patient one/report a.png').data.publicUrl,
          `http://127.0.0.1:${stub.port}/api/storage/signatures/patient%20one/report%20a.png`
        );
      } finally {
        await stub.close();
      }
    },
  },

  {
    // The two-tab pages (W33/W34) only work if a page holds ONE stream: a
    // browser allows six concurrent connections per origin over HTTP/1.1, so
    // AdminSettings' four channels as four long-lived streams starve the tab's
    // own fetches and a second tab never finishes loading. This pins the
    // multiplexing that replaced one-stream-per-channel.
    name: 'T8.19 all channels of one client share ONE stream, fan events out per binding, and teardown keeps the rest alive',
    fn: async () => {
      await loadShim();
      const seen = [];
      const streams = [];
      let closedCount = 0;
      const stub = await startStub((req, res) => {
        const u = new URL(req.url, 'http://stub');
        seen.push({ tables: u.searchParams.get('tables'), filter: u.searchParams.get('filter') });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => { closedCount += 1; });
        streams.push((event) => res.write(`data:${JSON.stringify(event)}\n\n`));
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        // exactly AdminSettings.tsx's four channels
        const settings = [];
        const services = [];
        const users = [];
        const patients = [];
        const channels = [
          client.channel('settings-updates').on('postgres_changes', { event: '*', schema: 'public', table: 'clinic_settings' }, (p) => settings.push(p)).subscribe(),
          client.channel('services-updates').on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, (p) => services.push(p)).subscribe(),
          client.channel('users-updates').on('postgres_changes', { event: '*', schema: 'public', table: 'user_roles' }, (p) => users.push(p)).subscribe(),
          client.channel('patients-updates').on('postgres_changes', { event: '*', schema: 'public', table: 'patients' }, (p) => patients.push(p)).subscribe(),
        ];

        await sleep(400);
        assert.equal(seen.length, 1, `four channels must share one stream, saw ${seen.length} stream requests`);
        assert.equal(seen[0].tables, 'clinic_settings,patients,services,user_roles', 'the stream carries the union of the channels\' tables');

        streams[0]({ table: 'user_roles', action: 'INSERT', payload: { record: { user_id: 'u1', role: 'user' } } });
        streams[0]({ table: 'services', action: 'UPDATE', payload: { record: { id: 's1' } } });
        await sleep(200);
        assert.equal(users.length, 1, 'the user_roles binding must receive the user_roles event');
        assert.equal(services.length, 1, 'the services binding must receive the services event');
        assert.equal(settings.length, 0, 'a binding must not receive another table\'s event');
        assert.equal(patients.length, 0);

        // tear one channel down: the others keep their events on the same stream
        client.removeChannel(channels[3]);
        await sleep(400);
        assert.equal(seen.length, 2, `removing a channel reconfigures the shared stream once, saw ${seen.length} requests`);
        assert.equal(seen[1].tables, 'clinic_settings,services,user_roles', 'the removed channel\'s table is gone from the stream');
        assert.ok(closedCount >= 1, 'the old stream must be closed, not left dangling');

        streams[1]({ table: 'patients', action: 'INSERT', payload: { record: { id: 'p1' } } });
        streams[1]({ table: 'user_roles', action: 'DELETE', payload: { old_record: { user_id: 'u1' } } });
        await sleep(200);
        assert.equal(patients.length, 0, 'a removed channel must stop receiving events');
        assert.equal(users.length, 2, 'the surviving channels must keep receiving events');

        // removing the rest closes the stream entirely: a page with no
        // subscription must not hold one of the six connections
        for (const channel of channels.slice(0, 3)) client.removeChannel(channel);
        await sleep(400);
        const before = seen.length;
        await sleep(400);
        assert.equal(seen.length, before, 'no channels left: no new stream may open');
        assert.ok(closedCount >= 2, 'the last stream must close when the last channel goes');
      } finally {
        await stub.close();
      }
    },
  },

  {
    // The reason `since=` exists on the route: a reconnect that jumps to the
    // queue's new high-water mark silently loses everything that changed while
    // the tab was offline.
    name: 'T8.20 a reconnect resumes with since=<outbox watermark> from the stream\'s own cursor line',
    fn: async () => {
      await loadShim();
      const seen = [];
      const held = [];
      const stub = await startStub((req, res) => {
        const u = new URL(req.url, 'http://stub');
        seen.push({ since: u.searchParams.get('since') });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': realtime stream on appointments cursor=17\n\n');
        held.push(res);
        // close the first stream from the server side so the client reconnects
        if (seen.length === 1) setTimeout(() => res.end(), 150);
      });
      try {
        const client = clientWithToken(`http://127.0.0.1:${stub.port}`);
        client.channel('queue-updates').on('postgres_changes', { event: '*', table: 'appointments' }, () => {}).subscribe();
        await until(() => seen.length >= 2, 8000, 'the client to reconnect after the server closed the stream');
        assert.equal(seen[0].since, null, 'the first stream has no watermark to resume from');
        assert.equal(seen[1].since, '17', `the reconnect must ask for since=17, saw ${JSON.stringify(seen[1].since)}`);
      } finally {
        for (const res of held) res.end();
        await stub.close();
      }
    },
  },
];

async function until(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
