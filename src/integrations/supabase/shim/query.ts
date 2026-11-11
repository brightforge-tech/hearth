// src/integrations/supabase/shim/query.ts — the `supabase.from(...)` chain and
// the `supabase.rpc(...)` call of the browser shim (task t8). It is the piece
// that turns a PostgREST-shaped chain of calls into one POST /api/query
// request (api/routes/query.mjs) and its {data, error} envelope back into the
// {data, error} object the 12 consumer files already destructure.
//
// What is reproduced, and the one place the wire shape differs:
//
//   * select strings — passed through untouched, embeds and all; the API
//     parses them (api/lib/sql-spec.mjs). `select()` with no argument is `*`,
//     as in supabase-js.
//   * filters — eq/neq/gt/gte/lt/lte/is/in/ilike/like land in the request's
//     `filters` object as {op, value} under their column.
//   * or(...) strings — passed through untouched.
//   * Two or more conditions on the SAME column (`.gte('created_at', from)
//     .lte('created_at', to)`, as the Exports stats and the Revenue cards use)
//     cannot live in a map keyed by column, so the shim folds them into the
//     `or` field with PostgREST's own and(...) group grammar, with every value
//     double-quoted: `and(created_at.gte."2026-01-01",created_at.lte."...")`.
//     The API's grammar (api/lib/filters.mjs) honours quotes for both dots and
//     commas, and binds the value as a parameter either way.
//   * order/limit/range → order:[{column,ascending}] + limit/offset.
//   * verbs insert/update/delete/upsert({onConflict}), single/maybeSingle.
//   * The response envelope is {data, error}; a single()/maybeSingle() that
//     found no row carries the API's PGRST116 inside the envelope — the exact
//     behaviour supabase-js had, which Billing.tsx relies on.
//
// Requests carry `Authorization: Bearer <token>` only when a session exists;
// with none the header is absent, which is what lets LandingPage.tsx's public
// queries reach the API's anonymous allow-list.

import type { PostgrestError as PostgrestErrorType, QueryResponse } from './types.ts';
import { PostgrestError } from './types.ts';

/** One filter as it travels to the API. */
interface FilterSpec {
  op: string;
  value: unknown;
}

export interface QueryContext {
  baseUrl: string;
  getToken(): string | null;
  fetch?: typeof globalThis.fetch;
}

/** The chain a page holds: every filter verb returns `this`, and awaiting the
 *  chain runs the request (it is a thenable, exactly like supabase-js's
 *  PostgrestBuilder — that is what makes `await supabase.from(...)...` and
 *  `Promise.all([builderA, builderB])` both keep working). */
export interface QueryChain<T = any> extends PromiseLike<QueryResponse<T>> {}

type Verb = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

/** The value side of the or()/and() grammar as the shim writes it: everything
 *  double-quoted, so a value may contain dots (timestamps) or commas without
 *  the grammar reading them as separators. */
function quoteOrValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `(${value.map(quoteOrValue).join(',')})`;
  const text = typeof value === 'string' ? value : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

class Chain<T = any> implements PromiseLike<QueryResponse<T>> {
  #ctx: QueryContext;
  #table: string;
  #verb: Verb = 'select';
  #select: string | null = null;
  #filters: Array<[string, FilterSpec]> = [];
  #ors: string[] = [];
  #order: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }> = [];
  #limit: number | null = null;
  #offset: number | null = null;
  #payload: unknown = undefined;
  #onConflict: string | null = null;
  #single = false;
  #maybeSingle = false;

  constructor(ctx: QueryContext, table: string) {
    this.#ctx = ctx;
    this.#table = table;
  }

  // --- verbs ---------------------------------------------------------------

  select(columns = '*'): this {
    // After a write verb, select() only declares the returned shape — the verb
    // stays, exactly like the old library's `insert(...).select('id')` pattern
    // (AdminSettings and Visit.tsx both rely on it). The verb default is
    // already 'select', so nothing has to be set here.
    this.#select = columns;
    return this;
  }

