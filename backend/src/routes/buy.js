'use strict';
const { Router } = require('express');
const { isDeviceOnline } = require('../mqttClient');

const router = Router();

const ITEM_NAME     = () => process.env.ITEM_NAME          || 'Onigiri';
const PRICE_DISPLAY = () => process.env.ITEM_PRICE_DISPLAY || '$3.00';

// GET /buy/:device_id
// Customer scans QR code → lands here.
// If device is online: show Pay button.
// If device is offline: show unavailable message (no payment taken).
router.get('/:device_id', (req, res) => {
  const { device_id } = req.params;
  const online        = isDeviceOnline(device_id);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ITEM_NAME()} — Buy Now</title>
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
    <h1>${ITEM_NAME()}</h1>
    <div class="price" id="totalPrice">${PRICE_DISPLAY()}</div>
    <div class="unit-price" id="unitPrice"></div>
    ${online
      ? `<div class="qty-row">
           <button class="qty-btn" id="qtyDown">−</button>
           <span class="qty-num" id="qtyNum">1</span>
           <button class="qty-btn" id="qtyUp">+</button>
         </div>
         <p class="hint">Tap to pay — fridge unlocks instantly</p>
         <button class="pay-btn" id="payBtn">Pay ${PRICE_DISPLAY()}</button>
         <p class="error" id="errMsg"></p>`
      : `<p class="hint offline">⚠️ This fridge is currently unavailable.<br>Please try again in a moment.</p>`
    }
  </div>

  ${online ? `<script>
    var UNIT_CENTS   = ${parseInt(process.env.ITEM_PRICE_CENTS || '300', 10)};
    var UNIT_DISPLAY = '${PRICE_DISPLAY()}';
    var qty = 1;
    var MAX_QTY = 10;

    var btn       = document.getElementById('payBtn');
    var errMsg    = document.getElementById('errMsg');
    var qtyNum    = document.getElementById('qtyNum');
    var qtyDown   = document.getElementById('qtyDown');
    var qtyUp     = document.getElementById('qtyUp');
    var totalEl   = document.getElementById('totalPrice');
    var unitEl    = document.getElementById('unitPrice');

    function formatCents(cents) {
      return '$' + (cents / 100).toFixed(2);
    }

    function updateQty(n) {
      qty = Math.max(1, Math.min(MAX_QTY, n));
      qtyNum.textContent = qty;
      qtyDown.disabled = qty <= 1;
      qtyUp.disabled   = qty >= MAX_QTY;
      if (qty === 1) {
        totalEl.textContent = UNIT_DISPLAY;
        unitEl.textContent  = '';
        btn.textContent     = 'Pay ' + UNIT_DISPLAY;
      } else {
        var total = formatCents(qty * UNIT_CENTS);
        totalEl.textContent = total;
        unitEl.textContent  = UNIT_DISPLAY + ' each';
        btn.textContent     = 'Pay ' + total;
      }
    }

    qtyDown.addEventListener('click', function() { updateQty(qty - 1); });
    qtyUp.addEventListener('click',   function() { updateQty(qty + 1); });
    updateQty(1);

    btn.addEventListener('click', function() {
      btn.disabled    = true;
      btn.textContent = 'Starting checkout…';
      errMsg.textContent = '';

      fetch('/api/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ device_id: '${device_id}', quantity: qty }),
      }).then(function(res) {
        return res.json().then(function(data) {
          if (!res.ok) throw new Error(data.error || 'Checkout failed');
          window.location.href = data.checkout_url;
        });
      }).catch(function(e) {
        errMsg.textContent = e.message;
        btn.disabled       = false;
        updateQty(qty);
      });
    });
  </script>` : ''}
</body>
</html>`);
});

module.exports = router;
