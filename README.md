# Onigiri Fridge

An ESP32-controlled, WiFi-connected mini fridge for unattended vending. Customers scan a QR code, pick an item and quantity, pay via Square, and the fridge unlocks itself over MQTT. A mobile-friendly admin panel handles remote control, WiFi provisioning, firmware updates, and the item catalog.

## How It Works

1. Customer scans a QR code linking to `/buy/:device_id`.
2. The page lists every active catalog item with live stock; out-of-stock items are shown disabled. The customer picks one item + quantity and pays via a Square-hosted checkout link.
3. Square's webhook (`POST /webhooks/square`) confirms payment, atomically decrements that item's stock, and publishes a signed `unlock` command over MQTT.
4. The ESP32 verifies the command's HMAC signature and nonce, releases the lock relay, and reports `unlocked`.
5. The customer opens the door, takes their item(s), and closes it — the fridge relocks automatically ~1.5s after the door is confirmed shut.
6. If the door is never opened within 60s, the device reports `unlock_timeout`; the backend refunds the payment automatically and reverses the stock decrement.
7. The customer's browser (`/thank-you`) shows live status throughout via Server-Sent Events.

Every backend → device command (`unlock`, `lock`, `reboot`, `wifi_update`, `wifi_reset`, `ota`) is HMAC-SHA256 signed with a shared device secret, timestamp-checked (±30s, once NTP has synced), and nonce-checked (replay protection) by the firmware before it's executed.

## Hardware

### Components

| Part | Model / spec | Notes |
|------|---------------|-------|
| Microcontroller | ESP32 dev board (HiLetgo, 30-pin) | Powered via USB wall wart |
| Lock | Amazon B0CNPWB8MM, 12V electric drop-bolt | Fail-secure (bolt extends/locks when unpowered). 3 wires: RED (+12V), BLACK (GND), PURPLE (capped — an unused magnetic-induction sensor output, not a trigger) |
| Relay | DIYables 5V relay module, active-LOW | Switches the 12V supply line to the lock directly, rather than shorting a trigger wire to ground |
| Door sensor | MC-31B magnetic reed switch | NC/NO labels are reversed from standard convention — identify wires with a multimeter, don't trust the printed labels |
| Power supply | 12V 2A wall adapter, 5.5×2.1mm barrel jack → screw-terminal adapter | |
| Wire termination | AITRIP ESP32 breakout board + Joinfworld barrier strip (shared ground bus) | Tinned wire ends on the breakout board (its terminals are too small for ferrule collars); ferrules everywhere else (relay, barrel adapter, barrier strip). The lock's own factory leads were too short to reach the enclosure, so they were extended with soldered, heat-shrunk splices instead of a screw-terminal connection |
| Enclosure | Plastic takeout container | Boards raised off the floor on electrical-tape pads; barrel adapter mounted outside the box |
| Mounting | 3M VHB 5952 tape | No drilling into the fridge, fully reversible. Lock is side-mounted with its bolt extending upward into a pad-eye-plate catch on the door — the lock's included magnetic strike plate is set aside, since it interferes with the lock's internal sensor |

### Wiring

**12V side** (PSU → relay → lock):

| From | To | Wire | Termination | Notes |
|---|---|---|---|---|
| Barrel adapter + | Relay COM | 20 AWG | Ferrule (relay) | Barrel adapter mounted outside the enclosure |
| Relay NO | Lock RED | 20 AWG | Ferrule (relay); soldered + heat-shrunk splice (lock extension) | Lock's factory wire was too short and was extended |
| Barrel adapter − | Lock BLACK | 20 AWG | Ferrule (barrel adapter); soldered + heat-shrunk splice (lock extension) | Lock's factory wire was too short and was extended |
| Lock PURPLE | — | — | Capped with heat shrink | Not connected |

The relay switches the 12V supply line itself rather than pulling a trigger wire to ground: relay energized → 12V reaches the lock → bolt retracts → **unlocked**. Relay de-energized → lock unpowered → bolt extends (fail-secure) → **locked**.

**Logic side** (ESP32 ↔ relay ↔ door sensor, via the breakout board and barrier strip):

