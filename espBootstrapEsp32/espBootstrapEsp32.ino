#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Update.h>
#include <ESP32Servo.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "phonebotProcess.h"

// ===== CONFIG =====
/** Bump this when releasing firmware; keep version.json in the repo in sync (manual for now). */
#define FW_VERSION "1.2.3"

/**
 * BUILD (ESP32 Dev Module, 4MB flash): sketch + BLE exceeds the default 1.2MB app slot.
 * Arduino IDE → Tools → Partition Scheme →
 *   "Minimal SPIFFS (1.9MB APP with OTA/128KB SPIFFS)"
 * (or "Custom" to use partitions.csv in this folder). WiFi OTA still works with dual app slots.
 */

/** Phonebot BLE GATT — same UUIDs as bluetoothTransmitter.js */
#define BLE_SERVICE_UUID        "4faf2012-5fb4-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_PIN_SETUP_UUID "4faf2013-5fb4-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_ACTION_UUID    "4faf2014-5fb4-459e-8fcc-c5c9c331914b"
#define BLE_CHAR_STATUS_UUID    "4faf2015-5fb4-459e-8fcc-c5c9c331914b"

const char* AP_PASS = "12345678";

WebServer server(80);

// Unique per device (from eFuse MAC lower 24 bits — same Robot-XXXXXX shape as ESP8266 bootstrap)
String robotApSsid;
String robotHostname;

String jsonEscape(const String& s);

// Stored credentials
String ssid = "";
String password = "";

const int MAX_SERVO_CHANNELS = 8;
Servo servos[MAX_SERVO_CHANNELS];
bool servoAttached[MAX_SERVO_CHANNELS] = {false};
int servoPins[MAX_SERVO_CHANNELS] = {-1, -1, -1, -1, -1, -1, -1, -1};

/**
 * Control source: WiFi/Bluetooth action stream vs screen-light phototransistors.
 * Default is LIGHT when no WiFi (and no BT) link is up; WiFi /action or /pin-setup
 * switches to WIFI. POST /control-source with body "light" forces optical mode
 * even while station WiFi stays connected (phone sends patches, not /action).
 */
enum ControlSource : uint8_t {
  CONTROL_LIGHT = 0,
  CONTROL_WIFI = 1,
  CONTROL_BT = 2
};
ControlSource controlSource = CONTROL_LIGHT;
bool staWasConnected = false;
bool bleClientConnected = false;
BLEServer* bleServer = nullptr;
BLECharacteristic* bleStatusChar = nullptr;
uint32_t lastLightUpdateMs = 0;
const uint32_t LIGHT_UPDATE_INTERVAL_MS = 20;

/** Servo GPIO → ADC1 phototransistor GPIO (VP=36, VN=39). ADC1 avoids WiFi/ADC2 conflict. */
struct LightChannel {
  int servoPin;
  int sensorPin;
};
const LightChannel LIGHT_CHANNELS[] = {
  {23, 36}, // VP
  {22, 39}, // VN
  {21, 34},
  {19, 35},
  {18, 32},
  {25, 33}
};
const int LIGHT_CHANNEL_COUNT = sizeof(LIGHT_CHANNELS) / sizeof(LIGHT_CHANNELS[0]);

/**
 * Optical ADC → servo µs calibration (100 kΩ load, phone screen).
 * Defaults from bench: ~142 mV (floor) → 1000 µs, ~182 mV (full white) → 2000 µs.
 * Later: POST /light-calibrate with body "mVMin:usMin,mVMax:usMax" (e.g. "142:1000,182:2000").
 */
int lightMvMin = 142;
int lightUsMin = 1000;
int lightMvMax = 182;
int lightUsMax = 2000;

uint32_t deviceId24() {
  return (uint32_t)(ESP.getEfuseMac() & 0xFFFFFF);
}

