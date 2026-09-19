/**
 * Bluetooth LE transmitter via Web Bluetooth.
 * Mirrors WiFi /pin-setup and /action payloads on GATT write characteristics.
 *
 * Requires HTTPS (or localhost) and a user gesture to pair. Works in Chrome/Edge
 * on Android and desktop; iOS Safari has limited Web Bluetooth support.
 */
const PHONEBOT_BLE = {
  serviceUuid: "4faf2012-5fb4-459e-8fcc-c5c9c331914b",
  pinSetupUuid: "4faf2013-5fb4-459e-8fcc-c5c9c331914b",
  actionUuid: "4faf2014-5fb4-459e-8fcc-c5c9c331914b",
  statusUuid: "4faf2015-5fb4-459e-8fcc-c5c9c331914b"
};

class BluetoothTransmitter {
  constructor(container, options = {}) {
    /** @type {HTMLElement} */
    this.container = container;
    /** @type {object|null} */
    this.deviceFilter = options.deviceFilter || null;
    this.ready = false;
    this._readyChangeHandler = null;
    /** Hz for action writes while the app transmit loop is on (1–20). */
    this.actionFrequencyHz = 10;
    this._actionFreqChangeHandler = null;
    /** @type {BluetoothDevice|null} */
    this._device = null;
    /** @type {BluetoothRemoteGATTServer|null} */
    this._server = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this._pinSetupChar = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this._actionChar = null;
    /** @type {TextEncoder} */
    this._encoder = new TextEncoder();
    this._connectBusy = false;
    this._onContainerClick = (e) => {
      const t = e.target;
      const el = t && (t instanceof Element ? t : t.parentElement);
      if (!el) return;
      if (el.closest('[data-action="open-in-chrome"]')) {
        e.preventDefault();
        if (typeof openCurrentPageInChrome === "function") openCurrentPageInChrome();
        return;
      }
      if (el.closest('[data-action="open-in-bluefy"]')) {
        e.preventDefault();
        if (typeof openCurrentPageInBluefy === "function") openCurrentPageInBluefy();
        return;
      }
      if (el.closest('[data-action="open-browser-install"]')) {
        e.preventDefault();
        if (typeof openBrowserInstallStore === "function") openBrowserInstallStore();
        return;
      }
      if (el.closest('[data-action="ble-connect"]')) {
        e.preventDefault();
        void this.connect();
      }
    };
    this._onDisconnect = () => {
      this._clearConnection(true);
      this._setStatus("<span class='warn'>Bluetooth disconnected.</span>");
      this._setDeviceInfo("");
      this._setFirmwareInfoHtml("");
    };

    this.buildDom();
    this.container.addEventListener("click", this._onContainerClick);
    this._bindControls();
    this._refreshAvailability();
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
    return this.ready && !!this._actionChar;
  }

