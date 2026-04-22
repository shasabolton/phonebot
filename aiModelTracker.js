class GenericTrackerAiModel {
    static _cvLoadPromise = null;

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "tracker";
        this.name = config.name || "Generic Object Tracker";
        this.enabled = false;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 10;
        this.frequencyHz = Math.max(1, Math.min(30, this.frequencyHz));
        this._timer = null;
        this._busy = false;
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._toggleBtn = null;
        this._freqInput = null;
        this._statusEl = null;
        this._outputEl = null;
        this._tracks = [];
        this._nextTrackId = 1;
        this._captureCanvas = null;
        this._captureCtx = null;
    }

    static _loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.querySelectorAll("script")).find((s) => s.src === src);
            if (existing) {
                if (window.cv && window.cv.Mat) {
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
            script.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            document.head.appendChild(script);
            const timeoutMs = 20000;
            const started = Date.now();
            const waitForCv = () => {
                if (window.cv && window.cv.Mat) {
                    resolve();
                    return;
                }
                if (Date.now() - started > timeoutMs) {
                    reject(new Error("Timed out waiting for OpenCV runtime initialization."));
                    return;
                }
                setTimeout(waitForCv, 50);
            };
            waitForCv();
        });
    }

    static async _loadOpenCv() {
        if (window.cv && window.cv.Mat) return;
        if (!this._cvLoadPromise) {
            this._cvLoadPromise = this._loadScript("https://docs.opencv.org/4.10.0/opencv.js");
        }
        return this._cvLoadPromise;
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

    _getFrameMat(videoEl) {
        const cv = window.cv;
        const frameW = videoEl.videoWidth | 0;
        const frameH = videoEl.videoHeight | 0;
        if (!frameW || !frameH) return null;

        if (!this._captureCanvas) {
            this._captureCanvas = document.createElement("canvas");
        }
        if (!this._captureCtx) {
            this._captureCtx = this._captureCanvas.getContext("2d", { willReadFrequently: true });
        }
        if (!this._captureCtx) return null;

        if (this._captureCanvas.width !== frameW) this._captureCanvas.width = frameW;
        if (this._captureCanvas.height !== frameH) this._captureCanvas.height = frameH;

        this._captureCtx.drawImage(videoEl, 0, 0, frameW, frameH);
        const imageData = this._captureCtx.getImageData(0, 0, frameW, frameH);
        return cv.matFromImageData(imageData);
    }

    _detectBoundingBoxes(videoEl) {
        const cv = window.cv;
        const src = this._getFrameMat(videoEl);
        if (!src) return [];
        const gray = new cv.Mat();
        const blur = new cv.Mat();
        const edges = new cv.Mat();
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        let kernel = null;

        try {
            if (src.empty() || src.rows <= 0 || src.cols <= 0) {
                return [];
            }

            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
            cv.Canny(blur, edges, 60, 160);

            kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
            cv.dilate(edges, edges, kernel);
            cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

            cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            const boxes = [];
            const frameArea = src.cols * src.rows;
            const minArea = frameArea * 0.002;
            const maxArea = frameArea * 0.8;
            for (let i = 0; i < contours.size(); i++) {
                const contour = contours.get(i);
                const rect = cv.boundingRect(contour);
                contour.delete();
                const area = rect.width * rect.height;
                if (area < minArea || area > maxArea) continue;
                if (rect.width < 20 || rect.height < 20) continue;
                boxes.push({
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    area
                });
            }

            boxes.sort((a, b) => b.area - a.area);
            return boxes.slice(0, 12);
        } finally {
            if (kernel) kernel.delete();
            src.delete();
            gray.delete();
            blur.delete();
            edges.delete();
            contours.delete();
            hierarchy.delete();
        }
    }

    _iou(a, b) {
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width, b.x + b.width);
        const y2 = Math.min(a.y + a.height, b.y + b.height);
        const w = Math.max(0, x2 - x1);
        const h = Math.max(0, y2 - y1);
        const intersection = w * h;
        if (!intersection) return 0;
        const union = a.width * a.height + b.width * b.height - intersection;
        return union > 0 ? intersection / union : 0;
    }

    _updateTracks(boxes) {
        const unmatchedTracks = new Set(this._tracks.map((t) => t.id));
        const nextTracks = [];

        for (const box of boxes) {
            let bestTrack = null;
            let bestIou = 0;
            for (const track of this._tracks) {
                if (!unmatchedTracks.has(track.id)) continue;
                const iou = this._iou(track.bbox, box);
                if (iou > bestIou) {
                    bestIou = iou;
                    bestTrack = track;
                }
            }

            if (bestTrack && bestIou >= 0.25) {
                unmatchedTracks.delete(bestTrack.id);
                nextTracks.push({
                    id: bestTrack.id,
                    bbox: box,
                    age: bestTrack.age + 1,
                    missing: 0
                });
            } else {
                nextTracks.push({
                    id: this._nextTrackId++,
                    bbox: box,
                    age: 1,
                    missing: 0
                });
            }
        }

        for (const oldTrack of this._tracks) {
            if (!unmatchedTracks.has(oldTrack.id)) continue;
            if (oldTrack.missing < 5) {
                nextTracks.push({
                    ...oldTrack,
                    missing: oldTrack.missing + 1
                });
            }
        }

        this._tracks = nextTracks
            .filter((t) => t.missing <= 5)
            .sort((a, b) => (b.bbox.area || 0) - (a.bbox.area || 0))
            .slice(0, 12);
    }

    _drawTracks(videoEl) {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._resizeOverlayToVideo(videoEl);
        this._clearOverlay();

        const ctx = this._overlayCtx;
        const widthScale = (videoEl.clientWidth || videoEl.videoWidth) / videoEl.videoWidth;
        const heightScale = (videoEl.clientHeight || videoEl.videoHeight) / videoEl.videoHeight;
        ctx.lineWidth = 2;
        ctx.font = "12px Arial";
        ctx.textBaseline = "top";

        this._tracks.forEach((track) => {
            if (track.missing > 0) return;
            const { x, y, width, height } = track.bbox;
            const bx = x * widthScale;
            const by = y * heightScale;
            const bw = width * widthScale;
            const bh = height * heightScale;
            const label = `obj-${track.id}`;

            ctx.strokeStyle = "#00a2ff";
            ctx.strokeRect(bx, by, bw, bh);
            const labelW = ctx.measureText(label).width + 8;
            const labelH = 16;
            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(bx, Math.max(0, by - labelH), labelW, labelH);
            ctx.fillStyle = "#00a2ff";
            ctx.fillText(label, bx + 4, Math.max(0, by - labelH + 2));
        });
    }

    _renderOutput() {
        if (!this._outputEl) return;
        const response = {
            model: this.type,
            trackedAt: new Date().toISOString(),
            objectCount: this._tracks.filter((t) => t.missing === 0).length,
            objects: this._tracks
                .filter((t) => t.missing === 0)
                .map((t) => ({
                    id: `obj-${t.id}`,
                    bbox: {
                        x: Math.round(t.bbox.x),
                        y: Math.round(t.bbox.y),
                        width: Math.round(t.bbox.width),
                        height: Math.round(t.bbox.height)
                    },
                    ageFrames: t.age
                }))
        };
        this._outputEl.textContent = JSON.stringify(response, null, 2);
    }

    async _tick() {
        if (this._busy || !this.enabled) return;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight || videoEl.readyState < 2) {
            if (this._statusEl) this._statusEl.textContent = "Waiting for camera stream...";
            return;
        }

        this._busy = true;
        try {
            await GenericTrackerAiModel._loadOpenCv();
            this._ensureOverlay();
            const boxes = this._detectBoundingBoxes(videoEl);
            this._updateTracks(boxes);
            this._drawTracks(videoEl);
            this._renderOutput();
            if (this._statusEl) {
                const count = this._tracks.filter((t) => t.missing === 0).length;
                this._statusEl.textContent = `Tracking ${count} object(s) at ${this.frequencyHz} Hz`;
                this._statusEl.className = "muted";
            }
        } catch (err) {
            console.error("Tracker error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = `Tracker error: ${err?.message || "unknown error"}`;
                this._statusEl.className = "error";
            }
        } finally {
            this._busy = false;
        }
    }

    _startLoop() {
        this._stopLoop();
        const intervalMs = Math.max(33, Math.round(1000 / this.frequencyHz));
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
                this._statusEl.textContent = "Loading tracker runtime...";
                this._statusEl.className = "muted";
            }
            try {
                await GenericTrackerAiModel._loadOpenCv();
                this._startLoop();
            } catch (err) {
                this.enabled = false;
                if (this._toggleBtn) this._toggleBtn.textContent = "Off";
                if (this._statusEl) {
                    this._statusEl.textContent = `Failed to load tracker: ${err?.message || "unknown error"}`;
                    this._statusEl.className = "error";
                }
            }
        } else {
            this._stopLoop();
            this._tracks = [];
            this._clearOverlay();
            this._renderOutput();
            if (this._statusEl) {
                this._statusEl.textContent = "Model off.";
                this._statusEl.className = "muted";
            }
        }
    }

    setFrequencyHz(nextHz) {
        const parsed = Number(nextHz);
        if (!Number.isFinite(parsed)) return;
        this.frequencyHz = Math.max(1, Math.min(30, parsed));
        if (this._freqInput) this._freqInput.value = String(this.frequencyHz);
        if (this.enabled) this._startLoop();
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-tracker";

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
        freqLabel.textContent = "Tracking frequency (Hz)";

        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = "1";
        freqInput.max = "30";
        freqInput.step = "1";
        freqInput.value = String(this.frequencyHz);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));
        freqInput.addEventListener("blur", () => this.setFrequencyHz(freqInput.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const note = document.createElement("p");
        note.className = "muted";
        note.textContent = "Generic contour tracker: tracks object positions without class labels.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(freqLabel);
        controls.appendChild(freqInput);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        wrap.appendChild(note);
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
        this._captureCanvas = null;
        this._captureCtx = null;
        this._tracks = [];
    }
}

window.GenericTrackerAiModel = GenericTrackerAiModel;
