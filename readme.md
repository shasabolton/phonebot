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
```

## Arcade billing (Stripe Checkout)

Paid talking-head modes are configured in `robots.js`. The Worker repeats the paid-mode
catalog as a server-authoritative allowlist so a browser cannot lower `priceCents`.
Keep both catalogs in sync when changing a product price.

The browser defaults to `/api` on the same origin. If the Worker is on another hostname,
change the `phonebot-billing-api` meta tag in `index.html`. Set `ALLOWED_ORIGINS` in
`worker/wrangler.jsonc` to the exact PWA origins. Optional `?owner=` and `?machine=` query
values are copied into Stripe and play-session metadata; they do not trigger payouts.

### Cloudflare setup

From `worker/`:

```sh
npx wrangler d1 create phonebot-arcade
# Copy the returned ID into wrangler.jsonc.
npx wrangler d1 migrations apply phonebot-arcade --remote
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put GROQ_API_KEY
npx wrangler deploy
```

Copy `worker/.dev.vars.example` to `worker/.dev.vars` for local secrets. Never commit
`.dev.vars` or real Stripe/Groq keys.

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be Stripe **test-mode** values while
testing. `GROQ_API_KEY` is used only by the Worker's metered hosted chat route. Free modes
retain BYOK. In paid arcade modes, a key entered in the app takes priority: chat, Whisper,
and TTS use that key directly and no AI budget is debited. With the key field empty, those
calls route through the Worker using `GROQ_API_KEY` and debit the play-session AI budget.
Payment is still required to enter a paid mode either way. Checkout amounts come from the
Worker mode catalog, not from the browser request body.

Set `GROQ_RATES_JSON` to a JSON object keyed by allowed model. Rates are AUD cents per
million tokens, for example:

```json
{
  "qwen/qwen3.6-27b": {
    "inputCentsPerMillion": 0,
    "outputCentsPerMillion": 0
  }
}
```

Replace the example zeroes with the current effective provider costs. A hosted chat call
is charged at least one cent so a missing or stale rate cannot create unlimited play.

### Stripe webhook and local test

Create a Stripe webhook endpoint:

```text
https://YOUR_WORKER/api/webhooks/stripe
```

Subscribe it to `checkout.session.completed` and
`checkout.session.async_payment_succeeded`. For local testing:

```sh
npx wrangler dev
stripe listen --forward-to http://localhost:8787/api/webhooks/stripe
```

Use the `whsec_...` printed by `stripe listen` as the local
`STRIPE_WEBHOOK_SECRET`; it differs from the Dashboard endpoint secret. Open a paid mode,
complete Checkout with Stripe's test card `4242 4242 4242 4242`, any future expiry and
any CVC. The PWA polls/validates the returned play-session ID and unlocks only after the
verified webhook marks it paid.

Useful checks:

- `priceCents: 0` or `free: true`: mode starts without billing.
- `priceCents: 200`: Checkout asks for A$2.00.
- Finishing Simon Says consumes the session; selecting/rematching requires another payment.
- When hosted chat spends the AI budget, the session becomes `paused_for_payment`; paying
  again creates a continuation session while browser conversation/game state stays intact.