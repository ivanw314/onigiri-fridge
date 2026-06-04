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
      console.warn(`[MQTT] Device ${device_id} went offline`);
    } else {
      deviceHeartbeats.set(device_id, new Date());
      console.log(`[MQTT] Heartbeat from ${device_id}`);
    }
    return;
  }

  if (type === 'evt') {
    const raw = rawPayload.toString();
    let event    = null;
    let order_id = null;

    try {
      // Firmware may eventually publish JSON: { event, order_id }
      const parsed = JSON.parse(raw);
      event    = parsed.event    ?? parsed.evt ?? null;
      order_id = parsed.order_id ?? null;
    } catch {
      // Current Phase 2 firmware publishes plain strings: "unlocked", "door_closed", etc.
      event = raw;
    }

    if (!event) {
      // Log the raw payload so we can see exactly what the firmware sent
      console.warn(`[MQTT] Unrecognised evt payload from ${device_id}: ${raw}`);
      return;
    }

    console.log(`[MQTT] Event from ${device_id}: ${event}`, order_id ? `(order ${order_id})` : '');
    emitter.emit('deviceEvent', { device_id, event, order_id });
  }
}

// ── Publish unlock command ────────────────────────────────────────────────────

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

  pendingOrders.set(device_id, order_id);
  console.log(`[MQTT] Published unlock → ${device_id} / order ${order_id}`);
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

function getPendingOrder(device_id) {
  return pendingOrders.get(device_id) || null;
}

function clearPendingOrder(device_id) {
  pendingOrders.delete(device_id);
}

module.exports = {
  connectMQTT,
  publishUnlock,
  publishOTA,
  isDeviceOnline,
  getPendingOrder,
  clearPendingOrder,
  emitter,
};