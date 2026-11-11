// api/lib/uploads.mjs — the disk half of the storage routes (task t9, W35).
//
// Two things make an upload endpoint dangerous, and both are decided here, in
// one place, before any byte reaches the disk:
//
//   1. WHERE the bytes land. The bucket must be one of BUCKETS, and the object
//      name must normalise to a path inside UPLOAD_DIR/<bucket>/. The name comes
//      from the URL, so it arrives percent-decoded and may contain `..`,
//      backslashes (a separator on Windows), control characters or a NUL; each
//      of those is refused with 400 BAD_PATH, and the resolved path is checked
//      against the bucket directory as well — the allow-list and the containment
//      test have to agree, because one of them is only as good as the other.
//   2. HOW MUCH of it. MAX_UPLOAD_BYTES (10 MB) is the cap the route hands to
//      express.raw, so an oversized body is refused while it is still arriving
//      rather than after it has been buffered.
//
// What is stored where: the bytes go to UPLOAD_DIR/<bucket>/<name> (UPLOAD_DIR
// defaults to var/uploads, which is gitignored — uploads are runtime artifacts,
// never committed); one row per object in public.storage_objects carries the
// metadata the routes serve back out (mime, byte count, sha256, owner), which is
// the local equivalent of the hosted storage.objects table (0006_storage.sql).
//
// Every error thrown from here is the ApiError the shared error handler already
// knows how to answer, so the storage routes need no mapping of their own.

import { createHash, randomBytes } from 'node:crypto';
import { stat } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { ROOT } from './env.mjs';
import { ApiError } from './http.mjs';

// ===== the policy knobs ======================================================

// The plan's cap, and the number a caller can be told about: "a signature is a
// PNG of a signature pad; anything larger is a mistake or an attack".
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The two buckets of the hosted project (0006_storage.sql inserts both). An
// unknown bucket is refused rather than created on demand: a bucket is a
// policy boundary, not a directory someone can invent by URL.
export const BUCKETS = Object.freeze(['signatures', 'exports']);

// The media types that may be stored. Visit.tsx uploads 'image/png'; the export
// endpoints (tasks t10..t12) write 'text/csv'. A type outside this set is a 415:
// storing an arbitrary type is how an upload endpoint turns into a phishing
// host, because the GET route serves the stored type straight back.
export const MEDIA_TYPES = Object.freeze(
  new Map([
    ['image/png', 'image/png'],
    ['text/csv', 'text/csv'],
  ])
);

// Depth and length caps: a 1 MB object name is not a name, and a 100-deep tree
// is a way to make a directory listing unusable.
const MAX_NAME_CHARS = 1024;
const MAX_SEGMENTS = 16;

// Windows refuses to create files with these stems (a signature named "con.png"
// would look like a server error), so they are refused as bad paths, which is
// what they are on this platform.
const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_unused, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_unused, i) => `lpt${i + 1}`),
]);

// ===== buckets and roots ======================================================

export function isBucket(name) {
  return typeof name === 'string' && BUCKETS.includes(name);
}

// uploadRoot(env): where objects live. Relative values are resolved from the
// project root, which is what makes the default `var/uploads` independent of
// the process' working directory.
export function uploadRoot(env = process.env) {
  const raw = String(env.UPLOAD_DIR ?? '').trim() || 'var/uploads';
  return resolve(ROOT, raw.replace(/[\\/]+$/, ''));
}

// bucketDir(bucket, root): UPLOAD_DIR/<bucket>, resolved and normalised.
export function bucketDir(bucket, root = uploadRoot()) {
  return resolve(root, bucket);
}

// ===== the name ================================================================

// normalizeObjectName(raw): the caller's path -> a safe, normalised object name.
// `raw` is what the router handed over, already percent-decoded (express decodes
// route params, so "%2e%2e%2f" has become "../" by the time it gets here, and
// decoding it a second time would turn a legal "%" into something else).
//
// Refusals are all 400 BAD_PATH, and each one names what is wrong:
//   * control characters and NUL — never part of a name, and a truncated-path
//     trap on every filesystem;
//   * backslashes — a directory separator on Windows, so "a\b" could climb out;
//   * ".." segments — the escape attempt W35 asks about, refused by name rather
//     than cleaned up by a normaliser the caller did not expect;
//   * empty, over-long, or over-deep names;
//   * a Windows reserved stem.
// `.` segments and duplicate slashes are simply normalised away, since they
// cannot escape anything.
export function normalizeObjectName(raw) {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'an object name is required', 'BAD_PATH');
  }
  if (raw.length > MAX_NAME_CHARS) {
    throw new ApiError(400, `an object name may be at most ${MAX_NAME_CHARS} characters`, 'BAD_PATH');
  }
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new ApiError(400, `the object name contains a control character (0x${code.toString(16)})`, 'BAD_PATH');
    }
  }
  if (raw.includes('\\')) {
    throw new ApiError(400, 'an object name may not contain a backslash; use "/" between folders', 'BAD_PATH');
  }

  const segments = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue; // a leading slash or a doubled slash: nothing to say
    if (part === '..') {
      throw new ApiError(400, `the object name ${JSON.stringify(raw)} climbs out of its bucket with ".."`, 'BAD_PATH');
    }
    segments.push(part);
  }
  if (segments.length === 0) throw new ApiError(400, 'an object name is required', 'BAD_PATH');
  if (segments.length > MAX_SEGMENTS) {
    throw new ApiError(400, `an object name may be at most ${MAX_SEGMENTS} folders deep`, 'BAD_PATH');
  }
  const stem = segments[segments.length - 1].split('.')[0].toLowerCase();
  if (RESERVED_STEMS.has(stem)) {
    throw new ApiError(400, `${JSON.stringify(segments[segments.length - 1])} is a name the server's filesystem reserves`, 'BAD_PATH');
  }
  return segments.join('/');
}

