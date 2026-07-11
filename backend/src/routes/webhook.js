'use strict';
const crypto = require('crypto');
const { Router } = require('express');
const { getOrder, updateOrder, isDuplicateEvent } = require('../orderStore');
const { decrementStockForItems, restoreStockForItems } = require('../itemStore');
const { getSquareOrder, createRefund } = require('../square');
const { publishUnlock } = require('../mqttClient');

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /webhooks/square
// Square calls this after every payment state change.
// We only act on payment.updated with status=COMPLETED.
router.post('/square', async (req, res) => {
  // 1. Acknowledge Square immediately (Square retries if it doesn't get 200 fast)
  res.sendStatus(200);

  try {
    await handleSquareWebhook(req);
  } catch (err) {
    // This webhook fires for every payment on the Square account/location,
    // not just ones from our checkout flow (POS sales, Square's "send test
    // webhook" feature, etc.) — anything unexpected here must be logged and
    // dropped, never thrown, or one bad event takes the whole server down.
    console.error('[WEBHOOK] Unhandled error processing event:', err.message);
  }
});

async function handleSquareWebhook(req) {
  // 2. Verify the HMAC signature — must happen before any business logic
  if (!verifySquareSignature(req)) {
    console.warn('[WEBHOOK] Signature verification failed — ignoring');
    return;
  }

  const body = req.body;

  // 3. Only handle payment.updated events
  if (body.type !== 'payment.updated') return;

  const event_id = body.event_id;
  const payment  = body?.data?.object?.payment;

  if (!payment) {
    console.warn('[WEBHOOK] Missing payment object in payload');
    return;
  }

  // 4. Only act on the final settled state
  if (payment.status !== 'COMPLETED') {
    console.log(`[WEBHOOK] Ignoring payment status: ${payment.status}`);
    return;
  }

  // 5. Deduplicate — Square retries delivery, so the same event_id can arrive
  //    multiple times. Process it exactly once.
  if (await isDuplicateEvent(event_id)) {
    console.log(`[WEBHOOK] Duplicate event_id ${event_id} — skipping`);
    return;
  }

  // 6. Resolve our internal order_id from the Square payment.
  //    reference_id is sometimes absent from the sandbox webhook payload,
  //    so we call GET /v2/orders/{square_order_id} to read it authoritatively.
  let order_id = payment.reference_id;

  if (!order_id && payment.order_id) {
    try {
      const squareOrder = await getSquareOrder(payment.order_id);
      order_id = squareOrder.reference_id;
    } catch (err) {
      console.error('[WEBHOOK] Failed to fetch Square order:', err.message);
      return;
    }
  }

  if (!order_id) {
    console.warn('[WEBHOOK] Could not resolve reference_id — dropping event');
    return;
  }

  // reference_id can come from an unrelated payment on the same Square
  // account/location (POS sale, test webhook, etc.) — anything that isn't
  // one of our own order UUIDs was never going to match a row anyway, and
  // the DB driver throws on malformed UUID input rather than just returning
  // no rows, so check the shape first.
  if (!UUID_RE.test(order_id)) {
    console.warn(`[WEBHOOK] reference_id "${order_id}" isn't one of our orders — dropping event`);
    return;
  }

  const order = await getOrder(order_id);
  if (!order) {
    console.warn(`[WEBHOOK] Unknown order_id ${order_id}`);
    return;
  }

  // Guard against double-processing (idempotent at order level too)
  if (order.status !== 'pending') {
    console.log(`[WEBHOOK] Order ${order_id} already in status ${order.status} — skipping`);
    return;
  }

  // 7. Decrement stock for every item in the cart now that money has actually
  //    been captured. This is atomic across the whole order (see
  //    decrementStockForItems) — if stock ran out for even one line item
  //    between checkout creation and payment completion (race with another
  //    buyer), none of it is taken, and we refund instead of unlocking for
  //    items we don't have.
  const amount_cents = order.items.reduce((sum, it) => sum + it.quantity * it.unit_price_cents, 0);
  const stockLines = order.items.filter((it) => it.item_id).map((it) => ({ item_id: it.item_id, quantity: it.quantity }));

  if (stockLines.length > 0) {
    const ok = await decrementStockForItems(stockLines);
    if (!ok) {
      console.warn(`[WEBHOOK] Out of stock for order ${order_id} — refunding instead of unlocking`);
      await updateOrder(order_id, { status: 'refunded' });
      try {
        await createRefund({ payment_id: payment.id, order_id, amount_cents });
        console.log(`[REFUND] Square refund issued for order ${order_id} (out of stock)`);
      } catch (refundErr) {
        console.error(`[REFUND] Square refund failed for order ${order_id}:`, refundErr.message);
      }
      return;
    }
  }

  // 8. Mark paid and publish the MQTT unlock command
  await updateOrder(order_id, {
    status:            'paid',
    square_payment_id: payment.id,
    square_order_id:   payment.order_id,
  });

  try {
    publishUnlock(order.device_id, order_id);
    // Status advances to 'dispensing' when the device publishes an 'unlocked' event
    // (handled in index.js via the MQTT emitter).
  } catch (err) {
    console.error(`[WEBHOOK] Failed to publish unlock for ${order_id}:`, err.message);
    await updateOrder(order_id, { status: 'refunded' });
    if (stockLines.length > 0) await restoreStockForItems(stockLines);
    if (payment.id) {
      try {
        await createRefund({ payment_id: payment.id, order_id, amount_cents });
        console.log(`[REFUND] Square refund issued for order ${order_id}`);
      } catch (refundErr) {
        console.error(`[REFUND] Square refund failed for order ${order_id}:`, refundErr.message);
      }
    } else {
      console.warn(`[REFUND] No payment_id for order ${order_id} — skipping Square refund`);
    }
  }
}

// ── Square HMAC verification ──────────────────────────────────────────────────
// Square computes: Base64( HMAC-SHA256( signatureKey, notificationUrl + rawBody ) )
// https://developer.squareup.com/docs/webhooks/validate-webhooks

function verifySquareSignature(req) {
  const sigHeader      = req.headers['x-square-hmacsha256-signature'];
  const signatureKey   = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;

  if (!sigHeader || !signatureKey || !notificationUrl) {
    console.warn('[WEBHOOK] Missing signature header or env vars — skipping verification in dev');
    // In development you may not have these set yet; remove this bypass before production.
    return process.env.NODE_ENV !== 'production';
  }

  const rawBody  = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(sigHeader),
      Buffer.from(expected)
    );
  } catch {
    return false; // buffers were different lengths
  }
}

module.exports = router;