int findServoIndexByPin(int pin) {
  for (int i = 0; i < MAX_SERVO_CHANNELS; i++) {
    if (servoAttached[i] && servoPins[i] == pin) return i;
  }
  return -1;
}

int findFreeServoIndex() {
  for (int i = 0; i < MAX_SERVO_CHANNELS; i++) {
    if (!servoAttached[i]) return i;
  }
  return -1;
}

bool parseIntField(const String& s, int& value) {
  if (s.length() == 0) return false;
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (i == 0 && (c == '-' || c == '+')) continue;
    if (c < '0' || c > '9') return false;
  }
  value = s.toInt();
  return true;
}

const char* controlSourceName() {
  switch (controlSource) {
    case CONTROL_LIGHT: return "light";
    case CONTROL_WIFI: return "wifi";
    case CONTROL_BT: return "bluetooth";
    default: return "unknown";
  }
}

ProcessResult processPinSetup(const String& body, ControlSource src) {
  ProcessResult r = {false, 0, ""};
  String payload = body;
  payload.trim();
  if (payload.length() == 0) {
    r.error = "Empty payload";
    return r;
  }

  setControlSource(src);

  int start = 0;
  while (start < payload.length()) {
    int comma = payload.indexOf(',', start);
    String item = comma == -1 ? payload.substring(start) : payload.substring(start, comma);
    item.trim();
    if (item.length() > 0) {
      int c1 = item.indexOf(':');
      int c2 = item.indexOf(':', c1 + 1);
      int c3 = item.indexOf(':', c2 + 1);
      int c4 = item.indexOf(':', c3 + 1);
      if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) {
        r.error = "Bad setup item";
        return r;
      }
      String pinStr = item.substring(0, c1);
      String typeStr = item.substring(c1 + 1, c2);
      String minStr = item.substring(c2 + 1, c3);
      String maxStr = item.substring(c3 + 1, c4);
      String homeStr = item.substring(c4 + 1);
      pinStr.trim(); typeStr.trim(); minStr.trim(); maxStr.trim(); homeStr.trim();
      if (typeStr != "servo") {
        r.error = "Unsupported output type";
        return r;
      }

      int pin = -1, minUs = 1000, maxUs = 2000, homeUs = 1500;
      if (!parseIntField(pinStr, pin) || !parseIntField(minStr, minUs) ||
          !parseIntField(maxStr, maxUs) || !parseIntField(homeStr, homeUs)) {
        r.error = "Bad numeric setup values";
        return r;
      }

      int idx = findServoIndexByPin(pin);
      if (idx < 0) idx = findFreeServoIndex();
      if (idx < 0) {
        r.error = "No servo slots available";
        return r;
      }

      if (!servoAttached[idx]) {
        servos[idx].attach(pin, minUs, maxUs);
        servoAttached[idx] = true;
        servoPins[idx] = pin;
      }
      servos[idx].writeMicroseconds(homeUs);
      r.count++;
    }
    if (comma == -1) break;
    start = comma + 1;
  }

  r.ok = true;
  return r;
}

ProcessResult processAction(const String& body, ControlSource src) {
  ProcessResult r = {false, 0, ""};
  String payload = body;
  payload.trim();
  if (payload.length() == 0) {
    r.error = "Empty payload";
    return r;
  }

  setControlSource(src);

  int start = 0;
  while (start < payload.length()) {
    int comma = payload.indexOf(',', start);
    String item = comma == -1 ? payload.substring(start) : payload.substring(start, comma);
    item.trim();
    if (item.length() > 0) {
      int c = item.indexOf(':');
      if (c < 0) {
        r.error = "Bad action item";
        return r;
      }
      String pinStr = item.substring(0, c);
      String usStr = item.substring(c + 1);
      pinStr.trim();
      usStr.trim();
      int pin = -1, us = 1500;
      if (!parseIntField(pinStr, pin) || !parseIntField(usStr, us)) {
        r.error = "Bad action values";
        return r;
      }
      int idx = findServoIndexByPin(pin);
      if (idx >= 0 && servoAttached[idx]) {
        servos[idx].writeMicroseconds(us);
        r.count++;
      }
    }
    if (comma == -1) break;
    start = comma + 1;
  }

  r.ok = true;
  return r;
}

