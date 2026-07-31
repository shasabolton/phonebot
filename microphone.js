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
        this._recordWanted = false;
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._recordedBlob = null;
        this._recordedUrl = null;
        this._playbackAudio = null;
        this._recordBtn = null;
        this._playBtn = null;
        this._downloadBtn = null;
    }

    _wantsMic() {
        return this._holdWanted || this._recordWanted;
    }

    async start() {
        if (this._stream) {
            if (this._levelWrapEl) this._levelWrapEl.classList.remove("sensor-microphone-level--off");
            this._startLevelLoop();
            return true;
        }
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
            if (this._audioContext.state === "suspended") {
                await this._audioContext.resume().catch(() => {});
            }
            this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
            this._analyserNode = this._audioContext.createAnalyser();
            this._analyserNode.fftSize = 1024;
            this._sourceNode.connect(this._analyserNode);
            this._levelData = new Uint8Array(this._analyserNode.fftSize);
            this._startLevelLoop();
            if (!this._wantsMic()) {
                this.stop();
                return false;
            }
            this._updateIdleOrActiveStatus();
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
        if (this._recordWanted) return;
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
                this._setStatus(this._idleStatusText(), false);
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

    getRecordedBlob() {
        return this._recordedBlob;
    }

    _idleStatusText() {
        if (this._recordedBlob) return "Recording ready. Play or download, or record again to overwrite.";
        return "Microphone idle. Hold the button to test level.";
    }

    _updateIdleOrActiveStatus() {
        if (this._recordWanted) {
            this._setStatus("Recording… Press Record again to stop.", false, true);
            return;
        }
        if (this._holdWanted) {
            this._setStatus("Level meter active (release button to stop).", false, true);
            return;
        }
        this._setStatus(this._idleStatusText(), false);
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

    _pickRecorderMimeType() {
        if (typeof MediaRecorder === "undefined") return "";
        for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
            if (MediaRecorder.isTypeSupported(t)) return t;
        }
        return "";
    }

    _extensionForMime(mime) {
        const m = String(mime || "").toLowerCase();
        if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
        if (m.includes("ogg")) return "ogg";
        if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
        return "webm";
    }

    _clearRecordedAudio() {
        this._stopPlayback();
        if (this._recordedUrl) {
            try {
                URL.revokeObjectURL(this._recordedUrl);
            } catch (_) {}
            this._recordedUrl = null;
        }
        this._recordedBlob = null;
        this._recordChunks = [];
        this._updatePlaybackButtons();
    }

    _stopPlayback() {
        if (!this._playbackAudio) return;
        try {
            this._playbackAudio.pause();
            this._playbackAudio.removeAttribute("src");
            this._playbackAudio.load();
        } catch (_) {}
        this._playbackAudio = null;
        if (this._playBtn && !this._recordWanted) {
            this._playBtn.textContent = "Play";
        }
    }

    _updatePlaybackButtons() {
        const has = !!this._recordedBlob;
        const recording = this._recordWanted;
        if (this._playBtn) {
            this._playBtn.disabled = !has || recording;
            if (!recording) this._playBtn.textContent = "Play";
        }
        if (this._downloadBtn) this._downloadBtn.disabled = !has || recording;
        if (this._recordBtn) {
            this._recordBtn.textContent = recording ? "Stop recording" : "Record";
            this._recordBtn.classList.toggle("active", recording);
        }
    }

    async _toggleRecord() {
        if (this._recordWanted) {
            await this._stopRecording();
            return;
        }
        await this._startRecording();
    }

    async _startRecording() {
        if (typeof MediaRecorder === "undefined") {
            this._setStatus("Recording not supported in this browser.", true);
            return;
        }
        this._clearRecordedAudio();
        this._recordWanted = true;
        this._updatePlaybackButtons();
        const ok = await this.start();
        if (!ok || !this._stream) {
            this._recordWanted = false;
            this._updatePlaybackButtons();
            this._setStatus("Could not start recording. Check microphone permission.", true);
            return;
        }

        const mimeType = this._pickRecorderMimeType();
        try {
            this._mediaRecorder = mimeType
                ? new MediaRecorder(this._stream, { mimeType })
                : new MediaRecorder(this._stream);
        } catch (err) {
            console.error("MediaRecorder start failed:", err);
            this._recordWanted = false;
            this._mediaRecorder = null;
            this._updatePlaybackButtons();
            if (!this._holdWanted) this.stop();
            this._setStatus("Could not start MediaRecorder.", true);
            return;
        }

        this._recordChunks = [];
        this._mediaRecorder.addEventListener("dataavailable", (e) => {
            if (e.data && e.data.size > 0) this._recordChunks.push(e.data);
        });
        try {
            this._mediaRecorder.start(250);
        } catch (err) {
            console.error("MediaRecorder.start failed:", err);
            this._recordWanted = false;
            this._mediaRecorder = null;
            this._updatePlaybackButtons();
            if (!this._holdWanted) this.stop();
            this._setStatus("Could not start recording.", true);
            return;
        }
        this._updateIdleOrActiveStatus();
        this._updatePlaybackButtons();
    }

    _stopRecording() {
        return new Promise((resolve) => {
            const mr = this._mediaRecorder;
            this._mediaRecorder = null;
            this._recordWanted = false;

            const finish = () => {
                const chunks = this._recordChunks;
                this._recordChunks = [];
                const type = (mr && mr.mimeType) || this._pickRecorderMimeType() || "audio/webm";
                this._recordedBlob = chunks.length ? new Blob(chunks, { type }) : null;
                if (this._recordedBlob) {
                    this._recordedUrl = URL.createObjectURL(this._recordedBlob);
                }
                this._updatePlaybackButtons();
                if (!this._holdWanted) {
                    this.stop();
                } else {
                    this._updateIdleOrActiveStatus();
                }
                if (this._recordedBlob) {
                    this._setStatus("Recording saved. Play or download, or record again to overwrite.", false, true);
                } else {
                    this._setStatus("Recording was empty.", true);
                }
                resolve();
            };

            if (!mr) {
                finish();
                return;
            }
            if (mr.state === "inactive") {
                finish();
                return;
            }
            mr.addEventListener("stop", finish, { once: true });
            try {
                mr.stop();
            } catch (_) {
                finish();
            }
        });
    }

    _playRecording() {
        if (!this._recordedBlob || this._recordWanted) return;
        if (this._playbackAudio && !this._playbackAudio.paused) {
            this._stopPlayback();
            this._setStatus("Playback stopped.", false);
            return;
        }
        this._stopPlayback();
        if (!this._recordedUrl) {
            this._recordedUrl = URL.createObjectURL(this._recordedBlob);
        }
        const audio = new Audio(this._recordedUrl);
        this._playbackAudio = audio;
        if (this._playBtn) this._playBtn.textContent = "Stop";
        audio.addEventListener(
            "ended",
            () => {
                if (this._playbackAudio === audio) {
                    this._playbackAudio = null;
                    if (this._playBtn && !this._recordWanted) this._playBtn.textContent = "Play";
                    this._setStatus("Playback finished.", false, true);
                }
            },
            { once: true }
        );
        audio.addEventListener(
            "error",
            () => {
                this._setStatus("Could not play recording.", true);
                this._stopPlayback();
            },
            { once: true }
        );
        void audio.play().then(
            () => this._setStatus("Playing recording…", false, true),
            (err) => {
                console.error("Playback failed:", err);
                this._setStatus("Could not play recording.", true);
                this._stopPlayback();
            }
        );
    }

    _downloadRecording() {
        if (!this._recordedBlob || this._recordWanted) return;
        if (!this._recordedUrl) {
            this._recordedUrl = URL.createObjectURL(this._recordedBlob);
        }
        const ext = this._extensionForMime(this._recordedBlob.type);
        const a = document.createElement("a");
        a.href = this._recordedUrl;
        a.download = `microphone-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        this._setStatus("Download started.", false, true);
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

        const controls = document.createElement("div");
        controls.className = "sensor-microphone-controls";

        const recordBtn = document.createElement("button");
        recordBtn.type = "button";
        recordBtn.className = "sensor-microphone-record-btn";
        recordBtn.textContent = "Record";

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "sensor-microphone-play-btn";
        playBtn.textContent = "Play";
        playBtn.disabled = true;

        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "sensor-microphone-download-btn";
        downloadBtn.textContent = "Download";
        downloadBtn.disabled = true;

        const endHold = (ev) => {
            if (ev?.pointerId != null && holdBtn.hasPointerCapture(ev.pointerId)) {
                try {
                    holdBtn.releasePointerCapture(ev.pointerId);
                } catch (_) {}
            }
            this._holdWanted = false;
            if (this._recordWanted) {
                this._updateIdleOrActiveStatus();
                return;
            }
            this.stop();
        };

        holdBtn.addEventListener("pointerdown", async (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            this._holdWanted = true;
            try {
                holdBtn.setPointerCapture(e.pointerId);
            } catch (_) {}
            await this.start();
            if (!this._wantsMic()) this.stop();
            else this._updateIdleOrActiveStatus();
        });
        holdBtn.addEventListener("pointerup", endHold);
        holdBtn.addEventListener("pointercancel", endHold);
        holdBtn.addEventListener("lostpointercapture", () => {
            this._holdWanted = false;
            if (this._recordWanted) {
                this._updateIdleOrActiveStatus();
                return;
            }
            this.stop();
        });

        recordBtn.addEventListener("click", () => {
            void this._toggleRecord();
        });
        playBtn.addEventListener("click", () => this._playRecording());
        downloadBtn.addEventListener("click", () => this._downloadRecording());

        controls.appendChild(recordBtn);
        controls.appendChild(playBtn);
        controls.appendChild(downloadBtn);

        wrap.appendChild(title);
        wrap.appendChild(level);
        wrap.appendChild(status);
        wrap.appendChild(holdBtn);
        wrap.appendChild(controls);
        container.appendChild(wrap);

        this.gui = wrap;
        this._levelWrapEl = level;
        this._levelFillEl = levelFill;
        this._statusEl = status;
        this._holdBtn = holdBtn;
        this._recordBtn = recordBtn;
        this._playBtn = playBtn;
        this._downloadBtn = downloadBtn;
    }

    destroy() {
        if (this._recordWanted) {
            this._recordWanted = false;
            if (this._mediaRecorder && this._mediaRecorder.state !== "inactive") {
                try {
                    this._mediaRecorder.stop();
                } catch (_) {}
            }
            this._mediaRecorder = null;
        }
        this._clearRecordedAudio();
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
