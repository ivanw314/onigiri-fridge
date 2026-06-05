'use strict';
const { Router } = require('express');
const { isDeviceOnline } = require('../mqttClient');
const { createOrder, updateOrder, getActiveOrderForDevice } = require('../orderStore');
const { createPaymentLink } = require('../square');

const router = Router();

// POST /api/checkout
// Body: { device_id }
// Creates an internal order, creates a Square Quick Pay link,
// and returns the checkout URL for the browser to redirect to.
router.post('/', async (req, res) => {
  const { device_id } = req.body;
  const quantity = Math.max(1, Math.min(10, parseInt(req.body.quantity ?? 1, 10) || 1));

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  // Guard: don't create a payment if the device is offline.
  // The landing page already checks this, but the user could have the page
  // open across a network blip and click Pay after the device went offline.
  if (!isDeviceOnline(device_id)) {
    return res.status(503).json({ error: 'Device is currently offline. Please try again.' });
  }

  const activeOrder = await getActiveOrderForDevice(device_id);
  if (activeOrder) {
    return res.status(409).json({ error: 'An order is already in progress. Please wait for it to finish.' });
  }

  // 1. Create our internal order (status: pending)
  const order = await createOrder({ device_id, quantity });

  // 2. Build the Square payment link
  const BASE_URL      = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const unit_cents    = parseInt(process.env.ITEM_PRICE_CENTS || '300', 10);
  const item_name     = process.env.ITEM_NAME || 'Onigiri';
  const redirect_url  = `${BASE_URL}/thank-you?order_id=${order.id}`;

  try {
    const { checkout_url, square_order_id } = await createPaymentLink({
      order_id:     order.id,
      amount_cents: unit_cents,
      item_name,
      redirect_url,
      quantity,
    });

    // Attach the Square order ID so the webhook handler can match it back
    await updateOrder(order.id, { square_order_id });

    return res.json({ checkout_url, order_id: order.id });

  } catch (err) {
    console.error('[CHECKOUT] Square error:', err.message);
    // Don't leave a dangling pending order — mark it refunded
    // (no payment was taken, so no actual refund needed, just state cleanup)
    await updateOrder(order.id, { status: 'refunded' });
    return res.status(502).json({ error: 'Could not create checkout. Please try again.' });
  }
});

module.exports = router;