| From | To | Wire | Termination | Notes |
|---|---|---|---|---|
| ESP32 VIN | Relay DC+ | 22 AWG | Tinned (breakout board), ferrule (relay) | Logic power |
| ESP32 GPIO 26 | Relay IN | 22 AWG | Tinned (breakout board), ferrule (relay) | LOW = relay on = unlocked |
| ESP32 GPIO 27 | MC-31B NC | 20 AWG | Tinned (breakout board), ferrule (sensor) | INPUT_PULLUP, LOW = door closed |
| ESP32 GND | Barrier strip | 22 AWG | Tinned (breakout board), ferrule (barrier strip) | Feeds common ground bus |
| Relay DC− | Barrier strip | 22 AWG | Ferrule both ends | |
| MC-31B COM | Barrier strip | 20 AWG | Ferrule (barrier strip) | Pulled from the 20 AWG color spool — oversized for a signal/ground wire, but fine |

### Pinout

| Component | Pin | Notes |
|-----------|-----|-------|
| Relay (electric lock) | GPIO 26 | Active-LOW relay: GPIO LOW energizes the relay → unlocked; GPIO HIGH → locked |
| Magnetic door sensor (reed switch) | GPIO 27 | INPUT_PULLUP — LOW = closed, HIGH = open |

## Firmware (`src/main.cpp`)

- **WiFi provisioning** — no hardcoded credentials. On first boot (or after a reset) the device starts a `FridgeSetup` WiFiManager captive portal; credentials are saved to NVS (`Preferences`, namespace `"wifi"`) and reused on later boots. Remote re-provisioning: the `wifi_update` command saves new credentials and reboots; `wifi_reset` clears NVS + WiFiManager's own store and reboots into the setup AP. The same reset is available locally via the serial console (`r` key).
- **MQTT topics** — namespaced by the device's `DEVICE_ID` (from `secrets.h`):

  | Topic | Direction | Payload |
  |-------|-----------|---------|
  | `fridge/<id>/cmd` | Subscribe | Signed JSON command |
  | `fridge/<id>/evt` | Publish | `{"evt": "..."}` state/event notifications |
  | `fridge/<id>/status` | Publish (retained, Last Will) | `online` / `offline` |

- **Command authentication** (`onMqttMessage` → `verifyHMAC`) — every incoming command needs a timestamp within 30s of the device's NTP-synced clock, an unseen nonce (8-entry ring buffer), and a valid HMAC-SHA256 signature over the canonical (alphabetically sorted) JSON keys, computed with `DEVICE_SECRET`. Any failure publishes `auth_failed` and drops the command.
- **OTA updates** — the `ota` command triggers a lock-and-flush sequence: the device locks, publishes `ota_start`, cleanly disconnects, downloads and flashes the given URL, then reboots. On failure it reconnects and publishes `ota_failed`.
- **Heartbeat** — `online` published (retained) every 30s; MQTT's Last Will publishes `offline` on an ungraceful disconnect.
- **Serial debug console** (115200 baud) — `u` triggers a manual unlock, `r` clears WiFi credentials and reboots into setup mode. Logs are prefixed by subsystem: `[LOCK]`, `[WIFI]`, `[MQTT]`, `[DOOR]`, `[CMD]`, `[AUTH]`, `[OTA]`, `[SNTP]`.
- **`src/secrets.h`** (gitignored — copy from `src/secrets_example.h`): `MQTT_HOST`, `MQTT_USER`, `MQTT_PASS`, `DEVICE_ID`, `DEVICE_SECRET`.

### Build & Flash

