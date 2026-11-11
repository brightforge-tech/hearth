// src/integrations/supabase/shim/realtime.ts — the `supabase.channel(...)` half
// of the supabase-js surface (task t8), over the self-hosted realtime route
// instead of a websocket.
//
// Transport: the API streams change events as Server-Sent Events from
//   GET /api/realtime?tables=appointments,services&filter=appointments:id=eq.<uuid>
// one JSON object per `data:` line, shaped
//   { "id": ..., "table": "appointments", "action": "INSERT",
//     "record_id": "...", "payload": { record?, old_record? ... } }
// and the shim reads those lines off one long-lived fetch.
//
// ONE CONNECTION PER PAGE, not one per channel. A browser allows only six
// concurrent connections to one origin over HTTP/1.1, and a long-lived stream
// holds one of them open for as long as the page lives. The pages here open
// four channels at once (AdminSettings.tsx), and the milestone's acceptance
// criteria run two of them side by side: with a stream per channel the browser
// spends its whole connection budget on streams, and the page's own sign-in,
// upload and query fetches — a second tab's document above all — queue behind
// them and time out. So all channels of one client share a single stream: the
// union of their tables and filters is requested once, and each event is
// fanned out to the bindings that asked for it (re-checked client-side, so the
// server-side filter is an optimisation, never the guarantee).
//
// Robustness rules, learned from the old client's behavior on flaky links:
// reconnect with capped exponential backoff, resume from the outbox watermark
// (`since=`) instead of silently skipping what changed while the link was down,
// and stop permanently on 401/403 (a token that can no longer read the stream
// will not get better by retrying) until the next subscribe(), which means a
// new session or a new page.

type ChangeHandler = (payload: {
  eventType: string;
  schema: string;
  table: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
  commit_timestamp: string;
  id: unknown;
}) => void;

interface Binding {
  event: string; // '*', 'INSERT', 'UPDATE', 'DELETE'
  schema: string;
  table: string;
  filter?: string; // 'col=op.value', e.g. `id=eq.${uuid}`
  callback: ChangeHandler;
}

interface ShimChannel {
  on(type: 'postgres_changes', binding: { event?: string; schema?: string; table: string; filter?: string }, callback: ChangeHandler): ShimChannel;
  subscribe(statusCallback?: (status: string) => void): ShimChannel;
  /** internal: the realtime client's removeChannel() stops the channel. */
  [STOP]: () => void;
}

const STOP = Symbol('shim.stop');

// The tables the self-hosted stream carries — api/routes/realtime.mjs's
// TABLE_ALLOW. A `table: '*'` binding asks for all of them.
const STREAMED_TABLES = Object.freeze([
  'appointments',
  'services',
  'invoices',
  'payments',
  'clinic_settings',
  'patients',
  'visit_notes',
  'user_roles',
  'expenses',
  'booking_requests',
]);

const compare = (left: unknown, op: string, right: string): boolean => {
  // PostgREST compares text values against JSON numbers by coercing; we only
  // need the handful of shapes the pages' filters produce (ids, dates).
  const asNum = Number(right);
  const l = typeof left === 'object' && left !== null ? JSON.stringify(left) : String(left);
  const r = Number.isNaN(asNum) ? right : String(asNum);
  switch (op) {
    case 'eq': return l === r;
    case 'neq': return l !== r;
    case 'gt': return l > r;
    case 'gte': return l >= r;
    case 'lt': return l < r;
    case 'lte': return l <= r;
    default: return true; // unknown op: let the server-side filter decide
  }
};

