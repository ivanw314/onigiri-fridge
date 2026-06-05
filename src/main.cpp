#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <HTTPUpdate.h>
#include "mbedtls/md.h"
#include <time.h>
#include "secrets.h"

#define FIRMWARE_VERSION "1.0.0"

// ── constants (not secrets) ───────────────────────────────────
const int            MQTT_PORT         = 8883;
const int            RELOCK_DELAY_MS   = 1500;
const unsigned long  UNLOCK_TIMEOUT_MS = 60000;
const unsigned long  HEARTBEAT_MS          = 30000;
const unsigned long  RECONNECT_INTERVAL_MS = 5000;
// ─────────────────────────────────────────────────────────────

const int RELAY_PIN = 26;
const int DOOR_PIN  = 27;

char TOPIC_CMD[64];
char TOPIC_EVT[64];
char TOPIC_STATUS[64];

WiFiClientSecure wifiClient;
PubSubClient mqtt(wifiClient);

enum State { LOCKED, UNLOCKED };
State state = LOCKED;
bool lastDoorClosed          = true;
bool doorOpenedWhileUnlocked = false;
unsigned long lastHeartbeat        = 0;
unsigned long unlockedAt           = 0;
unsigned long lastReconnectAttempt = 0;

// ── OTA ───────────────────────────────────────────────────────
bool otaPending = false;
char otaUrl[256];

// ── Nonce ring buffer ─────────────────────────────────────────
#define NONCE_RING_SIZE 8
static char seenNonces[NONCE_RING_SIZE][37];
static int  nonceCursor = 0;

static bool isNonceSeen(const char* nonce) {
  for (int i = 0; i < NONCE_RING_SIZE; i++) {
    if (seenNonces[i][0] != '\0' && strcmp(seenNonces[i], nonce) == 0)
      return true;
  }
  return false;
}

static void recordNonce(const char* nonce) {
  strncpy(seenNonces[nonceCursor], nonce, 36);
  seenNonces[nonceCursor][36] = '\0';
  nonceCursor = (nonceCursor + 1) % NONCE_RING_SIZE;
}

// ── HMAC-SHA256 ───────────────────────────────────────────────
static bool verifyHMAC(const char* message, const char* key, const char* expected) {
  uint8_t hmacBytes[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info || mbedtls_md_setup(&ctx, info, 1) != 0) {
    mbedtls_md_free(&ctx);
    return false;
  }
  mbedtls_md_hmac_starts(&ctx, (const uint8_t*)key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const uint8_t*)message, strlen(message));
  mbedtls_md_hmac_finish(&ctx, hmacBytes);
  mbedtls_md_free(&ctx);

  char computed[65];
  for (int i = 0; i < 32; i++) sprintf(computed + i * 2, "%02x", hmacBytes[i]);
  computed[64] = '\0';

  return strcmp(computed, expected) == 0;
}

// ── lock state machine ────────────────────────────────────────
void setState(State newState) {
  state = newState;
  switch (state) {
    case LOCKED:
      Serial.println("[LOCK] Relay engaging -- fridge is LOCKED");
      Serial.flush();
      digitalWrite(RELAY_PIN, LOW);
      doorOpenedWhileUnlocked = false;
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"locked\"}");
      break;
    case UNLOCKED:
      Serial.println("[LOCK] Relay releasing -- fridge is UNLOCKED");
      Serial.println("[LOCK] Open the door, then close it to relock.");
      Serial.flush();
      digitalWrite(RELAY_PIN, HIGH);
      doorOpenedWhileUnlocked = false;
      unlockedAt = millis();
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"unlocked\"}");
      break;
  }
}

// ── OTA update ────────────────────────────────────────────────
void performOTA(const char* url) {
  Serial.print("[OTA] Downloading from: ");
  Serial.println(url);

  WiFiClientSecure otaClient;
  otaClient.setInsecure();
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  t_httpUpdate_return ret = httpUpdate.update(otaClient, url);
  switch (ret) {
    case HTTP_UPDATE_OK:
      Serial.println("[OTA] Flash OK -- rebooting.");  // device reboots; line won't print
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("[OTA] Server returned no update.");
      break;
    case HTTP_UPDATE_FAILED:
      Serial.printf("[OTA] Failed (%d): %s\n",
        httpUpdate.getLastError(),
        httpUpdate.getLastErrorString().c_str());
      break;
  }
}

