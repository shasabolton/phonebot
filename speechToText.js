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
        if (!this._mic.isOn()) {
            const ok = await this._mic.start();
            if (!ok) throw new Error("Could not start microphone.");
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
        this._startVADMonitor();
    }

    _startVADMonitor() {
        if (this._monitorTimer) clearInterval(this._monitorTimer);
        this._monitorTimer = setInterval(() => {
            if (!this._isRecording || !this._mic) return;
            if (this._confirmationInProgress) return;
            const level = this._mic.getAudioLevel();
            const now = Date.now();
            if (level > 0.02) {
                this._lastSpeechAt = now;
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
        let transcript = this._latestRecordingTranscript.trim();
        if (transcript) this._logEvent("Transcription source: browser recognition");
        if (!transcript) this._logEvent("No browser transcript captured for this utterance.");

        if (!transcript) {
            this._setStatus(`No speech detected. Listening for "${this.wakePhrase}"`, "warn");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }

        const escapedWake = this.wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedConfirm = String(this.confirmationText || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const leadingNoiseRegex = new RegExp(
            `^(?:(?:${escapedWake}|${escapedConfirm})[\\s,;:.!?-]*)+`,
            "i"
        );
        const cleaned = transcript.replace(leadingNoiseRegex, "").trim();
        if (!cleaned) {
            this._setStatus(`Heard wake phrase only. Listening for "${this.wakePhrase}"`, "warn");
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
            transcript: cleaned,
            trigger: this.wakePhrase,
            silenceMs: this.silenceMs,
            sttEngine: this.sttEngine
        });
        this._logEvent(`Sending transcript: "${cleaned}"`);

        try {
            await agent.submitPrompt(cleaned);
            this._setStatus(`Sent. Listening for "${this.wakePhrase}"`, "ok");
            this._cooldownUntil = Date.now() + 1500;
        } catch (err) {
            this._setStatus(`Failed to send transcript: ${err?.message || "unknown"}`, "error");
            this._logEvent(`Send failed: ${err?.message || "unknown"}`);
        }
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

        controls.appendChild(toggleBtn);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(hint);
        wrap.appendChild(status);
        wrap.appendChild(eventLog);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._statusEl = status;
        this._eventLogEl = eventLog;
        this._outputEl = output;
    }

    destroy() {
        void this.setEnabled(false);
    }
}

window.SpeechToTextAiModel = SpeechToTextAiModel;
