'use strict';
const mqtt = require('mqtt');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const emitter = new EventEmitter();

// Last heartbeat timestamp per device_id → Date
const deviceHeartbeats = new Map();

// Devices whose most recent unlock came from the admin panel rather than a
// customer purchase. Door events during an admin unlock (restocking, etc.)
// aren't attributed to any order — otherwise opening the fridge shortly
// after a sale could complete that sale based on the admin's door activity.
// Cleared by the next customer unlock.
const adminUnlocks = new Set(); // device_id

const MAX_EVENTS      = 50;
const recentEvents    = []; // newest-first ring buffer
const otaPending      = new Set(); // devices mid-OTA (ota_start seen, not yet back online)
const deviceWifiInfo  = new Map(); // device_id → { ssid, rssi, ts }

function pushEvent(device_id, event) {
  recentEvents.unshift({ device_id, event, ts: new Date().toISOString() });
  if (recentEvents.length > MAX_EVENTS) recentEvents.pop();
}

function getRecentEvents() {
  return recentEvents.slice();
}

let client = null;

// ── Connection ────────────────────────────────────────────────────────────────

async function connectMQTT() {
  const {
    HIVEMQ_HOST,
    HIVEMQ_PORT = '8883',
    HIVEMQ_USERNAME,
    HIVEMQ_PASSWORD,
  } = process.env;

  if (!HIVEMQ_HOST || !HIVEMQ_USERNAME || !HIVEMQ_PASSWORD) {
    throw new Error('Missing HIVEMQ_HOST, HIVEMQ_USERNAME, or HIVEMQ_PASSWORD env vars');
  }

  client = mqtt.connect(`mqtts://${HIVEMQ_HOST}:${HIVEMQ_PORT}`, {
    username: HIVEMQ_USERNAME,
    password: HIVEMQ_PASSWORD,
    clientId: `backend-${uuidv4()}`,
    reconnectPeriod: 5000,
    rejectUnauthorized: true,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('MQTT connection timeout after 10s')),
      10_000
    );

    client.once('connect', () => {
      clearTimeout(timeout);
      console.log('[MQTT] Connected to broker');

      client.subscribe('fridge/+/evt',    { qos: 1 });
      client.subscribe('fridge/+/status', { qos: 0 });

      client.on('message',   handleMessage);
      client.on('error',     (err) => console.error('[MQTT] Error:', err));
      client.on('reconnect', ()    => console.log('[MQTT] Reconnecting...'));
      client.on('offline',   ()    => console.warn('[MQTT] Offline'));

      resolve();
    });

    client.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Incoming message handler ──────────────────────────────────────────────────

function handleMessage(topic, rawPayload) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'fridge') return;

  const [, device_id, type] = parts;

  if (type === 'status') {
    const raw = rawPayload.toString();
    if (raw === 'offline') {
      deviceHeartbeats.delete(device_id);
      pushEvent(device_id, 'offline');
      console.warn(`[MQTT] Device ${device_id} went offline`);
    } else {
      const wasOffline = !deviceHeartbeats.has(device_id);
      deviceHeartbeats.set(device_id, new Date());
      if (wasOffline) {
        if (otaPending.has(device_id)) {
          otaPending.delete(device_id);
          pushEvent(device_id, 'ota_complete');
        } else {
          pushEvent(device_id, 'online');
        }
      }
      console.log(`[MQTT] Heartbeat from ${device_id}`);
    }
    return;
  }

  if (type === 'evt') {
    const raw = rawPayload.toString();
    let event    = null;
    let order_id = null;

    let parsed = null;
    try {
      parsed   = JSON.parse(raw);
      event    = parsed.event    ?? parsed.evt ?? null;
      order_id = parsed.order_id ?? null;
    } catch {
      event = raw;
    }

    if (!event) {
      console.warn(`[MQTT] Unrecognised evt payload from ${device_id}: ${raw}`);
      return;
    }

    if (event === 'wifi_info' && parsed) {
      deviceWifiInfo.set(device_id, {
        ssid:    parsed.ssid    ?? null,
        rssi:    parsed.rssi    ?? null,
        version: parsed.version ?? null,
        ts:      new Date().toISOString(),
      });
      return; // metadata only — not shown in activity log
    }

    if (event === 'ota_start') {
      otaPending.add(device_id);
      deviceHeartbeats.delete(device_id); // clean disconnect won't trigger LWT, so force offline state
    }
    if (event === 'ota_failed') otaPending.delete(device_id);
    pushEvent(device_id, event);
    console.log(`[MQTT] Event from ${device_id}: ${event}`, order_id ? `(order ${order_id})` : '');
    emitter.emit('deviceEvent', { device_id, event, order_id });
  }
}

