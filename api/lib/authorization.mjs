// api/lib/authorization.mjs — the ported RLS matrix (task t7, S32).
//
// Once self-hosted there is no `auth.uid()`, no `authenticated`/`anon` role and
// no policy SQL, so the rules that used to live in Postgres live here — in the
// only component that can reach the database. This file is the whole
// authorization surface: `can()` decides whether a verb is allowed at all, and
// `predicate()` supplies the row restriction that used to be a policy's
// USING / WITH CHECK clause. api/routes/query.mjs ANDs that predicate into every
// statement it builds, for reads and for writes, exactly as RLS did.
//
// The matrix below transcribes the policies still live in the hosted project,
// in the state the migrations left them in (a policy only stops applying when a
// later migration drops it — none of them drop appointments or invoice_items):
//
//   20250811055059 / 055731 / 060241  the core set: "… by authenticated" on
//        clinic_settings (select, update) and all four verbs on patients,
//        appointments, visit_notes, services, invoices, invoice_items, payments;
//   20250811062807 / 063208 / 063743  user_roles gains "Read own roles"
//        (user_id = auth.uid()); clinic_settings update narrowed to admin;
//        services insert/update/delete narrowed to admin;
//   20250812125955  patients narrowed: admin gets all four verbs; staff read and
//        update only patients the clinic has booked; staff insert stays allowed;
//        no staff delete ("intentionally omitted for data protection");
//   20250812130142  visit_notes narrowed the same way, staff scoped to rows whose
//        appointment exists; no staff delete;
//   20250812130321  invoices and payments narrowed: admin all four verbs; staff
//        reads/writes scoped through invoices.appointment_id and
//        payments.invoice_id -> invoices -> appointments; no staff delete;
//   20250812182051  services reads opened to `anon` for show_on_landing rows and
//        to any authenticated caller for all rows;
//   20250812203349  user_roles insert/update/delete admin-only.
//
// Where the hosted policies differ between USING (which rows you may touch) and
// WITH CHECK (what a written row must look like) — invoices for staff — this
// file carries both fragments: applying only one would either hide rows the page
// is allowed to update or let a caller move a row out of its scope.
//
// Anonymous traffic is deliberately not modelled as "a caller with no role":
// `can(null, …)` is always false, and the only two shapes open to `anon` are the
// explicit allow-list in `anonAllow()` — reading the landing-page services (with
// the row predicate the hosted policy enforces) and inserting a patient from the
// intake dialog. Everything else is a 401 before it reaches a table.
//
// Roles are the app_role enum (admin, moderator, user). Every live policy asks
// either for `admin` or for "authenticated", so that is what is ported: a
// moderator is staff, exactly as a moderator is staff in the hosted project.

export const TABLES = Object.freeze([
  'clinic_settings', 'patients', 'appointments', 'visit_notes', 'services',
  'invoices', 'invoice_items', 'payments', 'user_roles',
  'expenses', 'booking_requests',
]);
export const VERBS = Object.freeze(['select', 'insert', 'update', 'delete']);

// --- SQL helpers ------------------------------------------------------------

// ref(alias, column): a quoted "alias"."column" reference. `alias` and `column`
// are never caller-supplied text: they come from this file and from the
// catalog-validated table/column names in the route.
function ref(alias, column) {
  return `"${String(alias).replace(/"/g, '""')}"."${String(column).replace(/"/g, '""')}"`;
}

// The staff row restrictions, as functions of the alias the row-under-test
// carries in the statement they are pasted into (the table name for reads and
// deletes; the returning-CTE name for the WITH CHECK of a write).

// The row's own appointment must exist (invoices, visit_notes).
function appointmentExists(column = 'appointment_id') {
  return (alias) => ({
    sql: `exists (select 1 from "public"."appointments" as "hh_appt"
                   where "hh_appt"."id" = ${ref(alias, column)})`,
    params: [],
  });
}

