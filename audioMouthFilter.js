/**
 * Processing module: amplitude envelope → mouth open amount (0…1).
 * Reads RMS from an audio source (default: audioPlayer), applies threshold + gain, caps at 1.
 */
class AudioMouthFilterAiModel {
    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "audioMouthFilter";
        this.name = config.name || "Audio mouth filter";
        this.input = String(config.input || "audioPlayer").trim();

        /** Threshold as fraction of max amplitude (0.5 = half full-scale). */
        this.threshold = this._clamp01(Number.isFinite(config.threshold) ? config.threshold : 0.05);
        /** Multiplier on (amplitude − threshold). */
        this.gain = Number.isFinite(config.gain) ? Math.max(0, config.gain) : 2;

        /** Raw RMS 0…1 before threshold/gain. */
        this.amplitude = 0;
        /** Filtered mouth value 0…1. */
        this.output = 0;

        this._raf = 0;
        this._running = false;

        this._levelFillEl = null;
        this._outputValueEl = null;
        this._ampValueEl = null;
        this._thresholdSlider = null;
        this._thresholdValueEl = null;
        this._gainSlider = null;
        this._gainValueEl = null;
        this._statusEl = null;
        this._inputSelect = null;
    }

    _clamp01(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(1, n));
    }

    _setStatus(text, isError = false) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.className = isError ? "error" : "muted";
    }

    _resolveSource() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        const byType = this.robot.getProcessingByType(this.input);
        if (byType) return byType;
        if (typeof this.robot.getProcessingByName === "function") {
            return this.robot.getProcessingByName(this.input);
        }
        return null;
    }

    _readAmplitude(source) {
        if (!source) return 0;
        if (typeof source.getAudioLevel === "function") {
            const level = source.getAudioLevel();
            return this._clamp01(level);
        }
        if (typeof source.ensurePlaybackTap === "function") {
            source.ensurePlaybackTap();
            if (typeof source.getAudioLevel === "function") {
                return this._clamp01(source.getAudioLevel());
            }
        }
        return 0;
    }

    _computeOutput(amplitude) {
        const excess = amplitude - this.threshold;
        if (excess <= 0) return 0;
        return this._clamp01(excess * this.gain);
    }

    _syncMeter() {
        if (this._levelFillEl) {
            this._levelFillEl.style.width = `${Math.round(this.output * 100)}%`;
        }
        if (this._outputValueEl) {
            this._outputValueEl.textContent = this.output.toFixed(3);
        }
        if (this._ampValueEl) {
            this._ampValueEl.textContent = this.amplitude.toFixed(3);
        }
    }

    _tick = () => {
        this._raf = 0;
        if (!this._running) return;

        const source = this._resolveSource();
        if (!source) {
            this.amplitude = 0;
            this.output = 0;
            this._syncMeter();
            this._setStatus(`Input "${this.input}" not found.`, true);
            this._raf = requestAnimationFrame(this._tick);
            return;
        }

        if (typeof source.ensurePlaybackTap === "function") {
            source.ensurePlaybackTap();
        }

        this.amplitude = this._readAmplitude(source);
        this.output = this._computeOutput(this.amplitude);
        this._syncMeter();
        this._setStatus(`Listening to ${source.name || this.input}.`);

        this._raf = requestAnimationFrame(this._tick);
    };

    start() {
        if (this._running) return;
        this._running = true;
        this._tick();
    }

    stop() {
        this._running = false;
        if (this._raf) {
            cancelAnimationFrame(this._raf);
            this._raf = 0;
        }
        this.amplitude = 0;
        this.output = 0;
        this._syncMeter();
    }

    setThreshold(value) {
        this.threshold = this._clamp01(value);
        if (this._thresholdSlider) this._thresholdSlider.value = String(this.threshold);
        if (this._thresholdValueEl) this._thresholdValueEl.textContent = this.threshold.toFixed(2);
    }

    setGain(value) {
        const n = Number(value);
        this.gain = Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : this.gain;
        if (this._gainSlider) this._gainSlider.value = String(this.gain);
        if (this._gainValueEl) this._gainValueEl.textContent = this.gain.toFixed(2);
    }

    setInput(name) {
        this.input = String(name || "audioPlayer").trim() || "audioPlayer";
        if (this._inputSelect) this._inputSelect.value = this.input;
    }

    buildGUI(container) {
        if (!container) return;

        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-audio-mouth-filter";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const inputLabel = document.createElement("label");
        inputLabel.textContent = "Input";
        const inputSelect = document.createElement("select");
        inputSelect.className = "audio-mouth-filter-input";
        for (const opt of [
            { value: "audioPlayer", label: "Audio player" }
            // TTS / other sources can be added here later
        ]) {
            const option = document.createElement("option");
            option.value = opt.value;
            option.textContent = opt.label;
            inputSelect.appendChild(option);
        }
        inputSelect.value = this.input === "audioPlayer" ? "audioPlayer" : this.input;
        if (![...inputSelect.options].some((o) => o.value === this.input)) {
            const custom = document.createElement("option");
            custom.value = this.input;
            custom.textContent = this.input;
            inputSelect.appendChild(custom);
            inputSelect.value = this.input;
        }
        inputSelect.addEventListener("change", () => this.setInput(inputSelect.value));
        inputLabel.appendChild(inputSelect);

        const meterLabel = document.createElement("p");
        meterLabel.className = "muted audio-mouth-filter-meter-label";
        meterLabel.innerHTML = 'Output <span class="audio-mouth-filter-output-value">0.000</span> (amp <span class="audio-mouth-filter-amp-value">0.000</span>)';

        const level = document.createElement("div");
        level.className = "audio-mouth-filter-level";
        const levelFill = document.createElement("div");
        levelFill.className = "audio-mouth-filter-level-fill";
        level.appendChild(levelFill);

        const thresholdLabel = document.createElement("label");
        thresholdLabel.className = "audio-mouth-filter-slider-label";
        thresholdLabel.innerHTML =
            'Threshold <span class="audio-mouth-filter-threshold-value">0.00</span> <span class="muted">(0.5 = half max amplitude)</span>';
        const thresholdSlider = document.createElement("input");
        thresholdSlider.type = "range";
        thresholdSlider.min = "0";
        thresholdSlider.max = "1";
        thresholdSlider.step = "0.01";
        thresholdSlider.value = String(this.threshold);
        thresholdSlider.addEventListener("input", () => this.setThreshold(Number(thresholdSlider.value)));

        const gainLabel = document.createElement("label");
        gainLabel.className = "audio-mouth-filter-slider-label";
        gainLabel.innerHTML =
            'Gain <span class="audio-mouth-filter-gain-value">0.00</span> <span class="muted">(× excess above threshold)</span>';
        const gainSlider = document.createElement("input");
        gainSlider.type = "range";
        gainSlider.min = "0";
        gainSlider.max = "10";
        gainSlider.step = "0.05";
        gainSlider.value = String(this.gain);
        gainSlider.addEventListener("input", () => this.setGain(Number(gainSlider.value)));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Starting…";

        wrap.appendChild(title);
        wrap.appendChild(inputLabel);
        wrap.appendChild(meterLabel);
        wrap.appendChild(level);
        wrap.appendChild(thresholdLabel);
        wrap.appendChild(thresholdSlider);
        wrap.appendChild(gainLabel);
        wrap.appendChild(gainSlider);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._levelFillEl = levelFill;
        this._outputValueEl = meterLabel.querySelector(".audio-mouth-filter-output-value");
        this._ampValueEl = meterLabel.querySelector(".audio-mouth-filter-amp-value");
        this._thresholdSlider = thresholdSlider;
        this._thresholdValueEl = thresholdLabel.querySelector(".audio-mouth-filter-threshold-value");
        this._gainSlider = gainSlider;
        this._gainValueEl = gainLabel.querySelector(".audio-mouth-filter-gain-value");
        this._statusEl = status;
        this._inputSelect = inputSelect;

        this.setThreshold(this.threshold);
        this.setGain(this.gain);
        this._syncMeter();
        this.start();
    }

    destroy() {
        this.stop();
    }
}

window.AudioMouthFilterAiModel = AudioMouthFilterAiModel;
