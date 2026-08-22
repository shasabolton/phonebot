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
  constructor(container) {
    /** @type {HTMLElement} */
    this.container = container;
    this.ready = false;
    this._readyChangeHandler = null;
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
      if (e.target.closest('[data-action="ble-connect"]')) {
        e.preventDefault();
        void this.connect();
      }
    };
    this._onDisconnect = () => {
      this._clearConnection(false);
      this._setStatus(
        "<span class='warn'>Bluetooth disconnected.</span> " +
          "<button type='button' data-action='ble-connect'>Connect again</button>"
      );
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

  setReady(ready) {
    const changed = this.ready !== ready;
    this.ready = ready;
    if (changed && this._readyChangeHandler) this._readyChangeHandler(this.ready);
  }

  isReady() {
    return this.ready && !!this._actionChar;
  }

  destroy() {
    this.container.removeEventListener("click", this._onContainerClick);
    void this.disconnect();
    if (this.container) this.container.innerHTML = "";
  }

  el(id) {
    return this.container.querySelector("#" + id);
  }

  buildDom() {
    this.container.innerHTML = `
<div id="bleStatus" class="box">Checking Bluetooth support…</div>
<button type="button" id="bleConnectBtn" data-action="ble-connect">Connect to robot</button>
<button type="button" id="bleDisconnectBtn" style="display:none;">Disconnect</button>
<p class="muted">
  Look for a device named <b>robot-</b> followed by six hex digits (same id as the WiFi AP).
  Keep the phone within a few metres of the ESP32. Bluetooth control works without WiFi.
</p>
<div id="bleDeviceInfo" class="muted" style="margin-top:8px;word-break:break-all;"></div>
`;
  }

  _bindControls() {
    const disc = this.el("bleDisconnectBtn");
    if (disc) disc.addEventListener("click", () => void this.disconnect());
  }

  _refreshAvailability() {
    const status = this.el("bleStatus");
    const connectBtn = this.el("bleConnectBtn");
    if (!status || !connectBtn) return;

    if (!navigator.bluetooth) {
      status.innerHTML =
        "<span class='error'>Web Bluetooth is not available in this browser.</span><br>" +
        "Use Chrome or Edge on Android/desktop over HTTPS, or localhost while developing.";
      connectBtn.disabled = true;
      this.setReady(false);
      return;
    }

    if (!window.isSecureContext) {
      status.innerHTML =
        "<span class='error'>Web Bluetooth requires a secure context (HTTPS or localhost).</span>";
      connectBtn.disabled = true;
      this.setReady(false);
      return;
    }

    status.innerHTML =
      "<span class='muted'>Not connected.</span> Tap Connect and pick your robot from the list.";
    connectBtn.disabled = false;
    this.setReady(false);
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
    this._setStatus("Opening Bluetooth device picker…");

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [PHONEBOT_BLE.serviceUuid] }],
        optionalServices: [PHONEBOT_BLE.serviceUuid]
      });

      this._clearConnection(false);
      this._device = device;
      device.addEventListener("gattserverdisconnected", this._onDisconnect);

      this._setStatus("Connecting to <b>" + escapeHtml(device.name || "robot") + "</b>…");
      const server = await device.gatt.connect();
      this._server = server;

      const service = await server.getPrimaryService(PHONEBOT_BLE.serviceUuid);
      this._pinSetupChar = await service.getCharacteristic(PHONEBOT_BLE.pinSetupUuid);
      this._actionChar = await service.getCharacteristic(PHONEBOT_BLE.actionUuid);

      let fwText = "";
      try {
        const statusChar = await service.getCharacteristic(PHONEBOT_BLE.statusUuid);
        const value = await statusChar.readValue();
        const json = JSON.parse(new TextDecoder().decode(value));
        if (json.fwVersion) fwText = "Firmware " + json.fwVersion;
      } catch (_) {
        /* status read optional */
      }

      this.setReady(true);
      this._setStatus("<span class='ok'>Connected via Bluetooth.</span>");
      this._setDeviceInfo(
        (device.name || "robot") + (fwText ? " · " + fwText : "")
      );

      const discBtn = this.el("bleDisconnectBtn");
      if (connectBtn) connectBtn.style.display = "none";
      if (discBtn) discBtn.style.display = "";
    } catch (e) {
      this._clearConnection(true);
      const msg = e && e.message ? e.message : String(e);
      if (msg.indexOf("cancel") !== -1 || e.name === "NotFoundError") {
        this._setStatus(
          "<span class='muted'>Pairing cancelled.</span> " +
            "<button type='button' data-action='ble-connect'>Try again</button>"
        );
      } else {
        this._setStatus(
          "<span class='error'>Bluetooth error: " +
            escapeHtml(msg) +
            "</span> " +
            "<button type='button' data-action='ble-connect'>Try again</button>"
        );
      }
      this._setDeviceInfo("");
    } finally {
      this._connectBusy = false;
      if (connectBtn && !this.isReady()) {
        connectBtn.disabled = false;
        connectBtn.style.display = "";
      }
    }
  }

  async disconnect() {
    this._setDeviceInfo("");
    if (this._device && this._device.gatt.connected) {
      try {
        this._device.gatt.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    this._clearConnection(true);
    this._setStatus(
      "<span class='muted'>Disconnected.</span> " +
        "<button type='button' data-action='ble-connect'>Connect to robot</button>"
    );
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
    if (!this._pinSetupChar) {
      return { ok: false, status: 0, body: "Bluetooth not connected." };
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
    if (!this._actionChar) {
      return { ok: false, status: 0, body: "Bluetooth not connected." };
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
