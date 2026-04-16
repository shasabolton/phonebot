#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <LittleFS.h>
#include <Updater.h>
#include <ESP8266httpUpdate.h>

// ===== CONFIG =====
const char* AP_PASS = "12345678";

ESP8266WebServer server(80);

// Unique per device (from chip ID)
String robotApSsid;
String robotHostname;

// Stored credentials
String ssid = "";
String password = "";

// ===== FUNCTIONS =====

void buildRobotIdentity() {
  uint32_t cid = ESP.getChipId() & 0xFFFFFF;
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

void sendCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() {
  sendCORSHeaders();
  server.send(204);
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
  WiFi.hostname(robotHostname.c_str());
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
  snprintf(chipBuf, sizeof(chipBuf), "%06X", ESP.getChipId() & 0xFFFFFF);

  String mdnsFull = robotHostname + ".local";
  String json = "{";
  json += "\"chipId\":\"" + String(chipBuf) + "\",";
  json += "\"apSsid\":\"" + jsonEscape(robotApSsid) + "\",";
  json += "\"hostname\":\"" + jsonEscape(robotHostname) + "\",";
  json += "\"mdnsHost\":\"" + jsonEscape(mdnsFull) + "\",";
  json += "\"connected\":" + String(connected ? "true" : "false") + ",";
  json += "\"ip\":\"" + ip + "\"";
  json += "}";
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
    json += "\"open\":" + String(WiFi.encryptionType(i) == ENC_TYPE_NONE ? "true" : "false");
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
    if (!Update.begin(ESP.getFreeSketchSpace())) {
  Serial.println("Not enough space for update");
}
  } 
  else if (upload.status == UPLOAD_FILE_WRITE) {
    Update.write(upload.buf, upload.currentSize);
  } 
  else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.println("Update Success");
    } else {
      Serial.println("Update Failed");
    }
  }
}

void handleUpdate() {
  sendCORSHeaders();
  server.send(200, "text/plain", "Updating...");
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

  LittleFS.begin();

  buildRobotIdentity();

  bool hasCreds = loadCredentials();
  startAP();

  WiFi.hostname(robotHostname.c_str());

  if (hasCreds) {
    if (connectToWiFi()) {
      Serial.println("Running in AP+STA mode (connected)");
    } else {
      Serial.println("Running in AP+STA mode (STA connect failed)");
    }
  }

  // Routes
  server.on("/config", HTTP_OPTIONS, handleOptions);
  server.on("/update", HTTP_OPTIONS, handleOptions);
  server.on("/ping", HTTP_OPTIONS, handleOptions);
  server.on("/scan", HTTP_OPTIONS, handleOptions);
  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/config", HTTP_POST, handleConfig);
  server.on("/update", HTTP_POST, handleUpdate, handleUpdateUpload);
  server.on("/ping", HTTP_GET, handlePing);
  server.on("/scan", HTTP_GET, handleScan);
  server.on("/status", HTTP_GET, handleStatus);

  server.begin();
}

// ===== LOOP =====

void loop() {
  MDNS.update();
  server.handleClient();
}
