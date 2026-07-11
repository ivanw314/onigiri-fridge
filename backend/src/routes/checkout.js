'use strict';
const { Router } = require('express');
const { isDeviceOnline } = require('../mqttClient');
const { createOrder, addOrderItems, updateOrder, getActiveOrderForDevice } = require('../orderStore');
const { getItem } = require('../itemStore');
const { createPaymentLink } = require('../square');

const router = Router();

const MAX_CART_LINES = 50;

// POST /api/checkout
// Body: { device_id, items: [{ item_id, quantity }, ...] }
// Creates an internal order covering every distinct item in the cart,
// creates a single Square Quick Pay link for the whole cart, and returns
// the checkout URL for the browser to redirect to.
router.post('/', async (req, res) => {
  const { device_id } = req.body;
  const cartInput = req.body.items;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (!Array.isArray(cartInput) || cartInput.length === 0) {
    return res.status(400).json({ error: 'items is required and must be a non-empty array' });
  }
  if (cartInput.length > MAX_CART_LINES) {
    return res.status(400).json({ error: 'Too many distinct items in one order.' });
  }

  // Guard: don't create a payment if the device is offline.
  // The landing page already checks this, but the user could have the page
  // open across a network blip and click Pay after the device went offline.
  if (!isDeviceOnline(device_id)) {
    return res.status(503).json({ error: 'Device is currently offline. Please try again.' });
  }

  // Resolve + validate each cart line against the live catalog before
  // creating anything.
  const resolvedLines = [];
  const seenItemIds = new Set();
  for (const line of cartInput) {
    const item_id = line?.item_id;
    if (!item_id || seenItemIds.has(item_id)) {
      return res.status(400).json({ error: 'Each item may only appear once in the cart.' });
    }
    seenItemIds.add(item_id);

    const item = await getItem(item_id);
    if (!item || !item.active) {
      return res.status(400).json({ error: 'One of the selected items is no longer available.' });
    }

    const quantity = Math.max(1, Math.min(10, parseInt(line.quantity ?? 1, 10) || 1));

    // Soft pre-check — the authoritative, race-safe decrement happens once
    // the webhook confirms payment. This just avoids generating a Square
    // checkout link for something that's visibly already sold out.
    if (item.stock < quantity) {
      return res.status(409).json({ error: `Not enough stock for ${item.name}.` });
    }

    resolvedLines.push({ item, quantity });
  }

  const activeOrder = await getActiveOrderForDevice(device_id);
  if (activeOrder) {
    return res.status(409).json({ error: 'An order is already in progress. Please wait for it to finish.' });
  }

  // 1. Create the order shell, then snapshot each cart line as an order_item
  //    — item name/price are captured now so later catalog edits or
  //    deletions never affect this order's display or refund amount.
  const order = await createOrder({ device_id });

  try {
    await addOrderItems(order.id, resolvedLines.map(({ item, quantity }) => ({
      item_id:          item.id,
      item_name:        item.name,
      unit_price_cents: item.price_cents,
      quantity,
    })));

    // 2. Build the Square payment link — one line item per cart entry
    const BASE_URL     = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const redirect_url = `${BASE_URL}/thank-you?order_id=${order.id}`;

    const { checkout_url, square_order_id } = await createPaymentLink({
      order_id: order.id,
      redirect_url,
      line_items: resolvedLines.map(({ item, quantity }) => ({
        name:         item.name,
        quantity,
        amount_cents: item.price_cents,
      })),
    });

    // Attach the Square order ID so the webhook handler can match it back
    await updateOrder(order.id, { square_order_id });

    return res.json({ checkout_url, order_id: order.id });

  } catch (err) {
    console.error('[CHECKOUT] Error:', err.message);
    // Don't leave a dangling pending order — mark it refunded
    // (no payment was taken, so no actual refund needed, just state cleanup)
    await updateOrder(order.id, { status: 'refunded' });
    return res.status(502).json({ error: 'Could not create checkout. Please try again.' });
  }
});

module.exports = router;