const matchesFilter = (filter: string, record: Record<string, unknown>): boolean => {
  // Filters on this page come as a single `col=op.value` term; support that
  // plus dot-free `.and.`-joined terms defensively.
  return filter.split('.and.').every((term) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(term) ??
      /^([A-Za-z_][A-Za-z0-9_]*)=(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(term);
    if (!m) return true;
    return compare(record?.[m[1]] ?? null, m[2], m[3]);
  });
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRealtimeClient({
  baseUrl,
  getToken,
  fetch: fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  getToken(): string | null;
  fetch?: typeof globalThis.fetch;
}) {
  interface LiveChannel {
    bindings: Binding[];
    statusCb?: (status: string) => void;
    stopped: boolean;
  }

  /** every channel that has subscribed and not been removed */
  const live = new Set<LiveChannel>();

  /** the query string the current stream carries ('' = no stream) */
  let signature = '';
  /** the outbox id to resume the next stream from, once one is known */
  let resumeAt: number | null = null;
  /** bumped by every (re)configuration: only the newest loop may keep running */
  let generation = 0;
  /** the in-flight fetch of the newest loop, so configure() can cancel it */
  let controller: AbortController | null = null;
  /** 401/403: no more retries until something subscribes again */
  let authStopped = false;
  /** coalesces the several subscribe() calls one page effect makes */
  let pending: ReturnType<typeof setTimeout> | null = null;

  const notify = (status: string) => {
    for (const channel of live) channel.statusCb?.(status);
  };

  // desiredQuery(): what the stream must carry now — the union of every live
  // channel's tables, plus every filter any of them asked for, each
  // table-qualified so the single request can carry them all (the route takes
  // repeated filter= parameters for exactly this).
  const desiredQuery = (): string | null => {
    const tables = new Set<string>();
    const filters = new Set<string>();
    for (const channel of live) {
      for (const binding of channel.bindings) {
        if (binding.table === '*') STREAMED_TABLES.forEach((table) => tables.add(table));
        else tables.add(binding.table);
        if (binding.filter) filters.add(`${binding.table}:${binding.filter}`);
      }
    }
    if (tables.size === 0) return null;
    let query = `tables=${[...tables].sort().join(',')}`;
    // sorted so the signature is stable, and equal queries are never reopened
    for (const filter of [...filters].sort()) query += `&filter=${encodeURIComponent(filter)}`;
    return query;
  };

  const cancelInFlight = () => {
    const inFlight = controller;
    controller = null;
    inFlight?.abort();
  };

  // configure(): reopen the stream if what the channels want has changed. On a
  // tick's delay, so the four channels one effect subscribes to become ONE
  // request rather than four.
  const configure = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const query = desiredQuery();
      if (query === null) {
        generation += 1; // tells the running loop to stop
        cancelInFlight();
        signature = '';
        return;
      }
      if (query === signature) return; // already carrying exactly this
      authStopped = false;
      generation += 1;
      cancelInFlight();
      signature = query;
      void run(query, generation);
    }, 0);
  };

  // run(): the one stream. `my` is this loop's generation: as soon as it is
  // stale the loop exits, which is how a reconfiguration ends the old stream
  // without a flag race and without ever having two live streams.
  const run = async (initialQuery: string, my: number) => {
    let backoff = 500;
    while (my === generation && !authStopped) {
      controller = new AbortController();
      const since = resumeAt !== null ? `&since=${resumeAt}` : '';
      try {
        const token = getToken();
        const res = await fetchImpl(`${baseUrl}/api/realtime?${initialQuery}${since}`, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 403) {
          // Auth is dead for this stream; retrying cannot help. The pages
          // notice through their normal query refetches instead.
          authStopped = true;
          notify('CHANNEL_ERROR');
          break;
        }
        if (!res.ok || !res.body) throw new Error(`realtime stream answered ${res.status}`);
        notify('SUBSCRIBED');
        backoff = 500;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            // A comment frame names the watermark this stream starts at
            // (`: realtime stream on appointments,payments cursor=17`). Keeping
            // it means a reconnect — or a channel appearing mid-session —
            // resumes from there instead of jumping to the queue's new
            // high-water mark and losing what changed in between.
            for (const line of raw.split('\n')) {
              const cursor = /(?:^:\s).*\bcursor=(\d{1,19})/.exec(line);
              if (cursor) noteWatermark(Number(cursor[1]));
            }
            const data = raw
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n');
            if (!data || data === '[DONE]') continue;
            let evt: any;
            try { evt = JSON.parse(data); } catch { continue; } // malformed frame
            if (!evt?.table) continue;
            if (typeof evt.id === 'number') noteWatermark(evt.id);
            deliver(evt);
          }
        }
        if (my !== generation || authStopped) break;
        notify('DISCONNECTED');
        await delay(1000); // the server closed a healthy stream: come back soon
      } catch (err) {
        if (my !== generation || authStopped) break;
        // an abort from configure()/removeChannel() is not a fault: the newest
        // loop is already on its way, so this one just ends
        if ((err as { name?: string })?.name === 'AbortError') break;
        notify('DISCONNECTED');
        await delay(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    if (my === generation) {
      signature = '';
      controller = null;
    }
  };

  const noteWatermark = (id: number) => {
    if (!Number.isSafeInteger(id) || id < 0) return;
    if (resumeAt === null || id > resumeAt) resumeAt = id;
  };

  // deliver(): hand one stream event to every binding that asked for it. The
  // re-check here is what makes the single shared stream safe: a page only ever
  // sees the events its own binding described.
  const deliver = (evt: any) => {
    const action = String(evt.action ?? 'INSERT').toUpperCase();
    const payload = evt.payload ?? {};
    const message = {
      id: evt.id ?? null,
      schema: 'public',
      table: evt.table,
      eventType: action,
      new: action === 'DELETE' ? {} : (payload.record ?? payload ?? {}),
      old: action === 'DELETE' ? (payload.old_record ?? payload.record ?? payload ?? {}) : (payload.old_record ?? {}),
      commit_timestamp: payload.timestamp ?? new Date().toISOString(),
    };
    for (const channel of live) {
      for (const b of channel.bindings) {
        if (b.table !== '*' && b.table !== message.table) continue;
        if (b.event !== '*' && b.event !== message.eventType) continue;
        if (b.filter) {
          const record = message.eventType === 'DELETE' ? message.old : message.new;
          if (!matchesFilter(b.filter, record as Record<string, unknown>)) continue;
        }
        try { b.callback(message); } catch { /* a page handler blowing up must not kill the stream */ }
      }
    }
  };

  return {
    channel(_name: string): ShimChannel {
      const record: LiveChannel = { bindings: [], stopped: false };
      let stopped = false;

      const channel: ShimChannel = {
        on(_type: 'postgres_changes', binding, callback) {
          if (_type !== 'postgres_changes') return channel; // nothing else exists server-side
          if (stopped) return channel;
          record.bindings.push({
            event: binding.event ?? '*',
            schema: binding.schema ?? 'public',
            table: binding.table,
            filter: binding.filter,
            callback,
          });
          return channel;
        },

        subscribe(statusCallback?) {
          record.statusCb = statusCallback;
          live.add(record);
          authStopped = false; // a new page or a fresh sign-in gets a fresh try
          configure();
          return channel;
        },

        [STOP]() {
          stopped = true;
          record.stopped = true;
          record.bindings = [];
          live.delete(record);
          configure();
        },
      };
      return channel;
    },

    removeChannel(channel: ShimChannel) {
      channel?.[STOP]?.();
      return { data: null, error: null } as const; // supabase-js returns this; no page reads it
    },
  };
}
