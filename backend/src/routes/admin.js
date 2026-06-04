'use strict';
const { Router } = require('express');
const { publishOTA, publishLock, publishUnlock, isDeviceOnline } = require('../mqttClient');
const { getRecentOrders } = require('../orderStore');

const DEVICE_ID = () => process.env.DEVICE_ID || 'onigiri';

const router = Router();

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET not configured' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── HTML page ─────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fridge Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f4f4ef; min-height: 100dvh; }
    #login    { display: none; align-items: center; justify-content: center; min-height: 100dvh; padding: 1.5rem; }
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
    .status-label { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; font-size: 0.95rem; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ccc; flex-shrink: 0; }
    .dot.online  { background: #1a7a1a; }
    .dot.offline { background: #c00; }
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
          <span id="statusText">Checking&#x2026;</span>
        </div>
        <button class="secondary" id="logoutBtn" style="width:auto;padding:0.4rem 0.9rem;font-size:0.85rem">Sign out</button>
      </div>
    </div>

    <div class="card">
      <h2>Controls</h2>
      <div class="btn-row">
        <button id="unlockBtn">&#x1F513; Unlock</button>
        <button id="lockBtn" class="secondary">&#x1F512; Lock</button>
      </div>
      <p class="msg" id="controlMsg"></p>
    </div>

    <div class="card">
      <h2>Firmware Update</h2>
      <input type="url" id="otaUrl" placeholder="https://github.com/.../firmware.bin">
      <button id="otaBtn">Push Update</button>
      <p class="msg" id="otaMsg"></p>
    </div>

    <div class="card">
      <h2>Recent Orders</h2>
      <div id="ordersList"><p style="color:#999;font-size:0.85rem">Loading&#x2026;</p></div>
    </div>

  </div>
</div>

<script>
  var token = sessionStorage.getItem("adminToken");
  var DEVICE_ID = "${DEVICE_ID()}";

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function(r) {
      if (r.status === 401) { doLogout(); throw new Error("Wrong password."); }
      return r.json().then(function(data) {
        if (!r.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  var loginEl     = document.getElementById("login");
  var dashboardEl = document.getElementById("dashboard");
  var passInput   = document.getElementById("passInput");
  var loginBtn    = document.getElementById("loginBtn");
  var loginErr    = document.getElementById("loginErr");

  loginBtn.addEventListener("click", tryLogin);
  passInput.addEventListener("keydown", function(e) { if (e.key === "Enter") tryLogin(); });

  function tryLogin() {
    loginErr.textContent = "";
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in...";
    token = passInput.value;
    api("GET", "/admin/status").then(function() {
      sessionStorage.setItem("adminToken", token);
      showDashboard();
    }).catch(function(e) {
      loginErr.textContent = e.message;
      token = null;
    }).finally(function() {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign in";
    });
  }

  function doLogout() {
    sessionStorage.removeItem("adminToken");
    token = null;
    loginEl.style.display = "flex";
    dashboardEl.style.display = "none";
    passInput.value = "";
  }
  document.getElementById("logoutBtn").addEventListener("click", doLogout);

  function showDashboard() {
    loginEl.style.display = "none";
    dashboardEl.style.display = "block";
    refreshStatus();
    refreshOrders();
    setInterval(refreshStatus, 15000);
  }

  function refreshStatus() {
    api("GET", "/admin/status").then(function(d) {
      var dot  = document.getElementById("dot");
      var text = document.getElementById("statusText");
      dot.className    = "dot " + (d.online ? "online" : "offline");
      text.textContent = (d.online ? "Online" : "Offline") + " — " + DEVICE_ID;
    }).catch(function() {});
  }

  function refreshOrders() {
    api("GET", "/admin/orders").then(function(orders) {
      var el = document.getElementById("ordersList");
      if (!orders.length) {
        el.innerHTML = '<p style="color:#999;font-size:0.85rem">No orders yet.</p>';
        return;
      }
      el.innerHTML = '<table><thead><tr><th>ID</th><th>Status</th><th>When</th></tr></thead><tbody>' +
        orders.map(function(o) {
          return '<tr><td>' + o.id.slice(0, 8) + '&hellip;</td>' +
            '<td><span class="badge ' + o.status + '">' + o.status + '</span></td>' +
            '<td>' + timeAgo(o.created_at) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function() {});
  }

  function timeAgo(iso) {
    var s = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (s < 60)    return s + "s ago";
    if (s < 3600)  return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function doAction(path, btnId, msgId, label) {
    var btn = document.getElementById(btnId);
    var msg = document.getElementById(msgId);
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "";
    api("POST", path).then(function() {
      msg.className = "msg ok";
      msg.textContent = label + " sent.";
    }).catch(function(e) {
      msg.className = "msg err";
      msg.textContent = e.message;
    }).finally(function() {
      btn.disabled = false;
    });
  }

  document.getElementById("unlockBtn").addEventListener("click", function() {
    doAction("/admin/unlock", "unlockBtn", "controlMsg", "Unlock");
  });
  document.getElementById("lockBtn").addEventListener("click", function() {
    doAction("/admin/lock", "lockBtn", "controlMsg", "Lock");
  });

  var otaUrlInput = document.getElementById("otaUrl");
  var otaBtn      = document.getElementById("otaBtn");
  var otaMsg      = document.getElementById("otaMsg");

  otaUrlInput.value = localStorage.getItem("lastOtaUrl") || "";

  otaBtn.addEventListener("click", function() {
    var url = otaUrlInput.value.trim();
    if (!url) { otaMsg.className = "msg err"; otaMsg.textContent = "Enter a URL."; return; }
    localStorage.setItem("lastOtaUrl", url);
    otaBtn.disabled = true;
    otaMsg.className = "msg";
    otaMsg.textContent = "";
    api("POST", "/admin/ota", { url: url }).then(function() {
      otaMsg.className = "msg ok";
      otaMsg.textContent = "OTA command sent — device will reboot shortly.";
    }).catch(function(e) {
      otaMsg.className = "msg err";
      otaMsg.textContent = e.message;
    }).finally(function() {
      otaBtn.disabled = false;
    });
  });

  if (token) { showDashboard(); } else { loginEl.style.display = "flex"; }
</script>

</body>
</html>`);
});

// ── API endpoints ─────────────────────────────────────────────────────────────

router.get('/status', requireAdmin, (req, res) => {
  const device_id = DEVICE_ID();
  res.json({ device_id, online: isDeviceOnline(device_id) });
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
