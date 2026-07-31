/**
 * RC servo / CRS channel in microseconds (matches firmware pin:servo:min:max:home and pin:us updates).
 * Configure with minMicroseconds, maxMicroseconds, homeMicroseconds, or legacy minAngle/homeAngle/maxAngle (mapped 0–180 → 1000–2000 µs).
 */
class Servo {
    /**
     * @param {object} config
     */
    constructor(config) {
        this.type = "servo";
        this.name = config?.name ?? "servo";
        this.pin = config?.pin;

        const fromAngles =
            Number.isFinite(config?.minAngle) &&
            Number.isFinite(config?.maxAngle) &&
            Number.isFinite(config?.homeAngle);

        if (Number.isFinite(config?.minMicroseconds) && Number.isFinite(config?.maxMicroseconds)) {
            this.minMicroseconds = Math.round(config.minMicroseconds);
            this.maxMicroseconds = Math.round(config.maxMicroseconds);
            this.homeMicroseconds = Number.isFinite(config.homeMicroseconds)
                ? Math.round(config.homeMicroseconds)
                : Math.round((this.minMicroseconds + this.maxMicroseconds) / 2);
        } else if (fromAngles) {
            this.minMicroseconds = Servo._angleToUsLinear(config.minAngle, config.minAngle, config.maxAngle);
            this.maxMicroseconds = Servo._angleToUsLinear(config.maxAngle, config.minAngle, config.maxAngle);
            this.homeMicroseconds = Servo._angleToUsLinear(config.homeAngle, config.minAngle, config.maxAngle);
        } else {
            throw new Error(
                `Servo "${this.name}" needs minMicroseconds/maxMicroseconds/homeMicroseconds or minAngle/maxAngle/homeAngle`
            );
        }

        if (this.minMicroseconds > this.maxMicroseconds) {
            const t = this.minMicroseconds;
            this.minMicroseconds = this.maxMicroseconds;
            this.maxMicroseconds = t;
        }

        this.homeMicroseconds = Servo._clampInt(this.homeMicroseconds, this.minMicroseconds, this.maxMicroseconds);

        const dbMin = config?.deadbandMicrosecondsMin ?? config?.deadbandMinUs;
        const dbMax = config?.deadbandMicrosecondsMax ?? config?.deadbandMaxUs;
        if (Number.isFinite(dbMin) && Number.isFinite(dbMax) && dbMin < dbMax) {
            this.deadbandMicrosecondsMin = Math.round(dbMin);
            this.deadbandMicrosecondsMax = Math.round(dbMax);
        } else {
            this.deadbandMicrosecondsMin = null;
            this.deadbandMicrosecondsMax = null;
        }

        this.microseconds = this.homeMicroseconds;
        this._deadbandHintEl = null;
        this._dbMinInput = null;
        this._dbMaxInput = null;
        this.gui = this.makeGui();
    }

    static _clampInt(v, lo, hi) {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return lo;
        return Math.min(hi, Math.max(lo, n));
    }

    /** Legacy linear map: same as old angleToMicroseconds (1000–2000 µs for 0–180 if min=0 max=180). */
    static _angleToUsLinear(angle, minAngle, maxAngle) {
        const span = maxAngle - minAngle;
        if (span <= 0) return 1500;
        const ratio = (Number(angle) - minAngle) / span;
        return Math.round(1000 + ratio * 1000);
    }

    /**
     * Crop (lo, hi) from the output range: map [min, deadbandCenter] → [min, lo] and (deadbandCenter, max] → (hi, max] linearly.
     * @param {number} us already clamped to [minMicroseconds, maxMicroseconds]
     */
    _applyDeadbandStretch(us) {
        if (this.deadbandMicrosecondsMin == null || this.deadbandMicrosecondsMax == null) return us;
        const lo = this.deadbandMicrosecondsMin;
        const hi = this.deadbandMicrosecondsMax;
        const deadbandCenter = (lo + hi) / 2;
        const min = this.minMicroseconds;
        const max = this.maxMicroseconds;
        if (deadbandCenter <= min || deadbandCenter >= max) return Servo._clampInt(us, min, max);
        if (us <= deadbandCenter) {
            us = min + ((lo - min) / (deadbandCenter - min)) * (us - min);
        } else {
            us = hi + ((max - hi) / (max - deadbandCenter)) * (us - deadbandCenter);
        }
        return Servo._clampInt(us, this.minMicroseconds, this.maxMicroseconds);
    }

