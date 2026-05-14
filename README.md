# Onigiri Fridge — Phase 1

An ESP32-based smart fridge lock that can be unlocked remotely over MQTT/WiFi. The lock re-engages automatically once the door is opened and closed after an unlock command.

## Hardware

| Component | Pin | Notes |
|-----------|-----|-------|
| Relay (electric lock) | GPIO 26 | LOW = locked, HIGH = unlocked |
| Magnetic door sensor (reed switch) | GPIO 27 | INPUT_PULLUP — LOW = closed, HIGH = open |

**Platform:** ESP32 dev board, powered via USB or external supply.

## How It Works

1. On boot the device connects to WiFi and then to an MQTT broker.
2. It publishes `online` to `fridge/onigiri/status` (retained) and subscribes to `fridge/onigiri/cmd`.
3. Sending an `unlock` payload to the command topic releases the relay.
4. Once the door is opened **and then closed**, the relay re-engages automatically.
5. A heartbeat is published to `fridge/onigiri/status` every 30 seconds.
6. All state transitions are published as JSON events to `fridge/onigiri/evt`.

### MQTT Topics

| Topic | Direction | Example payload |
|-------|-----------|-----------------|
| `fridge/onigiri/cmd` | Subscribe | `unlock` |
| `fridge/onigiri/evt` | Publish | `{"evt":"unlocked"}` / `{"evt":"locked"}` |
| `fridge/onigiri/status` | Publish (retained) | `online` / `offline` (Last Will) |

## Build & Flash

Requires [PlatformIO](https://platformio.org/).

```bash
# Install dependencies and build
pio run

# Flash to connected ESP32
pio run --target upload

# Open serial monitor (115200 baud)
pio device monitor
```

The upload and monitor ports are set to `/dev/tty.usbserial-0001` in [platformio.ini](platformio.ini). Change these to match your system if needed.

### Dependencies

- [PubSubClient](https://github.com/knolleary/pubsubclient) v2.8 (MQTT client)
- Arduino framework for ESP32 (managed by PlatformIO)

## Configuration

WiFi credentials, MQTT broker details, and pin assignments are currently hardcoded in [src/main.cpp](src/main.cpp). Update these before flashing:

```cpp
// WiFi
const char* ssid     = "your-ssid";
const char* password = "your-password";

// MQTT broker
const char* mqttHost = "your-broker-host";
const int   mqttPort = 8883;
const char* mqttUser = "your-mqtt-user";
const char* mqttPass = "your-mqtt-password";
```

The broker connection uses `WiFiClientSecure` with `setInsecure()` (no certificate pinning). See the roadmap below.

## Serial Debug Console

With the serial monitor open, press **`u`** to trigger a manual unlock — useful for local testing without an MQTT broker.

Log lines are prefixed by subsystem: `[LOCK]`, `[WIFI]`, `[MQTT]`, `[DOOR]`, `[CMD]`.

## Roadmap

- **Phase 1 (current):** WiFi + MQTT unlock, door auto-relock, heartbeat
- **Stage 2:** Externalize credentials (NVS / provisioning flow)
- **Stage 3:** TLS certificate pinning, HMAC command authentication

## Repository Structure

```
onigiri-fridge-phase1/
├── src/
│   └── main.cpp          # All firmware logic
├── include/              # Reserved for future header files
│   └── README
├── lib/                  # Reserved for local libraries
│   └── README
├── test/                 # Reserved for unit tests
│   └── README
├── platformio.ini        # Build, upload, and monitor configuration
├── .gitignore
├── .gitattributes
└── README.md
```