void updateBleStatusValue() {
  if (!bleStatusChar) return;
  String json = "{\"fwVersion\":\"" + jsonEscape(String(FW_VERSION)) + "\",";
  json += "\"controlSource\":\"" + String(controlSourceName()) + "\",";
  json += "\"bleConnected\":" + String(bleClientConnected ? "true" : "false") + "}";
  bleStatusChar->setValue(json.c_str());
}

int millivoltsToServoUs(int mv) {
  int mv0 = lightMvMin;
  int mv1 = lightMvMax;
  int us0 = lightUsMin;
  int us1 = lightUsMax;
  if (mv1 <= mv0) {
    // Degenerate cal — fall back to mid.
    return (us0 + us1) / 2;
  }
  if (mv <= mv0) return us0;
  if (mv >= mv1) return us1;
  return us0 + (int)(((long)(mv - mv0) * (us1 - us0)) / (mv1 - mv0));
}

bool ensureServoAttached(int pin, int minUs = 1000, int maxUs = 2000) {
  int idx = findServoIndexByPin(pin);
  if (idx >= 0 && servoAttached[idx]) return true;
  idx = findFreeServoIndex();
  if (idx < 0) return false;
  servos[idx].attach(pin, minUs, maxUs);
  servoAttached[idx] = true;
  servoPins[idx] = pin;
  return true;
}

void ensureLightChannelServosAttached() {
  for (int i = 0; i < LIGHT_CHANNEL_COUNT; i++) {
    ensureServoAttached(LIGHT_CHANNELS[i].servoPin);
  }
}

void setControlSource(ControlSource src) {
  if (controlSource == src) return;
  controlSource = src;
  Serial.print("Control source → ");
  Serial.println(controlSourceName());
  if (controlSource == CONTROL_LIGHT) {
    ensureLightChannelServosAttached();
  }
  updateBleStatusValue();
}

void updateServosFromLight() {
  for (int i = 0; i < LIGHT_CHANNEL_COUNT; i++) {
    const int servoPin = LIGHT_CHANNELS[i].servoPin;
    const int sensorPin = LIGHT_CHANNELS[i].sensorPin;
    int idx = findServoIndexByPin(servoPin);
    if (idx < 0 || !servoAttached[idx]) continue;
    int mv = analogReadMilliVolts(sensorPin);
    int us = millivoltsToServoUs(mv);
    servos[idx].writeMicroseconds(us);
  }
}

/** Sensor label for UI (VP/VN or GPIO number). */
String lightSensorLabel(int sensorPin) {
  if (sensorPin == 36) return String("VP");
  if (sensorPin == 39) return String("VN");
  return String(sensorPin);
}

void handleLightSensors() {
  sendCORSHeaders();
  String json = "{";
  json += "\"ok\":true,";
  json += "\"controlSource\":\"" + String(controlSourceName()) + "\",";
  json += "\"fwVersion\":\"" + jsonEscape(String(FW_VERSION)) + "\",";
  json += "\"cal\":{";
  json += "\"mvMin\":" + String(lightMvMin) + ",";
  json += "\"usMin\":" + String(lightUsMin) + ",";
  json += "\"mvMax\":" + String(lightMvMax) + ",";
  json += "\"usMax\":" + String(lightUsMax);
  json += "},";
  json += "\"channels\":[";
  for (int i = 0; i < LIGHT_CHANNEL_COUNT; i++) {
    if (i > 0) json += ",";
    const int servoPin = LIGHT_CHANNELS[i].servoPin;
    const int sensorPin = LIGHT_CHANNELS[i].sensorPin;
    int raw = analogRead(sensorPin);
    int mv = analogReadMilliVolts(sensorPin);
    int us = millivoltsToServoUs(mv);
    int idx = findServoIndexByPin(servoPin);
    bool attached = idx >= 0 && servoAttached[idx];
    json += "{";
    json += "\"index\":" + String(i) + ",";
    json += "\"servoPin\":" + String(servoPin) + ",";
    json += "\"sensorPin\":" + String(sensorPin) + ",";
    json += "\"sensor\":\"" + jsonEscape(lightSensorLabel(sensorPin)) + "\",";
    json += "\"raw\":" + String(raw) + ",";
    json += "\"mv\":" + String(mv) + ",";
    json += "\"us\":" + String(us) + ",";
    json += "\"attached\":" + String(attached ? "true" : "false");
    json += "}";
  }
  json += "]}";
  server.send(200, "application/json", json);
}

