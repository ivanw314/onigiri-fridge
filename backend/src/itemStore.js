'use strict';
const { v4: uuidv4 } = require('uuid');
const { pool, isUuid } = require('./db');

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

  // Categories group items into sections on the buy page, shown in
  // `position` order. Uncategorized items (category_id NULL) go last.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL,
      position    INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique ON categories (LOWER(name))`);
  // Checked by hand rather than ADD COLUMN IF NOT EXISTS, which on some
  // Postgres versions still adds a duplicate foreign key every boot.
  const { rows: catCol } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'category_id'`
  );
  if (catCol.length === 0) {
    await pool.query(`ALTER TABLE items ADD COLUMN category_id UUID REFERENCES categories(id) ON DELETE SET NULL`);
  }

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

  // One row per time an item sold out: from the sale that took its last unit
  // until it was back in stock or taken off sale. No FK to items, so the
  // history outlives a deleted item.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sellouts (
      id         SERIAL PRIMARY KEY,
      item_id    UUID NOT NULL,
      item_name  TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at   TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sellouts_one_open ON sellouts (item_id) WHERE ended_at IS NULL`);
  // When tracking began, so Insights can tell "nothing sold out" from "not
  // tracked yet". Needs the settings table, which is created first.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('sellouts_since', NOW()::text) ON CONFLICT (key) DO NOTHING`
  );
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
  // id comes straight from the public checkout request body.
  if (!isUuid(id)) return null;
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function createItem({ name, price_cents, stock, category_id = null }) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO items (id, name, price_cents, stock, active, category_id)
     VALUES ($1, $2, $3, $4, true, $5) RETURNING *`,
    [id, name, price_cents, stock, category_id]
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
  if (rows[0].stock > 0 || !rows[0].active) await endSellout(id);
  return rows[0];
}

async function deleteItem(id) {
  const { rowCount } = await pool.query('DELETE FROM items WHERE id = $1', [id]);
  if (rowCount === 0) throw new Error(`Item not found: ${id}`);
  await endSellout(id);
}

// Used to decide delete vs. deactivate: an item referenced by order history
// can't be hard-deleted without corrupting past orders' display/refunds.
async function itemHasOrders(id) {
  const { rows } = await pool.query('SELECT 1 FROM order_items WHERE item_id = $1 LIMIT 1', [id]);
  return rows.length > 0;
}

// Gives stock back when a paid order never actually dispensed (unlock
// failure or timeout) — the item was never physically taken. Internal —
// go through restoreStockForItems below.
async function restoreStock(id, qty) {
  const { rows } = await pool.query(
    `UPDATE items SET stock = stock + $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, qty]
  );
  if (rows[0]?.stock > 0) await endSellout(id);
  return rows[0] ?? null;
}

// Admin restock: a relative change rather than setting an absolute count, so
// a sale that lands between the admin loading the page and tapping +/- isn't
// overwritten. Clamped at zero. Returns null if the item doesn't exist.
async function adjustStock(id, delta) {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query(
    `UPDATE items SET stock = GREATEST(stock + $2, 0), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, delta]
  );
  if (rows[0]?.stock > 0) await endSellout(id);
  return rows[0] ?? null;
}

// items: [{ item_id, quantity }, ...] — a cart can span several distinct
// items, so stock for the whole order must be decremented as one atomic
// transaction: either every line has enough stock, or none of it is taken.
// Returns false (and leaves stock untouched) if any single line can't be
// fulfilled — callers should treat that as "can't fulfill this order".
async function decrementStockForItems(items) {
  const client = await pool.connect();
  const soldOut = [];
  try {
    await client.query('BEGIN');
    for (const { item_id, quantity } of items) {
      const { rows } = await client.query(
        `UPDATE items SET stock = stock - $2, updated_at = NOW()
         WHERE id = $1 AND active = true AND stock >= $2
         RETURNING id, stock`,
        [item_id, quantity]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      if (rows[0].stock === 0) soldOut.push(item_id);
    }
    await client.query('COMMIT');
    for (const id of soldOut) await startSellout(id);
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// items: [{ item_id, quantity }, ...] — restoring is always additive/safe
// per line, so unlike decrementStockForItems this doesn't need to be atomic
// across the whole set.
async function restoreStockForItems(items) {
  for (const { item_id, quantity } of items) {
    if (!item_id) continue;
    await restoreStock(item_id, quantity);
  }
}

// ── Sell-outs ─────────────────────────────────────────────────────────────────
// Only a sale starts one, so zeroing stock by hand (say, binning leftovers at
// closing) isn't counted. Bookkeeping for Insights, so these never throw: a
// failed write mustn't break a sale or a restock.

async function startSellout(id) {
  try {
    // Re-checks stock, since a restock may have landed since the sale.
    await pool.query(
      `INSERT INTO sellouts (item_id, item_name)
       SELECT id, name FROM items WHERE id = $1 AND stock <= 0 AND active
       ON CONFLICT DO NOTHING`,
      [id]
    );
  } catch (err) {
    console.error(`[ITEMS] Failed to record sell-out of ${id}:`, err.message);
  }
}

async function endSellout(id) {
  try {
    await pool.query('UPDATE sellouts SET ended_at = NOW() WHERE item_id = $1 AND ended_at IS NULL', [id]);
  } catch (err) {
    console.error(`[ITEMS] Failed to end sell-out of ${id}:`, err.message);
  }
}

// ── Categories ────────────────────────────────────────────────────────────────

async function getCategories() {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY position ASC, created_at ASC');
  return rows;
}

async function getCategory(id) {
  // id comes from the admin panel's request body.
  if (!isUuid(id)) return null;
  const { rows } = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// Names are unique ignoring case (categories_name_unique), so these throw a
// Postgres error with code 23505 on a duplicate.
async function createCategory(name) {
  const { rows } = await pool.query(
    `INSERT INTO categories (id, name, position)
     VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM categories))
     RETURNING *`,
    [uuidv4(), name]
  );
  return rows[0];
}

async function renameCategory(id, name) {
  const { rows } = await pool.query(
    'UPDATE categories SET name = $2 WHERE id = $1 RETURNING *',
    [id, name]
  );
  if (rows.length === 0) throw new Error(`Category not found: ${id}`);
  return rows[0];
}

// Swaps a category with its neighbour, then renumbers every position so
// they stay a clean 0..n-1 sequence. Moving past either end is a no-op.
async function moveCategory(id, direction) {
  const ids = (await getCategories()).map((c) => c.id);
  const from = ids.indexOf(id);
  if (from === -1) throw new Error(`Category not found: ${id}`);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await pool.query(
    `UPDATE categories c SET position = v.pos - 1
     FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, pos)
     WHERE c.id = v.id`,
    [ids]
  );
}

// Items in the category aren't deleted; the foreign key's ON DELETE SET NULL
// leaves them uncategorized.
async function deleteCategory(id) {
  const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [id]);
  if (rowCount === 0) throw new Error(`Category not found: ${id}`);
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
  adjustStock,
  decrementStockForItems,
  restoreStockForItems,
  getCategories,
  getCategory,
  createCategory,
  renameCategory,
  moveCategory,
  deleteCategory,
};
