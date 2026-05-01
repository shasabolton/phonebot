class SpeechToTextAiModel {
    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "speechToText";
        this.name = config.name || "Speech to text";
        this.enabled = false;
        this.wakePhrase = String(config.trigger || "hey robot").trim().toLowerCase();
        this.confirmationText = String(config.confirmation || "Listening").trim();
        this.terminatorPhrase = this._extractTerminatorPhrase(config.terminator);
        this.silenceMs = this._extractSilenceMs(config.terminator, config.silenceMs);
        this.maxRecordMs = Number.isFinite(config.maxRecordMs) ? Math.max(3000, Math.round(config.maxRecordMs)) : 25000;
        this.sttEngine = "browser-webspeech";
        this._mic = null;
        this._isRecording = false;
        this._isWakeArmed = false;
        this._lastSpeechAt = 0;
        this._recordStartedAt = 0;
        this._cooldownUntil = 0;
        this._monitorTimer = null;
        this._recognition = null;
        this._latestRecordingTranscript = "";
        this._recordIgnoreUntil = 0;
        this._confirmationInProgress = false;
        this._toggleBtn = null;
        this._statusEl = null;
        this._outputEl = null;
        this._eventLogEl = null;
        this._playClipBtn = null;
        this._transcribeClipBtn = null;
        this._lastRecordingBlob = null;
        this._audioStream = null;
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._previewAudio = null;
        this._previewObjectUrl = null;
    }

    _extractTerminatorPhrase(raw) {
        const text = String(raw || "").trim();
        if (!text) return "";
        if (/not\s+talking/i.test(text)) return "";
        return text.toLowerCase();
    }

    _extractSilenceMs(terminator, override) {
        if (Number.isFinite(override)) return Math.max(400, Math.round(override));
        const text = String(terminator || "");
        const m = text.match(/(\d+)\s*ms/i);
        if (!m) return 1000;
        const parsed = Number(m[1]);
        return Number.isFinite(parsed) ? Math.max(400, Math.round(parsed)) : 1000;
    }

    _logEvent(text) {
        if (!this._eventLogEl) return;
        const now = new Date();
        const stamp = now.toLocaleTimeString();
        this._eventLogEl.textContent = `${stamp} ${text}\n${this._eventLogEl.textContent}`.slice(0, 6000);
    }

    _setStatus(text, tone = "muted") {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.className = `${tone}`;
    }

    _renderOutput(payload) {
        if (!this._outputEl) return;
        this._outputEl.textContent = JSON.stringify(payload, null, 2);
    }

    _getMicrophoneSensor() {
        return this.robot.sensors.find((s) => s && s.type === "microphone") || null;
    }

    _getSpeechRecognitionClass() {
        return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }

    _normalize(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    _containsTrigger(text) {
        const needle = this._normalize(this.wakePhrase);
        const hay = this._normalize(text);
        return !!needle && !!hay && hay.includes(needle);
    }

    _containsTerminator(text) {
        const needle = this._normalize(this.terminatorPhrase);
        const hay = this._normalize(text);
        if (!needle || !hay) return false;
        return hay.includes(needle);
    }

    async _speakListeningCueAndWait() {
        const text = String(this.confirmationText || "").trim();
        if (!text) return;
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") return;
        await new Promise((resolve) => {
            try {
                window.speechSynthesis.cancel();
                const utter = new SpeechSynthesisUtterance(text);
                utter.rate = 1.05;
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    resolve();
                };
                utter.onend = finish;
                utter.onerror = finish;
                // Safety timeout in case onend/onerror never fires on some browsers.
                const timeoutMs = Math.max(600, Math.round(text.length * 130));
                setTimeout(finish, timeoutMs);
                window.speechSynthesis.speak(utter);
            } catch (_) {
                resolve();
            }
        });
    }

    async _ensureMicReady() {
        this._mic = this._getMicrophoneSensor();
        if (!this._mic) {
            throw new Error("Microphone sensor not found.");
        }
        return this._mic;
    }

    _startWakeRecognition() {
        const RecognitionClass = this._getSpeechRecognitionClass();
        if (!RecognitionClass) {
            this._setStatus("Browser speech recognition unavailable.", "warn");
            this._logEvent("Speech recognition unavailable.");
            return;
        }
        if (this._recognition) {
            try {
                this._recognition.stop();
            } catch (_) {}
            this._recognition = null;
        }

        const rec = new RecognitionClass();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onresult = async (evt) => {
            const now = Date.now();
            if (!this.enabled || now < this._cooldownUntil) return;
            let transcript = "";
            for (let i = evt.resultIndex; i < evt.results.length; i++) {
                const alt = evt.results[i]?.[0]?.transcript;
                if (alt) transcript += ` ${alt}`;
            }
            const clean = transcript.trim();
            if (!clean) return;

            if (this._isRecording) {
                if (Date.now() < this._recordIgnoreUntil) return;
                this._latestRecordingTranscript = clean;
                this._lastSpeechAt = now;
                if (this._containsTerminator(clean)) {
                    this._logEvent("Terminator phrase detected.");
                    this._stopRecording("terminator_phrase");
                }
                return;
            }

            if (this._containsTrigger(clean)) {
                this._logEvent(`Wake phrase detected: "${this.wakePhrase}"`);
                await this._onWakeTriggered();
            }
        };

        rec.onerror = (evt) => {
            this._logEvent(`Speech recognition error: ${evt?.error || "unknown"}`);
        };

        rec.onend = () => {
            if (!this.enabled) return;
            setTimeout(() => {
                if (!this.enabled || this._isRecording) return;
                try {
                    rec.start();
                } catch (_) {}
            }, 300);
        };

        this._recognition = rec;
        this._isWakeArmed = true;
        try {
            rec.start();
            this._setStatus(`Listening for "${this.wakePhrase}"`, "ok");
            this._logEvent("Wake listening active.");
        } catch (err) {
            this._setStatus(`Failed to start speech recognition: ${err?.message || "unknown"}`, "error");
        }
    }

    async _onWakeTriggered() {
        if (this._isRecording) return;
        await this._startRecording();
        this._confirmationInProgress = true;
        this._recordIgnoreUntil = Number.POSITIVE_INFINITY;
        this._setStatus(`Confirmation: "${this.confirmationText}"`, "muted");
        await this._speakListeningCueAndWait();
        this._confirmationInProgress = false;
        this._recordIgnoreUntil = Date.now() + 350;
        this._lastSpeechAt = Date.now();
        this._setStatus("Recording...", "ok");
        this._logEvent("Confirmation finished; speech capture active.");
    }

    async _startRecording() {
        await this._ensureMicReady();
        this._latestRecordingTranscript = "";
        this._lastSpeechAt = Date.now();
        this._recordStartedAt = Date.now();
        this._recordIgnoreUntil = 0;
        this._isRecording = true;
        this._setStatus("Recording...", "ok");
        this._logEvent("Recording started.");
        await this._beginMediaRecorder();
        this._startVADMonitor();
    }

    _pickMediaRecorderMime() {
        if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
        for (const c of candidates) {
            if (MediaRecorder.isTypeSupported(c)) return c;
        }
        return "";
    }

    async _beginMediaRecorder() {
        if (typeof MediaRecorder === "undefined") {
            this._logEvent("MediaRecorder unavailable; no audio clip will be stored.");
            return;
        }
        this._abortMediaRecorderSync();
        this._recordChunks = [];
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            this._audioStream = stream;
            const mime = this._pickMediaRecorderMime();
            const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            mr.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) this._recordChunks.push(e.data);
            };
            mr.onerror = (e) => {
                this._logEvent(`MediaRecorder error: ${e?.error || "unknown"}`);
            };
            mr.start(200);
            this._mediaRecorder = mr;
            this._logEvent("Parallel audio clip capture started (MediaRecorder).");
        } catch (err) {
            this._logEvent(`Audio clip capture failed: ${err?.message || err}`);
            this._abortMediaRecorderSync();
        }
    }

    _stopAudioStreamTracks() {
        if (!this._audioStream) return;
        for (const t of this._audioStream.getTracks()) {
            try {
                t.stop();
            } catch (_) {}
        }
        this._audioStream = null;
    }

    /**
     * @param {boolean} collectBlob - if true, resolve Blob from onstop; if false, discard chunks
     * @returns {Promise<Blob|null>}
     */
    async _flushMediaRecorder(collectBlob = true) {
        const mr = this._mediaRecorder;
        if (mr && mr.state !== "inactive") {
            return new Promise((resolve) => {
                const chunks = this._recordChunks;
                const done = () => {
                    this._mediaRecorder = null;
                    this._recordChunks = [];
                    this._stopAudioStreamTracks();
                };
                mr.onstop = () => {
                    if (!collectBlob) {
                        done();
                        resolve(null);
                        return;
                    }
                    const type = mr.mimeType || "audio/webm";
                    const blob = chunks.length ? new Blob(chunks, { type }) : null;
                    done();
                    resolve(blob && blob.size > 0 ? blob : null);
                };
                try {
                    if (typeof mr.requestData === "function") {
                        try {
                            mr.requestData();
                        } catch (_) {}
                    }
                    mr.stop();
                } catch (_) {
                    done();
                    resolve(null);
                }
            });
        }
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._stopAudioStreamTracks();
        return null;
    }

    _abortMediaRecorderSync() {
        const mr = this._mediaRecorder;
        if (mr && mr.state !== "inactive") {
            try {
                mr.onstop = null;
                if (typeof mr.requestData === "function") {
                    try {
                        mr.requestData();
                    } catch (_) {}
                }
                mr.stop();
            } catch (_) {}
        }
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._stopAudioStreamTracks();
    }

    _setLastRecordingBlob(blob) {
        if (!blob || blob.size < 1) return;
        this._lastRecordingBlob = blob;
        this._logEvent(`Stored last clip (${Math.round(blob.size / 1024)} KB, ${blob.type || "audio"}).`);
        this._updateClipButtons();
    }

    _updateClipButtons() {
        const has = !!(this._lastRecordingBlob && this._lastRecordingBlob.size > 0);
        if (this._playClipBtn) this._playClipBtn.disabled = !has;
        if (this._transcribeClipBtn) this._transcribeClipBtn.disabled = !has;
    }

    _disposePreviewPlayback() {
        try {
            if (this._previewAudio) {
                this._previewAudio.pause();
                this._previewAudio.src = "";
            }
        } catch (_) {}
        if (this._previewObjectUrl) {
            try {
                URL.revokeObjectURL(this._previewObjectUrl);
            } catch (_) {}
            this._previewObjectUrl = null;
        }
    }

    _playLastRecording() {
        if (!this._lastRecordingBlob || this._lastRecordingBlob.size < 1) {
            this._setStatus("No saved clip to play.", "warn");
            return;
        }
        this._disposePreviewPlayback();
        this._previewObjectUrl = URL.createObjectURL(this._lastRecordingBlob);
        this._previewAudio = this._previewAudio || new Audio();
        this._previewAudio.src = this._previewObjectUrl;
        this._previewAudio.play().catch((err) => {
            this._logEvent(`Playback failed: ${err?.message || err}`);
            this._setStatus("Could not play clip (see log).", "warn");
        });
        this._logEvent("Playing last saved clip.");
    }

    _cleanUtteranceForAgent(transcript) {
        const t = String(transcript || "").trim();
        if (!t) return "";
        const escapedWake = this.wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedConfirm = String(this.confirmationText || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const leadingNoiseRegex = new RegExp(
            `^(?:(?:${escapedWake}|${escapedConfirm})[\\s,;:.!?-]*)+`,
            "i"
        );
        return t.replace(leadingNoiseRegex, "").trim();
    }

    async _sendCleanedToChatbot(cleaned) {
        const text = String(cleaned || "").trim();
        if (!text) {
            this._setStatus("Nothing to send after cleaning.", "warn");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }
        const agent = this.robot.agentInterface;
        if (!agent || typeof agent.submitPrompt !== "function") {
            this._setStatus("Agent interface unavailable; cannot send transcript.", "error");
            this._logEvent("Cannot send transcript: agent interface missing.");
            return;
        }
        this._setStatus("Sending transcript to chat…", "muted");
        this._renderOutput({
            state: "sending",
            transcript: text,
            trigger: this.wakePhrase,
            silenceMs: this.silenceMs,
            sttEngine: this.sttEngine
        });
        this._logEvent(`Sending transcript: "${text}"`);
        try {
            await agent.submitPrompt(text);
            this._setStatus(`Sent. Listening for "${this.wakePhrase}"`, "ok");
            this._cooldownUntil = Date.now() + 1500;
        } catch (err) {
            this._setStatus(`Failed to send transcript: ${err?.message || "unknown"}`, "error");
            this._logEvent(`Send failed: ${err?.message || "unknown"}`);
        }
    }

    async transcribeLastClipAndSend() {
        if (!this._lastRecordingBlob || this._lastRecordingBlob.size < 1) {
            this._setStatus("No saved clip to transcribe.", "warn");
            return;
        }
        const agent = this.robot.agentInterface;
        if (!agent || typeof agent.transcribeAudioBlob !== "function") {
            this._setStatus("Agent interface has no transcribe support.", "error");
            return;
        }
        this._setStatus("Transcribing clip…", "muted");
        this._logEvent("Transcribing last clip via API…");
        try {
            const raw = await agent.transcribeAudioBlob(this._lastRecordingBlob);
            this._logEvent(`API transcript: "${raw.slice(0, 200)}${raw.length > 200 ? "…" : ""}"`);
            const cleaned = this._cleanUtteranceForAgent(raw);
            if (!cleaned) {
                this._setStatus("Transcription empty after cleaning wake/confirm noise.", "warn");
                this._cooldownUntil = Date.now() + 1000;
                return;
            }
            await this._sendCleanedToChatbot(cleaned);
        } catch (err) {
            this._setStatus(`Transcription failed: ${err?.message || "unknown"}`, "error");
            this._logEvent(`Transcription failed: ${err?.message || "unknown"}`);
        } finally {
            this._updateClipButtons();
        }
    }

    _startVADMonitor() {
        if (this._monitorTimer) clearInterval(this._monitorTimer);
        this._monitorTimer = setInterval(() => {
            if (!this._isRecording || !this._mic) return;
            if (this._confirmationInProgress) return;
            const now = Date.now();
            if (this._mic.isOn() && typeof this._mic.getAudioLevel === "function") {
                const level = this._mic.getAudioLevel();
                if (level > 0.02) {
                    this._lastSpeechAt = now;
                }
            }
            if (now - this._lastSpeechAt > this.silenceMs) {
                this._logEvent(`Silence timeout reached (${this.silenceMs}ms).`);
                this._stopRecording("silence_timeout");
                return;
            }
            if (now - this._recordStartedAt > this.maxRecordMs) {
                this._logEvent(`Max recording reached (${this.maxRecordMs}ms).`);
                this._stopRecording("max_duration");
            }
        }, 100);
    }

    _stopRecording(reason) {
        if (!this._isRecording) return;
        this._isRecording = false;
        if (this._monitorTimer) {
            clearInterval(this._monitorTimer);
            this._monitorTimer = null;
        }
        this._setStatus("Processing speech…", "muted");
        this._logEvent(`Recording stopped: ${reason}`);
        void this._finalizeRecording();
    }

    async _finalizeRecording() {
        const transcriptSnapshot = String(this._latestRecordingTranscript || "").trim();
        const blob = await this._flushMediaRecorder(true);
        if (blob) this._setLastRecordingBlob(blob);

        if (transcriptSnapshot) this._logEvent("Transcription source: browser recognition");
        if (!transcriptSnapshot) this._logEvent("No browser transcript captured for this utterance.");

        if (!transcriptSnapshot) {
            if (blob && blob.size > 0) {
                this._setStatus(
                    `No on-device transcript; saved ${Math.round(blob.size / 1024)} KB clip — use Transcribe clip (API key).`,
                    "warn"
                );
            } else {
                this._setStatus(`No speech detected. Listening for "${this.wakePhrase}"`, "warn");
            }
            this._cooldownUntil = Date.now() + 1000;
            return;
        }

        const cleaned = this._cleanUtteranceForAgent(transcriptSnapshot);
        if (!cleaned) {
            this._setStatus(`Heard wake phrase only. Listening for "${this.wakePhrase}"`, "warn");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }
        await this._sendCleanedToChatbot(cleaned);
    }

    async setEnabled(nextEnabled) {
        this.enabled = !!nextEnabled;
        if (this._toggleBtn) this._toggleBtn.textContent = this.enabled ? "On" : "Off";
        if (this.enabled) {
            try {
                await this._ensureMicReady();
                this._startWakeRecognition();
                this._renderOutput({
                    state: "armed",
                    wakePhrase: this.wakePhrase,
                    terminatorPhrase: this.terminatorPhrase || null,
                    silenceMs: this.silenceMs,
                    sttEngine: this.sttEngine
                });
            } catch (err) {
                this.enabled = false;
                if (this._toggleBtn) this._toggleBtn.textContent = "Off";
                this._setStatus(`Failed to start: ${err?.message || "unknown"}`, "error");
                this._logEvent(`Start failed: ${err?.message || "unknown"}`);
            }
        } else {
            if (this._monitorTimer) {
                clearInterval(this._monitorTimer);
                this._monitorTimer = null;
            }
            this._isRecording = false;
            this._abortMediaRecorderSync();
            if (this._recognition) {
                try {
                    this._recognition.stop();
                } catch (_) {}
                this._recognition = null;
            }
            this._setStatus("Speech model off.", "muted");
            this._renderOutput({ state: "off" });
            this._logEvent("Speech model disabled.");
        }
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-speech";
        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", async () => {
            toggleBtn.disabled = true;
            await this.setEnabled(!this.enabled);
            toggleBtn.disabled = false;
        });

        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = `Wake: "${this.wakePhrase}". Silence stop: ${this.silenceMs}ms. STT: ${this.sttEngine}`;

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Speech model off.";

        const eventLog = document.createElement("div");
        eventLog.className = "speech-event-log";
        eventLog.textContent = "";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        const clipRow = document.createElement("div");
        clipRow.className = "ai-model-speech-clip-controls";
        const playClipBtn = document.createElement("button");
        playClipBtn.type = "button";
        playClipBtn.textContent = "Play last clip";
        playClipBtn.disabled = true;
        playClipBtn.addEventListener("click", () => this._playLastRecording());
        const transcribeClipBtn = document.createElement("button");
        transcribeClipBtn.type = "button";
        transcribeClipBtn.textContent = "Transcribe clip & send";
        transcribeClipBtn.disabled = true;
        transcribeClipBtn.addEventListener("click", async () => {
            transcribeClipBtn.disabled = true;
            await this.transcribeLastClipAndSend();
            transcribeClipBtn.disabled = false;
        });
        clipRow.appendChild(playClipBtn);
        clipRow.appendChild(transcribeClipBtn);

        controls.appendChild(toggleBtn);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(clipRow);
        wrap.appendChild(hint);
        wrap.appendChild(status);
        wrap.appendChild(eventLog);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._statusEl = status;
        this._eventLogEl = eventLog;
        this._outputEl = output;
        this._playClipBtn = playClipBtn;
        this._transcribeClipBtn = transcribeClipBtn;
        this._updateClipButtons();
    }

    destroy() {
        this._disposePreviewPlayback();
        void this.setEnabled(false);
    }
}

window.SpeechToTextAiModel = SpeechToTextAiModel;
