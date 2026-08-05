class Camera extends Sensor {
    constructor(config) {
        super({ type: "camera", ...config });
        /** Parent robot; set at runtime by Robot.buildSensors for flow-box UI. */
        this.robot = config?.robot || null;
        this.name = config?.name || "Camera";
        /** @type {"user" | "environment"} user = front, environment = back */
        this._facingMode = "user";
        /** Selfie-style preview mirror when front-facing (see {@link #isMirrored}). */
        this.mirror = !!config?.mirror;
        this._stream = null;
        this._videoEl = null;
        this._frameEl = null;
        this._statusEl = null;
        this._startBtn = null;
        this._frontBtn = null;
        this._backBtn = null;
        /** @type {(() => void) | null} */
        this._onVideoLayout = null;
        /** @type {ResizeObserver | null} */
        this._frameResizeObs = null;
    }

    /**
     * Size the frame to the camera stream aspect so the video element is not letterboxed inside the box:
     * the painted picture fills the frame (same framing as canvas drawImage / model JPEG). Fits within the
     * sensor column width and 70vh.
     */
    _layoutVideoFrameToStreamAspect() {
        const v = this._videoEl;
        const frame = this._frameEl;
        if (!v || !frame) return;
        const vw = v.videoWidth | 0;
        const vh = v.videoHeight | 0;
        if (!vw || !vh) {
            frame.style.width = "";
            frame.style.height = "";
            return;
        }
        const wrap = this.gui;
        const maxW = Math.max(1, (wrap?.clientWidth || frame.parentElement?.clientWidth || 400) | 0);
        const vhCap = window.visualViewport?.height || window.innerHeight;
        const maxH = Math.max(1, Math.floor(vhCap * 0.7));
        const scale = Math.min(maxW / vw, maxH / vh);
        const dispW = Math.max(1, Math.floor(vw * scale));
        const dispH = Math.max(1, Math.floor(vh * scale));
        frame.style.width = `${dispW}px`;
        frame.style.height = `${dispH}px`;
    }

    _syncFaceButtons() {
        const isFront = this._facingMode === "user";
        if (this._frontBtn) {
            this._frontBtn.classList.toggle("active", isFront);
            this._frontBtn.setAttribute("aria-pressed", isFront ? "true" : "false");
        }
        if (this._backBtn) {
            this._backBtn.classList.toggle("active", !isFront);
            this._backBtn.setAttribute("aria-pressed", !isFront ? "true" : "false");
        }
        this._syncMirrorClass();
    }

    /** True when the preview is horizontally mirrored (front + mirror config). */
    isMirrored() {
        return !!(this.mirror && this._facingMode === "user");
    }

    _syncMirrorClass() {
        if (!this._frameEl) return;
        this._frameEl.classList.toggle("sensor-camera-frame--mirrored", this.isMirrored());
    }

    /**
     * @param {"user" | "environment"} facing
     */
    async setFacing(facing) {
        if (facing !== "user" && facing !== "environment") return;
        this._facingMode = facing;
        this._syncFaceButtons();
        if (this._stream) {
            this.stop();
            return this.start();
        }
        return true;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async start() {
        if (!this._videoEl || !navigator.mediaDevices?.getUserMedia) {
            if (this._statusEl) {
                this._statusEl.textContent = "Camera not supported in this browser.";
                this._statusEl.className = "error";
            }
            return false;
        }
        if (this._stream) return true;
        if (this._statusEl) {
            this._statusEl.textContent = "Starting camera…";
            this._statusEl.className = "muted";
        }
        const facing = this._facingMode === "environment" ? "environment" : "user";
        try {
            try {
                this._stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: facing } },
                    audio: false
                });
            } catch (_) {
                this._stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });
            }
            this._videoEl.srcObject = this._stream;
            await this._videoEl.play().catch(() => {});
            this._layoutVideoFrameToStreamAspect();
            if (this._statusEl) {
                this._statusEl.textContent = "";
                this._statusEl.className = "muted sensor-camera-status";
            }
            if (this._startBtn) this._startBtn.style.display = "none";
            return true;
        } catch (err) {
            console.error("Camera error:", err);
            if (this._statusEl) {
                if (err && err.name === "NotAllowedError") {
                    this._statusEl.textContent =
                        "Camera blocked or not allowed. Tap “Start camera” after allowing permission, or check site settings.";
                } else {
                    let msg = "Could not open camera. Tap “Start camera” to try again.";
                    if (!window.isSecureContext) {
                        msg += " Chrome on Android usually needs HTTPS (except localhost).";
                    }
                    this._statusEl.textContent = msg;
                }
                this._statusEl.className = "error";
            }
            this.stop();
            return false;
        }
    }

    stop() {
        if (this._stream) {
            for (const track of this._stream.getTracks()) {
                track.stop();
            }
            this._stream = null;
        }
        if (this._videoEl) {
            this._videoEl.srcObject = null;
        }
        if (this._frameEl) {
            this._frameEl.style.width = "";
            this._frameEl.style.height = "";
        }
        if (this._startBtn) this._startBtn.style.display = "";
    }

    getVideoElement() {
        return this._videoEl;
    }

    getFrameElement() {
        return this._frameEl;
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor sensor-camera";
        const title = document.createElement("h4");
        title.textContent = this.name;

        const faceRow = document.createElement("div");
        faceRow.className = "sensor-camera-face-row";
        const frontBtn = document.createElement("button");
        frontBtn.type = "button";
        frontBtn.className = "sensor-camera-face-btn";
        frontBtn.textContent = "Front";
        frontBtn.setAttribute("aria-pressed", "true");
        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.className = "sensor-camera-face-btn";
        backBtn.textContent = "Back";
        backBtn.setAttribute("aria-pressed", "false");
        frontBtn.addEventListener("click", async () => {
            if (this._facingMode === "user") return;
            frontBtn.disabled = true;
            backBtn.disabled = true;
            await this.setFacing("user");
            frontBtn.disabled = false;
            backBtn.disabled = false;
        });
        backBtn.addEventListener("click", async () => {
            if (this._facingMode === "environment") return;
            frontBtn.disabled = true;
            backBtn.disabled = true;
            await this.setFacing("environment");
            frontBtn.disabled = false;
            backBtn.disabled = false;
        });
        faceRow.appendChild(frontBtn);
        faceRow.appendChild(backBtn);
        this._frontBtn = frontBtn;
        this._backBtn = backBtn;
        this._syncFaceButtons();

        const frame = document.createElement("div");
        frame.className = "sensor-camera-frame";
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.playsInline = true;
        video.className = "sensor-camera-video";
        frame.appendChild(video);

        const flowRow = document.createElement("div");
        flowRow.className = "sensor-camera-flow-actions";
        flowRow.style.marginTop = "8px";
        const deleteFlowBtn = document.createElement("button");
        deleteFlowBtn.type = "button";
        deleteFlowBtn.textContent = "Delete flow box";
        deleteFlowBtn.title = "Remove the tap- or agent-placed optical-flow tracking box";
        deleteFlowBtn.addEventListener("click", () => {
            const r = this.robot;
            const cv =
                (r && typeof r.getProcessingByType === "function" && r.getProcessingByType("computervision")) ||
                (r && Array.isArray(r.processing) && r.processing.find((m) => String(m?.type || "").toLowerCase() === "computervision")) ||
                null;
            if (cv && typeof cv.clearManualFlowTracks === "function") {
                cv.clearManualFlowTracks();
            }
        });
        flowRow.appendChild(deleteFlowBtn);

        const flowBoxSizeWrap = document.createElement("div");
        flowBoxSizeWrap.className = "sensor-camera-flow-box-size";
        const flowBoxSizeLabel = document.createElement("label");
        flowBoxSizeLabel.className = "sensor-camera-flow-box-size-label";
        flowBoxSizeLabel.style.display = "block";
        const flowBoxSizeText = document.createElement("span");
        flowBoxSizeText.textContent = "Flow box width (% of frame)";
        const flowBoxSizeSelect = document.createElement("select");
        flowBoxSizeSelect.setAttribute("aria-label", "Flow box width as percent of camera frame width");
        const Vision = typeof window !== "undefined" ? window.ComputerVisionAiModel : null;
        const pctOptions = Vision?.FLOW_TOUCH_BOX_WIDTH_PCT_OPTIONS || [10, 15, 20, 25, 30];
        for (const p of pctOptions) {
            const opt = document.createElement("option");
            opt.value = String(p);
            opt.textContent = `${p}%`;
            flowBoxSizeSelect.appendChild(opt);
        }
        const r0 = this.robot;
        const cv0 =
            (r0 && typeof r0.getProcessingByType === "function" && r0.getProcessingByType("computervision")) ||
            (r0 &&
                Array.isArray(r0.processing) &&
                r0.processing.find((m) => String(m?.type || "").toLowerCase() === "computervision")) ||
            null;
        if (cv0 && typeof cv0.getFlowTouchBoxWidthPercent === "function") {
            flowBoxSizeSelect.value = String(cv0.getFlowTouchBoxWidthPercent());
        } else {
            flowBoxSizeSelect.value = "10";
        }
        if (!cv0 || typeof cv0.setFlowTouchBoxWidthPercent !== "function") {
            flowBoxSizeSelect.disabled = true;
            flowBoxSizeSelect.title = "Computer vision model is required to change flow box size.";
        }
        flowBoxSizeSelect.addEventListener("change", () => {
            const r = this.robot;
            const cv =
                (r && typeof r.getProcessingByType === "function" && r.getProcessingByType("computervision")) ||
                (r &&
                    Array.isArray(r.processing) &&
                    r.processing.find((m) => String(m?.type || "").toLowerCase() === "computervision")) ||
                null;
            if (cv && typeof cv.setFlowTouchBoxWidthPercent === "function") {
                cv.setFlowTouchBoxWidthPercent(Number(flowBoxSizeSelect.value));
            }
        });
        flowBoxSizeLabel.appendChild(flowBoxSizeText);
        flowBoxSizeLabel.appendChild(flowBoxSizeSelect);
        flowBoxSizeWrap.appendChild(flowBoxSizeLabel);
        flowRow.appendChild(flowBoxSizeWrap);

        const status = document.createElement("p");
        status.className = "muted sensor-camera-status";
        const startBtn = document.createElement("button");
        startBtn.type = "button";
        startBtn.className = "sensor-camera-start-btn";
        startBtn.textContent = "Start camera";
        startBtn.addEventListener("click", async () => {
            startBtn.disabled = true;
            frontBtn.disabled = true;
            backBtn.disabled = true;
            const ok = await this.start();
            startBtn.disabled = false;
            frontBtn.disabled = false;
            backBtn.disabled = false;
            if (!ok && this._startBtn) this._startBtn.style.display = "";
        });
        wrap.appendChild(title);
        wrap.appendChild(faceRow);
        wrap.appendChild(frame);
        wrap.appendChild(flowRow);
        wrap.appendChild(status);
        wrap.appendChild(startBtn);
        container.appendChild(wrap);
        this.gui = wrap;
        this._videoEl = video;
        this._frameEl = frame;
        this._statusEl = status;
        this._startBtn = startBtn;
        this._syncMirrorClass();

        this._onVideoLayout = () => this._layoutVideoFrameToStreamAspect();
        video.addEventListener("loadedmetadata", this._onVideoLayout);
        window.addEventListener("resize", this._onVideoLayout);
        if (typeof ResizeObserver !== "undefined") {
            this._frameResizeObs = new ResizeObserver(() => this._layoutVideoFrameToStreamAspect());
            this._frameResizeObs.observe(wrap);
        }

        this.start().then((ok) => {
            if (!ok && this._startBtn) {
                if (this._statusEl && !this._statusEl.textContent) {
                    this._statusEl.textContent = "Tap “Start camera” to use the camera on this device.";
                    this._statusEl.className = "muted";
                }
            }
        });
    }

    destroy() {
        if (this._onVideoLayout) {
            window.removeEventListener("resize", this._onVideoLayout);
            if (this._videoEl) {
                this._videoEl.removeEventListener("loadedmetadata", this._onVideoLayout);
            }
            this._onVideoLayout = null;
        }
        if (this._frameResizeObs) {
            this._frameResizeObs.disconnect();
            this._frameResizeObs = null;
        }
        this.stop();
    }
}