// ── MQTT message handler ──────────────────────────────────────
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[512];
  unsigned int len = min(length, (unsigned int)sizeof(msg) - 1);
  memcpy(msg, payload, len);
  msg[len] = '\0';

  Serial.print("[MQTT] Received on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(msg);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) { Serial.println("[CMD]  JSON parse error -- ignoring."); return; }

  const char* cmd   = doc["cmd"]   | "";
  const char* nonce = doc["nonce"] | "";
  long        ts    = doc["ts"]    | 0L;
  const char* sig   = doc["sig"]   | "";

  // 1. Timestamp freshness (only enforced after SNTP sync)
  time_t now = time(nullptr);
  if (now > 1000000000L) {
    long long diff = (long long)now - (long long)ts;
    if (diff < -30LL || diff > 30LL) {
      Serial.println("[AUTH] Stale timestamp -- rejected.");
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"auth_failed\"}");
      return;
    }
  }

  // 2. Nonce replay check
  if (isNonceSeen(nonce)) {
    Serial.println("[AUTH] Replayed nonce -- rejected.");
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"auth_failed\"}");
    return;
  }

  // 3. Build canonical form (keys sorted alphabetically, matching backend signPayload)
  //    and verify HMAC before executing anything
  char canonical[512];
  if (strcmp(cmd, "unlock") == 0) {
    const char* order_id = doc["order_id"] | "";
    snprintf(canonical, sizeof(canonical),
      "{\"cmd\":\"%s\",\"nonce\":\"%s\",\"order_id\":\"%s\",\"ts\":%ld}",
      cmd, nonce, order_id, ts);
  } else if (strcmp(cmd, "ota") == 0) {
    const char* url = doc["url"] | "";
    snprintf(canonical, sizeof(canonical),
      "{\"cmd\":\"%s\",\"nonce\":\"%s\",\"ts\":%ld,\"url\":\"%s\"}",
      cmd, nonce, ts, url);
  } else if (strcmp(cmd, "lock") == 0 || strcmp(cmd, "reboot") == 0 || strcmp(cmd, "wifi_reset") == 0) {
    snprintf(canonical, sizeof(canonical),
      "{\"cmd\":\"%s\",\"nonce\":\"%s\",\"ts\":%ld}",
      cmd, nonce, ts);
  } else if (strcmp(cmd, "wifi_update") == 0) {
    const char* newSsid = doc["ssid"]     | "";
    const char* newPass = doc["password"] | "";
    // Keys inserted alphabetically so ArduinoJson preserves order: cmd,nonce,password,ssid,ts
    JsonDocument cDoc;
    cDoc["cmd"]      = cmd;
    cDoc["nonce"]    = nonce;
    cDoc["password"] = newPass;
    cDoc["ssid"]     = newSsid;
    cDoc["ts"]       = ts;
    serializeJson(cDoc, canonical, sizeof(canonical));
  } else {
    Serial.println("[CMD]  Unrecognised command -- ignored.");
    return;
  }

  if (!verifyHMAC(canonical, DEVICE_SECRET, sig)) {
    Serial.println("[AUTH] HMAC mismatch -- rejected.");
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"auth_failed\"}");
    return;
  }

  recordNonce(nonce);

  // 4. Execute verified command
  if (strcmp(cmd, "unlock") == 0) {
    if (state == LOCKED) {
      Serial.println("[CMD]  Unlock command verified.");
      setState(UNLOCKED);
    } else {
      Serial.println("[CMD]  Already unlocked.");
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"already_unlocked\"}");
    }
  } else if (strcmp(cmd, "ota") == 0) {
    const char* url = doc["url"] | "";
    strncpy(otaUrl, url, sizeof(otaUrl) - 1);
    otaUrl[sizeof(otaUrl) - 1] = '\0';
    otaPending = true;
    Serial.println("[OTA]  Update scheduled.");
  } else if (strcmp(cmd, "lock") == 0) {
    Serial.println("[CMD]  Force lock verified.");
    setState(LOCKED);
  } else if (strcmp(cmd, "reboot") == 0) {
    Serial.println("[CMD]  Reboot command verified.");
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"rebooting\"}");
    mqtt.loop();
    delay(200);
    ESP.restart();
  } else if (strcmp(cmd, "wifi_update") == 0) {
    Serial.println("[CMD]  WiFi update command verified.");
    Preferences prefs;
    prefs.begin("wifi", false);
    prefs.putString("ssid", doc["ssid"]     | "");
    prefs.putString("pass", doc["password"] | "");
    prefs.end();
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"wifi_updating\"}");
    mqtt.loop();
    delay(200);
    ESP.restart();
  } else if (strcmp(cmd, "wifi_reset") == 0) {
    Serial.println("[CMD]  WiFi reset command verified.");
    Preferences prefs;
    prefs.begin("wifi", false);
    prefs.clear();
    prefs.end();
    WiFiManager wm;
    wm.resetSettings();
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"wifi_reset\"}");
    mqtt.loop();
    delay(200);
    ESP.restart();
  }
}

