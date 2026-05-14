'use strict';
const { v4: uuidv4 } = require('uuid');

// ── In-memory store ───────────────────────────────────────────────────────────
// Replace with a database (Postgres via Railway, or SQLite) in Phase 3.
// Order shape:
//   { id, device_id, status, square_order_id, square_payment_id,
//     created_at, updated_at }
//
// Status lifecycle:
//   pending → paid → dispensing → complete
//                              → refunded  (timeout or backend error)

const orders   = new Map(); // order_id → order object
const seenEventIds = new Set(); // Square event_id dedup

// SSE response objects waiting for status updates on a given order_id
const sseClients = new Map(); // order_id → Set<res>

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createOrder({ device_id }) {
  const order = {
    id:                uuidv4(),
    device_id,
    status:            'pending',
    square_order_id:   null,
    square_payment_id: null,
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  };
  orders.set(order.id, order);
  console.log(`[ORDER] Created ${order.id} for device ${device_id}`);
  return order;
}

function getOrder(order_id) {
  return orders.get(order_id) ?? null;
}

function updateOrder(order_id, updates) {
  const order = orders.get(order_id);
  if (!order) throw new Error(`Order not found: ${order_id}`);

  Object.assign(order, updates, { updated_at: new Date().toISOString() });
  console.log(`[ORDER] ${order_id} → ${order.status}`);

  // Push the new status to any waiting SSE clients
  _notifySSEClients(order_id, order.status);
  return order;
}

// ── Square event deduplication ────────────────────────────────────────────────

// Square retries webhook delivery, so the same event_id can arrive multiple
// times. Return true if we've already processed this event_id.
function isDuplicateEvent(event_id) {
  if (seenEventIds.has(event_id)) return true;
  seenEventIds.add(event_id);
  return false;
}

// ── SSE client management ─────────────────────────────────────────────────────

function addSSEClient(order_id, res) {
  if (!sseClients.has(order_id)) sseClients.set(order_id, new Set());
  sseClients.get(order_id).add(res);
}

function removeSSEClient(order_id, res) {
  sseClients.get(order_id)?.delete(res);
}

function _notifySSEClients(order_id, status) {
  const clients = sseClients.get(order_id);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify({ status })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* client already disconnected */ }
  }
}

module.exports = {
  createOrder,
  getOrder,
  updateOrder,
  isDuplicateEvent,
  addSSEClient,
  removeSSEClient,
};
