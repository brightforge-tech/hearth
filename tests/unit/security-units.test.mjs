// tests/unit/security-units.test.mjs — pure functions behind the security
// features: password policy, lockout backoff, booking validation, receipt
// normalisation, feature flags, proxy trust and audit filters.

import assert from 'node:assert/strict';

import { checkPassword, MIN_LENGTH } from '../../api/lib/password-policy.mjs';
import { lockMinutes } from '../../api/lib/throttle.mjs';
import { validateBooking, hashIp } from '../../api/routes/public.mjs';
import { normalizeResult, parseModelContent, aiConfig } from '../../api/routes/expenses.mjs';
import { features } from '../../api/lib/features.mjs';
import { trustProxySetting } from '../../api/routes/index.mjs';
import { buildAuditFilter, primaryRole } from '../../api/lib/audit.mjs';
import { temporaryPassword } from '../../api/routes/auth.mjs';
import { sessionIdleMinutes, sessionMaxHours } from '../../api/lib/sessions.mjs';

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

export default [
  {
    name: 'password policy: length 12, not all digits, not common, not the e-mail',
    fn: () => {
      assert.equal(MIN_LENGTH, 12);
      assert.match(checkPassword('Short-pw1'), /at least 12/);
      assert.match(checkPassword('1234567890123'), /digits only/);
      for (const common of ['passwordpassword', 'Password123456', 'qwertyuiop123', 'aaaaaaaaaaaaaa', 'Administrator1!', 'iloveyou123!!!']) {
        assert.match(String(checkPassword(common)), /too common/, common);
      }
      assert.match(String(checkPassword('dr.jones@example.test', { email: 'dr.jones@example.test' })), /e-mail/);
      assert.match(String(checkPassword('dr.jones2026!', { email: 'dr.jones@example.test' })), /e-mail/);
      assert.equal(checkPassword('Quiet-Harbour-Lamp-7', { email: 'a@example.test' }), null);
      assert.equal(checkPassword('correct horse battery staple'), null);
      assert.match(checkPassword('x'.repeat(1025)), /at most/);
    },
  },
  {
    name: 'lockout backoff doubles from 1 minute after the limit and is capped',
    fn: () => {
      const cfg = { maxFailures: 5, maxLockMinutes: 60 };
      assert.deepEqual([4, 5, 6, 7, 8, 20].map((n) => lockMinutes(n, cfg)), [0, 1, 2, 4, 8, 60]);
    },
  },
  {
    name: 'booking validation: required fields, contact, caps, dates, unknown fields',
    fn: () => {
      const ok = { first_name: ' Ada ', last_name: 'Example', phone: '+1 (555) 010-0100', reason: 'Check-up', preferred_date: day(1), preferred_time: '09:15', website: '' };
      const row = validateBooking(ok);
      assert.equal(row.first_name, 'Ada');
      assert.equal(row.email, null);
      assert.throws(() => validateBooking({ ...ok, first_name: '' }), /first name is required/);
      assert.throws(() => validateBooking({ ...ok, phone: null }), /e-mail address or a phone/);
      assert.throws(() => validateBooking({ ...ok, phone: 'call me maybe' }), /phone/);
      assert.throws(() => validateBooking({ ...ok, date_of_birth: day(10) }), /date of birth/);
      assert.throws(() => validateBooking({ ...ok, preferred_time: '9am' }), /HH:MM/);
      assert.throws(() => validateBooking({ ...ok, preferred_date: '2020-01-01' }), /next year/);
      assert.throws(() => validateBooking({ ...ok, patient_id: 'x' }), /unexpected field/);
      assert.throws(() => validateBooking([ok]), /JSON object/);
      assert.throws(() => validateBooking({ ...ok, reason: 7 }), /must be text/);
      // control characters are stripped
      assert.equal(validateBooking({ ...ok, reason: 'a\u0000b' }).reason, 'ab');
    },
  },
  {
    name: 'booking IP hashing is keyed and stable, never the raw address',
    fn: () => {
      const a = hashIp('203.0.113.7', { JWT_SECRET: 'k1' });
      assert.match(a, /^[0-9a-f]{64}$/);
      assert.equal(a, hashIp('203.0.113.7', { JWT_SECRET: 'k1' }));
      assert.notEqual(a, hashIp('203.0.113.7', { JWT_SECRET: 'k2' }));
      assert.ok(!a.includes('203'));
    },
  },
  {
    name: 'receipt results are normalised into the form shape whatever the model says',
    fn: () => {
      assert.deepEqual(parseModelContent('noise {"amount": 3} trailing'), { amount: 3 });
      assert.equal(parseModelContent('no json here'), null);
      const r = normalizeResult({ amount: 'USD 1,234.567', category: 'RENT', expense_date: 'yesterday', description: '' }, '2026-02-01');
      assert.deepEqual(r, { description: 'Receipt expense', amount: 1234.57, category: 'Rent', expense_date: '2026-02-01', reference: '', notes: '' });
      assert.equal(normalizeResult({ category: 'Lasers' }).category, 'Other');
      assert.equal(normalizeResult({ amount: -5 }).amount, 0);
      assert.deepEqual(aiConfig({}), { key: '', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
      assert.equal(aiConfig({ RECEIPT_AI_BASE_URL: 'http://127.0.0.1:11434/v1/' }).base, 'http://127.0.0.1:11434/v1');
    },
  },
  {
    name: 'every optional integration is off by default',
    fn: () => {
      assert.deepEqual(features({}), { email: false, password_reset_email: false, receipt_scanning: false, self_signup: false });
      assert.deepEqual(features({ RESEND_API_KEY: 'k', RESEND_FROM_SYSTEM: 'a@example.test', RECEIPT_AI_API_KEY: 'k', ALLOW_SELF_SIGNUP: 'true' }), { email: true, password_reset_email: true, receipt_scanning: true, self_signup: true });
      assert.equal(features({ RESEND_API_KEY: 'k' }).password_reset_email, false, 'no sender, no reset mails');
    },
  },
  {
    name: 'proxy trust defaults to loopback/private hops only and can be switched off',
    fn: () => {
      assert.equal(trustProxySetting({}), 'loopback, linklocal, uniquelocal');
      assert.equal(trustProxySetting({ TRUST_PROXY: 'false' }), false);
      assert.equal(trustProxySetting({ TRUST_PROXY: '2' }), 2);
    },
  },
  {
    name: 'audit filters bind every value and reject bad dates/actions; primaryRole picks the highest role',
    fn: () => {
      const f = buildAuditFilter({ from: '2026-01-01', to: '2026-01-31', actor: "o'brien%", action: 'view', entity_type: 'patient', entity_id: 'abc' });
      assert.equal(f.params.length, 6);
      assert.ok(!f.where.includes("o'brien"));
      assert.equal(f.params[2], "o'brien\\%");
      assert.throws(() => buildAuditFilter({ from: 'nope' }), /YYYY-MM-DD/);
      assert.throws(() => buildAuditFilter({ action: 'drop table' }), /unknown action/);
      assert.deepEqual(buildAuditFilter({}), { where: '', params: [] });
      assert.equal(primaryRole({ roles: ['user', 'admin'] }), 'admin');
      assert.equal(primaryRole({ roles: [] }), null);
    },
  },
  {
    name: 'temporary passwords are random, readable and pass the policy; session settings have safe defaults',
    fn: () => {
      const a = temporaryPassword();
      assert.match(a, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
      assert.notEqual(a, temporaryPassword());
      assert.equal(checkPassword(a), null);
      assert.equal(sessionIdleMinutes({}), 30);
      assert.equal(sessionMaxHours({}), 12);
      assert.equal(sessionMaxHours({ SESSION_TTL_HOURS: '8' }), 8);
      assert.equal(sessionMaxHours({ SESSION_MAX_HOURS: '4', SESSION_TTL_HOURS: '8' }), 4);
      assert.throws(() => sessionIdleMinutes({ SESSION_IDLE_MINUTES: '-1' }), /positive/);
    },
  },
];
