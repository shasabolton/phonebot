const ESP_AP_IP = "http://192.168.4.1";
const ESP_AP_PASS = "12345678"; // AP_PASS in epsBootstrap.ino
const LEGACY_STA_IP_KEY = "robot_sta_ip";
const ROBOTS_KEY = "phonebot_known_robots";

/** Tried in order when loading firmware from the page origin (serve project root over HTTP). */
const FIRMWARE_RELATIVE_PATHS = [
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

async function ping(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url + "/ping", {
      method: "GET",
      signal: controller.signal
    });
    if (res.ok) return true;
  } catch (e) {}
  finally {
    clearTimeout(timeoutId);
  }
  return false;
}

class WifiTransmitter {
  constructor(container) {
    /** @type {HTMLElement} */
    this.container = container;
    /** Base URL of robot when reachable on LAN/WiFi (station), e.g. http://192.168.1.5 */
    this.robotStaBaseUrl = null;
    this.ready = false;
    this._readyChangeHandler = null;
    this._uploadFirmwareBusy = false;
    this._onContainerClick = (e) => {
      if (e.target.closest('[data-action="detect-mode"]')) {
        e.preventDefault();
        this.detectMode();
      }
    };
    this.buildDom();
    this.container.addEventListener("click", this._onContainerClick);
    this._bindControls();
    migrateLegacyStaIp();
    this.refreshRobotPicker();
    this.detectMode();
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
    return this.ready && !!this.robotStaBaseUrl;
  }

