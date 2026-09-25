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

Paid talking-head modes share one arcade checkout in `robots.js` / the Worker catalog.
`priceCents` is the default suggestion (A$2); players can pick any whole-dollar amount from
A$1–A$10 with ±$1 controls. The full payment becomes hosted AI credit (bottom bar; A$10 =
full width). Top-up uses the same paywall; the Worker silently charges only what fits under
the A$10 cap when they already have credit. Credit expires after 7 days without use (keeps
D1 session rows from growing forever). Margin comes from `ARCADE_AI_MARKUP` (default `2`,
overridable via `GROQ_RATE_MARKUP`) on Groq costs. The bar reads a local credit cache so
menu/free use does not call the Worker; the cache updates after payment and hosted AI calls.

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
Hand-raised conversation turns with the hosted key use one Worker request for transcription,
chat, and speech, with one session check and one combined budget debit. BYOK remains entirely
client-side and continues to call Groq directly. Hand-raised recordings stop automatically
after 20 seconds. The agent UI shows the percentage and dollar amount of the hosted AI budget
used; while BYOK is active it shows that the hosted quota is not being consumed.
Payment is still required to enter a paid mode either way. Checkout amounts come from the
Worker mode catalog, not from the browser request body.

Set `GROQ_RATES_JSON` to a JSON object keyed by allowed model. Rates are AUD cents per
million tokens, for example:

```json
{
  "openai/gpt-oss-20b": {
    "inputCentsPerMillion": 11.25,
    "outputCentsPerMillion": 45
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
- AI modes: paywall lets the player choose A$1–A$10 (default A$2). Credit equals the
  payment; costs are marked up by `ARCADE_AI_MARKUP` (default 2×). Bottom bar + top-up
  dock always visible; top-up uses the same paywall and the Worker clamps to the A$10 cap.
- Switching AI games (or finishing one and picking another) keeps the same play session
  until the AI budget is spent or the session expires (~7 days idle; refreshed on use).
- Closing and reopening the PWA on the same browser restores credit via `localStorage` +
  the Worker session, until expiry.
- When hosted AI spends the budget, the session becomes `paused_for_payment`; paying
  again creates a continuation session while browser conversation/game state stays intact.

---

## TODO — PCB power for 8 micro servos (3 A / 5 V charger)

Goal: safely run **8 hobby micro servos** (plus ESP32) from a typical **5 V / 3 A** USB charger without cooking the reverse-protection diode or letting a stall melt traces.

**Expected servo current (5 V, typical SG90-class):**

| State | Per servo | 8 servos + ESP (~0.1 A) |
| --- | --- | --- |
| Idle / hold, no load | ~5–20 mA | ~0.2–0.3 A |
| Moving freely | ~100–200 mA | ~0.9–1.7 A |
| Stall | ~500–800 mA | ~4–6 A (must not be sustained) |

Normal free motion already sits around **1–2 A**, so parts rated for **1 A continuous** are undersized. Size protection for **normal motion under a 3 A supply**, and cut off **sustained stall**.

### 1. Upgrade the VBUS Schottky (must do)

**Why:** USB-C → Schottky → 5 V rail feeds **both** the ESP LDO and the servo headers. The current **1N5819 (~1 A)** will run at or above rating when all 8 servos move freely (~1–1.7 A). Heat and eventual failure are likely; a polyfuse on the servo branch does not protect this diode from normal motion current.

**Choose:** a Schottky rated **≥ 3 A continuous** at 5 V (e.g. **SS34** SMA, or JLCPCB equivalent). That matches a **3 A charger** with headroom and lowers forward drop so servos see closer to 5 V.

**Optional later:** ideal-diode / P-FET reverse protection (less heat than any Schottky).

### 2. Add a polyfuse on the servo 5 V rail only

**Why:** A charger’s own current limit is unreliable as board protection. Sustained multi-servo stall can pull **4 A+**, which overheats **1 mm traces** and stresses the connector path. A resettable fuse should open on long stalls while allowing brief current spikes during starts/direction changes.

**Placement:**

```text
USB 5V (after Schottky)
  ├─ LDO → ESP              (unfused — stays up if servos short)
  └─ polyfuse → 220 µF + 100 nF → SERVO1–8
```

Put the fuse **before** the servo bulk caps, **not** on the shared ESP branch.

**Choose:** **~2.5 A hold** PPTC (SMD, e.g. 1206/1812 class).

| Spec | Why |
| --- | --- |
| Hold ≈ **2.5 A** | Max useful headroom on a **3 A** USB supply: 8 micros at moderate load, or ~5 standards lightly; ESP (~0.1 A) is extra on the unfused branch |
| Trip ≈ **4–5 A** (typical ~2× hold) | Opens on sustained stall; brief higher spikes often pass (thermal mass). Fuse must **cool** (seconds) before servos recover |
| Servo rail only | ESP and charger stay up if the fuse opens; all servos lose 5 V together |

Do **not** use a 1 A hold part — free motion can nuisance-trip. Do **not** use **3 A hold** — that sits at the charger ceiling and trips too late to protect traces. **2.5 A** is the balance for maximum functionality without compromising a typical 5 V / 3 A USB supply.

### Related layout notes (same power pass)

- Widen **5 V and GND** to the servo headers (pours / ≥2 mm where possible); 1 mm at 3 A runs hot.
- Keep the existing header bulk caps **after** the polyfuse.
- Prefer a **≥2 A** USB cable/charger; many “fast” bricks are not 3 A at **5 V**.