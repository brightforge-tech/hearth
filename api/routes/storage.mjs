// api/routes/storage.mjs — PUT / GET / HEAD /api/storage/<bucket>/<path>
// (task t9, W35).
//
// This is the path Visit.tsx uses for a signature: the page calls
// `supabase.storage.from('signatures').upload(path, blob, {contentType, upsert})`,
// the shim (task t8) turns that into a raw PUT here, and the note it saves then
// points at `appointment_<id>/<timestamp>.png`. Serving those files back is the
// other half: an `<img src>` for a signature the staff member is looking at.
//
//   PUT  /api/storage/signatures/appointment_1/1700000000000.png
//        Authorization: Bearer <session>        (required — 401 without one)
//        Content-Type: image/png                (only image/png | text/csv)
//        x-upsert: true                         (replace an existing object)
//        body: the raw bytes, at most 10 MB
//   ->   200 {"Path":"signatures/appointment_1/1700000000000.png"}
//        400 the bucket or the name is refused (api/lib/uploads.mjs)
//        401 no session, 403 a session with no role, 413 too big, 415 bad type
//        409 an object with that name exists and x-upsert was not sent
//
//   GET|HEAD /api/storage/<bucket>/<path>   Authorization: Bearer <session>
//   ->   200 the bytes, with the stored Content-Type (Content-Length, ETag from
//        the stored sha256), or 404 when there is no such object.
//
// Why a session is required on GET: the hosted buckets are private
// (storage_buckets."public" is false for both, and the hosted policies let only
// signed-in users read objects), so an anonymous request must not be able to
// walk the signatures bucket and read patients' signatures.
//
// Why a rejected or failed upload leaves nothing behind: the bucket, the name,
// the media type and the size are all judged before anything is written; a name
// that already exists is refused before it can be clobbered; the metadata row is
// written, then the bytes land in a sibling temp file and are moved into place;
// and if that last step fails, the row this request created is taken back out.
// So there is never a row pointing at a missing file, nor a file no row names.
//
// Note what is NOT here: no DELETE. The app never deletes a signature — a
// signature is part of the clinical record — and the hosted project gave the
// SPA no delete path either, so this route does not invent one.

import { createReadStream } from 'node:fs';
import express from 'express';

import { query } from '../db.mjs';
import { ApiError, asyncHandler, readRawBody, sendJson } from '../lib/http.mjs';
import { requireAuth } from '../lib/session.mjs';
import { MAX_UPLOAD_BYTES, mediaTypeOf, putFile, resolveObject, sha256Hex, statFile } from '../lib/uploads.mjs';

// --- storage_objects, the index of what is on disk ---------------------------

// writeObjectRow: the metadata half of an upload.
//
// The two cases are deliberately two statements: without x-upsert a repeat is
// the caller's mistake (409), with it the replacement was asked for.
// `on conflict do nothing` + rowCount is what distinguishes them without a race:
// two concurrent first-PUTs of the same name cannot both be told they inserted.
async function writeObjectRow({ bucket, name, owner, mime, bytes, sha256, upsert }) {
  const onConflict = upsert
    ? `on conflict ("bucket", "name") do update
          set "owner" = excluded."owner", "mime" = excluded."mime",
              "bytes" = excluded."bytes", "sha256" = excluded."sha256"`
    : `on conflict ("bucket", "name") do nothing`;
  let rows;
  try {
    ({ rows } = await query(
      `insert into public."storage_objects" ("bucket", "name", "owner", "mime", "bytes", "sha256")
       values ($1, $2, $3, $4, $5, $6)
       ${onConflict}
       returning "id"`,
      [bucket, name, owner, mime, bytes, sha256]
    ));
  } catch (e) {
    // storage_objects.bucket references storage_buckets(id), and 0006_storage.sql
    // inserts both rows, so a violation here can only mean a bucket the allow-list
    // lets through that this database has not provisioned — said plainly, rather
    // than as a Postgres message with a constraint name in it.
    if (e && e.code === '23503') {
      throw new ApiError(400, `the storage bucket ${JSON.stringify(bucket)} is not provisioned in this database`, 'BAD_BUCKET');
    }
    throw e;
  }
  if (rows.length === 0) {
    throw new ApiError(
      409,
      `an object already exists at ${bucket}/${name}: send the header "x-upsert: true" to replace it`,
      'CONFLICT'
    );
  }
  return rows[0].id;
}

async function readObjectRow(bucket, name) {
  const { rows } = await query(
    `select "id", "mime", "bytes", "sha256", "created_at"
       from public."storage_objects"
      where "bucket" = $1 and "name" = $2`,
    [bucket, name]
  );
  return rows[0] ?? null;
}