  async postControl(path, message) {
    if (!this.robotStaBaseUrl) {
      return { ok: false, status: 0, body: "Robot not connected on station WiFi." };
    }
    try {
      const res = await fetch(this.robotStaBaseUrl + path, {
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
<div id="robotPicker" class="box" style="display:none;">
  <label for="knownRobotSelect"><b>Known robots</b> (on your home / hotspot WiFi)</label>
  <select id="knownRobotSelect"></select>
  <div id="knownRobotStoredIp" class="muted" style="margin-top:6px;word-break:break-all;"></div>
  <p class="muted">Pick a robot, then check connection after you switch your computer to the same WiFi.</p>
  <button type="button" data-action="detect-mode">Check connection</button>
</div>

<div id="status" class="box">Checking robot connection...</div>
<button type="button" id="wifiDisconnectBtn" style="display:none;">Disconnect / Switch Device</button>

<div id="firmwarePanel" class="box">
  <h3>Firmware</h3>
  <div id="firmwareVersionInfo" class="muted" style="margin-bottom:10px;"></div>
  <p class="muted">
    OTA loads the sketch’s Arduino build output under <code>espBootstrap/build/</code> (same repo you serve with this HTML).
    After compile or “Export compiled Binary”, use the <code>.bin</code> under the board-specific folder (for example <code>nodemcuv2/espBootstrap.ino.bin</code>). Serve the project root over HTTP.
  </p>
  <input type="file" id="firmwareFile" accept=".bin" style="display:none;">
  <button type="button" id="firmwareBtn" style="display:none;">Update firmware</button>
  <div id="firmwareStatus" class="muted" style="margin-top:8px;"></div>
</div>

<div id="wifiSetup" class="box" style="display:none;">
  <h3>Connect Robot to Your WiFi</h3>

  <p>
    Connected to this robot's access point.<br><br>
    Give it your WiFi credentials so it can join your network.
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
`;
  }

  _bindControls() {
    const disc = this.el("wifiDisconnectBtn");
    if (disc) disc.addEventListener("click", () => this.disconnect());
    const fw = this.el("firmwareBtn");
    if (fw) fw.addEventListener("click", () => this.uploadFirmware());
    const known = this.el("knownRobotSelect");
    if (known) known.addEventListener("change", () => this.updateKnownRobotStoredIpHint());
    const nl = this.el("networkList");
    if (nl) nl.addEventListener("change", () => this.onNetworkSelected());
    const scan = this.el("wifiScanNetworksBtn");
    if (scan) scan.addEventListener("click", () => this.scanNetworks());
    const send = this.el("wifiSendCredsBtn");
    if (send) send.addEventListener("click", () => this.sendCreds());
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

  updateKnownRobotStoredIpHint() {
    const hint = this.el("knownRobotStoredIp");
    const sel = this.el("knownRobotSelect");
    if (!hint || !sel) return;
    const robots = loadRobots();
    if (robots.length === 0) {
      hint.textContent = "";
      return;
    }
    const id = sel.value;
    if (!id) {
      hint.textContent =
        "Stored IPs on this device: " +
        robots
          .map((r) => (r.hostname || r.chipId) + " → " + (r.lastIp || "(none)"))
          .join(" · ");
      return;
    }
    const r = robots.find((x) => x.chipId === id);
    hint.textContent = r
      ? "Stored IP on this device: " + (r.lastIp || "(none)")
      : "";
  }

  refreshRobotPicker() {
    const wrap = this.el("robotPicker");
    const sel = this.el("knownRobotSelect");
    if (!wrap || !sel) return;
    const robots = loadRobots();
    if (robots.length === 0) {
      wrap.style.display = "none";
      sel.innerHTML = "";
      const hint = this.el("knownRobotStoredIp");
      if (hint) hint.textContent = "";
      return;
    }
    wrap.style.display = "block";
    sel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "(All saved — try each)";
    allOpt.title = "Try every saved robot; see stored IPs below.";
    sel.appendChild(allOpt);

    robots.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.chipId;
      const ipPart = r.lastIp ? r.lastIp : "(no IP saved)";
      let label = r.hostname
        ? r.hostname + (r.apSsid ? " (" + r.apSsid + ")" : "")
        : r.apSsid || r.chipId;
      label += " — " + ipPart;
      opt.textContent = label;
      opt.title = label;
      sel.appendChild(opt);
    });
    this.updateKnownRobotStoredIpHint();
  }

  async fetchRobotIdentityFromAp() {
    try {
      const res = await fetch(ESP_AP_IP + "/status", { method: "GET" });
      if (!res.ok) return;
      const data = await res.json();
      this.mergeRobot({
        chipId: data.chipId,
        apSsid: data.apSsid,
        hostname: data.hostname,
        mdnsHost: data.mdnsHost,
        lastIp: data.ip || ""
      });
    } catch (e) {}
  }

  buildStaTargets() {
    const urls = [];
    const add = (u) => {
      if (!u) return;
      if (urls.indexOf(u) === -1) urls.push(u);
    };

    const robots = loadRobots();
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

    add("http://esp8266.local");
    return urls;
  }

  apSsidHintHtml() {
    const robots = loadRobots();
    if (robots.length === 0) {
      return (
        "Look for a WiFi network named <b>Robot-</b> followed by six hex digits " +
        "(same id as this robot's hostname). Password: <b>" + ESP_AP_PASS + "</b>"
      );
    }
    const lines = robots
      .map((r) => (r.apSsid ? "<b>" + r.apSsid + "</b>" : null))
      .filter(Boolean);
    if (lines.length === 0) {
      return "Password: <b>" + ESP_AP_PASS + "</b>";
    }
    return "Try one of these AP names (or a new Robot-XXXXXX): " + lines.join(", ") +
      ". Password: <b>" + ESP_AP_PASS + "</b>";
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
      const res = await fetch(ESP_AP_IP + "/scan", { method: "GET" });
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

  disconnect() {
    this.robotStaBaseUrl = null;
    this.setReady(false);
    this.setFirmwarePanelVisible(false);
    const wifiSetup = this.el("wifiSetup");
    const status = this.el("status");
    const btn = this.el("wifiDisconnectBtn");
    if (wifiSetup) wifiSetup.style.display = "none";
    if (btn) btn.style.display = "none";
    if (status) {
      status.innerHTML =
        "<span class='muted'>Disconnected. Select a saved robot and click Check connection, or connect to another robot AP.</span>";
    }
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
      const r = await fetch(baseUrl + "/version", {
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
      try {
        const u = new URL("version.json", window.location.href).href;
        const r = await fetch(u, { method: "GET", cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          latestFw = j.fwVersion != null ? String(j.fwVersion) : null;
        }
      } catch (e) {}
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

  async uploadFirmware() {
    const btn = this.el("firmwareBtn");
    const st = this.el("firmwareStatus");
    if (!btn || !st) return;
    if (!this.robotStaBaseUrl) {
      st.innerHTML = "<span class='error'>Robot not connected on WiFi (station).</span>";
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
    try {
      const form = new FormData();
      form.append("update", blob, "firmware.bin");
      const res = await fetch(this.robotStaBaseUrl + "/update", {
        method: "POST",
        body: form
      });
      if (res.ok) {
        st.innerHTML = "<span class='ok'>Upload finished. Robot is restarting with new firmware.</span>";
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
    const status = this.el("status");
    const wifiSetup = this.el("wifiSetup");
    if (!status || !wifiSetup) return;

    migrateLegacyStaIp();
    this.refreshRobotPicker();

    const staTargets = this.buildStaTargets();

    status.innerHTML = "Checking robot connection...";
    wifiSetup.style.display = "none";

    const staPromises = staTargets.map((base) => ping(base));
    const [staResults, apOk] = await Promise.all([
      Promise.all(staPromises),
      ping(ESP_AP_IP)
    ]);
    const staOk = staResults.some(Boolean);

    // Clear station state before branching. If the phone is on the robot SoftAP,
    // pings to a saved STA URL can still succeed (AP+STA). Prefer AP UI so
    // credential inputs always show when joined to the robot AP.
    this.robotStaBaseUrl = null;
    this.setReady(false);
    this.setFirmwarePanelVisible(false);
    const switchBtn = this.el("wifiDisconnectBtn");
    if (switchBtn) switchBtn.style.display = "none";

    if (apOk) {
      status.innerHTML = "<span class='warn'>Connected to robot access point.</span>";
      wifiSetup.style.display = "block";
      await this.fetchRobotIdentityFromAp();
      this.scanNetworks();
      return;
    }

    if (staOk) {
      const idx = staResults.findIndex(Boolean);
      const base = staTargets[idx];
      this.robotStaBaseUrl = base;
      this.setReady(true);
      this.setFirmwarePanelVisible(true);
      const switchBtnSta = this.el("wifiDisconnectBtn");
      if (switchBtnSta) switchBtnSta.style.display = "block";
      const robots = loadRobots();
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

    status.innerHTML =
      "<span class='error'>Robot not found.</span><br><br>" +
      "Connect your computer to this robot's WiFi access point, then click below.<br><br>" +
      this.apSsidHintHtml() + "<br><br>" +
      "<button type=\"button\" data-action=\"detect-mode\">Click here when you are connected</button>";
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

    try {
      const res = await fetch(ESP_AP_IP + "/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: ssid,
          password: pass
        })
      });

      if (res.ok) {
        const data = await res.json();
        try {
          const stRes = await fetch(ESP_AP_IP + "/status", { method: "GET" });
          if (stRes.ok) {
            const st = await stRes.json();
            this.mergeRobot({
              chipId: st.chipId,
              apSsid: st.apSsid,
              hostname: st.hostname,
              mdnsHost: st.mdnsHost,
              lastIp: (data && data.ip) || st.ip || ""
            });
          }
        } catch (e) {}
        if (data && data.connected) {
          const ipText = data.ip ? "<b>" + data.ip + "</b>" : "your network";
          result.innerHTML =
            "<span class='ok'>Robot connected to WiFi.</span><br>" +
            "Robot IP: " + ipText + "<br><br>" +
            "Now reconnect your computer to the same WiFi, pick this robot above, and click Check connection.<br><br>" +
            "<button type=\"button\" data-action=\"detect-mode\">I switched networks — check robot</button>";
        } else {
          result.innerHTML =
            "<span class='warn'>Credentials saved, but robot could not connect yet.</span><br>" +
            "Check SSID/password and try again. The setup AP stays on.";
        }
        this.refreshRobotPicker();
      } else {
        result.innerHTML = "<span class='error'>Failed to send credentials.</span>";
      }
    } catch (e) {
      result.innerHTML = "<span class='error'>Connection error.</span>";
    }
  }
}
