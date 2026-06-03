'use strict';
require('dotenv').config();

const express = require('express');
const { connectMQTT, emitter } = require('./mqttClient');
const { initDB, getOrder, updateOrder } = require('./orderStore');
const { createRefund } = require('./square');

const app = express();

// Save raw body for Square webhook HMAC verification before JSON parsing consumes it
app.use(
  express.json({
    verify: (_req, _res, buf) => { _req.rawBody = buf; },
  })
);

app.use('/buy',           require('./routes/buy'));
app.use('/thank-you',     require('./routes/thankyou'));
app.use('/api/checkout',  require('./routes/checkout'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/webhooks',      require('./routes/webhook'));

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Device event handler ──────────────────────────────────────────────────────
// The MQTT client emits 'deviceEvent' whenever the ESP32 publishes to .../evt.
emitter.on('deviceEvent', async ({ device_id, event, order_id: eventOrderId }) => {
  try {
    const { getPendingOrder, clearPendingOrder } = require('./mqttClient');
    const order_id = eventOrderId || getPendingOrder(device_id);
    if (!order_id) return;

    const order = await getOrder(order_id);
    if (!order) return;

    switch (event) {
      case 'unlocked':
        await updateOrder(order_id, { status: 'dispensing' });
        break;
      case 'relocked':
      case 'door_closed':
        if (order.status === 'dispensing') {
          await updateOrder(order_id, { status: 'complete' });
          clearPendingOrder(device_id);
        }
        break;
      case 'unlock_timeout': {
        console.warn(`[EVT] Unlock timeout for order ${order_id} — refund needed`);
        await updateOrder(order_id, { status: 'timed_out' });
        clearPendingOrder(device_id);
        const payment_id = order.square_payment_id;
        if (payment_id) {
          try {
            await createRefund({ payment_id, order_id });
            console.log(`[REFUND] Square refund issued for order ${order_id}`);
          } catch (err) {
            console.error(`[REFUND] Square refund failed for order ${order_id}:`, err.message);
          }
        } else {
          console.warn(`[REFUND] No payment_id for order ${order_id} — skipping Square refund`);
        }
        break;
      }
      default:
        // door_open, auth_failed, etc. — log but don't change order state
        console.log(`[EVT] ${device_id} / ${order_id}: ${event}`);
    }
  } catch (err) {
    console.error('[EVT] Error handling device event:', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();
  await connectMQTT();
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch((err) => {
  console.error('[SERVER] Fatal startup error:', err);
  process.exit(1);
});