// The patient must be someone the clinic has booked (patients).
function patientHasAppointment() {
  return (alias) => ({
    sql: `exists (select 1 from "public"."appointments" as "hh_appt"
                   where "hh_appt"."patient_id" = ${ref(alias, 'id')})`,
    params: [],
  });
}

// The payment's invoice must belong to an appointment (payments).
function paymentInvoiceHasAppointment() {
  return (alias) => ({
    sql: `exists (select 1 from "public"."invoices" as "hh_inv"
                   join "public"."appointments" as "hh_appt" on "hh_appt"."id" = "hh_inv"."appointment_id"
                   where "hh_inv"."id" = ${ref(alias, 'invoice_id')})`,
    params: [],
  });
}

// invoices for staff: the row must keep an appointment, or have none at all —
// the WITH CHECK half of "Staff can update/insert invoices for appointments".
function appointmentOrNull() {
  return (alias) => ({
    sql: `(${ref(alias, 'appointment_id')} is null
           or exists (select 1 from "public"."appointments" as "hh_appt"
                       where "hh_appt"."id" = ${ref(alias, 'appointment_id')}))`,
    params: [],
  });
}

// services, anonymous read: the policy's own USING clause.
function landingOnly() {
  return (alias) => ({ sql: `${ref(alias, 'show_on_landing')} = true`, params: [] });
}

// --- the matrix -------------------------------------------------------------
//
// Per (table, verb):
//   null                        -> no live policy: denied to everyone
//   { role: 'any' }             -> any signed-in user, every row
//   { role: 'admin' }           -> admin only, every row
//   { role: 'self' }            -> signed-in, only one's own rows (user_roles)
// and, for a role 'any' policy that narrows staff:
//   { staff: { using, check } } -> the two fragments above (check defaults to
//                                  using when the hosted policy used one form)

const ANY = Object.freeze({ role: 'any' });
const ADMIN = Object.freeze({ role: 'admin' });
// admin + moderator (billing / front office): the finance tables.
const FINANCE = Object.freeze({ role: 'roles', roles: Object.freeze(['admin', 'moderator']) });

// staffScope(using, check?): the two fragments of a staff-narrowed policy.
const staffScope = (using, check = null) => Object.freeze({ using: [using], check: check ? [check] : [using] });

export const POLICIES = Object.freeze({
  clinic_settings: Object.freeze({
    select: ANY, // "Settings readable by authenticated"
    update: ADMIN, // "Settings updatable by admin"
    insert: null, // never a policy -> denied to everyone, admin included
    delete: null,
  }),
  patients: Object.freeze({
    // 20250812125955
    select: Object.freeze({ role: 'any', staff: staffScope(patientHasAppointment()) }),
    insert: ANY, // staff: WITH CHECK (not has_role(admin)) -> every row
    update: Object.freeze({ role: 'any', staff: staffScope(patientHasAppointment()) }),
    delete: ADMIN,
  }),
  appointments: Object.freeze({
    // "Appointments … by authenticated" — the core policies, never dropped.
    select: ANY, insert: ANY, update: ANY, delete: ANY,
  }),
  visit_notes: Object.freeze({
    // 20250812130142
    select: Object.freeze({ role: 'any', staff: staffScope(appointmentExists()) }),
    insert: Object.freeze({ role: 'any', staff: staffScope(appointmentExists()) }),
    update: Object.freeze({ role: 'any', staff: staffScope(appointmentExists()) }),
    delete: ADMIN,
  }),
  services: Object.freeze({
    // 20250812182051: `anon` sees the landing rows, any session sees all of them.
    select: Object.freeze({ role: 'any', anon: landingOnly() }),
    insert: ADMIN, // "Services insert by admin"
    update: ADMIN,
    delete: ADMIN,
  }),
  invoices: Object.freeze({
    // 20250812130321: USING requires the appointment to exist; WITH CHECK only
    // requires it to exist *or be absent*.
    select: Object.freeze({ role: 'any', staff: staffScope(appointmentExists()) }),
    insert: Object.freeze({ role: 'any', staff: staffScope(appointmentOrNull(), appointmentOrNull()) }),
    update: Object.freeze({ role: 'any', staff: staffScope(appointmentExists(), appointmentOrNull()) }),
    delete: ADMIN,
  }),
  invoice_items: Object.freeze({
    // "Invoice items … by authenticated" — the core policies, never dropped.
    select: ANY, insert: ANY, update: ANY, delete: ANY,
  }),
  payments: Object.freeze({
    // 20250812130321
    select: Object.freeze({ role: 'any', staff: staffScope(paymentInvoiceHasAppointment()) }),
    insert: Object.freeze({ role: 'any', staff: staffScope(paymentInvoiceHasAppointment()) }),
    update: Object.freeze({ role: 'any', staff: staffScope(paymentInvoiceHasAppointment()) }),
    delete: ADMIN, // "Only admins can delete payments (to preserve financial audit trail)"
  }),
  user_roles: Object.freeze({
    // "Read own roles" (20250811063743). Reads stay self-scoped for everyone,
    // admin included; only the realtime feed widens this for admin, because
    // its only user_roles subscriber is the admin-only Users panel
    // (see streamPredicate below).
    select: Object.freeze({ role: 'self' }),
    insert: ADMIN, // 20250812203349
    update: ADMIN,
    delete: ADMIN,
  }),
  expenses: Object.freeze({
    // The hosted policy allowed any session; Hearth narrows expenses to the
    // finance roles (the same roles the navigation shows the page to), and
    // keeps deletion for admins, like payments.
    select: FINANCE,
    insert: FINANCE,
    update: FINANCE,
    delete: ADMIN,
  }),
  booking_requests: Object.freeze({
    // Staff read them through /api/query (the review page and its realtime
    // feed); every write goes through api/routes/booking-requests.mjs (public
    // submit, approve, decline), never through the generic route.
    select: ANY,
    insert: null,
    update: null,
    delete: null,
  }),
});

