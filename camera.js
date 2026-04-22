class Camera extends Sensor {
    constructor(config) {
        super({ type: "camera", ...config });
        this.name = config?.name || "Camera";
        this._stream = null;
        this._videoEl = null;
        this._statusEl = null;
    }

    async start() {
        if (!this._videoEl || !navigator.mediaDevices?.getUserMedia) {
            if (this._statusEl) {
                this._statusEl.textContent = "Camera not supported in this browser.";
                this._statusEl.className = "error";
            }
            return;
        }
        if (this._stream) return;
        this._statusEl.textContent = "Starting camera…";
        this._statusEl.className = "muted";
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
            this._statusEl.textContent = "";
        } catch (err) {
            console.error("Camera error:", err);
            this._statusEl.textContent =
                err && err.name === "NotAllowedError"
                    ? "Camera permission denied."
                    : "Could not open camera.";
            this._statusEl.className = "error";
            this.stop();
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
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "sensor sensor-camera";
        const title = document.createElement("h4");
        title.textContent = this.name;
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.className = "sensor-camera-video";
        const status = document.createElement("p");
        status.className = "muted sensor-camera-status";
        wrap.appendChild(title);
        wrap.appendChild(video);
        wrap.appendChild(status);
        container.appendChild(wrap);
        this.gui = wrap;
        this._videoEl = video;
        this._statusEl = status;
        this.start();
    }

    destroy() {
        this.stop();
    }
}
