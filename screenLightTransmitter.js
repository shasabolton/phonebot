/**
 * Screen-light transmitter: encodes servo µs as bottom-of-screen brightness patches
 * for phototransistor pickup. 1000 µs = black, 2000 µs = full white.
 *
 * Layout: 2 columns × 3 rows. Each cell is half the viewport wide and 21mm tall
 * (CSS mm), including black borders (box-sizing: border-box).
 *
 * Optical path does not POST /action. If the ESP is still on station WiFi, we notify
 * it via POST /control-source (body "light") so it reads phototransistors instead.
 * Live ADC/µs readings are polled from GET /light-sensors when a robot IP is known.
 */
class ScreenLightTransmitter {
  static PATCH_ROWS = 3;
  static PATCH_COLS = 2;
  static PATCH_COUNT = 6;
  /** Physical cell height including border (CSS mm). */
  static PATCH_HEIGHT_MM = 21;
  /** Black border thickness included in PATCH_HEIGHT_MM. */
  static BORDER_MM = 1;
  static KNOWN_ROBOTS_KEY = "phonebot_known_robots";
  static SENSOR_POLL_MS = 250;

  constructor(container) {
    /** @type {HTMLElement} */
    this.container = container;
    this.ready = true;
    this._readyChangeHandler = null;
    /** @type {string[]} pin strings in actuator / patch order from pin-setup */
    this._pinOrder = [];
    /** @type {HTMLElement[]} */
    this._patches = [];
    /** @type {HTMLElement|null} */
    this._strip = null;
    /** @type {HTMLElement|null} */
    this._styleEl = null;
    /** @type {HTMLElement|null} */
    this._espNotifyEl = null;
    /** @type {HTMLElement|null} */
    this._sensorStatusEl = null;
    /** @type {HTMLElement|null} */
    this._sensorTableBodyEl = null;
    /** @type {string|null} */
    this._robotBaseUrl = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._sensorPollId = null;
    this._sensorPollInFlight = false;

    this.buildDom();
    this._mountStrip();
    this.setReady(true);
    void this.notifyEspLightMode().then(() => this.startSensorPoll());
  }

  setReadyChangeHandler(handler) {
    this._readyChangeHandler = handler;
    if (this._readyChangeHandler) this._readyChangeHandler(this.ready);
  }

  setReady(ready) {
    const changed = this.ready !== ready;
    this.ready = ready;
    if (changed && this._readyChangeHandler) this._readyChangeHandler(this.ready);
  }

  isReady() {
    return !!this.ready;
  }

  destroy() {
    this.stopSensorPoll();
    this._unmountStrip();
    if (this.container) this.container.innerHTML = "";
  }

  async transmitPinSetup(message) {
    this._pinOrder = [];
    const parts = String(message || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const pin = String(part.split(":")[0] || "").trim();
      if (pin) this._pinOrder.push(pin);
    }
    // Idle black until the first action frame.
    this._setAllBrightness(0);
    void this.notifyEspLightMode();
    return {
      ok: true,
      status: 200,
      body: `screen-light: ${Math.min(this._pinOrder.length, ScreenLightTransmitter.PATCH_COUNT)} patches`
    };
  }

  async transmitAction(message) {
    const byPin = new Map();
    const orderedUs = [];
    const parts = String(message || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const segs = part.split(":");
      const pin = String(segs[0] || "").trim();
      const us = Number(segs[1]);
      if (!pin) continue;
      byPin.set(pin, us);
      orderedUs.push(us);
    }

    for (let i = 0; i < ScreenLightTransmitter.PATCH_COUNT; i++) {
      let us = 1000;
      if (this._pinOrder.length) {
        const pin = this._pinOrder[i];
        if (pin != null && byPin.has(pin)) us = byPin.get(pin);
      } else if (i < orderedUs.length) {
        us = orderedUs[i];
      }
      this._setPatchBrightness(i, ScreenLightTransmitter.usToBrightness(us));
    }

    return { ok: true, status: 200, body: "ok" };
  }

  /** Map servo µs (1000–2000) → 0–255 channel. */
  static usToBrightness(us) {
    const n = Number(us);
    if (!Number.isFinite(n)) return 0;
    const clamped = Math.max(1000, Math.min(2000, n));
    return Math.round(((clamped - 1000) / 1000) * 255);
  }

