// api/routes/audit.mjs — the admin-only audit log reader.
//
//   GET /api/audit?from&to&actor&action&entity_type&entity_id&limit&offset
//        -> {rows, total}
//   GET /api/audit/export?<same filters>  -> text/csv (and is itself audited)
//
// There is deliberately no POST/PUT/PATCH/DELETE here, and the generic query
// route has no policy for audit_log: nothing reachable over HTTP can change or
// remove an audit row.

import express from 'express';

import { query } from '../db.mjs';
import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { buildAuditFilter, clientIp, recordAudit } from '../lib/audit.mjs';
import { csvCell } from '../lib/csv.mjs';

const MAX_EXPORT_ROWS = 100_000;

function filterOrBad(q) {
  try {
    return buildAuditFilter(q);
  } catch (e) {
    throw new ApiError(400, e.message, 'BAD_FILTER');
  }
}

function intParam(v, dflt, max) {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isInteger(n) || n < 0) return dflt;
  return Math.min(n, max);
}

const COLUMNS = 'id, at, actor_id, actor_email, actor_role, action, entity_type, entity_id, ip, summary';

const handleList = asyncHandler(async (req, res) => {
  const { where, params } = filterOrBad(req.query);
  const limit = intParam(req.query.limit, 100, 500);
  const offset = intParam(req.query.offset, 0, 10_000_000);
  const total = await query(`select count(*)::int as n from public.audit_log ${where}`, params);
  const rows = await query(
    `select ${COLUMNS} from public.audit_log ${where} order by at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset]
  );
  sendJson(res, 200, { rows: rows.rows, total: total.rows[0].n });
});

const handleExport = asyncHandler(async (req, res) => {
  const { where, params } = filterOrBad(req.query);
  const { rows } = await query(
    `select ${COLUMNS} from public.audit_log ${where} order by at desc, id desc limit $${params.length + 1}`,
    [...params, MAX_EXPORT_ROWS]
  );
  const header = ['id', 'at', 'actor_id', 'actor_email', 'actor_role', 'action', 'entity_type', 'entity_id', 'ip', 'summary'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.id, r.at instanceof Date ? r.at.toISOString() : r.at, r.actor_id, r.actor_email, r.actor_role, r.action, r.entity_type, r.entity_id, r.ip, r.summary ? JSON.stringify(r.summary) : '']
        .map((v) => csvCell(v === null || v === undefined ? '' : String(v)))
        .join(',')
    );
  }
  await recordAudit({
    user: req.user,
    action: 'export',
    entityType: 'audit_log',
    ip: clientIp(req),
    summary: { rows: rows.length, filters: Object.fromEntries(Object.entries(req.query).filter(([k]) => ['from', 'to', 'actor', 'action', 'entity_type', 'entity_id'].includes(k))) },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\n') + '\n');
});

export function createAuditRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('admin'));
  router.get('/', handleList);
  router.get('/export', handleExport);
  return router;
}

export const router = createAuditRouter();
export default createAuditRouter;
