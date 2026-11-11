// tests/api/passwords.test.mjs — api/lib/passwords.mjs (task t5, criterion W20).
//
// The criterion is about what may NOT end up in app_users.password_hash: the
// plaintext, or a bare md5/sha of the password. The module's contract is the
// replacement: a self-describing scrypt record with a per-user salt, verified
// in (near) constant time. No database and no server here — the record format,
// the salt behaviour and the verify answer set are pure code properties, and
// the column that stores one is checked over real HTTP in tests/api/auth.test.mjs.

import { createHash } from 'node:crypto';

import { hashPassword, isPasswordHash, MAX_PASSWORD_LENGTH, SCRYPT_PARAMS, verifyPassword } from '../../api/lib/passwords.mjs';

const PASSWORD = 'Admin#2025test';

// Every digest of the password the module must never be mistaken for: hex and
// base64 of md5/sha1/sha256/sha512.
function forbiddenForms(password) {
  const forms = [];
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) {
    forms.push(createHash(algo).update(password, 'utf8').digest('hex'));
    forms.push(createHash(algo).update(password, 'utf8').digest('base64'));
  }
  forms.push(password);
  return forms;
}

export default [
  {
    name: 'a hash is a scrypt record with cost parameters and a per-user salt — never the password or a bare digest',
    async fn() {
      const stored = await hashPassword(PASSWORD);
      if (!isPasswordHash(stored)) throw new Error(`not a recognised record: ${stored}`);
      const parts = stored.split('$');
      if (parts[0] !== 'scrypt') throw new Error(`algorithm field is ${parts[0]}`);
      const [, N, r, p, salt, hash] = parts;
      if (Number(N) !== SCRYPT_PARAMS.N || Number(r) !== SCRYPT_PARAMS.r || Number(p) !== SCRYPT_PARAMS.p) {
        throw new Error(`cost parameters ${N}/${r}/${p} are not the configured ${SCRYPT_PARAMS.N}/${SCRYPT_PARAMS.r}/${SCRYPT_PARAMS.p}`);
      }
      if (Buffer.from(salt, 'base64').length < 16) throw new Error('the salt is shorter than 16 bytes');
      if (Buffer.from(hash, 'base64').length !== SCRYPT_PARAMS.keyLength) {
        throw new Error(`the key is ${Buffer.from(hash, 'base64').length} bytes, expected ${SCRYPT_PARAMS.keyLength}`);
      }
      for (const forbidden of forbiddenForms(PASSWORD)) {
        if (stored === forbidden) throw new Error(`the stored value IS a bare digest of the password: ${forbidden}`);
        if (stored.includes(forbidden)) throw new Error(`the stored value contains a bare digest of the password: ${forbidden}`);
      }
      // hex-only digests of any length are never this format
      if (/^[0-9a-f]+$/.test(stored)) throw new Error(`the stored value looks like a hex digest: ${stored}`);
    },
  },
  {
    name: 'the same password hashes to different records (a fresh random salt per user)',
    async fn() {
      const a = await hashPassword(PASSWORD);
      const b = await hashPassword(PASSWORD);
      if (a === b) throw new Error('two hashes of the same password are identical — no per-record salt');
      if (a.split('$')[4] === b.split('$')[4]) throw new Error('the two records share their salt');
      if (!(await verifyPassword(PASSWORD, a)) || !(await verifyPassword(PASSWORD, b))) {
        throw new Error('both records must verify the password they were hashed from');
      }
    },
  },
  {
    name: 'verify says yes to the right password and no to everything else',
    async fn() {
      const stored = await hashPassword('S0me-Long_Passw0rd!');
      if (!(await verifyPassword('S0me-Long_Passw0rd!', stored))) throw new Error('the right password was refused');
      for (const wrong of ['S0me-Long_Passw0rd', 's0me-long_passw0rd!', 'S0me-Long_Passw0rd!!', '', '  S0me-Long_Passw0rd!  ']) {
        if (await verifyPassword(wrong, stored)) throw new Error(`a wrong password verified: ${JSON.stringify(wrong)}`);
      }
    },
  },
  {
    name: 'a tampered record does not verify, however it was tampered with',
    async fn() {
      const stored = await hashPassword(PASSWORD);
      const [alg, N, r, p, salt, hash] = stored.split('$');
      const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
      const mutations = [
        [alg, N, r, p, salt, flip(hash)], // last character of the key
        [alg, N, r, p, flip(salt), hash], // the salt
        [alg, N, r, p, salt, hash.slice(0, -4)], // truncated key
        ['scryptt', N, r, p, salt, hash], // algorithm field
        ['bcrypt', N, r, p, salt, hash], // algorithm substitution
        ['md5', N, r, p, salt, hash],
        [alg, String(Number(N) / 2), r, p, salt, hash], // downgraded cost
        [`${salt}$${hash}`, 'x', 'x', 'x', 'x', 'x'], // field injection
      ];
      for (const partsM of mutations) {
        const storedM = partsM.join('$');
        if (await verifyPassword(PASSWORD, storedM)) throw new Error(`a tampered record verified: ${storedM}`);
      }
      for (const garbage of ['', 'plaintext', 'scrypt', 'scrypt$1$1$1$AAAA$AAAA', `${'a'.repeat(64)}`, createHash('md5').update(PASSWORD).digest('hex')]) {
        if (await verifyPassword(PASSWORD, garbage)) throw new Error(`garbage stored value verified: ${garbage}`);
      }
    },
  },
  {
    name: 'verify never throws: a missing or non-string value is simply a refusal',
    async fn() {
      for (const value of [undefined, null, 42, {}, [], true]) {
        if (await verifyPassword(PASSWORD, value)) throw new Error(`verify(${JSON.stringify(value)}) said yes`);
      }
      const stored = await hashPassword(PASSWORD);
      for (const value of [undefined, null, 42, {}]) {
        if (await verifyPassword(value, stored)) throw new Error(`a non-string password verified: ${JSON.stringify(value)}`);
      }
    },
  },
  {
    name: 'an absurd cost parameter is refused, not derived (no DoS through a poisoned row)',
    async fn() {
      const expensive = 'scrypt$2147483648$1024$8$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAA';
      const started = Date.now();
      if (await verifyPassword(PASSWORD, expensive)) throw new Error('the expensive record verified');
      if (Date.now() - started > 500) throw new Error('verify attempted the expensive derivation');
    },
  },
  {
    name: 'hashPassword refuses input it must not store: empty, non-string or oversized',
    async fn() {
      for (const bad of ['', undefined, null, 42, {}, Buffer.from('x')]) {
        let thrown = null;
        try {
          await hashPassword(bad);
        } catch (e) {
          thrown = e;
        }
        if (!thrown || thrown.code !== 'BAD_PASSWORD_INPUT') throw new Error(`hashPassword(${JSON.stringify(bad)}) must be refused with BAD_PASSWORD_INPUT`);
      }
      let thrown = null;
      try {
        await hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1));
      } catch (e) {
        thrown = e;
      }
      if (!thrown || thrown.code !== 'BAD_PASSWORD_INPUT') throw new Error('an oversized password must be refused');
    },
  },
  {
    name: 'unicode, emoji and long passwords round-trip',
    async fn() {
      for (const password of ['pässwört-ünïcode-ünicode', 'パスワード123!漢字', '🔐 clinic admin 🔑 2025', 'x'.repeat(512)]) {
        const stored = await hashPassword(password);
        if (!(await verifyPassword(password, stored))) throw new Error(`round-trip failed for ${JSON.stringify(password.slice(0, 16))}…`);
      }
    },
  },
  {
    name: 'isPasswordHash recognises only this module\'s records',
    async fn() {
      if (!isPasswordHash(await hashPassword('long-enough-1'))) throw new Error('a real hash was not recognised');
      for (const notAHash of ['$2b$10$abcdefghijklmnopqrstuv', '$argon2id$v=19$m=65536', '5f4dcc3b5aa765d61d8327deb882cf99', '', 'scrypt$16384$8$1$!!invalid-base64!!$AAAA']) {
        if (isPasswordHash(notAHash)) throw new Error(`recognised a foreign format: ${notAHash}`);
      }
    },
  },
];