// --- the anonymous allow-list ------------------------------------------------
// The only shape served to `anon`: the landing-page services. (The hosted app
// also let anyone insert a patient from the booking form; Hearth does not —
// public booking requests go to booking_requests through a dedicated,
// rate-limited endpoint and never create a patient.) Widening this is a
// security change, not a convenience: each entry is data the public landing page
// is allowed to read or write today, and nothing more.
const ANON_ALLOW = Object.freeze({
  'services.select': landingOnly(),
});

export function anonAllow(table, verb = 'select') {
  return Object.prototype.hasOwnProperty.call(ANON_ALLOW, `${table}.${verb}`);
}

// anonPredicate(table, verb, alias): the row restriction the anonymous shape
// carries (the show_on_landing read), or null.
export function anonPredicate(table, verb = 'select', alias = table) {
  const entry = ANON_ALLOW[`${table}.${verb}`];
  if (!entry) return null;
  return entry(alias);
}

// --- the two calls the route makes ------------------------------------------

// isAdmin(user): the only role question any live policy asks.
export function isAdmin(user) {
  return Boolean(user && Array.isArray(user.roles) && user.roles.includes('admin'));
}

export function isStaff(user) {
  return Boolean(user && Array.isArray(user.roles) && user.roles.length > 0 && !isAdmin(user));
}

// can(user, table, verb) -> boolean.
// A null caller is always false: the anonymous path is anonAllow(), never this.
export function can(user, table, verb) {
  const policy = policyFor(table, verb);
  if (!policy) return false;
  if (!user || !user.id) return false;
  if (policy.role === 'admin') return isAdmin(user);
  if (policy.role === 'roles') return Array.isArray(user.roles) && user.roles.some((r) => policy.roles.includes(r));
  return true; // 'any' and 'self' both just need a session (roles already checked)
}

function policyFor(table, verb) {
  if (typeof table !== 'string' || typeof verb !== 'string') return null;
  const byVerb = POLICIES[table];
  if (!byVerb) return null;
  // hasOwnProperty: a caller naming 'constructor' or '__proto__' must not find a
  // policy on Object.prototype.
  if (!Object.prototype.hasOwnProperty.call(byVerb, verb)) return null;
  return byVerb[verb];
}

