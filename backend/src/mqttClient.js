'use strict';
const mqtt = require('mqtt');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const emitter = new EventEmitter();

// Last heartbeat timestamp per device_id → Date
const deviceHeartbeats = new Map();

// Tracks which order_id is currently being fulfilled per device_id.
// Used to correlate device events back to orders until firmware includes
// order_id in event payloads (Phase 3 firmware update).
const pendingOrders = new Map(); // device_id → order_id

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
    rejectUnauthorized: true, // HiveMQ Cloud has a valid CA-signed cert
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('MQTT connection timeout after 10s')),
      10_000
    );

    client.once('connect', () => {
      clearTimeout(timeout);
      console.log('[MQTT] Connected to broker');

      // Subscribe to all device events and status topics
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
  // topic shape: fridge/{device_id}/{type}
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'fridge') return;

  const [, device_id, type] = parts;

  let data;
  try {
    data = JSON.parse(rawPayload.toString());
  } catch {
    // Plain string payload (e.g. "unlocked", "offline")
    data = { event: rawPayload.toString() };
  }

  if (type === 'status') {
    deviceHeartbeats.set(device_id, new Date());
    const state = data.state || data.event || data;
    if (state === 'offline') {
      console.warn(`[MQTT] Device ${device_id} went offline`);
    } else {
      console.log(`[MQTT] Heartbeat from ${device_id}`);
    }
    return;
  }

  if (type === 'evt') {
    // Normalise: firmware may send a plain string or {event, order_id, ...}
    const event    = data.event || (typeof data === 'string' ? data : null);
    const order_id = data.order_id || null;
    console.log(`[MQTT] Event from ${device_id}: ${event}`, order_id ? `(order ${order_id})` : '');
    emitter.emit('deviceEvent', { device_id, event, order_id });
  }
}

// ── Publish unlock command ────────────────────────────────────────────────────

function publishUnlock(device_id, order_id) {
  if (!client?.connected) {
    throw new Error('MQTT client not connected');
  }

  const secret = process.env.DEVICE_SECRET;
  if (!secret) throw new Error('DEVICE_SECRET env var not set');

  // Build payload, sign it, then add sig
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

  // Track which order is pending on this device so events can be correlated
  pendingOrders.set(device_id, order_id);

  console.log(`[MQTT] Published unlock → ${device_id} / order ${order_id}`);
}

// HMAC-SHA256 over a canonical (key-sorted) JSON serialisation of the payload.
// The firmware verifies the same way. sig field is excluded before signing.
function signPayload(payload, secret) {
  const { sig: _omit, ...rest } = payload;
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(rest).sort())
  );
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns true if the device has sent a heartbeat within maxAgeMs (default 90s).
// The ESP32 heartbeats every 30s; 90s gives three missed beats before "offline".
function isDeviceOnline(device_id, maxAgeMs = 90_000) {
  const last = deviceHeartbeats.get(device_id);
  if (!last) return false;
  return Date.now() - last.getTime() < maxAgeMs;
}

function getPendingOrder(device_id) {
  return pendingOrders.get(device_id) || null;
}

function clearPendingOrder(device_id) {
  pendingOrders.delete(device_id);
}

module.exports = {
  connectMQTT,
  publishUnlock,
  isDeviceOnline,
  getPendingOrder,
  clearPendingOrder,
  emitter,
};
