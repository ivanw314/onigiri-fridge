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

// ── Tax lookup ────────────────────────────────────────────────────────────────
// Mirrors whatever sales tax rate is already configured on the physical
// Square terminal's catalog, instead of hardcoding a percentage that can
// drift out of sync with the dashboard. Cached in memory — tax codes change
// at most a few times a year, not worth a Square API call on every checkout.

const TAX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let taxCache = { catalogObjectId: null, fetchedAt: 0 };

async function getTaxCatalogObjectId() {
  if (Date.now() - taxCache.fetchedAt < TAX_CACHE_TTL_MS) {
    return taxCache.catalogObjectId;
  }

  try {
    const data = await squareFetch('/v2/catalog/list?types=TAX');
    const enabledTaxes = (data.objects || []).filter((o) => o.tax_data?.enabled !== false);

    let match;
    if (process.env.SQUARE_TAX_NAME) {
      match = enabledTaxes.find((o) => o.tax_data?.name === process.env.SQUARE_TAX_NAME);
      if (!match) {
        console.error(`[SQUARE] No enabled catalog tax named "${process.env.SQUARE_TAX_NAME}" found — charging no tax`);
      }
    } else if (enabledTaxes.length === 1) {
      match = enabledTaxes[0];
    } else if (enabledTaxes.length > 1) {
      console.error(
        '[SQUARE] Multiple enabled catalog taxes found — set SQUARE_TAX_NAME to pick one:',
        enabledTaxes.map((o) => o.tax_data?.name).join(', ')
      );
    }

    taxCache = { catalogObjectId: match?.id ?? null, fetchedAt: Date.now() };
  } catch (err) {
    console.error('[SQUARE] Failed to refresh tax catalog, keeping last known value:', err.message);
    // Don't let a transient API failure drop tax entirely — just retry on
    // the next TTL window instead of hammering Square with retries now.
    taxCache = { ...taxCache, fetchedAt: Date.now() };
  }

  return taxCache.catalogObjectId;
}

// ── createPaymentLink ─────────────────────────────────────────────────────────
// Creates a Square hosted checkout URL covering one or more distinct items
// (a cart). order_id is stored as reference_id on the Square order so we can
// correlate the webhook back to our internal order.
//
// line_items: [{ name, quantity, amount_cents }, ...]
// Returns: { checkout_url, square_order_id }

async function createPaymentLink({ order_id, line_items, redirect_url }) {
  const { SQUARE_LOCATION_ID } = process.env;
  if (!SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID env var not set');

  const taxCatalogObjectId = await getTaxCatalogObjectId();
  const taxes = taxCatalogObjectId
    ? [{ uid: 'sales_tax', catalog_object_id: taxCatalogObjectId, scope: 'ORDER' }]
    : undefined;

  const data = await squareFetch('/v2/online-checkout/payment-links', {
    method: 'POST',
    body: JSON.stringify({
      idempotency_key: order_id,
      order: {
        location_id:  SQUARE_LOCATION_ID,
        reference_id: order_id,
        line_items: line_items.map((li) => ({
          name:     li.name,
          quantity: String(li.quantity),
          base_price_money: {
            amount:   li.amount_cents,
            currency: 'USD',
          },
        })),
        ...(taxes ? { taxes } : {}),
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