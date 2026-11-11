// api/lib/format.mjs — the calendar and clock the shipped edge functions ran
// on, pinned so the port is the same characters everywhere (task t10).
//
// The Supabase function wrote the CSV Date cells and the e-mail `Date:` line
// with bare `new Date(...).toLocaleDateString()` / `.toLocaleTimeString()`:
// whatever the runtime's locale and time zone happened to be. On the hosted
// Deno runtime (en-US, UTC) an invoice created at 2025-08-05T14:30:00Z read
// `8/5/2025` and `2:30:00 PM` — but the same code self-hosted on a machine in
// another locale or zone would print `05/08/2025` or `4:30:00 PM` and quietly
// change what the QuickBooks import and the invoice e-mail show.
//
// These two functions pin exactly what the hosted runtime produced: the en-US
// short date and the en-US medium time, always computed in UTC —
//
//   legacyDate('2025-08-05T14:30:00Z') === '8/5/2025'
//   legacyTime('2025-08-05T14:30:00Z') === '2:30:00 PM'
//
// regardless of the process TZ or locale (the contract tests pin TZ=UTC for
// the reference builders as well, so the old-vs-new comparison is
// environment-independent). The CSV Date cells, the invoice HTML `Date:` line
// and the receipt's Date/Time rows all go through these; the legacy reference
// builders in tests/legacy/ call them in place of toLocaleDateString/Time.
//
// null/undefined/'Invalid Date' produce the empty string — the legacy code
// would have printed 'Invalid Date', which no contract fixture pins; the
// callers all feed NOT NULL columns.

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'numeric',
  day: 'numeric',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// legacyDate(isoOrDate): the en-US short date in UTC — '8/5/2025'.
export function legacyDate(value) {
  const d = toDate(value);
  return d ? DATE_FORMAT.format(d) : '';
}

// legacyTime(isoOrDate): the en-US medium time in UTC — '2:30:00 PM'.
export function legacyTime(value) {
  const d = toDate(value);
  return d ? TIME_FORMAT.format(d) : '';
}
