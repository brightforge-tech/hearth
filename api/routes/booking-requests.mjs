// api/routes/booking-requests.mjs — staff review of public booking requests.
//
//   POST /api/booking-requests/:id/approve  {patient_id?, scheduled_start?}
//        -> 200 {patient_id, appointment_id}; creates (or links) the patient and
//           books a 'scheduled' appointment, in one transaction.
//   POST /api/booking-requests/:id/decline  {reason?} -> 200 {ok:true}
//
// Any staff role may review. Listing goes through /api/query (select only:
// api/lib/authorization.mjs gives booking_requests no write policy, so these
// two routes are the only way a request changes state). Every decision is
// audited.

import express from 'express';

import { tx } from '../db.mjs';
import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { clientIp, recordAudit } from '../lib/audit.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value, name = 'id') {
  const id = String(value ?? '');
  if (!UUID_RE.test(id)) throw new ApiError(400, `${name} must be a uuid`, 'INVALID_INPUT');
  return id;
}

async function lockPending(client, id) {
  const { rows } = await client.query('select * from public.booking_requests where id = $1 for update', [id]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'No such booking request', 'NOT_FOUND');
  if (row.status !== 'pending') throw new ApiError(409, `This request was already ${row.status}`, 'NOT_PENDING');
  return row;
}

const handleApprove = asyncHandler(async (req, res) => {
  const id = requireId(req.params.id);
  const body = req.body ?? {};
  const linkPatient = body.patient_id ? requireId(body.patient_id, 'patient_id') : null;
  let start = null;
  if (body.scheduled_start !== undefined && body.scheduled_start !== null && body.scheduled_start !== '') {
    const t = Date.parse(String(body.scheduled_start));
    if (Number.isNaN(t)) throw new ApiError(400, 'scheduled_start must be an ISO date-time', 'INVALID_INPUT');
    start = new Date(t).toISOString();
  }
  const result = await tx(async (client) => {
    const request = await lockPending(client, id);
    let patientId = linkPatient;
    if (patientId) {
      const found = await client.query('select 1 from public.patients where id = $1', [patientId]);
      if (!found.rowCount) throw new ApiError(400, 'patient_id does not name a patient', 'INVALID_INPUT');
    } else {
      const created = await client.query(
        `insert into public.patients (first_name, last_name, email, phone, date_of_birth)
         values ($1, $2, $3, $4, $5) returning id`,
        [request.first_name, request.last_name, request.email, request.phone, request.date_of_birth]
      );
      patientId = created.rows[0].id;
      await recordAudit({ db: client, user: req.user, action: 'create', entityType: 'patient', entityId: patientId, ip: clientIp(req), summary: { via: 'booking_request', booking_request_id: id } });
    }
    // the requested slot, read as clinic-local wall time when no override is given
    const appt = await client.query(
      `insert into public.appointments (patient_id, scheduled_start, status, reason, customer_type)
       values ($1, coalesce($2::timestamptz, ($3::date + $4::time)::timestamptz), 'scheduled', $5, 'appointment')
       returning id`,
      [patientId, start, request.preferred_date, request.preferred_time, request.reason]
    );
    const appointmentId = appt.rows[0].id;
    await client.query(
      `update public.booking_requests
          set status = 'approved', reviewed_at = now(), reviewed_by = $2, patient_id = $3, appointment_id = $4
        where id = $1`,
      [id, req.user.id, patientId, appointmentId]
    );
    await recordAudit({ db: client, user: req.user, action: 'create', entityType: 'appointment', entityId: appointmentId, ip: clientIp(req), summary: { via: 'booking_request', booking_request_id: id } });
    await recordAudit({ db: client, user: req.user, action: 'update', entityType: 'booking_request', entityId: id, ip: clientIp(req), summary: { status: 'approved', linked_existing_patient: Boolean(linkPatient) } });
    return { patient_id: patientId, appointment_id: appointmentId };
  });
  sendJson(res, 200, result);
});

const handleDecline = asyncHandler(async (req, res) => {
  const id = requireId(req.params.id);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) || null : null;
  await tx(async (client) => {
    await lockPending(client, id);
    await client.query(
      `update public.booking_requests set status = 'declined', reviewed_at = now(), reviewed_by = $2, decline_reason = $3 where id = $1`,
      [id, req.user.id, reason]
    );
    await recordAudit({ db: client, user: req.user, action: 'update', entityType: 'booking_request', entityId: id, ip: clientIp(req), summary: { status: 'declined' } });
  });
  sendJson(res, 200, { ok: true });
});

export function createBookingRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('admin', 'moderator', 'user'));
  router.post('/:id/approve', handleApprove);
  router.post('/:id/decline', handleDecline);
  return router;
}

export const router = createBookingRouter();
export default createBookingRouter;
