'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pool } = require('./db');
const { getSettings, setSetting } = require('./settingsStore');

// Weather from the US National Weather Service (api.weather.gov): free for
// any use, no API key. It only keeps a week of station observations, so each
// finished day is summed up into weather_days, and that history is what
// Insights compares sales against. The forecast is just kept in memory.

const NWS = 'https://api.weather.gov';
// NWS asks for a User-Agent naming the app, ideally with a contact address
// so they can get in touch about a problem instead of blocking it.
const USER_AGENT = process.env.WEATHER_CONTACT ? `onigiri-fridge (${process.env.WEATHER_CONTACT})` : 'onigiri-fridge';

// Rain or snow only counts toward a day between these local hours.
const DAYTIME_FROM = 7;
const DAYTIME_TO   = 19;
// A rainy day had rain or snow in at least this many daytime hours, so one
// passing shower doesn't count.
const RAINY_HOURS = 2;
// A day is recorded only once observations cover this many of its hours.
const MIN_HOURS_COVERED = 18;
// Bands of daily high (°F) for comparing sales; null = open-ended.
const TEMP_BANDS = [[null, 50], [50, 60], [60, 70], [70, 80], [80, null]];

const WET = /rain|drizzle|shower|snow|sleet|hail|ice|thunder/i;

let forecast = null;            // { fetched_at, days: [...] } from the last good fetch
const reportedGaps = new Set();  // "station day" already logged as incomplete

async function initWeatherTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weather_days (
      station       TEXT NOT NULL,
      day           DATE NOT NULL,
      temp_max_f    REAL,
      wet_hours     INT NOT NULL,
      summary       TEXT,
      hours_covered INT NOT NULL,
      recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (station, day)
    )
  `);
  console.log('[WEATHER] Table ready');
}

async function nws(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch { /* not JSON */ }
    const err = new Error(`National Weather Service returned ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toF(q) {
  if (!q || q.value === null || q.qualityControl === 'X') return null;
  return q.unitCode && q.unitCode.endsWith('degF') ? q.value : q.value * 9 / 5 + 32;
}

// The middle of a ZIP code's area as [lat, lon], or null. From the Census
// Bureau's 2024 Gazetteer of ZIP Code Tabulation Areas (public domain):
// GEOID, INTPTLAT and INTPTLONG to 3 places, one "zip,lat,lon" per line,
// gzipped. PO-box-only ZIPs aren't in it. Read only when a location is saved.
function lookupZip(zip) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../data/zip-centroids.csv.gz'))).toString();
  const m = text.match(new RegExp(`^${zip},(.+),(.+)$`, 'm'));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function badInput(message) {
  const err = new Error(message);
  err.badInput = true;
  return err;
}

// Takes { zip } or { lat, lon }. Looks the spot up with NWS and saves it
// along with its forecast URL and nearest station. Days are recorded per
// station, so moving to a different one starts a fresh history without
// losing the old.
async function setLocation({ zip = null, lat, lon }) {
  if (zip) {
    const point = lookupZip(zip);
    if (!point) throw badInput(`Couldn't find ZIP code ${zip}. Try this phone's location instead.`);
    [lat, lon] = point;
  }
  // NWS redirects requests with more than 4 decimal places.
  lat = Math.round(lat * 1e4) / 1e4;
  lon = Math.round(lon * 1e4) / 1e4;
  let point;
  try {
    point = (await nws(`${NWS}/points/${lat},${lon}`)).properties;
  } catch (err) {
    if (err.status === 404) throw badInput('The National Weather Service has no data for that spot. It only covers the US.');
    throw err;
  }
  const stations = (await nws(point.observationStations)).features.map((f) => f.properties);
  // Airport stations (K…, or P… in Alaska and Hawaii) report the present
  // weather every few minutes; the others nearby often don't.
  const station = stations.find((s) => /^[KP][A-Z0-9]{3}$/.test(s.stationIdentifier)) || stations[0];
  if (!station) throw new Error('No weather station found near there');
  const place = point.relativeLocation?.properties;
  const location = {
    zip, lat, lon,
    place:        place ? `${place.city}, ${place.state}` : null,
    station:      station.stationIdentifier,
    station_name: station.name,
    forecast_url: point.forecast,
  };
  await setSetting('weather_location', JSON.stringify(location));
  forecast = null;
  try { await refreshForecast(location); } catch (err) { console.log('[WEATHER] Forecast not updated:', err.message); }
  refreshWeather();   // records the past week in the background
  return location;
}

async function refreshForecast(location) {
  const { periods } = (await nws(location.forecast_url)).properties;
  forecast = {
    fetched_at: new Date().toISOString(),
    days: periods.filter((p) => p.isDaytime).map((p) => ({
      date:        p.startTime.slice(0, 10),   // local to the forecast point
      temp_f:      p.temperatureUnit === 'C' ? Math.round(p.temperature * 9 / 5 + 32) : p.temperature,
      rain_chance: p.probabilityOfPrecipitation?.value ?? 0,
      short:       p.shortForecast,
    })),
  };
}

// One local day's observations, summed up.
function summarizeDay(observations, timezone) {
  const hourOf = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' });
  const hours = new Set();
  const wetHours = new Set();
  const descriptions = {};
  let tempMax = null;
  for (const o of observations) {
    const hour = parseInt(hourOf.format(new Date(o.timestamp)), 10) % 24;
    hours.add(hour);
    const t = toF(o.temperature);
    if (t !== null && (tempMax === null || t > tempMax)) tempMax = t;
    if (hour < DAYTIME_FROM || hour >= DAYTIME_TO) continue;
    if ((o.presentWeather || []).some((w) => WET.test(w.weather)) || WET.test(o.textDescription || '')) wetHours.add(hour);
    if (o.textDescription) descriptions[o.textDescription] = (descriptions[o.textDescription] || 0) + 1;
  }
  const summary = Object.keys(descriptions).sort((a, b) => descriptions[b] - descriptions[a])[0] || null;
  return {
    temp_max_f:    tempMax === null ? null : Math.round(tempMax * 10) / 10,
    wet_hours:     wetHours.size,
    summary,
    hours_covered: hours.size,
  };
}