// ── WiFi ──────────────────────────────────────────────────────
void connectWifi() {
  Preferences prefs;
  prefs.begin("wifi", true);
  String savedSsid = prefs.getString("ssid", "");
  String savedPass = prefs.getString("pass", "");
  prefs.end();

  if (savedSsid.length() > 0) {
    Serial.printf("[WIFI] Trying saved network: %s\n", savedSsid.c_str());
    WiFi.begin(savedSsid.c_str(), savedPass.c_str());
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Starting setup AP: FridgeSetup");
    WiFiManager wm;
    wm.resetSettings(); // clear any ESP32-internal saved credentials so portal is forced
    wm.setConfigPortalTimeout(180);
    if (!wm.autoConnect("FridgeSetup")) {
      Serial.println("[WIFI] Setup portal timed out -- rebooting.");
      ESP.restart();
    }
    prefs.begin("wifi", false);
    prefs.putString("ssid", WiFi.SSID());
    prefs.putString("pass", WiFi.psk());
    prefs.end();
  }

  Serial.printf("[WIFI] Connected to %s  IP: %s\n",
    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
}

// ── NTP time sync ─────────────────────────────────────────────
void syncTime() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("[SNTP] Syncing time");
  time_t now = 0;
  for (int i = 0; i < 20 && now < 1000000000L; i++) {
    delay(500);
    now = time(nullptr);
    Serial.print(".");
  }
  Serial.println();
  if (now > 1000000000L) {
    Serial.println("[SNTP] Time synced.");
  } else {
    Serial.println("[SNTP] Sync failed -- timestamp checks disabled.");
  }
}

// ── MQTT connect (also sets Last Will) ───────────────────────
// Single non-blocking attempt; returns true on success.
bool tryMqttConnect() {
  Serial.print("[MQTT] Connecting...");
  bool ok = mqtt.connect(
    DEVICE_ID,
    MQTT_USER, MQTT_PASS,
    TOPIC_STATUS, 1, true, "offline"
  );
  if (ok) {
    Serial.println(" connected.");
    mqtt.publish(TOPIC_STATUS, "online", true);
    mqtt.subscribe(TOPIC_CMD);
    Serial.print("[MQTT] Subscribed to ");
    Serial.println(TOPIC_CMD);
  } else {
    Serial.print(" failed rc=");
    Serial.println(mqtt.state());
  }
  return ok;
}

// Blocking connect used at boot and after OTA failure.
void connectMqtt() {
  while (!tryMqttConnect()) {
    Serial.println("[MQTT] Retrying in 5s.");
    delay(5000);
  }
}

// ── setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("----------------------------------------");
  Serial.println("  Onigiri Fridge -- booting...");
  Serial.println("----------------------------------------");

  snprintf(TOPIC_CMD,    sizeof(TOPIC_CMD),    "fridge/%s/cmd",    DEVICE_ID);
  snprintf(TOPIC_EVT,    sizeof(TOPIC_EVT),    "fridge/%s/evt",    DEVICE_ID);
  snprintf(TOPIC_STATUS, sizeof(TOPIC_STATUS), "fridge/%s/status", DEVICE_ID);

  memset(seenNonces, 0, sizeof(seenNonces));

  pinMode(RELAY_PIN, OUTPUT);
  pinMode(DOOR_PIN,  INPUT_PULLUP);

  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);
  lastDoorClosed = doorClosed;
  Serial.print("[DOOR] Initial door state: ");
  Serial.println(doorClosed ? "CLOSED" : "OPEN");

  setState(LOCKED);

  connectWifi();
  syncTime();

  wifiClient.setInsecure();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);

  connectMqtt();

  char wifiEvt[192];
  snprintf(wifiEvt, sizeof(wifiEvt),
    "{\"evt\":\"wifi_info\",\"ssid\":\"%s\",\"rssi\":%d,\"version\":\"%s\"}",
    WiFi.SSID().c_str(), WiFi.RSSI(), FIRMWARE_VERSION);
  mqtt.publish(TOPIC_EVT, wifiEvt);
}

// ── loop ──────────────────────────────────────────────────────
void loop() {
  // OTA takes priority: lock fridge, flush publish, download, flash, reboot
  if (otaPending) {
    otaPending = false;
    setState(LOCKED);
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"ota_start\"}");
    mqtt.loop();   // flush the publish before disconnecting
    delay(200);
    mqtt.disconnect();
    performOTA(otaUrl);
    // Only reached on OTA failure — reconnect and report
    connectMqtt();
    mqtt.publish(TOPIC_EVT, "{\"evt\":\"ota_failed\"}");
    return;
  }

  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (now - lastReconnectAttempt >= RECONNECT_INTERVAL_MS) {
      lastReconnectAttempt = now;
      tryMqttConnect();
    }
  }
  mqtt.loop();

  // Door sensing
  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);
  if (doorClosed != lastDoorClosed) {
    lastDoorClosed = doorClosed;
    Serial.print("[DOOR] Door is now: ");
    Serial.println(doorClosed ? "CLOSED" : "OPEN");
    mqtt.publish(TOPIC_EVT, doorClosed
      ? "{\"evt\":\"door_closed\"}"
      : "{\"evt\":\"door_open\"}");
  }

  // Serial 'u' kept for local debugging
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'u' && state == LOCKED) {
      Serial.println("[CMD]  Serial unlock.");
      setState(UNLOCKED);
    }
    if (c == 'r') {
      Preferences prefs;
      prefs.begin("wifi", false);
      prefs.clear();
      prefs.end();
      Serial.println("[WIFI] Credentials cleared -- rebooting into setup AP.");
      delay(500);
      ESP.restart();
    }
  }

  // Lock state machine
  if (state == UNLOCKED) {
    if (!doorClosed && !doorOpenedWhileUnlocked) {
      Serial.println("[DOOR] Door opened while unlocked -- will relock on close.");
      doorOpenedWhileUnlocked = true;
    }
    // Timeout: door never opened — trigger refund path on backend
    if (!doorOpenedWhileUnlocked && (millis() - unlockedAt >= UNLOCK_TIMEOUT_MS)) {
      Serial.println("[LOCK] Unlock timeout -- door never opened.");
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"unlock_timeout\"}");
      setState(LOCKED);
    }
    if (doorOpenedWhileUnlocked && doorClosed) {
      Serial.println("[LOCK] Door closed -- waiting for relock delay.");
      delay(RELOCK_DELAY_MS);
      // Re-check door is still closed after the delay
      doorClosed = (digitalRead(DOOR_PIN) == LOW);
      if (doorClosed) {
        Serial.println("[LOCK] Relocking.");
        setState(LOCKED);
      } else {
        Serial.println("[LOCK] Door reopened during delay -- waiting.");
        // doorOpenedWhileUnlocked remains true; will retry on next close
      }
    }
  }

  // Heartbeat
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    mqtt.publish(TOPIC_STATUS, "online", true);
    Serial.println("[MQTT] Heartbeat.");
  }
}