  /** Candidate station base URLs from known-robot localStorage (same key as WiFi TX). */
  _candidateRobotBaseUrls() {
    const urls = [];
    const add = (u) => {
      if (u && urls.indexOf(u) === -1) urls.push(u);
    };
    try {
      const raw = localStorage.getItem(ScreenLightTransmitter.KNOWN_ROBOTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) {
        for (const r of list) {
          if (r && r.lastIp) add("http://" + String(r.lastIp).replace(/^https?:\/\//, ""));
        }
      }
    } catch (e) {
      /* ignore */
    }
    return urls;
  }

  /**
   * Tell ESP to drive servos from phototransistors (even if STA WiFi is up).
   * No-op if no known robot IP — offline light mode on the ESP still works by default.
   */
  async notifyEspLightMode() {
    const urls = this._candidateRobotBaseUrls();
    if (!urls.length) {
      this._robotBaseUrl = null;
      this._setEspNotifyStatus(
        "No known robot IP — ESP uses light mode when WiFi is down. Connect via WiFi transmitter once to store an IP for handoff + sensor readout.",
        "muted"
      );
      return { ok: false, body: "no known robot IP" };
    }

    this._setEspNotifyStatus("Notifying ESP to use light sensors…", "muted");
    for (const base of urls) {
      try {
        const res = await fetch(base + "/control-source", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "light"
        });
        const body = await res.text();
        if (res.ok) {
          this._robotBaseUrl = base;
          this._setEspNotifyStatus(
            "ESP control source → light (" + base + ").",
            "ok"
          );
          return { ok: true, status: res.status, body };
        }
      } catch (e) {
        /* try next */
      }
    }
    // Still try polling the first URL for diagnostics even if control-source failed
    // (e.g. old firmware without that route).
    this._robotBaseUrl = urls[0];
    this._setEspNotifyStatus(
      "Could not set control-source on ESP — polling " +
        urls[0] +
        " for sensor readout anyway. Update firmware if /light-sensors is missing.",
      "warn"
    );
    return { ok: false, body: "unreachable" };
  }

  _setEspNotifyStatus(text, cls) {
    if (!this._espNotifyEl) return;
    this._espNotifyEl.className = cls || "muted";
    this._espNotifyEl.textContent = text;
  }

  startSensorPoll() {
    this.stopSensorPoll();
    void this.pollLightSensors();
    this._sensorPollId = setInterval(
      () => void this.pollLightSensors(),
      ScreenLightTransmitter.SENSOR_POLL_MS
    );
  }

  stopSensorPoll() {
    if (this._sensorPollId != null) {
      clearInterval(this._sensorPollId);
      this._sensorPollId = null;
    }
  }

  async pollLightSensors() {
    if (this._sensorPollInFlight) return;
    const urls = [];
    if (this._robotBaseUrl) urls.push(this._robotBaseUrl);
    for (const u of this._candidateRobotBaseUrls()) {
      if (urls.indexOf(u) === -1) urls.push(u);
    }
    if (!urls.length) {
      this._renderSensorStatus(
        "No robot IP — cannot read sensors over WiFi.",
        "muted"
      );
      return;
    }

    this._sensorPollInFlight = true;
    try {
      for (const base of urls) {
        try {
          const res = await fetch(base + "/light-sensors", {
            method: "GET",
            cache: "no-store"
          });
          if (!res.ok) continue;
          const data = await res.json();
          this._robotBaseUrl = base;
          this._renderSensorReadout(data, base);
          return;
        } catch (e) {
          /* try next */
        }
      }
      this._renderSensorStatus(
        "ESP not reachable for /light-sensors (need STA WiFi + firmware ≥ 1.2.1).",
        "warn"
      );
    } finally {
      this._sensorPollInFlight = false;
    }
  }

  _renderSensorStatus(text, cls) {
    if (this._sensorStatusEl) {
      this._sensorStatusEl.className = cls || "muted";
      this._sensorStatusEl.textContent = text;
    }
  }

  _renderSensorReadout(data, base) {
    const src = data && data.controlSource != null ? String(data.controlSource) : "?";
    const fw = data && data.fwVersion != null ? String(data.fwVersion) : "?";
    const channels = Array.isArray(data && data.channels) ? data.channels : [];
    this._renderSensorStatus(
      "Live from " + base + " · controlSource=" + src + " · fw=" + fw,
      src === "light" ? "ok" : "warn"
    );
    if (!this._sensorTableBodyEl) return;
    if (!channels.length) {
      this._sensorTableBodyEl.innerHTML =
        '<tr><td colspan="6" class="muted">No channels in response.</td></tr>';
      return;
    }
    this._sensorTableBodyEl.innerHTML = channels
      .map((ch) => {
        const i = ch.index != null ? ch.index : "";
        const servo = ch.servoPin != null ? ch.servoPin : "";
        const sens =
          ch.sensor != null
            ? ch.sensor
            : ch.sensorPin != null
              ? ch.sensorPin
              : "";
        const mv = ch.mv != null ? ch.mv : "—";
        const us = ch.us != null ? ch.us : "—";
        const raw = ch.raw != null ? ch.raw : "—";
        const att = ch.attached === false ? " no" : " yes";
        return (
          "<tr>" +
          "<td>" +
          i +
          "</td><td>" +
          servo +
          "</td><td>" +
          sens +
          "</td><td>" +
          mv +
          "</td><td>" +
          us +
          "</td><td>" +
          raw +
          att +
          "</td></tr>"
        );
      })
      .join("");
  }

  buildDom() {
    const h = ScreenLightTransmitter.PATCH_HEIGHT_MM;
    const rows = ScreenLightTransmitter.PATCH_ROWS;
    this.container.innerHTML = `
<div id="screenLightSensorMonitor" class="box" style="margin-top:0;padding:10px;">
  <div style="font-weight:bold;margin-bottom:6px;">ESP light sensors (live)</div>
  <p id="screenLightSensorStatus" class="muted" style="margin:0 0 8px 0;">Connecting…</p>
  <div style="overflow-x:auto;">
    <table id="screenLightSensorTable" style="width:100%;border-collapse:collapse;font-size:0.85em;">
      <thead>
        <tr>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">#</th>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">servo</th>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">sensor</th>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">mV</th>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">µs</th>
          <th style="text-align:left;border-bottom:1px solid #ccc;padding:2px 4px;">raw/att</th>
        </tr>
      </thead>
      <tbody id="screenLightSensorTableBody">
        <tr><td colspan="6" class="muted">Waiting for ESP…</td></tr>
      </tbody>
    </table>
  </div>
</div>
<p id="screenLightEspNotify" class="muted">Checking whether to notify ESP over WiFi…</p>
<p class="muted">Optical TX: fixed <b>2×3</b> strip at bottom of screen.
Each cell <b>${h}&nbsp;mm</b> tall (borders included), half screen wide.
<b>1000&nbsp;µs = black</b>, <b>2000&nbsp;µs = full white</b>.</p>
<p class="muted">Map: 23:VP(36), 22:VN(39), 21:34, 19:35, 18:32, 25:33 — 0&nbsp;V→1000&nbsp;µs, 3.3&nbsp;V→2000&nbsp;µs.
Strip height reserved: ${rows * h}&nbsp;mm.</p>
`;
    this._espNotifyEl = this.container.querySelector("#screenLightEspNotify");
    this._sensorStatusEl = this.container.querySelector("#screenLightSensorStatus");
    this._sensorTableBodyEl = this.container.querySelector("#screenLightSensorTableBody");
  }

  _mountStrip() {
    this._unmountStrip();

    const style = document.createElement("style");
    style.id = "screenLightTransmitterStyle";
    const h = ScreenLightTransmitter.PATCH_HEIGHT_MM;
    const b = ScreenLightTransmitter.BORDER_MM;
    const totalMm = ScreenLightTransmitter.PATCH_ROWS * h;
    style.textContent = `
html.screen-light-tx-active,
body.screen-light-tx-active {
  padding-bottom: calc(${totalMm}mm + 12px) !important;
  box-sizing: border-box;
}
#screenLightStrip {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100vw;
  max-width: 100vw;
  height: ${totalMm}mm;
  z-index: 10000;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: repeat(${ScreenLightTransmitter.PATCH_ROWS}, ${h}mm);
  margin: 0;
  padding: 0;
  background: #000;
  pointer-events: none;
  transform: translateZ(0);
}
#screenLightStrip .screen-light-patch {
  box-sizing: border-box;
  width: 100%;
  height: ${h}mm;
  margin: 0;
  padding: 0;
  border: ${b}mm solid #000;
  background: #000;
}
#screenLightSensorTable td {
  border-bottom: 1px solid #eee;
  padding: 2px 4px;
  font-variant-numeric: tabular-nums;
}
`;
    document.head.appendChild(style);
    this._styleEl = style;

    const strip = document.createElement("div");
    strip.id = "screenLightStrip";
    strip.setAttribute("aria-hidden", "true");
    this._patches = [];
    for (let i = 0; i < ScreenLightTransmitter.PATCH_COUNT; i++) {
      const cell = document.createElement("div");
      cell.className = "screen-light-patch";
      cell.dataset.patchIndex = String(i);
      strip.appendChild(cell);
      this._patches.push(cell);
    }
    document.body.appendChild(strip);
    this._strip = strip;

    document.documentElement.classList.add("screen-light-tx-active");
    document.body.classList.add("screen-light-tx-active");
  }

  _unmountStrip() {
    if (this._strip && this._strip.parentNode) {
      this._strip.parentNode.removeChild(this._strip);
    }
    this._strip = null;
    this._patches = [];
    if (this._styleEl && this._styleEl.parentNode) {
      this._styleEl.parentNode.removeChild(this._styleEl);
    }
    this._styleEl = null;
    document.documentElement.classList.remove("screen-light-tx-active");
    document.body.classList.remove("screen-light-tx-active");
  }

  _setPatchBrightness(index, brightness) {
    const el = this._patches[index];
    if (!el) return;
    const v = Math.max(0, Math.min(255, Math.round(brightness)));
    el.style.backgroundColor = `rgb(${v},${v},${v})`;
  }

  _setAllBrightness(brightness) {
    for (let i = 0; i < this._patches.length; i++) {
      this._setPatchBrightness(i, brightness);
    }
  }
}
