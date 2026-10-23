'use strict';
const { v4: uuidv4 } = require('uuid');
const { pool, isUuid } = require('./db');
const { logActivity } = require('./activityLog');

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
  // The actual amount Square charged (line items + tax), captured once the
  // webhook marks an order 'paid'. Refunds use this instead of re-summing
  // order_items, since that sum is pre-tax and would short-refund the
  // customer once sales tax is added at checkout.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_cents INT`);
  // When the door was first seen opening during this order's unlock. An
  // order is only ever marked complete once this is set, so a lost message
  // can never complete a sale the customer may not have been able to open.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS door_opened_at TIMESTAMPTZ`);
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
// Square payment links never expire, so a customer can still pay after this —
// the webhook refunds those payments automatically.
const PENDING_ORDER_TIMEOUT_MINUTES = 3;

async function getActiveOrderForDevice(device_id) {
  const { rows } = await pool.query(
    `SELECT id, status FROM orders
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
    await logActivity({ order_id: order.id, device_id, source: 'customer', event: 'checkout_cancelled' });
  }
  return order;
}

// Flips orders that were created but never paid within the timeout window
// over to 'timed_out'. No refund or stock restore needed here — stock is
// only decremented once the Square webhook confirms payment (see
// webhook.js), so an order still 'pending' at this point never touched it.
// A single conditional UPDATE so it can't overwrite a payment the webhook
// claims at the same moment — whichever lands first wins.
async function expireStalePendingOrders() {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'timed_out', updated_at = NOW()
     WHERE status = 'pending'
       AND created_at <= NOW() - INTERVAL '${PENDING_ORDER_TIMEOUT_MINUTES} minutes'
     RETURNING id, device_id`
  );
  for (const { id, device_id } of rows) {
    console.log(`[ORDER] ${id} → timed_out`);
    _notifySSEClients(id, 'timed_out');
    await logActivity({ order_id: id, device_id, source: 'server', event: 'checkout_expired' });
  }
  if (rows.length > 0) {
    console.log(`[ORDER] Expired ${rows.length} stale pending order(s)`);
  }
  return rows.length;
}

// Marks a pending order paid and records its payment. A single conditional
// UPDATE, so if Square delivers the same payment twice at once, or the
// expiry sweep runs at the same moment, only one of them wins. Returns false
// if the order wasn't pending any more.
async function claimPendingOrderForPayment(order_id, { square_payment_id, square_order_id, total_cents }) {
  const { rows } = await pool.query(
    `UPDATE orders
     SET status = 'paid', square_payment_id = $2, square_order_id = $3, total_cents = $4, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING device_id`,
    [order_id, square_payment_id, square_order_id, total_cents]
  );
  if (rows.length === 0) return false;
  console.log(`[ORDER] ${order_id} → paid`);
  _notifySSEClients(order_id, 'paid');
  await logActivity({
    order_id, device_id: rows[0].device_id, source: 'square', event: 'paid',
    detail: { payment_id: square_payment_id, amount_cents: total_cents },
  });
  return true;
}

// For a payment that arrived after its order expired or was cancelled:
// records the payment and marks the order refunded — but only if the order
// has never had a payment. Square sends several notifications per payment,
// and the repeats for a payment we've already handled must not trigger a
// refund. Returns false if there's nothing to refund.
async function claimUnpaidOrderForLateRefund(order_id, { square_payment_id, square_order_id, total_cents }) {
  const { rows } = await pool.query(
    `UPDATE orders
     SET status = 'refunded', square_payment_id = $2, square_order_id = $3, total_cents = $4, updated_at = NOW()
     WHERE id = $1 AND status <> 'pending' AND square_payment_id IS NULL
     RETURNING device_id`,
    [order_id, square_payment_id, square_order_id, total_cents]
  );
  if (rows.length === 0) return false;
  console.log(`[ORDER] ${order_id} → refunded`);
  _notifySSEClients(order_id, 'refunded');
  await logActivity({
    order_id, device_id: rows[0].device_id, source: 'square', event: 'late_payment',
    detail: { payment_id: square_payment_id, amount_cents: total_cents },
  });
  return true;
}

