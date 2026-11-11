// api/routes/expenses.mjs — optional AI receipt scanning for the Expenses page.
//
//   POST /api/expenses/analyze-receipt {image: "data:image/<type>;base64,..."}
//        -> 200 {description, amount, category, expense_date, reference, notes}
//
// OFF unless RECEIPT_AI_API_KEY is set (404 FEATURE_DISABLED otherwise). When
// on, the receipt image is sent to the configured provider: any
// OpenAI-compatible chat-completions endpoint (RECEIPT_AI_BASE_URL, default
// https://api.openai.com/v1; a self-hosted model server works too) with
// RECEIPT_AI_MODEL (default gpt-4o-mini). The result only pre-fills the
// expense form; staff review it and nothing is saved by this endpoint.
// Expenses themselves are ordinary rows written through /api/query.

import express from 'express';

import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { receiptScanningEnabled } from '../lib/features.mjs';
import { clientIp, recordAudit } from '../lib/audit.mjs';

export const EXPENSE_CATEGORIES = Object.freeze([
  'Office Supplies', 'Medical Equipment', 'Rent', 'Utilities', 'Insurance', 'Marketing',
  'Professional Services', 'Maintenance', 'Software Subscriptions', 'Training & Education',
  'Travel', 'Meals & Entertainment', 'Other',
]);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;

const SYSTEM_PROMPT = `You are a receipt analyzer. Extract expense information from the receipt image and return ONLY a JSON object:
{"description": "brief description", "amount": 0.00, "category": "one of: ${EXPENSE_CATEGORIES.join(', ')}", "expense_date": "YYYY-MM-DD", "reference": "receipt or invoice number if visible", "notes": "vendor name, payment method or other relevant details"}
Use the total amount. If the date is unclear use an empty string. Return only the JSON object.`;

export function aiConfig(env = process.env) {
  return {
    key: String(env.RECEIPT_AI_API_KEY ?? '').trim(),
    base: (String(env.RECEIPT_AI_BASE_URL ?? '').trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: String(env.RECEIPT_AI_MODEL ?? '').trim() || 'gpt-4o-mini',
  };
}

// normalizeResult(raw): whatever the model said, coerced into the form's shape.
export function normalizeResult(raw, today = new Date().toISOString().slice(0, 10)) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const amount = Number.parseFloat(String(obj.amount ?? '').replace(/[^0-9.\-]/g, ''));
  const date = str(obj.expense_date, 10);
  const category = EXPENSE_CATEGORIES.find((c) => c.toLowerCase() === str(obj.category, 60).toLowerCase()) ?? 'Other';
  return {
    description: str(obj.description, 200) || 'Receipt expense',
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0,
    category,
    expense_date: /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : today,
    reference: str(obj.reference, 100),
    notes: str(obj.notes, 500),
  };
}

export function parseModelContent(content) {
  const text = String(content ?? '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

const handleAnalyze = asyncHandler(async (req, res) => {
  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  const m = DATA_URL_RE.exec(image);
  if (!m) throw new ApiError(400, 'image must be a data:image/(png|jpeg|webp|gif);base64 URL', 'INVALID_INPUT');
  if (Buffer.byteLength(m[2], 'base64') > MAX_IMAGE_BYTES) throw new ApiError(413, 'The image is larger than 8 MB', 'PAYLOAD_TOO_LARGE');

  const cfg = aiConfig();
  let response;
  try {
    response = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: 'Extract the expense from this receipt.' }, { type: 'image_url', image_url: { url: image } }] },
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ApiError(502, `The receipt service could not be reached: ${e?.message ?? 'network error'}`, 'UPSTREAM_ERROR');
  }
  if (!response.ok) {
    throw new ApiError(502, `The receipt service answered ${response.status}`, 'UPSTREAM_ERROR');
  }
  const data = await response.json().catch(() => null);
  const parsed = parseModelContent(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new ApiError(502, 'Could not read expense details from the receipt', 'UPSTREAM_ERROR');
  await recordAudit({ user: req.user, action: 'export', entityType: 'receipt_scan', ip: clientIp(req), summary: { provider_host: new URL(cfg.base).host, model: cfg.model } });
  sendJson(res, 200, normalizeResult(parsed));
});

export function createExpensesRouter() {
  const router = express.Router();
  router.post(
    '/analyze-receipt',
    requireAuth,
    requireRole('admin', 'moderator'),
    (req, res, next) => (receiptScanningEnabled() ? next() : next(new ApiError(404, 'Receipt scanning is not enabled on this server', 'FEATURE_DISABLED'))),
    handleAnalyze
  );
  return router;
}

export const router = createExpensesRouter();
export default createExpensesRouter;
