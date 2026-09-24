const ESP_AP_IP = "http://192.168.4.1";
const ESP_AP_PASS = "12345678"; // AP_PASS in epsBootstrap.ino
const LEGACY_STA_IP_KEY = "robot_sta_ip";
const ROBOTS_KEY = "phonebot_known_robots";

/** Tried in order when loading firmware from the page origin (serve project root over HTTP). */
const FIRMWARE_RELATIVE_PATHS = [
  "espBootstrapEsp32/build/esp32.esp32.esp32s3/espBootstrapEsp32.ino.bin",
  "espBootstrapEsp32/build/esp32.esp32.esp32s3/firmware.bin",
  "espBootstrapEsp32/build/esp32.esp32.esp32/espBootstrapEsp32.ino.bin",
  "espBootstrapEsp32/build/esp32.esp32.esp32/firmware.bin",
  "espBootstrap/build/esp8266.esp8266.nodemcuv2/espBootstrap.ino.bin",
  "espBootstrap/build/esp8266.esp8266.nodemcuv2/firmware.bin",
  "espBootstrap/build/esp8266.esp8266.d1_mini/espBootstrap.ino.bin",
  "espBootstrap/build/esp8266.esp8266.d1_mini/firmware.bin",
  "firmware.bin"
];

function loadRobots() {
  try {
    const raw = localStorage.getItem(ROBOTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveRobots(list) {
  localStorage.setItem(ROBOTS_KEY, JSON.stringify(list));
}

function migrateLegacyStaIp() {
  const oldIp = localStorage.getItem(LEGACY_STA_IP_KEY);
  if (!oldIp) return;
  const list = loadRobots();
  if (!list.some((r) => r.lastIp === oldIp)) {
    list.push({
      chipId: "unknown-" + oldIp,
      apSsid: "",
      hostname: "",
      mdnsHost: "esp8266.local",
      lastIp: oldIp
    });
    saveRobots(list);
  }
  localStorage.removeItem(LEGACY_STA_IP_KEY);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Load fwVersion from this page's version.json (null if unavailable). */
async function fetchAppFwVersion(timeoutMs = 2500) {
  if (
    typeof window === "undefined" ||
    (window.location.protocol !== "http:" && window.location.protocol !== "https:")
  ) {
    return null;
  }
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const u = new URL("version.json", window.location.href).href;
    const r = await fetch(u, { method: "GET", cache: "no-store", signal: ac.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j.fwVersion != null ? String(j.fwVersion) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Classify a robot control URL for Local Network Access (Firefox/Chrome).
 * HTTPS pages need targetAddressSpace so mixed-content to SoftAP HTTP is allowed
 * after the user grants local-network permission.
 * @returns {"local"|"loopback"|null}
 */
function robotAddressSpace(url) {
  try {
    const base =
      typeof location !== "undefined" && location.href ? location.href : undefined;
    const host = new URL(url, base).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return "loopback";
    }
    if (host.endsWith(".local")) return "local";
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return "local";
    if (a === 172 && b >= 16 && b <= 31) return "local";
    if (a === 192 && b === 168) return "local";
    if (a === 169 && b === 254) return "local";
  } catch (_) {}
  return null;
}

/** Remember which targetAddressSpace value worked (local | private | none). */
let _robotLnaMode = null;

/**
 * fetch() to the robot SoftAP/LAN, with Local Network Access annotations so
 * Firefox (and Chromium) can reach http://192.168.x.x from an HTTPS PWA.
 * On first click the browser should prompt; choose Allow.
 */
async function robotFetch(url, options = {}) {
  const space = robotAddressSpace(url);
  const baseOpts = { cache: "no-store", ...options };
  const attempts = [];
  if (space) {
    if (_robotLnaMode === "local" || _robotLnaMode == null) {
      attempts.push({ ...baseOpts, targetAddressSpace: space });
    }
    // Older Chromium builds used "private" before the rename to "local".
    if ((_robotLnaMode === "private" || _robotLnaMode == null) && space === "local") {
      attempts.push({ ...baseOpts, targetAddressSpace: "private" });
    }
  }
  attempts.push(baseOpts);

  let lastErr = null;
  for (const opts of attempts) {
    try {
      const res = await fetch(url, opts);
      if (opts.targetAddressSpace === "private") _robotLnaMode = "private";
      else if (opts.targetAddressSpace === "local" || opts.targetAddressSpace === "loopback") {
        _robotLnaMode = "local";
      } else if (_robotLnaMode == null) {
        _robotLnaMode = "none";
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("network error");
}

/** Resolve the Element for a click/tap (Firefox may target a text node inside the button). */
function eventElement(e) {
  const t = e && e.target;
  if (!t) return null;
  if (t instanceof Element) return t;
  return t.parentElement || null;
}

function clientPlatform() {
  const ua = String(
    (typeof navigator !== "undefined" && (navigator.userAgentData?.platform || navigator.userAgent)) ||
      ""
  );
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS 13+ may report as Mac; treat touch Macs as iOS for browser hints.
  if (
    typeof navigator !== "undefined" &&
    /Mac/i.test(ua) &&
    navigator.maxTouchPoints > 1
  ) {
    return "ios";
  }
  return "other";
}

/**
 * @returns {Promise<{ok: boolean, kind: "ok"|"timeout"|"http"|"blocked", elapsedMs: number}>}
 */
async function ping(url, timeoutMs = 1500) {
  const started =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const elapsed = () =>
    (typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now()) - started;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await robotFetch(url + "/ping", {
      method: "GET",
      signal: controller.signal
    });
    const elapsedMs = elapsed();
    if (res.ok) return { ok: true, kind: "ok", elapsedMs };
    return { ok: false, kind: "http", elapsedMs };
  } catch (e) {
    const elapsedMs = elapsed();
    const aborted =
      (e && e.name === "AbortError") ||
      (controller.signal && controller.signal.aborted);
    if (aborted) return { ok: false, kind: "timeout", elapsedMs };
    return { ok: false, kind: "blocked", elapsedMs };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Failures under this duration are treated as "browser refused" (policy), not "robot absent". */
const PING_INSTANT_MS = 400;

function probeLooksInstantBlocked(p) {
  return !!p && !p.ok && p.kind === "blocked" && p.elapsedMs < PING_INSTANT_MS;
}

/** True if any probe looks like the browser actually tried (timeout / response / slow fail). */
function probesLookLikeSearch(probes) {
  return probes.some(
    (p) =>
      p &&
      (p.kind === "timeout" ||
        p.kind === "http" ||
        p.kind === "ok" ||
        (p.kind === "blocked" && p.elapsedMs >= PING_INSTANT_MS))
  );
}

function currentPageUrl() {
  try {
    return typeof location !== "undefined" ? String(location.href || "") : "";
  } catch (_) {
    return "";
  }
}

const CHROME_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.android.chrome";
const BLUEFY_APP_STORE_URL =
  "https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055";

/** Copy current page URL (best-effort; must run in a user-gesture click). */
function copyPageUrlToClipboard() {
  const href = currentPageUrl();
  if (!href) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      void navigator.clipboard.writeText(href);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = href;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}

/**
 * Single Android Intent targeting Chrome with this page URL.
 * No Play Store fallback (that caused store + chooser + about:blank).
 */
function chromeIntentHref() {
  const href = currentPageUrl();
  if (!href) return CHROME_PLAY_STORE_URL;
  try {
    const u = new URL(href);
    const hostAndPath = u.host + u.pathname + u.search + u.hash;
    return (
      "intent://" +
      hostAndPath +
      "#Intent;scheme=" +
      u.protocol.replace(":", "") +
      ";package=com.android.chrome;end"
    );
  } catch (_) {
    return CHROME_PLAY_STORE_URL;
  }
}

/** Open the current page in Bluefy (iOS). */
function bluefyOpenCurrentPageHref() {
  const href = currentPageUrl();
  if (!href) return BLUEFY_APP_STORE_URL;
  return "bluefy://open?url=" + encodeURIComponent(href);
}

function openCurrentPageInChrome() {
  copyPageUrlToClipboard();
  try {
    location.href = chromeIntentHref();
  } catch (_) {}
}

function openCurrentPageInBluefy() {
  copyPageUrlToClipboard();
  try {
    location.href = bluefyOpenCurrentPageHref();
  } catch (_) {}
}

function openBrowserInstallStore() {
  copyPageUrlToClipboard();
  const platform = clientPlatform();
  const store =
    platform === "ios" ? BLUEFY_APP_STORE_URL : CHROME_PLAY_STORE_URL;
  try {
    location.href = store;
  } catch (_) {}
}

/**
 * Red error + two buttons to copy URL and launch/install Chrome (Android/other)
 * or Bluefy (iOS). No "click when connected" retry.
 * @param {string} errorText Plain error sentence (wrapped in .error).
 */
function browserRefusedSwitchHtml(errorText) {
  const platform = clientPlatform();
  const name = platform === "ios" ? "Bluefy browser" : "Chrome browser";
  const launchAction = platform === "ios" ? "open-in-bluefy" : "open-in-chrome";
  const launchHref =
    platform === "ios" ? bluefyOpenCurrentPageHref() : chromeIntentHref();
  const installHref =
    platform === "ios" ? BLUEFY_APP_STORE_URL : CHROME_PLAY_STORE_URL;

  return (
    "<span class='error'>" +
    escapeHtml(errorText) +
    "</span><br><br>" +
    '<button type="button" data-action="' +
    launchAction +
    '" data-href="' +
    escapeHtml(launchHref) +
    '">copy url, launch ' +
    name +
    "</button><br><br>" +
    '<button type="button" data-action="open-browser-install" data-href="' +
    escapeHtml(installHref) +
    '">copy url, install ' +
    name +
    "</button>"
  );
}

function robotNotFoundStatusHtml(probes) {
  if (probesIndicateBrowserRefused(probes)) {
    return browserRefusedSwitchHtml("Browser refused to search for the robot.");
  }
  return "<span class='error'>Browser searched but robot not found.</span>";
}

function probesIndicateBrowserRefused(probes) {
  const searched = probesLookLikeSearch(probes);
  return (
    !searched && probes.length > 0 && probes.every(probeLooksInstantBlocked)
  );
}

class WifiTransmitter {
  constructor(container, options = {}) {
    /** @type {HTMLElement} */
    this.container = container;
    /** @type {object|null} */
    this.deviceFilter = options.deviceFilter || null;
    /** Base URL of robot when reachable in station mode (not SoftAP control). */
    this.robotStaBaseUrl = null;
    /** True while phone is on the robot SoftAP for provisioning only. */
    this.onSoftAp = false;
    this.ready = false;
    this._readyChangeHandler = null;
    /** Hz for /action while the app transmit loop is on (1–20). */
    this.actionFrequencyHz = 10;
    this._actionFreqChangeHandler = null;
    this._uploadFirmwareBusy = false;
    /** @type {Promise<void> | null} */
    this._detectPromise = null;
    /** Bumps on each detectMode so a hung probe cannot block later taps. */
    this._detectGen = 0;
    /** True when UI is reduced to browser-switch only (policy blocked probes). */
    this._browserBlocked = false;
    this._onContainerClick = (e) => {
      const el = eventElement(e);
      if (!el) return;
      if (el.closest('[data-action="open-in-chrome"]')) {
        e.preventDefault();
        e.stopPropagation();
        openCurrentPageInChrome();
        return;
      }
      if (el.closest('[data-action="open-in-bluefy"]')) {
        e.preventDefault();
        e.stopPropagation();
        openCurrentPageInBluefy();
        return;
      }
      if (el.closest('[data-action="open-browser-install"]')) {
        e.preventDefault();
        e.stopPropagation();
        openBrowserInstallStore();
        return;
      }
      if (!el.closest('[data-action="detect-mode"]')) return;
      e.preventDefault();
      e.stopPropagation();
      void this.detectMode();
    };
    this.buildDom();
    this.container.addEventListener("click", this._onContainerClick);
    this._bindControls();
    migrateLegacyStaIp();
    this.refreshRobotPicker();
    this.detectMode();
  }

  destroy() {
    if (this.container && this._onContainerClick) {
      this.container.removeEventListener("click", this._onContainerClick);
    }
    this._detectGen += 1;
    this._detectPromise = null;
    this.setReady(false);
    this.robotStaBaseUrl = null;
    this.onSoftAp = false;
  }

  setReadyChangeHandler(handler) {
    this._readyChangeHandler = handler;
    if (this._readyChangeHandler) this._readyChangeHandler(this.ready);
  }

  setActionFrequencyChangeHandler(handler) {
    this._actionFreqChangeHandler = handler;
  }

  setReady(ready) {
    const changed = this.ready !== ready;
    this.ready = ready;
    if (changed && this._readyChangeHandler) this._readyChangeHandler(this.ready);
    this._setActionRateVisible(this.isReady());
  }

  isReady() {
    return this.ready && !!this.robotStaBaseUrl && !this.onSoftAp;
  }

  /** SoftAP is reachable for WiFi provisioning (not for robot control). */
  isSoftApConnected() {
    return !!this.onSoftAp;
  }

  _setActionRateVisible(show) {
    const rate = this.el("actionRatePanel");
    if (rate) rate.style.display = show ? "" : "none";
  }

  getActionIntervalMs() {
    const hz = Math.max(1, Math.min(20, Number(this.actionFrequencyHz) || 10));
    return Math.max(50, Math.round(1000 / hz));
  }

  setActionFrequencyHz(hz, { notify = true } = {}) {
    const next = Math.max(1, Math.min(20, Math.round(Number(hz) || 10)));
    const changed = next !== this.actionFrequencyHz;
    this.actionFrequencyHz = next;
    const slider = this.el("actionFreqHz");
    const label = this.el("actionFreqHzValue");
    if (slider && Number(slider.value) !== next) slider.value = String(next);
    if (label) label.textContent = String(next);
    if (changed && notify && this._actionFreqChangeHandler) {
      this._actionFreqChangeHandler(next);
    }
  }

  /** Resolves when the current (or last) connection probe finishes. */
  async waitForDetectMode() {
    if (!this._detectPromise) return;
    try {
      await this._detectPromise;
    } catch (_) {
      /* ignore probe errors */
    }
  }

  async postControl(path, message) {
    if (!this.robotStaBaseUrl) {
      return { ok: false, status: 0, body: "Robot not connected on WiFi." };
    }
    try {
      const res = await robotFetch(this.robotStaBaseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: message || ""
      });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: e && e.message ? e.message : "network error" };
    }
  }

  async transmitPinSetup(message) {
    return this.postControl("/pin-setup", message);
  }

  async transmitAction(message) {
    return this.postControl("/action", message);
  }

  el(id) {
    return this.container.querySelector("#" + id);
  }

  buildDom() {
    this.container.innerHTML = `
<div id="wifiConnectPanel" class="box">
  <div id="status">Checking robot connection...</div>
  <div id="knownRobotWrap" style="display:none;margin-top:12px;">
    <label for="knownRobotSelect"><b>Known robots</b> (on your home / hotspot WiFi)</label>
    <select id="knownRobotSelect"></select>
  </div>
  <p id="wifiJoinHint" class="muted" style="display:none;margin-top:12px;margin-bottom:0;"></p>
  <button type="button" data-action="detect-mode" id="wifiCheckBtn" style="display:none;margin-top:12px;">Check connection</button>
</div>

<div id="wifiSetup" class="box" style="display:none;">
  <h3>Connect Robot to Your WiFi</h3>

  <p>
    Give the robot your WiFi credentials so it can join your network. Control works after the robot is on that network (station mode), not on this access point.
  </p>

  <select id="networkList">
    <option value="">Select a WiFi network (or type manually below)</option>
  </select>
  <button type="button" id="wifiScanNetworksBtn">Refresh Networks</button>
  <div id="scanStatus"></div>

  <input id="ssid" placeholder="WiFi Name (SSID)">
  <input id="pass" type="password" placeholder="WiFi Password">

  <button type="button" id="wifiSendCredsBtn">Connect Robot to WiFi</button>

  <div id="setupResult"></div>
</div>

<button type="button" id="wifiDisconnectBtn" style="display:none;">Disconnect / Switch Device</button>

<div id="firmwarePanel" class="box" style="display:none;">
  <h3>Firmware</h3>
  <div id="firmwareVersionInfo" class="muted" style="margin-bottom:10px;"></div>
  <p class="muted">
    OTA loads the sketch’s Arduino build output under <code>espBootstrap/build/</code> or <code>espBootstrapEsp32/build/</code> (same repo you serve with this HTML).
    After compile or “Export compiled Binary”, use the <code>.bin</code> under the board-specific folder (for example <code>esp32s3/espBootstrapEsp32.ino.bin</code>). Serve the project root over HTTP.
  </p>
  <input type="file" id="firmwareFile" accept=".bin" style="display:none;">
  <button type="button" id="firmwareBtn" style="display:none;">Update firmware</button>
  <div id="firmwareStatus" class="muted" style="margin-top:8px;"></div>
</div>

<div id="actionRatePanel" class="box" style="display:none;">
  <label for="actionFreqHz"><b>Action send rate</b> <span id="actionFreqHzValue">10</span> Hz</label>
  <input type="range" id="actionFreqHz" min="1" max="20" step="1" value="10" style="width:100%;margin-top:8px;">
  <p class="muted" style="margin-top:6px;margin-bottom:0;">
    How often <code>/action</code> is posted while the transmit loop is on.
  </p>
</div>
`;
  }

  _bindControls() {
    const disc = this.el("wifiDisconnectBtn");
    if (disc) disc.addEventListener("click", () => this.disconnect());
    const fw = this.el("firmwareBtn");
    if (fw) fw.addEventListener("click", () => this.uploadFirmware());
    const nl = this.el("networkList");
    if (nl) nl.addEventListener("change", () => this.onNetworkSelected());
    const scan = this.el("wifiScanNetworksBtn");
    if (scan) scan.addEventListener("click", () => this.scanNetworks());
    const send = this.el("wifiSendCredsBtn");
    if (send) send.addEventListener("click", () => this.sendCreds());
    const freq = this.el("actionFreqHz");
    if (freq) {
      const onFreq = () => this.setActionFrequencyHz(freq.value);
      freq.addEventListener("input", onFreq);
      freq.addEventListener("change", onFreq);
    }
  }

  setDeviceFilter(filter) {
    this.deviceFilter = filter || null;
    this.refreshRobotPicker();
  }

  _filteredRobots(robots) {
    if (!this.deviceFilter || typeof PhonebotDeviceFilter === "undefined") {
      return robots;
    }
    return robots.filter((r) => PhonebotDeviceFilter.matchesRobot(r, this.deviceFilter));
  }

  _identityMatchesFilter(identity) {
    if (!this.deviceFilter || typeof PhonebotDeviceFilter === "undefined") return true;
    return PhonebotDeviceFilter.matchesRobot(identity, this.deviceFilter);
  }

  mergeRobot(entry) {
    if (!entry || !entry.chipId) return;
    const list = loadRobots();
    const i = list.findIndex((r) => r.chipId === entry.chipId);
    const merged = {
      chipId: entry.chipId,
      apSsid: entry.apSsid || "",
      hostname: entry.hostname || "",
      mdnsHost: entry.mdnsHost || "",
      lastIp: entry.lastIp || ""
    };
    if (i >= 0) {
      list[i] = { ...list[i], ...merged };
    } else {
      list.push(merged);
    }
    saveRobots(list);
    this.refreshRobotPicker();
  }

  wifiJoinHintHtml() {
    const hasKnown = this._filteredRobots(loadRobots()).length > 0;
    const apName = this.deviceFilter ? this.deviceFilter.apSsid : null;
    const joinAp = apName
      ? "open your WiFi settings to join <b>" + escapeHtml(apName) + "</b>"
      : "open your WiFi settings to join an available new robot’s access point";
    const html = hasKnown
      ? "Choose a known robot from the list, or " + joinAp
      : joinAp.charAt(0).toUpperCase() + joinAp.slice(1);
    return html + ". Password: <b>" + ESP_AP_PASS + "</b>.";
  }

  /**
   * @param {"checking"|"prompt"|"connected"|"refused"} mode
   */
  _setWifiConnectMode(mode) {
    const hint = this.el("wifiJoinHint");
    const checkBtn = this.el("wifiCheckBtn");
    const knownWrap = this.el("knownRobotWrap");

    if (mode === "refused") {
      if (hint) hint.style.display = "none";
      if (checkBtn) checkBtn.style.display = "none";
      if (knownWrap) knownWrap.style.display = "none";
      return;
    }

    if (mode === "connected") {
      if (hint) hint.style.display = "none";
      if (checkBtn) checkBtn.style.display = "none";
      if (knownWrap) knownWrap.style.display = "none";
      return;
    }

    if (mode === "checking") {
      if (hint) hint.style.display = "none";
      if (checkBtn) checkBtn.style.display = "none";
      return;
    }

    // prompt
    if (hint) {
      hint.innerHTML = this.wifiJoinHintHtml();
      hint.style.display = "block";
    }
    if (checkBtn) checkBtn.style.display = "inline-block";
    this.refreshRobotPicker();
  }

  refreshRobotPicker() {
    const wrap = this.el("knownRobotWrap");
    const sel = this.el("knownRobotSelect");
    if (!wrap || !sel) return;
    if (this._browserBlocked) {
      wrap.style.display = "none";
      return;
    }
    const robots = loadRobots();
    const visible = this._filteredRobots(robots);
    if (visible.length === 0) {
      wrap.style.display = "none";
      sel.innerHTML = "";
      return;
    }
    wrap.style.display = "block";
    sel.innerHTML = "";
    if (!this.deviceFilter) {
      const allOpt = document.createElement("option");
      allOpt.value = "";
      allOpt.textContent = "(All saved — try each)";
      sel.appendChild(allOpt);
    }

    visible.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.chipId;
      let label = r.hostname
        ? r.hostname + (r.apSsid ? " (" + r.apSsid + ")" : "")
        : r.apSsid || r.chipId;
      opt.textContent = label;
      opt.title = label;
      sel.appendChild(opt);
    });
    if (this.deviceFilter && visible.length === 1) {
      sel.value = visible[0].chipId;
    }
  }

  async fetchRobotIdentityFromAp() {
    try {
      const res = await robotFetch(ESP_AP_IP + "/status", { method: "GET" });
      if (!res.ok) return null;
      const data = await res.json();
      this._lastApIdentity = data;
      this.mergeRobot({
        chipId: data.chipId,
        apSsid: data.apSsid,
        hostname: data.hostname,
        mdnsHost: data.mdnsHost,
        lastIp: data.ip || ""
      });
      return data;
    } catch (e) {
      return null;
    }
  }

  buildStaTargets() {
    const urls = [];
    const add = (u) => {
      if (!u) return;
      if (urls.indexOf(u) === -1) urls.push(u);
    };

    const robots = this._filteredRobots(loadRobots());
    const sel = this.el("knownRobotSelect");
    const preferredId = sel ? sel.value : "";

    if (preferredId) {
      const r = robots.find((x) => x.chipId === preferredId);
      if (r) {
        if (r.mdnsHost) add("http://" + r.mdnsHost);
        if (r.lastIp) add("http://" + r.lastIp);
      }
    }

    for (const r of robots) {
      if (r.mdnsHost) add("http://" + r.mdnsHost);
      if (r.lastIp) add("http://" + r.lastIp);
    }

    if (this.deviceFilter) {
      add("http://" + this.deviceFilter.hostname + ".local");
    } else {
      add("http://esp8266.local");
    }
    return urls;
  }

  onNetworkSelected() {
    const networkList = this.el("networkList");
    const ssid = this.el("ssid");
    if (!networkList || !ssid) return;
    const selected = networkList.value;
    if (selected) {
      ssid.value = selected;
    }
  }

  async scanNetworks() {
    const scanStatus = this.el("scanStatus");
    const networkList = this.el("networkList");
    if (!scanStatus || !networkList) return;

    scanStatus.innerHTML = "Scanning for nearby WiFi networks...";
    networkList.innerHTML = "<option value=''>Loading networks...</option>";

    try {
      const res = await robotFetch(ESP_AP_IP + "/scan", { method: "GET" });
      if (!res.ok) {
        throw new Error("Scan request failed");
      }

      const networks = await res.json();
      networkList.innerHTML = "<option value=''>Select a WiFi network (or type manually below)</option>";

      if (!Array.isArray(networks) || networks.length === 0) {
        scanStatus.innerHTML = "<span class='warn'>No networks found. You can still type SSID manually.</span>";
        return;
      }

      networks.forEach((network) => {
        if (!network || !network.ssid) return;
        const option = document.createElement("option");
        option.value = network.ssid;
        option.textContent = network.rssi !== undefined
          ? network.ssid + " (" + network.rssi + " dBm)"
          : network.ssid;
        networkList.appendChild(option);
      });

      scanStatus.innerHTML = "<span class='ok'>Network list updated.</span>";
    } catch (e) {
      networkList.innerHTML = "<option value=''>Select a WiFi network (or type manually below)</option>";
      scanStatus.innerHTML = "<span class='error'>Could not scan networks. You can still type SSID manually.</span>";
    }
  }

  setFirmwarePanelVisible(show) {
    const panel = this.el("firmwarePanel");
    if (!panel) return;
    if (this._browserBlocked) show = false;
    panel.style.display = show ? "block" : "none";
    if (!show) {
      const st = this.el("firmwareStatus");
      const btn = this.el("firmwareBtn");
      const vi = this.el("firmwareVersionInfo");
      if (st) st.textContent = "";
      if (btn) {
        btn.disabled = false;
        btn.style.display = "none";
      }
      if (vi) vi.innerHTML = "";
    }
  }

  /** Hide rate / firmware when the browser cannot reach the robot at all. */
  _setBrowserBlockedUi(blocked) {
    this._browserBlocked = !!blocked;
    this._setActionRateVisible(!blocked && this.isReady());
    const setup = this.el("wifiSetup");
    if (blocked && setup) setup.style.display = "none";
    const disc = this.el("wifiDisconnectBtn");
    if (blocked && disc) disc.style.display = "none";
    this.setFirmwarePanelVisible(false);
    if (blocked) this._setWifiConnectMode("refused");
    else this.refreshRobotPicker();
  }

  disconnect() {
    this.robotStaBaseUrl = null;
    this.onSoftAp = false;
    this.setReady(false);
    this.setFirmwarePanelVisible(false);
    this._setActionRateVisible(false);
    const wifiSetup = this.el("wifiSetup");
    const status = this.el("status");
    const btn = this.el("wifiDisconnectBtn");
    if (wifiSetup) wifiSetup.style.display = "none";
    if (btn) btn.style.display = "none";
    if (status) {
      status.innerHTML = "<span class='muted'>Disconnected.</span>";
    }
    this._setWifiConnectMode("prompt");
  }

  async checkFirmwareVersion(baseUrl) {
    const versionInfo = this.el("firmwareVersionInfo");
    const btn = this.el("firmwareBtn");
    if (!versionInfo || !btn) return;
    versionInfo.innerHTML = "Checking firmware version…";
    btn.style.display = "none";

    let robotFw = null;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 4000);
    try {
      const r = await robotFetch(baseUrl + "/version", {
        method: "GET",
        signal: ac.signal
      });
      if (r.ok) {
        const j = await r.json();
        robotFw = j.fwVersion != null ? String(j.fwVersion) : null;
      }
    } catch (e) {}
    finally {
      clearTimeout(to);
    }

    let latestFw = null;
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      latestFw = await fetchAppFwVersion(2500);
    }

    if (!robotFw) {
      versionInfo.innerHTML =
        "<span class='warn'>Could not read firmware version from the robot (<code>/version</code>).</span>";
      btn.style.display = "block";
      return;
    }

    if (!latestFw) {
      versionInfo.innerHTML =
        "<span class='muted'>Robot firmware version: <b>" +
        escapeHtml(robotFw) +
        "</b>.<br>" +
        "Could not load <code>version.json</code> from this page’s server — serve the project over HTTP (same folder as this HTML) to compare with your repo.</span>";
      btn.style.display = "block";
      return;
    }

    if (robotFw === latestFw) {
      versionInfo.innerHTML =
        "<span class='ok'>Firmware up to date with version <b>" + escapeHtml(robotFw) + "</b>.</span>";
      btn.style.display = "none";
      return;
    }

    versionInfo.innerHTML =
      "<span class='warn'>The robot has firmware version <b>" +
      escapeHtml(robotFw) +
      "</b>. Update to the latest version <b>" +
      escapeHtml(latestFw) +
      "</b>.</span>";
    btn.style.display = "block";
  }

  async resolveFirmwareBlob() {
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      for (const rel of FIRMWARE_RELATIVE_PATHS) {
        const url = new URL(rel, window.location.href).href;
        try {
          const res = await fetch(url, { method: "GET", cache: "no-store" });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > 10000) {
              return new Blob([buf], { type: "application/octet-stream" });
            }
          }
        } catch (e) {}
      }
    }

    const input = this.el("firmwareFile");
    if (!input) {
      return Promise.reject(new Error("No firmware input"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      function cleanup() {
        input.removeEventListener("change", onChange);
        window.removeEventListener("focus", onFocusAfterDialog);
        clearTimeout(fallbackTid);
      }
      function fail(msg) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(msg));
      }
      function ok(file) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(file);
      }
      const onChange = () => {
        const f = input.files && input.files[0];
        input.value = "";
        if (!f) fail("No file selected");
        else ok(f);
      };
      const onFocusAfterDialog = () => {
        setTimeout(() => {
          if (settled) return;
          const f = input.files && input.files[0];
          if (f) {
            input.value = "";
            ok(f);
            return;
          }
          fail("No file selected");
        }, 400);
      };
      const fallbackTid = setTimeout(() => fail("No file selected"), 120000);
      input.addEventListener("change", onChange);
      requestAnimationFrame(() => {
        window.addEventListener("focus", onFocusAfterDialog, { once: true });
      });
      input.click();
    });
  }

  /**
   * After OTA the ESP reboots; poll until /ping succeeds, then refresh version UI.
   * @returns {Promise<boolean>} true if the robot came back
   */
  async waitForRobotAfterOta(baseUrl, { attempts = 40, intervalMs = 1500 } = {}) {
    const st = this.el("firmwareStatus");
    const versionInfo = this.el("firmwareVersionInfo");
    if (versionInfo) {
      versionInfo.innerHTML =
        "<span class='muted'>Waiting for robot to reboot and reconnect…</span>";
    }
    for (let i = 0; i < attempts; i++) {
      if (st) {
        st.innerHTML =
          "<span class='muted'>Waiting for robot to reconnect… (" +
          (i + 1) +
          "/" +
          attempts +
          ")</span>";
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (!this.robotStaBaseUrl || this.robotStaBaseUrl !== baseUrl) return false;
      const p = await ping(baseUrl, 2000);
      if (p && p.ok) return true;
    }
    return false;
  }

  async uploadFirmware() {
    const btn = this.el("firmwareBtn");
    const st = this.el("firmwareStatus");
    if (!btn || !st) return;
    if (!this.robotStaBaseUrl) {
      st.innerHTML = "<span class='error'>Robot not connected on WiFi.</span>";
      return;
    }
    if (this._uploadFirmwareBusy) return;
    this._uploadFirmwareBusy = true;
    st.textContent = "Loading firmware file…";
    let blob;
    try {
      blob = await this.resolveFirmwareBlob();
    } catch (e) {
      st.innerHTML =
        "<span class='warn'>No firmware file. Serve the project over HTTP after compiling (see <code>espBootstrap/build/…</code>), or pick a <code>.bin</code> when prompted.</span>";
      this._uploadFirmwareBusy = false;
      return;
    }
    btn.disabled = true;
    st.textContent = "Uploading to robot… (do not close this page)";
    const baseUrl = this.robotStaBaseUrl;
    try {
      const form = new FormData();
      form.append("update", blob, "firmware.bin");
      const res = await robotFetch(baseUrl + "/update", {
        method: "POST",
        body: form
      });
      if (res.ok) {
        st.innerHTML = "<span class='ok'>Upload finished. Robot is restarting with new firmware.</span>";
        this.setReady(false);
        const back = await this.waitForRobotAfterOta(baseUrl);
        if (!back) {
          st.innerHTML =
            "<span class='warn'>Upload finished, but the robot did not come back yet.</span> Tap <b>Check connection</b> once it rejoins WiFi.";
          btn.disabled = false;
        } else {
          this.setReady(true);
          st.innerHTML = "<span class='ok'>Robot reconnected. Checking firmware…</span>";
          await this.checkFirmwareVersion(baseUrl);
          st.innerHTML = "";
          // Re-enable only if still shown (outdated / unverifiable).
          if (btn.style.display !== "none") btn.disabled = false;
        }
      } else {
        st.innerHTML = "<span class='error'>Update failed (HTTP " + res.status + ").</span>";
        btn.disabled = false;
      }
    } catch (e) {
      st.innerHTML = "<span class='error'>Upload error: " + (e && e.message ? e.message : "network") + "</span>";
      btn.disabled = false;
    }
    this._uploadFirmwareBusy = false;
  }

  async detectMode() {
    const gen = ++this._detectGen;
    const status = this.el("status");
    const wifiSetup = this.el("wifiSetup");
    // Update UI synchronously so Firefox taps never look "dead" while a probe runs.
    if (status) status.textContent = "Checking robot connection...";
    if (wifiSetup) wifiSetup.style.display = "none";
    this._setWifiConnectMode("checking");

    const run = (async () => {
      await this._detectModeBody(gen);
    })();
    this._detectPromise = run;
    try {
      await run;
    } finally {
      if (this._detectPromise === run) this._detectPromise = null;
    }
  }

  async _detectModeBody(gen) {
    const status = this.el("status");
    const wifiSetup = this.el("wifiSetup");
    if (!status || !wifiSetup) return;
    if (gen !== this._detectGen) return;

    migrateLegacyStaIp();
    this.refreshRobotPicker();

    const staTargets = this.buildStaTargets();

    status.textContent = "Checking robot connection...";
    wifiSetup.style.display = "none";

    const staPromises = staTargets.map((base) => ping(base));
    const [staResults, apProbe] = await Promise.all([
      Promise.all(staPromises),
      ping(ESP_AP_IP)
    ]);
    if (gen !== this._detectGen) return;
    const apOk = !!(apProbe && apProbe.ok);
    const staOk = staResults.some((r) => r && r.ok);

    // Clear station state before branching. If the phone is on the robot SoftAP,
    // pings to a saved STA URL can still succeed (AP+STA). Prefer AP UI so
    // credential inputs always show when joined to the robot AP.
    this.robotStaBaseUrl = null;
    this.onSoftAp = false;
    this.setReady(false);
    this._setBrowserBlockedUi(false);
    this.setFirmwarePanelVisible(false);
    this._setActionRateVisible(false);
    const switchBtn = this.el("wifiDisconnectBtn");
    if (switchBtn) switchBtn.style.display = "none";

    if (apOk) {
      // SoftAP is for WiFi provisioning only — not robot control.
      this.onSoftAp = true;
      this.robotStaBaseUrl = null;
      this.setReady(false);
      this.setFirmwarePanelVisible(false);
      this._setActionRateVisible(false);
      const switchBtnAp = this.el("wifiDisconnectBtn");
      if (switchBtnAp) switchBtnAp.style.display = "block";
      wifiSetup.style.display = "block";
      this._setWifiConnectMode("connected");
      const identity = await this.fetchRobotIdentityFromAp();
      if (gen !== this._detectGen) return;
      if (this.deviceFilter && identity && !this._identityMatchesFilter(identity)) {
        this.onSoftAp = false;
        this.setReady(false);
        this.setFirmwarePanelVisible(false);
        if (switchBtnAp) switchBtnAp.style.display = "none";
        status.innerHTML =
          "<span class='error'>Wrong robot access point.</span> This link expects <b>" +
          this.deviceFilter.apSsid +
          "</b>.";
        wifiSetup.style.display = "none";
        this._setWifiConnectMode("prompt");
        return;
      }
      status.innerHTML =
        "<span class='ok'>Connected to robot access point.</span> Enter WiFi credentials below to put the robot on your network.";
      // Do not await: page-origin fetches (version.json) hang or stall with no internet on SoftAP.
      void this.scanNetworks();
      return;
    }

    if (staOk) {
      const idx = staResults.findIndex((r) => r && r.ok);
      const base = staTargets[idx];
      this.onSoftAp = false;
      this.robotStaBaseUrl = base;
      this.setReady(true);
      this.setFirmwarePanelVisible(true);
      this._setWifiConnectMode("connected");
      wifiSetup.style.display = "none";
      const switchBtnSta = this.el("wifiDisconnectBtn");
      if (switchBtnSta) switchBtnSta.style.display = "block";
      const robots = this._filteredRobots(loadRobots());
      const match = robots.find(
        (r) =>
          (r.mdnsHost && base.indexOf(r.mdnsHost) !== -1) ||
          (r.lastIp && base.indexOf(r.lastIp) !== -1)
      );
      if (match && match.hostname) {
        status.innerHTML =
          "<span class='ok'>Robot <b>" + match.hostname + "</b> reachable on your WiFi " +
          (match.lastIp && base.indexOf(match.lastIp) !== -1
            ? "(<b>" + match.lastIp + "</b>)"
            : "") +
          ".</span>";
        if (match.lastIp && base.indexOf(match.lastIp) !== -1) {
          this.mergeRobot({ ...match, lastIp: match.lastIp });
        }
      } else if (base && base.indexOf("192.168.") !== -1) {
        const ip = base.replace("http://", "").replace("https://", "");
        status.innerHTML =
          "<span class='ok'>Robot is connected to your WiFi at <b>" + ip + "</b>.</span>";
      } else {
        status.innerHTML =
          "<span class='ok'>Robot is connected to your WiFi (station mode).</span>";
      }
      await this.checkFirmwareVersion(base);
      return;
    }

    const probes = [...staResults, apProbe];
    status.innerHTML = robotNotFoundStatusHtml(probes);
    if (probesIndicateBrowserRefused(probes)) {
      this._setBrowserBlockedUi(true);
    } else {
      this._setWifiConnectMode("prompt");
    }
  }

  async sendCreds() {
    const ssidEl = this.el("ssid");
    const passEl = this.el("pass");
    const result = this.el("setupResult");
    if (!ssidEl || !passEl || !result) return;

    const ssid = ssidEl.value;
    const pass = passEl.value;

    if (!ssid) {
      result.innerHTML = "<span class='error'>Please enter or select a WiFi name (SSID).</span>";
      return;
    }

    result.innerHTML = "Sending credentials...";

    const showConnectedResult = (ip) => {
      const ipText = ip ? "<b>" + ip + "</b>" : "your network";
      result.innerHTML =
        "<span class='ok'>Robot connected to WiFi.</span><br>" +
        "Robot IP: " + ipText + "<br><br>" +
        "Now reconnect your computer to the same WiFi, pick this robot above if listed, and tap Check connection.<br><br>" +
        "<button type=\"button\" data-action=\"detect-mode\">Check connection</button>";
    };

    const mergeStatusFromAp = async (ipHint) => {
      try {
        const stRes = await robotFetch(ESP_AP_IP + "/status", { method: "GET" });
        if (stRes.ok) {
          const st = await stRes.json();
          this.mergeRobot({
            chipId: st.chipId,
            apSsid: st.apSsid,
            hostname: st.hostname,
            mdnsHost: st.mdnsHost,
            lastIp: ipHint || st.ip || ""
          });
        }
      } catch (e) {}
    };

    const waitForStaConnect = async () => {
      result.innerHTML = "Credentials saved. Robot is connecting to WiFi...";
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const stRes = await robotFetch(ESP_AP_IP + "/status", { method: "GET" });
          if (!stRes.ok) continue;
          const st = await stRes.json();
          if (st.connected) {
            await mergeStatusFromAp(st.ip || "");
            showConnectedResult(st.ip || "");
            this.refreshRobotPicker();
            return true;
          }
        } catch (e) {}
      }
      return false;
    };

    try {
      const res = await robotFetch(ESP_AP_IP + "/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: ssid,
          password: pass
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.connecting) {
          const connected = await waitForStaConnect();
          if (!connected) {
            result.innerHTML =
              "<span class='warn'>Credentials saved, but robot could not connect yet.</span><br>" +
              "Check SSID/password and try again. The setup AP stays on.";
            this.refreshRobotPicker();
          }
        } else if (data && data.connected) {
          await mergeStatusFromAp((data && data.ip) || "");
          showConnectedResult(data.ip || "");
          this.refreshRobotPicker();
        } else {
          result.innerHTML =
            "<span class='warn'>Credentials saved, but robot could not connect yet.</span><br>" +
            "Check SSID/password and try again. The setup AP stays on.";
          this.refreshRobotPicker();
        }
      } else {
        result.innerHTML = "<span class='error'>Failed to send credentials.</span>";
      }
    } catch (e) {
      result.innerHTML = "<span class='error'>Connection error.</span>";
    }
  }
}
