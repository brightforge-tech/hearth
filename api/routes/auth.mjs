// api/routes/auth.mjs — staff sessions: signup, login, session, logout and
// admin user creation (task t5; criteria W14, W15, W16, W18, W20).
//
// Mounted by api/routes/index.mjs at /api/auth. The contracts:
//
//   POST   /api/auth/login       JSON {"email","password"} (username/pass are
//                                 accepted too)      -> 200 {access_token, user,
//                                 roles} + session cookie; wrong credentials
//                                 -> 401 {"error":{"code","message"}} and no
//                                 cookie is set, so no session exists (W14)
//   POST   /api/auth/login       application/x-www-form-urlencoded body
//                                 user=...&pass=...   -> 302 to / with the
//                                 hh_token cookie set: the scripted/crawler
//                                 login path (W16)
//   GET    /api/auth/session     valid bearer token or cookie -> 200 {user,
//                                 roles}; absent, forged or expired -> 401 (W15)
//   POST   /api/auth/signup      {"email","password"} -> 200 with a session for
//                                 the new account, which immediately holds the
//                                 'user' role; the same e-mail a second time ->
//                                 409 and no second row (W18)
//   POST   /api/auth/logout      clears the session cookie
//   POST   /api/auth/admin/users admin-only: create an account with a role
//                                 (S32: the role decision is made here, on the
//                                 server, never in the browser)
//
// Why the identity/roles come back as they do: the token is only a signature
// the bearer presents (api/lib/tokens.mjs); who the caller is and what they may
// do are re-read from app_users/user_roles on every request (api/lib/session.mjs).
// So `roles` in these responses is the database's answer at this instant, and
// revoking a role needs no token invalidation.
//
// The session cookie is the scripted-login convenience (SameSite=Lax, Path=/).
// The bearer token in localStorage stays the SPA's primary path. Because a
// browser can ride the cookie, every state-changing route here that can be
// authenticated by the cookie alone additionally requires an
// application/json content type (requireJsonMutation) — a cross-site <form>
// cannot set that header, and the one route that must accept a form (login)
// changes nothing in the caller's data.

import express from 'express';

import { query, tx } from '../db.mjs';
import { ApiError, asyncHandler, readJsonBody, readRawBody, sendJson } from '../lib/http.mjs';
import { hashPassword, verifyPassword } from '../lib/passwords.mjs';
import { requireAuth, requireOptionalAuth, requireRole, SESSION_COOKIE } from '../lib/session.mjs';
import { sessionTtlHours, signToken } from '../lib/tokens.mjs';

// Login/sign-up field spellings accepted on every content type. The crawler
// forms and the SPA both land on email/password; the
// form path is classically user/pass.
const IDENTITY_FIELDS = ['email', 'username', 'user'];
const PASSWORD_FIELDS = ['password', 'pass'];

// An account whose e-mail is not this shape is a typo or an attack, never a
// staff member; the same regex guards every write to app_users.email.
const EMAIL_RE = /^[^\s@,;:]+@[^\s@,;:]+\.[^\s@,;:]+$/;

// The shortest password the API will store. (Login never applies this — it
// only verifies — so an account can never be locked out by a policy change.)
const MIN_PASSWORD_LENGTH = 8;

// The roles an admin may grant; exactly public.app_role (0001_enums.sql).
const GRANTABLE_ROLES = ['admin', 'moderator', 'user'];

function badRequest(message) {
  return new ApiError(400, message, 'INVALID_INPUT');
}

// normalizeEmail: trim + lowercase, the form every writer and reader uses.
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

// readCredentials(req): {identifier, password} from a JSON or urlencoded body.
// The jsonBodyParser already consumed (and parsed) application/json; anything
// else — urlencoded above all — arrives untouched on the stream.
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
    password: readField(body, PASSWORD_FIELDS),
    redirected: contentType === 'application/x-www-form-urlencoded',
  };
}

