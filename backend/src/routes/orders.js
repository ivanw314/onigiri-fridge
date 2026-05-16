'use strict';
const { Router } = require('express');
const { getOrder, addSSEClient, removeSSEClient } = require('../orderStore');

const router = Router();

// GET /api/orders/:order_id/status
// Server-Sent Events stream. The thank-you page connects here and receives
// { status } events until the order reaches a terminal state.
router.get('/:order_id/status', (req, res) => {
  const { order_id } = req.params;
  const order = getOrder(order_id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // SSE handshake
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current status immediately so the client is never left waiting
  // if it connects after the order has already advanced.
  res.write(`data: ${JSON.stringify({ status: order.status })}\n\n`);

  // Register for future updates pushed by orderStore.updateOrder()
  addSSEClient(order_id, res);

  // Keep-alive ping every 25s (proxy / load balancer timeouts)
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeSSEClient(order_id, res);
  });
});

// GET /api/orders/:order_id/status/poll
// One-shot fallback used by the thank-you page when the SSE stream dies.
router.get('/:order_id/status/poll', (req, res) => {
  const order = getOrder(req.params.order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ status: order.status });
});

module.exports = router;