  /** GATT linked (may still be blocked by outdated firmware). */
  isLinked() {
    return !!(this._device && this._actionChar);
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

  destroy() {
    this.container.removeEventListener("click", this._onContainerClick);
    void this.disconnect();
    if (this.container) this.container.innerHTML = "";
  }

  el(id) {
    return this.container.querySelector("#" + id);
  }

  setDeviceFilter(filter) {
    this.deviceFilter = filter || null;
    this._refreshAvailability();
  }

  buildDom() {
    this.container.innerHTML = `
<div id="bleStatus" class="box">Checking Bluetooth support…</div>
<button type="button" id="bleConnectBtn" data-action="ble-connect">Connect to robot</button>
<button type="button" id="bleDisconnectBtn" style="display:none;">Disconnect</button>
<div id="bleDeviceInfo" class="muted" style="margin-top:8px;word-break:break-all;"></div>
<div id="bleFirmwareInfo" class="box" style="display:none;margin-top:8px;"></div>
<div id="actionRatePanel" class="box" style="display:none;">
  <label for="actionFreqHz"><b>Action send rate</b> <span id="actionFreqHzValue">10</span> Hz</label>
  <input type="range" id="actionFreqHz" min="1" max="20" step="1" value="10" style="width:100%;margin-top:8px;">
  <p class="muted" style="margin-top:6px;margin-bottom:0;">
    How often action GATT writes run while the transmit loop is on.
  </p>
</div>
`;
  }

  _bindControls() {
    const disc = this.el("bleDisconnectBtn");
    if (disc) disc.addEventListener("click", () => void this.disconnect());
    const freq = this.el("actionFreqHz");
    if (freq) {
      const onFreq = () => this.setActionFrequencyHz(freq.value);
      freq.addEventListener("input", onFreq);
      freq.addEventListener("change", onFreq);
    }
  }

  _refreshAvailability() {
    const status = this.el("bleStatus");
    const connectBtn = this.el("bleConnectBtn");
    if (!status || !connectBtn) return;

    if (!navigator.bluetooth) {
      status.innerHTML =
        typeof browserRefusedSwitchHtml === "function"
          ? browserRefusedSwitchHtml("Web Bluetooth is not available in this browser.")
          : "<span class='error'>Web Bluetooth is not available in this browser.</span>";
      this._setBrowserBlockedUi(true);
      this.setReady(false);
      return;
    }

    if (!window.isSecureContext) {
      status.innerHTML =
        typeof browserRefusedSwitchHtml === "function"
          ? browserRefusedSwitchHtml(
              "Web Bluetooth requires a secure context (HTTPS or localhost)."
            )
          : "<span class='error'>Web Bluetooth requires a secure context (HTTPS or localhost).</span>";
      this._setBrowserBlockedUi(true);
      this.setReady(false);
      return;
    }

    this._setBrowserBlockedUi(false);
    status.innerHTML = this.deviceFilter
      ? "<span class='muted'>Not connected.</span> Tap Connect to pair with <b>" +
        escapeHtml(this.deviceFilter.bleName) +
        "</b>."
      : "<span class='muted'>Not connected.</span> Tap Connect and pick your robot from the list.";
    connectBtn.disabled = false;
    this.setReady(false);
  }

  /** Hide controls when this browser cannot use Web Bluetooth. */
  _setBrowserBlockedUi(blocked) {
    this._setActionRateVisible(false);
    const fw = this.el("bleFirmwareInfo");
    if (fw) {
      fw.style.display = "none";
      fw.innerHTML = "";
    }
    const info = this.el("bleDeviceInfo");
    if (info) info.style.display = blocked ? "none" : "";
    const connectBtn = this.el("bleConnectBtn");
    if (connectBtn) {
      connectBtn.style.display = blocked ? "none" : "";
      connectBtn.disabled = !!blocked;
    }
    const disc = this.el("bleDisconnectBtn");
    if (blocked && disc) disc.style.display = "none";
  }

  _setFirmwareInfoHtml(html) {
    const fw = this.el("bleFirmwareInfo");
    if (!fw) return;
    if (!html) {
      fw.style.display = "none";
      fw.innerHTML = "";
      return;
    }
    fw.innerHTML = html;
    fw.style.display = "block";
  }

  /**
   * Compare robot BLE status fwVersion to page version.json.
   * @returns {Promise<{ok: boolean, robotFw: string|null, latestFw: string|null}>}
   */
  async _evaluateFirmware(robotFw) {
    const latestFw =
      typeof fetchAppFwVersion === "function" ? await fetchAppFwVersion(2500) : null;
    return {
      ok: !!(robotFw && latestFw && robotFw === latestFw),
      robotFw: robotFw || null,
      latestFw: latestFw || null
    };
  }

  _buildRequestDeviceOptions() {
    if (typeof PhonebotDeviceFilter !== "undefined") {
      return PhonebotDeviceFilter.buildBluetoothRequestOptions(
        this.deviceFilter,
        PHONEBOT_BLE.serviceUuid
      );
    }
    return {
      filters: [{ services: [PHONEBOT_BLE.serviceUuid] }],
      optionalServices: [PHONEBOT_BLE.serviceUuid]
    };
  }

  _setStatus(html) {
    const status = this.el("bleStatus");
    if (status) status.innerHTML = html;
  }

  _setDeviceInfo(text) {
    const el = this.el("bleDeviceInfo");
    if (el) el.textContent = text || "";
  }

  _clearConnection(updateUi) {
    if (this._device) {
      this._device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    }
    this._device = null;
    this._server = null;
    this._pinSetupChar = null;
    this._actionChar = null;
    this.setReady(false);
    if (!updateUi) return;
    this._setFirmwareInfoHtml("");
    const connectBtn = this.el("bleConnectBtn");
    const discBtn = this.el("bleDisconnectBtn");
    if (connectBtn) connectBtn.style.display = "";
    if (discBtn) discBtn.style.display = "none";
  }

  async connect() {
    if (this._connectBusy) return;
    if (!navigator.bluetooth) {
      this._refreshAvailability();
      return;
    }
    this._connectBusy = true;
    const connectBtn = this.el("bleConnectBtn");
    if (connectBtn) connectBtn.disabled = true;
    this._setFirmwareInfoHtml("");
    this._setStatus(
      this.deviceFilter
        ? "Opening Bluetooth picker for <b>" + escapeHtml(this.deviceFilter.bleName) + "</b>…"
        : "Opening Bluetooth device picker…"
    );

    try {
      const device = await navigator.bluetooth.requestDevice(
        this._buildRequestDeviceOptions()
      );

      this._clearConnection(false);
      this._device = device;
      device.addEventListener("gattserverdisconnected", this._onDisconnect);

      this._setStatus("Connecting to <b>" + escapeHtml(device.name || "robot") + "</b>…");
      const server = await device.gatt.connect();
      this._server = server;

      const service = await server.getPrimaryService(PHONEBOT_BLE.serviceUuid);
      this._pinSetupChar = await service.getCharacteristic(PHONEBOT_BLE.pinSetupUuid);
      this._actionChar = await service.getCharacteristic(PHONEBOT_BLE.actionUuid);

      let robotFw = null;
      try {
        const statusChar = await service.getCharacteristic(PHONEBOT_BLE.statusUuid);
        const value = await statusChar.readValue();
        const json = JSON.parse(new TextDecoder().decode(value));
        if (json.fwVersion != null) robotFw = String(json.fwVersion);
      } catch (_) {
        /* status read optional */
      }

      this._setStatus("Checking firmware…");
      const fwCheck = await this._evaluateFirmware(robotFw);

      this._setDeviceInfo(device.name || "robot");
      const discBtn = this.el("bleDisconnectBtn");
      if (connectBtn) connectBtn.style.display = "none";
      if (discBtn) discBtn.style.display = "";

      if (fwCheck.ok) {
        this._setFirmwareInfoHtml(
          "<span class='ok'>Firmware up to date with version <b>" +
            escapeHtml(fwCheck.robotFw) +
            "</b>.</span>"
        );
        this._setStatus("<span class='ok'>Connected via Bluetooth.</span>");
        this.setReady(true);
      } else if (fwCheck.robotFw && fwCheck.latestFw) {
        this._setFirmwareInfoHtml(
          "<span class='warn'>The robot has firmware version <b>" +
            escapeHtml(fwCheck.robotFw) +
            "</b>. Update to <b>" +
            escapeHtml(fwCheck.latestFw) +
            "</b>.</span><br><br>" +
            "Connect via <b>WiFi</b> (station mode) to update firmware. Bluetooth control is disabled until then."
        );
        this._setStatus(
          "<span class='warn'>Connected via Bluetooth, but firmware is out of date — control disabled.</span>"
        );
        this.setReady(false);
      } else if (fwCheck.robotFw && !fwCheck.latestFw) {
        this._setFirmwareInfoHtml(
          "<span class='warn'>Robot firmware version: <b>" +
            escapeHtml(fwCheck.robotFw) +
            "</b>. Could not load <code>version.json</code> from this page to verify.</span><br><br>" +
            "Connect via <b>WiFi</b> to update firmware if needed. Bluetooth control is disabled until the app can verify the version."
        );
        this._setStatus(
          "<span class='warn'>Connected via Bluetooth, but firmware could not be verified — control disabled.</span>"
        );
        this.setReady(false);
      } else {
        this._setFirmwareInfoHtml(
          "<span class='warn'>Could not read firmware version from the robot over Bluetooth.</span><br><br>" +
            "Connect via <b>WiFi</b> to update firmware. Bluetooth control is disabled until the version is known and up to date."
        );
        this._setStatus(
          "<span class='warn'>Connected via Bluetooth, but firmware is unknown — control disabled.</span>"
        );
        this.setReady(false);
      }
    } catch (e) {
      this._clearConnection(true);
      const msg = e && e.message ? e.message : String(e);
      if (msg.indexOf("cancel") !== -1 || e.name === "NotFoundError") {
        this._setStatus("<span class='muted'>Pairing cancelled.</span>");
      } else {
        this._setStatus(
          "<span class='error'>Bluetooth error: " + escapeHtml(msg) + "</span>"
        );
      }
      this._setDeviceInfo("");
      this._setFirmwareInfoHtml("");
    } finally {
      this._connectBusy = false;
      if (connectBtn && !this.isReady()) {
        // Keep Connect hidden if still GATT-linked but not control-ready (outdated FW).
        const stillLinked = !!(this._device && this._actionChar);
        if (!stillLinked) {
          connectBtn.disabled = false;
          connectBtn.style.display = "";
        }
      }
    }
  }

  async disconnect() {
    this._setDeviceInfo("");
    this._setFirmwareInfoHtml("");
    if (this._device && this._device.gatt && this._device.gatt.connected) {
      try {
        this._device.gatt.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    this._clearConnection(true);
    this._setStatus("<span class='muted'>Disconnected.</span>");
    const connectBtn = this.el("bleConnectBtn");
    if (connectBtn) connectBtn.disabled = false;
  }

  async _writeCharacteristic(characteristic, message) {
    const data = this._encoder.encode(String(message || ""));
    const props = characteristic.properties;
    if (props.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(data);
    } else {
      await characteristic.writeValue(data);
    }
  }

  async transmitPinSetup(message) {
    if (!this.isReady() || !this._pinSetupChar) {
      return {
        ok: false,
        status: 0,
        body: this._actionChar
          ? "Bluetooth connected but firmware must be up to date before control."
          : "Bluetooth not connected."
      };
    }
    try {
      await this._writeCharacteristic(this._pinSetupChar, message);
      return { ok: true, status: 200, body: "ble pin-setup ok" };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: e && e.message ? e.message : "ble pin-setup failed"
      };
    }
  }

  async transmitAction(message) {
    if (!this.isReady() || !this._actionChar) {
      return {
        ok: false,
        status: 0,
        body: this._actionChar
          ? "Bluetooth connected but firmware must be up to date before control."
          : "Bluetooth not connected."
      };
    }
    try {
      await this._writeCharacteristic(this._actionChar, message);
      return { ok: true, status: 200, body: "ble action ok" };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: e && e.message ? e.message : "ble action failed"
      };
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
