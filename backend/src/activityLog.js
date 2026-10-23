'use strict';
const { pool, isUuid } = require('./db');

// Permanent record of what happened to each order and to the fridge: order
// status changes, payments, refunds, commands sent to the fridge and every
// event it reports. Each order's card in the admin panel shows its own rows
// as a timeline, and the Device tab shows them all, so questions like "was
// the fridge opened for this order?" can be answered without digging through
// server logs (which roll over within hours).
//
// source is who or what caused the row: customer, square, fridge, admin or
// server (automatic: sweeps, unlock sends, refunds).
//
// No foreign key to orders, so deleting an order (or clearing them all)
// keeps its history.

async function initActivityTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id         BIGSERIAL PRIMARY KEY,
      order_id   UUID,
      device_id  TEXT,
      source     TEXT NOT NULL,
      event      TEXT NOT NULL,
      detail     JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS activity_log_order_idx ON activity_log (order_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC)');
  console.log('[ACTIVITY] Table ready');
}

// Never throws: a failed history write must not break a sale. The time is
// taken when this is called rather than when the insert lands, so rows
// written concurrently (a door_closed and the locked right after it) still
// sort in the order they happened.
async function logActivity({ order_id = null, device_id = null, source, event, detail = null }) {
  const at = new Date();
  try {
    await pool.query(
      `INSERT INTO activity_log (order_id, device_id, source, event, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [isUuid(order_id) ? order_id : null, device_id, source, event, detail && JSON.stringify(detail), at]
    );
  } catch (err) {
    console.error(`[ACTIVITY] Failed to record ${source}/${event}:`, err.message);
  }
}

// Oldest first, for an order's timeline.
async function getOrderActivity(order_id) {
  if (!isUuid(order_id)) return [];
  const { rows } = await pool.query(
    `SELECT source, event, detail, created_at FROM activity_log
     WHERE order_id = $1 ORDER BY created_at, id`,
    [order_id]
  );
  return rows;
}

// Newest first, for the Device tab.
async function getRecentActivity(limit = 100) {
  const { rows } = await pool.query(
    `SELECT order_id, source, event, detail, created_at FROM activity_log
     ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { initActivityTable, logActivity, getOrderActivity, getRecentActivity };
