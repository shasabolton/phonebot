class Microphone extends Sensor {
    constructor(config = {}) {
        super({ type: "microphone", ...config });
        this.name = config?.name || "Microphone";
        this._stream = null;
        this._audioContext = null;
        this._sourceNode = null;
        this._analyserNode = null;
        this._levelData = null;
        this._levelTimer = null;
        this._statusEl = null;
        this._levelWrapEl = null;
        this._levelFillEl = null;
        this._holdBtn = null;
        this._holdWanted = false;
    }

    async start() {
        if (this._stream) return true;
        if (!navigator.mediaDevices?.getUserMedia) {
            this._setStatus("Microphone not supported in this browser.", true);
            return false;
        }
        this._setStatus("Starting microphone…", false);
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            this._audioContext = this._audioContext || new (window.AudioContext || window.webkitAudioContext)();
            this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
            this._analyserNode = this._audioContext.createAnalyser();
            this._analyserNode.fftSize = 1024;
            this._sourceNode.connect(this._analyserNode);
            this._levelData = new Uint8Array(this._analyserNode.fftSize);
            this._startLevelLoop();
            if (!this._holdWanted) {
                this.stop();
                return false;
            }
            this._setStatus("Level meter active (release button to stop).", false, true);
            if (this._levelWrapEl) this._levelWrapEl.classList.remove("sensor-microphone-level--off");
            return true;
        } catch (err) {
            console.error("Microphone start failed:", err);
            this._setStatus("Could not open microphone. Check browser permission.", true);
            this.stop();
            return false;
        }
    }

    stop() {
        if (this._levelTimer) {
            clearInterval(this._levelTimer);
            this._levelTimer = null;
        }
        if (this._sourceNode) {
            try {
                this._sourceNode.disconnect();
            } catch (_) {}
            this._sourceNode = null;
        }
        if (this._analyserNode) {
            try {
                this._analyserNode.disconnect();
            } catch (_) {}
            this._analyserNode = null;
        }
        if (this._stream) {
            for (const track of this._stream.getTracks()) {
                track.stop();
            }
            this._stream = null;
        }
        if (this._levelFillEl) this._levelFillEl.style.width = "0%";
        if (this._levelWrapEl) this._levelWrapEl.classList.add("sensor-microphone-level--off");
        if (!this._holdWanted && this._statusEl) {
            const isErr = this._statusEl.classList.contains("error");
            if (!isErr) {
                this._setStatus("Microphone idle. Hold the button to test level.", false);
            }
        }
    }

    isOn() {
        return !!this._stream;
    }

    getStream() {
        return this._stream;
    }

    getAnalyserNode() {
        return this._analyserNode;
    }

    getAudioLevel() {
        if (!this._analyserNode || !this._levelData) return 0;
        this._analyserNode.getByteTimeDomainData(this._levelData);
        let sumSquares = 0;
        for (let i = 0; i < this._levelData.length; i++) {
            const norm = (this._levelData[i] - 128) / 128;
            sumSquares += norm * norm;
        }
        return Math.sqrt(sumSquares / this._levelData.length);
    }

    _startLevelLoop() {
        if (this._levelTimer) clearInterval(this._levelTimer);
        this._levelTimer = setInterval(() => {
            const level = this.getAudioLevel();
            if (this._levelFillEl) {
                const percent = Math.max(0, Math.min(100, Math.round(level * 350)));
                this._levelFillEl.style.width = `${percent}%`;
            }
        }, 100);
    }

    _setStatus(text, isError = false, isOk = false) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.className = isError ? "error sensor-microphone-status" : isOk ? "ok sensor-microphone-status" : "muted sensor-microphone-status";
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor sensor-microphone";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const level = document.createElement("div");
        level.className = "sensor-microphone-level";
        const levelFill = document.createElement("div");
        levelFill.className = "sensor-microphone-level-fill";
        level.appendChild(levelFill);

        const status = document.createElement("p");
        status.className = "muted sensor-microphone-status";
        status.textContent = "Microphone idle. Hold the button to test level.";

        level.classList.add("sensor-microphone-level--off");

        const holdBtn = document.createElement("button");
        holdBtn.type = "button";
        holdBtn.className = "sensor-microphone-hold-btn";
        holdBtn.textContent = "Test mic level (hold)";

        const endHold = (ev) => {
            if (ev?.pointerId != null && holdBtn.hasPointerCapture(ev.pointerId)) {
                try {
                    holdBtn.releasePointerCapture(ev.pointerId);
                } catch (_) {}
            }
            this._holdWanted = false;
            this.stop();
        };

        holdBtn.addEventListener("pointerdown", async (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            this._holdWanted = true;
            try {
                holdBtn.setPointerCapture(e.pointerId);
            } catch (_) {}
            await this.start();
            if (!this._holdWanted) this.stop();
        });
        holdBtn.addEventListener("pointerup", endHold);
        holdBtn.addEventListener("pointercancel", endHold);
        holdBtn.addEventListener("lostpointercapture", () => {
            this._holdWanted = false;
            this.stop();
        });

        wrap.appendChild(title);
        wrap.appendChild(level);
        wrap.appendChild(status);
        wrap.appendChild(holdBtn);
        container.appendChild(wrap);

        this.gui = wrap;
        this._levelWrapEl = level;
        this._levelFillEl = levelFill;
        this._statusEl = status;
        this._holdBtn = holdBtn;
    }

    destroy() {
        this.stop();
        if (this._audioContext) {
            try {
                this._audioContext.close();
            } catch (_) {}
            this._audioContext = null;
        }
    }
}

window.Microphone = Microphone;
