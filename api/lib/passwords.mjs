// api/lib/passwords.mjs — scrypt password hashing (task t5, criterion W20).
//
// app_users.password_hash stores exactly one thing this module can write:
//
//   scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
//
// — a self-describing scrypt record with a per-user random salt, so the same
// password hashes differently for every account (W20: no plaintext, no bare
// md5/sha of the password anywhere in the column), and the cost parameters
// travel with the hash instead of being compiled in, so raising them later is
// a migration and not a mass password reset.
//
// Parameters follow the current OWASP guidance for scrypt (N=2^14, r=8, p=1,
// 32-byte key, 16-byte salt). verifyPassword compares with timingSafeEqual and
// always runs the key derivation, so the answer does not arrive measurably
// faster for a wrong password than for a right one.
//
// The two failure surfaces are deliberately different:
//   * hashPassword INPUT faults (empty/oversized password) throw — a route
//     must not be able to store a hash of nothing;
//   * verifyPassword faults are always `false`: a malformed stored hash, a
//     non-string, an absurd cost parameter. Login answers 401 with one generic
//     message either way, and a broken row can never crash the route or be
//     used to make verification cost no work at all.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// The record's first field; the migration and the tests recognise this shape.
export const PASSWORD_ALGORITHM = 'scrypt';

// OWASP 2024 parameters for scrypt: N=2^14 blocks, r=8, p=1, 32-byte key.
export const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32, saltBytes: 16 });

// scrypt needs 128 * N * r * p bytes of memory; allow generous headroom, but
// refuse to derive anything a hostile stored hash could make expensive.
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;
const COST_CEILING = Object.freeze({ N: 1 << 20, r: 16, p: 8 });

// A password of more than this is almost certainly a copy-paste of a whole
// document, not a password; scrypt cost grows only with memory (N), so the
// cap is for sanity, not protection.
export const MAX_PASSWORD_LENGTH = 1024;

const RECORD = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

function inputFault(message) {
  const err = new Error(message);
  err.code = 'BAD_PASSWORD_INPUT';
  return err;
}

// derive(password, {N, r, p, salt, keyLength}): one scrypt run with the memory
// bound that the parameters actually need.
async function derive(password, { N, r, p, salt, keyLength }) {
  const memory = 128 * N * r * p;
  if (memory > MAX_SCRYPT_MEMORY) {
    throw inputFault(`refusing scrypt parameters needing ${memory} bytes of memory`);
  }
  return scrypt(Buffer.from(String(password), 'utf8'), salt, keyLength, { N, r, p, maxmem: memory + 8 * 1024 * 1024 });
}

// hashPassword(password) -> the self-describing scrypt record. Throws with
// code BAD_PASSWORD_INPUT on an empty/oversized/non-string password.
export async function hashPassword(password) {
  if (typeof password !== 'string' || password === '') {
    throw inputFault('password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw inputFault(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const { N, r, p, keyLength, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const key = await derive(password, { N, r, p, salt, keyLength });
  return [PASSWORD_ALGORITHM, N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

// isPasswordHash(stored): does the string look like this module's output?
export function isPasswordHash(stored) {
  return typeof stored === 'string' && RECORD.test(stored);
}

// verifyPassword(password, stored) -> true | false. Never throws: a stored
// value this module could not have written is simply "does not verify".
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string' || password === '') return false;
  const m = RECORD.exec(stored);
  if (!m) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  if (
    !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) ||
    N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1 ||
    N > COST_CEILING.N || r > COST_CEILING.r || p > COST_CEILING.p
  ) {
    return false;
  }
  const salt = Buffer.from(m[4], 'base64');
  const expected = Buffer.from(m[5], 'base64');
  // Exactly the configured key length: anything shorter is a truncated record,
  // and deriving the shorter length would match the truncated key by matching
  // its prefix — which is exactly how a truncated hash must never verify.
  if (salt.length < 8 || expected.length !== SCRYPT_PARAMS.keyLength) return false;
  let got;
  try {
    got = await derive(password, { N, r, p, salt, keyLength: SCRYPT_PARAMS.keyLength });
  } catch {
    return false;
  }
  return timingSafeEqual(got, expected);
}
