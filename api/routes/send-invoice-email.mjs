// api/routes/send-invoice-email.mjs — the invoice e-mail endpoint, ported from
// supabase/functions/send-invoice-email (task t11).
//
// The request and response contracts stay what Billing.tsx (and, until the
// cutover, the shipped function) spoke:
//
//   POST {invoiceId, recipientEmail} + staff Bearer token
//   200 {"success":true,"message":"Invoice email sent successfully","emailId":...}
//   500 {"success":false,"error":"<message>"}
//
// including the legacy quirk that a missing invoiceId (or an id that does not
// resolve) answers 'Invoice not found' as a 500 — the shipped code reached
// the same branch through its `.single()` error.
//
// What changes with the port (the milestone-4 fixes):
//
//   * S27 — requireAuth + requireRole gate the endpoint before any SQL runs:
//     an absent/forged session answers 401 and a roleless session 403 with
//     the standard envelope, never the legacy bodies, and the mail never
//     leaves for a caller the API refused (W42);
//   * W46 — api/queries/invoice-detail.mjs INNER JOINs appointments and
//     patients, so an invoice whose appointment_id is null yields no row and
//     this route answers the legacy 'Invoice not found' JSON instead of the
//     shipped function mailing a letter to "undefined undefined" (the port's
//     one recorded behavioural deviation);
//   * S10 — every value interpolated into the HTML passes through
//     api/lib/escape.mjs (api/lib/email-invoice.mjs), and the sender comes
//     from RESEND_FROM_INVOICE instead of the shipped hardcoded test address;
//     with that variable unset the endpoint answers the same legacy failure
//     JSON with 'Mail sender not configured' and performs no request to the
//     provider (W48);
//   * the send itself is the plain REST call in api/lib/resend.mjs, so no
//     Supabase runtime, SDK or service-role key is involved any more.
//
// The legacy console.log tracing is dropped — the API's request logger
// already records every call with its status.

import { Router } from 'express';

import { asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { buildInvoiceEmailHtml, invoiceEmailSubject } from '../lib/email-invoice.mjs';
import { invoiceSender, sendEmail } from '../lib/resend.mjs';
import { fetchInvoiceDetail } from '../queries/invoice-detail.mjs';

export const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole('admin', 'moderator', 'user'),
  asyncHandler(async (req, res) => {
    // The shipped function read the whole body as JSON and destructured
    // invoiceId/recipientEmail (recipientName was accepted and unused); a
    // missing key lands in the same failure branches below.
    const { invoiceId, recipientEmail } = req.body ?? {};

    try {
      const invoice = await fetchInvoiceDetail(invoiceId);
      if (!invoice) throw new Error('Invoice not found');

      // W48: the sender comes from the environment and is checked BEFORE the
      // provider is contacted.
      const from = invoiceSender();
      if (from === '') throw new Error('Mail sender not configured');

      // The legacy order: build the HTML, hand it to the provider, and only
      // then report success. sendEmail never rejects; it mirrors the SDK's
      // {data, error}, so a failed send is thrown and reported by the same
      // legacy catch below.
      const { data, error } = await sendEmail({
        from,
        to: [recipientEmail],
        subject: invoiceEmailSubject(invoice),
        html: buildInvoiceEmailHtml(invoice),
      });
      if (error) throw error;

      return sendJson(res, 200, {
        success: true,
        message: 'Invoice email sent successfully',
        emailId: data?.id,
      });
    } catch (error) {
      // Legacy contract: any failure is a 500 with this body.
      return sendJson(res, 500, { success: false, error: error?.message ? String(error.message) : 'Failed to send invoice email' });
    }
  })
);

export default router;
