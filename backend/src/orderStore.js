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
      quantity          INT NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1
  `);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_id UUID
  `);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS item_name TEXT
  `);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS unit_price_cents INT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_events (
      event_id   TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function getActiveOrderForDevice(device_id) {
  const { rows } = await pool.query(
    `SELECT id FROM orders
     WHERE device_id = $1
       AND status IN ('pending', 'paid', 'dispensing')
       AND created_at > NOW() - INTERVAL '5 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [device_id]
  );
  return rows[0] ?? null;
}

async function createOrder({ device_id, quantity = 1, item_id = null, item_name = null, unit_price_cents = null }) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO orders (id, device_id, status, quantity, item_id, item_name, unit_price_cents, created_at, updated_at)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [id, device_id, quantity, item_id, item_name, unit_price_cents]
  );
  const order = rows[0];
  console.log(`[ORDER] Created ${order.id} for device ${device_id}`);
  return order;
}

async function getOrder(order_id) {
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1',
    [order_id]
  );
  return rows[0] ?? null;
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
  const { rows } = await pool.query(
    'SELECT * FROM orders ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

async function deleteOrder(order_id) {
  const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [order_id]);
  if (rowCount === 0) throw new Error(`Order not found: ${order_id}`);
}

async function deleteAllOrders() {
  const { rowCount } = await pool.query('DELETE FROM orders');
  return rowCount;
}

// defaultUnitCents is only used for legacy orders predating per-order price
// snapshots (unit_price_cents IS NULL) — new orders always carry their own.
async function getOrderStats(defaultUnitCents) {
  const [{ rows: todayRows }, { rows: totalRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(quantity), 0) AS count,
              COALESCE(SUM(quantity * COALESCE(unit_price_cents, $1)), 0) AS revenue_cents
       FROM orders
       WHERE status = 'complete' AND created_at >= CURRENT_DATE`,
      [defaultUnitCents]
    ),
    pool.query(
      `SELECT COALESCE(SUM(quantity), 0) AS count,
              COALESCE(SUM(quantity * COALESCE(unit_price_cents, $1)), 0) AS revenue_cents
       FROM orders WHERE status = 'complete'`,
      [defaultUnitCents]
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
  getActiveOrderForDevice,
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
