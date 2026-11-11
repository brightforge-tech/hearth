// api/lib/audit.mjs — the append-only audit trail (public.audit_log).
//
// recordAudit() is the only writer. What goes in is deliberately small: who
// (id, e-mail, role), what (view/create/update/delete/export/login/
// login_failed/logout), which record (entity type + id), from where (IP), and
// a summary of FIELD NAMES or counts — never the values, so the audit log
// does not become a second copy of the patient record. There is no API path
// that updates or deletes audit rows, and the table's trigger refuses both
// (db/migrations/0009_security.sql).

import { query as poolQuery } from '../db.mjs';

export const AUDIT_ACTIONS = Object.freeze(['view', 'create', 'update', 'delete', 'export', 'login', 'login_failed', 'logout']);

// Tables whose writes are audited when they go through /api/query, mapped to
// the entity_type the log uses.
export const AUDITED_WRITE_TABLES = Object.freeze({
  patients: 'patient',
  appointments: 'appointment',
  visit_notes: 'visit_note',
  invoices: 'invoice',
  invoice_items: 'invoice_item',
  payments: 'payment',
  expenses: 'expense',
  user_roles: 'user_role',
  clinic_settings: 'settings',
  services: 'service',
});

// The highest role a caller holds, for the log's actor_role column.
export function primaryRole(user) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  for (const r of ['admin', 'moderator', 'user']) if (roles.includes(r)) return r;
  return roles[0] ?? null;
}

// clientIp(req): the address express resolved (honours TRUST_PROXY), trimmed
// of the IPv4-mapped prefix.
export function clientIp(req) {
  const ip = String(req?.ip ?? req?.socket?.remoteAddress ?? '');
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip || null;
}

const MAX_SUMMARY_BYTES = 2000;

function safeSummary(summary) {
  if (summary === undefined || summary === null) return null;
  const text = JSON.stringify(summary);
  if (text.length <= MAX_SUMMARY_BYTES) return text;
  return JSON.stringify({ truncated: true });
}

// recordAudit({ db, user, actorEmail, action, entityType, entityId, ip, summary })
// `db` is a pg client (to write inside the caller's transaction) or omitted
// (the pool). Throws on an unknown action: a typo must not silently drop.
export async function recordAudit({ db, user = null, actorEmail, actorId, actorRole, action, entityType = null, entityId = null, ip = null, summary = null }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${JSON.stringify(action)}`);
  const run = db ? (sql, params) => db.query(sql, params) : poolQuery;
  await run(
    `insert into public.audit_log (actor_id, actor_email, actor_role, action, entity_type, entity_id, ip, summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      actorId ?? user?.id ?? null,
      actorEmail ?? user?.email ?? null,
      actorRole ?? primaryRole(user),
      action,
      entityType,
      entityId === null || entityId === undefined ? null : String(entityId),
      ip,
      safeSummary(summary),
    ]
  );
}

// auditMany: one row per entity id (capped), or one summary row when there are
// more ids than the cap or none at all.
export async function auditMany({ db, user, action, entityType, ids, ip, summary, cap = 50 }) {
  const list = (ids ?? []).filter((id) => id !== null && id !== undefined);
  if (list.length === 0 || list.length > cap) {
    await recordAudit({ db, user, action, entityType, entityId: null, ip, summary: { ...(summary ?? {}), rows: list.length } });
    return;
  }
  for (const id of list) await recordAudit({ db, user, action, entityType, entityId: id, ip, summary });
}

// --- reading the log (admin page + CSV) ---------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// buildAuditFilter(q): {where, params} from the page's query-string filters.
// Every value is bound; nothing is interpolated.
export function buildAuditFilter(q = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const str = (v, max = 200) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null);
  const from = str(q.from, 10);
  const to = str(q.to, 10);
  if (from) {
    if (!DATE_RE.test(from)) throw Object.assign(new Error('from must be YYYY-MM-DD'), { code: 'BAD_FILTER' });
    add('at >= ?::date', from);
  }
  if (to) {
    if (!DATE_RE.test(to)) throw Object.assign(new Error('to must be YYYY-MM-DD'), { code: 'BAD_FILTER' });
    add("at < (?::date + interval '1 day')", to);
  }
  const actor = str(q.actor);
  if (actor) add("actor_email ilike '%' || ? || '%'", actor.replace(/[\\%_]/g, (c) => `\\${c}`));
  const action = str(q.action, 20);
  if (action) {
    if (!AUDIT_ACTIONS.includes(action)) throw Object.assign(new Error('unknown action'), { code: 'BAD_FILTER' });
    add('action = ?', action);
  }
  const entityType = str(q.entity_type, 60);
  if (entityType) add('entity_type = ?', entityType);
  const entityId = str(q.entity_id, 100);
  if (entityId) add('entity_id = ?', entityId);
  return { where: where.length ? `where ${where.join(' and ')}` : '', params };
}

export default recordAudit;
