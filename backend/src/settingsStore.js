'use strict';
const { pool } = require('./db');

// Store-wide settings the admin can change from the panel. Kept in the
// database rather than env vars so a change takes effect immediately and
// survives redeploys.

// Time zones the admin panel offers. "Today" in the sales stats starts at
// midnight in whichever one is chosen.
const US_TIMEZONES = [
  { id: 'America/Los_Angeles', label: 'Pacific' },
  { id: 'America/Denver',      label: 'Mountain' },
  { id: 'America/Phoenix',     label: 'Arizona (no daylight saving)' },
  { id: 'America/Chicago',     label: 'Central' },
  { id: 'America/New_York',    label: 'Eastern' },
  { id: 'America/Anchorage',   label: 'Alaska' },
  { id: 'Pacific/Honolulu',    label: 'Hawaii' },
];

const DEFAULTS = {
  timezone: 'America/Los_Angeles',
};

async function initSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[SETTINGS] Table ready');
}

// Every setting, with defaults filled in for any never saved.
async function getSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const settings = { ...DEFAULTS };
  for (const { key, value } of rows) {
    if (key in DEFAULTS) settings[key] = value;
  }
  return settings;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
  console.log(`[SETTINGS] ${key} → ${value}`);
}

module.exports = { US_TIMEZONES, initSettingsTable, getSettings, setSetting };
