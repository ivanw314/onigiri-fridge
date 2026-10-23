'use strict';
const { Router } = require('express');
const {
  publishOTA, publishLock, publishAdminUnlock, publishReboot, publishWifiUpdate, publishWifiReset,
  isDeviceOnline, getDeviceLastSeen, getDeviceWifiInfo,
} = require('../mqttClient');
const { logActivity, getOrderActivity, getRecentActivity } = require('../activityLog');
const {
  getRecentOrders, getOrderStats, getInsights, getOrder, updateOrder, deleteOrder, deleteAllOrders,
  getActiveOrderForDevice, getInProgressOrderForDevice,
} = require('../orderStore');
const {
  getAllItems, getItem, createItem, updateItem, deleteItem, itemHasOrders, adjustStock,
  getCategories, getCategory, createCategory, renameCategory, moveCategory, deleteCategory,
} = require('../itemStore');
const { createRefund } = require('../square');
const { US_TIMEZONES, getSettings, setSetting } = require('../settingsStore');

const DEVICE_ID = () => process.env.DEVICE_ID || 'onigiri';

const router = Router();

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET not configured' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── PWA assets ────────────────────────────────────────────────────────────────

router.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Fridge Admin',
    short_name: 'Fridge',
    start_url: '/admin',
    scope: '/admin',
    display: 'standalone',
    background_color: '#f4f4ef',
    theme_color: '#111111',
    icons: [{ src: '/admin/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  });
});

router.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<rect width="100" height="100" rx="22" fill="#111"/>' +
    '<text x="50" y="70" font-family="system-ui,-apple-system,sans-serif" ' +
    'font-size="56" font-weight="700" text-anchor="middle" fill="#fff">F</text>' +
    '</svg>'
  );
});