// ── Publish unlock command ────────────────────────────────────────────────────

function publishLock(device_id) {
  if (!client?.connected) throw new Error('MQTT client not connected');
  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:   'lock',
    nonce: uuidv4(),
    ts:    Math.floor(Date.now() / 1000),
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );
  console.log(`[MQTT] Published lock → ${device_id}`);
}

function publishOTA(device_id, url) {
  if (!client?.connected) throw new Error('MQTT client not connected');
  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:   'ota',
    nonce: uuidv4(),
    ts:    Math.floor(Date.now() / 1000),
    url,
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );
  console.log(`[MQTT] Published OTA → ${device_id} / ${url}`);
}

function publishUnlock(device_id, order_id) {
  _publishUnlockCmd(device_id, order_id);
  adminUnlocks.delete(device_id);
}

// Admin-panel unlock — not tied to any customer order. The firmware still
// expects an order_id in the signed command, so send a placeholder.
function publishAdminUnlock(device_id) {
  _publishUnlockCmd(device_id, `admin-${Date.now()}`);
  adminUnlocks.add(device_id);
}

function _publishUnlockCmd(device_id, order_id) {
  if (!client?.connected) {
    throw new Error('MQTT client not connected');
  }

  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:      'unlock',
    order_id,
    nonce:    uuidv4(),
    ts:       Math.floor(Date.now() / 1000),
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );

  console.log(`[MQTT] Published unlock → ${device_id} / order ${order_id}`);
}

function publishReboot(device_id) {
  if (!client?.connected) throw new Error('MQTT client not connected');
  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:   'reboot',
    nonce: uuidv4(),
    ts:    Math.floor(Date.now() / 1000),
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );
  console.log(`[MQTT] Published reboot → ${device_id}`);
}

function getDeviceLastSeen(device_id) {
  return deviceHeartbeats.get(device_id) || null;
}

function getDeviceWifiInfo(device_id) {
  return deviceWifiInfo.get(device_id) || null;
}

function publishWifiReset(device_id) {
  if (!client?.connected) throw new Error('MQTT client not connected');
  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:   'wifi_reset',
    nonce: uuidv4(),
    ts:    Math.floor(Date.now() / 1000),
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );
  console.log(`[MQTT] Published wifi_reset → ${device_id}`);
}

function publishWifiUpdate(device_id, ssid, password) {
  if (!client?.connected) throw new Error('MQTT client not connected');
  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  const payload = {
    cmd:      'wifi_update',
    nonce:    uuidv4(),
    ts:       Math.floor(Date.now() / 1000),
    ssid,
    password,
  };
  payload.sig = signPayload(payload, secret);

  client.publish(
    `fridge/${device_id}/cmd`,
    JSON.stringify(payload),
    { qos: 1 }
  );
  console.log(`[MQTT] Published wifi_update → ${device_id} / ssid: ${ssid}`);
}

function signPayload(payload, secret) {
  const { sig: _omit, ...rest } = payload;
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(rest).sort())
  );
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isDeviceOnline(device_id, maxAgeMs = 90_000) {
  const last = deviceHeartbeats.get(device_id);
  if (!last) return false;
  return Date.now() - last.getTime() < maxAgeMs;
}

function isAdminUnlockActive(device_id) {
  return adminUnlocks.has(device_id);
}

module.exports = {
  connectMQTT,
  publishUnlock,
  publishAdminUnlock,
  publishLock,
  publishOTA,
  publishReboot,
  publishWifiReset,
  publishWifiUpdate,
  isDeviceOnline,
  getDeviceLastSeen,
  getDeviceWifiInfo,
  getRecentEvents,
  isAdminUnlockActive,
  emitter,
};