// Records each finished day of the past week not yet recorded for the
// station. A day waits two hours past midnight for late observations.
async function recordMissingDays(location, timezone) {
  const { rows } = await pool.query(
    `SELECT d::date::text AS day, d AT TIME ZONE $1 AS starts, (d + INTERVAL '1 day') AT TIME ZONE $1 AS ends
     FROM generate_series(date_trunc('day', NOW() AT TIME ZONE $1) - INTERVAL '6 days',
                          date_trunc('day', NOW() AT TIME ZONE $1) - INTERVAL '1 day', INTERVAL '1 day') AS d
     WHERE (d + INTERVAL '1 day') AT TIME ZONE $1 <= NOW() - INTERVAL '2 hours'
       AND NOT EXISTS (SELECT 1 FROM weather_days w WHERE w.station = $2 AND w.day = d::date)
     ORDER BY d`,
    [timezone, location.station]
  );
  for (const { day, starts, ends } of rows) {
    // A day is ~300 observations at one every 5 minutes, inside one page.
    const body = await nws(`${NWS}/stations/${location.station}/observations` +
      `?start=${starts.toISOString()}&end=${ends.toISOString()}&limit=500`);
    const s = summarizeDay(body.features.map((f) => f.properties), timezone);
    // Stations do have outages. Retried hourly until NWS drops the day, but
    // only logged once.
    if (s.hours_covered < MIN_HOURS_COVERED) {
      if (!reportedGaps.has(`${location.station} ${day}`)) {
        reportedGaps.add(`${location.station} ${day}`);
        console.log(`[WEATHER] ${day}: only ${s.hours_covered}h of observations from ${location.station} so far, not recorded yet`);
      }
      continue;
    }
    await pool.query(
      `INSERT INTO weather_days (station, day, temp_max_f, wet_hours, summary, hours_covered)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [location.station, day, s.temp_max_f, s.wet_hours, s.summary, s.hours_covered]
    );
    console.log(`[WEATHER] ${day}: high ${s.temp_max_f}°F, rain/snow in ${s.wet_hours}h, ${s.summary}`);
  }
}

// NWS has frequent short outages and the next hour usually works, so its
// failures are logged as plain lines rather than errors.
async function refreshNow() {
  try {
    const { timezone, weather_location: location } = await getSettings();
    if (!location) return;
    try { await refreshForecast(location); } catch (err) { console.log('[WEATHER] Forecast not updated:', err.message); }
    await recordMissingDays(location, timezone);
  } catch (err) {
    console.log('[WEATHER] Refresh stopped, will try again next hour:', err.message);
  }
}

// Refreshes run one after another, so a location change waits for the one
// in flight. Never rejects.
let queue = Promise.resolve();
function refreshWeather() {
  queue = queue.then(refreshNow);
  return queue;
}

// Sales against the recorded weather: every recorded open day from the first
// sale on, whatever range is picked. Plus the forecast from today on.
async function getWeatherInsights(location, timezone, closedDays) {
  if (!location) return { location: null };
  const [daysQ, sinceQ] = await Promise.all([
    pool.query(
      `SELECT w.wet_hours, w.temp_max_f,
              (SELECT COUNT(*) FROM orders o
               WHERE o.status = 'complete'
                 AND o.created_at >= w.day::timestamp AT TIME ZONE $1
                 AND o.created_at <  (w.day + 1)::timestamp AT TIME ZONE $1) AS orders
       FROM weather_days w
       WHERE w.station = $2
         AND EXTRACT(ISODOW FROM w.day)::int <> ALL($3::int[])
         AND w.day >= (SELECT (MIN(created_at) AT TIME ZONE $1)::date FROM orders WHERE status = 'complete')`,
      [timezone, location.station, closedDays]
    ),
    pool.query(`SELECT MIN(day)::text AS since FROM weather_days WHERE station = $1`, [location.station]),
  ]);

  const rain  = { dry: { days: 0, orders: 0 }, wet: { days: 0, orders: 0 } };
  const bands = TEMP_BANDS.map(([from, to]) => ({ from, to, days: 0, orders: 0 }));
  for (const r of daysQ.rows) {
    const orders = parseInt(r.orders, 10) || 0;
    const g = r.wet_hours >= RAINY_HOURS ? rain.wet : rain.dry;
    g.days++;
    g.orders += orders;
    if (r.temp_max_f !== null) {
      const b = bands.find((x) => (x.from === null || r.temp_max_f >= x.from) && (x.to === null || r.temp_max_f < x.to));
      b.days++;
      b.orders += orders;
    }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());   // YYYY-MM-DD
  return {
    location: { zip: location.zip || null, place: location.place, station: location.station, station_name: location.station_name },
    recorded_since: sinceQ.rows[0].since,
    rainy_hours: RAINY_HOURS,
    daytime: [DAYTIME_FROM, DAYTIME_TO],
    rain,
    bands,
    forecast: forecast ? forecast.days.filter((d) => d.date >= today).map((d) => ({
      ...d,
      dow:      new Date(`${d.date}T12:00:00Z`).getUTCDay() || 7,
      is_today: d.date === today,
    })) : [],
  };
}

module.exports = { initWeatherTable, setLocation, refreshWeather, getWeatherInsights };
