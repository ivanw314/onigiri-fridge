'use strict';
require('dotenv').config();

const express = require('express');
const { connectMQTT, emitter } = require('./mqttClient');
const { getOrder, updateOrder } = require('./orderStore');

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
// Phase 2: we correlate events to orders via the pendingOrders map in mqttClient.
// Phase 3: firmware will include order_id directly in event payloads.
emitter.on('deviceEvent', ({ device_id, event, order_id: eventOrderId }) => {
  // Resolve the order_id: use the one in the event payload if present,
  // otherwise fall back to the tracked pending order for this device.
  const { getPendingOrder, clearPendingOrder } = require('./mqttClient');
  const order_id = eventOrderId || getPendingOrder(device_id);
  if (!order_id) return;

  const order = getOrder(order_id);
  if (!order) return;

  switch (event) {
    case 'unlocked':
      updateOrder(order_id, { status: 'dispensing' });
      break;
    case 'relocked':
    case 'door_closed':
      if (order.status === 'dispensing') {
        updateOrder(order_id, { status: 'complete' });
        clearPendingOrder(device_id);
      }
      break;
    case 'unlock_timeout':
      // Door was never opened — refund path (implemented in Phase 3)
      console.warn(`[EVT] Unlock timeout for order ${order_id} — refund needed`);
      updateOrder(order_id, { status: 'refunded' });
      clearPendingOrder(device_id);
      break;
    default:
      // door_open, auth_failed, etc. — log but don't change order state
      console.log(`[EVT] ${device_id} / ${order_id}: ${event}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await connectMQTT();
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch((err) => {
  console.error('[SERVER] Fatal startup error:', err);
  process.exit(1);
});
