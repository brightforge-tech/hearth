// api/lib/sql-spec.mjs — the PostgREST `select` string parser (task t7).
//
// The browser sends the same select strings the pages send to the hosted
// PostgREST today (`src/pages/Billing.tsx:66` for instance):
//
//   id, status, total,
//   appointment:appointments(scheduled_start, reason,
//       patient:patients(first_name, last_name, email, phone, address)),
//   invoice_items(description, quantity, unit_price, line_total, service:services(name))
//
// This module turns such a string into a plain tree:
//
//   { fields: [{kind:'field', column, alias, cast},
//              {kind:'embed',  alias, table, hint, children: <tree>}] }
//
// and nothing else: it never sees the database, never builds SQL and never
// trusts an identifier — validation of every name against information_schema is
// api/lib/catalog.mjs's job, and the SQL that finally goes to Postgres is built
// in api/routes/query.mjs from the validated tree. Keeping the parser pure is
// what lets tests/ unit-test it without a database.
//
// Accepted grammar (the subset of PostgREST's select syntax the app uses, plus
// the nesting its pages actually send — up to three embed levels):
//
//   select        := item (',' item)*  | '*'  | ''
//   item          := field | embed
//   field         := [alias ':'] column ['::' type]
//   embed         := [alias ':'] table ['!' hint] '(' select ')'
//   alias, table, column := SQL identifier characters only
//
// `!inner`, `!left`, `!outer` and a named FK are captured as `hint`: they only
// choose join direction in PostgREST, and the route honours `inner` by dropping
// parents with no child, which is what that modifier means.
//
// Everything else is an error: an unexpected character, an empty list, a
// column named `*` inside an embed, or an embed nested four levels deep (the
// deepest shipped consumer is Billing.tsx's Recent Payments select, three:
// payments -> invoices -> appointments -> patients, and anything deeper means
// the string is not what we think it is). Errors are `SpecError`s carrying
// code BAD_SELECT; the route answers them as 400 {"error":{"code":"BAD_SELECT",...}}.

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecError';
    this.code = 'BAD_SELECT';
  }
}

// An SQL identifier as it may appear in a select string. Anything else (spaces,
// quotes, dots, parens, semicolons, dashes) cannot be a column or a table, so
// rejecting the shape here is the first line of defence against injection —
// catalog validation is the second.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The PostgREST join hints allowed after `table!`.
const HINTS = new Set(['inner', 'left', 'outer']);

// How many embed levels to accept. The shipped consumers use three: the
// Billing invoices select nests appointment -> patient and invoice_items ->
// service (two), and its Recent Payments select nests invoice -> appointment
// -> patient (src/pages/Billing.tsx:88-96) — three. Four is a request the app
// never makes, and a tree that deep is not a select string we understand.
export const MAX_DEPTH = 3;

// parseSelect(select, {defaultAll}) -> tree
//   '*' or '' (or undefined) with defaultAll -> every column of the table
//   (the route expands it against the catalog, so nothing here knows the table).
export function parseSelect(select, { defaultAll = true } = {}) {
  const text = select === undefined || select === null ? '' : String(select).trim();
  if (text === '' || text === '*') {
    if (!defaultAll) throw new SpecError('an empty select is not allowed here');
    return { fields: [{ kind: 'all' }] };
  }
  const items = splitTopLevel(text, ',');
  const fields = items.map((raw) => parseItem(raw.trim())).filter(Boolean);
  if (fields.length === 0) throw new SpecError(`the select list has no fields: ${JSON.stringify(text)}`);
  return { fields };
}

