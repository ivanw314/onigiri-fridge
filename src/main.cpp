#include <Arduino.h>

const int RELAY_PIN = 26;
const int DOOR_PIN = 27;

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);  // relay off at start
  pinMode(DOOR_PIN, INPUT_PULLUP);
  Serial.println("Phase 1 Stage 3 test starting.");
}
void loop() {
  bool doorClosed = (digitalRead(DOOR_PIN) == LOW);
  Serial.println(doorClosed ? "Door: CLOSED" : "Door: OPEN");
  delay(500);
}