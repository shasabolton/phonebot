/**
 * Phone orientation via DeviceOrientationEvent.
 * Pitch ≈ beta (front/back tilt), roll ≈ gamma (left/right tilt), yaw ≈ alpha (compass / Z rotation).
 */
class Gyro extends Sensor {
    constructor(config = {}) {
        super({ type: "gyro", ...config });
        this.name = config?.name || "Gyro";
        /** @type {number|null} degrees */
        this.pitch = null;
        /** @type {number|null} degrees */
        this.roll = null;
        /** @type {number|null} degrees */
        this.yaw = null;
        this._listening = false;
        this._onOrientation = this._onOrientation.bind(this);
        this._statusEl = null;
        this._pitchEl = null;
        this._rollEl = null;
        this._yawEl = null;
        this._toggleBtn = null;
    }

    _formatDeg(v) {
        if (v == null || Number.isNaN(v)) return "—";
        return `${Number(v).toFixed(1)}°`;
    }

    _updateReadout() {
        if (this._pitchEl) this._pitchEl.textContent = this._formatDeg(this.pitch);
        if (this._rollEl) this._rollEl.textContent = this._formatDeg(this.roll);
        if (this._yawEl) this._yawEl.textContent = this._formatDeg(this.yaw);
    }

    _onOrientation(ev) {
        const beta = ev.beta;
        const gamma = ev.gamma;
        let alpha = ev.alpha;
        if ((alpha == null || Number.isNaN(alpha)) && ev.webkitCompassHeading != null) {
            const h = ev.webkitCompassHeading;
            if (Number.isFinite(h)) alpha = 360 - h;
        }
        this.pitch = beta != null && Number.isFinite(beta) ? beta : null;
        this.roll = gamma != null && Number.isFinite(gamma) ? gamma : null;
        this.yaw = alpha != null && Number.isFinite(alpha) ? alpha : null;
        this._updateReadout();
    }

    async _ensurePermission() {
        const DO = window.DeviceOrientationEvent;
        if (DO && typeof DO.requestPermission === "function") {
            const state = await DO.requestPermission();
            return state === "granted";
        }
        return true;
    }

    async start() {
        if (this._listening) return true;
        if (!window.DeviceOrientationEvent) {
            this._setStatus("Device orientation is not supported in this browser.", true);
            return false;
        }
        try {
            const permitted = await this._ensurePermission();
            if (!permitted) {
                this._setStatus("Motion/orientation permission was denied.", true);
                return false;
            }
        } catch (err) {
            console.error("Gyro permission failed:", err);
            this._setStatus("Could not obtain orientation permission.", true);
            return false;
        }
        window.addEventListener("deviceorientation", this._onOrientation, false);
        this._listening = true;
        this._setStatus("Listening — move the phone to update pitch, roll, and yaw.", false, true);
        if (this._toggleBtn) this._toggleBtn.textContent = "Stop gyro";
        return true;
    }

    stop() {
        if (!this._listening) return;
        window.removeEventListener("deviceorientation", this._onOrientation, false);
        this._listening = false;
        this.pitch = null;
        this.roll = null;
        this.yaw = null;
        this._updateReadout();
        this._setStatus("Gyro stopped. Tap “Start gyro” to track orientation again.", false);
        if (this._toggleBtn) this._toggleBtn.textContent = "Start gyro";
    }

    isListening() {
        return this._listening;
    }

    _setStatus(text, isError = false, isOk = false) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.className = isError
            ? "error sensor-gyro-status"
            : isOk
              ? "ok sensor-gyro-status"
              : "muted sensor-gyro-status";
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor sensor-gyro";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const readouts = document.createElement("div");
        readouts.className = "sensor-gyro-readouts";

        const mkRow = (label) => {
            const row = document.createElement("div");
            row.className = "sensor-gyro-row";
            const lab = document.createElement("span");
            lab.className = "sensor-gyro-label";
            lab.textContent = label;
            const val = document.createElement("span");
            val.className = "sensor-gyro-value";
            val.textContent = "—";
            row.appendChild(lab);
            row.appendChild(val);
            readouts.appendChild(row);
            return val;
        };

        this._pitchEl = mkRow("Pitch");
        this._rollEl = mkRow("Roll");
        this._yawEl = mkRow("Yaw");

        const status = document.createElement("p");
        status.className = "muted sensor-gyro-status";
        status.textContent =
            "Tap “Start gyro” to read phone tilt. On iOS, the browser will ask for motion access.";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "sensor-gyro-toggle";
        toggleBtn.textContent = "Start gyro";
        toggleBtn.addEventListener("click", async () => {
            if (this._listening) {
                this.stop();
            } else {
                await this.start();
            }
        });

        wrap.appendChild(title);
        wrap.appendChild(readouts);
        wrap.appendChild(status);
        wrap.appendChild(toggleBtn);
        container.appendChild(wrap);

        this.gui = wrap;
        this._statusEl = status;
        this._toggleBtn = toggleBtn;
    }

    destroy() {
        this.stop();
        this._statusEl = null;
        this._pitchEl = null;
        this._rollEl = null;
        this._yawEl = null;
        this._toggleBtn = null;
    }
}