// parseItem: one comma-separated entry.
function parseItem(item) {
  if (item === '') throw new SpecError('the select list has an empty entry (a doubled comma?)');
  if (item === '*') return { kind: 'all' };

  const open = findFirstTopLevel(item, '(');
  if (open === -1) return parseField(item);

  const close = matchingParen(item, open);
  if (close !== item.length - 1) {
    throw new SpecError(`unexpected text after the embedded list in ${JSON.stringify(item)}`);
  }
  const head = item.slice(0, open).trim();
  const inner = item.slice(open + 1, close);

  // alias:table!hint
  let alias = null;
  let rest = head;
  const colon = indexOfTopLevel(rest, ':');
  if (colon !== -1) {
    alias = rest.slice(0, colon).trim();
    rest = rest.slice(colon + 1).trim();
    if (!IDENT.test(alias)) throw new SpecError(`invalid embed alias ${JSON.stringify(alias)}`);
  }
  let hint = null;
  const bang = rest.lastIndexOf('!');
  if (bang !== -1) {
    const rawHint = rest.slice(bang + 1).trim();
    rest = rest.slice(0, bang).trim();
    // A named foreign-key hint (invoices!payments_invoice_id(...)) is not a
    // direction; keep it out of `hint` so the caller is never told to join on
    // something this port does not implement.
    if (HINTS.has(rawHint.toLowerCase())) hint = rawHint.toLowerCase();
    else if (rawHint !== '') throw new SpecError(`unsupported relationship hint ${JSON.stringify(rawHint)} on ${JSON.stringify(rest)}`);
  }
  if (!IDENT.test(rest)) throw new SpecError(`invalid embedded table name ${JSON.stringify(rest)}`);

  const children = parseSelect(inner, { defaultAll: false });
  if (children.fields.some((f) => f.kind === 'all')) {
    throw new SpecError(`an embedded resource needs an explicit column list, not "*": ${JSON.stringify(rest)}`);
  }
  return { kind: 'embed', alias: alias ?? rest, table: rest, hint, children };
}

// parseField: `col`, `alias:col`, `col::type`, `alias:col::type`.
function parseField(item) {
  let rest = item;
  let cast = null;
  const at = rest.lastIndexOf('::');
  if (at !== -1) {
    cast = rest.slice(at + 2).trim();
    rest = rest.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(cast)) {
      throw new SpecError(`invalid cast ${JSON.stringify(cast)} in ${JSON.stringify(item)}`);
    }
  }
  let alias = null;
  let column = rest;
  const colon = rest.indexOf(':');
  if (colon !== -1) {
    alias = rest.slice(0, colon).trim();
    column = rest.slice(colon + 1).trim();
    if (!IDENT.test(alias)) throw new SpecError(`invalid column alias ${JSON.stringify(alias)}`);
  }
  if (!IDENT.test(column)) throw new SpecError(`invalid column name ${JSON.stringify(column)}`);
  return { kind: 'field', column, alias: alias ?? column, cast };
}

// --- splitting/parsing helpers that understand parentheses ------------------

// splitTopLevel(str, ','): split on the separator everywhere except inside ()
// or "" — that is what makes `items(id, name), other(x)` three items and not
// four, and lets a quoted value keep its commas.
export function splitTopLevel(str, separator) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === separator && depth === 0) {
      out.push(str.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) throw new SpecError(`unbalanced parentheses or quotes in ${JSON.stringify(str)}`);
  out.push(str.slice(start));
  return out;
}

// indexOfTopLevel / findFirstTopLevel: the first occurrence outside any ().
function indexOfTopLevel(str, needle) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    // The needle is checked BEFORE the depth bookkeeping, so that the needle
    // may itself be '(' — the caller looking for the start of an embed must
    // find it while still at depth 0.
    if (depth === 0 && ch === needle) return i;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return -1;
}
const findFirstTopLevel = indexOfTopLevel;

// matchingParen(str, open): index of the ')' closing the '(' at `open`.
function matchingParen(str, open) {
  let depth = 0;
  for (let i = open; i < str.length; i++) {
    if (str[i] === '(') depth += 1;
    else if (str[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SpecError(`unbalanced parentheses in ${JSON.stringify(str)}`);
}

// --- tree walkers used by the route ----------------------------------------

// walk(tree, fn): depth-first over every node, with the node's depth (0 at the
// top). Used to validate names and to collect the projections.
export function walk(tree, fn, depth = 0) {
  for (const node of tree.fields) {
    fn(node, depth);
    if (node.kind === 'embed') {
      if (depth >= MAX_DEPTH) {
        throw new SpecError(`embedded resources may be nested ${MAX_DEPTH} levels deep at most (found one deeper under ${JSON.stringify(node.alias)})`);
      }
      walk(node.children, fn, depth + 1);
    }
  }
}

// outputKeys(tree): the keys the built JSON object carries, in select order
// ('*' already expanded into columns by the caller).
export function outputKeys(tree) {
  return tree.fields.map((node) => node.alias);
}

export default parseSelect;