async function deleteObjectRow(id) {
  await query('delete from public."storage_objects" where "id" = $1', [id]).catch(() => {});
}

// --- the handlers -------------------------------------------------------------

async function handlePut(req, res) {
  // 1. where would it go, and is that a legal answer? (400 BAD_BUCKET/BAD_PATH)
  const target = resolveObject(req.params.bucket, req.params[0]);

  // 2. what is it? (415 unless it is one of the two types this API stores)
  const mime = mediaTypeOf(req.headers['content-type']);

  // 3. the bytes, capped at 10 MB. readRawBody (api/lib/http.mjs) is what every
  //    body this API reads goes through; it refuses an oversized upload as a
  //    413 PAYLOAD_TOO_LARGE that names the cap — the number the shim surfaces
  //    to the Visit.tsx toast. (express.raw is deliberately NOT used here: when
  //    body-parser gives up on a request it destroys the request stream, and
  //    the shared error handler's "the caller hung up" guard then cannot tell
  //    that cancellation from a dead client — and would answer nothing.)
  const body = await readRawBody(req, MAX_UPLOAD_BYTES);

  const upsert = /^(?:1|true|yes)$/i.test(String(req.headers['x-upsert'] ?? '').trim());

  // Does something already live here? Asked before anything is written, for two
  // reasons: a repeat without x-upsert is refused before it can clobber the
  // object it collided with, and a failed write has to know whether the row it
  // is taking back out was its own or somebody else's.
  const existing = await readObjectRow(target.bucket, target.name);
  if (existing && !upsert) {
    throw new ApiError(
      409,
      `an object already exists at ${target.bucket}/${target.name}: send the header "x-upsert: true" to replace it`,
      'CONFLICT'
    );
  }

  // Metadata first, then bytes, then the bytes are moved into place (uploads.mjs
  // writes to a sibling temp file and renames), so a request that gets this far
  // and fails on the disk leaves no half-written object behind. The insert is
  // still `on conflict`-guarded, because between this read and that write a
  // second upload of the same name may have landed.
  const id = await writeObjectRow({
    bucket: target.bucket,
    name: target.name,
    owner: req.user?.id ?? null,
    mime,
    bytes: body.length,
    sha256: sha256Hex(body),
    upsert,
  });
  try {
    await putFile(target.filePath, body);
  } catch (e) {
    if (!existing) await deleteObjectRow(id); // only a row this request made is this request's to undo
    throw e;
  }

  // The legacy storage contract the shim's callers expect on success is the
  // object's path; the byte count is what Visit.tsx would want if it ever shows
  // one, and the sha256 lets an operator compare a file against the row by hand.
  return sendJson(res, 200, { Path: `${target.bucket}/${target.name}` });
}

async function handleRead(req, res) {
  const target = resolveObject(req.params.bucket, req.params[0]);
  const row = await readObjectRow(target.bucket, target.name);
  if (!row) {
    throw new ApiError(404, `no object ${JSON.stringify(target.name)} in the ${JSON.stringify(target.bucket)} bucket`, 'NOT_FOUND');
  }
  const file = await statFile(target.filePath);
  if (!file) {
    // The row exists but its bytes do not: the same answer for a browser, and a
    // message that says which of the two halves is missing for whoever looks.
    throw new ApiError(
      404,
      `the object ${JSON.stringify(target.name)} has no file in this server's upload directory`,
      'NOT_FOUND'
    );
  }

  // The stored mime is served verbatim — and only ever came from MEDIA_TYPES,
  // which is what makes it safe to hand straight to a browser.
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (row.sha256) res.setHeader('ETag', `"${row.sha256}"`);
  res.setHeader('Last-Modified', new Date(file.mtimeMs).toUTCString());

  if (req.method === 'HEAD') return res.status(200).end();

  res.status(200);
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(target.filePath);
    stream.on('error', rejectStream);
    stream.on('end', resolveStream);
    // A browser that hangs up mid-download must not leave a stream reading a
    // file nobody wants, and must not look like a server error either.
    res.on('close', () => {
      stream.destroy();
      resolveStream();
    });
    stream.pipe(res);
  });
  return undefined;
}

// The router.
//
// requireAuth is attached per method rather than with router.use(), so a verb
// this route does not implement (DELETE, PATCH...) still reaches the API's JSON
// 404 instead of being answered 401 by a guard on a route that does not exist.
export function createStorageRouter() {
  const router = express.Router();
  const path = '/:bucket/*';
  router.get(path, requireAuth, asyncHandler(handleRead));
  router.head(path, requireAuth, asyncHandler(handleRead));
  router.put(path, requireAuth, asyncHandler(handlePut));
  return router;
}

export const router = createStorageRouter();
export default createStorageRouter;
