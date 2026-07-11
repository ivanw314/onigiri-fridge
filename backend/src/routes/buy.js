'use strict';
const { Router } = require('express');
const { isDeviceOnline } = require('../mqttClient');
const { getActiveItems } = require('../itemStore');

const router = Router();

const STORE_NAME = () => process.env.STORE_NAME || process.env.ITEM_NAME || 'Onigiri Fridge';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /buy/:device_id
// Customer scans QR code → lands here.
// If device is online: show the cart — each item gets its own qty stepper,
// so a customer can buy several different items in one purchase.
// If device is offline: show unavailable message (no payment taken).
router.get('/:device_id', async (req, res) => {
  const { device_id } = req.params;
  const online        = isDeviceOnline(device_id);
  const items         = online ? await getActiveItems() : [];

  let bodyHtml;
  if (!online) {
    bodyHtml = `<p class="hint offline">⚠️ This fridge is currently unavailable.<br>Please try again in a moment.</p>`;
  } else if (items.length === 0) {
    bodyHtml = `<p class="hint offline">Nothing available to buy right now.<br>Please check back later.</p>`;
  } else {
    const itemRowsHtml = items.map((it) => {
      const soldOut = it.stock <= 0;
      const maxQty  = Math.min(10, it.stock);
      return `<div class="item-row${soldOut ? ' soldout' : ''}" data-id="${it.id}" data-price="${it.price_cents}" data-max="${maxQty}">
        <div class="item-row-info">
          <div class="item-row-name">${escapeHtml(it.name)}</div>
          <div class="item-row-price">$${(it.price_cents / 100).toFixed(2)} each</div>
        </div>
        ${soldOut
          ? '<span class="item-option-badge">Sold out</span>'
          : `<div class="item-row-qty">
               <button class="qty-btn small" data-action="down" data-id="${it.id}">−</button>
               <span class="qty-num small" data-qty-for="${it.id}">0</span>
               <button class="qty-btn small" data-action="up" data-id="${it.id}">+</button>
             </div>`
        }
      </div>`;
    }).join('');

    bodyHtml = `
      <div class="item-list" id="itemList">${itemRowsHtml}</div>
      <div class="cart-total-row">
        <span>Total</span>
        <span id="totalPrice">$0.00</span>
      </div>
      <p class="hint">Tap + to add items — fridge unlocks instantly</p>
      <button class="pay-btn" id="payBtn" disabled>Select items to pay</button>
      <p class="error" id="errMsg"></p>`;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(STORE_NAME())} — Buy Now</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f4f4ef;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100dvh;
      padding: 1.5rem;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 2.5rem 2rem;
      max-width: 340px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.07);
    }
    .emoji  { font-size: 3rem; line-height: 1; margin-bottom: 0.75rem; }
    h1      { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
    .item-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 1.25rem 0; text-align: left; }
    .item-row {
      border: 1.5px solid #e0e0e0;
      border-radius: 12px;
      padding: 0.65rem 0.85rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .item-row.soldout { opacity: 0.5; }
    .item-row-name  { font-weight: 600; font-size: 0.95rem; }
    .item-row-price { font-size: 0.82rem; color: #666; margin-top: 0.1rem; }
    .item-option-badge { font-size: 0.72rem; color: #c00; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
    .item-row-qty { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .qty-btn {
      background: #f0f0f0;
      color: #111;
      border: none;
      border-radius: 50%;
      width: 2.25rem;
      height: 2.25rem;
      font-size: 1.25rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s;
    }
    .qty-btn.small { width: 1.8rem; height: 1.8rem; font-size: 1rem; }
    .qty-btn:hover:not(:disabled) { background: #e0e0e0; }
    .qty-btn:disabled { color: #bbb; cursor: not-allowed; }
    .qty-num { font-size: 1.5rem; font-weight: 700; min-width: 2rem; text-align: center; }
    .qty-num.small { font-size: 1.05rem; min-width: 1.3rem; }
    .cart-total-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 1.15rem;
      font-weight: 700;
      margin: 0.5rem 0 1rem;
    }
    .hint   { font-size: 0.85rem; color: #777; margin-bottom: 1.5rem; line-height: 1.4; }
    .hint.offline { color: #c00; }
    button.pay-btn {
      background: #111;
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 1rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: opacity 0.15s;
    }
    button.pay-btn:hover:not(:disabled) { opacity: 0.8; }
    button.pay-btn:disabled { background: #bbb; cursor: not-allowed; opacity: 1; }
    .error { color: #c00; font-size: 0.85rem; margin-top: 1rem; min-height: 1.2em; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">🍙</div>
    <h1>${escapeHtml(STORE_NAME())}</h1>
    ${bodyHtml}
  </div>

  ${online && items.length ? `<script>
    var DEVICE_ID    = ${JSON.stringify(device_id)};
    var CART_KEY     = 'onigiri_cart_' + DEVICE_ID;
    var PENDING_KEY  = 'onigiri_checkout_pending_' + DEVICE_ID;
    var cart = {}; // item_id -> { price, maxQty, qty }

    var rows    = Array.prototype.slice.call(document.querySelectorAll('.item-row'));
    var totalEl = document.getElementById('totalPrice');
    var payBtn  = document.getElementById('payBtn');
    var errMsg  = document.getElementById('errMsg');

    rows.forEach(function(row) {
      var id = row.getAttribute('data-id');
      cart[id] = {
        price:  parseInt(row.getAttribute('data-price'), 10),
        maxQty: parseInt(row.getAttribute('data-max'), 10),
        qty:    0,
      };
    });

    // Restore quantities from a previous visit — e.g. the customer went to
    // Square checkout, then came back to add something they forgot.
    (function restoreCart() {
      var saved;
      try { saved = JSON.parse(sessionStorage.getItem(CART_KEY) || '{}'); } catch (e) { saved = {}; }
      Object.keys(saved).forEach(function(id) {
        if (!cart[id]) return;
        cart[id].qty = Math.max(0, Math.min(cart[id].maxQty, saved[id] || 0));
        var qtyEl = document.querySelector('[data-qty-for="' + id + '"]');
        if (qtyEl) qtyEl.textContent = cart[id].qty;
      });
    })();

    function saveCart() {
      var toSave = {};
      Object.keys(cart).forEach(function(id) { toSave[id] = cart[id].qty; });
      try { sessionStorage.setItem(CART_KEY, JSON.stringify(toSave)); } catch (e) { /* storage unavailable */ }
    }

    // Runs on every page view, including a browser back-navigation restored
    // from bfcache (which doesn't re-run the script above). If we left for
    // Square checkout and are now back, free up the pending order right
    // away instead of leaving the customer stuck until the timeout sweep.
    window.addEventListener('pageshow', function() {
      if (!sessionStorage.getItem(PENDING_KEY)) return;
      sessionStorage.removeItem(PENDING_KEY);
      payBtn.disabled    = false;
      errMsg.textContent = '';
      recompute();
      fetch('/api/checkout/cancel', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device_id: DEVICE_ID }),
      }).catch(function() { /* best effort — timeout sweep is the fallback */ });
    });

    function formatCents(cents) {
      return '$' + (cents / 100).toFixed(2);
    }

    function recompute() {
      var total = 0, anyQty = false;
      Object.keys(cart).forEach(function(id) {
        total += cart[id].qty * cart[id].price;
        if (cart[id].qty > 0) anyQty = true;
      });
      totalEl.textContent = formatCents(total);
      payBtn.disabled     = !anyQty;
      payBtn.textContent  = anyQty ? 'Pay ' + formatCents(total) : 'Select items to pay';
    }

    document.querySelectorAll('.qty-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id     = btn.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        var row    = cart[id];
        if (!row) return;
        var next = row.qty + (action === 'up' ? 1 : -1);
        row.qty = Math.max(0, Math.min(row.maxQty, next));
        document.querySelector('[data-qty-for="' + id + '"]').textContent = row.qty;
        recompute();
        saveCart();
      });
    });

    payBtn.addEventListener('click', function() {
      var cartItems = Object.keys(cart)
        .filter(function(id) { return cart[id].qty > 0; })
        .map(function(id) { return { item_id: id, quantity: cart[id].qty }; });
      if (!cartItems.length) return;

      payBtn.disabled     = true;
      payBtn.textContent  = 'Starting checkout…';
      errMsg.textContent  = '';

      fetch('/api/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device_id: DEVICE_ID, items: cartItems }),
      }).then(function(res) {
        return res.json().then(function(data) {
          if (!res.ok) throw new Error(data.error || 'Checkout failed');
          // Mark this checkout as in-flight so that if the customer backs
          // out of Square to edit their cart, the pageshow handler above
          // knows to free up the pending order instead of waiting it out.
          sessionStorage.setItem(PENDING_KEY, '1');
          window.location.href = data.checkout_url;
        });
      }).catch(function(e) {
        errMsg.textContent = e.message;
        recompute();
      });
    });

    recompute();
  </script>` : ''}
</body>
</html>`);
});

module.exports = router;