/**
 * POST body: "mVMin:usMin,mVMax:usMax" e.g. "142:1000,182:2000"
 * Updates runtime optical calibration (not persisted yet).
 */
void handleLightCalibrate() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "text/plain", "Missing payload");
    return;
  }
  String body = server.arg("plain");
  body.trim();
  int comma = body.indexOf(',');
  if (comma < 0) {
    server.send(400, "text/plain", "Expected mVMin:usMin,mVMax:usMax");
    return;
  }
  String a = body.substring(0, comma);
  String b = body.substring(comma + 1);
  a.trim();
  b.trim();
  int c1 = a.indexOf(':');
  int c2 = b.indexOf(':');
  if (c1 < 0 || c2 < 0) {
    server.send(400, "text/plain", "Expected mVMin:usMin,mVMax:usMax");
    return;
  }
  int mvMin = -1, usMin = -1, mvMax = -1, usMax = -1;
  if (!parseIntField(a.substring(0, c1), mvMin) ||
      !parseIntField(a.substring(c1 + 1), usMin) ||
      !parseIntField(b.substring(0, c2), mvMax) ||
      !parseIntField(b.substring(c2 + 1), usMax)) {
    server.send(400, "text/plain", "Bad numeric calibrate values");
    return;
  }
  if (mvMax <= mvMin) {
    server.send(400, "text/plain", "mVMax must be > mVMin");
    return;
  }
  lightMvMin = mvMin;
  lightUsMin = usMin;
  lightMvMax = mvMax;
  lightUsMax = usMax;
  Serial.printf("Light cal → %d mV:%d us … %d mV:%d us\n",
                lightMvMin, lightUsMin, lightMvMax, lightUsMax);
  String json = "{";
  json += "\"ok\":true,";
  json += "\"mvMin\":" + String(lightMvMin) + ",";
  json += "\"usMin\":" + String(lightUsMin) + ",";
  json += "\"mvMax\":" + String(lightMvMax) + ",";
  json += "\"usMax\":" + String(lightUsMax);
  json += "}";
  server.send(200, "application/json", json);
}

void sendCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() {
  sendCORSHeaders();
  server.send(204);
}

void handleControlSource() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "text/plain", "Missing payload");
    return;
  }
  String body = server.arg("plain");
  body.trim();
  body.toLowerCase();
  if (body == "light" || body == "screen" || body == "screen-light" || body == "screen light") {
    setControlSource(CONTROL_LIGHT);
    String json = "{\"ok\":true,\"controlSource\":\"light\"}";
    server.send(200, "application/json", json);
    return;
  }
  if (body == "wifi" || body == "action") {
    setControlSource(CONTROL_WIFI);
    String json = "{\"ok\":true,\"controlSource\":\"wifi\"}";
    server.send(200, "application/json", json);
    return;
  }
  if (body == "bt" || body == "bluetooth") {
    setControlSource(CONTROL_BT);
    String json = "{\"ok\":true,\"controlSource\":\"bluetooth\"}";
    server.send(200, "application/json", json);
    return;
  }
  server.send(400, "text/plain", "Expected body: light | wifi | bluetooth");
}

