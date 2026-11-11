// tests/api/security.test.mjs — login hardening against a real API process:
// throttling (per account and per IP), server-side sessions (rotation, idle
// timeout, absolute lifetime, logout revocation), the password policy, forced
// password changes, admin resets and the e-mail reset flow.

import assert from 'node:assert/strict';

import { ADMIN, STAFF, expectStatus, sleep, withHearth } from '../helpers/app.mjs';
import { startResendStub } from '../helpers/resend-stub.mjs';
import { decodeToken } from '../../api/lib/tokens.mjs';

export default [
  {
    name: 'per-account lockout: after LOGIN_MAX_FAILURES wrong passwords even the right one is refused with 429 and retry_after',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl, env: { LOGIN_MAX_FAILURES: '3' } }, async (api) => {
      for (let i = 0; i < 3; i++) expectStatus(await api.login(STAFF.email, 'wrong-password-123'), 401, 'INVALID_CREDENTIALS', `try ${i}`);
      const locked = await api.login(STAFF.email, STAFF.password);
      expectStatus(locked, 429, 'LOGIN_LOCKED', 'right password while locked');
      assert.ok(locked.json.error.retry_after > 0 && locked.json.error.retry_after <= 60);
      assert.ok(Number(locked.headers['retry-after']) > 0);
      // other accounts are unaffected
      expectStatus(await api.login(ADMIN.email, ADMIN.password), 200, undefined, 'admin');
      // unknown accounts lock the same way (no account enumeration through the lock)
      for (let i = 0; i < 3; i++) await api.login('nobody@example.test', 'wrong-password-123');
      expectStatus(await api.login('nobody@example.test', 'x'), 429, 'LOGIN_LOCKED', 'unknown account');
      const failed = await api.audit("action = 'login_failed' and actor_email = $1", [STAFF.email]);
      assert.ok(failed.length >= 4, `login_failed audit rows: ${failed.length}`);
      assert.ok(failed.some((r) => r.summary?.reason === 'account_locked'));
      // after the lock expires (simulated by ageing the attempts) the right password works
      await api.db.query("update public.login_attempts set created_at = created_at - interval '2 hours'");
      expectStatus(await api.login(STAFF.email, STAFF.password), 200, undefined, 'after the lock');
    }),
  },
  {
    name: 'per-IP lockout: many failures from one address across different names block that address',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl, env: { LOGIN_IP_MAX_FAILURES: '4', LOGIN_MAX_FAILURES: '50' } }, async (api) => {
      for (let i = 0; i < 4; i++) expectStatus(await api.login(`spray${i}@example.test`, 'wrong-password-123'), 401);
      expectStatus(await api.login(ADMIN.email, ADMIN.password), 429, 'LOGIN_LOCKED', 'admin from the sprayed IP');
    }),
  },
  {
    name: 'every login creates a new server-side session id; logout revokes it; tokens without a live session are refused',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const a = await api.login(ADMIN.email, ADMIN.password);
      const b = await api.login(ADMIN.email, ADMIN.password, { authorization: `Bearer ${a.json.access_token}` });
      const sidA = decodeToken(a.json.access_token).payload.sid;
      const sidB = decodeToken(b.json.access_token).payload.sid;
      assert.match(sidA, /^[0-9a-f-]{36}$/);
      assert.notEqual(sidA, sidB);
      // the session presented at login was rotated out
      expectStatus(await api.call('/api/auth/session', { token: a.json.access_token }), 401, undefined, 'rotated-out token');
      expectStatus(await api.call('/api/auth/session', { token: b.json.access_token }), 200, undefined, 'new token');
      expectStatus(await api.post('/api/auth/logout', {}, b.json.access_token), 200);
      expectStatus(await api.call('/api/auth/session', { token: b.json.access_token }), 401, undefined, 'after logout');
      const logouts = await api.audit("action = 'logout'");
      assert.equal(logouts.length, 1);
      const logins = await api.audit("action = 'login'");
      assert.equal(logins.length, 2);
      // the cookie is HttpOnly
      assert.match(String(a.headers['set-cookie']), /HttpOnly/);
    }),
  },
  {
    name: 'idle timeout: a session unused for longer than SESSION_IDLE_MINUTES answers 401 SESSION_EXPIRED',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const token = await api.token(ADMIN);
      expectStatus(await api.call('/api/auth/session', { token }), 200);
      await api.db.query("update public.app_sessions set last_seen_at = now() - interval '31 minutes'");
      expectStatus(await api.call('/api/auth/session', { token }), 401, 'SESSION_EXPIRED', 'idle');
      // the query route reports the same code (not a bare 401)
      expectStatus(await api.query({ table: 'patients', select: 'id' }, token), 401, 'SESSION_EXPIRED', 'query idle');
    }),
  },
  {
    name: 'absolute lifetime: a busy session still ends at SESSION_MAX_HOURS',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl, env: { SESSION_IDLE_MINUTES: '600' } }, async (api) => {
      const token = await api.token(ADMIN);
      await api.db.query("update public.app_sessions set expires_at = now() - interval '1 second', last_seen_at = now()");
      expectStatus(await api.call('/api/auth/session', { token }), 401, 'SESSION_EXPIRED', 'past lifetime');
    }),
  },
  {
    name: 'seeded accounts must change their password first; until then every data route answers 403 PASSWORD_CHANGE_REQUIRED',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl, env: { SEED_FORCE_PASSWORD_CHANGE: '1' } }, async (api) => {
      const r = await api.login(ADMIN.email, ADMIN.password);
      expectStatus(r, 200);
      assert.equal(r.json.must_change_password, true);
      assert.equal(r.json.user.must_change_password, true);
      const token = r.json.access_token;
      expectStatus(await api.query({ table: 'patients', select: 'id' }, token), 403, 'PASSWORD_CHANGE_REQUIRED', 'query');
      expectStatus(await api.call('/api/audit', { token }), 403, 'PASSWORD_CHANGE_REQUIRED', 'audit');
      expectStatus(await api.call('/api/auth/session', { token }), 200, undefined, 'session stays readable');
      // the policy
      for (const [pw, label] of [['short-1', 'short'], ['123456789012345', 'digits'], ['Password123!', 'common'], ['admin@example.test', 'e-mail']]) {
        expectStatus(await api.post('/api/auth/change-password', { current_password: ADMIN.password, new_password: pw }, token), 400, 'WEAK_PASSWORD', label);
      }
      expectStatus(await api.post('/api/auth/change-password', { current_password: 'not-it-at-all', new_password: 'Fresh-Lantern-Cove-42' }, token), 401, 'INVALID_CREDENTIALS', 'wrong current');
      const changed = await api.post('/api/auth/change-password', { current_password: ADMIN.password, new_password: 'Fresh-Lantern-Cove-42' }, token);
      expectStatus(changed, 200, undefined, 'change');
      assert.equal(changed.json.must_change_password, false);
      expectStatus(await api.call('/api/auth/session', { token }), 401, undefined, 'old token after change');
      expectStatus(await api.query({ table: 'patients', select: 'id' }, changed.json.access_token), 200, undefined, 'new token');
      expectStatus(await api.login(ADMIN.email, ADMIN.password), 401, undefined, 'old password');
      const audit = await api.audit("action = 'update' and entity_type = 'user'");
      assert.ok(audit.some((a) => JSON.stringify(a.summary).includes('password')));
      assert.ok(!JSON.stringify(audit).includes('Fresh-Lantern-Cove-42'), 'the audit log must never hold a password');
    }),
  },
  {
    name: 'admin password reset: temporary password, the user is signed out everywhere and must change it; non-admins cannot reset',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const staffToken = await api.token(STAFF);
      const { rows } = await api.db.query('select id from public.app_users where email = $1', [STAFF.email]);
      const staffId = rows[0].id;
      expectStatus(await api.post(`/api/auth/admin/users/${staffId}/reset-password`, {}, staffToken), 403, 'FORBIDDEN', 'staff resets');
      const r = await api.post(`/api/auth/admin/users/${staffId}/reset-password`, {}, admin);
      expectStatus(r, 200);
      assert.match(r.json.temporary_password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
      expectStatus(await api.call('/api/auth/session', { token: staffToken }), 401, undefined, 'staff session revoked');
      const login = await api.login(STAFF.email, r.json.temporary_password);
      expectStatus(login, 200);
      assert.equal(login.json.must_change_password, true);
      expectStatus(await api.post('/api/auth/admin/users/not-a-uuid/reset-password', {}, admin), 400);
      // admin-created accounts start with a forced change and must meet the policy
      expectStatus(await api.post('/api/auth/admin/users', { email: 'weak@example.test', password: 'password', role: 'user' }, admin), 400, 'WEAK_PASSWORD');
      const created = await api.post('/api/auth/admin/users', { email: 'new.clinician@example.test', password: 'Quiet-Harbour-Lamp-7', role: 'user' }, admin);
      expectStatus(created, 200);
      const fresh = await api.login('new.clinician@example.test', 'Quiet-Harbour-Lamp-7');
      assert.equal(fresh.json.must_change_password, true);
    }),
  },
  {
    name: 'self-service reset is off without e-mail (404) and, with e-mail, single-use, hashed at rest and expiring',
    fn: async ({ root, testUrl }) => {
      await withHearth({ root, testUrl }, async (api) => {
        expectStatus(await api.post('/api/auth/password-reset/request', { email: STAFF.email }), 404, 'FEATURE_DISABLED');
        const f = await api.call('/api/auth/features');
        assert.deepEqual(f.json, { email: false, password_reset_email: false, receipt_scanning: false, self_signup: false });
      });
      const stub = await startResendStub();
      try {
        await withHearth({ root, testUrl, env: { RESEND_API_KEY: 'rk_test_stub', RESEND_API_BASE: stub.baseUrl, RESEND_FROM_SYSTEM: 'Hearth <noreply@example.test>', APP_BASE_URL: 'https://clinic.example.test' } }, async (api) => {
          const f = await api.call('/api/auth/features');
          assert.equal(f.json.password_reset_email, true);
          // unknown address: same answer, no mail
          expectStatus(await api.post('/api/auth/password-reset/request', { email: 'ghost@example.test' }), 202);
          assert.equal(stub.requests.length, 0);
          expectStatus(await api.post('/api/auth/password-reset/request', { email: STAFF.email }), 202);
          assert.equal(stub.requests.length, 1);
          const html = stub.requests[0].json.html;
          const m = /reset-password\?token=([A-Za-z0-9_%-]+)/.exec(html);
          assert.ok(m, html);
          assert.ok(html.includes('https://clinic.example.test/reset-password?token='));
          const token = decodeURIComponent(m[1]);
          const stored = await api.db.query('select token_hash from public.password_reset_tokens');
          assert.equal(stored.rows.length, 1);
          assert.notEqual(stored.rows[0].token_hash, token, 'the token is stored hashed');
          assert.ok(!stored.rows[0].token_hash.includes(token));
          expectStatus(await api.post('/api/auth/password-reset/confirm', { token, new_password: 'short' }), 400, 'WEAK_PASSWORD');
          expectStatus(await api.post('/api/auth/password-reset/confirm', { token, new_password: 'Silver-Maple-Kettle-3' }), 200);
          expectStatus(await api.post('/api/auth/password-reset/confirm', { token, new_password: 'Another-Maple-Kettle-4' }), 400, 'INVALID_TOKEN', 'reuse');
          expectStatus(await api.login(STAFF.email, 'Silver-Maple-Kettle-3'), 200);
          // an expired token is refused
          await api.post('/api/auth/password-reset/request', { email: STAFF.email });
          const second = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(stub.requests.at(-1).json.html)[1]);
          await api.db.query("update public.password_reset_tokens set expires_at = now() - interval '1 minute' where used_at is null");
          expectStatus(await api.post('/api/auth/password-reset/confirm', { token: second, new_password: 'Third-Maple-Kettle-5' }), 400, 'INVALID_TOKEN', 'expired');
        });
      } finally {
        await stub.close();
      }
    },
  },
  {
    name: 'responses carry the browser hardening headers and /api answers are never cached',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const r = await api.call('/api/auth/features');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.match(r.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(r.headers['cache-control'], 'no-store');
    }),
  },
];
