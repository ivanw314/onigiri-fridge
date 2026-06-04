'use strict';
const { Router } = require('express');
const { publishOTA, publishUnlock, isDeviceOnline } = require('../mqttClient');

const router = Router();

// Simple bearer-token auth — checked on every admin route.
// Set ADMIN_SECRET in Railway env vars; use the same value as the Authorization header.
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET not configured' });

  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/admin/ota
// Body: { device_id, url }
// Publishes a signed OTA command to the device via MQTT.
router.post('/ota', requireAdmin, (req, res) => {
  const { device_id, url } = req.body;
  if (!device_id || !url) {
    return res.status(400).json({ error: 'device_id and url are required' });
  }
  try {
    publishOTA(device_id, url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/unlock
// Body: { device_id }
// Manually unlocks the fridge without a payment (owner access).
router.post('/unlock', requireAdmin, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });
  if (!isDeviceOnline(device_id)) {
    return res.status(503).json({ error: 'Device is offline' });
  }
  try {
    publishUnlock(device_id, `admin-${Date.now()}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