void handlePinSetup() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "text/plain", "Missing payload");
    return;
  }

  ProcessResult r = processPinSetup(server.arg("plain"), CONTROL_WIFI);
  if (!r.ok) {
    server.send(400, "text/plain", r.error);
    return;
  }
  String json = "{\"ok\":true,\"attached\":" + String(r.count) + "}";
  server.send(200, "application/json", json);
}

void handleAction() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "text/plain", "Missing payload");
    return;
  }

  ProcessResult r = processAction(server.arg("plain"), CONTROL_WIFI);
  if (!r.ok) {
    server.send(400, "text/plain", r.error);
    return;
  }
  String json = "{\"ok\":true,\"applied\":" + String(r.count) + "}";
  server.send(200, "application/json", json);
}

class PhonebotBLEServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleClientConnected = true;
    setControlSource(CONTROL_BT);
    Serial.println("BLE client connected");
  }

  void onDisconnect(BLEServer* pServer) {
    bleClientConnected = false;
    Serial.println("BLE client disconnected");
    if (WiFi.status() == WL_CONNECTED) {
      setControlSource(CONTROL_WIFI);
    } else {
      setControlSource(CONTROL_LIGHT);
    }
    BLEDevice::startAdvertising();
  }
};

class PinSetupBLECallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String rx = pCharacteristic->getValue();
    if (rx.length() == 0) return;
    ProcessResult r = processPinSetup(rx, CONTROL_BT);
    if (!r.ok) {
      Serial.print("BLE pin-setup error: ");
      Serial.println(r.error);
    }
  }
};

class ActionBLECallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String rx = pCharacteristic->getValue();
    if (rx.length() == 0) return;
    ProcessResult r = processAction(rx, CONTROL_BT);
    if (!r.ok) {
      Serial.print("BLE action error: ");
      Serial.println(r.error);
    }
  }
};

void startBLE() {
  BLEDevice::init(robotHostname.c_str());
  BLEDevice::setMTU(517);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new PhonebotBLEServerCallbacks());

  BLEService* service = bleServer->createService(BLE_SERVICE_UUID);

  BLECharacteristic* pinSetupChar = service->createCharacteristic(
    BLE_CHAR_PIN_SETUP_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pinSetupChar->setCallbacks(new PinSetupBLECallbacks());

  BLECharacteristic* actionChar = service->createCharacteristic(
    BLE_CHAR_ACTION_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  actionChar->setCallbacks(new ActionBLECallbacks());

  bleStatusChar = service->createCharacteristic(
    BLE_CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ
  );
  updateBleStatusValue();

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.print("BLE advertising as ");
  Serial.println(robotHostname);
}

// ===== FUNCTIONS =====

void buildRobotIdentity() {
  uint32_t cid = deviceId24();
  char chipHexUpper[8];
  char chipHexLower[8];
  snprintf(chipHexUpper, sizeof(chipHexUpper), "%06X", cid);
  snprintf(chipHexLower, sizeof(chipHexLower), "%06x", cid);
  robotApSsid = String("Robot-") + chipHexUpper;
  robotHostname = String("robot-") + chipHexLower;
}

String jsonEscape(const String& s) {
  String out;
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '\\' || c == '"') out += '\\';
    out += c;
  }
  return out;
}

void applyStaServices() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (MDNS.begin(robotHostname.c_str())) {
    MDNS.addService("http", "tcp", 80);
  }
}

void saveCredentials(String s, String p) {
  File f = LittleFS.open("/wifi.txt", "w");
  f.println(s);
  f.println(p);
  f.close();
}

bool loadCredentials() {
  if (!LittleFS.exists("/wifi.txt")) return false;

  File f = LittleFS.open("/wifi.txt", "r");
  ssid = f.readStringUntil('\n');
  password = f.readStringUntil('\n');
  ssid.trim();
  password.trim();
  f.close();

  return ssid.length() > 0;
}

