// api/routes/send-receipt-email.mjs — the payment-receipt e-mail endpoint,
// ported from supabase/functions/send-receipt-email (task t11).
//
// Request/response contracts stay the shipped function's, quirks included:
//
//   POST {paymentId, recipientEmail} + staff Bearer token
//   200 {"success":true,"message":"Receipt email sent successfully","emailId":...}
//   500 {"error":"Payment ID and recipient email are required"}   (missing field)
//   500 {"success":false,"error":"Payment not found"}             (W46)
//   500 {"success":false,"error":"Mail sender not configured"}    (W48)
//
// The missing-field answer keeps the shipped flat {"error":...} body (W45);
// the not-found and sender bodies carry success:false as milestone 4 pins
// them, so both shapes a Billing.tsx mutation has to understand are exactly
// what the criteria name.
//
// What changes with the port (the milestone-4 fixes):
//
//   * S27 — requireAuth + requireRole run before anything else: absent or
//     forged session 401, roleless session 403 (W42);
//   * W46 — api/queries/payment-detail.mjs turns the shipped
//     invoices!inner/appointments!inner/patients!inner chain into INNER
//     JOINs, so a payment whose invoice has no appointment (or no resolvable
//     patient) yields no row and answers 'Payment not found' rather than
//     mailing a receipt to "undefined undefined";
//   * S10 — the HTML interpolates only values escaped by api/lib/escape.mjs
//     (patient fields and the free-text payment reference alike), and the
//     sender comes from RESEND_FROM_RECEIPT, never the shipped placeholder
//     domain; unset sender -> 'Mail sender not configured' with no request
//     to the provider (W48);
//   * a provider failure is reported with the shipped wording, 'Failed to
//     send email: <detail>' (that is what the shipped function threw when
//     the SDK answered with an error).

import { Router } from 'express';

import { asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth, requireRole } from '../lib/session.mjs';
import { buildReceiptEmailHtml, receiptEmailSubject } from '../lib/email-receipt.mjs';
import { receiptSender, sendEmail } from '../lib/resend.mjs';
import { fetchPaymentDetail } from '../queries/payment-detail.mjs';

export const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole('admin', 'moderator', 'user'),
  asyncHandler(async (req, res) => {
    // The shipped function destructured paymentId/recipientEmail (the
    // optional recipientName was accepted and unused) and validated exactly
    // these two, before touching the database.
    const { paymentId, recipientEmail } = req.body ?? {};
    if (!paymentId || !recipientEmail) {
      return sendJson(res, 500, { error: 'Payment ID and recipient email are required' });
    }

    try {
      const payment = await fetchPaymentDetail(paymentId);
      if (!payment) throw new Error('Payment not found');

      // W48: sender from the environment, checked before any network call.
      const from = receiptSender();
      if (from === '') throw new Error('Mail sender not configured');

      // The legacy order: numbers and HTML first, provider second, success
      // only after the send succeeded.
      const { data, error } = await sendEmail({
        from,
        to: [recipientEmail],
        subject: receiptEmailSubject(payment),
        html: buildReceiptEmailHtml(payment),
      });
      if (error) throw error;

      return sendJson(res, 200, {
        success: true,
        message: 'Receipt email sent successfully',
        emailId: data?.id,
      });
    } catch (error) {
      // Legacy contract: any failure is a 500; the two bodies milestone 4
      // pins (not-found, sender) are covered by this shape.
      return sendJson(res, 500, { success: false, error: error?.message ? String(error.message) : 'Failed to send receipt email' });
    }
  })
);

export default router;