// ── HTML page ─────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Fridge Admin</title>
  <meta name="theme-color" content="#111111">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Fridge Admin">
  <link rel="manifest" href="/admin/manifest.json">
  <link rel="apple-touch-icon" href="/admin/icon.svg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f4f4ef; color: #111; min-height: 100dvh; }
    #login     { display: none; align-items: center; justify-content: center; min-height: 100dvh; padding: 1.5rem; }
    /* App shell: header, scrolling content, tab bar stacked to fill the
       screen. Nothing is position: fixed, because iOS Safari shifts fixed
       bars around while its toolbar resizes and during overscroll bounce. */
    #dashboard { display: none; flex-direction: column; height: 100vh; height: 100dvh; }
    #scroller  { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; }
    .wrap { max-width: 480px; margin: 0 auto; }
    .content { padding: 1rem 1rem 1.5rem; }
    .tab { display: flex; flex-direction: column; gap: 1rem; }
    .card { background: #fff; border-radius: 20px; padding: 1.75rem 1.5rem; box-shadow: 0 4px 24px rgba(0,0,0,0.07); }
    #login .card { max-width: 340px; width: 100%; text-align: center; }
    .emoji { font-size: 2.5rem; margin-bottom: 0.75rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1.25rem; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #333; }
    .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .card-head h2 { margin-bottom: 0; }
    .link { color: #555; font-size: 0.85rem; font-weight: 600; text-decoration: none; }
    input, select {
      width: 100%; border: 1.5px solid #e0e0e0; border-radius: 10px;
      padding: 0.75rem; font-size: 0.95rem; margin-bottom: 0.75rem; font-family: inherit;
    }
    select { background: #fff; color: #111; }
    input:focus, select:focus { outline: none; border-color: #999; }
    .field-label { display: block; font-size: 0.85rem; color: #666; margin-bottom: 0.4rem; }
    button {
      background: #111; color: #fff; border: none; border-radius: 12px;
      padding: 0.85rem 1rem; font-size: 0.95rem; font-weight: 600;
      cursor: pointer; width: 100%; transition: opacity 0.15s; font-family: inherit;
      -webkit-tap-highlight-color: transparent;
    }
    button:hover:not(:disabled) { opacity: 0.8; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    button.secondary { background: #fff; color: #111; border: 1.5px solid #e0e0e0; }
    button.secondary:disabled { background: #fff; color: #aaa; border-color: #e0e0e0; }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 0.6rem; }
    .msg { font-size: 0.85rem; margin-top: 0.6rem; }
    .msg:empty { margin-top: 0; }
    .msg.ok  { color: #1a7a1a; }
    .msg.err { color: #c00; }
    .empty { color: #999; font-size: 0.85rem; }
    .hint { font-size: 0.78rem; color: #999; margin-bottom: 0.6rem; }
    .num { color: #666; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .status-main { font-weight: 600; font-size: 0.95rem; }
    .status-sub  { font-size: 0.78rem; color: #999; margin-top: 0.15rem; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ccc; flex-shrink: 0; }
    .dot.online  { background: #1a7a1a; }
    .dot.offline { background: #c00; }
    .icon-btn {
      background: #fff; color: #111; border: 1.5px solid #e0e0e0; border-radius: 10px;
      width: 2.1rem; height: 2.1rem; padding: 0; font-size: 1rem; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s; flex-shrink: 0;
    }
    .icon-btn:hover { opacity: 0.7; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { animation: spin 0.5s linear; }
    .sm-btn {
      width: auto; padding: 0.5rem 0.8rem; font-size: 0.8rem; border-radius: 8px; font-weight: 600;
      background: #fff; color: #111; border: 1px solid #e0e0e0;
    }
    .sm-btn:hover:not(:disabled)         { opacity: 1; background: #f5f5f5; }
    .sm-btn:disabled                     { background: #fff; color: #ccc; border-color: #eee; }
    .sm-btn.primary                      { background: #111; color: #fff; border-color: #111; }
    .sm-btn.primary:hover:not(:disabled) { background: #111; opacity: 0.8; }
    .sm-btn.primary:disabled             { background: #ccc; border-color: #ccc; color: #fff; }
    .sm-btn.danger                       { color: #c00; border-color: #f5c0c0; }
    .sm-btn.danger:hover:not(:disabled)  { background: #fef0f0; }
    .sm-btn.good                         { color: #1a7a1a; border-color: #bfe3bf; }
    .sm-btn.good:hover:not(:disabled)    { background: #eef8ee; }
    .kv { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; font-size: 0.85rem; }
    .kv dt { color: #999; }
    .kv dd { min-width: 0; overflow-wrap: anywhere; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.74rem; }

    /* Header (every tab) and bottom tab bar */
    .topbar {
      flex-shrink: 0; background: #f4f4ef;
      border-bottom: 1px solid #e6e6df; padding: calc(env(safe-area-inset-top) + 0.6rem) 1rem 0.6rem;
    }
    .topbar-inner { display: flex; align-items: center; gap: 0.6rem; }
    .topbar-text  { flex: 1; min-width: 0; }
    .tabbar { flex-shrink: 0; background: #fff; border-top: 1px solid #e6e6df; padding-bottom: env(safe-area-inset-bottom); }
    .tabbar-inner { display: grid; grid-template-columns: repeat(5, 1fr); }
    .tab-btn {
      position: relative; background: none; color: #999; border-radius: 0;
      padding: 0.55rem 0 0.5rem; display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
      font-size: 0.68rem; font-weight: 600;
    }
    .tab-btn svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .tab-btn.active, .tab-btn:hover:not(:disabled) { color: #111; opacity: 1; }
    .tab-dot {
      position: absolute; top: 0.4rem; left: calc(50% + 7px); width: 8px; height: 8px;
      border-radius: 50%; background: #c00; border: 2px solid #fff; box-sizing: content-box;
    }

    /* Home: sales */
    .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
    .hero-num   { font-size: 2.2rem; font-weight: 700; line-height: 1; letter-spacing: -0.01em; }
    .hero-side  { text-align: right; }
    .stat-num   { font-size: 1.4rem; font-weight: 700; line-height: 1; }
    .stat-label { font-size: 0.72rem; color: #999; margin-top: 0.3rem; text-transform: uppercase; letter-spacing: 0.03em; }
    .week-readout { font-size: 0.8rem; color: #666; margin-bottom: 0.5rem; min-height: 1.2em; }
    .week { display: grid; gap: 2px; }
    .wk-col {
      background: none; color: #999; padding: 0; border-radius: 6px;
      display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
      font-size: 0.68rem; font-weight: 500;
    }
    .wk-col:hover:not(:disabled) { opacity: 1; }
    .wk-plot { width: 100%; height: 72px; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px solid #e6e6df; }
    .wk-bar  { width: 100%; max-width: 24px; background: #94948c; border-radius: 4px 4px 0 0; }
    .wk-col.hl .wk-bar { background: #111; }
    .wk-col.sel { color: #111; font-weight: 700; }
    .wk-col.sel:not(.hl) .wk-bar { background: #4f4f4a; }
    .wk-label { white-space: nowrap; }
    .by-item { list-style: none; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid #f0f0f0; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.85rem; }
    .by-item li { display: flex; justify-content: space-between; gap: 1rem; }
    .all-time { margin-top: 0.75rem; }

    /* Home: restock */
    .restock-row {
      display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
      background: none; color: #111; border-radius: 0; padding: 0.6rem 0; border-top: 1px solid #f0f0f0;
      font-weight: 500; font-size: 0.9rem; text-align: left;
    }
    .restock-row:first-child { border-top: none; padding-top: 0; }
    .restock-left     { font-size: 0.8rem; font-weight: 600; color: #b45309; white-space: nowrap; }
    .restock-left.oos { color: #c00; }

    /* Insights */
    .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.1rem 0.75rem; }
    .tile-num { font-size: 1.2rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    #insAbandoned:not(:empty) { margin: 1rem 0 0; }
    .chart-heading { margin-top: 1.5rem; }
    .top-list { list-style: none; display: flex; flex-direction: column; gap: 0.8rem; font-size: 0.88rem; }
    .top-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; }
    .top-rank { display: inline-block; min-width: 1rem; color: #999; font-weight: 600; }
    .share { height: 6px; margin-top: 0.35rem; background: #f0f0eb; border-radius: 4px; overflow: hidden; }
    .share span { display: block; height: 100%; background: #94948c; border-radius: 0 4px 4px 0; }
    .share.first span { background: #111; }
    #pairsBox { margin-top: 1.5rem; }
    #pairsBox .by-item { margin-top: 0; padding-top: 0; border-top: none; }
    .fc-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid #f0f0f0; }
    .fc-row:first-child { border-top: none; padding-top: 0; }
    .fc-name { font-weight: 600; font-size: 0.9rem; }
    .fc-eta { font-size: 0.82rem; font-weight: 600; white-space: nowrap; }
    .fc-eta.low   { color: #b45309; }
    .fc-eta.oos   { color: #c00; }
    .fc-eta.muted { color: #999; font-weight: 500; }

    /* Orders */
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }
    .chip {
      width: auto; background: #fff; color: #555; border: 1.5px solid #e0e0e0; border-radius: 999px;
      padding: 0.35rem 0.8rem; font-size: 0.8rem; font-weight: 600;
    }
    .chip.active { background: #111; color: #fff; border-color: #111; }
    .order { border-top: 1px solid #f0f0f0; }
    .order:first-child { border-top: none; }
    .order-toggle {
      display: block; width: 100%; background: none; color: inherit; border-radius: 0;
      padding: 0.7rem 0; text-align: left; font-weight: 400; font-size: inherit;
    }
    .order-top   { display: flex; align-items: center; gap: 0.5rem; }
    .order-total { font-weight: 700; font-size: 0.95rem; font-variant-numeric: tabular-nums; }
    .order-time  { margin-left: auto; color: #999; font-size: 0.78rem; white-space: nowrap; }
    .order-chev  { color: #bbb; font-size: 1rem; line-height: 1; transition: transform 0.15s; }
    .order.open .order-chev { transform: rotate(90deg); }
    .order-items { display: block; margin-top: 0.25rem; font-size: 0.83rem; color: #555; }
    .order-details { padding: 0 0 0.9rem; font-size: 0.83rem; }
    .order-lines { list-style: none; display: flex; flex-direction: column; gap: 0.2rem; margin-bottom: 0.75rem; }
    .order-lines li { display: flex; justify-content: space-between; gap: 1rem; }
    .order-lines .tax { color: #999; }
    .order-actions { display: flex; gap: 0.5rem; margin-top: 0.85rem; }
    .timeline-head { color: #999; margin: 0.85rem 0 0.4rem; }
    .timeline { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
    .timeline li { display: flex; align-items: flex-start; gap: 0.5rem; }
    .timeline .event-dot { margin-top: 0.4em; }
    .badge {
      display: inline-block; padding: 0.15rem 0.55rem;
      border-radius: 6px; font-size: 0.75rem; font-weight: 600; white-space: nowrap;
    }
    .badge.complete   { background: #e6f4e6; color: #1a7a1a; }
    .badge.dispensing,
    .badge.paid       { background: #e8f0fe; color: #1a5cbf; }
    .badge.pending,
    .badge.cancelled  { background: #f5f5f5; color: #666; }
    .badge.timed_out,
    .badge.refunded   { background: #fde8e8; color: #c00; }
    #loadMoreBtn { margin-top: 0.75rem; }

    /* Items */
    .item-group + .item-group { margin-top: 1.5rem; }
    .item-group-heading {
      font-size: 0.72rem; font-weight: 700; color: #999; margin-bottom: 0.6rem;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .item-row { border-top: 1px solid #f0f0f0; padding: 0.65rem 0; }
    .item-row:first-child, .item-group-heading + .item-row { border-top: none; padding-top: 0; }
    .item-row.item-inactive .item-head { opacity: 0.55; }
    @keyframes flash { from { background: #fff1c7; } to { background: transparent; } }
    .item-row.flash { animation: flash 1.6s ease-out; }
    .item-head  { display: flex; align-items: center; gap: 0.6rem; }
    .item-info  { flex: 1; min-width: 0; }
    .item-name  { font-weight: 600; font-size: 0.92rem; overflow-wrap: anywhere; }
    .item-price { font-size: 0.8rem; color: #888; margin-top: 0.1rem; }
    .item-badge { font-size: 0.72rem; font-weight: 500; color: #999; margin-left: 0.4rem; }
    .item-badge.oos { color: #c00; }
    .stepper  { display: flex; align-items: center; border: 1.5px solid #e0e0e0; border-radius: 10px; flex-shrink: 0; }
    .step-btn { width: 2.5rem; height: 2.5rem; padding: 0; background: none; color: #111; border-radius: 8px; font-size: 1.2rem; font-weight: 500; }
    .step-btn:disabled { background: none; color: #ccc; }
    .step-val { min-width: 2rem; text-align: center; font-weight: 700; font-size: 0.95rem; font-variant-numeric: tabular-nums; }
    .item-edit { margin-top: 0.75rem; padding: 0.85rem; background: #fafaf7; border-radius: 12px; }
    .mini-label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 0.6rem; }
    .mini-label input, .mini-label select { margin: 0.25rem 0 0; padding: 0.55rem; font-size: 0.9rem; }
    .item-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.25rem; }
    .item-actions .push { margin-left: auto; }
    .add-item-form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #f0f0f0; }
    .cat-row { display: flex; gap: 0.4rem; align-items: center; padding: 0.5rem 0; border-top: 1px solid #f0f0f0; }
    .cat-row:first-child { border-top: none; padding-top: 0; }
    .cat-row input { flex: 1 1 auto; min-width: 0; margin-bottom: 0; padding: 0.5rem; font-size: 0.85rem; }
    .cat-move-btn { padding: 0.5rem 0.6rem; }

    /* Device */
    .event-list { list-style: none; display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
    .event-item { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.4rem 0; border-top: 1px solid #f0f0f0; font-size: 0.83rem; }
    .event-item:first-child { border-top: none; }
    .event-item .event-dot { margin-top: 0.4em; }
    .event-dot  { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .event-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .event-meta { display: block; color: #aaa; font-size: 0.75rem; margin-top: 0.1rem; }
    .card.danger { border: 1.5px solid #f5c0c0; }
    .card.danger h2 { color: #c00; }
    .danger-item + .danger-item { border-top: 1px solid #f7e0e0; margin-top: 1rem; padding-top: 1rem; }
    .danger-btn { background: #fff; color: #c00; border: 1.5px solid #f5c0c0; }
    .danger-btn:hover:not(:disabled) { opacity: 1; background: #fef0f0; }
    .danger-btn:disabled { background: #fff; color: #e0a0a0; }
  </style>
</head>
<body>

<div id="login">
  <div class="card">
    <div class="emoji">&#x1F512;</div>
    <h1>Fridge Admin</h1>
    <input type="password" id="passInput" placeholder="Admin password" autocomplete="current-password">
    <button id="loginBtn">Sign in</button>
    <p class="msg err" id="loginErr"></p>
  </div>
</div>

<div id="dashboard">
  <header class="topbar">
    <div class="wrap topbar-inner">
      <span class="dot" id="dot"></span>
      <div class="topbar-text">
        <div class="status-main" id="statusText">Checking&#x2026;</div>
        <div class="status-sub"  id="lastSeenText"></div>
      </div>
      <button class="icon-btn" id="refreshBtn" title="Refresh" aria-label="Refresh">&#x21BB;</button>
    </div>
  </header>

  <main id="scroller">
  <div class="wrap content">

    <section class="tab" data-tab="home" hidden>
      <div class="card">
        <div class="card-head">
          <h2>Sales</h2>
          <a class="link" href="#insights">Insights &#x2192;</a>
        </div>
        <div class="hero">
          <div>
            <div class="hero-num" id="statTodayRev">&#x2014;</div>
            <div class="stat-label">Revenue today</div>
          </div>
          <div class="hero-side">
            <div class="stat-num" id="statTodayCount">&#x2014;</div>
            <div class="stat-label">Sold today</div>
          </div>
        </div>
        <p class="week-readout" id="weekReadout"></p>
        <div class="week" id="weekChart"></div>
        <ul class="by-item" id="todayByItem"></ul>
        <p class="status-sub all-time" id="statAllTime"></p>
      </div>

      <div class="card">
        <h2>Door</h2>
        <div class="btn-row">
          <button id="unlockBtn">&#x1F513; Unlock</button>
          <button id="lockBtn" class="secondary">&#x1F512; Lock</button>
        </div>
        <p class="msg" id="controlMsg"></p>
      </div>

      <div class="card" id="restockCard" hidden>
        <h2>Needs restock</h2>
        <div id="restockList"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Latest orders</h2>
          <a class="link" href="#orders">See all &#x2192;</a>
        </div>
        <div id="latestOrders"><p class="empty">Loading&#x2026;</p></div>
      </div>
    </section>

    <section class="tab" data-tab="items" hidden>
      <div class="card">
        <h2>Items</h2>
        <div id="itemsList"><p class="empty">Loading&#x2026;</p></div>
        <div class="add-item-form">
          <h3 class="item-group-heading">Add an item</h3>
          <input type="text" id="newItemName" placeholder="Item name">
          <div class="two-col">
            <input type="number" id="newItemPrice" step="0.01" min="0.01" inputmode="decimal" placeholder="Price ($)">
            <input type="number" id="newItemStock" step="1" min="0" inputmode="numeric" placeholder="Initial stock">
          </div>
          <select id="newItemCategory"><option value="">No category</option></select>
          <button id="addItemBtn">Add item</button>
          <p class="msg" id="addItemMsg"></p>
        </div>
      </div>

      <div class="card">
        <h2>Categories</h2>
        <p class="status-sub" style="margin:-0.5rem 0 1rem">Sections on the buy page, shown in this order. Items without a category go last, under &ldquo;Other&rdquo;.</p>
        <div id="categoriesList"><p class="empty">Loading&#x2026;</p></div>
        <div class="add-item-form">
          <input type="text" id="newCategoryName" placeholder="Category name, e.g. Drinks">
          <button id="addCategoryBtn">Add category</button>
          <p class="msg" id="addCategoryMsg"></p>
        </div>
      </div>
    </section>

    <section class="tab" data-tab="orders" hidden>
      <div class="card">
        <h2>Orders</h2>
        <div class="chips" id="orderFilters" role="group" aria-label="Filter orders">
          <button class="chip active" data-status="" aria-pressed="true">All</button>
          <button class="chip" data-status="complete" aria-pressed="false">Completed</button>
          <button class="chip" data-status="pending,paid,dispensing" aria-pressed="false">In progress</button>
          <button class="chip" data-status="refunded,timed_out" aria-pressed="false">Refunded / timed out</button>
        </div>
        <div id="ordersList"><p class="empty">Loading&#x2026;</p></div>
        <button class="secondary" id="loadMoreBtn" hidden>Load more</button>
      </div>
    </section>

    <section class="tab" data-tab="insights" hidden>
      <div class="chips" id="rangeChips" role="group" aria-label="Time range">
        <button class="chip" data-range="7" aria-pressed="false">7 days</button>
        <button class="chip" data-range="30" aria-pressed="false">30 days</button>
        <button class="chip" data-range="all" aria-pressed="false">All time</button>
      </div>

      <div class="card">
        <h2>Summary</h2>
        <div class="tiles" id="insSummary"></div>
        <p class="hint" id="insAbandoned"></p>
      </div>

      <div class="card">
        <h2>Busiest times</h2>
        <h3 class="item-group-heading">Time of day</h3>
        <p class="week-readout" id="hourReadout"></p>
        <div class="week" id="hourChart"></div>
        <h3 class="item-group-heading chart-heading">Day of week</h3>
        <p class="week-readout" id="dowReadout"></p>
        <div class="week" id="dowChart"></div>
      </div>

      <div class="card">
        <h2>Top items</h2>
        <ol class="top-list" id="topItems"><li class="empty">Loading&#x2026;</li></ol>
        <div id="pairsBox" hidden>
          <h3 class="item-group-heading">Often bought together</h3>
          <ul class="by-item" id="pairs"></ul>
        </div>
      </div>

      <div class="card">
        <h2>Restock forecast</h2>
        <p class="hint" id="forecastHint"></p>
        <div id="forecast"><p class="empty">Loading&#x2026;</p></div>
      </div>
    </section>

    <section class="tab" data-tab="device" hidden>
      <div class="card">
        <h2>Device</h2>
        <dl class="kv">
          <dt>Status</dt>    <dd id="infoStatus">&#x2014;</dd>
          <dt>Last seen</dt> <dd id="infoLastSeen">&#x2014;</dd>
          <dt>Network</dt>   <dd id="infoNetwork">&#x2014;</dd>
          <dt>Signal</dt>    <dd id="infoSignal">&#x2014;</dd>
          <dt>Firmware</dt>  <dd id="infoFirmware">&#x2014;</dd>
        </dl>
      </div>

      <div class="card">
        <h2>Change WiFi network</h2>
        <input type="text"     id="wifiSsid" placeholder="Network name (SSID)" autocomplete="off">
        <input type="password" id="wifiPass" placeholder="Password" autocomplete="new-password">
        <button id="wifiBtn">Update WiFi</button>
        <p class="msg" id="wifiMsg"></p>
      </div>

      <div class="card">
        <h2>Firmware update</h2>
        <input type="url" id="otaUrl" placeholder="https://github.com/.../firmware.bin">
        <button id="otaBtn">Push Update</button>
        <p class="msg" id="otaMsg"></p>
      </div>

      <div class="card">
        <h2>Store time zone</h2>
        <label class="field-label" for="tzSelect">When &ldquo;Today&rdquo; starts for sales stats</label>
        <select id="tzSelect"></select>
        <p class="status-sub" id="tzNow" style="margin:-0.35rem 0 0.75rem"></p>
        <button id="settingsBtn">Save</button>
        <p class="msg" id="settingsMsg"></p>
      </div>

      <div class="card">
        <h2>Activity</h2>
        <div id="eventLog"><p class="empty">No events yet.</p></div>
      </div>

      <div class="card danger">
        <h2>Danger zone</h2>
        <div class="danger-item">
          <button class="danger-btn" id="rebootBtn">&#x1F504; Reboot device</button>
          <p class="msg" id="rebootMsg"></p>
        </div>
        <div class="danger-item">
          <p class="hint">Erases the saved WiFi and reboots into the &ldquo;FridgeSetup&rdquo; hotspot. The fridge stays offline until it&rsquo;s set up again.</p>
          <button class="danger-btn" id="wifiResetBtn">&#x26A0;&#xFE0F; Reset WiFi &amp; enter setup mode</button>
          <p class="msg" id="wifiResetMsg"></p>
        </div>
        <div class="danger-item">
          <p class="hint">Deletes every order, including the history the sales stats are based on.</p>
          <button class="danger-btn" id="clearOrdersBtn">Clear all orders</button>
          <p class="msg" id="clearOrdersMsg"></p>
        </div>
      </div>

      <button class="secondary" id="logoutBtn">Sign out</button>
    </section>

  </div>
  </main>

  <nav class="tabbar" aria-label="Sections">
    <div class="wrap tabbar-inner">
      <button class="tab-btn" data-tab="home">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>
        Home
      </button>
      <button class="tab-btn" data-tab="items">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>
        Items
        <span class="tab-dot" id="itemsTabDot" title="Something is out of stock" hidden></span>
      </button>
      <button class="tab-btn" data-tab="orders">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>
        Orders
      </button>
      <button class="tab-btn" data-tab="insights">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18"/><path d="M6 17v-5"/><path d="M11 17V7"/><path d="M16 17v-8"/><path d="M21 17V4"/></svg>
        Insights
      </button>
      <button class="tab-btn" data-tab="device">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>
        Device
      </button>
    </div>
  </nav>
</div>

<script>
  var token    = localStorage.getItem('adminToken');
  var DEVICEID = '${DEVICE_ID()}';

  var TABS       = ['home', 'items', 'orders', 'insights', 'device'];
  var LOW_STOCK  = 3;   // Home's "Needs restock" lists active items at or below this
  var ORDER_PAGE = 20;

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function(r) {
      if (r.status === 401) { doLogout(); throw new Error('Wrong password.'); }
      return r.json().then(function(data) {
        if (!r.ok) {
          var err = new Error(data.error || 'Request failed');
          err.status = r.status;
          err.data   = data;
          throw err;
        }
        return data;
      });
    });
  }

  var loginEl     = document.getElementById('login');
  var dashboardEl = document.getElementById('dashboard');
  var passInput   = document.getElementById('passInput');
  var loginBtn    = document.getElementById('loginBtn');
  var loginErr    = document.getElementById('loginErr');

  loginBtn.addEventListener('click', tryLogin);
  passInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryLogin(); });

  function tryLogin() {
    loginErr.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    token = passInput.value;
    api('GET', '/admin/status').then(function() {
      localStorage.setItem('adminToken', token);
      showDashboard();
    }).catch(function(e) {
      loginErr.textContent = e.message;
      token = null;
    }).finally(function() {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
    });
  }

  function doLogout() {
    stopPolling();
    dashboardOn = false;
    localStorage.removeItem('adminToken');
    token = null;
    loginEl.style.display = 'flex';
    dashboardEl.style.display = 'none';
    passInput.value = '';
  }
  document.getElementById('logoutBtn').addEventListener('click', doLogout);

  // ── Tabs & polling ──────────────────────────────────────────────────────────
  // Only the visible tab polls, and nothing polls while the app is in the
  // background. The header's status line shows on every tab, so it always does.

  var TAB_REFRESH = {
    home:     { every: 30000, run: function() { refreshStats(); refreshItems(); refreshLatestOrders(); } },
    items:    { every: 30000, run: function() { refreshCategories(); refreshItems(); } },
    orders:   { every: 30000, run: function() { refreshOrders(); } },
    insights: { every: 60000, run: function() { refreshInsights(); } },
    device:   { every: 10000, run: function() { refreshEvents(); showStoreTime(); } },
  };

  var dashboardOn = false;
  var activeTab   = null;
  var statusTimer = null;
  var tabTimer    = null;
  var tabSections = document.querySelectorAll('.tab');
  var tabButtons  = document.querySelectorAll('.tab-btn');
  var scroller    = document.getElementById('scroller');   // the only part of the page that scrolls

  function startPolling() {
    stopPolling();
    statusTimer = setInterval(refreshStatus, 15000);
    tabTimer    = setInterval(TAB_REFRESH[activeTab].run, TAB_REFRESH[activeTab].every);
  }

  function stopPolling() {
    clearInterval(statusTimer);
    clearInterval(tabTimer);
    statusTimer = tabTimer = null;
  }

  function showTab(name) {
    if (TABS.indexOf(name) === -1) name = 'home';
    activeTab = name;
    tabSections.forEach(function(s) { s.hidden = s.getAttribute('data-tab') !== name; });
    tabButtons.forEach(function(b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    try { localStorage.setItem('adminTab', name); } catch (e) {}
    scroller.scrollTop = 0;
    TAB_REFRESH[name].run();
    if (!document.hidden) startPolling();
  }

  tabButtons.forEach(function(b) {
    b.addEventListener('click', function() {
      var name = b.getAttribute('data-tab');
      if (name === activeTab) { scroller.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      location.hash = name;
    });
  });

  // The hash drives the tab, so the back button steps back through tabs.
  window.addEventListener('hashchange', function() {
    if (dashboardOn) showTab(location.hash.slice(1));
  });

  document.addEventListener('visibilitychange', function() {
    if (!dashboardOn) return;
    if (document.hidden) { stopPolling(); return; }
    refreshStatus();
    TAB_REFRESH[activeTab].run();
    startPolling();
  });

  document.getElementById('refreshBtn').addEventListener('click', function() {
    var icon = this;
    icon.classList.remove('spinning');
    void icon.offsetWidth; // force reflow to restart animation
    icon.classList.add('spinning');
    icon.addEventListener('animationend', function() { icon.classList.remove('spinning'); }, { once: true });
    refreshStatus();
    TAB_REFRESH[activeTab].run();
  });

  function showDashboard() {
    loginEl.style.display = 'none';
    dashboardEl.style.display = 'flex';
    dashboardOn = true;
    refreshStatus();
    loadSettings();
    refreshCategories();
    // A home-screen PWA always opens at /admin with no hash, so fall back to
    // the last tab used.
    var saved = null;
    try { saved = localStorage.getItem('adminTab'); } catch (e) {}
    var tab = location.hash.slice(1);
    if (TABS.indexOf(tab) === -1) tab = TABS.indexOf(saved) !== -1 ? saved : 'home';
    history.replaceState(null, '', '#' + tab);
    showTab(tab);
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  function refreshStatus() {
    api('GET', '/admin/status').then(function(d) {
      document.getElementById('dot').className          = 'dot ' + (d.online ? 'online' : 'offline');
      document.getElementById('statusText').textContent   = (d.online ? 'Online' : 'Offline') + ' — ' + DEVICEID;
      document.getElementById('lastSeenText').textContent = d.lastSeen ? 'Last seen ' + timeAgo(d.lastSeen) : '';
      document.getElementById('infoStatus').textContent   = d.online ? 'Online' : 'Offline';
      document.getElementById('infoLastSeen').textContent = d.lastSeen ? timeAgo(d.lastSeen) : '—';
      var w = d.wifi || {};
      var signal = '—';
      if (w.ssid) {
        var qual = w.rssi >= -55 ? 'Excellent' : w.rssi >= -65 ? 'Good' : w.rssi >= -75 ? 'Fair' : 'Weak';
        signal = qual + ' (' + w.rssi + ' dBm)';
      }
      document.getElementById('infoNetwork').textContent  = w.ssid || '—';
      document.getElementById('infoSignal').textContent   = signal;
      document.getElementById('infoFirmware').textContent = w.version ? 'v' + w.version : '—';
    }).catch(function() {});
  }

  // ── Charts ──────────────────────────────────────────────────────────────────

  // Small single-series column chart; the tallest bar fills the plot.
  // bars: [{ value, label, strong, readout }]. Tapping, hovering or focusing
  // a bar puts its readout in the line above the chart; otherwise that line
  // shows the chart's summary.
  function barChart(el, readoutEl) {
    var chart = { bars: [], summary: '', sel: null };

    function showReadout() {
      readoutEl.textContent = chart.sel === null ? chart.summary : chart.bars[chart.sel].readout;
    }

    chart.render = function(bars, summary) {
      chart.bars    = bars;
      chart.summary = summary;
      if (chart.sel !== null && chart.sel >= bars.length) chart.sel = null;
      var max = bars.reduce(function(m, b) { return Math.max(m, b.value); }, 0);
      el.style.gridTemplateColumns = 'repeat(' + Math.max(bars.length, 1) + ', 1fr)';
      el.innerHTML = bars.map(function(b, i) {
        var height = b.value ? 'max(3px,' + (b.value / max * 100).toFixed(1) + '%)' : '0';
        return '<button class="wk-col' + (b.strong ? ' hl' : '') + (i === chart.sel ? ' sel' : '') + '" data-i="' + i + '"' +
          ' aria-label="' + escapeAttr(b.readout) + '">' +
          '<span class="wk-plot"><span class="wk-bar" style="height:' + height + '"></span></span>' +
          '<span class="wk-label">' + (b.label || '&nbsp;') + '</span>' +
        '</button>';
      }).join('');
      showReadout();
    };

    chart.select = function(i) {
      if (i === chart.sel) return;
      chart.sel = i;
      el.querySelectorAll('.wk-col').forEach(function(c, j) { c.classList.toggle('sel', j === i); });
      showReadout();
    };

    function barIndex(e) {
      var col = e.target.closest('.wk-col');
      return col ? parseInt(col.getAttribute('data-i'), 10) : null;
    }

    el.addEventListener('pointerover', function(e) {
      if (e.pointerType === 'mouse' && barIndex(e) !== null) chart.select(barIndex(e));
    });
    el.addEventListener('pointerleave', function(e) { if (e.pointerType === 'mouse') chart.select(null); });
    el.addEventListener('click', function(e) { if (barIndex(e) !== null) chart.select(barIndex(e)); });
    el.addEventListener('focusin', function(e) { if (barIndex(e) !== null) chart.select(barIndex(e)); });
    el.addEventListener('focusout', function(e) { if (!el.contains(e.relatedTarget)) chart.select(null); });

    return chart;
  }

  // ── Sales ───────────────────────────────────────────────────────────────────

  var weekChart = barChart(document.getElementById('weekChart'), document.getElementById('weekReadout'));

  function refreshStats() {
    api('GET', '/admin/stats').then(function(s) {
      document.getElementById('statTodayRev').textContent   = money(s.todayRevenueCents);
      document.getElementById('statTodayCount').textContent = s.todayCount;
      document.getElementById('statAllTime').textContent    = 'All time: ' + money(s.totalRevenueCents) + ' · ' + s.totalCount + ' sold';
      renderWeek(s.last7Days || []);
      renderTodayByItem(s.todayByItem || []);
    }).catch(function() {});
  }

  // Noon, so the local weekday can never shift a day either way.
  function dayDate(day) { return new Date(day + 'T12:00:00'); }

  function renderWeek(days) {
    var last = days.length - 1;
    var rev = 0, sold = 0;
    days.forEach(function(d) { rev += d.revenue_cents; sold += d.count; });
    weekChart.render(days.map(function(d, i) {
      var name = i === last ? 'Today' : dayDate(d.day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return {
        value:   d.revenue_cents,
        strong:  i === last,
        label:   i === last ? 'Today' : dayDate(d.day).toLocaleDateString('en-US', { weekday: 'short' }),
        readout: name + ': ' + money(d.revenue_cents) + ' · ' + d.count + ' sold',
      };
    }), days.length ? 'Last 7 days: ' + money(rev) + ' · ' + sold + ' sold' : '');
  }

  function renderTodayByItem(rows) {
    document.getElementById('todayByItem').innerHTML = rows.length
      ? rows.map(function(r) {
          return '<li><span>' + r.quantity + '&times; ' + escapeAttr(r.item_name) + '</span><span class="num">' + money(r.revenue_cents) + '</span></li>';
        }).join('')
      : '<li class="empty">No sales yet today.</li>';
  }

  // ── Insights ────────────────────────────────────────────────────────────────

  var RANGES       = ['7', '30', 'all'];
  var DOW_SHORT    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var DOW_PLURAL   = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  var hourChart    = barChart(document.getElementById('hourChart'), document.getElementById('hourReadout'));
  var dowChart     = barChart(document.getElementById('dowChart'), document.getElementById('dowReadout'));
  var insightsReq  = 0;
  var insightsRange = '30';
  try { insightsRange = localStorage.getItem('insightsRange') || '30'; } catch (e) {}
  if (RANGES.indexOf(insightsRange) === -1) insightsRange = '30';

  function markRange() {
    document.querySelectorAll('#rangeChips .chip').forEach(function(c) {
      var on = c.getAttribute('data-range') === insightsRange;
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  markRange();

  document.getElementById('rangeChips').addEventListener('click', function(e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    insightsRange = chip.getAttribute('data-range');
    try { localStorage.setItem('insightsRange', insightsRange); } catch (err) {}
    markRange();
    refreshInsights();
  });

  function refreshInsights() {
    var req = ++insightsReq;
    api('GET', '/admin/insights?range=' + insightsRange).then(function(ins) {
      if (req !== insightsReq) return;
      renderSummary(ins.summary);
      renderHours(ins.byHour, ins.range.days_counted);
      renderWeekdays(ins.byWeekday);
      renderTopItems(ins.topItems, ins.summary.items, ins.pairs);
      renderForecast(ins.forecast);
    }).catch(function() {});
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function hour12(h)   { h = h % 24; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }
  function hourSpan(h) { return hour12(h) + '–' + hour12(h + 1); }
  function hourTick(h) { return (h % 12 || 12) + (h < 12 ? 'a' : 'p'); }

  function renderSummary(s) {
    function tile(value, label) {
      return '<div class="tile"><div class="tile-num">' + value + '</div><div class="stat-label">' + label + '</div></div>';
    }
    document.getElementById('insSummary').innerHTML =
      tile(money(s.revenue_cents), 'Revenue') +
      tile(s.orders, 'Orders') +
      tile(s.items, 'Items sold') +
      tile(s.orders ? money(s.avg_order_cents) : '—', 'Avg order') +
      tile(s.orders ? s.items_per_order.toFixed(1) : '—', 'Items / order') +
      tile(s.orders || s.refunded ? Math.round(s.refund_rate * 100) + '%' : '—', 'Refunded (' + s.refunded + ')');
    document.getElementById('insAbandoned').textContent = s.abandoned
      ? plural(s.abandoned, 'checkout') + ' started but never paid.'
      : '';
  }

  // Bars cover just the hours that had sales (at least 6 wide), so a fridge
  // that only sells at lunch and dinner isn't squeezed into 24 slivers.
  function renderHours(hours, days) {
    var active = hours.filter(function(h) { return h.orders > 0; });
    if (!active.length) { hourChart.render([], 'No sales in this range yet.'); return; }
    var lo = active[0].hour;
    var hi = active[active.length - 1].hour;
    while (hi - lo < 5) {
      if (hi < 23) hi++;
      if (hi - lo < 5 && lo > 0) lo--;
    }
    var peak = active.reduce(function(p, h) { return h.orders > p.orders ? h : p; });
    var span = hours.slice(lo, hi + 1);
    function perDay(n) { return days ? (n / days).toFixed(1) : '0'; }
    hourChart.render(span.map(function(h) {
      return {
        value:   h.orders,
        strong:  h.hour === peak.hour,
        label:   span.length <= 8 || h.hour % 3 === 0 ? hourTick(h.hour) : '',
        readout: hourSpan(h.hour) + ': ' + plural(h.orders, 'order') + ' (' + perDay(h.orders) + ' a day)',
      };
    }), 'Busiest: ' + hourSpan(peak.hour) + ', ' + perDay(peak.orders) + ' orders a day');
  }

  // Averaged per occurrence of each weekday, since a 30-day range has more
  // of some weekdays than others.
  function renderWeekdays(rows) {
    var avg  = rows.map(function(d) { return d.days ? d.orders / d.days : 0; });
    var peak = avg.reduce(function(p, v, i) { return v > avg[p] ? i : p; }, 0);
    if (!avg[peak]) { dowChart.render([], 'No sales in this range yet.'); return; }
    dowChart.render(rows.map(function(d, i) {
      return {
        value:   avg[i],
        strong:  i === peak,
        label:   DOW_SHORT[i],
        readout: DOW_PLURAL[i] + ': ' + avg[i].toFixed(1) + ' orders on average (' + d.orders + ' total)',
      };
    }), 'Busiest: ' + DOW_PLURAL[peak] + ', ' + avg[peak].toFixed(1) + ' orders on average');
  }

  function renderTopItems(rows, totalItems, pairs) {
    document.getElementById('topItems').innerHTML = rows.length
      ? rows.map(function(r, i) {
          var share = totalItems ? r.quantity / totalItems * 100 : 0;
          return '<li class="top-row">' +
            '<div class="top-head">' +
              '<span><span class="top-rank">' + (i + 1) + '</span> ' + escapeAttr(r.item_name) + '</span>' +
              '<span class="num">' + r.quantity + ' sold · ' + Math.round(share) + '% · ' + money(r.revenue_cents) + '</span>' +
            '</div>' +
            '<div class="share' + (i === 0 ? ' first' : '') + '"><span style="width:' + share.toFixed(1) + '%"></span></div>' +
          '</li>';
        }).join('')
      : '<li class="empty">No sales in this range yet.</li>';
    document.getElementById('pairsBox').hidden = !pairs.length;
    document.getElementById('pairs').innerHTML = pairs.map(function(p) {
      return '<li><span>' + escapeAttr(p.a) + ' + ' + escapeAttr(p.b) + '</span><span class="num">' + plural(p.orders, 'order') + '</span></li>';
    }).join('');
  }

  function renderForecast(f) {
    document.getElementById('forecastHint').textContent =
      'Based on sales over the last ' + plural(f.window_days, 'day') + ', whatever range is picked above.';
    // Soonest to run out first; items with no recent sales last.
    var rows = f.items.slice().sort(function(a, b) {
      var da = a.stock <= 0 ? -1 : a.days_left === null ? Infinity : a.days_left;
      var db = b.stock <= 0 ? -1 : b.days_left === null ? Infinity : b.days_left;
      return da - db || a.name.localeCompare(b.name);
    });
    document.getElementById('forecast').innerHTML = rows.length ? rows.map(function(it) {
      var eta, cls = '';
      if (it.stock <= 0)               { eta = 'Out of stock'; cls = ' oos'; }
      else if (it.days_left === null)  { eta = 'No recent sales'; cls = ' muted'; }
      else if (it.days_left > 30)      { eta = '30+ days'; }
      else if (it.days_left < 1)       { eta = 'Under a day'; cls = ' low'; }
      else {
        var d = Math.round(it.days_left);
        eta = '~' + plural(d, 'day');
        if (it.days_left <= 2) cls = ' low';
      }
      return '<div class="fc-row">' +
        '<div><div class="fc-name">' + escapeAttr(it.name) + '</div>' +
        '<div class="item-price">' + it.stock + ' left' + (it.sold ? ' · ' + it.per_day.toFixed(1) + ' sold a day' : '') + '</div></div>' +
        '<span class="fc-eta' + cls + '">' + eta + '</span>' +
      '</div>';
    }).join('') : '<p class="empty">No active items.</p>';
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  var orderFilter  = '';   // comma-separated statuses; '' = all
  var orderList    = [];   // what the Orders tab is showing
  var ordersMore   = false;
  var openOrders   = {};   // ids of expanded cards, kept across refreshes
  var orderHistory = {};   // id → activity rows, fetched while its card is open
  var orderReq     = 0;    // lets a newer request drop an older one's response
  var latestOrders = [];   // Home's read-only list

  function ordersQuery(limit, before) {
    return '/admin/orders?limit=' + limit +
      (orderFilter ? '&status=' + orderFilter : '') +
      (before ? '&before=' + encodeURIComponent(before) : '');
  }

  // Refetches everything already on screen (at least a page) so the periodic
  // refresh doesn't drop pages added with Load more. Past the API's cap of 50
  // it leaves the list alone rather than cut it short.
  function refreshOrders() {
    if (orderList.length > 50) return;
    var limit = Math.max(ORDER_PAGE, orderList.length);
    var req   = ++orderReq;
    api('GET', ordersQuery(limit)).then(function(rows) {
      if (req !== orderReq) return;
      orderList  = rows;
      ordersMore = rows.length === limit;
      renderOrders();
      Object.keys(openOrders).forEach(loadOrderHistory);
    }).catch(function() {});
  }

  function loadOrderHistory(id) {
    api('GET', '/admin/orders/' + id + '/activity').then(function(rows) {
      orderHistory[id] = rows;
      if (openOrders[id]) renderOrders();
    }).catch(function() {});
  }

  function refreshLatestOrders() {
    api('GET', '/admin/orders?limit=5').then(function(rows) {
      latestOrders = rows;
      renderLatestOrders();
    }).catch(function() {});
  }

  function renderOrders() {
    document.getElementById('ordersList').innerHTML = orderList.length
      ? orderList.map(function(o) { return orderCardHtml(o, true); }).join('')
      : '<p class="empty">' + (orderFilter ? 'No matching orders.' : 'No orders yet.') + '</p>';
    document.getElementById('loadMoreBtn').hidden = !ordersMore;
  }

  function renderLatestOrders() {
    document.getElementById('latestOrders').innerHTML = latestOrders.length
      ? latestOrders.map(function(o) { return orderCardHtml(o, false); }).join('')
      : '<p class="empty">No orders yet.</p>';
  }

  function itemsSubtotal(o) {
    return (o.items || []).reduce(function(sum, it) { return sum + it.quantity * it.unit_price_cents; }, 0);
  }

  // What Square actually charged (with tax). Same fallback as the refund route.
  function orderTotal(o) {
    return o.total_cents != null ? o.total_cents : itemsSubtotal(o);
  }

  function orderCardHtml(o, interactive) {
    var lines   = o.items || [];
    var summary = lines.length
      ? lines.map(function(it) { return it.quantity + '&times; ' + escapeAttr(it.item_name); }).join(', ')
      : '&#x2014;';
    var open = interactive && openOrders[o.id];
    var main =
      '<span class="order-top">' +
        '<span class="badge ' + o.status + '">' + o.status.replace(/_/g, ' ') + '</span>' +
        '<span class="order-total">' + money(orderTotal(o)) + '</span>' +
        '<span class="order-time">' + orderTime(o.created_at) + '</span>' +
        (interactive ? '<span class="order-chev" aria-hidden="true">&#x203A;</span>' : '') +
      '</span>' +
      '<span class="order-items">' + summary + '</span>';
    if (!interactive) return '<div class="order"><div class="order-toggle">' + main + '</div></div>';
    return '<div class="order' + (open ? ' open' : '') + '" data-id="' + o.id + '">' +
      '<button class="order-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">' + main + '</button>' +
      (open ? orderDetailsHtml(o) : '') +
    '</div>';
  }

  function orderDetailsHtml(o) {
    var lines     = o.items || [];
    var tax       = o.total_cents != null ? o.total_cents - itemsSubtotal(o) : 0;
    var canRefund = o.status === 'complete' || o.status === 'dispensing';
    return '<div class="order-details">' +
      (lines.length
        ? '<ul class="order-lines">' + lines.map(function(it) {
            return '<li><span>' + it.quantity + '&times; ' + escapeAttr(it.item_name) + '</span>' +
              '<span class="num">' + money(it.quantity * it.unit_price_cents) + '</span></li>';
          }).join('') +
          (tax > 0 ? '<li class="tax"><span>Tax</span><span class="num">' + money(tax) + '</span></li>' : '') +
          '</ul>'
        : '') +
      '<dl class="kv">' +
        '<dt>Order</dt><dd class="mono">' + o.id + '</dd>' +
        '<dt>Payment</dt><dd class="mono">' + (o.square_payment_id ? escapeAttr(o.square_payment_id) : '&#x2014;') + '</dd>' +
        '<dt>Placed</dt><dd>' + fmtTime(o.created_at, true) + '</dd>' +
        (o.door_opened_at ? '<dt>Door opened</dt><dd>' + fmtTime(o.door_opened_at, true) + '</dd>' : '') +
        '<dt>Updated</dt><dd>' + fmtTime(o.updated_at, true) + '</dd>' +
      '</dl>' +
      '<div class="timeline-head">History</div>' +
      orderHistoryHtml(orderHistory[o.id]) +
      '<div class="order-actions">' +
        (canRefund ? '<button class="sm-btn danger refund-btn">Refund</button>' : '') +
        '<button class="sm-btn delete-btn">Delete</button>' +
      '</div>' +
    '</div>';
  }

  function orderHistoryHtml(rows) {
    if (!rows) return '<p class="empty">Loading&#x2026;</p>';
    if (!rows.length) return '<p class="empty">Nothing recorded &#x2014; this order is older than the history log.</p>';
    return '<ul class="timeline">' + rows.map(function(r) {
      return '<li>' +
        '<span class="event-dot" style="background:' + activityColor(r) + '"></span>' +
        '<span class="num">' + fmtClock(r.created_at) + '</span>' +
        '<span>' + activityLabel(r) + '</span>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function findOrder(id) {
    for (var i = 0; i < orderList.length; i++) if (orderList[i].id === id) return orderList[i];
    return null;
  }

  document.getElementById('orderFilters').addEventListener('click', function(e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    orderFilter = chip.getAttribute('data-status');
    this.querySelectorAll('.chip').forEach(function(c) {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
    });
    orderList  = [];
    ordersMore = false;
    document.getElementById('ordersList').innerHTML = '<p class="empty">Loading&#x2026;</p>';
    document.getElementById('loadMoreBtn').hidden = true;
    refreshOrders();
  });

  document.getElementById('loadMoreBtn').addEventListener('click', function() {
    var btn  = this;
    var last = orderList[orderList.length - 1];
    if (!last) return;
    var req = ++orderReq;
    btn.disabled = true;
    api('GET', ordersQuery(ORDER_PAGE, last.created_at)).then(function(rows) {
      if (req !== orderReq) return;
      orderList  = orderList.concat(rows);
      ordersMore = rows.length === ORDER_PAGE;
      renderOrders();
    }).catch(function(err) {
      alert(err.message);
    }).finally(function() {
      btn.disabled = false;
    });
  });

  document.getElementById('ordersList').addEventListener('click', function(e) {
    var card = e.target.closest('.order');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var o  = findOrder(id);
    if (!o) return;
    if (e.target.closest('.order-toggle')) {
      if (openOrders[id]) {
        delete openOrders[id];
      } else {
        openOrders[id] = true;
        loadOrderHistory(id);
      }
      renderOrders();
      return;
    }
    var refundBtn = e.target.closest('.refund-btn');
    if (refundBtn) {
      if (!confirm('Refund ' + money(orderTotal(o)) + ' for order ' + id.slice(0, 8) + '?')) return;
      refundBtn.disabled = true;
      api('POST', '/admin/refund/' + id).then(function() {
        o.status = 'refunded';
        renderOrders();
        refreshOrders();
      }).catch(function(err) {
        alert('Refund failed: ' + err.message);
        refundBtn.disabled = false;
      });
      return;
    }
    var deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      if (!confirm('Delete order ' + id.slice(0, 8) + '? This cannot be undone.')) return;
      deleteBtn.disabled = true;
      api('DELETE', '/admin/orders/' + id).then(function() {
        orderList = orderList.filter(function(x) { return x.id !== id; });
        delete openOrders[id];
        delete orderHistory[id];
        renderOrders();
      }).catch(function(err) {
        alert('Delete failed: ' + err.message);
        deleteBtn.disabled = false;
      });
    }
  });

  document.getElementById('clearOrdersBtn').addEventListener('click', function() {
    if (!confirm('Delete ALL orders? This cannot be undone.')) return;
    var btn = this;
    var msg = document.getElementById('clearOrdersMsg');
    btn.disabled = true;
    api('DELETE', '/admin/orders').then(function(d) {
      orderList    = [];
      openOrders   = {};
      orderHistory = {};
      latestOrders = [];
      renderOrders();
      renderLatestOrders();
      flashMsg(msg, 'msg ok', 'Deleted ' + d.count + (d.count === 1 ? ' order.' : ' orders.'), 4000);
    }).catch(function(err) {
      flashMsg(msg, 'msg err', err.message, 5000);
    }).finally(function() {
      btn.disabled = false;
    });
  });

  // ── Items & categories ──────────────────────────────────────────────────────

  var catalog       = [];    // every item, from /admin/items
  var catalogLoaded = false;
  var editingItems  = {};    // id -> { origStock, draft } while its edit form is open
  var stockChanges  = {};    // id -> { delta: taps not sent yet, sent: in flight, timer }
  var flashItemId   = null;  // row to highlight after jumping in from Home

  // Cached so the item rows can fill their category dropdowns without
  // refetching; reloaded whenever a category changes.
  var categories = [];

  function findItem(id) {
    for (var i = 0; i < catalog.length; i++) if (catalog[i].id === id) return catalog[i];
    return null;
  }

  function findCategory(id) {
    for (var i = 0; i < categories.length; i++) if (categories[i].id === id) return categories[i];
    return null;
  }

  function categoryOptions(selectedId) {
    return '<option value="">No category</option>' + categories.map(function(c) {
      return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' + escapeAttr(c.name) + '</option>';
    }).join('');
  }

  function refreshItems(force) {
    api('GET', '/admin/items').then(function(list) {
      catalog       = list;
      catalogLoaded = true;
      renderRestock();
      renderItems(force);
    }).catch(function() {});
  }

  // Includes +/- taps that haven't been confirmed by the server yet.
  function shownStock(it) {
    var c = stockChanges[it.id];
    return it.stock + (c ? c.delta + c.sent : 0);
  }

  // Re-rendering replaces every input, so open edit forms carry their unsaved
  // values across, and it waits while someone is typing (the periodic refresh
  // used to wipe edits in progress). force: after an action on the list itself.
  function renderItems(force) {
    var el = document.getElementById('itemsList');
    var a  = document.activeElement;
    if (!catalogLoaded) return;
    if (!force && a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    Object.keys(editingItems).forEach(function(id) {
      if (!findItem(id)) { delete editingItems[id]; return; }
      var row  = el.querySelector('.item-row[data-id="' + id + '"]');
      var name = row && row.querySelector('.item-name-input');
      if (!name) return;
      editingItems[id].draft = {
        name:        name.value,
        category_id: row.querySelector('.item-category-select').value,
        price:       row.querySelector('.item-price-input').value,
        stock:       row.querySelector('.item-stock-input').value,
      };
    });
    if (!catalog.length) {
      el.innerHTML = '<p class="empty">No items yet.</p>';
      return;
    }
    el.innerHTML = groupItems(catalog).map(function(g) {
      return '<div class="item-group">' +
        (g.name ? '<h3 class="item-group-heading">' + escapeAttr(g.name) + '</h3>' : '') +
        g.items.map(itemRowHtml).join('') +
      '</div>';
    }).join('');
  }

  // Same grouping as the buy page: categories in their set order, then
  // uncategorized items last. No heading at all when nothing is categorized.
  function groupItems(list) {
    var byId   = {};
    var groups = categories.map(function(c) { return byId[c.id] = { name: c.name, items: [] }; });
    var none   = { name: 'No category', items: [] };
    list.forEach(function(it) { (byId[it.category_id] || none).items.push(it); });
    var nonEmpty = groups.concat([none]).filter(function(g) { return g.items.length > 0; });
    if (nonEmpty.length === 1 && nonEmpty[0] === none) none.name = null;
    return nonEmpty;
  }

  function itemRowHtml(it) {
    var editing = editingItems[it.id];
    var stock   = shownStock(it);
    var cls     = 'item-row' + (it.active ? '' : ' item-inactive') + (it.id === flashItemId ? ' flash' : '');
    var badge   = !it.active ? '<span class="item-badge">Inactive</span>'
                : stock <= 0 ? '<span class="item-badge oos">Out of stock</span>' : '';
    var controls = '';
    if (!editing) {
      controls = (it.active
        ? '<div class="stepper">' +
            '<button class="step-btn" data-step="-1" aria-label="One fewer"' + (stock <= 0 ? ' disabled' : '') + '>&minus;</button>' +
            '<span class="step-val">' + stock + '</span>' +
            '<button class="step-btn" data-step="1" aria-label="One more">+</button>' +
          '</div>'
        : '') +
        '<button class="sm-btn item-edit-btn">' + (it.active ? 'Edit' : 'Manage') + '</button>';
    }
    return '<div class="' + cls + '" data-id="' + it.id + '">' +
      '<div class="item-head">' +
        '<div class="item-info">' +
          '<div class="item-name">' + escapeAttr(it.name) + '</div>' +
          '<div class="item-price">' + money(it.price_cents) + badge + '</div>' +
        '</div>' +
        controls +
      '</div>' +
      (editing ? itemEditHtml(it, editing.draft) : '') +
    '</div>';
  }

  function itemEditHtml(it, draft) {
    if (!it.active) {
      return '<div class="item-edit">' +
        '<p class="hint">Hidden from the buy page. Restore it to sell it again.</p>' +
        '<div class="item-actions">' +
          '<button class="sm-btn good item-restore-btn">Restore</button>' +
          '<button class="sm-btn item-cancel-btn">Close</button>' +
          '<button class="sm-btn danger item-purge-btn push">Delete permanently</button>' +
        '</div>' +
      '</div>';
    }
    var d = draft || {
      name:        it.name,
      category_id: it.category_id,
      price:       (it.price_cents / 100).toFixed(2),
      stock:       String(shownStock(it)),
    };
    return '<div class="item-edit">' +
      '<label class="mini-label">Name<input class="item-name-input" value="' + escapeAttr(d.name) + '"></label>' +
      '<label class="mini-label">Category<select class="item-category-select">' + categoryOptions(d.category_id) + '</select></label>' +
      '<div class="two-col">' +
        '<label class="mini-label">Price ($)<input class="item-price-input" type="number" step="0.01" min="0.01" inputmode="decimal" value="' + escapeAttr(d.price) + '"></label>' +
        '<label class="mini-label">Stock count<input class="item-stock-input" type="number" step="1" min="0" inputmode="numeric" value="' + escapeAttr(d.stock) + '"></label>' +
      '</div>' +
      '<div class="item-actions">' +
        '<button class="sm-btn primary item-save-btn">Save</button>' +
        '<button class="sm-btn item-cancel-btn">Cancel</button>' +
        '<button class="sm-btn danger item-del-btn push">Delete</button>' +
      '</div>' +
    '</div>';
  }

  // +/- taps add up locally and go out as one relative change after a short
  // pause, so a burst of taps is one request and a sale in the meantime
  // isn't overwritten.
  function stepStock(row, it, step) {
    var next = shownStock(it) + step;
    if (next < 0) return;
    var c = stockChanges[it.id] || (stockChanges[it.id] = { delta: 0, sent: 0, timer: null });
    c.delta += step;
    row.querySelector('.step-val').textContent = next;
    row.querySelector('.step-btn[data-step="-1"]').disabled = next <= 0;
    clearTimeout(c.timer);
    c.timer = setTimeout(function() { sendStock(it.id); }, 600);
  }

  function sendStock(id) {
    var c     = stockChanges[id];
    var delta = c.delta;
    c.delta = 0;
    c.timer = null;
    if (!delta) { settleStock(id); return; }
    c.sent += delta;
    api('POST', '/admin/items/' + id + '/stock', { delta: delta }).then(function(item) {
      catalog = catalog.map(function(it) { return it.id === id ? item : it; });
    }).catch(function(err) {
      alert('Stock update failed: ' + err.message);
    }).finally(function() {
      c.sent -= delta;
      settleStock(id);
    });
  }

  function settleStock(id) {
    var c = stockChanges[id];
    if (c && !c.delta && !c.sent) delete stockChanges[id];
    renderRestock();
    renderItems();
  }

  document.getElementById('itemsList').addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    var row = btn.closest('.item-row');
    var id  = row.getAttribute('data-id');
    var it  = findItem(id);
    if (!it) return;

    if (btn.classList.contains('step-btn')) {
      stepStock(row, it, parseInt(btn.getAttribute('data-step'), 10));
      return;
    }
    if (btn.classList.contains('item-edit-btn')) {
      editingItems[id] = { origStock: shownStock(it), draft: null };
      renderItems(true);
      return;
    }
    if (btn.classList.contains('item-cancel-btn')) {
      delete editingItems[id];
      renderItems(true);
      return;
    }

    var req;
    if (btn.classList.contains('item-save-btn')) {
      var name  = row.querySelector('.item-name-input').value.trim();
      var price = parseFloat(row.querySelector('.item-price-input').value);
      var stock = parseInt(row.querySelector('.item-stock-input').value, 10);
      if (!name)         { alert('Name cannot be empty.'); return; }
      if (!(price > 0))  { alert('Enter a valid price.'); return; }
      if (!(stock >= 0)) { alert('Enter a valid stock amount.'); return; }
      var body = { name: name, price_cents: Math.round(price * 100), category_id: row.querySelector('.item-category-select').value || null };
      // Only send stock when it was actually recounted, so a sale since the
      // form opened isn't overwritten by the count it opened with.
      if (stock !== editingItems[id].origStock) body.stock = stock;
      req = api('PATCH', '/admin/items/' + id, body);
    } else if (btn.classList.contains('item-del-btn')) {
      if (!confirm('Delete "' + it.name + '"?')) return;
      req = api('DELETE', '/admin/items/' + id);
    } else if (btn.classList.contains('item-restore-btn')) {
      req = api('PATCH', '/admin/items/' + id, { active: true });
    } else if (btn.classList.contains('item-purge-btn')) {
      if (!confirm('Permanently delete "' + it.name + '"? This cannot be undone. Past orders will keep showing its name and price, but you will not be able to restore it.')) return;
      req = api('DELETE', '/admin/items/' + id + '?force=true');
    } else {
      return;
    }
    btn.disabled = true;
    req.then(function() {
      delete editingItems[id];
      refreshItems(true);
    }).catch(function(err) {
      alert(err.message);
      btn.disabled = false;
    });
  });

  function renderRestock() {
    var low = catalog.filter(function(it) { return it.active && shownStock(it) <= LOW_STOCK; })
      .sort(function(a, b) { return shownStock(a) - shownStock(b) || a.name.localeCompare(b.name); });
    document.getElementById('restockCard').hidden = !low.length;
    document.getElementById('itemsTabDot').hidden = !low.some(function(it) { return shownStock(it) <= 0; });
    document.getElementById('restockList').innerHTML = low.map(function(it) {
      var n = shownStock(it);
      return '<button class="restock-row" data-id="' + it.id + '">' +
        '<span>' + escapeAttr(it.name) + '</span>' +
        '<span class="restock-left' + (n <= 0 ? ' oos' : '') + '">' + (n <= 0 ? 'Out of stock' : n + ' left') + '</span>' +
      '</button>';
    }).join('');
  }

  document.getElementById('restockList').addEventListener('click', function(e) {
    var btn = e.target.closest('.restock-row');
    if (!btn) return;
    history.pushState(null, '', '#items');
    showTab('items');
    flashItemId = btn.getAttribute('data-id');
    renderItems(true);
    var row = document.querySelector('.item-row[data-id="' + flashItemId + '"]');
    if (row) row.scrollIntoView({ block: 'center' });
    setTimeout(function() { flashItemId = null; }, 1600);
  });

  document.getElementById('addItemBtn').addEventListener('click', function() {
    var name  = document.getElementById('newItemName').value.trim();
    var price = parseFloat(document.getElementById('newItemPrice').value);
    var stock = parseInt(document.getElementById('newItemStock').value, 10);
    var msg   = document.getElementById('addItemMsg');
    if (!name)         { flashMsg(msg, 'msg err', 'Enter an item name.', 4000); return; }
    if (!(price > 0))  { flashMsg(msg, 'msg err', 'Enter a valid price.', 4000); return; }
    if (!(stock >= 0)) { flashMsg(msg, 'msg err', 'Enter a valid stock amount.', 4000); return; }
    var categoryId = document.getElementById('newItemCategory').value || null;
    var btn = document.getElementById('addItemBtn');
    btn.disabled = true;
    // The category picker is left as-is so a run of items in the same
    // category doesn't need it re-picked each time.
    api('POST', '/admin/items', { name: name, price_cents: Math.round(price * 100), stock: stock, category_id: categoryId })
      .then(function() {
        document.getElementById('newItemName').value  = '';
        document.getElementById('newItemPrice').value = '';
        document.getElementById('newItemStock').value = '';
        flashMsg(msg, 'msg ok', 'Item added.', 3000);
        refreshItems();
      })
      .catch(function(err) { flashMsg(msg, 'msg err', err.message, 5000); })
      .finally(function() { btn.disabled = false; });
  });

  // force: after an action on the list itself. Otherwise the rows are left
  // alone while one is mid-rename.
  function refreshCategories(force) {
    api('GET', '/admin/categories').then(function(cats) {
      var el = document.getElementById('categoriesList');
      var renaming = [].some.call(el.querySelectorAll('.cat-name-input'), function(input) {
        var c = findCategory(input.closest('.cat-row').getAttribute('data-id'));
        return input === document.activeElement || (c && input.value !== c.name);
      });
      categories = cats;
      if (force || !renaming) {
        el.innerHTML = cats.length ? cats.map(function(c, i) {
          return '<div class="cat-row" data-id="' + c.id + '">' +
            '<input class="cat-name-input" value="' + escapeAttr(c.name) + '">' +
            '<button class="sm-btn cat-move-btn" data-dir="up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>&#x2191;</button>' +
            '<button class="sm-btn cat-move-btn" data-dir="down" title="Move down"' + (i === cats.length - 1 ? ' disabled' : '') + '>&#x2193;</button>' +
            '<button class="sm-btn cat-save-btn">Save</button>' +
            '<button class="sm-btn danger cat-del-btn">Delete</button>' +
          '</div>';
        }).join('') : '<p class="empty">No categories yet &#x2014; the buy page shows one plain list.</p>';
      }
      var newItemCategory = document.getElementById('newItemCategory');
      newItemCategory.innerHTML = categoryOptions(newItemCategory.value);
      // A deleted category's items still carry its id in the cache, which
      // groupItems already treats as uncategorized, so no refetch is needed.
      renderItems();
    }).catch(function() {});
  }

  document.getElementById('categoriesList').addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var row = btn.closest('.cat-row');
    var id  = row.getAttribute('data-id');
    var req;
    if (btn.classList.contains('cat-save-btn')) {
      var name = row.querySelector('.cat-name-input').value.trim();
      if (!name) { alert('Name cannot be empty.'); return; }
      req = api('PATCH', '/admin/categories/' + id, { name: name });
    } else if (btn.classList.contains('cat-move-btn')) {
      req = api('POST', '/admin/categories/' + id + '/move', { direction: btn.getAttribute('data-dir') });
    } else if (btn.classList.contains('cat-del-btn')) {
      var catName = row.querySelector('.cat-name-input').value;
      if (!confirm('Delete category "' + catName + '"? Its items will not be deleted, just left without a category.')) return;
      req = api('DELETE', '/admin/categories/' + id);
    } else {
      return;
    }
    btn.disabled = true;
    req.then(function() { refreshCategories(true); })
      .catch(function(err) { alert(err.message); btn.disabled = false; });
  });

  document.getElementById('addCategoryBtn').addEventListener('click', function() {
    var input = document.getElementById('newCategoryName');
    var name  = input.value.trim();
    var msg   = document.getElementById('addCategoryMsg');
    if (!name) { flashMsg(msg, 'msg err', 'Enter a category name.', 4000); return; }
    var btn = document.getElementById('addCategoryBtn');
    btn.disabled = true;
    api('POST', '/admin/categories', { name: name })
      .then(function() {
        input.value = '';
        flashMsg(msg, 'msg ok', 'Category added.', 3000);
        refreshCategories(true);
      })
      .catch(function(err) { flashMsg(msg, 'msg err', err.message, 5000); })
      .finally(function() { btn.disabled = false; });
  });

  // ── Device ──────────────────────────────────────────────────────────────────

  // Wording and colour for activity log rows, shared by this tab's list and
  // each order's History. Admin actions get their own colour so it's easy to
  // spot who opened the fridge.
  var ACTIVITY_RED   = ['refund_failed', 'unlock_failed', 'checkout_failed', 'auth_failed', 'ota_failed', 'offline', 'unlock_timeout'];
  var ACTIVITY_AMBER = ['late_payment', 'out_of_stock', 'refund_issued', 'started', 'ota_start', 'rebooting', 'wifi_updating', 'wifi_reset'];
  var ACTIVITY_GREEN = ['paid', 'complete', 'unlocked', 'online', 'ota_complete'];

  function activityColor(r) {
    if (ACTIVITY_RED.indexOf(r.event) !== -1)   return '#c00';
    if (r.source === 'admin')                   return '#1a5cbf';
    if (ACTIVITY_AMBER.indexOf(r.event) !== -1) return '#b45309';
    if (ACTIVITY_GREEN.indexOf(r.event) !== -1) return '#1a7a1a';
    return '#888';
  }

  function activityLabel(r) {
    var d = r.detail || {};
    var text;
    switch (r.event) {
      case 'checkout_started':   text = 'Checkout started &#x2014; sent to Square'; break;
      case 'checkout_cancelled': text = 'Customer went back to edit their cart &#x2014; checkout cancelled'; break;
      case 'checkout_expired':   text = 'Checkout expired unpaid &#x2014; fridge was never unlocked'; break;
      case 'checkout_failed':    text = 'Couldn&#x2019;t create the Square checkout: ' + escapeAttr(d.error); break;
      case 'paid':               text = 'Paid ' + money(d.amount_cents); break;
      case 'late_payment':       text = 'Paid ' + money(d.amount_cents) + ' after the checkout had ended &#x2014; refunding'; break;
      case 'out_of_stock':       text = 'Sold out before payment completed &#x2014; refunding'; break;
      case 'unlock_sent':        text = 'Unlock sent to fridge'; break;
      case 'unlock_failed':      text = 'Couldn&#x2019;t send unlock: ' + escapeAttr(d.error); break;
      case 'complete':           text = d.door_close_missed ? 'Completed (door close never received)' : 'Completed'; break;
      case 'refund_issued':      text = 'Refunded ' + money(d.amount_cents) + ' &#x2014; ' + escapeAttr(d.reason); break;
      case 'refund_failed':      text = 'Refund of ' + money(d.amount_cents) + ' FAILED: ' + escapeAttr(d.error); break;
      case 'unlocked':           text = 'Fridge unlocked'; break;
      case 'door_open':          text = 'Door opened'; break;
      case 'door_closed':        text = 'Door closed'; break;
      case 'locked':
      case 'relocked':           text = 'Fridge locked'; break;
      case 'unlock_timeout':     text = 'Door not opened within 60s &#x2014; relocked'; break;
      case 'already_unlocked':   text = 'Fridge was already unlocked'; break;
      case 'auth_failed':        text = 'Fridge rejected a command (failed signature or time check)'; break;
      case 'online':             text = 'Fridge online'; break;
      case 'offline':            text = 'Fridge offline'; break;
      case 'ota_start':          text = 'Firmware update started'; break;
      case 'ota_failed':         text = 'Firmware update failed'; break;
      case 'ota_complete':       text = 'Firmware update complete'; break;
      case 'rebooting':          text = 'Fridge rebooting'; break;
      case 'wifi_updating':      text = 'Fridge switching WiFi network'; break;
      case 'wifi_reset':         text = 'Fridge WiFi erased &#x2014; in setup mode'; break;
      case 'started':            text = 'Server restarted'; break;
      case 'admin_unlock':       text = 'Admin unlocked the fridge'; break;
      case 'admin_lock':         text = 'Admin locked the fridge'; break;
      case 'admin_reboot':       text = 'Admin rebooted the fridge'; break;
      case 'admin_wifi_update':  text = 'Admin changed WiFi to &#x201C;' + escapeAttr(d.ssid) + '&#x201D;'; break;
      case 'admin_wifi_reset':   text = 'Admin reset the fridge&#x2019;s WiFi'; break;
      case 'admin_ota':          text = 'Admin started a firmware update'; break;
      case 'order_deleted':      text = 'Admin deleted the order'; break;
      case 'orders_cleared':     text = 'Admin deleted all orders (' + d.count + ')'; break;
      default:                   text = escapeAttr(r.event).replace(/_/g, ' ');
    }
    if (d.admin_unlock) text += ' (admin unlock)';
    return text;
  }

  function refreshEvents() {
    api('GET', '/admin/events').then(function(rows) {
      var el = document.getElementById('eventLog');
      if (!rows.length) {
        el.innerHTML = '<p class="empty">No events yet.</p>';
        return;
      }
      el.innerHTML = '<ul class="event-list">' +
        rows.map(function(r) {
          return '<li class="event-item">' +
            '<span class="event-dot" style="background:' + activityColor(r) + '"></span>' +
            '<span class="event-name">' + activityLabel(r) +
              '<span class="event-meta">' + fmtTime(r.created_at, true) +
                (r.order_id ? ' &#xB7; order ' + r.order_id.slice(0, 8) : '') +
              '</span>' +
            '</span>' +
            '</li>';
        }).join('') + '</ul>';
    }).catch(function() {});
  }

  // Reboot, WiFi changes and OTA all restart the device. The server refuses
  // those (409) while a customer order is in progress, so ask first and then
  // resend with force. Cancelling rejects with an empty message so the
  // button shows nothing. On success, check status soon so the header shows
  // Offline without waiting for the next poll.
  function withRestartCheck(path, body) {
    return api('POST', path, body).catch(function(err) {
      var busy = err.data && err.data.order_in_progress;
      if (!busy) throw err;
      if (!confirm('A customer order is in progress (' + busy.id.slice(0, 8) + ', ' + busy.status + '). Restarting now could stop them opening the door. Restart anyway?')) {
        throw new Error('');
      }
      var forced = {};
      Object.keys(body || {}).forEach(function(k) { forced[k] = body[k]; });
      forced.force = true;
      return api('POST', path, forced);
    }).then(function(data) {
      setTimeout(refreshStatus, 2000);
      return data;
    });
  }

  function doAction(path, btnId, msgId, label, restarts) {
    var btn = document.getElementById(btnId);
    var msg = document.getElementById(msgId);
    btn.disabled = true;
    flashMsg(msg, 'msg', '', 0);
    (restarts ? withRestartCheck(path) : api('POST', path)).then(function() {
      flashMsg(msg, 'msg ok', label + ' sent.', 4000);
    }).catch(function(e) {
      flashMsg(msg, 'msg err', e.message, 5000);
    }).finally(function() {
      btn.disabled = false;
    });
  }

  document.getElementById('unlockBtn').addEventListener('click', function() {
    doAction('/admin/unlock', 'unlockBtn', 'controlMsg', 'Unlock');
  });
  document.getElementById('lockBtn').addEventListener('click', function() {
    doAction('/admin/lock', 'lockBtn', 'controlMsg', 'Lock');
  });
  document.getElementById('rebootBtn').addEventListener('click', function() {
    if (!confirm('Reboot the fridge controller?')) return;
    doAction('/admin/reboot', 'rebootBtn', 'rebootMsg', 'Reboot', true);
  });

  var otaUrlInput = document.getElementById('otaUrl');
  var otaBtn      = document.getElementById('otaBtn');
  var otaMsg      = document.getElementById('otaMsg');

  // The field used to be refilled with the last URL pushed, which left an
  // old firmware link sitting there. Drop what earlier versions stored.
  try { localStorage.removeItem('lastOtaUrl'); } catch (e) {}

  otaBtn.addEventListener('click', function() {
    var url = otaUrlInput.value.trim();
    if (!url) { flashMsg(otaMsg, 'msg err', 'Enter a URL.', 4000); return; }
    otaBtn.disabled = true;
    flashMsg(otaMsg, 'msg', '', 0);
    withRestartCheck('/admin/ota', { url: url }).then(function() {
      // Kept on failure so it can be retried; cleared once it's been sent.
      otaUrlInput.value = '';
      flashMsg(otaMsg, 'msg ok', 'OTA command sent — device will reboot shortly.', 5000);
    }).catch(function(e) {
      flashMsg(otaMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      otaBtn.disabled = false;
    });
  });

  var wifiSsidInput = document.getElementById('wifiSsid');
  var wifiPassInput = document.getElementById('wifiPass');
  var wifiBtn       = document.getElementById('wifiBtn');
  var wifiMsg       = document.getElementById('wifiMsg');

  wifiBtn.addEventListener('click', function() {
    var ssid = wifiSsidInput.value.trim();
    var pass = wifiPassInput.value;
    if (!ssid || !pass) {
      flashMsg(wifiMsg, 'msg err', 'Enter both network name and password.', 4000);
      return;
    }
    wifiBtn.disabled = true;
    flashMsg(wifiMsg, 'msg', '', 0);
    withRestartCheck('/admin/wifi', { ssid: ssid, password: pass }).then(function() {
      flashMsg(wifiMsg, 'msg ok', 'Sent — device will reconnect shortly.', 5000);
      wifiPassInput.value = '';
    }).catch(function(e) {
      flashMsg(wifiMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      wifiBtn.disabled = false;
    });
  });

  var wifiResetBtn = document.getElementById('wifiResetBtn');
  var wifiResetMsg = document.getElementById('wifiResetMsg');

  wifiResetBtn.addEventListener('click', function() {
    if (!confirm('This will erase WiFi credentials and reboot into setup AP mode. The fridge will be offline until reconfigured. Are you sure?')) return;
    if (!confirm('Second confirmation: fridge goes offline now. Proceed?')) return;
    wifiResetBtn.disabled = true;
    flashMsg(wifiResetMsg, 'msg', '', 0);
    withRestartCheck('/admin/wifi-reset').then(function() {
      flashMsg(wifiResetMsg, 'msg ok', 'Done — device is rebooting into setup mode.', 5000);
    }).catch(function(e) {
      flashMsg(wifiResetMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      wifiResetBtn.disabled = false;
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────────

  var tzSelect    = document.getElementById('tzSelect');
  var tzNow       = document.getElementById('tzNow');
  var settingsBtn = document.getElementById('settingsBtn');
  var settingsMsg = document.getElementById('settingsMsg');

  // The saved store time zone. Order dates use it so they line up with what
  // the sales stats call "Today".
  var storeTz = null;

  // Shows the current time in the selected zone, so a wrong pick is obvious
  // before saving.
  function showStoreTime() {
    if (!tzSelect.value) return;
    tzNow.textContent = 'Time there now: ' + new Date().toLocaleTimeString('en-US', {
      timeZone: tzSelect.value, hour: 'numeric', minute: '2-digit',
    });
  }

  function loadSettings() {
    api('GET', '/admin/settings').then(function(d) {
      tzSelect.innerHTML = '';
      d.timezones.forEach(function(tz) {
        var opt = document.createElement('option');
        opt.value = tz.id;
        opt.textContent = tz.label;
        tzSelect.appendChild(opt);
      });
      tzSelect.value = d.settings.timezone;
      storeTz = d.settings.timezone;
      showStoreTime();
      renderOrders();
      renderLatestOrders();
    }).catch(function() {});
  }

  tzSelect.addEventListener('change', showStoreTime);

  settingsBtn.addEventListener('click', function() {
    settingsBtn.disabled = true;
    flashMsg(settingsMsg, 'msg', '', 0);
    api('PATCH', '/admin/settings', { timezone: tzSelect.value }).then(function() {
      storeTz = tzSelect.value;
      flashMsg(settingsMsg, 'msg ok', 'Saved.', 4000);
      refreshStats();
      renderOrders();
      renderLatestOrders();
    }).catch(function(e) {
      flashMsg(settingsMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      settingsBtn.disabled = false;
    });
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function money(cents) {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function timeAgo(iso) {
    var s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function fmtTime(iso, withSeconds) {
    var opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (withSeconds) opts.second = '2-digit';
    if (storeTz) opts.timeZone = storeTz;
    return new Date(iso).toLocaleString('en-US', opts);
  }

  // Time of day only, for a single order's History.
  function fmtClock(iso) {
    var opts = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
    if (storeTz) opts.timeZone = storeTz;
    return new Date(iso).toLocaleTimeString('en-US', opts);
  }

  // Relative while recent, a real date once "3d ago" stops being useful.
  function orderTime(iso) {
    return Date.now() - new Date(iso) < 86400000 ? timeAgo(iso) : fmtTime(iso);
  }

  function flashMsg(el, cls, text, ms) {
    if (el._clearTimer) { clearTimeout(el._clearTimer); el._clearTimer = null; }
    el.className = cls;
    el.textContent = text;
    if (ms) {
      el._clearTimer = setTimeout(function() {
        el.textContent = '';
        el.className = 'msg';
      }, ms);
    }
  }

  if (token) { showDashboard(); } else { loginEl.style.display = 'flex'; }
</script>

</body>
</html>`);
});

// ── API endpoints ─────────────────────────────────────────────────────────────

router.get('/events', requireAdmin, async (req, res) => {
  try {
    res.json(await getRecentActivity(100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  const lastSeen  = getDeviceLastSeen(device_id);
  res.json({
    device_id,
    online:   isDeviceOnline(device_id),
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
    wifi:     getDeviceWifiInfo(device_id),
  });
});

// Restarting the device (reboot, WiFi change, OTA) mid-purchase could stop a
// customer opening the door they just paid for. Unless the admin has
// confirmed (force: true), answer 409 naming the order instead. Returns true
// when it has responded.
async function refuseIfOrderInProgress(req, res, device_id) {
  if (req.body?.force === true) return false;
  const order = (await getActiveOrderForDevice(device_id)) || (await getInProgressOrderForDevice(device_id));
  if (!order) return false;
  res.status(409).json({
    error: 'A customer order is in progress',
    order_in_progress: { id: order.id, status: order.status },
  });
  return true;
}

router.post('/wifi', requireAdmin, async (req, res) => {
  const { ssid, password } = req.body;
  if (!ssid || !password) return res.status(400).json({ error: 'ssid and password required' });
  if (ssid.includes('"') || password.includes('"'))
    return res.status(400).json({ error: 'Credentials may not contain double-quote characters' });
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    if (await refuseIfOrderInProgress(req, res, device_id)) return;
    publishWifiUpdate(device_id, ssid, password);
    await logActivity({ device_id, source: 'admin', event: 'admin_wifi_update', detail: { ssid } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/wifi-reset', requireAdmin, async (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    if (await refuseIfOrderInProgress(req, res, device_id)) return;
    publishWifiReset(device_id);
    await logActivity({ device_id, source: 'admin', event: 'admin_wifi_reset' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const { timezone } = await getSettings();
    const stats = await getOrderStats(timezone);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?range=7 | 30 | all (default 30): days back from today in the store time zone.
router.get('/insights', requireAdmin, async (req, res) => {
  const days = req.query.range === 'all' ? null : req.query.range === '7' ? 7 : 30;
  try {
    const { timezone } = await getSettings();
    res.json(await getInsights(timezone, days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    res.json({ settings: await getSettings(), timezones: US_TIMEZONES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/settings', requireAdmin, async (req, res) => {
  const { timezone } = req.body || {};
  if (timezone === undefined) return res.status(400).json({ error: 'No valid fields to update' });
  if (!US_TIMEZONES.some((tz) => tz.id === timezone)) return res.status(400).json({ error: 'Unsupported time zone' });
  try {
    await setSetting('timezone', timezone);
    res.json({ settings: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Items ─────────────────────────────────────────────────────────────────────

router.get('/items', requireAdmin, async (req, res) => {
  try {
    res.json(await getAllItems());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Empty/null means "no category". Returns undefined for an unknown id.
async function resolveCategoryId(value) {
  if (value === null || value === '') return null;
  const category = await getCategory(value);
  return category ? category.id : undefined;
}

router.post('/items', requireAdmin, async (req, res) => {
  const name  = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const price = parseInt(req.body.price_cents, 10);
  const stock = parseInt(req.body.stock, 10);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'price_cents must be a positive integer' });
  if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'stock must be a non-negative integer' });
  try {
    const category_id = await resolveCategoryId(req.body.category_id ?? null);
    if (category_id === undefined) return res.status(400).json({ error: 'Unknown category' });
    const item = await createItem({ name, price_cents: price, stock, category_id });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/items/:id', requireAdmin, async (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    updates.name = name;
  }
  if (req.body.price_cents !== undefined) {
    const price = parseInt(req.body.price_cents, 10);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'price_cents must be a positive integer' });
    updates.price_cents = price;
  }
  if (req.body.stock !== undefined) {
    const stock = parseInt(req.body.stock, 10);
    if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'stock must be a non-negative integer' });
    updates.stock = stock;
  }
  if (req.body.active !== undefined) updates.active = !!req.body.active;
  try {
    if (req.body.category_id !== undefined) {
      const category_id = await resolveCategoryId(req.body.category_id);
      if (category_id === undefined) return res.status(400).json({ error: 'Unknown category' });
      updates.category_id = category_id;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    res.json(await updateItem(req.params.id, updates));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Body: { delta } — relative restock from the admin +/- stepper. See
// adjustStock for why this isn't just a PATCH of the absolute count.
router.post('/items/:id/stock', requireAdmin, async (req, res) => {
  const delta = req.body.delta;
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
    return res.status(400).json({ error: 'delta must be a non-zero integer between -100 and 100' });
  }
  try {
    const item = await adjustStock(req.params.id, delta);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hard-deletes items with no order history; otherwise deactivates so past
// orders that reference this item keep their name/price intact (order_items
// already snapshots item_name/unit_price_cents itself, so this is really
// just to keep the Items list from silently losing a row admin might want
// to restore). ?force=true skips that safety check and always hard-deletes
// — safe to do at any time since order_items has no foreign key back to
// items and never looks the live row up again after checkout.
router.delete('/items/:id', requireAdmin, async (req, res) => {
  try {
    const item = await getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const force = req.query.force === 'true';
    if (!force && await itemHasOrders(item.id)) {
      await updateItem(item.id, { active: false });
      return res.json({ ok: true, deactivated: true });
    }
    await deleteItem(item.id);
    res.json({ ok: true, deactivated: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Categories ────────────────────────────────────────────────────────────────

const DUPLICATE_KEY = '23505';

router.get('/categories', requireAdmin, async (req, res) => {
  try {
    res.json(await getCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categories', requireAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    res.json(await createCategory(name));
  } catch (err) {
    if (err.code === DUPLICATE_KEY) return res.status(400).json({ error: 'A category with that name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/categories/:id', requireAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    if (!await getCategory(req.params.id)) return res.status(404).json({ error: 'Category not found' });
    res.json(await renameCategory(req.params.id, name));
  } catch (err) {
    if (err.code === DUPLICATE_KEY) return res.status(400).json({ error: 'A category with that name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// Body: { direction: 'up' | 'down' } — earlier categories show first on the buy page.
router.post('/categories/:id/move', requireAdmin, async (req, res) => {
  const { direction } = req.body || {};
  if (direction !== 'up' && direction !== 'down') return res.status(400).json({ error: 'direction must be "up" or "down"' });
  try {
    if (!await getCategory(req.params.id)) return res.status(404).json({ error: 'Category not found' });
    await moveCategory(req.params.id, direction);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/categories/:id', requireAdmin, async (req, res) => {
  try {
    if (!await getCategory(req.params.id)) return res.status(404).json({ error: 'Category not found' });
    await deleteCategory(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ORDER_STATUSES = ['pending', 'paid', 'dispensing', 'complete', 'refunded', 'timed_out', 'cancelled'];

// Query: ?limit (max 50), ?before=<created_at ISO> to page back,
// ?status=a,b to filter. Unknown statuses are ignored.
router.get('/orders', requireAdmin, async (req, res) => {
  const limit    = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const before   = req.query.before && !isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  const statuses = String(req.query.status || '').split(',').filter((s) => ORDER_STATUSES.includes(s));
  try {
    res.json(await getRecentOrders({ limit, before, statuses }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unlock', requireAdmin, async (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    publishAdminUnlock(device_id);
    await logActivity({ device_id, source: 'admin', event: 'admin_unlock' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/lock', requireAdmin, async (req, res) => {
  const device_id = DEVICE_ID();
  try {
    publishLock(device_id);
    await logActivity({ device_id, source: 'admin', event: 'admin_lock' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reboot', requireAdmin, async (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    if (await refuseIfOrderInProgress(req, res, device_id)) return;
    publishReboot(device_id);
    await logActivity({ device_id, source: 'admin', event: 'admin_reboot' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:order_id/activity', requireAdmin, async (req, res) => {
  try {
    res.json(await getOrderActivity(req.params.order_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The order's activity rows are kept, so its history is still there to look
// up after it's gone from the Orders list.
router.delete('/orders/:order_id', requireAdmin, async (req, res) => {
  try {
    await deleteOrder(req.params.order_id);
    await logActivity({ order_id: req.params.order_id, source: 'admin', event: 'order_deleted' });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/orders', requireAdmin, async (req, res) => {
  try {
    const count = await deleteAllOrders();
    await logActivity({ source: 'admin', event: 'orders_cleared', detail: { count } });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refund/:order_id', requireAdmin, async (req, res) => {
  const { order_id } = req.params;
  try {
    const order = await getOrder(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.square_payment_id) return res.status(400).json({ error: 'No payment to refund' });
    if (order.status === 'refunded' || order.status === 'timed_out') {
      return res.status(400).json({ error: 'Already refunded' });
    }
    // total_cents is the amount Square actually charged (includes tax);
    // fall back to the pre-tax item sum only for orders that predate that
    // column being populated.
    const amount_cents = order.total_cents ?? order.items.reduce((sum, it) => sum + it.quantity * it.unit_price_cents, 0);
    await createRefund({ payment_id: order.square_payment_id, order_id, amount_cents, reason: 'Refunded by store' });
    await updateOrder(order_id, { status: 'refunded' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ota', requireAdmin, async (req, res) => {
  const { url } = req.body;
  const device_id = DEVICE_ID();
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    if (await refuseIfOrderInProgress(req, res, device_id)) return;
    publishOTA(device_id, url);
    await logActivity({ device_id, source: 'admin', event: 'admin_ota', detail: { url } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
