// src/integrations/supabase/shim/storage.ts — the `supabase.storage` half of
// the supabase-js surface (task t8).
//
// One call site in the app matters today: Visit.tsx uploads the signature
// PNG via `supabase.storage.from("signatures").upload(path, blob, {...})`.
// The self-hosted transport (route lands in task t9) is
//   PUT /api/storage/<bucket>/<path>            body: raw bytes
//   x-upsert: 'true' when options.upsert
//   content-type: options.contentType
// and errors arrive as the same JSON envelope the query routes use, so
// `const { error } = await upload(...)` keeps its old meaning.

import type { PostgrestError as PostgrestErrorType } from './types.ts';
import type { QueryContext } from './query.ts';

/** Map a failed storage response the same way the query routes map errors:
 *  JSON envelope { error: { message, code, details, hint } } if present,
 *  otherwise the bare status. */
async function errorFrom(res: Response): Promise<PostgrestErrorType & Error> {
  let message = `Upload failed with status ${res.status}`;
  let code = String(res.status);
  let details: string | null = null;
  let hint: string | null = null;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = String(body.error.code);
    if (typeof body?.error?.details === 'string') details = body.error.details;
    if (typeof body?.error?.hint === 'string') hint = body.error.hint;
  } catch { /* not JSON: status text is all we have */ }
  const err = new Error(message) as PostgrestErrorType & Error;
  err.code = code;
  err.details = details;
  err.hint = hint;
  return err;
}

interface UploadOptions {
  contentType?: string;
  upsert?: boolean;
  [key: string]: unknown;
}

export function createStorageClient(ctx: QueryContext) {
  const encodePath = (path: string) =>
    String(path).split('/').map((part) => encodeURIComponent(part)).join('/');

  return {
    from(bucket: string) {
      return {
        /** upload(path, body, options) — body may be a Blob/File, an
         *  ArrayBuffer/TypedArray, or a string (stored as UTF-8). */
        async upload(
          path: string,
          body: Blob | ArrayBuffer | ArrayBufferView | string,
          options: UploadOptions = {},
        ): Promise<{ data: { path: string; fullPath: string } | null; error: PostgrestErrorType | null }> {
          let payload: BodyInit = body as BodyInit;
          if (typeof body === 'string') payload = new TextEncoder().encode(body);
          else if (ArrayBuffer.isView(body)) payload = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);

          try {
            const token = ctx.getToken();
            const res = await (ctx.fetch ?? globalThis.fetch)(
              `${ctx.baseUrl}/api/storage/${encodeURIComponent(bucket)}/${encodePath(path)}`,
              {
                method: 'PUT',
                headers: {
                  ...(token ? { authorization: `Bearer ${token}` } : {}),
                  ...(options.contentType ? { 'content-type': options.contentType } : {}),
                  ...(options.upsert ? { 'x-upsert': 'true' } : {}),
                },
                body: payload,
              },
            );
            if (res.ok) {
              return { data: { path, fullPath: `${bucket}/${path}` }, error: null };
            }
            return { data: null, error: await errorFrom(res) };
          } catch (err) {
            const e = new Error(String((err as Error)?.message ?? err)) as PostgrestErrorType & Error;
            e.code = 'STORAGE_ERROR';
            e.details = null;
            e.hint = null;
            return { data: null, error: e };
          }
        },

        /** getPublicUrl(path) — never throws in supabase-js; the self-hosted
         *  route serves bucket objects under the same path. */
        getPublicUrl(path: string): { data: { publicUrl: string } } {
          return { data: { publicUrl: `${ctx.baseUrl}/api/storage/${encodeURIComponent(bucket)}/${encodePath(path)}` } };
        },
      };
    },
  };
}
