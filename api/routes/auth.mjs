// api/routes/auth.mjs — staff sessions and account security.
//
// Mounted by api/routes/index.mjs at /api/auth:
//
//   POST /login                      JSON {email,password} -> 200 session; 401
//                                    INVALID_CREDENTIALS; 429 LOGIN_LOCKED.
//                                    urlencoded form -> 302 / + session cookie.
//   GET  /login                      a minimal HTML sign-in form (scripted use)
//   GET  /session                    the caller (allowed while a forced
//                                    password change is pending)
//   POST /logout                     revokes the server-side session
//   POST /change-password            {current_password,new_password} -> new session
//   GET  /features                   which optional integrations are on (public)
//   POST /password-reset/request     {email} -> 202 (only with e-mail configured)
//   POST /password-reset/confirm     {token,new_password}
//   POST /signup                     disabled unless ALLOW_SELF_SIGNUP; creates a
//                                    role-less account (an admin grants a role)
//   POST /admin/users                admin: create an account (forced change)
//   POST /admin/users/:id/reset-password  admin: temporary password
//
// Security properties (see docs/PRIVACY-AND-SECURITY.md):
//   * failed sign-ins are throttled per account name and per IP in the
//     database (api/lib/throttle.mjs);
//   * every sign-in creates a new server-side session (api/lib/sessions.mjs):
//     idle timeout, absolute lifetime, revocation on logout/password change;
//   * new passwords must pass api/lib/password-policy.mjs;
//   * login, failed login, logout and account changes are written to the
//     audit log (api/lib/audit.mjs);
//   * who the caller is and what they may do are re-read from the database on
//     every request (api/lib/session.mjs), never trusted from the token.
//
// The session cookie mirrors the bearer token for scripted logins (SameSite=
// Lax). Every state-changing route that a cookie alone can authenticate also
// requires an application/json content type (requireJsonMutation), which a
// cross-site <form> cannot send.

import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

import { query, tx } from '../db.mjs';
import { ApiError, asyncHandler, readJsonBody, readRawBody, sendJson } from '../lib/http.mjs';
import { hashPassword, verifyPassword } from '../lib/passwords.mjs';
import { checkPassword } from '../lib/password-policy.mjs';
import { readSessionToken, requireAuth, requireAuthAllowPending, requireRole, resolveUser, SESSION_COOKIE } from '../lib/session.mjs';
import { createSession, revokeSession, revokeUserSessions } from '../lib/sessions.mjs';
import { checkLogin, recordAttempt } from '../lib/throttle.mjs';
import { clientIp, recordAudit } from '../lib/audit.mjs';
import { features, passwordResetEmailEnabled, selfSignupEnabled } from '../lib/features.mjs';
import { sendEmail } from '../lib/resend.mjs';
import { escapeHtml } from '../lib/escape.mjs';
import { CLINIC_NAME, PRODUCT_NAME } from '../lib/brand.mjs';
import { decodeToken } from '../lib/tokens.mjs';

