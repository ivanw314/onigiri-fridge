'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function squareHeaders() {
  return {
    'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Content-Type':  'application/json',
    'Square-Version': '2024-01-18',
  };
}

function squareBase() {
  // Sandbox:    https://connect.squareupsandbox.com
  // Production: https://connect.squareup.com
  return process.env.SQUARE_API_BASE || 'https://connect.squareupsandbox.com';
}

async function squareFetch(path, options = {}) {
  const res = await fetch(`${squareBase()}${path}`, {
    ...options,
    headers: { ...squareHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[SQUARE] API error:', path, JSON.stringify(data));
    throw new Error(`Square ${res.status}: ${JSON.stringify(data.errors ?? data)}`);
  }
  return data;
}

// ── createPaymentLink ─────────────────────────────────────────────────────────
// Creates a Square hosted checkout URL.
// order_id is stored as reference_id on the Square order so we can
// correlate the webhook back to our internal order.
//
// Returns: { checkout_url, square_order_id }

async function createPaymentLink({ order_id, amount_cents, item_name, redirect_url, quantity = 1 }) {
  const { SQUARE_LOCATION_ID } = process.env;
  if (!SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID env var not set');

  const data = await squareFetch('/v2/online-checkout/payment-links', {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: order_id,
      order: {
        location_id:  SQUARE_LOCATION_ID,
        reference_id: order_id,
        line_items: [
          {
            name:     item_name || 'Onigiri',
            quantity: String(quantity),
            base_price_money: {
              amount:   amount_cents,
              currency: 'USD',
            },
          },
        ],
      },
      checkout_options: {
        redirect_url,
      },
    }),
  });

  return {
    checkout_url:    data.payment_link.url,
    square_order_id: data.payment_link.order_id,
  };
}

// ── getSquareOrder ────────────────────────────────────────────────────────────
// Fetches a Square order by its Square-assigned order_id.
// Used in the webhook handler because the sandbox sometimes omits
// reference_id from the webhook payload — this call gets it authoritatively.

async function getSquareOrder(square_order_id) {
  const data = await squareFetch(`/v2/orders/${square_order_id}`);
  return data.order; // { id, reference_id, state, ... }
}

// ── createRefund ──────────────────────────────────────────────────────────────
// Issues a full refund for a completed Square payment.
// Called when an order transitions to 'refunded' after a failed or timed-out unlock.

async function createRefund({ payment_id, order_id, amount_cents }) {
  const cents = amount_cents ?? parseInt(process.env.ITEM_PRICE_CENTS || '300', 10);
  return squareFetch('/v2/refunds', {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: `refund-${order_id}`,
      payment_id,
      reason: 'Unlock timeout — item not dispensed',
      amount_money: {
        amount:   cents,
        currency: 'USD',
      },
    }),
  });
}

module.exports = { createPaymentLink, getSquareOrder, createRefund };