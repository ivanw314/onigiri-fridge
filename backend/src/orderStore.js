'use strict';
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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
    CREATE TABLE IF NOT EXISTS seen_events (
      event_id   TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[DB] Tables ready');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

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

async function getOrderStats() {
  const [{ rows: todayRows }, { rows: totalRows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS count FROM orders
       WHERE status = 'complete' AND created_at >= CURRENT_DATE`
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM orders WHERE status = 'complete'`
    ),
  ]);
  return {
    todayCount: parseInt(todayRows[0].count, 10),
    totalCount: parseInt(totalRows[0].count, 10),
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
  getOrder,
  updateOrder,
  getRecentOrders,
  getOrderStats,
  isDuplicateEvent,
  addSSEClient,
  removeSSEClient,
};