// How far back to look when matching a device event to an order: long
// enough to cover paying plus a slow customer with the door open, short
// enough never to reach back to an earlier, unrelated sale.
const IN_PROGRESS_ORDER_WINDOW_MINUTES = 15;

// The order a device event (unlocked, door_open, ...) belongs to. Firmware
// events don't carry an order_id, so it's the device's most recent
// paid/dispensing order — looked up in the database rather than kept in
// memory, so a server restart mid-sale doesn't lose track of the order.
async function getInProgressOrderForDevice(device_id) {
  const { rows } = await pool.query(
    `SELECT id, status FROM orders
     WHERE device_id = $1
       AND status IN ('paid', 'dispensing')
       AND created_at > NOW() - INTERVAL '${IN_PROGRESS_ORDER_WINDOW_MINUTES} minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [device_id]
  );
  return rows[0] ?? null;
}

// Records that the door was opened during this order's unlock. Keeps the
// first open if the door is opened more than once.
async function markDoorOpened(order_id) {
  await pool.query(
    `UPDATE orders SET door_opened_at = COALESCE(door_opened_at, NOW())
     WHERE id = $1 AND status IN ('paid', 'dispensing')`,
    [order_id]
  );
}

// Completes a dispensing order, but only if the door was seen opening. A
// single conditional UPDATE so overlapping triggers (door_closed, locked
// 1.5s later, the sweep below) can't race each other.
async function completeOrderIfDoorOpened(order_id) {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'complete', updated_at = NOW()
     WHERE id = $1 AND status = 'dispensing' AND door_opened_at IS NOT NULL
     RETURNING device_id`,
    [order_id]
  );
  if (rows.length === 0) return false;
  console.log(`[ORDER] ${order_id} → complete`);
  _notifySSEClients(order_id, 'complete');
  await logActivity({ order_id, device_id: rows[0].device_id, source: 'server', event: 'complete' });
  return true;
}

// Safety net for when neither door_closed nor locked made it through (the
// fridge dropped off WiFi, or the server was down at that moment). Only
// completes orders where the door was seen opening; anything without that
// evidence stays 'dispensing' for the admin to resolve rather than guessing.
const DISPENSE_SWEEP_MINUTES = 5;