  insert(payload: unknown): this {
    this.#verb = 'insert';
    this.#payload = payload;
    return this;
  }

  update(payload: unknown): this {
    this.#verb = 'update';
    this.#payload = payload;
    return this;
  }

  /** supabase-js's upsert: one row or many, plus {onConflict: 'col[,col]'}. */
  upsert(payload: unknown, options?: { onConflict?: string }): this {
    this.#verb = 'upsert';
    this.#payload = payload;
    if (options?.onConflict) this.#onConflict = options.onConflict;
    return this;
  }

  delete(): this {
    this.#verb = 'delete';
    return this;
  }

  // --- filters -------------------------------------------------------------

  #add(op: string, column: string, value: unknown): this {
    this.#filters.push([column, { op, value }]);
    return this;
  }

  eq(column: string, value: unknown): this { return this.#add('eq', column, value); }
  neq(column: string, value: unknown): this { return this.#add('neq', column, value); }
  gt(column: string, value: unknown): this { return this.#add('gt', column, value); }
  gte(column: string, value: unknown): this { return this.#add('gte', column, value); }
  lt(column: string, value: unknown): this { return this.#add('lt', column, value); }
  lte(column: string, value: unknown): this { return this.#add('lte', column, value); }
  like(column: string, pattern: string): this { return this.#add('like', column, pattern); }
  ilike(column: string, pattern: string): this { return this.#add('ilike', column, pattern); }
  is(column: string, value: unknown): this { return this.#add('is', column, value); }
  in(column: string, values: readonly unknown[]): this { return this.#add('in', column, Array.isArray(values) ? [...values] : values); }

  /** PostgREST's or-filter string, passed through verbatim — it is already in
   *  the grammar api/lib/filters.mjs speaks. */
  or(filter: string): this {
    this.#ors.push(filter);
    return this;
  }

  // --- shape ---------------------------------------------------------------

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const entry: { column: string; ascending: boolean; nullsFirst?: boolean } = {
      column,
      ascending: options?.ascending !== false,
    };
    if (options?.nullsFirst !== undefined) entry.nullsFirst = options.nullsFirst;
    this.#order.push(entry);
    return this;
  }

  limit(count: number): this {
    this.#limit = count;
    return this;
  }

  /** PostgREST's 0-based inclusive window, expressed as the API's limit/offset. */
  range(from: number, to: number): this {
    this.#offset = from;
    this.#limit = Math.max(0, to - from + 1);
    return this;
  }

  single(): PromiseLike<QueryResponse<T>> {
    this.#single = true;
    return this;
  }

  maybeSingle(): PromiseLike<QueryResponse<T | null>> {
    this.#maybeSingle = true;
    return this as unknown as PromiseLike<QueryResponse<T | null>>;
  }

  // --- request body ----------------------------------------------------------

  /** Build the POST /api/query body for what the chain collected. */
  toSpec(): Record<string, unknown> {
    const body: Record<string, unknown> = { table: this.#table, verb: this.#verb };
    if (this.#select !== null) body.select = this.#select;
    if (this.#payload !== undefined) body.payload = this.#payload;
    if (this.#onConflict) body.onConflict = this.#onConflict;
    if (this.#order.length) body.order = this.#order;
    if (this.#limit !== null) body.limit = this.#limit;
    if (this.#offset !== null) body.offset = this.#offset;
    if (this.#single) body.single = true;
    if (this.#maybeSingle) body.maybeSingle = true;

    // Columns with one condition go into `filters` directly. A column with
    // several conditions (the gte+lte date windows the pages build) becomes one
    // and(...) group in the `or` field — see the header for why.
    const byColumn = new Map<string, FilterSpec[]>();
    for (const [column, spec] of this.#filters) {
      const list = byColumn.get(column);
      if (list) list.push(spec);
      else byColumn.set(column, [spec]);
    }
    const filters: Record<string, FilterSpec> = {};
    const groups: string[] = [];
    for (const [column, specs] of byColumn) {
      if (specs.length === 1 && !Object.prototype.hasOwnProperty.call(filters, column)) {
        filters[column] = specs[0];
        continue;
      }
      groups.push(`and(${specs.map((spec) => `${column}.${spec.op}.${quoteOrValue(spec.value)}`).join(',')})`);
    }
    const totalGroups = groups.length + this.#ors.length;
    for (const text of this.#ors) {
      // A lone or() string is the or field itself; next to other groups it must
      // keep its OR meaning inside the AND, so it is wrapped in the grammar's
      // own or(...) form.
      groups.push(totalGroups > 1 ? `or(${text})` : text);
    }
    if (Object.keys(filters).length > 0) body.filters = filters;
    if (groups.length === 1) body.or = groups[0];
    else if (groups.length > 1) body.or = `and(${groups.join(',')})`;

    return body;
  }

  // --- execution -------------------------------------------------------------

  then<R = QueryResponse<T>, S = never>(
    onfulfilled?: ((value: QueryResponse<T>) => R | PromiseLike<R>) | null,
    onrejected?: ((reason: unknown) => S | PromiseLike<S>) | null
  ): PromiseLike<R | S> {
    return this.#execute().then(onfulfilled, onrejected);
  }

  async #execute(): Promise<QueryResponse<T>> {
    return requestApi<T>(this.#ctx, '/api/query', this.toSpec());
  }
}

/** One POST with the bearer header when there is a session, converted from the
 *  API's {"error":{"code","message"}} / {data,error} wire shapes into the
 *  {data, error} supabase-js object. Exported for rpc.ts/storage use. */
export async function requestApi<T>(
  ctx: QueryContext,
  path: string,
  body: unknown,
  { method = 'POST' }: { method?: string } = {}
): Promise<QueryResponse<T>> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = ctx.getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchImpl(`${ctx.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return {
      data: null as T,
      error: new PostgrestError(`Cannot reach the API at ${ctx.baseUrl}${path}: ${(e as Error).message}`, 'FETCH_ERROR'),
    };
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A non-JSON body is handled by the status branches below.
  }

  const envelope = json as { data?: unknown; error?: { code?: string; message?: string; details?: string } } | null;
  const errorFromEnvelope = (): PostgrestErrorType =>
    new PostgrestError(
      envelope?.error?.message || `The API answered ${response.status}`,
      envelope?.error?.code ?? (response.status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
      envelope?.error?.details ?? null
    );

  // 200: the query route always answers {data, error}, including the PostgREST
  // PGRST116 single() miss inside the envelope — pass both through unchanged.
  if (response.ok) {
    if (envelope && typeof envelope === 'object' && ('data' in envelope || 'error' in envelope)) {
      return {
        data: (envelope.data ?? null) as T,
        error: envelope.error ? new PostgrestError(envelope.error.message || 'Query failed', envelope.error.code ?? 'PGRST_ERROR', envelope.error.details ?? null) : null,
      };
    }
    // The rpc route answers with the bare rows array.
    return { data: json as T, error: null };
  }
  return { data: null as T, error: errorFromEnvelope() };
}

/** createQueryClient({ baseUrl, getToken }): the `from` and `rpc` surface. */
export function createQueryClient(ctx: QueryContext) {
  return {
    from(table: string): Chain<any> {
      return new Chain(ctx, table);
    },

    /** supabase.rpc(name, args) — POST /api/rpc/<name>. The API allow-lists the
     *  names and answers with the rows array (api/routes/rpc.mjs); the old
     *  client wrapped that into {data, error} for the page, and so do we. */
    async rpc(function_name: string, args: Record<string, unknown> = {}): Promise<QueryResponse<any>> {
      return requestApi(ctx, `/api/rpc/${encodeURIComponent(function_name)}`, args ?? {});
    },
  };
}

export default createQueryClient;