    setMicroseconds(us) {
        let v = Servo._clampInt(us, this.minMicroseconds, this.maxMicroseconds);
        v = this._applyDeadbandStretch(v);
        this.microseconds = v;

        if (this._usSlider && Number(this._usSlider.value) !== v) {
            this._usSlider.value = String(v);
        }
        const label = `Pulse: ${v} µs`;
        if (this._usLabel && this._usLabel.textContent !== label) {
            this._usLabel.textContent = label;
        }
    }

    getMicroseconds() {
        return this.microseconds;
    }

    getHomeMicroseconds() {
        return this.homeMicroseconds;
    }

    getMinMicroseconds() {
        return this.minMicroseconds;
    }

    getMaxMicroseconds() {
        return this.maxMicroseconds;
    }

    setName(value) {
        const next = String(value ?? "").trim() || "servo";
        this.name = next;
        if (this._nameInput && this._nameInput.value !== next) this._nameInput.value = next;
        if (this._titleEl) this._titleEl.textContent = next;
    }

    setPin(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) {
            if (this._pinInput) this._pinInput.value = String(this.pin ?? "");
            return;
        }
        this.pin = n;
        if (this._pinInput && Number(this._pinInput.value) !== n) this._pinInput.value = String(n);
    }

    setHomeMicroseconds(value) {
        const n = Servo._clampInt(value, this.minMicroseconds, this.maxMicroseconds);
        this.homeMicroseconds = n;
        if (this._homeInput && Number(this._homeInput.value) !== n) this._homeInput.value = String(n);
    }

    setMinMicroseconds(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) {
            if (this._minInput) this._minInput.value = String(this.minMicroseconds);
            return;
        }
        this.minMicroseconds = n;
        if (this.minMicroseconds > this.maxMicroseconds) {
            const t = this.minMicroseconds;
            this.minMicroseconds = this.maxMicroseconds;
            this.maxMicroseconds = t;
        }
        this._syncRangeDependentUi();
    }

    setMaxMicroseconds(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) {
            if (this._maxInput) this._maxInput.value = String(this.maxMicroseconds);
            return;
        }
        this.maxMicroseconds = n;
        if (this.minMicroseconds > this.maxMicroseconds) {
            const t = this.minMicroseconds;
            this.minMicroseconds = this.maxMicroseconds;
            this.maxMicroseconds = t;
        }
        this._syncRangeDependentUi();
    }

    _syncRangeDependentUi() {
        if (this._minInput) this._minInput.value = String(this.minMicroseconds);
        if (this._maxInput) this._maxInput.value = String(this.maxMicroseconds);
        this.homeMicroseconds = Servo._clampInt(this.homeMicroseconds, this.minMicroseconds, this.maxMicroseconds);
        if (this._homeInput) {
            this._homeInput.min = String(this.minMicroseconds);
            this._homeInput.max = String(this.maxMicroseconds);
            this._homeInput.value = String(this.homeMicroseconds);
        }
        if (this._usSlider) {
            this._usSlider.min = String(this.minMicroseconds);
            this._usSlider.max = String(this.maxMicroseconds);
        }
        if (this._dbMinInput) {
            this._dbMinInput.min = String(this.minMicroseconds);
            this._dbMinInput.max = String(this.maxMicroseconds);
        }
        if (this._dbMaxInput) {
            this._dbMaxInput.min = String(this.minMicroseconds);
            this._dbMaxInput.max = String(this.maxMicroseconds);
        }
        this._readDeadbandFromInputs();
        this.setMicroseconds(this.microseconds);
    }

    _updateDeadbandHint() {
        if (!this._deadbandHintEl) return;
        if (
            this.deadbandMicrosecondsMin != null &&
            this.deadbandMicrosecondsMax != null &&
            this.deadbandMicrosecondsMin < this.deadbandMicrosecondsMax
        ) {
            this._deadbandHintEl.textContent = `Deadband ${this.deadbandMicrosecondsMin}–${this.deadbandMicrosecondsMax} µs (crop + stretch each side).`;
        } else {
            this._deadbandHintEl.textContent = "Deadband off — set min and max (µs, min < max) to enable.";
        }
    }

    _readDeadbandFromInputs() {
        const rawLo = this._dbMinInput?.value?.trim?.() ?? "";
        const rawHi = this._dbMaxInput?.value?.trim?.() ?? "";
        if (rawLo === "" || rawHi === "") {
            this.deadbandMicrosecondsMin = null;
            this.deadbandMicrosecondsMax = null;
            this._updateDeadbandHint();
            this.setMicroseconds(this.microseconds);
            return;
        }
        let lo = Math.round(Number(rawLo));
        let hi = Math.round(Number(rawHi));
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
            this.deadbandMicrosecondsMin = null;
            this.deadbandMicrosecondsMax = null;
            this._updateDeadbandHint();
            this.setMicroseconds(this.microseconds);
            return;
        }
        lo = Servo._clampInt(lo, this.minMicroseconds, this.maxMicroseconds);
        hi = Servo._clampInt(hi, this.minMicroseconds, this.maxMicroseconds);
        if (lo >= hi) {
            this.deadbandMicrosecondsMin = null;
            this.deadbandMicrosecondsMax = null;
            this._updateDeadbandHint();
            this.setMicroseconds(this.microseconds);
            return;
        }
        this.deadbandMicrosecondsMin = lo;
        this.deadbandMicrosecondsMax = hi;
        this._updateDeadbandHint();
        this.setMicroseconds(this.microseconds);
    }

    makeGui() {
        const gui = document.createElement("div");
        const dbMinVal = this.deadbandMicrosecondsMin != null ? String(this.deadbandMicrosecondsMin) : "";
        const dbMaxVal = this.deadbandMicrosecondsMax != null ? String(this.deadbandMicrosecondsMax) : "";
        const pinVal = this.pin != null && Number.isFinite(Number(this.pin)) ? String(this.pin) : "";
        gui.innerHTML = `
        <h3 class="servo-title">${this.name}</h3>
        <label class="servo-deadband-label">Name</label>
        <input type="text" class="servo-name" value="${this.name}">
        <label class="servo-deadband-label">Pin</label>
        <input type="number" class="servo-pin" step="1" value="${pinVal}">
        <label class="servo-deadband-label">Min (µs)</label>
        <input type="number" class="servo-min-us" step="1" value="${this.minMicroseconds}">
        <label class="servo-deadband-label">Max (µs)</label>
        <input type="number" class="servo-max-us" step="1" value="${this.maxMicroseconds}">
        <label class="servo-deadband-label">Home (µs)</label>
        <input type="number" class="servo-home-us" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" step="1" value="${this.homeMicroseconds}">
        <p class="muted servo-deadband-hint"></p>
        <label class="servo-deadband-label">Deadband min (µs)</label>
        <input type="number" class="servo-deadband-min" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" step="1" value="${dbMinVal}" placeholder="none">
        <label class="servo-deadband-label">Deadband max (µs)</label>
        <input type="number" class="servo-deadband-max" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" step="1" value="${dbMaxVal}" placeholder="none">
        <label class="servo-deadband-label">Pulse (µs)</label>
        <input type="range" class="servo-us-slider" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" value="${this.microseconds}" step="1">
        <p class="servo-us-display">Pulse: ${this.microseconds} µs</p>
        `;
        this._titleEl = gui.querySelector(".servo-title");
        this._nameInput = gui.querySelector(".servo-name");
        this._pinInput = gui.querySelector(".servo-pin");
        this._minInput = gui.querySelector(".servo-min-us");
        this._maxInput = gui.querySelector(".servo-max-us");
        this._homeInput = gui.querySelector(".servo-home-us");
        this._deadbandHintEl = gui.querySelector(".servo-deadband-hint");
        this._dbMinInput = gui.querySelector(".servo-deadband-min");
        this._dbMaxInput = gui.querySelector(".servo-deadband-max");
        this._usSlider = gui.querySelector(".servo-us-slider");
        this._usLabel = gui.querySelector(".servo-us-display");

        const onNameChange = () => this.setName(this._nameInput.value);
        this._nameInput.addEventListener("change", onNameChange);
        this._nameInput.addEventListener("blur", onNameChange);

        const onPinChange = () => this.setPin(this._pinInput.value);
        this._pinInput.addEventListener("change", onPinChange);
        this._pinInput.addEventListener("blur", onPinChange);

        const onMinChange = () => this.setMinMicroseconds(this._minInput.value);
        this._minInput.addEventListener("change", onMinChange);
        this._minInput.addEventListener("blur", onMinChange);

        const onMaxChange = () => this.setMaxMicroseconds(this._maxInput.value);
        this._maxInput.addEventListener("change", onMaxChange);
        this._maxInput.addEventListener("blur", onMaxChange);

        const onHomeChange = () => this.setHomeMicroseconds(this._homeInput.value);
        this._homeInput.addEventListener("change", onHomeChange);
        this._homeInput.addEventListener("blur", onHomeChange);

        const onDeadbandChange = () => this._readDeadbandFromInputs();
        this._dbMinInput.addEventListener("change", onDeadbandChange);
        this._dbMinInput.addEventListener("blur", onDeadbandChange);
        this._dbMaxInput.addEventListener("change", onDeadbandChange);
        this._dbMaxInput.addEventListener("blur", onDeadbandChange);

        this._usSlider.addEventListener("input", () => {
            this.setMicroseconds(Number(this._usSlider.value));
        });
        this._updateDeadbandHint();
        return gui;
    }
}
