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
// If device is online: show the item picker.
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
    const itemListHtml = items.map((it) => {
      const soldOut = it.stock <= 0;
      return `<div class="item-option${soldOut ? ' soldout' : ''}" data-id="${it.id}" data-price="${it.price_cents}" data-stock="${it.stock}">
        <div>
          <div class="item-option-name">${escapeHtml(it.name)}</div>
          <div class="item-option-price">$${(it.price_cents / 100).toFixed(2)} each</div>
        </div>
        ${soldOut ? '<span class="item-option-badge">Sold out</span>' : ''}
      </div>`;
    }).join('');

    bodyHtml = `
      <div class="item-list" id="itemList">${itemListHtml}</div>
      <div class="price" id="totalPrice"></div>
      <div class="unit-price" id="unitPrice"></div>
      <div class="qty-row">
        <button class="qty-btn" id="qtyDown">−</button>
        <span class="qty-num" id="qtyNum">1</span>
        <button class="qty-btn" id="qtyUp">+</button>
      </div>
      <p class="hint">Tap to pay — fridge unlocks instantly</p>
      <button class="pay-btn" id="payBtn">Pay</button>
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
    .price  { font-size: 2.25rem; font-weight: 800; letter-spacing: -0.03em; margin: 0.75rem 0 0; }
    .unit-price { font-size: 0.8rem; color: #999; margin-bottom: 1rem; }
    .item-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 1.25rem 0; text-align: left; }
    .item-option {
      border: 1.5px solid #e0e0e0;
      border-radius: 12px;
      padding: 0.75rem 0.9rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .item-option.selected { border-color: #111; background: #fafafa; }
    .item-option.soldout  { opacity: 0.5; cursor: not-allowed; }
    .item-option-name  { font-weight: 600; font-size: 0.95rem; }
    .item-option-price { font-size: 0.85rem; color: #666; margin-top: 0.1rem; }
    .item-option-badge { font-size: 0.72rem; color: #c00; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
    .qty-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }
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
    .qty-btn:hover:not(:disabled) { background: #e0e0e0; }
    .qty-btn:disabled { color: #bbb; cursor: not-allowed; }
    .qty-num { font-size: 1.5rem; font-weight: 700; min-width: 2rem; text-align: center; }
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
    button.pay-btn:hover   { opacity: 0.8; }
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
    var DEVICE_ID = ${JSON.stringify(device_id)};
    var qty = 1;
    var selected = null;

    var optionEls = Array.prototype.slice.call(document.querySelectorAll('.item-option'));
    var qtyNum    = document.getElementById('qtyNum');
    var qtyDown   = document.getElementById('qtyDown');
    var qtyUp     = document.getElementById('qtyUp');
    var totalEl   = document.getElementById('totalPrice');
    var unitEl    = document.getElementById('unitPrice');
    var payBtn    = document.getElementById('payBtn');
    var errMsg    = document.getElementById('errMsg');

    function formatCents(cents) {
      return '$' + (cents / 100).toFixed(2);
    }

    function updateQty(n) {
      if (!selected) return;
      var maxQty = Math.max(1, Math.min(10, selected.stock));
      qty = Math.max(1, Math.min(maxQty, n));
      qtyNum.textContent = qty;
      qtyDown.disabled = qty <= 1;
      qtyUp.disabled   = qty >= maxQty;
      var total = formatCents(qty * selected.price);
      totalEl.textContent = total;
      unitEl.textContent  = qty === 1 ? '' : formatCents(selected.price) + ' each';
      payBtn.textContent  = 'Pay ' + total;
    }

    function selectItem(el) {
      if (el.classList.contains('soldout')) return;
      optionEls.forEach(function(o) { o.classList.remove('selected'); });
      el.classList.add('selected');
      selected = {
        id:    el.getAttribute('data-id'),
        price: parseInt(el.getAttribute('data-price'), 10),
        stock: parseInt(el.getAttribute('data-stock'), 10),
      };
      payBtn.disabled = false;
      updateQty(1);
    }

    optionEls.forEach(function(el) {
      el.addEventListener('click', function() { selectItem(el); });
    });

    var firstAvailable = optionEls.find(function(el) { return !el.classList.contains('soldout'); });
    if (firstAvailable) {
      selectItem(firstAvailable);
    } else {
      payBtn.disabled = true;
      payBtn.textContent = 'Sold out';
    }

    qtyDown.addEventListener('click', function() { updateQty(qty - 1); });
    qtyUp.addEventListener('click',   function() { updateQty(qty + 1); });

    payBtn.addEventListener('click', function() {
      if (!selected) return;
      payBtn.disabled    = true;
      payBtn.textContent = 'Starting checkout…';
      errMsg.textContent = '';

      fetch('/api/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device_id: DEVICE_ID, item_id: selected.id, quantity: qty }),
      }).then(function(res) {
        return res.json().then(function(data) {
          if (!res.ok) throw new Error(data.error || 'Checkout failed');
          window.location.href = data.checkout_url;
        });
      }).catch(function(e) {
        errMsg.textContent = e.message;
        payBtn.disabled     = false;
        updateQty(qty);
      });
    });
  </script>` : ''}
</body>
</html>`);
});

module.exports = router;
