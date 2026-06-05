'use strict';
const { Router } = require('express');
const {
  publishOTA, publishLock, publishUnlock, publishReboot, publishWifiUpdate, publishWifiReset,
  isDeviceOnline, getDeviceLastSeen, getDeviceWifiInfo, getRecentEvents,
} = require('../mqttClient');
const { getRecentOrders, getOrderStats, getOrder, updateOrder, deleteOrder, deleteAllOrders } = require('../orderStore');
const { createRefund } = require('../square');

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
    input {
      width: 100%; border: 1.5px solid #e0e0e0; border-radius: 10px;
      padding: 0.75rem; font-size: 0.95rem; margin-bottom: 0.75rem; font-family: inherit;
    }
    input:focus { outline: none; border-color: #999; }
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
    .badge.pending    { background: #f5f5f5; color: #666; }
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
    refreshEvents();
  });

  function showDashboard() {
    loginEl.style.display = 'none';
    dashboardEl.style.display = 'block';
    refreshStatus();
    refreshStats();
    refreshOrders();
    refreshEvents();
    setInterval(refreshStatus, 15000);
    setInterval(refreshStats,  60000);
    setInterval(refreshOrders, 30000);
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
        wifiEl.textContent = d.wifi.ssid + '  (' + qual + ', ' + rssi + ' dBm)';
      } else {
        wifiEl.textContent = '';
      }
    }).catch(function() {});
  }

  function refreshStats() {
    api('GET', '/admin/stats').then(function(s) {
      var price = (s.itemPriceCents || 0) / 100;
      document.getElementById('statTodayCount').textContent = s.todayCount;
      document.getElementById('statTodayRev').textContent   = '$' + (s.todayCount  * price).toFixed(2);
      document.getElementById('statTotalCount').textContent = s.totalCount;
      document.getElementById('statTotalRev').textContent   = '$' + (s.totalCount  * price).toFixed(2);
    }).catch(function() {});
  }

  function refreshOrders() {
    api('GET', '/admin/orders').then(function(orders) {
      var el = document.getElementById('ordersList');
      if (!orders.length) {
        el.innerHTML = '<p style="color:#999;font-size:0.85rem">No orders yet.</p>';
        return;
      }
      el.innerHTML = '<table><thead><tr><th>ID</th><th>Status</th><th>Qty</th><th>When</th><th></th></tr></thead><tbody>' +
        orders.map(function(o) {
          var canRefund = o.status === 'complete' || o.status === 'dispensing';
          var action = (canRefund ? '<button class="refund-btn" data-id="' + o.id + '">Refund</button> ' : '') +
            '<button class="delete-btn" data-id="' + o.id + '">&#x2715;</button>';
          return '<tr>' +
            '<td>' + o.id.slice(0, 8) + '&hellip;</td>' +
            '<td><span class="badge ' + o.status + '">' + o.status + '</span></td>' +
            '<td>' + (o.quantity || 1) + '</td>' +
            '<td>' + timeAgo(o.created_at) + '</td>' +
            '<td>' + action + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
    }).catch(function() {});
  }

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

  function doAction(path, btnId, msgId, label) {
    var btn = document.getElementById(btnId);
    var msg = document.getElementById(msgId);
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = '';
    api('POST', path).then(function() {
      msg.className = 'msg ok';
      msg.textContent = label + ' sent.';
    }).catch(function(e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
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
    if (!url) { otaMsg.className = 'msg err'; otaMsg.textContent = 'Enter a URL.'; return; }
    localStorage.setItem('lastOtaUrl', url);
    otaBtn.disabled = true;
    otaMsg.className = 'msg';
    otaMsg.textContent = '';
    api('POST', '/admin/ota', { url: url }).then(function() {
      otaMsg.className = 'msg ok';
      otaMsg.textContent = 'OTA command sent — device will reboot shortly.';
    }).catch(function(e) {
      otaMsg.className = 'msg err';
      otaMsg.textContent = e.message;
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
      wifiMsg.className = 'msg err';
      wifiMsg.textContent = 'Enter both network name and password.';
      return;
    }
    wifiBtn.disabled = true;
    wifiMsg.className = 'msg';
    wifiMsg.textContent = '';
    api('POST', '/admin/wifi', { ssid: ssid, password: pass }).then(function() {
      wifiMsg.className = 'msg ok';
      wifiMsg.textContent = 'Sent — device will reconnect shortly.';
      wifiPassInput.value = '';
    }).catch(function(e) {
      wifiMsg.className = 'msg err';
      wifiMsg.textContent = e.message;
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
    wifiResetMsg.className = 'msg';
    wifiResetMsg.textContent = '';
    api('POST', '/admin/wifi-reset').then(function() {
      wifiResetMsg.className = 'msg ok';
      wifiResetMsg.textContent = 'Done — device is rebooting into setup mode.';
    }).catch(function(e) {
      wifiResetMsg.className = 'msg err';
      wifiResetMsg.textContent = e.message;
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
    const stats = await getOrderStats();
    res.json({ ...stats, itemPriceCents: parseInt(process.env.ITEM_PRICE_CENTS || '0', 10) });
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
    publishUnlock(device_id, `admin-${Date.now()}`);
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
    const unitCents = parseInt(process.env.ITEM_PRICE_CENTS || '300', 10);
    await createRefund({ payment_id: order.square_payment_id, order_id, amount_cents: (order.quantity || 1) * unitCents });
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
