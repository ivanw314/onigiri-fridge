'use strict';
const { Router } = require('express');

const router = Router();

const ITEM_NAME = () => process.env.ITEM_NAME || 'Onigiri';

// GET /thank-you?order_id=xxx
// Square redirects here after a successful payment.
// The page opens an SSE stream to /api/orders/:order_id/status and
// shows "Open the door!" as soon as the device reports unlocked.
router.get('/', (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.redirect('/');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thank you!</title>
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
    h1       { font-size: 1.4rem; font-weight: 700; margin-bottom: 1.5rem; }
    #status  { font-size: 1.1rem; color: #444; min-height: 4rem; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 0.75rem; }
    .open    { color: #1a7a1a; font-weight: 700; font-size: 1.3rem; }
    .done    { color: #555; }
    .err     { color: #c00; }
    /* Spinner */
    .spinner {
      width: 2rem; height: 2rem;
      border: 3px solid #e0e0e0;
      border-top-color: #333;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>Payment received! 🎉</h1>
    <div id="status">
      <div class="spinner"></div>
      <span>Unlocking fridge…</span>
    </div>
  </div>

  <script>
    const ORDER_ID  = "${order_id}";
    const ITEM_NAME = "${ITEM_NAME()}";
    const statusEl  = document.getElementById('status');

    function setStatus(html) {
      statusEl.innerHTML = html;
    }

    function applyStatus(status) {
      switch (status) {
        case 'dispensing':
        case 'unlocked':
          setStatus('<span class="open">🔓 Open the fridge door now!</span>');
          break;
        case 'complete':
          setStatus('<span class="done">Enjoy your ' + ITEM_NAME + '! 🍙</span>');
          break;
        case 'refunded':
          setStatus('<span class="err">Something went wrong &#8212; you&#39;ll be refunded automatically.</span>');
          break;
        // pending / paid: keep spinner
      }
    }

    // ── SSE stream ──────────────────────────────────────────────────────────
    const evtSource = new EventSource('/api/orders/' + ORDER_ID + '/status');

    evtSource.onmessage = (e) => {
      const { status } = JSON.parse(e.data);
      applyStatus(status);
      if (['dispensing', 'unlocked', 'complete', 'refunded'].includes(status)) {
        evtSource.close();
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      // SSE died — fall back to a single poll
      fetch('/api/orders/' + ORDER_ID + '/status/poll')
        .then(r => r.json())
        .then(({ status }) => applyStatus(status))
        .catch(() => {}); // swallow; stale UI is fine here
    };

    // Soft timeout: encourage patience after 30s without a terminal state
    setTimeout(() => {
      if (statusEl.querySelector('.spinner')) {
        setStatus('<span>Taking a little longer than usual… please wait.</span>');
      }
    }, 30_000);
  </script>
</body>
</html>`);
});

module.exports = router;
