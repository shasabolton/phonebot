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
        gui.innerHTML = `
        <h3>${this.name}</h3>
        <p>Pin: ${this.pin}</p>
        <p>Home: ${this.homeMicroseconds} µs</p>
        <p>Range: ${this.minMicroseconds} – ${this.maxMicroseconds} µs</p>
        <p class="muted servo-deadband-hint"></p>
        <label class="servo-deadband-label">Deadband min (µs)</label>
        <input type="number" class="servo-deadband-min" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" step="1" value="${dbMinVal}" placeholder="none">
        <label class="servo-deadband-label">Deadband max (µs)</label>
        <input type="number" class="servo-deadband-max" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" step="1" value="${dbMaxVal}" placeholder="none">
        <input type="range" min="${this.minMicroseconds}" max="${this.maxMicroseconds}" value="${this.microseconds}" step="1">
        <p class="servo-us-display">Pulse: ${this.microseconds} µs</p>
        `;
        this._deadbandHintEl = gui.querySelector(".servo-deadband-hint");
        this._dbMinInput = gui.querySelector(".servo-deadband-min");
        this._dbMaxInput = gui.querySelector(".servo-deadband-max");
        this._usSlider = gui.querySelector('input[type="range"]');
        this._usLabel = gui.querySelector(".servo-us-display");
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