// ===== SETUP MODE (AP) =====

void startAP() {
  // AP+STA allows WiFi scanning while still hosting setup AP.
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(robotApSsid.c_str(), AP_PASS);

  Serial.println("AP Mode Started");
  Serial.print("AP SSID: ");
  Serial.println(robotApSsid);
  Serial.println(WiFi.softAPIP());
}

// ===== CONNECT TO WIFI =====

bool connectToWiFi() {
  // Keep setup AP available while trying station connection.
  WiFi.mode(WIFI_AP_STA);
  WiFi.setHostname(robotHostname.c_str());
  WiFi.begin(ssid.c_str(), password.c_str());

  Serial.print("Connecting");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected!");
    Serial.println(WiFi.localIP());
    applyStaServices();
    return true;
  }

  Serial.println("\nFailed to connect");
  return false;
}

// ===== HTTP ENDPOINTS =====

void handleStatus() {
  sendCORSHeaders();
  bool connected = WiFi.status() == WL_CONNECTED;
  String ip = connected ? WiFi.localIP().toString() : "";

  char chipBuf[16];
  snprintf(chipBuf, sizeof(chipBuf), "%06X", deviceId24());

  String mdnsFull = robotHostname + ".local";
  String json = "{";
  json += "\"chipId\":\"" + String(chipBuf) + "\",";
  json += "\"apSsid\":\"" + jsonEscape(robotApSsid) + "\",";
  json += "\"hostname\":\"" + jsonEscape(robotHostname) + "\",";
  json += "\"mdnsHost\":\"" + jsonEscape(mdnsFull) + "\",";
  json += "\"connected\":" + String(connected ? "true" : "false") + ",";
  json += "\"ip\":\"" + ip + "\",";
  json += "\"fwVersion\":\"" + jsonEscape(String(FW_VERSION)) + "\",";
  json += "\"controlSource\":\"" + String(controlSourceName()) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleVersion() {
  sendCORSHeaders();
  String json = "{\"fwVersion\":\"" + jsonEscape(String(FW_VERSION)) + "\"}";
  server.send(200, "application/json", json);
}

void handleScan() {
  sendCORSHeaders();

  int n = WiFi.scanNetworks();
  String json = "[";

  for (int i = 0; i < n; i++) {
    if (i > 0) json += ",";

    String networkSSID = WiFi.SSID(i);
    networkSSID.replace("\\", "\\\\");
    networkSSID.replace("\"", "\\\"");

    json += "{";
    json += "\"ssid\":\"" + networkSSID + "\",";
    json += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    json += "\"open\":" + String(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "true" : "false");
    json += "}";
  }

  json += "]";
  server.send(200, "application/json", json);
  WiFi.scanDelete();
}

// Receive credentials from PWA
void handleConfig() {
  sendCORSHeaders();

  if (server.hasArg("plain")) {
    String body = server.arg("plain");

    int s = body.indexOf("ssid");
    int p = body.indexOf("password");

    if (s >= 0 && p >= 0) {
      // Very simple parsing (expects JSON)
      int s1 = body.indexOf(":", s) + 2;
      int s2 = body.indexOf("\"", s1);
      int p1 = body.indexOf(":", p) + 2;
      int p2 = body.indexOf("\"", p1);

      ssid = body.substring(s1, s2);
      password = body.substring(p1, p2);

      saveCredentials(ssid, password);
      bool connected = connectToWiFi();
      String staIp = connected ? WiFi.localIP().toString() : "";
      String json = "{\"saved\":true,\"connected\":" + String(connected ? "true" : "false") +
                    ",\"ip\":\"" + staIp + "\"}";
      server.send(200, "application/json", json);
      return;
    }
  }

  server.send(400, "application/json", "{\"saved\":false,\"error\":\"Invalid payload\"}");
}

// OTA update endpoint
void handleUpdateUpload() {
  HTTPUpload& upload = server.upload();

  if (upload.status == UPLOAD_FILE_START) {
    Serial.println("Update Start");
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Serial.println("Not enough space for update");
      Update.printError(Serial);
    }
  }
  else if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Update.printError(Serial);
    }
  }
  else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.printf("Update Success: %u\n", upload.totalSize);
    } else {
      Serial.println("Update Failed");
      Update.printError(Serial);
    }
  }
}

