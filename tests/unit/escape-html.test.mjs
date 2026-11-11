/**
 * Unit tests for the HTML escaper (api/lib/escape.mjs), milestone 5 (t14).
 *
 * `escapeHtml` is the only thing standing between patient data and script
 * execution inside the invoice/receipt email templates, which interpolate
 * patient names, appointment reasons and clinic settings into HTML with no
 * autoescaping (there is no JSX there, just template strings — the same
 * hand-written strings the legacy edge functions shipped). The hostile
 * contract fixture proves the end-to-end path; these pin the character rules
 * themselves so a future refactor of the helper is caught directly:
 *
 *   - `&` is escaped first, otherwise it would double-escape the other
 *     entities' own `&`;
 *   - `<`, `>` are escaped (no tags can start);
 *   - `"` and `'` are escaped too, because every interpolation in the
 *     templates sits inside a double-quoted HTML attribute as well as in text
 *     position (href, style-less class, etc.) — the same coverage
 *     heptabase's escapeHtml had, per the migration notes;
 *   - null/undefined render as the empty string. The legacy template
 *     interpolated names raw (`${invoice.appointment?.patient?.first_name}`),
 *     so a missing related row printed the literal word "undefined" into the
 *     letter; with escaping in front of the interpolation, nothing renders —
 *     the endpoint additionally refuses to mail an invoice that has no
 *     patient at all (the port's one recorded deviation, documented in
 *     send-invoice-email.test.mjs);
 *   - ampersand sequences that look like entities (&amp;, &#39;, &#x27;) are
 *     escaped too, i.e. the escaper never decodes, only encodes.
 */

import assert from 'node:assert/strict';

import { escapeHtml } from '../../api/lib/escape.mjs';

export default [
  {
    name: 'escapeHtml: encodes all five significant characters',
    async fn() {
      assert.equal(escapeHtml('&'), '&amp;');
      assert.equal(escapeHtml('<'), '&lt;');
      assert.equal(escapeHtml('>'), '&gt;');
      assert.equal(escapeHtml('"'), '&quot;');
      assert.equal(escapeHtml("'"), '&#39;');
    },
  },

  {
    name: 'escapeHtml: ampersand is escaped first (no double-encoding of entities)',
    async fn() {
      assert.equal(escapeHtml('&lt;'), '&amp;lt;');
      assert.equal(escapeHtml('&amp;'), '&amp;amp;');
      assert.equal(escapeHtml('&#39;'), '&amp;#39;');
      assert.equal(escapeHtml('&#x27;'), '&amp;#x27;');
      assert.equal(escapeHtml('A & B < C'), 'A &amp; B &lt; C');
    },
  },

  {
    name: 'escapeHtml: the hostile fixture payloads become inert text',
    async fn() {
      const cases = [
        ['<script>alert("xss")</script>', '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'],
        ['"><img src=x onerror=alert(1)>', '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'],
        ["'; DROP TABLE--", '&#39;; DROP TABLE--'],
        // `&#39;` in the source must NOT come out as a live apostrophe
        ['&quot;onmouseover=1&quot;', '&amp;quot;onmouseover=1&amp;quot;'],
      ];
      for (const [input, want] of cases) {
        const got = escapeHtml(input);
        assert.equal(got, want);
        assert.ok(!got.includes('<'), `escaped output carries no live tag: ${input}`);
        assert.ok(!/<(script|img|iframe)/i.test(got), 'no tag name can be formed');
      }
    },
  },

  {
    name: 'escapeHtml: nullish renders empty; everything else stringifies like legacy',
    async fn() {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
      assert.equal(escapeHtml(''), '');
      assert.equal(escapeHtml(0), '0');
      assert.equal(escapeHtml('Dr. “Smart” Quotes'), 'Dr. “Smart” Quotes'); // unicode passes through
      assert.equal(escapeHtml('a\nb'), 'a\nb'); // newlines are safe in HTML text
    },
  },

  {
    name: 'escapeHtml: idempotence check — an escaped value never becomes a tag again',
    async fn() {
      const once = escapeHtml('<a href="x">y</a>');
      const twice = escapeHtml(once);
      assert.ok(twice.startsWith('&amp;lt;'), 'second pass encodes the first pass\' entities');
      // the renderer only ever calls it once per interpolation, but even a
      // double call cannot resurrect markup
      assert.ok(!twice.includes('<'));
    },
  },
];
