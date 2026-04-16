# ESP8266 Robot Control System (PWA + OTA + WiFi Provisioning)

## Overview

This project is a low-latency robotics control system using:

- ESP8266MOD microcontroller
- Phone-hosted or web-hosted Progressive Web App (PWA)
- WiFi hotspot connection (phone acts as network)
- Local network control (no cloud required for runtime)
- OTA firmware updates from the PWA

The system is designed so:
- The user only plugs in and flashes once via USB
- After that, everything is done over WiFi
- UI lives in a web PWA (not on the ESP)
- ESP acts as a networked robot node (not a UI host)

---

## Goals

### Primary objectives
- <100ms control latency
- Simple onboarding for any phone
- No need to re-flash via USB after initial setup
- Web-based UI (PWA) instead of ESP-hosted HTML
- OTA firmware updates directly from browser/PWA

---

## System Architecture

### 1. ESP8266 Bootstrap Firmware (initial USB flash)
Responsibilities:
- Start in Access Point mode if no WiFi saved
- Accept WiFi credentials via HTTP `/config`
- Store credentials in flash
- Switch to Station mode (connect to phone hotspot)
- Provide `/ping` endpoint for connectivity detection
- Provide `/update` endpoint for OTA firmware updates

Access Point mode:
SSID: ESP_Setup
Password: 12345678
IP: 192.168.4.1


---

### 2. Station Mode (normal operation)
ESP connects to user hotspot:
- Phone acts as WiFi router
- ESP receives local IP
- Device becomes reachable via:
  - `esp8266.local` (mDNS if enabled)
  - or IP address

---

### 3. PWA (Web UI)
Responsibilities:
- Detect ESP state (AP vs Station)
- Guide onboarding flow
- Send WiFi credentials to ESP (`/config`)
- Later: send control commands (WebSocket)
- Upload firmware updates via `/update`

Runs from:
- hosted web app (preferred)
- or locally saved HTML file (fallback)

---

## Connection Flow

### First-time setup

1. User opens PWA
2. PWA checks:
   - `http://esp8266.local/ping`
3. If not found:
   - prompts user to connect to ESP AP (`ESP_Setup`)
4. Once connected:
   - PWA detects `192.168.4.1`
5. User enters WiFi credentials in PWA
6. PWA sends:
7. ESP stores credentials and reboots
8. ESP connects to WiFi hotspot (station mode)

---

### Normal operation

1. PWA opens
2. Detects ESP via:
- `esp8266.local` or IP
3. Establishes control channel (WebSocket planned)
4. Sends real-time motor commands

---

### Firmware update flow

1. PWA downloads latest `.bin` firmware from server
2. Sends file to ESP:

3. ESP flashes firmware and reboots
4. New firmware preserves:
- WiFi logic
- OTA endpoint
- config endpoint

---

## ESP Firmware Requirements (Bootstrap)

Must include:

### WiFi provisioning
- AP mode fallback
- credential storage (flash)

### HTTP endpoints
- `/ping` → connectivity check
- `/config` → receive SSID/password
- `/update` → OTA firmware upload

### OTA safety rule
NEVER remove `/update` endpoint in future firmware versions.

---

## PWA Requirements

Must include:

### Device detection
- Try `esp8266.local`
- Fallback to `192.168.4.1`

### Setup UI states
- “Searching for robot”
- “Connect to ESP access point”
- “Enter WiFi credentials”
- “Success / connected”

### WiFi configuration request
```js
POST /config
{
"ssid": "...",
"password": "..."
}