const IDENTITY_FIELDS = ['email', 'username', 'user'];
const PASSWORD_FIELDS = ['password', 'pass'];
const EMAIL_RE = /^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+$/;
const GRANTABLE_ROLES = ['admin', 'moderator', 'user'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESET_TOKEN_MINUTES = 60;

function badRequest(message, code = 'INVALID_INPUT') {
  return new ApiError(400, message, code);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readField(body, names) {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

async function readCredentials(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  let body;
  if (contentType === 'application/x-www-form-urlencoded') {
    const raw = await readRawBody(req, 65_536);
    body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  } else {
    body = await readJsonBody(req);
  }
  return {
    identifier: readField(body, IDENTITY_FIELDS),
    // a password is taken as typed (not trimmed): spaces may be part of it
    password: PASSWORD_FIELDS.map((n) => body?.[n]).find((v) => typeof v === 'string' && v !== '') ?? null,
    redirected: contentType === 'application/x-www-form-urlencoded',
  };
}

// validateNewPassword: the policy, as a 400 WEAK_PASSWORD.
function validateNewPassword(password, email) {
  const problem = checkPassword(password, { email });
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
}

function validateEmail(identifier) {
  const email = normalizeEmail(identifier);
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest('email must be a valid e-mail address');
  return email;
}

async function loadAccount(email) {
  const { rows } = await query(
    `select u.id, u.email, u.password_hash, u.must_change_password,
            coalesce(bool_or(r.is_doctor), false) as is_doctor,
            coalesce(array_agg(r.role::text order by r.role) filter (where r.role is not null), '{}'::text[]) as roles
       from public.app_users u
       left join public.user_roles r on r.user_id = u.id
      where u.email = $1
      group by u.id, u.email, u.password_hash, u.must_change_password`,
    [email]
  );
  return rows[0] ?? null;
}

async function loadAccountById(id) {
  const { rows } = await query('select email from public.app_users where id = $1', [id]);
  return rows[0]?.email ? loadAccount(rows[0].email) : null;
}

// createAccount(email, password, role, {mustChange}): user + role in one tx.
async function createAccount(email, password, role, { mustChange = false } = {}) {
  const hash = await hashPassword(password);
  try {
    return await tx(async (client) => {
      const inserted = await client.query(
        `insert into public.app_users (email, password_hash, must_change_password, password_changed_at)
         values ($1, $2, $3, now()) on conflict (email) do nothing returning id`,
        [email, hash, mustChange]
      );
      if (!inserted.rows.length) return null;
      const id = inserted.rows[0].id;
      if (role === null) return { id, email, roles: [], must_change_password: mustChange };
      await client.query('insert into public.user_roles (user_id, role) values ($1, $2::public.app_role) on conflict do nothing', [id, role]);
      return { id, email, roles: [role], must_change_password: mustChange };
    });
  } catch (e) {
    if (e && e.code === '23505') throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
    throw e;
  }
}

// --- session cookie ----------------------------------------------------------

function setSessionCookie(res, req, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax', 'HttpOnly'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (req.secure || req.secured) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'HttpOnly', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (req.secure || req.secured) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// The sid of a token the caller presented (signature not needed: it is only
// used to revoke that session, which an attacker gains nothing from).
function presentedSid(req) {
  const token = readSessionToken(req);
  const sid = token ? decodeToken(token)?.payload?.sid : null;
  return typeof sid === 'string' && UUID_RE.test(sid) ? sid : null;
}

// startSession: a NEW server-side session (the presented one, if any, is
// revoked first — session ids are rotated on every sign-in) and the 200 body.
async function startSession(res, req, account, { withCookie = true } = {}) {
  const old = presentedSid(req);
  if (old) await revokeSession(old);
  const { token, expiresIn } = await createSession(account, req);
  if (withCookie) setSessionCookie(res, req, token, expiresIn);
  const user = {
    id: account.id,
    email: account.email,
    roles: account.roles,
    is_doctor: Boolean(account.is_doctor),
    must_change_password: Boolean(account.must_change_password),
  };
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    user,
    roles: account.roles,
    must_change_password: user.must_change_password,
  };
}

function requireJsonMutation(req, res, next) {
  const bearer = /^\s*bearer\s+\S+/i.test(String(req.headers.authorization ?? ''));
  if (!req.user || bearer || req.jsonContentType === true) return next();
  return next(new ApiError(403, 'Cookie-authenticated requests must send Content-Type: application/json', 'CSRF'));
}

// GET /login — a minimal sign-in page for scripted use (the SPA has its own).
const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Hearth</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f6f7f9; color: #111; }
  form { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.08); width: min(92vw, 340px); }
  label { display: block; font-weight: 600; margin-bottom: .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; margin-bottom: 1rem; border: 1px solid #cbd2d9; border-radius: 6px; }
  button { width: 100%; padding: .6rem; border: 0; border-radius: 6px; background: #0f766e; color: #fff; font-weight: 600; cursor: pointer; }
  p.note { color: #667085; font-size: .85rem; margin: 0; }
</style>
</head>
<body>
<form method="POST" action="/api/auth/login">
  <h1 style="margin:0 0 1rem;font-size:1.25rem">Hearth — staff sign-in</h1>
  <label for="email">E-mail</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <input name="user" type="hidden">
  <input name="pass" type="hidden">
  <button type="submit">Sign in</button>
  <p class="note">Staff accounts only. A successful sign-in sets a session cookie and opens the application.</p>
</form>
</body>
</html>`;

function handleLoginPage(req, res) {
  res.status(200).type('text/html; charset=utf-8').send(LOGIN_PAGE);
}

// A syntactically valid scrypt record nothing matches: the unknown-account
// branch costs the same as a wrong password.
const DUMMY_HASH = 'scrypt$16384$8$1$ZHVtbXktc2FsdC1mb3ItY29uc3RhbnQt$ZHVtbXktc2FsdC1mb3ItY29uc3RhbnQt';

// --- handlers ------------------------------------------------------------------

const handleLogin = asyncHandler(async (req, res) => {
  const { identifier, password, redirected } = await readCredentials(req);
  if (!identifier || typeof password !== 'string' || password === '') {
    throw badRequest('email and password are required');
  }
  const email = normalizeEmail(identifier).slice(0, 254);
  const ip = clientIp(req);

  const lock = await checkLogin(email, ip);
  if (lock.locked) {
    await recordAudit({ actorEmail: email, action: 'login_failed', entityType: 'session', ip, summary: { reason: lock.scope === 'ip' ? 'ip_locked' : 'account_locked' } });
    const minutes = Math.max(1, Math.ceil(lock.retryAfter / 60));
    res.setHeader('Retry-After', String(lock.retryAfter));
    throw Object.assign(
      new ApiError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'LOGIN_LOCKED'),
      { retryAfter: lock.retryAfter }
    );
  }

  const account = await loadAccount(email);
  const known = account !== null;
  const ok = await verifyPassword(password, known ? account.password_hash : DUMMY_HASH);
  if (!known || !ok) {
    await recordAttempt(email, ip, false);
    await recordAudit({ actorId: known ? account.id : null, actorEmail: email, action: 'login_failed', entityType: 'session', ip, summary: { reason: 'invalid_credentials' } });
    throw new ApiError(401, 'Invalid e-mail or password', 'INVALID_CREDENTIALS');
  }
  await recordAttempt(email, ip, true);
  await query('update public.app_users set last_login_at = now() where id = $1', [account.id]);
  await recordAudit({ user: account, action: 'login', entityType: 'session', ip });

  if (redirected) {
    await startSession(res, req, account, { withCookie: true });
    return res.redirect(302, account.must_change_password ? '/change-password' : '/');
  }
  return sendJson(res, 200, await startSession(res, req, account));
});

const handleSession = (req, res) => {
  sendJson(res, 200, {
    user: {
      id: req.user.id,
      email: req.user.email,
      roles: req.user.roles,
      is_doctor: req.user.is_doctor,
      must_change_password: req.user.must_change_password,
    },
    roles: req.user.roles,
  });
};

// POST /signup — only with ALLOW_SELF_SIGNUP. The account gets NO role: a
// self-registered stranger must never see patient data. An admin grants a
// role in Settings -> Users.
const handleSignup = asyncHandler(async (req, res) => {
  if (!selfSignupEnabled()) {
    throw new ApiError(403, 'Self sign-up is disabled. Ask an administrator for an account.', 'SIGNUP_DISABLED');
  }
  const { identifier, password } = await readCredentials(req);
  if (!identifier || typeof password !== 'string' || password === '') throw badRequest('email and password are required');
  const email = validateEmail(identifier);
  validateNewPassword(password, email);
  const created = await createAccount(email, password, null);
  if (!created) throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
  await recordAudit({ actorId: created.id, actorEmail: email, action: 'create', entityType: 'user', entityId: created.id, ip: clientIp(req), summary: { via: 'self_signup' } });
  return sendJson(res, 201, { user: { id: created.id, email, roles: [] }, roles: [], message: 'Account created. An administrator must assign a role before you can sign in to the app.' });
});

// POST /logout — revokes the server-side session and clears the cookie.
const handleLogout = asyncHandler(async (req, res) => {
  // CSRF: a cookie-only logout must be a JSON request (a cross-site form
  // cannot send that); a bearer token or no credential at all is fine.
  const bearer = /^\s*bearer\s+\S+/i.test(String(req.headers.authorization ?? ''));
  if (!bearer && readSessionToken(req) && req.jsonContentType !== true) {
    throw new ApiError(403, 'Cookie-authenticated requests must send Content-Type: application/json', 'CSRF');
  }
  let user = null;
  try {
    user = await resolveUser(req, { allowPendingPasswordChange: true });
  } catch {
    /* an expired or unknown session logs out all the same */
  }
  const sid = presentedSid(req);
  if (sid) await revokeSession(sid);
  if (user) await recordAudit({ user, action: 'logout', entityType: 'session', ip: clientIp(req) });
  clearSessionCookie(res, req);
  sendJson(res, 200, { ok: true, message: 'Signed out' });
});

// POST /change-password — verifies the current password, applies the policy,
// clears a forced change, revokes every other session and starts a new one.
const handleChangePassword = asyncHandler(async (req, res) => {
  const body = (await readJsonBody(req)) ?? {};
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!current || !next) throw badRequest('current_password and new_password are required');
  const account = await loadAccount(req.user.email);
  if (!account || !(await verifyPassword(current, account.password_hash))) {
    throw new ApiError(401, 'The current password is not correct', 'INVALID_CREDENTIALS');
  }
  if (current === next) throw badRequest('The new password must be different from the current one', 'WEAK_PASSWORD');
  validateNewPassword(next, account.email);
  const hash = await hashPassword(next);
  await query('update public.app_users set password_hash = $2, must_change_password = false, password_changed_at = now() where id = $1', [account.id, hash]);
  await revokeUserSessions(account.id);
  await recordAudit({ user: account, action: 'update', entityType: 'user', entityId: account.id, ip: clientIp(req), summary: { fields: ['password'] } });
  const fresh = await loadAccount(account.email);
  return sendJson(res, 200, await startSession(res, req, fresh));
});

const handleFeatures = (req, res) => sendJson(res, 200, features());

// --- self-service reset (only with e-mail configured) ---------------------------

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

function resetEmailHtml(link) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111">
<p>A password reset was requested for your ${escapeHtml(PRODUCT_NAME)} account at ${escapeHtml(CLINIC_NAME)}.</p>
<p><a href="${escapeHtml(link)}">Choose a new password</a> (the link works once and expires in ${RESET_TOKEN_MINUTES} minutes).</p>
<p>If you did not ask for this, ignore this e-mail; your password stays unchanged.</p>
</body></html>`;
}

const handleResetRequest = asyncHandler(async (req, res) => {
  if (!passwordResetEmailEnabled()) throw new ApiError(404, 'Password reset by e-mail is not enabled on this server', 'FEATURE_DISABLED');
  const body = (await readJsonBody(req)) ?? {};
  const email = normalizeEmail(body.email).slice(0, 254);
  const ip = clientIp(req);
  // Same answer whether or not the account exists. Requests share the login
  // throttle, so this cannot be used to spam a mailbox.
  const lock = await checkLogin(`reset:${email}`, ip);
  if (EMAIL_RE.test(email) && !lock.locked) {
    await recordAttempt(`reset:${email}`, ip, false);
    const account = await loadAccount(email);
    if (account) {
      const token = randomBytes(32).toString('base64url');
      await query('update public.password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [account.id]);
      await query(
        `insert into public.password_reset_tokens (user_id, token_hash, expires_at)
         values ($1, $2, now() + make_interval(mins => $3))`,
        [account.id, hashToken(token), RESET_TOKEN_MINUTES]
      );
      const base = String(process.env.APP_BASE_URL ?? '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
      const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
      const from = String(process.env.RESEND_FROM_SYSTEM ?? process.env.RESEND_FROM_INVOICE ?? '').trim();
      const { error } = await sendEmail({ from, to: [account.email], subject: `${PRODUCT_NAME}: reset your password`, html: resetEmailHtml(link) });
      if (error) console.error(`auth: password reset mail failed: ${error.message}`);
      await recordAudit({ user: account, action: 'update', entityType: 'user', entityId: account.id, ip, summary: { password_reset: 'requested' } });
    }
  }
  return sendJson(res, 202, { ok: true });
});

const handleResetConfirm = asyncHandler(async (req, res) => {
  const body = (await readJsonBody(req)) ?? {};
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';
  if (!token || token.length > 200 || !next) throw badRequest('token and new_password are required');
  const { rows } = await query(
    `select t.id, t.user_id, u.email from public.password_reset_tokens t
       join public.app_users u on u.id = t.user_id
      where t.token_hash = $1 and t.used_at is null and t.expires_at > now()`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) throw badRequest('This reset link is invalid or has expired', 'INVALID_TOKEN');
  validateNewPassword(next, row.email);
  const hash = await hashPassword(next);
  await tx(async (client) => {
    const used = await client.query('update public.password_reset_tokens set used_at = now() where id = $1 and used_at is null returning id', [row.id]);
    if (!used.rowCount) throw badRequest('This reset link is invalid or has expired', 'INVALID_TOKEN');
    await client.query('update public.app_users set password_hash = $2, must_change_password = false, password_changed_at = now() where id = $1', [row.user_id, hash]);
    await revokeUserSessions(row.user_id, { db: client });
    await recordAudit({ db: client, actorId: row.user_id, actorEmail: row.email, action: 'update', entityType: 'user', entityId: row.user_id, ip: clientIp(req), summary: { password_reset: 'completed' } });
  });
  return sendJson(res, 200, { ok: true });
});

// --- admin ----------------------------------------------------------------------

// POST /admin/users — the account must change its password at first sign-in.
const handleAdminCreateUser = asyncHandler(async (req, res) => {
  const body = (await readJsonBody(req)) ?? {};
  const identifier = readField(body, IDENTITY_FIELDS);
  const password = PASSWORD_FIELDS.map((n) => body?.[n]).find((v) => typeof v === 'string' && v !== '') ?? '';
  const email = validateEmail(identifier ?? '');
  validateNewPassword(password, email);
  const role = body.role === undefined ? 'user' : body.role === null ? null : String(body.role);
  if (role !== null && !GRANTABLE_ROLES.includes(role)) throw badRequest(`role must be one of ${GRANTABLE_ROLES.join(', ')}`);
  const created = await createAccount(email, password, role, { mustChange: true });
  if (!created) throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
  await recordAudit({ user: req.user, action: 'create', entityType: 'user', entityId: created.id, ip: clientIp(req), summary: { role } });
  return sendJson(res, 200, { user: { id: created.id, email: created.email, roles: created.roles }, roles: created.roles });
});

// A readable temporary password: 4 groups of 4 from an unambiguous alphabet
// (about 80 bits), e.g. "kq7m-x2pd-9fhw-c4tz".
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// POST /admin/users/:id/reset-password — temporary password, forced change,
// every session of that user revoked.
const handleAdminResetPassword = asyncHandler(async (req, res) => {
  const id = String(req.params.id ?? '');
  if (!UUID_RE.test(id)) throw badRequest('user id must be a uuid');
  const account = await loadAccountById(id);
  if (!account) throw new ApiError(404, 'No such user', 'NOT_FOUND');
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  await query('update public.app_users set password_hash = $2, must_change_password = true, password_changed_at = now() where id = $1', [id, hash]);
  await revokeUserSessions(id);
  await recordAudit({ user: req.user, action: 'update', entityType: 'user', entityId: id, ip: clientIp(req), summary: { password_reset: 'admin_temporary' } });
  return sendJson(res, 200, { temporary_password: temp, must_change_password: true });
});

export function createAuthRouter() {
  const router = express.Router();
  router.get('/login', handleLoginPage);
  router.post('/login', handleLogin);
  router.post('/signup', handleSignup);
  router.post('/logout', handleLogout);
  router.get('/features', handleFeatures);
  router.post('/password-reset/request', handleResetRequest);
  router.post('/password-reset/confirm', handleResetConfirm);

  router.get('/session', requireAuthAllowPending, handleSession);
  router.post('/change-password', requireAuthAllowPending, requireJsonMutation, handleChangePassword);

  router.post('/admin/users', requireAuth, requireJsonMutation, requireRole('admin'), handleAdminCreateUser);
  router.post('/admin/users/:id/reset-password', requireAuth, requireJsonMutation, requireRole('admin'), handleAdminResetPassword);

  return router;
}

export const router = createAuthRouter();
export default createAuthRouter;