// resolveObject(bucket, raw, {root}): everything a storage route needs for one
// object — the bucket, the normalised name (what storage_objects stores), and the
// absolute path the bytes live at.
//
// The containment test is the last line, and it is written as a test rather than
// as a normalisation: the resolved path must be strictly below the bucket
// directory. normalizeObjectName already refuses "..", so this normally cannot
// fire; it exists so that a future change to the name rules cannot silently
// widen where files land.
export function resolveObject(bucket, raw, { root = uploadRoot() } = {}) {
  if (!isBucket(bucket)) {
    throw new ApiError(
      400,
      `unknown storage bucket ${JSON.stringify(bucket)}: this API serves the ${BUCKETS.join(' and ')} buckets`,
      'BAD_BUCKET'
    );
  }
  const name = normalizeObjectName(raw);
  const dir = bucketDir(bucket, root);
  const filePath = resolve(dir, ...name.split('/'));
  if (filePath === dir || !isWithin(dir, filePath)) {
    throw new ApiError(400, `the object name ${JSON.stringify(name)} escapes the ${JSON.stringify(bucket)} bucket`, 'BAD_PATH');
  }
  return { bucket, name, filePath, bucketDirPath: dir };
}

// isWithin(parent, child): child is strictly below parent (this platform's
// separators, whatever they are).
function isWithin(parent, child) {
  if (isAbsolute(parent) !== isAbsolute(child)) return false;
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0];
  return first !== '..';
}

// ===== the media type ==========================================================

// mediaTypeOf(header): the request's Content-Type, canonicalised to one of
// MEDIA_TYPES' keys, or a 415. Parameters ("; charset=utf-8") are dropped.
export function mediaTypeOf(header) {
  const type = String(header ?? '').split(';')[0].trim().toLowerCase();
  const stored = MEDIA_TYPES.get(type);
  if (!stored) {
    throw new ApiError(
      415,
      `this API stores uploads as ${[...MEDIA_TYPES.keys()].join(' or ')}, not ${JSON.stringify(type || 'no content type')}`,
      'UNSUPPORTED_MEDIA_TYPE'
    );
  }
  return stored;
}

// ===== the bytes ==============================================================

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// putFile(filePath, buffer): write the bytes so a reader never sees a half
// file. The bytes land in a sibling temp file first and are then moved into
// place; a failed write leaves the previous object (if any) exactly as it was
// and removes the temp file.
export async function putFile(filePath, buffer) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, buffer, { flag: 'wx' });
    try {
      await renameOrReplace(tmp, filePath);
    } catch (e) {
      // Windows can refuse the move while another handle (an antivirus scan, a
      // GET of the same object) is open: the object is then left as it was.
      const wrapped = new ApiError(500, `could not store the uploaded object: ${e.code ?? e.message}`, 'UPLOAD_FAILED');
      wrapped.cause = e;
      throw wrapped;
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { bytes: buffer.length, sha256: sha256Hex(buffer) };
}

// renameOrReplace(tmp, filePath): an atomic replace where the platform gives
// one (POSIX rename), falling back to unlink+rename where it does not.
async function renameOrReplace(tmp, filePath) {
  try {
    await rename(tmp, filePath);
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
    await unlink(filePath).catch(() => {});
    await rename(tmp, filePath);
  }
}

// removeFile(filePath): delete an object's bytes, ignoring "it was not there".
export async function removeFile(filePath) {
  try {
    await unlink(filePath);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// statFile(filePath): {size, mtimeMs} for the bytes, or null when there are
// none. The routes answer 404 with this — an object row whose file has gone is
// the same answer to a browser as an object that was never uploaded.
export function statFile(filePath) {
  return new Promise((resolveStat, rejectStat) => {
    stat(filePath, (err, info) => {
      if (!err) return resolveStat({ size: info.size, mtimeMs: info.mtimeMs });
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return resolveStat(null);
      rejectStat(err);
    });
  });
}

export default { BUCKETS, MAX_UPLOAD_BYTES, MEDIA_TYPES, isBucket, uploadRoot, bucketDir, normalizeObjectName, resolveObject, mediaTypeOf, sha256Hex, putFile, removeFile, statFile };
