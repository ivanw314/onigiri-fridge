'use strict';
const { Router } = require('express');
const {
  publishOTA, publishLock, publishAdminUnlock, publishReboot, publishWifiUpdate, publishWifiReset,
  isDeviceOnline, getDeviceLastSeen, getDeviceWifiInfo, getRecentEvents,
} = require('../mqttClient');
const { getRecentOrders, getOrderStats, getOrder, updateOrder, deleteOrder, deleteAllOrders } = require('../orderStore');
const {
  getAllItems, getItem, createItem, updateItem, deleteItem, itemHasOrders,
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    body { font-family: system-ui, -apple-system, sans-serif; background: #f4f4ef; min-height: 100dvh; }
    #login     { display: none; align-items: center; justify-content: center; min-height: 100dvh; padding: 1.5rem; }
    #dashboard { display: none; padding: 1.5rem; }
    .wrap { max-width: 380px; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; }
    .card { background: #fff; border-radius: 20px; padding: 1.75rem 1.5rem; box-shadow: 0 4px 24px rgba(0,0,0,0.07); }
    #login .card { max-width: 340px; width: 100%; text-align: center; }
    .emoji { font-size: 2.5rem; margin-bottom: 0.75rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1.25rem; }
    h2 { font-size: 1rem; font-weight: 600; margin-bottom: 1rem; color: #333; }
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
    }
    button:hover:not(:disabled) { opacity: 0.8; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    button.secondary { background: #fff; color: #111; border: 1.5px solid #e0e0e0; }
    button.secondary:disabled { background: #fff; color: #aaa; border-color: #e0e0e0; }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
    .msg { font-size: 0.85rem; min-height: 1.2em; margin-top: 0.6rem; }
    .msg.ok  { color: #1a7a1a; }
    .msg.err { color: #c00; }
    .status-row { display: flex; align-items: center; justify-content: space-between; }
    .status-label { display: flex; align-items: center; gap: 0.5rem; }
    .status-main { font-weight: 600; font-size: 0.95rem; }
    .status-sub  { font-size: 0.78rem; color: #999; margin-top: 0.15rem; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ccc; flex-shrink: 0; }
    .dot.online  { background: #1a7a1a; }
    .dot.offline { background: #c00; }
    .status-actions { display: flex; gap: 0.4rem; align-items: center; }
    .icon-btn {
      background: #fff; color: #111; border: 1.5px solid #e0e0e0; border-radius: 10px;
      width: 2.1rem; height: 2.1rem; padding: 0; font-size: 1rem; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s; flex-shrink: 0;
    }
    .icon-btn:hover { opacity: 0.7; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { animation: spin 0.5s linear; }
    .stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem 1rem; }
    .stat { text-align: center; padding: 0.5rem 0; }
    .stat-num   { font-size: 1.6rem; font-weight: 700; line-height: 1; }
    .stat-label { font-size: 0.72rem; color: #999; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.03em; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; color: #888; font-weight: 500; padding-bottom: 0.5rem; }
    td { padding: 0.45rem 0; border-top: 1px solid #f0f0f0; vertical-align: middle; }
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
    .refund-btn {
      width: auto; font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 8px;
      background: #fff; color: #c00; border: 1px solid #f5c0c0; font-weight: 500; cursor: pointer;
    }
    .refund-btn:hover:not(:disabled) { background: #fef0f0; }
    .refund-btn:disabled { color: #aaa; border-color: #e0e0e0; cursor: not-allowed; }
    .event-list { list-style: none; display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
    .event-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-top: 1px solid #f0f0f0; font-size: 0.83rem; }
    .event-item:first-child { border-top: none; }
    .event-dot  { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .event-name { flex: 1; }
    .event-time { color: #bbb; font-size: 0.75rem; white-space: nowrap; }
    .delete-btn {
      width: auto; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 8px;
      background: #fff; color: #aaa; border: 1px solid #e0e0e0; font-weight: 500; cursor: pointer; font-family: inherit;
    }
    .delete-btn:hover:not(:disabled) { color: #c00; border-color: #f5c0c0; background: #fef0f0; }
    .delete-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .item-card { border-top: 1px solid #f0f0f0; padding: 0.75rem 0 0.25rem; }
    .item-card:first-child { border-top: none; padding-top: 0; }
    .item-card input { margin-bottom: 0.5rem; }
    .item-card.item-inactive { opacity: 0.55; }
    .item-badge { font-size: 0.72rem; color: #999; margin-left: 0.4rem; }
    .item-badge.oos { color: #c00; }
    .item-fields { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    .item-fields input { flex: 1 1 70px; min-width: 60px; margin-bottom: 0; padding: 0.5rem; font-size: 0.85rem; }
    .item-card select { margin-bottom: 0.5rem; padding: 0.5rem; font-size: 0.85rem; }
    .item-group + .item-group { margin-top: 1.5rem; }
    .item-group-heading {
      font-size: 0.72rem; font-weight: 700; color: #999; margin-bottom: 0.6rem;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .item-group-heading + .item-card { border-top: none; padding-top: 0; }
    .item-save-btn, .item-del-btn, .item-restore-btn, .item-purge-btn,
    .cat-save-btn, .cat-del-btn, .cat-move-btn {
      width: auto; padding: 0.5rem 0.6rem; font-size: 0.78rem; border-radius: 8px;
      font-weight: 500; cursor: pointer; font-family: inherit;
    }
    .item-save-btn, .cat-save-btn, .cat-move-btn { background: #fff; color: #111; border: 1px solid #e0e0e0; }
    .item-save-btn:hover:not(:disabled), .cat-save-btn:hover:not(:disabled), .cat-move-btn:hover:not(:disabled) { background: #f5f5f5; }
    .cat-move-btn:disabled { background: #fff; color: #ccc; }
    .item-del-btn, .item-purge-btn, .cat-del-btn { background: #fff; color: #c00; border: 1px solid #f5c0c0; }
    .item-del-btn:hover:not(:disabled), .item-purge-btn:hover:not(:disabled), .cat-del-btn:hover:not(:disabled) { background: #fef0f0; }
    .item-restore-btn { background: #fff; color: #1a7a1a; border: 1px solid #bfe3bf; }
    .item-restore-btn:hover:not(:disabled) { background: #eef8ee; }
    .add-item-form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #f0f0f0; }
    .cat-row { display: flex; gap: 0.4rem; align-items: center; padding: 0.5rem 0; border-top: 1px solid #f0f0f0; }
    .cat-row:first-child { border-top: none; padding-top: 0; }
    .cat-row input { flex: 1 1 auto; min-width: 0; margin-bottom: 0; padding: 0.5rem; font-size: 0.85rem; }
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
  <div class="wrap">

    <div class="card">
      <div class="status-row">
        <div class="status-label">
          <span class="dot" id="dot"></span>
          <div>
            <div class="status-main" id="statusText">Checking&#x2026;</div>
            <div class="status-sub"  id="lastSeenText"></div>
            <div class="status-sub"  id="wifiText"></div>
          </div>
        </div>
        <div class="status-actions">
          <button class="icon-btn" id="refreshBtn" title="Refresh">&#x21BB;</button>
          <button class="secondary" id="logoutBtn" style="width:auto;padding:0.4rem 0.9rem;font-size:0.85rem">Sign out</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Sales</h2>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-num" id="statTodayCount">&#x2014;</div>
          <div class="stat-label">Today</div>
        </div>
        <div class="stat">
          <div class="stat-num" id="statTodayRev">&#x2014;</div>
          <div class="stat-label">Revenue today</div>
        </div>
        <div class="stat">
          <div class="stat-num" id="statTotalCount">&#x2014;</div>
          <div class="stat-label">All time</div>
        </div>
        <div class="stat">
          <div class="stat-num" id="statTotalRev">&#x2014;</div>
          <div class="stat-label">All-time revenue</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Controls</h2>
      <div class="btn-row">
        <button id="unlockBtn">&#x1F513; Unlock</button>
        <button id="lockBtn" class="secondary">&#x1F512; Lock</button>
      </div>
      <button id="rebootBtn" class="secondary" style="margin-top:0.6rem">&#x1F504; Reboot device</button>
      <p class="msg" id="controlMsg"></p>
    </div>

    <div class="card">
      <h2>Categories</h2>
      <p class="status-sub" style="margin:-0.5rem 0 1rem">Sections on the buy page, shown in this order. Items without a category go last, under &ldquo;Other&rdquo;.</p>
      <div id="categoriesList"><p style="color:#999;font-size:0.85rem">Loading&#x2026;</p></div>
      <div class="add-item-form">
        <input type="text" id="newCategoryName" placeholder="Category name, e.g. Drinks">
        <button id="addCategoryBtn">Add category</button>
        <p class="msg" id="addCategoryMsg"></p>
      </div>
    </div>

    <div class="card">
      <h2>Items</h2>
      <div id="itemsList"><p style="color:#999;font-size:0.85rem">Loading&#x2026;</p></div>
      <div class="add-item-form">
        <input type="text" id="newItemName" placeholder="Item name">
        <input type="number" id="newItemPrice" step="0.01" min="0.01" placeholder="Price ($)">
        <input type="number" id="newItemStock" step="1" min="0" placeholder="Initial stock">
        <select id="newItemCategory"><option value="">No category</option></select>
        <button id="addItemBtn">Add item</button>
        <p class="msg" id="addItemMsg"></p>
      </div>
    </div>

    <div class="card">
      <h2>WiFi Settings</h2>
      <input type="text"     id="wifiSsid" placeholder="Network name (SSID)" autocomplete="off">
      <input type="password" id="wifiPass" placeholder="Password" autocomplete="new-password">
      <button id="wifiBtn">Update WiFi</button>
      <p class="msg" id="wifiMsg"></p>
      <hr style="border:none;border-top:1px solid #f0f0f0;margin:1rem 0">
      <button class="secondary" id="wifiResetBtn" style="color:#c00;border-color:#f5c0c0">&#x26A0;&#xFE0F; Reset WiFi &amp; enter setup mode</button>
      <p class="msg" id="wifiResetMsg"></p>
    </div>

    <div class="card">
      <h2>Settings</h2>
      <label class="field-label" for="tzSelect">Store time zone (when &ldquo;Today&rdquo; starts)</label>
      <select id="tzSelect"></select>
      <p class="status-sub" id="tzNow" style="margin:-0.35rem 0 0.75rem"></p>
      <button id="settingsBtn">Save</button>
      <p class="msg" id="settingsMsg"></p>
    </div>

    <div class="card">
      <h2>Firmware Update</h2>
      <input type="url" id="otaUrl" placeholder="https://github.com/.../firmware.bin">
      <button id="otaBtn">Push Update</button>
      <p class="msg" id="otaMsg"></p>
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
        <h2 style="margin-bottom:0">Recent Orders</h2>
        <button id="clearOrdersBtn" class="secondary" style="width:auto;padding:0.3rem 0.75rem;font-size:0.8rem;color:#c00;border-color:#f5c0c0">Clear all</button>
      </div>
      <div id="ordersList"><p style="color:#999;font-size:0.85rem">Loading&#x2026;</p></div>
    </div>

    <div class="card">
      <h2>Activity</h2>
      <div id="eventLog"><p style="color:#999;font-size:0.83rem">No events yet.</p></div>
    </div>

  </div>
</div>

<script>
  var token    = localStorage.getItem('adminToken');
  var DEVICEID = '${DEVICE_ID()}';

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function(r) {
      if (r.status === 401) { doLogout(); throw new Error('Wrong password.'); }
      return r.json().then(function(data) {
        if (!r.ok) throw new Error(data.error || 'Request failed');
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
    localStorage.removeItem('adminToken');
    token = null;
    loginEl.style.display = 'flex';
    dashboardEl.style.display = 'none';
    passInput.value = '';
  }
  document.getElementById('logoutBtn').addEventListener('click', doLogout);

  document.getElementById('refreshBtn').addEventListener('click', function() {
    var icon = this;
    icon.classList.remove('spinning');
    void icon.offsetWidth; // force reflow to restart animation
    icon.classList.add('spinning');
    icon.addEventListener('animationend', function() { icon.classList.remove('spinning'); }, { once: true });
    refreshStatus();
    refreshStats();
    refreshOrders();
    refreshCategories();
    refreshEvents();
  });

  function showDashboard() {
    loginEl.style.display = 'none';
    dashboardEl.style.display = 'block';
    refreshStatus();
    refreshStats();
    refreshOrders();
    refreshCategories();
    refreshEvents();
    loadSettings();
    setInterval(refreshStatus, 15000);
    setInterval(showStoreTime, 30000);
    setInterval(refreshStats,  60000);
    setInterval(refreshOrders, 30000);
    setInterval(refreshItems,  30000);
    setInterval(refreshEvents, 10000);
  }

  function eventColor(evt) {
    if (evt === 'auth_failed' || evt === 'ota_failed' || evt === 'offline' || evt === 'unlock_timeout') return '#c00';
    if (evt === 'ota_start' || evt === 'rebooting' || evt === 'wifi_updating' || evt === 'wifi_reset') return '#b45309';
    if (evt === 'online' || evt === 'unlocked' || evt === 'ota_complete') return '#1a7a1a';
    return '#888';
  }

  function refreshEvents() {
    api('GET', '/admin/events').then(function(events) {
      var el = document.getElementById('eventLog');
      if (!events.length) {
        el.innerHTML = '<p style="color:#999;font-size:0.83rem">No events yet.</p>';
        return;
      }
      el.innerHTML = '<ul class="event-list">' +
        events.map(function(e) {
          var color = eventColor(e.event);
          return '<li class="event-item">' +
            '<span class="event-dot" style="background:' + color + '"></span>' +
            '<span class="event-name">' + e.event.replace(/_/g, ' ') + '</span>' +
            '<span class="event-time">' + timeAgo(e.ts) + '</span>' +
            '</li>';
        }).join('') + '</ul>';
    }).catch(function() {});
  }

  function refreshStatus() {
    api('GET', '/admin/status').then(function(d) {
      var dot     = document.getElementById('dot');
      var text    = document.getElementById('statusText');
      var sub     = document.getElementById('lastSeenText');
      var wifiEl  = document.getElementById('wifiText');
      dot.className    = 'dot ' + (d.online ? 'online' : 'offline');
      text.textContent = (d.online ? 'Online' : 'Offline') + ' — ' + DEVICEID;
      sub.textContent  = d.lastSeen ? 'Last seen ' + timeAgo(d.lastSeen) : '';
      if (d.wifi && d.wifi.ssid) {
        var rssi  = d.wifi.rssi;
        var qual  = rssi >= -55 ? 'excellent' : rssi >= -65 ? 'good' : rssi >= -75 ? 'fair' : 'weak';
        var ver   = d.wifi.version ? '  v' + d.wifi.version : '';
        wifiEl.textContent = d.wifi.ssid + '  (' + qual + ', ' + rssi + ' dBm)' + ver;
      } else {
        wifiEl.textContent = '';
      }
    }).catch(function() {});
  }

  function refreshStats() {
    api('GET', '/admin/stats').then(function(s) {
      document.getElementById('statTodayCount').textContent = s.todayCount;
      document.getElementById('statTodayRev').textContent   = '$' + (s.todayRevenueCents / 100).toFixed(2);
      document.getElementById('statTotalCount').textContent = s.totalCount;
      document.getElementById('statTotalRev').textContent   = '$' + (s.totalRevenueCents / 100).toFixed(2);
    }).catch(function() {});
  }

  function refreshOrders() {
    api('GET', '/admin/orders').then(function(orders) {
      var el = document.getElementById('ordersList');
      if (!orders.length) {
        el.innerHTML = '<p style="color:#999;font-size:0.85rem">No orders yet.</p>';
        return;
      }
      el.innerHTML = '<table><thead><tr><th>ID</th><th>Items</th><th>Status</th><th>Qty</th><th>When</th><th></th></tr></thead><tbody>' +
        orders.map(function(o) {
          var canRefund = o.status === 'complete' || o.status === 'dispensing';
          var action = (canRefund ? '<button class="refund-btn" data-id="' + o.id + '">Refund</button> ' : '') +
            '<button class="delete-btn" data-id="' + o.id + '">&#x2715;</button>';
          var lineItems = o.items || [];
          var itemsSummary = lineItems.length
            ? lineItems.map(function(it) { return it.quantity + '&times; ' + escapeAttr(it.item_name); }).join(', ')
            : '&#x2014;';
          var totalQty = lineItems.reduce(function(sum, it) { return sum + it.quantity; }, 0);
          return '<tr>' +
            '<td>' + o.id.slice(0, 8) + '&hellip;</td>' +
            '<td>' + itemsSummary + '</td>' +
            '<td><span class="badge ' + o.status + '">' + o.status + '</span></td>' +
            '<td>' + totalQty + '</td>' +
            '<td>' + timeAgo(o.created_at) + '</td>' +
            '<td>' + action + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
    }).catch(function() {});
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Cached so the 30s item refresh can fill each item's category dropdown
  // without refetching; reloaded whenever a category changes.
  var categories = [];

  function categoryOptions(selectedId) {
    return '<option value="">No category</option>' + categories.map(function(c) {
      return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' + escapeAttr(c.name) + '</option>';
    }).join('');
  }

  function refreshCategories() {
    api('GET', '/admin/categories').then(function(cats) {
      categories = cats;
      var el = document.getElementById('categoriesList');
      el.innerHTML = cats.length ? cats.map(function(c, i) {
        return '<div class="cat-row" data-id="' + c.id + '">' +
          '<input class="cat-name-input" value="' + escapeAttr(c.name) + '">' +
          '<button class="cat-move-btn" data-dir="up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>&#x2191;</button>' +
          '<button class="cat-move-btn" data-dir="down" title="Move down"' + (i === cats.length - 1 ? ' disabled' : '') + '>&#x2193;</button>' +
          '<button class="cat-save-btn">Save</button>' +
          '<button class="cat-del-btn">Delete</button>' +
        '</div>';
      }).join('') : '<p style="color:#999;font-size:0.85rem">No categories yet &#x2014; the buy page shows one plain list.</p>';
      var newItemCategory = document.getElementById('newItemCategory');
      newItemCategory.innerHTML = categoryOptions(newItemCategory.value);
      refreshItems();
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
    req.then(function() { refreshCategories(); })
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
        refreshCategories();
      })
      .catch(function(err) { flashMsg(msg, 'msg err', err.message, 5000); })
      .finally(function() { btn.disabled = false; });
  });

  function refreshItems() {
    api('GET', '/admin/items').then(function(items) {
      var el = document.getElementById('itemsList');
      if (!items.length) {
        el.innerHTML = '<p style="color:#999;font-size:0.85rem">No items yet.</p>';
        return;
      }
      el.innerHTML = groupItems(items).map(function(g) {
        return '<div class="item-group">' +
          (g.name ? '<h3 class="item-group-heading">' + escapeAttr(g.name) + '</h3>' : '') +
          g.items.map(itemCardHtml).join('') +
        '</div>';
      }).join('');
    }).catch(function() {});
  }

  // Same grouping as the buy page: categories in their set order, then
  // uncategorized items last. No heading at all when nothing is categorized.
  function groupItems(items) {
    var byId   = {};
    var groups = categories.map(function(c) { return byId[c.id] = { name: c.name, items: [] }; });
    var none   = { name: 'No category', items: [] };
    items.forEach(function(it) { (byId[it.category_id] || none).items.push(it); });
    var nonEmpty = groups.concat([none]).filter(function(g) { return g.items.length > 0; });
    if (nonEmpty.length === 1 && nonEmpty[0] === none) none.name = null;
    return nonEmpty;
  }

  function itemCardHtml(it) {
    var dollars   = (it.price_cents / 100).toFixed(2);
    var cardCls   = it.active ? 'item-card' : 'item-card item-inactive';
    var disabled  = it.active ? '' : 'disabled';
    var badges    = '';
    if (!it.active) badges += '<span class="item-badge">Inactive</span>';
    else if (it.stock <= 0) badges += '<span class="item-badge oos">Out of stock</span>';
    var actionBtn = it.active
      ? '<button class="item-del-btn" data-id="' + it.id + '">Delete</button>'
      : '<button class="item-restore-btn" data-id="' + it.id + '">Restore</button>' +
        '<button class="item-purge-btn" data-id="' + it.id + '">Delete permanently</button>';
    return '<div class="' + cardCls + '" data-id="' + it.id + '">' +
      '<input class="item-name-input" value="' + escapeAttr(it.name) + '" ' + disabled + '>' +
      badges +
      '<select class="item-category-select" ' + disabled + '>' + categoryOptions(it.category_id) + '</select>' +
      '<div class="item-fields">' +
        '<input class="item-price-input" type="number" step="0.01" min="0.01" value="' + dollars + '" ' + disabled + '>' +
        '<input class="item-stock-input" type="number" step="1" min="0" value="' + it.stock + '" ' + disabled + '>' +
        (it.active ? '<button class="item-save-btn" data-id="' + it.id + '">Save</button>' : '') +
        actionBtn +
      '</div>' +
    '</div>';
  }

  document.getElementById('itemsList').addEventListener('click', function(e) {
    var saveBtn = e.target.closest('.item-save-btn');
    if (saveBtn) {
      var card  = saveBtn.closest('.item-card');
      var id    = saveBtn.getAttribute('data-id');
      var name  = card.querySelector('.item-name-input').value.trim();
      var price = parseFloat(card.querySelector('.item-price-input').value);
      var stock = parseInt(card.querySelector('.item-stock-input').value, 10);
      var categoryId = card.querySelector('.item-category-select').value || null;
      if (!name)          { alert('Name cannot be empty.'); return; }
      if (!(price > 0))   { alert('Enter a valid price.'); return; }
      if (!(stock >= 0))  { alert('Enter a valid stock amount.'); return; }
      saveBtn.disabled = true;
      api('PATCH', '/admin/items/' + id, { name: name, price_cents: Math.round(price * 100), stock: stock, category_id: categoryId })
        .then(function() { refreshItems(); })
        .catch(function(err) { alert('Save failed: ' + err.message); saveBtn.disabled = false; });
      return;
    }
    var delBtn = e.target.closest('.item-del-btn');
    if (delBtn) {
      var delId = delBtn.getAttribute('data-id');
      if (!confirm('Delete this item?')) return;
      delBtn.disabled = true;
      api('DELETE', '/admin/items/' + delId)
        .then(function() { refreshItems(); })
        .catch(function(err) { alert('Delete failed: ' + err.message); delBtn.disabled = false; });
      return;
    }
    var restoreBtn = e.target.closest('.item-restore-btn');
    if (restoreBtn) {
      var restoreId = restoreBtn.getAttribute('data-id');
      restoreBtn.disabled = true;
      api('PATCH', '/admin/items/' + restoreId, { active: true })
        .then(function() { refreshItems(); })
        .catch(function(err) { alert('Restore failed: ' + err.message); restoreBtn.disabled = false; });
      return;
    }
    var purgeBtn = e.target.closest('.item-purge-btn');
    if (purgeBtn) {
      var purgeId   = purgeBtn.getAttribute('data-id');
      var purgeCard = purgeBtn.closest('.item-card');
      var purgeName = purgeCard.querySelector('.item-name-input').value;
      if (!confirm('Permanently delete "' + purgeName + '"? This cannot be undone. Past orders will keep showing its name and price, but you will not be able to restore it.')) return;
      purgeBtn.disabled = true;
      api('DELETE', '/admin/items/' + purgeId + '?force=true')
        .then(function() { refreshItems(); })
        .catch(function(err) { alert('Delete failed: ' + err.message); purgeBtn.disabled = false; });
    }
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

  document.getElementById('ordersList').addEventListener('click', function(e) {
    var refundBtn = e.target.closest('.refund-btn');
    if (refundBtn && !refundBtn.disabled) {
      var orderId = refundBtn.getAttribute('data-id');
      if (!confirm('Issue a refund for order ' + orderId.slice(0, 8) + '?')) return;
      refundBtn.disabled = true;
      api('POST', '/admin/refund/' + orderId).then(function() {
        refreshOrders();
        refreshStats();
      }).catch(function(err) {
        alert('Refund failed: ' + err.message);
        refundBtn.disabled = false;
      });
    }
    var deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn && !deleteBtn.disabled) {
      var orderId = deleteBtn.getAttribute('data-id');
      if (!confirm('Delete order ' + orderId.slice(0, 8) + '? This cannot be undone.')) return;
      deleteBtn.disabled = true;
      api('DELETE', '/admin/orders/' + orderId).then(function() {
        refreshOrders();
        refreshStats();
      }).catch(function(err) {
        alert('Delete failed: ' + err.message);
        deleteBtn.disabled = false;
      });
    }
  });

  document.getElementById('clearOrdersBtn').addEventListener('click', function() {
    if (!confirm('Delete ALL orders? This cannot be undone.')) return;
    var btn = document.getElementById('clearOrdersBtn');
    btn.disabled = true;
    api('DELETE', '/admin/orders').then(function() {
      refreshOrders();
      refreshStats();
    }).catch(function(err) {
      alert('Clear failed: ' + err.message);
    }).finally(function() {
      btn.disabled = false;
    });
  });

  function timeAgo(iso) {
    var s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
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

  function doAction(path, btnId, msgId, label) {
    var btn = document.getElementById(btnId);
    var msg = document.getElementById(msgId);
    btn.disabled = true;
    flashMsg(msg, 'msg', '', 0);
    api('POST', path).then(function() {
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
    doAction('/admin/reboot', 'rebootBtn', 'controlMsg', 'Reboot');
  });

  var otaUrlInput = document.getElementById('otaUrl');
  var otaBtn      = document.getElementById('otaBtn');
  var otaMsg      = document.getElementById('otaMsg');

  otaUrlInput.value = localStorage.getItem('lastOtaUrl') || '';

  otaBtn.addEventListener('click', function() {
    var url = otaUrlInput.value.trim();
    if (!url) { flashMsg(otaMsg, 'msg err', 'Enter a URL.', 4000); return; }
    localStorage.setItem('lastOtaUrl', url);
    otaBtn.disabled = true;
    flashMsg(otaMsg, 'msg', '', 0);
    api('POST', '/admin/ota', { url: url }).then(function() {
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
    api('POST', '/admin/wifi', { ssid: ssid, password: pass }).then(function() {
      flashMsg(wifiMsg, 'msg ok', 'Sent — device will reconnect shortly.', 5000);
      wifiPassInput.value = '';
    }).catch(function(e) {
      flashMsg(wifiMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      wifiBtn.disabled = false;
    });
  });

  var tzSelect    = document.getElementById('tzSelect');
  var tzNow       = document.getElementById('tzNow');
  var settingsBtn = document.getElementById('settingsBtn');
  var settingsMsg = document.getElementById('settingsMsg');

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
      showStoreTime();
    }).catch(function() {});
  }

  tzSelect.addEventListener('change', showStoreTime);

  settingsBtn.addEventListener('click', function() {
    settingsBtn.disabled = true;
    flashMsg(settingsMsg, 'msg', '', 0);
    api('PATCH', '/admin/settings', { timezone: tzSelect.value }).then(function() {
      flashMsg(settingsMsg, 'msg ok', 'Saved.', 4000);
      refreshStats();
    }).catch(function(e) {
      flashMsg(settingsMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      settingsBtn.disabled = false;
    });
  });

  var wifiResetBtn = document.getElementById('wifiResetBtn');
  var wifiResetMsg = document.getElementById('wifiResetMsg');

  wifiResetBtn.addEventListener('click', function() {
    if (!confirm('This will erase WiFi credentials and reboot into setup AP mode. The fridge will be offline until reconfigured. Are you sure?')) return;
    if (!confirm('Second confirmation: fridge goes offline now. Proceed?')) return;
    wifiResetBtn.disabled = true;
    flashMsg(wifiResetMsg, 'msg', '', 0);
    api('POST', '/admin/wifi-reset').then(function() {
      flashMsg(wifiResetMsg, 'msg ok', 'Done — device is rebooting into setup mode.', 5000);
    }).catch(function(e) {
      flashMsg(wifiResetMsg, 'msg err', e.message, 5000);
    }).finally(function() {
      wifiResetBtn.disabled = false;
    });
  });

  if (token) { showDashboard(); } else { loginEl.style.display = 'flex'; }
</script>

</body>
</html>`);
});

// ── API endpoints ─────────────────────────────────────────────────────────────

router.get('/events', requireAdmin, (req, res) => {
  res.json(getRecentEvents());
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

router.post('/wifi', requireAdmin, (req, res) => {
  const { ssid, password } = req.body;
  if (!ssid || !password) return res.status(400).json({ error: 'ssid and password required' });
  if (ssid.includes('"') || password.includes('"'))
    return res.status(400).json({ error: 'Credentials may not contain double-quote characters' });
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    publishWifiUpdate(device_id, ssid, password);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/wifi-reset', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    publishWifiReset(device_id);
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

router.get('/orders', requireAdmin, async (req, res) => {
  try {
    res.json(await getRecentOrders(20));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/unlock', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    publishAdminUnlock(device_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/lock', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  try {
    publishLock(device_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reboot', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  if (!isDeviceOnline(device_id)) return res.status(503).json({ error: 'Device is offline' });
  try {
    publishReboot(device_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/orders/:order_id', requireAdmin, async (req, res) => {
  try {
    await deleteOrder(req.params.order_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete('/orders', requireAdmin, async (req, res) => {
  try {
    const count = await deleteAllOrders();
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
    await createRefund({ payment_id: order.square_payment_id, order_id, amount_cents });
    await updateOrder(order_id, { status: 'refunded' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ota', requireAdmin, (req, res) => {
  const { url } = req.body;
  const device_id = DEVICE_ID();
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    publishOTA(device_id, url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
