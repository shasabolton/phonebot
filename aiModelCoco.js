class CocoAiModel {
    static _tfLoadPromise = null;
    static _modelLoadPromise = null;
    static _modelInstance = null;

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "coco";
        this.name = config.name || "COCO Vision";
        this.enabled = false;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 1;
        this.frequencyHz = Math.max(0.2, Math.min(10, this.frequencyHz));
        this._timer = null;
        this._running = false;
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._detections = [];
        this._toggleBtn = null;
        this._freqInput = null;
        this._statusEl = null;
        this._outputEl = null;
    }

    static async _loadTfJs() {
        if (window.tf) return;
        if (!this._tfLoadPromise) {
            this._tfLoadPromise = this._loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
        }
        return this._tfLoadPromise;
    }

    static async _loadModel() {
        if (this._modelInstance) return this._modelInstance;
        await this._loadTfJs();
        if (!this._modelLoadPromise) {
            this._modelLoadPromise = (async () => {
                if (!window.cocoSsd) {
                    await this._loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
                }
                this._modelInstance = await window.cocoSsd.load();
                return this._modelInstance;
            })();
        }
        return this._modelLoadPromise;
    }

    static _loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.querySelectorAll("script")).find((s) => s.src === src);
            if (existing) {
                if (existing.dataset.loaded === "true") {
                    resolve();
                    return;
                }
                existing.addEventListener("load", () => resolve(), { once: true });
                existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
                return;
            }
            const script = document.createElement("script");
            script.src = src;
            script.async = true;
            script.addEventListener("load", () => {
                script.dataset.loaded = "true";
                resolve();
            }, { once: true });
            script.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            document.head.appendChild(script);
        });
    }

    _getCameraSensor() {
        return this.robot.sensors.find((sensor) => sensor && sensor.type === "camera");
    }

    _ensureOverlay() {
        if (this._overlayCanvas) return true;
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return false;
        const canvas = document.createElement("canvas");
        canvas.className = "sensor-camera-overlay";
        frameEl.appendChild(canvas);
        this._overlayCanvas = canvas;
        this._overlayCtx = canvas.getContext("2d");
        return true;
    }

    _resizeOverlayToVideo(videoEl) {
        if (!this._overlayCanvas) return;
        const w = videoEl.clientWidth || videoEl.videoWidth || 0;
        const h = videoEl.clientHeight || videoEl.videoHeight || 0;
        if (!w || !h) return;
        if (this._overlayCanvas.width !== w) this._overlayCanvas.width = w;
        if (this._overlayCanvas.height !== h) this._overlayCanvas.height = h;
    }

    _clearOverlay() {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._overlayCtx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
    }

    _drawDetections(videoEl, detections) {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._resizeOverlayToVideo(videoEl);
        this._clearOverlay();
        const ctx = this._overlayCtx;
        const widthScale = (videoEl.clientWidth || videoEl.videoWidth) / videoEl.videoWidth;
        const heightScale = (videoEl.clientHeight || videoEl.videoHeight) / videoEl.videoHeight;
        ctx.lineWidth = 2;
        ctx.font = "12px Arial";
        ctx.textBaseline = "top";

        detections.forEach((item) => {
            const [x, y, w, h] = item.bbox;
            const bx = x * widthScale;
            const by = y * heightScale;
            const bw = w * widthScale;
            const bh = h * heightScale;
            const label = `${item.class} ${(item.score * 100).toFixed(0)}%`;

            ctx.strokeStyle = "#00ff66";
            ctx.strokeRect(bx, by, bw, bh);
            const labelW = ctx.measureText(label).width + 8;
            const labelH = 16;
            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(bx, Math.max(0, by - labelH), labelW, labelH);
            ctx.fillStyle = "#00ff66";
            ctx.fillText(label, bx + 4, Math.max(0, by - labelH + 2));
        });
    }

    _renderResponseOutput() {
        if (!this._outputEl) return;
        const response = {
            model: this.type,
            detectedAt: new Date().toISOString(),
            objectCount: this._detections.length,
            objects: this._detections.map((item) => ({
                name: item.class,
                score: Number(item.score.toFixed(3)),
                bbox: {
                    x: Number(item.bbox[0].toFixed(1)),
                    y: Number(item.bbox[1].toFixed(1)),
                    width: Number(item.bbox[2].toFixed(1)),
                    height: Number(item.bbox[3].toFixed(1))
                }
            }))
        };
        this._outputEl.textContent = JSON.stringify(response, null, 2);
    }

    async _tick() {
        if (this._running || !this.enabled) return;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight || videoEl.readyState < 2) {
            if (this._statusEl) this._statusEl.textContent = "Waiting for camera stream...";
            return;
        }
        this._running = true;
        try {
            const model = await CocoAiModel._loadModel();
            this._ensureOverlay();
            const detections = await model.detect(videoEl);
            this._detections = Array.isArray(detections) ? detections : [];
            this._drawDetections(videoEl, this._detections);
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = `Running: ${this._detections.length} object(s)`;
                this._statusEl.className = "muted";
            }
        } catch (err) {
            console.error("COCO detection error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = `COCO error: ${err?.message || "unknown error"}`;
                this._statusEl.className = "error";
            }
        } finally {
            this._running = false;
        }
    }

    _startLoop() {
        this._stopLoop();
        const intervalMs = Math.max(100, Math.round(1000 / this.frequencyHz));
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }

    _stopLoop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async setEnabled(nextEnabled) {
        this.enabled = !!nextEnabled;
        if (this._toggleBtn) this._toggleBtn.textContent = this.enabled ? "On" : "Off";
        if (this.enabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Loading COCO model...";
                this._statusEl.className = "muted";
            }
            try {
                await CocoAiModel._loadModel();
                this._startLoop();
            } catch (err) {
                this.enabled = false;
                if (this._toggleBtn) this._toggleBtn.textContent = "Off";
                if (this._statusEl) {
                    this._statusEl.textContent = `Failed to load model: ${err?.message || "unknown error"}`;
                    this._statusEl.className = "error";
                }
            }
        } else {
            this._stopLoop();
            this._detections = [];
            this._clearOverlay();
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = "Model off.";
                this._statusEl.className = "muted";
            }
        }
    }

    setFrequencyHz(nextHz) {
        const parsed = Number(nextHz);
        if (!Number.isFinite(parsed)) return;
        this.frequencyHz = Math.max(0.2, Math.min(10, parsed));
        if (this._freqInput) this._freqInput.value = String(this.frequencyHz);
        if (this.enabled) this._startLoop();
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-coco";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "ai-model-toggle-btn";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", async () => {
            toggleBtn.disabled = true;
            await this.setEnabled(!this.enabled);
            toggleBtn.disabled = false;
        });

        const freqLabel = document.createElement("label");
        freqLabel.textContent = "Vision frequency (Hz)";
        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = "0.2";
        freqInput.max = "10";
        freqInput.step = "0.2";
        freqInput.value = String(this.frequencyHz);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));
        freqInput.addEventListener("blur", () => this.setFrequencyHz(freqInput.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(freqLabel);
        controls.appendChild(freqInput);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._freqInput = freqInput;
        this._statusEl = status;
        this._outputEl = output;
    }

    destroy() {
        this._stopLoop();
        this._clearOverlay();
        if (this._overlayCanvas && this._overlayCanvas.parentNode) {
            this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
        }
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._detections = [];
    }
}

window.CocoAiModel = CocoAiModel;
