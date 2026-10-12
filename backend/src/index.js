'use strict';
require('dotenv').config();

const express = require('express');
const { connectMQTT, emitter, isAdminUnlockActive } = require('./mqttClient');
const {
  initDB, getOrder, updateOrder, expireStalePendingOrders,
  getInProgressOrderForDevice, markDoorOpened, completeOrderIfDoorOpened, completeStaleDispensingOrders,
} = require('./orderStore');
const { initItemsTable, restoreStockForItems } = require('./itemStore');
const { initSettingsTable } = require('./settingsStore');
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
app.use('/admin',         require('./routes/admin'));

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Device event handler ──────────────────────────────────────────────────────
// The MQTT client emits 'deviceEvent' whenever the ESP32 publishes to .../evt.
emitter.on('deviceEvent', async ({ device_id, event, order_id: eventOrderId }) => {
  try {
    // Events during an admin-panel unlock belong to no order.
    let order_id = eventOrderId;
    if (!order_id && !isAdminUnlockActive(device_id)) {
      order_id = (await getInProgressOrderForDevice(device_id))?.id;
    }
    if (!order_id) return;

    const order = await getOrder(order_id);
    if (!order) return;

    switch (event) {
      case 'unlocked':
        await updateOrder(order_id, { status: 'dispensing' });
        break;
      case 'door_open':
        console.log(`[EVT] ${device_id} / ${order_id}: ${event}`);
        await markDoorOpened(order_id);
        break;
      case 'door_closed':
        // A close while unlocked means the door was opened, even if the
        // door_open message itself never arrived.
        await markDoorOpened(order_id);
        await completeOrderIfDoorOpened(order_id);
        break;
      case 'locked':
      case 'relocked':
        // Backup for a lost door_closed. The fridge also relocks after an
        // unlock timeout or a forced lock, so this only completes the order
        // if the door was actually opened.
        await completeOrderIfDoorOpened(order_id);
        break;
      case 'unlock_timeout': {
        console.warn(`[EVT] Unlock timeout for order ${order_id} — refund needed`);
        await updateOrder(order_id, { status: 'timed_out' });
        const stockLines = order.items.filter((it) => it.item_id).map((it) => ({ item_id: it.item_id, quantity: it.quantity }));
        if (stockLines.length > 0) await restoreStockForItems(stockLines);
        const payment_id = order.square_payment_id;
        if (payment_id) {
          try {
            // total_cents is the amount Square actually charged (includes
            // tax); fall back to the pre-tax item sum only for orders that
            // predate that column being populated.
            const amount_cents = order.total_cents ?? order.items.reduce((sum, it) => sum + it.quantity * it.unit_price_cents, 0);
            await createRefund({ payment_id, order_id, amount_cents });
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

// Last-resort guard: Express 4 doesn't catch errors thrown from async route
// handlers, and Node exits on an unhandled rejection by default. One bad
// request used to take the whole server down mid-sale; log it and keep
// serving instead.
process.on('unhandledRejection', (err) => {
  console.error('[SERVER] Unhandled rejection:', err);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();
  await initItemsTable();
  await initSettingsTable();
  await connectMQTT();

  // Sweep abandoned pending orders (checkout started, never paid) over to
  // 'timed_out' so they don't sit as 'pending' forever in the dashboard, and
  // complete dispensing orders whose door-close message was lost.
  setInterval(() => {
    expireStalePendingOrders().catch((err) => {
      console.error('[ORDER] Failed to expire stale pending orders:', err.message);
    });
    completeStaleDispensingOrders().catch((err) => {
      console.error('[ORDER] Failed to complete stale dispensing orders:', err.message);
    });
  }, 30 * 1000);

  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch((err) => {
  console.error('[SERVER] Fatal startup error:', err);
  process.exit(1);
});
