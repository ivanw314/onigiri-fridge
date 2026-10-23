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

// Orders placed during a weather_days row's day, as a subquery.
const ORDERS_THAT_DAY = (day) => `(SELECT COUNT(*) FROM orders o
   WHERE o.status = 'complete'
     AND o.created_at >= ${day}::timestamp AT TIME ZONE $1
     AND o.created_at <  (${day} + 1)::timestamp AT TIME ZONE $1)`;

// Each rainy day against the dry days of its own weekday, so a rainy spell
// that happened to land on quiet weekdays isn't blamed on the rain. Only
// counts rainy days whose weekday has at least 2 dry days to compare with.
function sameWeekdayRain(days) {
  const dry = {};
  for (const d of days) {
    if (d.wet) continue;
    dry[d.dow] = dry[d.dow] || { days: 0, orders: 0 };
    dry[d.dow].days++;
    dry[d.dow].orders += d.orders;
  }
  const out = { rainy_days: 0, orders: 0, expected: 0 };
  for (const d of days) {
    const base = dry[d.dow];
    if (!d.wet || !base || base.days < 2) continue;
    out.rainy_days++;
    out.orders   += d.orders;
    out.expected += base.orders / base.days;
  }
  return out;
}

// Units of each active item a day in each kind of weather, counted from the
// item's first sale so a new item's empty earlier days don't count against it.
// "Warmer" is the upper half of recorded daily highs, so it adapts to the
// place and the season.
function itemsByWeather(days, itemRows, unitRows) {
  const highs = days.map((d) => d.temp_max_f).filter((t) => t !== null).sort((a, b) => a - b);
  const warmFrom = highs.length ? Math.round(highs[Math.floor(highs.length / 2)]) : null;
  const units = {};
  for (const r of unitRows) units[`${r.day} ${r.item_id}`] = r.units;
  const group = () => ({ days: 0, units: 0 });
  const items = itemRows.map((item) => {
    const g = { name: item.name, units: 0, wet: group(), dry: group(), warm: group(), cool: group() };
    for (const d of days) {
      if (d.day < item.first_day) continue;
      const u = units[`${d.day} ${item.id}`] || 0;
      g.units += u;
      for (const k of [d.wet ? 'wet' : 'dry', d.temp_max_f === null ? null : d.temp_max_f >= warmFrom ? 'warm' : 'cool']) {
        if (!k) continue;
        g[k].days++;
        g[k].units += u;
      }
    }
    return g;
  });
  return { warm_from: warmFrom, items: items.sort((a, b) => b.units - a.units) };
}

// Sales against the recorded weather: every recorded open day from the first
// sale on, whatever range is picked. Plus the last few open days one by one,
// and the forecast from today on.
async function getWeatherInsights(location, timezone, closedDays) {
  if (!location) return { location: null };
  const params    = [timezone, location.station, closedDays];
  const openDay   = (d) => `EXTRACT(ISODOW FROM ${d})::int <> ALL($3::int[])`;
  const firstSale = `(SELECT date_trunc('day', MIN(created_at) AT TIME ZONE $1) FROM orders WHERE status = 'complete')`;
  const [daysQ, sinceQ, recentQ, itemsQ, unitsQ] = await Promise.all([
    pool.query(
      `SELECT w.day::text AS day, EXTRACT(ISODOW FROM w.day)::int AS dow, w.wet_hours, w.temp_max_f,
              ${ORDERS_THAT_DAY('w.day')} AS orders
       FROM weather_days w
       WHERE w.station = $2 AND ${openDay('w.day')} AND w.day >= ${firstSale}`,
      params
    ),
    pool.query(`SELECT MIN(day)::text AS since FROM weather_days WHERE station = $1`, [location.station]),
    // The last 7 finished open days, weather or not (a station gap, or days
    // from before recording began, just show no weather).
    pool.query(
      `SELECT d::date::text AS day, EXTRACT(ISODOW FROM d)::int AS dow,
              w.temp_max_f, w.wet_hours, w.summary, ${ORDERS_THAT_DAY('d::date')} AS orders
       FROM generate_series(date_trunc('day', NOW() AT TIME ZONE $1) - INTERVAL '21 days',
                            date_trunc('day', NOW() AT TIME ZONE $1) - INTERVAL '1 day', INTERVAL '1 day') AS d
       LEFT JOIN weather_days w ON w.station = $2 AND w.day = d::date
       WHERE ${openDay('d')} AND d >= ${firstSale}
       ORDER BY d DESC
       LIMIT 7`,
      params
    ),
    pool.query(
      `SELECT i.id, i.name, (MIN(o.created_at) AT TIME ZONE $1)::date::text AS first_day
       FROM items i
       JOIN order_items oi ON oi.item_id = i.id
       JOIN orders o ON o.id = oi.order_id AND o.status = 'complete'
       WHERE i.active
       GROUP BY i.id, i.name`,
      [timezone]
    ),
    pool.query(
      `SELECT w.day::text AS day, oi.item_id, SUM(oi.quantity)::int AS units
       FROM weather_days w
       JOIN orders o ON o.status = 'complete'
                    AND o.created_at >= w.day::timestamp AT TIME ZONE $1
                    AND o.created_at <  (w.day + 1)::timestamp AT TIME ZONE $1
       JOIN order_items oi ON oi.order_id = o.id
       WHERE w.station = $2 AND ${openDay('w.day')}
       GROUP BY 1, 2`,
      params
    ),
  ]);

  const days  = daysQ.rows.map((r) => ({ ...r, orders: parseInt(r.orders, 10) || 0, wet: r.wet_hours >= RAINY_HOURS }));
  const rain  = { dry: { days: 0, orders: 0 }, wet: { days: 0, orders: 0 } };
  const bands = TEMP_BANDS.map(([from, to]) => ({ from, to, days: 0, orders: 0 }));
  for (const d of days) {
    const g = d.wet ? rain.wet : rain.dry;
    g.days++;
    g.orders += d.orders;
    if (d.temp_max_f !== null) {
      const b = bands.find((x) => (x.from === null || d.temp_max_f >= x.from) && (x.to === null || d.temp_max_f < x.to));
      b.days++;
      b.orders += d.orders;
    }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());   // YYYY-MM-DD
  return {
    location: { zip: location.zip || null, place: location.place, station: location.station, station_name: location.station_name },
    recorded_since: sinceQ.rows[0].since,
    rainy_hours: RAINY_HOURS,
    daytime: [DAYTIME_FROM, DAYTIME_TO],
    rain,
    same_weekday: sameWeekdayRain(days),
    bands,
    // recorded is false for a day with no weather (station gap, or before
    // recording began).
    recent: recentQ.rows.map((r) => ({
      day: r.day, dow: r.dow, orders: parseInt(r.orders, 10) || 0,
      recorded: r.wet_hours !== null, temp_max_f: r.temp_max_f, wet: r.wet_hours >= RAINY_HOURS, wet_hours: r.wet_hours, summary: r.summary,
    })),
    ...itemsByWeather(days, itemsQ.rows, unitsQ.rows),
    forecast: forecast ? forecast.days.filter((d) => d.date >= today).map((d) => ({
      ...d,
      dow:      new Date(`${d.date}T12:00:00Z`).getUTCDay() || 7,
      is_today: d.date === today,
    })) : [],
  };
}

module.exports = { initWeatherTable, setLocation, refreshWeather, getWeatherInsights };
