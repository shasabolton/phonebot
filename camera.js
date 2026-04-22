class Camera extends Sensor {
    constructor(config) {
        super({ type: "camera", ...config });
        this.name = config?.name || "Camera";
        this._stream = null;
        this._videoEl = null;
        this._statusEl = null;
        this._startBtn = null;
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
        try {
            try {
                this._stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: "environment" } },
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

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor sensor-camera";
        const title = document.createElement("h4");
        title.textContent = this.name;
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.playsInline = true;
        video.className = "sensor-camera-video";
        const status = document.createElement("p");
        status.className = "muted sensor-camera-status";
        const startBtn = document.createElement("button");
        startBtn.type = "button";
        startBtn.className = "sensor-camera-start-btn";
        startBtn.textContent = "Start camera";
        startBtn.addEventListener("click", async () => {
            startBtn.disabled = true;
            const ok = await this.start();
            startBtn.disabled = false;
            if (!ok && this._startBtn) this._startBtn.style.display = "";
        });
        wrap.appendChild(title);
        wrap.appendChild(video);
        wrap.appendChild(status);
        wrap.appendChild(startBtn);
        container.appendChild(wrap);
        this.gui = wrap;
        this._videoEl = video;
        this._statusEl = status;
        this._startBtn = startBtn;

        // Mobile Chrome usually requires getUserMedia inside a tap; try silent start for desktop, then fall back to button.
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
