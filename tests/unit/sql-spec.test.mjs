// tests/unit/sql-spec.test.mjs — the pure select-string parser (task t7).
//
// No database and no server: what this module promises is that the text a page
// sends becomes the tree the query route builds from, or a SpecError (a 400
// BAD_SELECT), and both halves of that promise are checkable in isolation.
// The strings are copied from what the app actually sends — the Billing page's
// two-level embed is the shape the parser exists for.

import assert from 'node:assert/strict';

import { MAX_DEPTH, outputKeys, parseSelect, splitTopLevel, SpecError, walk } from '../../api/lib/sql-spec.mjs';

const BILLING =
  'id, status, total, ' +
  'appointment:appointments(scheduled_start, reason, ' +
  'patient:patients(first_name, last_name, email, phone, address)), ' +
  'invoice_items(description, quantity, unit_price, line_total, service:services(name))';

function specError(fn) {
  assert.throws(fn, (e) => e instanceof SpecError && e.code === 'BAD_SELECT');
}

export default [
  {
    name: 'the Billing page select parses into the documented tree',
    fn: () => {
      const tree = parseSelect(BILLING);
      const [id, status, total, appt, items] = tree.fields;
      assert.deepEqual(
        { kind: id.kind, column: id.column, alias: id.alias },
        { kind: 'field', column: 'id', alias: 'id' }
      );
      assert.equal(status.column, 'status');
      assert.equal(total.column, 'total');

      // level 1: the to-one embed keeps its alias and its table separately
      assert.deepEqual({ kind: appt.kind, alias: appt.alias, table: appt.table }, { kind: 'embed', alias: 'appointment', table: 'appointments' });
      // level 2: the nested patient embed lives inside appointments' list
      const nested = appt.children.fields.find((f) => f.kind === 'embed');
      assert.deepEqual({ alias: nested.alias, table: nested.table }, { alias: 'patient', table: 'patients' });
      assert.deepEqual(nested.children.fields.map((f) => f.column), ['first_name', 'last_name', 'email', 'phone', 'address']);
      // the to-many embed and its own nested service
      assert.deepEqual({ kind: items.kind, alias: items.alias, table: items.table }, { kind: 'embed', alias: 'invoice_items', table: 'invoice_items' });
      const service = items.children.fields.find((f) => f.kind === 'embed');
      assert.equal(service.table, 'services');
    },
  },
  {
    name: "'*' and '' are the whole table; an explicit '*' inside an embed is refused",
    fn: () => {
      assert.deepEqual(parseSelect('*').fields, [{ kind: 'all' }]);
      assert.deepEqual(parseSelect('').fields, [{ kind: 'all' }]);
      assert.deepEqual(parseSelect(undefined).fields, [{ kind: 'all' }]);
      assert.deepEqual(parseSelect('  id , * ').fields.map((f) => f.kind), ['field', 'all']);
      specError(() => parseSelect('appointments(*)'));
    },
  },
  {
    name: 'aliases and casts: `label:status`, `total::float`, `label:col::type`',
    fn: () => {
      const t = parseSelect('label:status, total::float, when:scheduled_start::date');
      assert.deepEqual(
        t.fields.map((f) => ({ alias: f.alias, column: f.column, cast: f.cast })),
        [
          { alias: 'label', column: 'status', cast: null },
          { alias: 'total', column: 'total', cast: 'float' },
          { alias: 'when', column: 'scheduled_start', cast: 'date' },
        ]
      );
      specError(() => parseSelect('total::not_a_type(')); // '(' with no matching embed
    },
  },
  {
    name: '`!inner`/`!left`/`!outer` are captured as hints; a named-FK hint is refused',
    fn: () => {
      assert.equal(parseSelect('p:patients!inner(id)').fields[0].hint, 'inner');
      assert.equal(parseSelect('p:patients!left(id)').fields[0].hint, 'left');
      specError(() => parseSelect('p:patients!patients_pkey(id)'));
    },
  },
  {
    name: 'malformed input is SpecError, never a crash and never a silent tree',
    fn: () => {
      specError(() => parseSelect('id,,name')); // doubled comma
      specError(() => parseSelect('appointments((id')); // unbalanced paren
      specError(() => parseSelect('appointments(id) junk')); // text after the embed
      specError(() => parseSelect('id; drop table payments')); // anything non-identifier
      specError(() => parseSelect('appointments(123bad)')); // non-identifier column inside an embed
    },
  },
  {
    name: 'splitTopLevel splits only outside parens and quotes',
    fn: () => {
      assert.deepEqual(splitTopLevel('a(x,y),b', ','), ['a(x,y)', 'b']);
      assert.deepEqual(splitTopLevel('"a,b",c', ','), ['"a,b"', 'c']);
      assert.deepEqual(splitTopLevel('a.eq.x', '.'), ['a', 'eq', 'x']);
      assert.throws(() => splitTopLevel('a(b,c', ','), SpecError);
    },
  },
  {
    name: 'three embed levels are accepted (Billing\'s payments select), a fourth is the documented SpecError',
    fn: () => {
      // BILLING nests two levels: appointment > patient and invoice_items > service.
      assert.doesNotThrow(() => walk(parseSelect(BILLING), () => {}));
      // Billing.tsx's Recent Payments select nests three: invoice > appointment
      // > patient. This is the shape the payments tab ships and sends verbatim.
      const PAYMENTS =
        'id, amount, method, reference, received_at, invoice_id, ' +
        'invoice:invoices(id, total, currency_code, ' +
        'appointment:appointments(patient:patients(first_name, last_name, email, phone, address)))';
      assert.doesNotThrow(() => walk(parseSelect(PAYMENTS), () => {}));
      // four levels: a > b > c > d — deeper than any shipped consumer asks.
      const deep = parseSelect('a:payments(b:invoices(c:appointments(d:patients(id))))');
      specError(() => walk(deep, () => {}));
      assert.equal(MAX_DEPTH, 3);
    },
  },
  {
    name: 'outputKeys returns the JSON keys in select order, alias-resolved',
    fn: () => {
      assert.deepEqual(outputKeys(parseSelect(BILLING)), ['id', 'status', 'total', 'appointment', 'invoice_items']);
      assert.deepEqual(outputKeys(parseSelect('label:status, p:patients(id)')), ['label', 'p']);
    },
  },
];