// validateEmailPassword: the shared write-side validation for signup and
// admin user creation.
function validateEmailPassword(identifier, password) {
  const email = normalizeEmail(identifier);
  if (!EMAIL_RE.test(email)) throw badRequest('email must be a valid e-mail address');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`password must be a string of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 1024) throw badRequest('password must be at most 1024 characters');
  return { email, password };
}

// loadAccount(email): the row login needs — identity, hash, and the roles
// aggregated exactly like api/lib/session.mjs does, so the token body and the
// session endpoint can never disagree.
async function loadAccount(email) {
  const { rows } = await query(
    `select u.id,
            u.email,
            u.password_hash,
            coalesce(
              array_agg(r.role::text order by r.role) filter (where r.role is not null),
              '{}'::text[]
            ) as roles
       from public.app_users u
       left join public.user_roles r on r.user_id = u.id
      where u.email = $1
      group by u.id, u.email, u.password_hash`,
    [email]
  );
  return rows[0] ?? null;
}

// createAccount(email, password, role): one transaction, user + role, so no
// account can exist in a role-less half state through this door (a roleless
// account is 403 NO_ROLE everywhere else — see session.mjs). The one caller
// that deliberately passes role=null is the admin user-creation door: the
// browser page picks the role itself and inserts the user_roles row right
// afterwards, exactly like supabase-js's auth.admin.createUser (which never
// granted a role) behaved before the migration.
async function createAccount(email, password, role) {
  const hash = await hashPassword(password);
  try {
    return await tx(async (client) => {
      const inserted = await client.query(
        'insert into public.app_users (email, password_hash) values ($1, $2) on conflict (email) do nothing returning id',
        [email, hash]
      );
      if (!inserted.rows.length) return null; // the e-mail got taken between check and insert
      if (role === null) return { id: inserted.rows[0].id, email, roles: [] };
      await client.query('insert into public.user_roles (user_id, role) values ($1, $2::public.app_role) on conflict do nothing', [
        inserted.rows[0].id,
        role,
      ]);
      return { id: inserted.rows[0].id, email, roles: [role] };
    });
  } catch (e) {
    if (e && e.code === '23505') throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
    throw e;
  }
}

// --- session cookie ----------------------------------------------------------

// cookie(name=value) header: Path=/ so it reaches every /api route; SameSite=Lax
// so a cross-site POST never rides on it; no Max-Age on read (the token's own
// exp is the real deadline); Secure whenever the request itself arrived over TLS.
function setSessionCookie(res, req, token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (req.secured) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (req.secured) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// sessionPayload: the 200 body login and signup answer with. access_token for
// the Authorization header (the SPA keeps it in localStorage); user carries the
// id/email/roles the pages render; the cookie mirrors the token for crawlers.
function sessionPayload(res, req, account, { withCookie = true } = {}) {
  const token = signToken({ sub: account.id, email: account.email });
  const hours = sessionTtlHours();
  if (withCookie) setSessionCookie(res, req, token, Math.round(hours * 3600));
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: Math.round(hours * 3600),
    user: { id: account.id, email: account.email, roles: account.roles },
    roles: account.roles,
  };
}

// --- CSRF guard ---------------------------------------------------------------

// requireJsonMutation: a state-changing request that authenticates with the
// session cookie (no Authorization header) must carry an application/json
// content type — the one thing a cross-site <form> cannot set. A bearer-token
// request proves intent beyond any doubt (the token is not attachable
// cross-origin), so it always passes. Mounted after requireAuth/
// requireOptionalAuth so req.user reflects the cookie.
function requireJsonMutation(req, res, next) {
  const bearer = /^\s*bearer\s+\S+/i.test(String(req.headers.authorization ?? ''));
  if (!req.user || bearer || req.jsonContentType === true) return next();
  return next(new ApiError(403, 'Cookie-authenticated requests must send Content-Type: application/json', 'CSRF'));
}

// GET /login — the login PAGE (not just the endpoint). Scripted sign-ins —
// test harnesses, crawlers, any cookie-holding bot —
// treat the login path as a page: GET it, fill the named fields, POST the
// form. So the endpoint also serves the form it POSTs to. Both field spellings
// are in the form (email/password and user/pass); empty ones are ignored by
// readCredentials, so whichever the caller fills wins, and the POST handler
// below is the only submit target. A wrong password on this form still gets
// the JSON 401 — one answer for bad credentials, page or wire.
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

// --- handlers ------------------------------------------------------------------

// POST /login — W14 (JSON) and W16 (form + cookie + 302).
const handleLogin = asyncHandler(async (req, res) => {
  const { identifier, password, redirected } = await readCredentials(req);
  if (!identifier || typeof password !== 'string' || password === '') {
    throw badRequest('email and password are required');
  }
  const account = await loadAccount(normalizeEmail(identifier));
  // A missing account verifies against a fixed well-formed record so the two
  // failures cost the same work; the caller sees one answer either way.
  const known = account !== null;
  const ok = await verifyPassword(password, known ? account.password_hash : DUMMY_HASH);
  if (!known || !ok) {
    throw new ApiError(401, 'Invalid e-mail or password', 'INVALID_CREDENTIALS');
  }
  if (redirected) {
    // The scripted login: the cookie is the session, and the crawler follows
    // the redirect into the SPA it was pointed at (W16).
    setSessionCookie(res, req, signToken({ sub: account.id, email: account.email }), Math.round(sessionTtlHours() * 3600));
    return res.redirect(302, '/');
  }
  return sendJson(res, 200, sessionPayload(res, req, account));
});

// A syntactically valid scrypt record that nothing is expected to match: it
// keeps the "unknown account" branch as expensive as the "wrong password" one.
const DUMMY_HASH = 'scrypt$16384$8$1$ZHVtbXktc2FsdC1mb3ItY29uc3RhbnQt$ZHVtbXktc2FsdC1mb3ItY29uc3RhbnQt';

// GET /session — W15. requireAuth has already re-read the roles from the
// database; this endpoint just shows the caller what the API will answer with.
const handleSession = (req, res) => {
  sendJson(res, 200, {
    user: { id: req.user.id, email: req.user.email, roles: req.user.roles },
    roles: req.user.roles,
  });
};

// POST /signup — W18. The new account is immediately usable: the response
// carries a full session, and the account already holds the 'user' role.
const handleSignup = asyncHandler(async (req, res) => {
  const { identifier, password } = await readCredentials(req);
  if (!identifier || typeof password !== 'string' || password === '') {
    throw badRequest('email and password are required');
  }
  const { email, password: plain } = validateEmailPassword(identifier, password);
  const created = await createAccount(email, plain, 'user');
  if (!created) throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
  return sendJson(res, 200, sessionPayload(res, req, created));
});

// POST /logout — clears the cookie. The bearer token needs no logout: the
// SPA throws it away, and it is worthless once it does (api/lib/tokens.mjs).
const handleLogout = (req, res) => {
  clearSessionCookie(res, req);
  sendJson(res, 200, { ok: true, message: 'The session cookie has been cleared' });
};

// POST /admin/users — admin-only account creation (S32). The caller picks the
// role from the enum; 'user' is the default, matching signup.
const handleAdminCreateUser = asyncHandler(async (req, res) => {
  const body = await readJsonBody(req);
  const identifier = readField(body, IDENTITY_FIELDS);
  const password = readField(body, PASSWORD_FIELDS);
  const { email, password: plain } = validateEmailPassword(identifier, password);
  const role = body.role === undefined ? 'user' : body.role === null ? null : String(body.role);
  if (role !== null && !GRANTABLE_ROLES.includes(role)) {
    throw badRequest(`role must be one of ${GRANTABLE_ROLES.join(', ')}`);
  }
  const created = await createAccount(email, plain, role);
  if (!created) throw new ApiError(409, 'An account with this e-mail already exists', 'EMAIL_TAKEN');
  return sendJson(res, 200, { user: { id: created.id, email: created.email, roles: created.roles }, roles: created.roles });
});

// The router. It is stateless, so api/routes/index.mjs may mount the single
// exported instance, like every other route file.
export function createAuthRouter() {
  const router = express.Router();

  // login accepts a form by contract; it mutates no caller data, so the JSON
  // guard does not apply to it (and must not — a crawler posts urlencoded).
  router.get('/login', handleLoginPage);
  router.post('/login', handleLogin);
  router.post('/signup', handleSignup);
  router.post('/logout', requireOptionalAuth, requireJsonMutation, handleLogout);

  router.get('/session', requireAuth, handleSession);

  // admin-only: requireAuth answers 401 for no/forged/expired session,
  // requireRole answers 403 FORBIDDEN for a signed-in non-admin (W17 pattern).
  router.post('/admin/users', requireAuth, requireJsonMutation, requireRole('admin'), handleAdminCreateUser);

  return router;
}

export const router = createAuthRouter();
export default createAuthRouter;
