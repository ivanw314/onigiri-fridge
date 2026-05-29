#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "secrets.h"

// ── constants (not secrets) ───────────────────────────────────
const int MQTT_PORT = 8883;
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

unsigned long lastHeartbeat       = 0;
const unsigned long HEARTBEAT_MS  = 30000;

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
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"unlocked\"}");
      break;
  }
}

// ── MQTT message handler ──────────────────────────────────────
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[256];
  unsigned int len = min(length, (unsigned int)sizeof(msg) - 1);
  memcpy(msg, payload, len);
  msg[len] = '\0';

  Serial.print("[MQTT] Received on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(msg);

  // Simple string match -- no HMAC yet (Phase 3 adds that)
  if (strstr(msg, "unlock") != NULL) {
    if (state == LOCKED) {
      Serial.println("[CMD]  Unlock command received via MQTT.");
      setState(UNLOCKED);
    } else {
      Serial.println("[CMD]  Already unlocked.");
      mqtt.publish(TOPIC_EVT, "{\"evt\":\"already_unlocked\"}");
    }
  } else {
    Serial.println("[CMD]  Unrecognised command -- ignored.");
  }
}

// ── WiFi ──────────────────────────────────────────────────────
void connectWifi() {
  Serial.print("[WIFI] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("[WIFI] Connected. IP: ");
  Serial.println(WiFi.localIP());
}

// ── MQTT connect (also sets Last Will) ───────────────────────
void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connecting...");
    bool ok = mqtt.connect(
      DEVICE_ID,              // client ID
      MQTT_USER, MQTT_PASS,   // credentials
      TOPIC_STATUS,           // Last Will topic
      1,                      // Last Will QoS
      true,                   // Last Will retain
      "offline"               // Last Will payload
    );
    if (ok) {
      Serial.println(" connected.");
      mqtt.publish(TOPIC_STATUS, "online", true);  // retained
      mqtt.subscribe(TOPIC_CMD);
      Serial.print("[MQTT] Subscribed to ");
      Serial.println(TOPIC_CMD);
    } else {
      Serial.print(" failed rc=");
      Serial.print(mqtt.state());
      Serial.println(". Retrying in 5s.");
      delay(5000);
    }
  }
}

// ── setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("----------------------------------------");
  Serial.println("  Onigiri Fridge Phase 2 -- booting...");
  Serial.println("----------------------------------------");

  snprintf(TOPIC_CMD,    sizeof(TOPIC_CMD),    "fridge/%s/cmd",    DEVICE_ID);
  snprintf(TOPIC_EVT,    sizeof(TOPIC_EVT),    "fridge/%s/evt",    DEVICE_ID);
  snprintf(TOPIC_STATUS, sizeof(TOPIC_STATUS), "fridge/%s/status", DEVICE_ID);

  pinMode(RELAY_PIN, OUTPUT);
  pinMode(DOOR_PIN,  INPUT_PULLUP);

  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);
  lastDoorClosed = doorClosed;
  Serial.print("[DOOR] Initial door state: ");
  Serial.println(doorClosed ? "CLOSED" : "OPEN");

  setState(LOCKED);

  connectWifi();

  wifiClient.setInsecure();  // no cert pinning yet -- Phase 3 adds this
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);

  connectMqtt();
}

// ── loop ──────────────────────────────────────────────────────
void loop() {
  if (!mqtt.connected()) {
    Serial.println("[MQTT] Disconnected -- reconnecting.");
    connectMqtt();
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
  }

  // Lock state machine
  if (state == UNLOCKED) {
    if (!doorClosed && !doorOpenedWhileUnlocked) {
      Serial.println("[DOOR] Door opened while unlocked -- will relock on close.");
      doorOpenedWhileUnlocked = true;
    }
    if (doorOpenedWhileUnlocked && doorClosed) {
      Serial.println("[LOCK] Door closed after opening -- relocking.");
      setState(LOCKED);
    }
  }

  // Heartbeat
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    mqtt.publish(TOPIC_STATUS, "online", true);
    Serial.println("[MQTT] Heartbeat.");
  }
}