// predicate(user, table, verb, {alias, when}) -> {sql, params} | null
//
// The fragment to AND into the statement, with its own $1..$n parameters that
// the route rebases into the statement's parameter list. `alias` names the row
// under test; `when` is 'using' (which existing rows may be read or touched) or
// 'check' (what a written row must look like). null means "no row restriction".
export function predicate(user, table, verb, { alias = table, when = 'using' } = {}) {
  const policy = policyFor(table, verb);
  if (!policy) return null;

  if (policy.role === 'self') {
    // "Read own roles": user_id = auth.uid(), bound as a parameter.
    return { sql: `${ref(alias, 'user_id')} = $1`, params: [user?.id ?? null] };
  }
  if (policy.role === 'admin' || policy.role === 'roles') return null; // every row, for a caller that passed can()
  if (isAdmin(user)) return null; // staff scoping does not apply to an admin
  if (policy.staff) {
    const list = when === 'check' ? policy.staff.check : policy.staff.using;
    return combine(list.map((make) => make(alias)), ' and ');
  }
  return null;
}

// An anonymous read never has a user, so the caller asks for it by name.
export function readPredicate(user, table, verb, options = {}) {
  if (!user) return anonPredicate(table, verb, options.alias ?? table);
  return predicate(user, table, verb, options);
}

// streamPredicate(user, table, verb, options): the row scoping for the realtime
// feed (api/routes/realtime.mjs). It is the read predicate with exactly one
// widening: an ADMIN is not row-scoped on user_roles.
//
// Why: the only page subscribed to user_roles is the admin Users panel in
// AdminSettings.tsx, and that panel lists every user through
// get_users_with_roles — a SECURITY DEFINER function an admin may call. Keeping
// that subscription at the "Read own roles" scope would never let it see the
// grants it exists to watch: an admin adding a user would get no event and the
// panel would sit stale until a reload. Telling an admin about a grant leaks
// nothing either — the same row is already in their rpc list. A direct
// /api/query select on user_roles keeps the self-scope unchanged: this decides
// who is told about a change, not what may be read.
export function streamPredicate(user, table, verb, options = {}) {
  if (table === 'user_roles' && isAdmin(user)) return null;
  return readPredicate(user, table, verb, options);
}

// combine(fragments, joiner): {sql, params} for several fragments.
function combine(fragments, joiner) {
  const kept = fragments.filter((f) => f && f.sql);
  if (kept.length === 0) return null;
  let sql = '';
  let params = [];
  let count = 0;
  for (const fragment of kept) {
    count += 1;
    const local = renumber(fragment, params.length);
    sql += `${count > 1 ? `${joiner} ` : ''}(${local.sql})`;
    params = params.concat(local.params);
  }
  return { sql, params };
}

// renumber(fragment, offset): shift a fragment's $n up by `offset` so that
// independently-written fragments share one statement's parameter list.
export function renumber(fragment, offset) {
  if (offset <= 0) return { sql: fragment.sql, params: [...fragment.params] };
  return {
    sql: fragment.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + offset}`),
    params: [...fragment.params],
  };
}

// denyReason(user, table, verb): the message the 403 carries. Specific enough
// for a page to explain itself, generic enough not to enumerate the schema.
export function denyReason(user, table, verb) {
  if (!VERBS.includes(verb)) return `${JSON.stringify(verb)} is not a supported verb`;
  const policy = policyFor(table, verb);
  if (!policy) return `this API does not allow ${verb === undefined ? 'that' : verb} on ${String(table)}`;
  if (policy.role === 'admin') return `${table} ${verb} needs the admin role`;
  if (policy.role === 'roles') return `${table} ${verb} needs one of the roles ${policy.roles.join(', ')}`;
  if (policy.role === 'self') return `${table} ${verb} is limited to your own rows`;
  return `${table} ${verb} is not permitted for this account`;
}

export default { can, predicate, readPredicate, streamPredicate, anonAllow, anonPredicate, denyReason, POLICIES, TABLES, VERBS };
