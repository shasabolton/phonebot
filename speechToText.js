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
        /** When true, capture mic to blob; if browser transcript is empty, call agent API transcription (no chat context), then run normal speech→agent pipeline. Default on unless config sets false. */
        this.agentTranscribeFallback = Object.prototype.hasOwnProperty.call(config, "agentTranscribeFallback")
            ? !!config.agentTranscribeFallback
            : true;
        /** Ignore wake for this long after TTS stops; laptops often still echo / deliver late transcripts. */
        this.postTtsWakeGuardMs = Number.isFinite(config.postTtsWakeGuardMs)
            ? Math.max(0, Math.round(config.postTtsWakeGuardMs))
            : 750;
        this._postTtsWakeGuardUntil = 0;
        this._lastTtsSpeaking = false;
        this._mic = null;
        this._recordingStream = null;
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._recordedBlob = null;
        this._vadAudioContext = null;
        this._vadSource = null;
        this._vadAnalyser = null;
        this._vadData = null;
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
        this._fallbackToggle = null;
        this._transcriberLineEl = null;
        this._statusEl = null;
        this._outputEl = null;
        this._eventLogEl = null;
        this._hintEl = null;
        this._lastInterimSpeechLogAt = 0;
        /** @type {'idle'|'wake_listening'|'capture'|'finalizing'} */
        this._speechSessionState = "idle";
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

    /** Full session transcript: all result segments in order (fixes delta-only overwrite from resultIndex…end). */
    _fullSpeechResultsTranscript(evt) {
        const n = evt?.results?.length ?? 0;
        if (!n) return "";
        const parts = [];
        for (let i = 0; i < n; i++) {
            const alt = evt.results[i]?.[0]?.transcript;
            const t = alt != null ? String(alt).trim() : "";
            if (t) parts.push(t);
        }
        return parts.join(" ").replace(/\s+/g, " ").trim();
    }

    _speechResultsDebug(evt) {
        const parts = [];
        const n = evt?.results?.length ?? 0;
        for (let i = 0; i < n; i++) {
            const r = evt.results[i];
            const alt = r && r[0];
            const raw = alt ? String(alt.transcript || "") : "";
            const t = raw.trim();
            const slice = t.length > 100 ? `${t.slice(0, 100)}…` : t;
            const conf = alt && typeof alt.confidence === "number" ? alt.confidence.toFixed(3) : "—";
            parts.push(`#${i} final=${!!r?.isFinal} conf=${conf} "${slice}"`);
        }
        const detail = parts.length ? parts.join(" | ") : "(no segments)";
        const full = this._fullSpeechResultsTranscript(evt);
        const fullHint = full && full.length > 60 ? `${full.slice(0, 60)}…` : full;
        return fullHint ? `${detail} | combined="${fullHint}"` : detail;
    }

    _eventHasFinalSpeechResult(evt) {
        const n = evt?.results?.length ?? 0;
        for (let i = 0; i < n; i++) {
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

    _setTranscriberLine(text) {
        if (this._transcriberLineEl) {
            this._transcriberLineEl.textContent = String(text || "").trim() || "Last transcriber: —";
        }
    }

    _syncHintText() {
        if (!this._hintEl) return;
        const fb = this.agentTranscribeFallback ? "on" : "off";
        this._hintEl.textContent = `Wake: "${this.wakePhrase}". Silence stop: ${this.silenceMs}ms. Post-TTS wake guard: ${this.postTtsWakeGuardMs}ms. Primary STT: ${this.sttEngine}. API fallback if empty: ${fb}.`;
    }

    _releaseRecordingCapture() {
        if (this._mediaRecorder) {
            try {
                if (this._mediaRecorder.state !== "inactive") {
                    this._mediaRecorder.stop();
                }
            } catch (_) {}
            this._mediaRecorder = null;
        }
        this._recordChunks = [];
        if (this._vadSource) {
            try {
                this._vadSource.disconnect();
            } catch (_) {}
            this._vadSource = null;
        }
        if (this._vadAnalyser) {
            try {
                this._vadAnalyser.disconnect();
            } catch (_) {}
            this._vadAnalyser = null;
        }
        if (this._vadAudioContext) {
            try {
                this._vadAudioContext.close();
            } catch (_) {}
            this._vadAudioContext = null;
        }
        this._vadData = null;
        if (this._recordingStream) {
            for (const tr of this._recordingStream.getTracks()) {
                try {
                    tr.stop();
                } catch (_) {}
            }
            this._recordingStream = null;
        }
    }

    _getCaptureVadLevel() {
        if (!this._vadAnalyser || !this._vadData) return 0;
        this._vadAnalyser.getByteTimeDomainData(this._vadData);
        let sumSquares = 0;
        for (let i = 0; i < this._vadData.length; i++) {
            const norm = (this._vadData[i] - 128) / 128;
            sumSquares += norm * norm;
        }
        return Math.sqrt(sumSquares / this._vadData.length);
    }

    /**
     * One getUserMedia stream per capture: Web Audio VAD always; MediaRecorder only when API fallback is on.
     */
    async _acquireRecordingCapture() {
        this._releaseRecordingCapture();
        if (!navigator.mediaDevices?.getUserMedia) {
            this._logEvent("getUserMedia unavailable; using recognition-only VAD.");
            return;
        }
        try {
            this._recordingStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
        } catch (err) {
            this._logEvent(`Capture stream failed: ${err?.message || err}`);
            return;
        }

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                this._vadAudioContext = new AC();
                if (this._vadAudioContext.state === "suspended") {
                    await this._vadAudioContext.resume().catch(() => {});
                }
                this._vadSource = this._vadAudioContext.createMediaStreamSource(this._recordingStream);
                this._vadAnalyser = this._vadAudioContext.createAnalyser();
                this._vadAnalyser.fftSize = 1024;
                this._vadSource.connect(this._vadAnalyser);
                this._vadData = new Uint8Array(this._vadAnalyser.fftSize);
            }
        } catch (err) {
            this._logEvent(`VAD analyser setup failed: ${err?.message || err}`);
        }

        if (!this.agentTranscribeFallback || typeof MediaRecorder === "undefined") {
            this._logEvent("Capture stream active (audio-level silence detection).");
            return;
        }

        let mimeType = "";
        for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
            if (MediaRecorder.isTypeSupported(t)) {
                mimeType = t;
                break;
            }
        }
        try {
            this._mediaRecorder = mimeType
                ? new MediaRecorder(this._recordingStream, { mimeType })
                : new MediaRecorder(this._recordingStream);
            this._mediaRecorder.addEventListener(
                "dataavailable",
                (e) => {
                    if (e.data && e.data.size > 0) this._recordChunks.push(e.data);
                },
                false
            );
            this._mediaRecorder.start(250);
            this._logEvent(`Capture + MediaRecorder (${mimeType || "default"}).`);
        } catch (err) {
            this._logEvent(`MediaRecorder failed: ${err?.message || err}`);
            this._mediaRecorder = null;
        }
    }

    async _finalizeMediaRecorderIfNeeded() {
        this._recordedBlob = null;
        const mr = this._mediaRecorder;
        this._mediaRecorder = null;

        if (mr && this.agentTranscribeFallback) {
            await new Promise((resolve) => {
                const finish = () => {
                    const chunks = this._recordChunks;
                    this._recordChunks = [];
                    const t = mr.mimeType || "audio/webm";
                    this._recordedBlob = chunks.length ? new Blob(chunks, { type: t }) : null;
                    resolve();
                };
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
        } else {
            this._recordChunks = [];
        }

        this._releaseRecordingCapture();
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
        this._postTtsWakeGuardUntil = 0;
        this._lastTtsSpeaking = false;
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

            const clean = this._fullSpeechResultsTranscript(evt);

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

            const synth = window.speechSynthesis;
            const ttsSpeaking = !!(synth && synth.speaking);
            if (this.postTtsWakeGuardMs > 0) {
                if (ttsSpeaking) {
                    this._postTtsWakeGuardUntil = now + this.postTtsWakeGuardMs;
                } else if (this._lastTtsSpeaking) {
                    // speaking just went false; extend from now (laptop echo / late results)
                    this._postTtsWakeGuardUntil = now + this.postTtsWakeGuardMs;
                }
                this._lastTtsSpeaking = ttsSpeaking;
            }

            if (this._containsTrigger(clean)) {
                const inPostTtsGuard = this.postTtsWakeGuardMs > 0 && now < this._postTtsWakeGuardUntil;
                if (ttsSpeaking || inPostTtsGuard) {
                    this._maybeLogRecognitionResult(
                        evt,
                        ttsSpeaking ? "[ignored: wake while TTS]" : "[ignored: post-TTS echo guard]"
                    );
                    return;
                }
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
            this._logEvent(`onend (session=${this._speechSessionState})`);
            if (!this.enabled) return;
            setTimeout(() => {
                if (!this.enabled) return;
                if (!this._shouldRestartRecognitionAfterEnd()) {
                    this._logEvent(`onend → skip rec.start (session=${this._speechSessionState})`);
                    return;
                }
                try {
                    rec.start();
                    this._logEvent(`onend → rec.start() (${this._speechSessionState})`);
                } catch (err) {
                    this._logEvent(`onend → rec.start() failed: ${err?.message || err}`);
                }
            }, 300);
        };

        this._recognition = rec;
        this._isWakeArmed = true;
        try {
            rec.start();
            this._speechSessionState = "wake_listening";
            this._setStatus(`Listening for "${this.wakePhrase}"`, "ok");
            this._logEvent("Wake listening active.");
        } catch (err) {
            this._speechSessionState = "idle";
            this._setStatus(`Failed to start speech recognition: ${err?.message || "unknown"}`, "error");
        }
    }

    _shouldRestartRecognitionAfterEnd() {
        return this._speechSessionState === "wake_listening" || this._speechSessionState === "capture";
    }

    async _onWakeTriggered() {
        if (this._isRecording) return;
        this._speechSessionState = "capture";
        this._logEvent("Session → capture (wake phrase; onend will restart recognition if needed)");
        try {
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
        } catch (err) {
            this._logEvent(`Wake flow failed: ${err?.message || err}`);
            this._isRecording = false;
            this._confirmationInProgress = false;
            this._recordIgnoreUntil = 0;
            if (this._monitorTimer) {
                clearInterval(this._monitorTimer);
                this._monitorTimer = null;
            }
            void this._finalizeMediaRecorderIfNeeded();
            this._speechSessionState = this.enabled ? "wake_listening" : "idle";
        }
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
        try {
            await this._acquireRecordingCapture();
        } catch (err) {
            this._logEvent(`Capture pipeline failed: ${err?.message || err}`);
        }
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

    async _sendCleanedToChatbot(cleaned, transcriberLabel = "Browser Web Speech API") {
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
        const transcriber = String(transcriberLabel || "").trim() || "Unknown";
        this._setTranscriberLine(`Last transcriber: ${transcriber}`);
        this._setStatus("Sending transcript to chat…", "muted");
        this._renderOutput({
            state: "sending",
            transcript: text,
            transcriber,
            trigger: this.wakePhrase,
            silenceMs: this.silenceMs,
            sttEngine: this.sttEngine
        });
        this._logEvent(`Sending transcript (${transcriber}): "${text}"`);
        try {
            const ok = await agent.submitPrompt(text, { fromSpeech: true, speechTranscriber: transcriber });
            if (!ok) {
                this._setStatus(
                    `Not sent. Turn the chat agent on in “Chat agents”, enter an API key, and ensure no other send is running.`,
                    "warn"
                );
                this._cooldownUntil = Date.now() + 2000;
                return;
            }
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
            if (!this._isRecording) return;
            if (this._confirmationInProgress) return;
            const now = Date.now();
            const capLevel = this._getCaptureVadLevel();
            if (capLevel > 0.018) {
                this._lastSpeechAt = now;
            } else if (this._mic.isOn() && typeof this._mic.getAudioLevel === "function") {
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
        this._speechSessionState = "finalizing";
        if (this._monitorTimer) {
            clearInterval(this._monitorTimer);
            this._monitorTimer = null;
        }
        this._setStatus("Processing speech…", "muted");
        void this._afterRecordingStopped(reason);
    }

    async _afterRecordingStopped(reason) {
        this._logEvent(`Recording stopped: ${reason}`);
        try {
            await this._finalizeMediaRecorderIfNeeded();
        } catch (err) {
            this._logEvent(`Media finalize error: ${err?.message || err}`);
        }
        try {
            await this._finalizeRecording();
        } catch (err) {
            this._logEvent(`Finalize error: ${err?.message || err}`);
        } finally {
            if (this.enabled) {
                this._speechSessionState = "wake_listening";
                this._logEvent("Session → wake_listening (ready for next wake)");
            } else {
                this._speechSessionState = "idle";
            }
        }
    }

    async _finalizeRecording() {
        const transcriptSnapshot = String(this._latestRecordingTranscript || "").trim();

        if (transcriptSnapshot) {
            this._logEvent("Transcription source: browser recognition");
            const cleaned = this._cleanUtteranceForAgent(transcriptSnapshot);
            if (!cleaned) {
                this._setStatus(`Heard wake phrase only. Listening for "${this.wakePhrase}"`, "warn");
                this._cooldownUntil = Date.now() + 1000;
                return;
            }
            await this._sendCleanedToChatbot(cleaned, "Browser Web Speech API");
            return;
        }

        this._logEvent("No browser transcript captured for this utterance.");

        if (!this.agentTranscribeFallback) {
            this._setStatus(`No speech detected. Listening for "${this.wakePhrase}"`, "warn");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }

        const agent = this.robot.agentInterface;
        if (!agent || typeof agent.transcribeSpeechBlob !== "function") {
            this._setStatus("Agent interface cannot transcribe audio.", "error");
            this._logEvent("transcribeSpeechBlob missing on agent interface.");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }

        if (!this._recordedBlob || this._recordedBlob.size < 32) {
            this._setStatus("No recorded audio for API transcription.", "warn");
            this._logEvent("Recorded blob missing or too small.");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }

        this._setStatus("Transcribing with API (no chat context)…", "muted");
        let apiText = "";
        try {
            const ext = String(this._recordedBlob.type || "").includes("mp4") ? "m4a" : "webm";
            apiText = await agent.transcribeSpeechBlob(this._recordedBlob, { filename: `speech.${ext}` });
        } catch (err) {
            this._setStatus(`API transcription failed: ${err?.message || "unknown"}`, "error");
            this._logEvent(`API transcription failed: ${err?.message || err}`);
            this._cooldownUntil = Date.now() + 1500;
            return;
        }

        const model =
            typeof agent.getTranscriptionModelLabel === "function" ? agent.getTranscriptionModelLabel() : "API";
        this._logEvent(`API raw transcript (${model}): "${apiText.slice(0, 160)}${apiText.length > 160 ? "…" : ""}"`);

        const cleaned = this._cleanUtteranceForAgent(apiText);
        if (!cleaned) {
            this._setStatus("API transcript empty after cleaning wake/confirm.", "warn");
            this._cooldownUntil = Date.now() + 1000;
            return;
        }
        await this._sendCleanedToChatbot(cleaned, `API transcription (${model})`);
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
                    sttEngine: this.sttEngine,
                    agentTranscribeFallback: this.agentTranscribeFallback
                });
                this._syncHintText();
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
            this._speechSessionState = "idle";
            this._postTtsWakeGuardUntil = 0;
            this._lastTtsSpeaking = false;
            if (this._recognition) {
                try {
                    this._recognition.stop();
                } catch (_) {}
                this._recognition = null;
            }
            this._setStatus("Speech model off.", "muted");
            this._renderOutput({ state: "off" });
            this._logEvent("Speech model disabled.");
            this._releaseRecordingCapture();
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

        const fallbackWrap = document.createElement("label");
        fallbackWrap.style.display = "flex";
        fallbackWrap.style.alignItems = "center";
        fallbackWrap.style.gap = "8px";
        fallbackWrap.style.marginTop = "8px";
        const fallbackToggle = document.createElement("input");
        fallbackToggle.type = "checkbox";
        fallbackToggle.checked = this.agentTranscribeFallback;
        fallbackToggle.addEventListener("change", () => {
            this.agentTranscribeFallback = !!fallbackToggle.checked;
            this._syncHintText();
            this._logEvent(`API transcription fallback ${this.agentTranscribeFallback ? "on" : "off"}.`);
        });
        fallbackWrap.appendChild(fallbackToggle);
        fallbackWrap.appendChild(document.createTextNode("Record mic + use agent API if browser transcript is empty"));

        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = "";

        const transcriberLine = document.createElement("p");
        transcriberLine.className = "muted";
        transcriberLine.textContent = "Last transcriber: —";

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
        controls.appendChild(fallbackWrap);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(hint);
        wrap.appendChild(transcriberLine);
        wrap.appendChild(status);
        wrap.appendChild(eventLog);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._fallbackToggle = fallbackToggle;
        this._hintEl = hint;
        this._transcriberLineEl = transcriberLine;
        this._statusEl = status;
        this._eventLogEl = eventLog;
        this._outputEl = output;
        this._syncHintText();
    }

    destroy() {
        void this.setEnabled(false);
        this._releaseRecordingCapture();
    }
}

window.SpeechToTextAiModel = SpeechToTextAiModel;