async function completeStaleDispensingOrders() {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'complete', updated_at = NOW()
     WHERE status = 'dispensing'
       AND door_opened_at <= NOW() - INTERVAL '${DISPENSE_SWEEP_MINUTES} minutes'
     RETURNING id, device_id`
  );
  for (const { id, device_id } of rows) {
    console.log(`[ORDER] ${id} → complete (door was opened; close never received)`);
    _notifySSEClients(id, 'complete');
    await logActivity({ order_id: id, device_id, source: 'server', event: 'complete', detail: { door_close_missed: true } });
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
  // order_id often comes straight from a URL — treat anything malformed as
  // "no such order" here rather than in every caller.
  if (!isUuid(order_id)) return null;
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

// before: created_at cursor for paging (only orders older than it);
// statuses: optional list to filter to.
async function getRecentOrders({ limit = 20, before, statuses } = {}) {
  const where  = [];
  const params = [];
  if (before) {
    params.push(before);
    where.push(`created_at < $${params.length}`);
  }
  if (statuses && statuses.length) {
    params.push(statuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const { rows: orders } = await pool.query(
    `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
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

// "Today" starts at midnight in the store's time zone, not the database
// server's (UTC by default, which rolled the day over at 5 PM Pacific).
// AT TIME ZONE handles daylight saving.
async function getOrderStats(timezone) {
  const [{ rows: todayRows }, { rows: totalRows }, { rows: dayRows }, { rows: itemRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS count,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete'
         AND o.created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`,
      [timezone]
    ),
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS count,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete'`
    ),
    // Exactly 7 rows (today and the 6 days before), zero-filled. Each day's
    // bounds are converted from store-local midnight separately, so a
    // daylight-saving day is correctly 23 or 25 hours long.
    pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(oi.quantity), 0) AS count,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM generate_series(
              date_trunc('day', NOW() AT TIME ZONE $1) - INTERVAL '6 days',
              date_trunc('day', NOW() AT TIME ZONE $1),
              INTERVAL '1 day'
            ) AS d(day)
       LEFT JOIN orders o
         ON o.status = 'complete'
        AND o.created_at >= d.day AT TIME ZONE $1
        AND o.created_at <  (d.day + INTERVAL '1 day') AT TIME ZONE $1
       LEFT JOIN order_items oi ON oi.order_id = o.id
       GROUP BY d.day
       ORDER BY d.day`,
      [timezone]
    ),
    pool.query(
      `SELECT oi.item_name,
              SUM(oi.quantity) AS quantity,
              SUM(oi.quantity * oi.unit_price_cents) AS revenue_cents
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete'
         AND o.created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
       GROUP BY oi.item_name
       ORDER BY SUM(oi.quantity) DESC, SUM(oi.quantity * oi.unit_price_cents) DESC, oi.item_name`,
      [timezone]
    ),
  ]);
  return {
    todayCount:         parseInt(todayRows[0].count, 10),
    todayRevenueCents:  parseInt(todayRows[0].revenue_cents, 10),
    totalCount:         parseInt(totalRows[0].count, 10),
    totalRevenueCents:  parseInt(totalRows[0].revenue_cents, 10),
    last7Days: dayRows.map((r) => ({
      day:           r.day,
      count:         parseInt(r.count, 10),
      revenue_cents: parseInt(r.revenue_cents, 10),
    })),
    todayByItem: itemRows.map((r) => ({
      item_name:     r.item_name,
      quantity:      parseInt(r.quantity, 10),
      revenue_cents: parseInt(r.revenue_cents, 10),
    })),
  };
}

// Analysis for the admin Insights tab over the last `days` store-local days
// (including today), or all history when days is null. Like getOrderStats,
// only completed orders count as sales and revenue is pre-tax.
// The window Insights' sell-outs cover, in days back from today.
const SELLOUT_DAYS = 30;

// How many calendar days from today it takes to get through openDays of
// trading, stepping over closed weekdays (ISO numbers).
function calendarDaysFor(openDays, todayDow, closedDays) {
  if (!closedDays.length) return openDays;
  let left = openDays;
  let days = 0;
  for (let dow = todayDow; days < 60; dow = (dow % 7) + 1, days++) {
    if (closedDays.includes(dow)) continue;
    if (left <= 1) return days + left;
    left -= 1;
  }
  return days + left;   // far enough out that the exact figure doesn't matter
}

// closedDays: ISO weekdays the fridge isn't in use. They aren't counted as
// days in any average, though a sale made on one still counts in the totals.
async function getInsights(timezone, days, closedDays = []) {
  // Every range query takes both parameters, with days NULL meaning no lower
  // bound, so the all-time case runs the same SQL.
  const today   = `date_trunc('day', NOW() AT TIME ZONE $1)`;
  const params  = [timezone, days];
  const start   = `${today} - INTERVAL '1 day' * ($2::int - 1)`;
  const inRange = `AND ($2::int IS NULL OR o.created_at >= (${start}) AT TIME ZONE $1)`;
  const sales   = `FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.status = 'complete' ${inRange}`;

  const [
    statusQ, totalsQ, hourQ, dowQ, dayCountQ, itemQ, pairQ, forecastQ, windowQ,
    prevTotalsQ, prevDaysQ, selloutQ, trackedQ,
  ] = await Promise.all([
    // timed_out covers both checkouts that were never paid (abandoned) and
    // paid orders auto-refunded after an unlock timeout; the payment id is
    // what tells them apart.
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE o.status = 'refunded'
                                  OR (o.status = 'timed_out' AND o.square_payment_id IS NOT NULL)) AS refunded,
              COUNT(*) FILTER (WHERE o.status = 'timed_out' AND o.square_payment_id IS NULL) AS abandoned
       FROM orders o WHERE true ${inRange}`,
      params
    ),
    pool.query(
      `SELECT COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(oi.quantity), 0) AS items,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       ${sales}`,
      params
    ),
    pool.query(
      `SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE $1)::int AS hour,
              COUNT(DISTINCT o.id) AS orders, SUM(oi.quantity) AS items
       ${sales} GROUP BY 1`,
      params
    ),
    pool.query(
      `SELECT EXTRACT(ISODOW FROM o.created_at AT TIME ZONE $1)::int AS dow,
              COUNT(DISTINCT o.id) AS orders, SUM(oi.quantity) AS items
       ${sales} GROUP BY 1`,
      params
    ),
    // How many of each weekday the range covers, counted from the first sale
    // when that's later, so averages aren't diluted by days before launch.
    // Closed weekdays aren't counted at all.
    pool.query(
      `SELECT EXTRACT(ISODOW FROM d)::int AS dow, COUNT(*) AS days
       FROM (SELECT date_trunc('day', MIN(created_at) AT TIME ZONE $1) AS first_day
             FROM orders WHERE status = 'complete') f,
            generate_series(CASE WHEN $2::int IS NULL THEN f.first_day ELSE GREATEST(${start}, f.first_day) END,
                            ${today}, INTERVAL '1 day') AS d
       WHERE EXTRACT(ISODOW FROM d)::int <> ALL($3::int[])
       GROUP BY 1`,
      [...params, closedDays]
    ),
    pool.query(
      `SELECT oi.item_name, SUM(oi.quantity) AS quantity,
              SUM(oi.quantity * oi.unit_price_cents) AS revenue_cents, COUNT(DISTINCT o.id) AS orders
       ${sales}
       GROUP BY oi.item_name
       ORDER BY SUM(oi.quantity) DESC, SUM(oi.quantity * oi.unit_price_cents) DESC, oi.item_name`,
      params
    ),
    pool.query(
      `SELECT a.item_name AS a, b.item_name AS b, COUNT(DISTINCT o.id) AS orders
       FROM orders o
       JOIN order_items a ON a.order_id = o.id
       JOIN order_items b ON b.order_id = o.id AND a.item_name < b.item_name
       WHERE o.status = 'complete' ${inRange}
       GROUP BY 1, 2
       ORDER BY 3 DESC, 1, 2
       LIMIT 3`,
      params
    ),
    // The forecast always uses recent sales (the last 14 days, or since the
    // first sale if that's sooner), whatever range is picked.
    pool.query(
      `SELECT i.id, i.name, i.stock, COALESCE(s.sold, 0) AS sold
       FROM items i
       LEFT JOIN (
         SELECT oi.item_id, SUM(oi.quantity) AS sold
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE o.status = 'complete' AND o.created_at >= (${today} - INTERVAL '13 days') AT TIME ZONE $1
         GROUP BY oi.item_id
       ) s ON s.item_id = i.id
       WHERE i.active
       ORDER BY i.name`,
      [timezone]
    ),
    // That window's length, how many of its days were open, and today's
    // weekday for turning open days of stock back into calendar days.
    pool.query(
      `SELECT COUNT(*) AS days,
              COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d)::int <> ALL($2::int[])) AS open_days,
              EXTRACT(ISODOW FROM ${today})::int AS today_dow
       FROM (SELECT date_trunc('day', MIN(created_at) AT TIME ZONE $1) AS first_day
             FROM orders WHERE status = 'complete') f,
            generate_series(GREATEST(${today} - INTERVAL '13 days', f.first_day), ${today}, INTERVAL '1 day') AS d`,
      [timezone, closedDays]
    ),
    // The same number of days just before the range, cut off at the same
    // time of day, to compare against. Not for all time.
    days === null ? null : pool.query(
      `SELECT COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(oi.quantity), 0) AS items,
              COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0) AS revenue_cents
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'complete'
         AND o.created_at >= (${start} - INTERVAL '1 day' * $2::int) AT TIME ZONE $1
         AND o.created_at <  NOW() - INTERVAL '1 day' * $2::int`,
      params
    ),
    // Its open days, and whether sales had started by then. A comparison
    // against a stretch from before launch would mean nothing.
    days === null ? null : pool.query(
      `SELECT COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d)::int <> ALL($3::int[])) AS open_days,
              MIN(f.first_day) <= MIN(d) AS covered
       FROM (SELECT date_trunc('day', MIN(created_at) AT TIME ZONE $1) AS first_day
             FROM orders WHERE status = 'complete') f,
            generate_series(${start} - INTERVAL '1 day' * $2::int, ${today} - INTERVAL '1 day' * $2::int,
                            INTERVAL '1 day') AS d`,
      [...params, closedDays]
    ),
    // Each open day of the last SELLOUT_DAYS an item sold out, or spent
    // entirely sold out (a sell-out that carried over from an earlier day
    // without a restock before it started), and its median sell-out time.
    // A fixed window rather than the picked range: it sits on the Stock view,
    // which has no range buttons.
    pool.query(
      `WITH out_days AS (
         SELECT s.item_id, s.item_name, s.started_at, d,
                d = date_trunc('day', s.started_at AT TIME ZONE $1) AS sold_out_that_day
         FROM sellouts s,
              generate_series(date_trunc('day', s.started_at AT TIME ZONE $1),
                              date_trunc('day', COALESCE(s.ended_at, NOW()) AT TIME ZONE $1), INTERVAL '1 day') AS d
         WHERE ($2::int IS NULL OR d >= ${start})
           AND EXTRACT(ISODOW FROM d)::int <> ALL($3::int[])
           AND (d = date_trunc('day', s.started_at AT TIME ZONE $1)
                OR COALESCE(s.ended_at, NOW()) AT TIME ZONE $1 >= LEAST(d + INTERVAL '1 day', NOW() AT TIME ZONE $1))
       )
       SELECT COALESCE(i.name, MAX(o.item_name)) AS item_name,
              COUNT(DISTINCT o.d) FILTER (WHERE o.sold_out_that_day) AS days_sold_out,
              COUNT(DISTINCT o.d) FILTER (WHERE NOT o.sold_out_that_day) AS days_out_all_day,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (EXTRACT(EPOCH FROM (o.started_at AT TIME ZONE $1)::time) / 60)::float8)
                FILTER (WHERE o.sold_out_that_day) AS usual_minute
       FROM out_days o LEFT JOIN items i ON i.id = o.item_id
       GROUP BY o.item_id, i.name
       ORDER BY COUNT(DISTINCT o.d) DESC, 1`,
      [timezone, SELLOUT_DAYS, closedDays]
    ),
    // The open days in that window that sell-outs were tracked for: tracking
    // started with this feature, so at first it's only partly covered.
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d)::int <> ALL($3::int[])) AS open_days,
              to_char(MIN(t.since_day), 'YYYY-MM-DD') AS since,
              MIN(t.since_day) > COALESCE(${start}, MIN(f.first_day)) AS partial
       FROM (SELECT date_trunc('day', value::timestamptz AT TIME ZONE $1) AS since_day
             FROM settings WHERE key = 'sellouts_since') t,
            (SELECT date_trunc('day', MIN(created_at) AT TIME ZONE $1) AS first_day
             FROM orders WHERE status = 'complete') f,
            generate_series(GREATEST(t.since_day, f.first_day, ${start}), ${today}, INTERVAL '1 day') AS d`,
      [timezone, SELLOUT_DAYS, closedDays]
    ),
  ]);

  const n = (v) => parseInt(v, 10) || 0;
  const orders   = n(totalsQ.rows[0].orders);
  const items    = n(totalsQ.rows[0].items);
  const revenue  = n(totalsQ.rows[0].revenue_cents);
  const refunded = n(statusQ.rows[0].refunded);

  const weekdayDays = {};
  let daysCounted = 0;
  for (const r of dayCountQ.rows) {
    weekdayDays[r.dow] = n(r.days);
    daysCounted += n(r.days);
  }
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, items: 0 }));
  for (const r of hourQ.rows) byHour[r.hour] = { hour: r.hour, orders: n(r.orders), items: n(r.items) };
  const byWeekday = [1, 2, 3, 4, 5, 6, 7].map((dow) => {
    const r = dowQ.rows.find((x) => x.dow === dow);
    return { dow, orders: r ? n(r.orders) : 0, items: r ? n(r.items) : 0, days: weekdayDays[dow] || 0 };
  });

  const windowDays = n(windowQ.rows[0].days) || 14;
  const openDays   = n(windowQ.rows[0].open_days);
  const todayDow   = n(windowQ.rows[0].today_dow);
  const tracked    = trackedQ.rows[0];

  return {
    range: { days, days_counted: daysCounted, closed_days: closedDays },
    summary: {
      orders,
      items,
      revenue_cents:   revenue,
      avg_order_cents: orders ? Math.round(revenue / orders) : 0,
      items_per_order: orders ? items / orders : 0,
      refunded,
      refund_rate:     orders + refunded ? refunded / (orders + refunded) : 0,
      abandoned:       n(statusQ.rows[0].abandoned),
    },
    // The same totals for the stretch before the range, or null when there's
    // nothing to compare (all time, or sales hadn't started yet).
    previous: prevDaysQ && prevDaysQ.rows[0].covered ? {
      orders:        n(prevTotalsQ.rows[0].orders),
      items:         n(prevTotalsQ.rows[0].items),
      revenue_cents: n(prevTotalsQ.rows[0].revenue_cents),
      open_days:     n(prevDaysQ.rows[0].open_days),
    } : null,
    byHour,
    byWeekday,
    topItems: itemQ.rows.map((r) => ({
      item_name:     r.item_name,
      quantity:      n(r.quantity),
      revenue_cents: n(r.revenue_cents),
      orders:        n(r.orders),
    })),
    pairs: pairQ.rows.map((r) => ({ a: r.a, b: r.b, orders: n(r.orders) })),
    // usual_minute: median minutes after midnight it sold out, null when it
    // only carried over from earlier days.
    sellouts: {
      days:          SELLOUT_DAYS,
      open_days:     n(tracked.open_days),
      tracked_since: tracked.since,
      partial:       Boolean(tracked.partial),
      items: selloutQ.rows.map((r) => ({
        item_name:        r.item_name,
        days_sold_out:    n(r.days_sold_out),
        days_out_all_day: n(r.days_out_all_day),
        usual_minute:     r.usual_minute === null ? null : Math.round(r.usual_minute),
      })),
    },
    // per_day is per open day. days_left counts calendar days, so a closed
    // weekend in between pushes it out; open_days_left doesn't.
    forecast: {
      window_days: windowDays,
      open_days:   openDays,
      items: forecastQ.rows.map((r) => {
        const sold     = n(r.sold);
        const perDay   = sold / Math.max(openDays, 1);
        const openLeft = perDay > 0 ? r.stock / perDay : null;
        return {
          id: r.id, name: r.name, stock: r.stock, sold, per_day: perDay,
          open_days_left: openLeft,
          days_left:      openLeft === null ? null : calendarDaysFor(openLeft, todayDow, closedDays),
        };
      }),
    },
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
  claimPendingOrderForPayment,
  claimUnpaidOrderForLateRefund,
  getInProgressOrderForDevice,
  markDoorOpened,
  completeOrderIfDoorOpened,
  completeStaleDispensingOrders,
  getOrder,
  updateOrder,
  getRecentOrders,
  getOrderStats,
  getInsights,
  deleteOrder,
  deleteAllOrders,
  isDuplicateEvent,
  addSSEClient,
  removeSSEClient,
};