Requires [PlatformIO](https://platformio.org/).

```bash
pio run                  # build
pio run --target upload  # flash to connected ESP32
pio device monitor       # serial monitor (115200 baud)
```

Upload/monitor ports default to `/dev/tty.usbserial-0001` in [platformio.ini](platformio.ini) — override to match your system.

## Backend (`backend/`)

Node.js/Express on Railway. HiveMQ Cloud (MQTT over TLS), Postgres, Square Payments.

| File | Responsibility |
|------|-----------------|
| `src/index.js` | Express entry point; wires up routes; MQTT device-event handler (order state transitions, stock restore on timeout) |
| `src/db.js` | Shared Postgres connection pool |
| `src/orderStore.js` | Orders table CRUD, stats, Square-event dedup, SSE client registry |
| `src/itemStore.js` | Items catalog CRUD, atomic stock decrement/restore |
| `src/mqttClient.js` | HiveMQ connection, HMAC command signing/publishing, device heartbeat + activity-event tracking |
| `src/square.js` | Square payment links, order lookup, refunds |
| `src/routes/buy.js` | `GET /buy/:device_id` — multi-item storefront |
| `src/routes/checkout.js` | `POST /api/checkout` — creates an order + Square payment link |
| `src/routes/webhook.js` | `POST /webhooks/square` — payment confirmation, stock decrement, triggers unlock |
| `src/routes/thankyou.js` | `GET /thank-you` — post-payment live status page (SSE) |
| `src/routes/orders.js` | `GET /api/orders/:id/status` — SSE stream + poll fallback |
| `src/routes/admin.js` | Admin panel (PWA) + all `/admin/*` management APIs |

### Order lifecycle

`pending → paid → dispensing → complete`, or `→ timed_out` (60s unlock timeout, auto-refunded) / `→ refunded` (manual refund, or an error-path refund).

### Items catalog & stock

The product catalog lives in Postgres (`items` table: `name`, `price_cents`, `stock`, `active`), managed from the admin panel's **Items** card — add, edit, deactivate/restore, or delete items. On an empty database the catalog auto-seeds one row from the `ITEM_NAME` / `ITEM_PRICE_CENTS` env vars, so existing deployments keep working with no manual step.

- The `/buy` page lists every active item with live stock; out-of-stock items are shown disabled rather than hidden, and the quantity stepper is capped at remaining stock.
- Stock decrements atomically the moment Square confirms payment (not at checkout-link creation), so two concurrent buyers can't oversell the last unit. If the decrement fails (a stock race, or an unlock command fails to send) the order is refunded automatically instead of unlocking.
- Stock is restored automatically only when a paid order never dispenses (unlock-publish failure, or the device's `unlock_timeout` event) — never for manual refunds of already-dispensed orders, since the item may already be physically gone.
- Every order snapshots the item's name/price at purchase time, so later catalog edits or deletions never change historical order display, revenue stats, or refund amounts.
- Deleting an item hard-deletes it if it has no order history, otherwise deactivates it (hidden from the storefront, restorable later) to keep past orders intact.

### Admin panel (`/admin`)

Installable PWA, Bearer-token auth (`ADMIN_SECRET`), persistent login via localStorage.

- **Status** — online/offline, last-seen, WiFi SSID/signal/firmware version, manual refresh
- **Sales** — today's / all-time items sold and revenue (computed from each order's snapshotted price)
- **Controls** — Unlock, Lock, Reboot
- **Items** — catalog CRUD, stock editing, add/delete
- **WiFi Settings** — remote credential update, factory reset (double-confirm)
- **Firmware Update** — OTA trigger by URL
- **Recent Orders** — item, status, quantity, timestamp; refund / delete per row, clear all
- **Activity** — color-coded recent device events, auto-refreshing

### Environment variables

See [`backend/.env.example`](backend/.env.example) for the full annotated list — server/database/HiveMQ/Square/admin secrets, plus `ITEM_NAME` / `ITEM_PRICE_CENTS` (legacy catalog-seed + fallback only) and the optional `STORE_NAME`.

## Repository Structure

```
onigiri-fridge-phase1/
├── src/
│   ├── main.cpp                 # ESP32 firmware
│   ├── secrets.h                # Device credentials (gitignored)
│   └── secrets_example.h        # Template for secrets.h
├── platformio.ini               # Firmware build & upload config
│
├── backend/
│   ├── src/
│   │   ├── index.js             # Express entry + MQTT device-event handler
│   │   ├── db.js                # Shared Postgres pool
│   │   ├── orderStore.js        # Orders: CRUD, stats, event dedup, SSE registry
│   │   ├── itemStore.js         # Items catalog: CRUD, stock decrement/restore
│   │   ├── mqttClient.js        # HiveMQ connection, HMAC signing, event tracking
│   │   ├── square.js            # Payment links, order lookup, refunds
│   │   └── routes/
│   │       ├── buy.js           # GET /buy/:device_id — item picker + checkout
│   │       ├── checkout.js      # POST /api/checkout
│   │       ├── webhook.js       # POST /webhooks/square
│   │       ├── thankyou.js      # GET /thank-you — live status page
│   │       ├── orders.js        # GET /api/orders/:id/status — SSE
│   │       └── admin.js         # Admin panel + /admin/* APIs
│   ├── package.json
│   ├── railway.toml             # Railway hosting config
│   └── .env.example
│
├── .gitignore
└── README.md
```