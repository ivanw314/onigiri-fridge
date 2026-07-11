'use strict';
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');

// SSE response objects — ephemeral by nature, stays in-memory
const sseClients = new Map(); // order_id → Set<res>

// ── Schema init ───────────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                UUID PRIMARY KEY,
      device_id         TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      square_order_id   TEXT,
      square_payment_id TEXT,
      event_id          TEXT UNIQUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id                SERIAL PRIMARY KEY,
      order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      item_id           UUID,
      item_name         TEXT NOT NULL,
      unit_price_cents  INT NOT NULL,
      quantity          INT NOT NULL
    )
  `);
  // A single order can now hold multiple distinct items (order_items), so the
  // old single-item columns on orders are redundant. Pre-launch cleanup, no
  // backfill — any pre-existing test orders just show no line items.
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS item_id`);
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS item_name`);
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS unit_price_cents`);
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS quantity`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_events (
      event_id   TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

// A pending order that's never paid within this window is considered
// abandoned. Kept as a single constant since it's checked in two places:
// deciding whether a device still has an order "in progress", and sweeping
// stale rows over to 'timed_out' so they don't sit there as 'pending' forever.
const PENDING_ORDER_TIMEOUT_MINUTES = 2;

async function getActiveOrderForDevice(device_id) {
  const { rows } = await pool.query(
    `SELECT id FROM orders
     WHERE device_id = $1
       AND status IN ('pending', 'paid', 'dispensing')
       AND created_at > NOW() - INTERVAL '${PENDING_ORDER_TIMEOUT_MINUTES} minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [device_id]
  );
  return rows[0] ?? null;
}

// Lets a customer who backed out of Square checkout (e.g. to go add a
// forgotten item) free their device up immediately instead of waiting out
// the timeout sweep. No payment was taken yet, so this is just a status
// flip — no refund or stock restore needed. Scoped to status = 'pending'
// so it can never cancel an order that's already been paid.
async function cancelPendingOrderForDevice(device_id) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'cancelled', updated_at = NOW()
     WHERE device_id = $1 AND status = 'pending'
     RETURNING id`,
    [device_id]
  );
  const order = rows[0] ?? null;
  if (order) {
    console.log(`[ORDER] Cancelled ${order.id} for device ${device_id} (customer returned to edit cart)`);
    _notifySSEClients(order.id, 'cancelled');
  }
  return order;
}

// Flips orders that were created but never paid within the timeout window
// over to 'timed_out'. No refund or stock restore needed here — stock is
// only decremented once the Square webhook confirms payment (see
// webhook.js), so an order still 'pending' at this point never touched it.
async function expireStalePendingOrders() {
  const { rows } = await pool.query(
    `SELECT id FROM orders
     WHERE status = 'pending'
       AND created_at <= NOW() - INTERVAL '${PENDING_ORDER_TIMEOUT_MINUTES} minutes'`
  );
  for (const { id } of rows) {
    await updateOrder(id, { status: 'timed_out' });
  }
  if (rows.length > 0) {
    console.log(`[ORDER] Expired ${rows.length} stale pending order(s)`);
  }
  return rows.length;
}

async function createOrder({ device_id }) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO orders (id, device_id, status, created_at, updated_at)
     VALUES ($1, $2, 'pending', NOW(), NOW())
     RETURNING *`,
    [id, device_id]
  );
  const order = rows[0];
  console.log(`[ORDER] Created ${order.id} for device ${device_id}`);
  return order;
}

// items: [{ item_id, item_name, unit_price_cents, quantity }, ...]
// One row per distinct item in the cart — lets a single order hold several
// different items instead of just one.
async function addOrderItems(order_id, items) {
  const values = [];
  const placeholders = items.map((it, i) => {
    const base = i * 5;
    values.push(order_id, it.item_id, it.item_name, it.unit_price_cents, it.quantity);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  }).join(', ');
  await pool.query(
    `INSERT INTO order_items (order_id, item_id, item_name, unit_price_cents, quantity)
     VALUES ${placeholders}`,
    values
  );
}

async function getOrder(order_id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [order_id]);
  const order = rows[0];
  if (!order) return null;
  const { rows: items } = await pool.query(
    'SELECT item_id, item_name, unit_price_cents, quantity FROM order_items WHERE order_id = $1 ORDER BY id ASC',
    [order_id]
  );
  return { ...order, items };
}

async function updateOrder(order_id, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  if (fields.length === 0) throw new Error('No updates provided');

  const setClauses = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE orders SET ${setClauses}, updated_at = NOW()
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    [...values, order_id]
  );
  if (rows.length === 0) throw new Error(`Order not found: ${order_id}`);
  const order = rows[0];
  console.log(`[ORDER] ${order_id} → ${order.status}`);
  _notifySSEClients(order_id, order.status);
  return order;
}

async function getRecentOrders(limit = 20) {
  const { rows: orders } = await pool.query(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  if (orders.length === 0) return [];

  const { rows: items } = await pool.query(
    'SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id ASC',
    [orders.map((o) => o.id)]
  );
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }
  return orders.map((o) => ({ ...o, items: itemsByOrder.get(o.id) || [] }));
}

async function deleteOrder(order_id) {
  const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [order_id]);
  if (rowCount === 0) throw new Error(`Order not found: ${order_id}`);
}

async function deleteAllOrders() {
  const { rowCount } = await pool.query('DELETE FROM orders');
  return rowCount;
}

async function getOrderStats() {
  const [{ rows: todayRows }, { rows: totalRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS count,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete' AND o.created_at >= CURRENT_DATE`
    ),
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS count,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete'`
    ),
  ]);
  return {
    todayCount:         parseInt(todayRows[0].count, 10),
    todayRevenueCents:  parseInt(todayRows[0].revenue_cents, 10),
    totalCount:         parseInt(totalRows[0].count, 10),
    totalRevenueCents:  parseInt(totalRows[0].revenue_cents, 10),
  };
}

// ── Square event deduplication ────────────────────────────────────────────────
// Uses INSERT ... ON CONFLICT DO NOTHING for atomic dedup across retries.
// Returns true if this event_id has already been processed.

async function isDuplicateEvent(event_id) {
  const { rowCount } = await pool.query(
    'INSERT INTO seen_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [event_id]
  );
  return rowCount === 0;
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
  initDB,
  createOrder,
  addOrderItems,
  getActiveOrderForDevice,
  cancelPendingOrderForDevice,
  expireStalePendingOrders,
  getOrder,
  updateOrder,
  getRecentOrders,
  getOrderStats,
  deleteOrder,
  deleteAllOrders,
  isDuplicateEvent,
  addSSEClient,
  removeSSEClient,
};
