'use strict';
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');

// ── Schema init ───────────────────────────────────────────────────────────────

async function initItemsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL,
      price_cents INT NOT NULL,
      stock       INT NOT NULL DEFAULT 0,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One-time migration: seed the catalog from the old single-item env vars
  // so existing deployments keep selling without any admin action required.
  const { rows } = await pool.query('SELECT COUNT(*) FROM items');
  if (parseInt(rows[0].count, 10) === 0) {
    const name  = process.env.ITEM_NAME || 'Onigiri';
    const price = parseInt(process.env.ITEM_PRICE_CENTS || '300', 10);
    await pool.query(
      `INSERT INTO items (id, name, price_cents, stock, active) VALUES ($1, $2, $3, $4, true)`,
      [uuidv4(), name, price, 999]
    );
    console.log(`[ITEMS] Seeded initial item "${name}" from env vars — set a real stock count in the admin panel`);
  }
  console.log('[ITEMS] Table ready');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function getActiveItems() {
  const { rows } = await pool.query(
    'SELECT * FROM items WHERE active = true ORDER BY created_at ASC'
  );
  return rows;
}

async function getAllItems() {
  const { rows } = await pool.query('SELECT * FROM items ORDER BY created_at ASC');
  return rows;
}

async function getItem(id) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function createItem({ name, price_cents, stock }) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO items (id, name, price_cents, stock, active)
     VALUES ($1, $2, $3, $4, true) RETURNING *`,
    [id, name, price_cents, stock]
  );
  return rows[0];
}

async function updateItem(id, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  if (fields.length === 0) throw new Error('No updates provided');

  const setClauses = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE items SET ${setClauses}, updated_at = NOW()
     WHERE id = $${fields.length + 1}
     RETURNING *`,
    [...values, id]
  );
  if (rows.length === 0) throw new Error(`Item not found: ${id}`);
  return rows[0];
}

async function deleteItem(id) {
  const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id]);
  if (rowCount === 0) throw new Error(`Item not found: ${id}`);
}

// Used to decide delete vs. deactivate: an item referenced by order history
// can't be hard-deleted without corrupting past orders' display/refunds.
async function itemHasOrders(id) {
  const { rows } = await pool.query('SELECT 1 FROM orders WHERE item_id = $1 LIMIT 1', [id]);
  return rows.length > 0;
}

// Atomically decrements stock. Fails (returns null) if the item is inactive
// or there isn't enough stock left — callers must treat null as "can't fulfill".
async function decrementStock(id, qty) {
  const { rows } = await pool.query(
    `UPDATE items SET stock = stock - $2, updated_at = NOW()
     WHERE id = $1 AND active = true AND stock >= $2
     RETURNING *`,
    [id, qty]
  );
  return rows[0] ?? null;
}

// Gives stock back when a paid order never actually dispensed (unlock
// failure or timeout) — the item was never physically taken.
async function restoreStock(id, qty) {
  const { rows } = await pool.query(
    `UPDATE items SET stock = stock + $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, qty]
  );
  return rows[0] ?? null;
}

module.exports = {
  initItemsTable,
  getActiveItems,
  getAllItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  itemHasOrders,
  decrementStock,
  restoreStock,
};