void handleUpdate() {
  sendCORSHeaders();
  server.sendHeader("Connection", "close");
  server.send(200, "text/plain", Update.hasError() ? "FAIL" : "Updating...");
  delay(1000);
  ESP.restart();
}

// Simple ping
void handlePing() {
  sendCORSHeaders();
  server.send(200, "text/plain", "OK");
}

// ===== SETUP =====

void setup() {
  Serial.begin(115200);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
  }

  buildRobotIdentity();

  // ADC1 full-scale ~3.3 V for phototransistor → µs mapping
  analogSetAttenuation(ADC_11db);
  ensureLightChannelServosAttached();

  bool hasCreds = loadCredentials();
  startAP();

  WiFi.setHostname(robotHostname.c_str());

  bool staConnected = false;
  if (hasCreds) {
    if (connectToWiFi()) {
      Serial.println("Running in AP+STA mode (connected)");
      staConnected = true;
    } else {
      Serial.println("Running in AP+STA mode (STA connect failed)");
    }
  }

  // No WiFi and no BLE link → optical default. STA or BLE up → wait for commands.
  staWasConnected = staConnected;
  if (staConnected) {
    setControlSource(CONTROL_WIFI);
  } else {
    setControlSource(CONTROL_LIGHT);
  }

  startBLE();

  // Routes
  server.on("/config", HTTP_OPTIONS, handleOptions);
  server.on("/update", HTTP_OPTIONS, handleOptions);
  server.on("/ping", HTTP_OPTIONS, handleOptions);
  server.on("/scan", HTTP_OPTIONS, handleOptions);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/version", HTTP_OPTIONS, handleOptions);
  server.on("/pin-setup", HTTP_OPTIONS, handleOptions);
  server.on("/action", HTTP_OPTIONS, handleOptions);
  server.on("/control-source", HTTP_OPTIONS, handleOptions);
  server.on("/light-sensors", HTTP_OPTIONS, handleOptions);
  server.on("/light-calibrate", HTTP_OPTIONS, handleOptions);
  server.on("/config", HTTP_POST, handleConfig);
  server.on("/update", HTTP_POST, handleUpdate, handleUpdateUpload);
  server.on("/pin-setup", HTTP_POST, handlePinSetup);
  server.on("/action", HTTP_POST, handleAction);
  server.on("/control-source", HTTP_POST, handleControlSource);
  server.on("/light-calibrate", HTTP_POST, handleLightCalibrate);
  server.on("/ping", HTTP_GET, handlePing);
  server.on("/scan", HTTP_GET, handleScan);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/version", HTTP_GET, handleVersion);
  server.on("/light-sensors", HTTP_GET, handleLightSensors);

  server.begin();
}

// ===== LOOP =====

void loop() {
  server.handleClient();

  bool staConnected = WiFi.status() == WL_CONNECTED;
  if (staWasConnected && !staConnected) {
    // Lost station WiFi — fall back to light unless BLE is still connected.
    if (!bleClientConnected) {
      setControlSource(CONTROL_LIGHT);
    }
  }
  staWasConnected = staConnected;

  if (controlSource == CONTROL_LIGHT) {
    uint32_t now = millis();
    if (now - lastLightUpdateMs >= LIGHT_UPDATE_INTERVAL_MS) {
      lastLightUpdateMs = now;
      updateServosFromLight();
    }
  }
}
