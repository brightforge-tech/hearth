// api/routes/public.mjs — the only write the internet can make: a booking
// REQUEST from the landing page (POST /api/public/booking-requests).
//
// It never creates a patient or an appointment (staff approve or decline the
// request in the app, api/routes/booking-requests.mjs) and it answers with no
// data at all, so it cannot be used to read or probe anything. Abuse controls:
//
//   * a per-IP rate limit (BOOKING_RATE_LIMIT_PER_HOUR, default 5), counted in
//     the database against a keyed hash of the address (the raw IP is not
//     stored with the request);
//   * a honeypot field (`website`): a real browser leaves it empty, a form
//     bot fills it — such a submission is answered 202 and discarded;
//   * strict validation and length caps on every field, and a small body limit.

import { createHmac } from 'node:crypto';
import express from 'express';

import { query } from '../db.mjs';
import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { clientIp } from '../lib/audit.mjs';

const EMAIL_RE = /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]+$/;
const PHONE_RE = /^[0-9+()\-.\s]{5,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'reason', 'preferred_date', 'preferred_time', 'website'];

export function bookingRateLimit(env = process.env) {
  const n = Number(env.BOOKING_RATE_LIMIT_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

export function hashIp(ip, env = process.env) {
  const key = String(env.JWT_SECRET || 'hearth-booking-ip');
  return createHmac('sha256', key).update(String(ip ?? '')).digest('hex');
}

function bad(message) {
  return new ApiError(400, message, 'INVALID_INPUT');
}

function text(body, name, { max, required = false } = {}) {
  const raw = body[name];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw bad(`${name.replace(/_/g, ' ')} is required`);
    return null;
  }
  if (typeof raw !== 'string') throw bad(`${name.replace(/_/g, ' ')} must be text`);
  const value = raw.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (value.length > max) throw bad(`${name.replace(/_/g, ' ')} must be at most ${max} characters`);
  return value;
}

function isoDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// validateBooking(body) -> the row to insert (throws 400 with a readable message)
export function validateBooking(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('a JSON object body is required');
  for (const key of Object.keys(body)) if (!FIELDS.includes(key)) throw bad(`unexpected field ${JSON.stringify(key).slice(0, 40)}`);
  const row = {
    first_name: text(body, 'first_name', { max: 100, required: true }),
    last_name: text(body, 'last_name', { max: 100, required: true }),
    email: text(body, 'email', { max: 254 }),
    phone: text(body, 'phone', { max: 40 }),
    date_of_birth: text(body, 'date_of_birth', { max: 10 }),
    reason: text(body, 'reason', { max: 1000, required: true }),
    preferred_date: text(body, 'preferred_date', { max: 10, required: true }),
    preferred_time: text(body, 'preferred_time', { max: 5, required: true }),
  };
  if (!row.email && !row.phone) throw bad('give an e-mail address or a phone number so the clinic can reach you');
  if (row.email && !EMAIL_RE.test(row.email)) throw bad('email is not a valid e-mail address');
  if (row.phone && !PHONE_RE.test(row.phone)) throw bad('phone may contain digits, spaces and + ( ) - . only');
  if (row.date_of_birth && (!DATE_RE.test(row.date_of_birth) || Number.isNaN(Date.parse(row.date_of_birth)) || row.date_of_birth > isoDay(0) || row.date_of_birth < '1900-01-01')) {
    throw bad('date of birth must be a past date (YYYY-MM-DD)');
  }
  if (!DATE_RE.test(row.preferred_date) || Number.isNaN(Date.parse(row.preferred_date))) throw bad('preferred date must be YYYY-MM-DD');
  if (row.preferred_date < isoDay(-1) || row.preferred_date > isoDay(366)) throw bad('preferred date must be within the next year');
  if (!TIME_RE.test(row.preferred_time)) throw bad('preferred time must be HH:MM');
  return row;
}

const handleBooking = asyncHandler(async (req, res) => {
  const body = req.body;
  // honeypot: silently accepted, never stored
  if (body && typeof body === 'object' && typeof body.website === 'string' && body.website.trim() !== '') {
    return sendJson(res, 202, { ok: true });
  }
  const row = validateBooking(body);
  const ipHash = hashIp(clientIp(req));
  const { rows } = await query(
    "select count(*)::int as n from public.booking_requests where source_ip_hash = $1 and created_at > now() - interval '1 hour'",
    [ipHash]
  );
  if (rows[0].n >= bookingRateLimit()) {
    throw Object.assign(new ApiError(429, 'Too many booking requests from this network. Please try again later or call the clinic.', 'RATE_LIMITED'), { retryAfter: 3600 });
  }
  await query(
    `insert into public.booking_requests
       (first_name, last_name, email, phone, date_of_birth, reason, preferred_date, preferred_time, source_ip_hash)
     values ($1, $2, $3, $4, $5::date, $6, $7::date, $8, $9)`,
    [row.first_name, row.last_name, row.email ? row.email.toLowerCase() : null, row.phone, row.date_of_birth, row.reason, row.preferred_date, row.preferred_time, ipHash]
  );
  return sendJson(res, 202, { ok: true });
});

export function createPublicRouter() {
  const router = express.Router();
  // a booking form is tiny: refuse anything bigger before reading it
  router.use((req, res, next) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 8192) return next(new ApiError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE'));
    return next();
  });
  router.post('/booking-requests', handleBooking);
  return router;
}

export const router = createPublicRouter();
export default createPublicRouter;
