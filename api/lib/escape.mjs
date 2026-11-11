// api/lib/escape.mjs — the one HTML escaper the e-mail builders use (task t11).
//
// S10: the shipped edge functions interpolated patient names, addresses, phone
// numbers and the appointment reason straight into the HTML they handed to
// Resend. A patient stored with `<script>alert(1)</script>` as a name — or an
// `<img src=x onerror=...>` — therefore arrived in the recipient's inbox as
// live markup (a stored-XSS vector that travels by mail). The port escapes
// every interpolated value, so data can never contribute tags, attributes or
// entity starts.
//
// The five replacements are the HTML5 attribute/text set:
//
//   &  -> &amp;    (first, or it would double-escape the others)
//   <  -> &lt;
//   >  -> &gt;
//   "  -> &quot;   (cannot break out of a double-quoted attribute)
//   '  -> &#39;    (cannot break out of a single-quoted attribute)
//
// escapeHtml(null/undefined) returns '' — which is what the legacy templates
// already rendered for a missing value, so the conditional `${value ? ... : ''}`
// branches keep the exact legacy truthiness. Anything else is stringified, so
// the numeric interpolations (toFixed results, quantities) pass through
// untouched and stay byte-compatible.

// The map is fixed and total: there is no way to ask this function to escape
// fewer characters, which is what makes "every interpolation goes through
// escapeHtml" auditable in one grep.
const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// escapeHtml(value): the value as HTML text. null/undefined become ''.
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
