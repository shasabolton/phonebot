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
        this._lastInterimSpeechLogAt = 0;
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
        this._eventLogEl.textContent = `${stamp} ${text}\n${this._eventLogEl.textContent}`.slice(0, 12000);
    }

    _speechResultsDebug(evt) {
        const parts = [];
        const n = evt?.results?.length ?? 0;
        const start = Number.isFinite(evt?.resultIndex) ? evt.resultIndex : 0;
        for (let i = start; i < n; i++) {
            const r = evt.results[i];
            const alt = r && r[0];
            const raw = alt ? String(alt.transcript || "") : "";
            const t = raw.trim();
            const slice = t.length > 100 ? `${t.slice(0, 100)}…` : t;
            const conf = alt && typeof alt.confidence === "number" ? alt.confidence.toFixed(3) : "—";
            parts.push(`#${i} final=${!!r?.isFinal} conf=${conf} "${slice}"`);
        }
        return parts.length ? parts.join(" | ") : "(no segments)";
    }

    _eventHasFinalSpeechResult(evt) {
        const n = evt?.results?.length ?? 0;
        const start = Number.isFinite(evt?.resultIndex) ? evt.resultIndex : 0;
        for (let i = start; i < n; i++) {
            if (evt.results[i]?.isFinal) return true;
        }
        return false;
    }

    _maybeLogRecognitionResult(evt, extra = "") {
        const now = Date.now();
        const hasFinal = this._eventHasFinalSpeechResult(evt);
        if (!hasFinal && now - this._lastInterimSpeechLogAt < 450) return;
        this._lastInterimSpeechLogAt = now;
        const suffix = extra ? ` ${extra}` : "";
        this._logEvent(`onresult ${this._speechResultsDebug(evt)}${suffix}`);
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

        rec.onstart = () => {
            this._logEvent("onstart");
        };

        rec.onaudiostart = () => {
            this._logEvent("onaudiostart");
        };

        rec.onaudioend = () => {
            this._logEvent("onaudioend");
        };

        rec.onspeechstart = () => {
            this._logEvent("onspeechstart");
        };

        rec.onspeechend = () => {
            this._logEvent("onspeechend");
        };

        rec.onnomatch = () => {
            this._logEvent("onnomatch (no final match)");
        };

        rec.onresult = async (evt) => {
            const now = Date.now();
            if (!this.enabled) {
                this._maybeLogRecognitionResult(evt, "[ignored: speech model off]");
                return;
            }
            if (now < this._cooldownUntil) {
                this._maybeLogRecognitionResult(evt, "[ignored: cooldown]");
                return;
            }

            let transcript = "";
            for (let i = evt.resultIndex; i < evt.results.length; i++) {
                const alt = evt.results[i]?.[0]?.transcript;
                if (alt) transcript += ` ${alt}`;
            }
            const clean = transcript.trim();

            if (this._isRecording && now < this._recordIgnoreUntil) {
                this._maybeLogRecognitionResult(evt, "[ignored: post-wake / TTS ignore window]");
                return;
            }

            if (!clean) {
                this._maybeLogRecognitionResult(evt, "[empty combined transcript]");
                return;
            }

            this._maybeLogRecognitionResult(evt, `[combined="${clean.length > 80 ? `${clean.slice(0, 80)}…` : clean}"]`);

            if (this._isRecording) {
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
            const code = evt?.error != null ? String(evt.error) : "unknown";
            const msg = evt?.message != null ? String(evt.message) : "";
            this._logEvent(`onerror code=${code}${msg ? ` message=${msg}` : ""}`);
        };

        rec.onend = () => {
            this._logEvent("onend");
            if (!this.enabled) return;
            setTimeout(() => {
                if (!this.enabled) return;
                if (this._isRecording) {
                    this._logEvent("onend → skip rec.start (recording active)");
                    return;
                }
                try {
                    rec.start();
                    this._logEvent("onend → rec.start() retry");
                } catch (err) {
                    this._logEvent(`onend → rec.start() failed: ${err?.message || err}`);
                }
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
        if (transcriptSnapshot) this._logEvent("Transcription source: browser recognition");
        if (!transcriptSnapshot) this._logEvent("No browser transcript captured for this utterance.");

        if (!transcriptSnapshot) {
            this._setStatus(`No speech detected. Listening for "${this.wakePhrase}"`, "warn");
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
