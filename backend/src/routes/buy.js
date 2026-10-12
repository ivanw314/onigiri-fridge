'use strict';
const { Router } = require('express');
const { isDeviceOnline } = require('../mqttClient');
const { getActiveItems, getCategories } = require('../itemStore');

const router = Router();

const STORE_NAME = () => process.env.STORE_NAME || process.env.ITEM_NAME || 'Onigiri Fridge';
const STORE_LOGO_URL = () => process.env.STORE_LOGO_URL || null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Splits items into the buy page's sections: one per category in admin
// order, then uncategorized items last under "Other". Empty sections are
// dropped. `name` is null when nothing is categorized, so a store that
// doesn't use categories gets one plain list with no heading.
function groupIntoSections(items, categories) {
  const sections = new Map(categories.map((c) => [c.id, { name: c.name, items: [] }]));
  const other = { name: 'Other', items: [] };
  for (const it of items) (sections.get(it.category_id) ?? other).items.push(it);
  const nonEmpty = [...sections.values(), other].filter((s) => s.items.length > 0);
  if (nonEmpty.length === 1 && nonEmpty[0] === other) other.name = null;
  return nonEmpty;
}

// GET /buy/:device_id
// Customer scans QR code → lands here.
// If device is online: show the cart — each item gets its own qty stepper,
// so a customer can buy several different items in one purchase.
// If device is offline: show unavailable message (no payment taken).
router.get('/:device_id', async (req, res) => {
  const { device_id } = req.params;
  const online        = isDeviceOnline(device_id);
  const [items, categories] = online ? await Promise.all([getActiveItems(), getCategories()]) : [[], []];

  let bodyHtml;
  if (!online) {
    bodyHtml = `<p class="hint offline">⚠️ This fridge is currently unavailable.<br>Please try again in a moment.</p>`;
  } else if (items.length === 0) {
    bodyHtml = `<p class="hint offline">Nothing available to buy right now.<br>Please check back later.</p>`;
  } else {
    const itemRowHtml = (it) => {
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
    };

    const sections = groupIntoSections(items, categories);
    const sectionsHtml = sections.map((s, i) => `<section class="menu-section" id="section-${i}">
        ${s.name ? `<h2 class="section-heading">${escapeHtml(s.name)}</h2>` : ''}
        <div class="item-list">${s.items.map(itemRowHtml).join('')}</div>
      </section>`).join('');
    // Jump links, only worth showing once there's more than one section.
    const navHtml = sections.length > 1
      ? `<nav class="section-nav">${sections.map((s, i) =>
          `<a class="section-chip" href="#section-${i}">${escapeHtml(s.name)}</a>`).join('')}</nav>`
      : '';

    bodyHtml = `
      ${navHtml}
      <div class="menu">${sectionsHtml}</div>
      <p class="hint">Tap + to add items — fridge unlocks instantly</p>
      <div class="checkout-bar">
        <div class="checkout-row">
          <div class="cart-total">
            <span class="cart-total-label">Total</span>
            <span id="totalPrice">$0.00</span>
          </div>
          <button class="pay-btn" id="payBtn" disabled>Pay</button>
        </div>
        <p class="error" id="errMsg"></p>
      </div>`;
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
    .logo   { max-width: 100%; max-height: 6rem; margin-bottom: 0.75rem; }
    h1      { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
    .section-nav {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      gap: 0.4rem;
      overflow-x: auto;
      scrollbar-width: none;
      /* Bleed to the card's edges so rows scrolling under it are fully hidden. */
      margin: 1rem -2rem 0;
      padding: 0.6rem 2rem;
      background: #fff;
      border-bottom: 1px solid #f0f0f0;
    }
    .section-nav::-webkit-scrollbar { display: none; }
    .section-chip {
      flex-shrink: 0;
      padding: 0.4rem 0.8rem;
      border-radius: 999px;
      background: #f0f0f0;
      color: #111;
      font-size: 0.85rem;
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }
    .menu { display: flex; flex-direction: column; gap: 1.25rem; margin: 1.25rem 0; text-align: left; }
    .menu-section { scroll-margin-top: 4rem; }
    .section-heading {
      font-size: 0.78rem;
      font-weight: 700;
      color: #777;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }
    .item-list { display: flex; flex-direction: column; gap: 0.5rem; }
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
    /* Stays pinned to the bottom of the screen while the menu scrolls, so the
       total and Pay button are always in reach however long the list is. */
    .checkout-bar {
      position: sticky;
      bottom: 0;
      z-index: 1;
      /* Bleed to the card's edges, like .section-nav. */
      margin: 0 -2rem;
      padding: 0.75rem 2rem;
      background: #fff;
      border-top: 1px solid #f0f0f0;
    }
    .checkout-row { display: flex; align-items: center; gap: 1rem; }
    .cart-total { display: flex; flex-direction: column; align-items: flex-start; text-align: left; }
    .cart-total-label { font-size: 0.72rem; font-weight: 700; color: #777; text-transform: uppercase; letter-spacing: 0.05em; }
    #totalPrice { font-size: 1.25rem; font-weight: 700; }
    .hint   { font-size: 0.85rem; color: #777; margin-bottom: 1.5rem; line-height: 1.4; }
    .menu + .hint { margin-bottom: 1rem; }
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
      flex: 1;
      transition: opacity 0.15s;
    }
    button.pay-btn:hover:not(:disabled) { opacity: 0.8; }
    button.pay-btn:disabled { background: #bbb; cursor: not-allowed; opacity: 1; }
    .error { color: #c00; font-size: 0.85rem; margin-top: 0.5rem; }
    .error:empty { display: none; }
  </style>
</head>
<body>
  <div class="card">
    ${STORE_LOGO_URL()
      ? `<img class="logo" src="${escapeHtml(STORE_LOGO_URL())}" alt="${escapeHtml(STORE_NAME())}">`
      : `<div class="emoji">🍙</div>`}
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
      payBtn.textContent  = 'Pay';
    }

    // Scroll to the section rather than following the #link, so each tap
    // doesn't add a history entry the phone's back button has to step through.
    document.querySelectorAll('.section-chip').forEach(function(chip) {
      chip.addEventListener('click', function(e) {
        e.preventDefault();
        document.querySelector(chip.getAttribute('href')).scrollIntoView({ behavior: 'smooth' });
      });
    });

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
