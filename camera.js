class Camera extends Sensor {
    constructor(config) {
        super({ type: "camera", ...config });
        this.name = config?.name || "Camera";
        /** @type {"user" | "environment"} user = front, environment = back */
        this._facingMode = "user";
        this._stream = null;
        this._videoEl = null;
        this._frameEl = null;
        this._statusEl = null;
        this._startBtn = null;
        this._frontBtn = null;
        this._backBtn = null;
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
        wrap.appendChild(status);
        wrap.appendChild(startBtn);
        container.appendChild(wrap);
        this.gui = wrap;
        this._videoEl = video;
        this._frameEl = frame;
        this._statusEl = status;
        this._startBtn = startBtn;

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
        this.stop();
    }
}
