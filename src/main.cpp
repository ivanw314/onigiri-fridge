#include <Arduino.h>

const int RELAY_PIN = 26;
const int DOOR_PIN = 27;

enum State { LOCKED, UNLOCKED };
State state = LOCKED;
bool lastDoorClosed = true;
bool doorOpenedWhileUnlocked = false;

void setState(State newState) {
  state = newState;
  switch (state) {
    case LOCKED:
      Serial.println("[LOCK] Relay engaging — fridge is LOCKED");
      Serial.flush();
      digitalWrite(RELAY_PIN, HIGH);
      break;
    case UNLOCKED:
      doorOpenedWhileUnlocked = false;
      Serial.println("[LOCK] Relay releasing — fridge is UNLOCKED");
      Serial.println("[LOCK] Open the door, then close it to relock.");
      Serial.flush();
      digitalWrite(RELAY_PIN, LOW);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("----------------------------------------");
  Serial.println("  Onigiri Fridge Phase 1 — booting...");
  Serial.println("----------------------------------------");
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(DOOR_PIN, INPUT_PULLUP);

  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);
  lastDoorClosed = doorClosed;
  Serial.print("[DOOR] Initial door state: ");
  Serial.println(doorClosed ? "CLOSED" : "OPEN");

  setState(LOCKED);
  Serial.println("[CMD]  Send 'u' to unlock.");
}

void loop() {
  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);

  if (doorClosed != lastDoorClosed) {
    lastDoorClosed = doorClosed;
    Serial.print("[DOOR] Door is now: ");
    Serial.println(doorClosed ? "CLOSED" : "OPEN");
  }

  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'u') {
      if (state == LOCKED) {
        setState(UNLOCKED);
      } else {
        Serial.println("[CMD]  Already unlocked — close the door to relock.");
      }
    } else {
      Serial.print("[CMD]  Unknown command: '");
      Serial.print(c);
      Serial.println("' — send 'u' to unlock.");
    }
  }

  if (state == UNLOCKED) {
    if (!doorClosed) doorOpenedWhileUnlocked = true;
    if (doorOpenedWhileUnlocked && doorClosed) setState(LOCKED);
  }
}
