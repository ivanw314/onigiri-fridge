#pragma once

// WiFi credentials are now stored in NVS via WiFiManager.
// On first boot, the device creates a "FridgeSetup" AP for provisioning.
// WIFI_SSID and WIFI_PASS are no longer needed here.

// HiveMQ
const char* MQTT_HOST = "YOUR_HIVEMQ_CLUSTER.s1.eu.hivemq.cloud";
const char* MQTT_USER = "YOUR_HIVEMQ_USERNAME";
const char* MQTT_PASS = "YOUR_HIVEMQ_PASSWORD";

// Device
const char* DEVICE_ID     = "onigiri";
const char* DEVICE_SECRET = "YOUR_DEVICE_SECRET";
