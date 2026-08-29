/**
 * Manages LLM chat agents (configurable base URL, path, model, API key).
 * Independent from Groq vision model. Groq/OpenAI-compatible chat stays on
 * /chat/completions; Gemini agents use native generativelanguage REST.
 */
class AgentInterface {
    static STORAGE_KEY_PREFIX = "phonebot.agent.";
    static STORAGE_REMEMBER = "phonebot.agent.remember";
    /** Sentinel `<select>` value: insert live state JSON (not a file path). */
    static TEMPLATE_VALUE_STATE = "__robot_state_json__";
    static FORTUNE_TELLER_FINALE_EVERY = 8;
    static FORTUNE_TELLER_FINALE_LINE = "Can you please give me my grand finale fortune now";

    /**
     * @param {Robot} robot
     * @param {object} config from robot.config.agentInterface
     */
    constructor(robot, config = {}) {
        this.robot = robot;
        this.config = typeof config === "object" && config ? config : {};
        this.name = this.config.name || "AI Agents";
        this.defaultBaseUrl = String(this.config.defaultBaseUrl || "https://api.groq.com/openai/v1").replace(/\/$/, "");
        this.agents = Array.isArray(this.config.agents) ? this.config.agents : [];
        this.promptTemplates = Array.isArray(this.config.promptTemplates)
            ? this.config.promptTemplates
            : [{ name: "Introduction prompt", path: "promptTemplates/introductionPrompt.txt" }];
        const stm = this.config.shortTermMemory;
        this.shortTermMemory = stm != null && typeof stm === "string" ? stm : "";
        this.messageHistory = [];
        /** Latest JPEG data URL for stateMachine path `agentInterface.currentCameraImageUrl` and vision chat. */
        this.currentCameraImageUrl = "";
        const capEdge = this.config.cameraCaptureMaxEdge;
        this.cameraCaptureMaxEdge = Number.isFinite(capEdge) ? Math.round(capEdge) : 960;
        this.cameraCaptureMaxEdge = Math.max(320, Math.min(1600, this.cameraCaptureMaxEdge));
        const jq = this.config.cameraCaptureJpegQuality;
        this.cameraCaptureJpegQuality = Number.isFinite(jq) ? jq : 0.85;
        this.cameraCaptureJpegQuality = Math.max(0.4, Math.min(0.98, this.cameraCaptureJpegQuality));
        this._captureCanvas = null;
        this._captureCtx = null;
        this._apiKey = "";
        this._rememberKey = false;
        this._voiceOn = false;
        this._ttsVoice = typeof window.GroqTts?.loadSavedVoice === "function"
            ? window.GroqTts.loadSavedVoice()
            : "autumn";
        this._speakGeneration = 0;
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._voiceInput = null;
        this._voiceSelect = null;
        this._voiceSelectLabel = null;
        this._voiceStatusEl = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this._showFullSpeechPrompt = false;
        this._fullSpeechPromptInput = null;
        this._agentEnabled = true;
        this._sendInProgress = false;
        /** True while Simon Says countdown/pose-send cycle is running (blocks overlapping sends). */
        this._simonPoseCycleRunning = false;
        /** True while conversation-mode timed mic capture / transcribe is running. */
        this._conversationListenRunning = false;
        this._billingPaused = false;
        this._aiBudgetEl = null;
        this._aiBudgetListener = () => this._syncAiBudgetUi();
        window.addEventListener("phonebot:ai-budget", this._aiBudgetListener);
        this._agentPowerBtn = null;
        /** When true, attach current camera JPEG to the last user message on send. */
        this._sendCameraImage = this.config.sendCameraImage !== false;
        this._sendCameraImageInput = null;
        /** DOM overlay for camera countdown (Simon pose). */
        this._countdownOverlayEl = null;
        this._countdownNumberEl = null;
        this._countdownLabelEl = null;
        /** Lean-in proximity gauge overlay (conversation listen). */
        this._leanOverlayEl = null;
        this._leanFillEl = null;
        this._leanMarkEl = null;
        this._leanLabelEl = null;
        this._leanHintEl = null;
        this._leanRecEl = null;
        this._loadSavedKeyPreference();
        this._voiceOn = this._resolveVoiceDefault(null);
    }

    /** Face-width / frame-width: lean-in enter / lean-out exit (hysteresis). */
    static LEAN_ENTER_SCALE = 0.36;
    static LEAN_EXIT_SCALE = 0.26;
    /** Gauge reads empty at/below this scale. */
    static LEAN_GAUGE_FLOOR = 0.12;

    /** True when a lean-in-to-talk game is active (Philosophy, 20 Questions, Fortune Teller). */
    _isConversationMode() {
        const mode = String(this.robot?.mode || "").trim().toLowerCase();
        return (
            mode === "philosophy" ||
            mode === "twentyquestions" ||
            mode === "fortuneteller"
        );
    }

    _isFortuneTellerMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "fortuneteller";
    }

    /** True on player turns 8, 16, 24… before this utterance is stored. */
    _isFortuneTellerFinaleDue() {
        if (!this._isFortuneTellerMode()) return false;
        const userCount = (this.messageHistory || []).filter((m) => m && m.role === "user").length;
        return (userCount + 1) % AgentInterface.FORTUNE_TELLER_FINALE_EVERY === 0;
    }

    _joinFortuneTellerFinale(userText) {
        const finale = AgentInterface.FORTUNE_TELLER_FINALE_LINE;
        const base = String(userText || "").trim();
        if (!base) return finale;
        if (base.includes(finale)) return base;
        return `${base} ${finale}`;
    }

    /** Append the finale line to this player utterance when due. Visible in history. */
    _withFortuneTellerFinaleIfDue(userText) {
        const base = String(userText || "");
        if (!this._isFortuneTellerFinaleDue()) return base;
        return this._joinFortuneTellerFinale(base);
    }

    /** True when Groq Simon Says AI is active (not the local pose-match game). */
    _isSimonSaysMode() {
        const mode = String(this.robot?.mode || "").trim().toLowerCase();
        if (mode === "simonsaysai") return true;
        if (mode === "simonsaysposematch") return false;
        const selected = String(this._templateSelect?.value || "").trim();
        if (/simonSaysPrompt/i.test(selected)) return true;
        const list = Array.isArray(this.promptTemplates) ? this.promptTemplates : [];
        const tpl = list.find((t) => String(t?.path || "").trim() === selected);
        if (/simon\s*says/i.test(String(tpl?.name || ""))) return true;
        const marker = /you are simon in a game of simon says/i;
        if (marker.test(String(this._promptInput?.value || ""))) return true;
        for (const m of this.messageHistory || []) {
            if (marker.test(String(m?.fullPrompt || "")) || marker.test(String(m?.text || ""))) {
                return true;
            }
        }
        return false;
    }

    /**
     * Called when the robot mode select changes (or after GUI build).
     * Starts timed listen in conversation mode; cancels prior countdown/TTS.
     * @param {string} [_modeId]
     */
    onRobotModeChanged(_modeId) {
        this._stopSpeaking();
        if (this._isSimonSaysPoseMatchMode() || this._isParrotMode()) return;
        if (this._agentEnabled && this._isConversationMode()) {
            this._queueConversationListen(this._speakGeneration);
        }
    }

    /** Local MoveNet + agent-TTS Simon Says (no chat LLM). */
    _isSimonSaysPoseMatchMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "simonsaysposematch";
    }

    /** Local lean-in echo (no LLM / TTS). */
    _isParrotMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "parrot";
    }

    /**
     * Lean-in mic capture for local games (e.g. Parrot). Reuses the conversation lean UI.
     * Cancels when `isActive()` is false or speaking is stopped.
     * @param {{ isActive?: () => boolean }} [options]
     * @returns {Promise<Blob|null>}
     */
    async captureLeanInRecording(options = {}) {
        const generation = this._speakGeneration;
        const isActive =
            typeof options.isActive === "function"
                ? () => generation === this._speakGeneration && !!options.isActive()
                : () => generation === this._speakGeneration;
        return this._recordMicrophoneWhileLeanedIn(generation, { isActive });
    }

    _billingContext() {
        return {
            modeId: this.robot?.mode,
            modeConfig: this.robot?._getActiveModeConfig?.(),
            robotSlug: this.robot?._robotSlug?.()
        };
    }

    /** The key field is the source of truth, so clearing it drops any remembered key. */
    _clientApiKey() {
        if (this._keyInput) return String(this._keyInput.value || "").trim();
        return String(this._apiKey || "").trim();
    }

    hasClientApiKey() {
        return !!this._clientApiKey();
    }

    /** Hosted Groq is the fallback for paid modes only when the user has no key of their own. */
    _useHostedAi() {
        if (this._clientApiKey()) return false;
        return !!window.playBilling?.isArcadeAiMode?.(this._billingContext().modeConfig);
    }

    async _ensureArcadeAiBudget() {
        const context = this._billingContext();
        if (!this._useHostedAi()) return true;
        if (!window.playBilling?.isArcadeAiMode?.(context.modeConfig)) return true;
        const allowed = await window.playBilling.ensureAiBudget(context);
        this._billingPaused = !allowed;
        if (!allowed) {
            throw new Error("AI is paused until payment is completed.");
        }
        return true;
    }

    _syncAiBudgetUi() {
        if (!this._aiBudgetEl) return;
        const modeConfig = this._billingContext().modeConfig;
        if (!window.playBilling?.isArcadeAiMode?.(modeConfig)) {
            this._aiBudgetEl.hidden = true;
            return;
        }
        this._aiBudgetEl.hidden = false;
        if (this._clientApiKey()) {
            this._aiBudgetEl.textContent = "Hosted AI quota: BYOK active — 0% used.";
            this._aiBudgetEl.className = "ok";
            return;
        }
        const session = window.playBilling?.getActiveSession?.();
        const budget = Math.max(
            0,
            Number(session?.aiBudgetCents ?? modeConfig?.aiBudgetCents) || 0
        );
        const spent = Math.min(budget, Math.max(0, Number(session?.aiSpentCents) || 0));
        const percent = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
        const format = (cents) =>
            window.playBilling?.formatPrice?.(cents, modeConfig?.currency || "aud") ??
            `${cents}¢`;
        this._aiBudgetEl.textContent =
            `Hosted AI quota: ${percent}% used (${format(spent)} of ${format(budget)}).`;
        this._aiBudgetEl.className = percent >= 80 ? "warn" : "muted";
    }

    /**
     * Select a prompt template by path or name and insert it into the prompt textarea.
     * Used when a robot mode declares `promptTemplate`.
     * @param {string} pathOrName
     * @returns {Promise<boolean>}
     */
    async applyPromptTemplate(pathOrName) {
        const want = String(pathOrName || "").trim();
        if (!want || !this._promptInput) return false;
        const list = Array.isArray(this.promptTemplates) ? this.promptTemplates : [];
        const tpl =
            list.find((t) => String(t?.path || "").trim() === want) ||
            list.find((t) => String(t?.name || "").trim().toLowerCase() === want.toLowerCase());
        const path = String(tpl?.path || want).trim();
        if (!path || path === AgentInterface.TEMPLATE_VALUE_STATE) return false;
        if (this._templateSelect) {
            const hasOption = Array.from(this._templateSelect.options || []).some(
                (opt) => opt.value === path
            );
            if (hasOption) this._templateSelect.value = path;
        }
        try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) throw new Error(`Failed to load template: ${path}`);
            const templateText = await res.text();
            this._promptInput.value = this.buildInstructionPromptFromTemplate(templateText);
            if (this._statusEl) {
                this._statusEl.className = "ok";
                this._statusEl.textContent = `Loaded template: ${tpl?.name || path}`;
            }
            return true;
        } catch (err) {
            if (this._statusEl) {
                this._statusEl.className = "error";
                this._statusEl.textContent = err?.message || "Template load failed.";
            }
            return false;
        }
    }

    _setAgentEnabled(on) {
        this._agentEnabled = !!on;
        if (this._agentPowerBtn) {
            this._agentPowerBtn.textContent = this._agentEnabled ? "Turn off agent" : "Turn on agent";
        }
        if (!this._agentEnabled) {
            this._stopSpeaking();
        } else if (this._isConversationMode()) {
            this._queueConversationListen(this._speakGeneration);
        }
        this._syncSendButtonState();
    }

    _syncSendButtonState() {
        if (!this._sendBtn) return;
        this._sendBtn.disabled =
            this._sendInProgress ||
            this._simonPoseCycleRunning ||
            this._conversationListenRunning ||
            !this._agentEnabled;
    }

    /**
     * Persists scratch notes for the next model turn. Visible in state at `agentInterface.shortTermMemory`.
     * @param {string|null|undefined} value
     */
    setShortTermMemory(value) {
        this.shortTermMemory = String(value == null ? "" : value);
    }

    _loadSavedKeyPreference() {
        try {
            this._rememberKey = localStorage.getItem(AgentInterface.STORAGE_REMEMBER) === "true";
        } catch (_) {
            this._rememberKey = false;
        }
    }

    _storageKeyForAgent(agentName) {
        return `${AgentInterface.STORAGE_KEY_PREFIX}key.${String(agentName || "default").replace(/\s+/g, "_")}`;
    }

    _loadKeyForAgent(agentName) {
        if (!this._rememberKey) return "";
        try {
            return localStorage.getItem(this._storageKeyForAgent(agentName)) || "";
        } catch (_) {
            return "";
        }
    }

    _persistKeyForAgent(agentName, key) {
        try {
            localStorage.setItem(AgentInterface.STORAGE_REMEMBER, this._rememberKey ? "true" : "false");
            if (this._rememberKey && key) {
                localStorage.setItem(this._storageKeyForAgent(agentName), key);
            } else {
                localStorage.removeItem(this._storageKeyForAgent(agentName));
            }
        } catch (_) {}
    }

    getSelectedAgent() {
        const idx = this._agentSelect ? Number(this._agentSelect.value) : 0;
        if (!Number.isFinite(idx) || idx < 0) return null;
        return this.agents[idx] || null;
    }

    _isGeminiProvider(agent = this.getSelectedAgent()) {
        if (typeof window.GeminiAudioTurn?.isGeminiAgent === "function") {
            return !!window.GeminiAudioTurn.isGeminiAgent(agent);
        }
        return String(agent?.provider || "").trim().toLowerCase() === "gemini";
    }

    _isGeminiAudioTurn(agent = this.getSelectedAgent()) {
        if (typeof window.GeminiAudioTurn?.isAudioTurnAgent === "function") {
            return !!window.GeminiAudioTurn.isAudioTurnAgent(agent);
        }
        return this._isGeminiProvider(agent);
    }

    _resolveChatUrl(agent) {
        if (!agent) return null;
        if (agent.chatUrl) return String(agent.chatUrl).trim();
        const base = String(agent.baseUrl || this.defaultBaseUrl || "").replace(/\/$/, "");
        const path = String(agent.chatPath || "/chat/completions").startsWith("/")
            ? agent.chatPath
            : `/${agent.chatPath}`;
        if (!base) return null;
        return `${base}${path}`;
    }

    _resolveTranscribeUrl(agent) {
        if (!agent) return null;
        if (agent.transcriptionUrl) return String(agent.transcriptionUrl).trim();
        const base = String(agent.baseUrl || this.defaultBaseUrl || "").replace(/\/$/, "");
        const rawPath = agent.transcriptionPath != null ? String(agent.transcriptionPath) : "/audio/transcriptions";
        const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        if (!base) return null;
        return `${base}${path}`;
    }

    _resolveTranscriptionModel(agent) {
        const fromAgent = agent && String(agent.transcriptionModel || "").trim();
        if (fromAgent) return fromAgent;
        const fromCfg = String(this.config.transcriptionModel || "").trim();
        return fromCfg || "whisper-large-v3";
    }

    /** Label for speech UI: which model the API uses for `transcribeSpeechBlob`. */
    getTranscriptionModelLabel() {
        const agent = this.getSelectedAgent();
        if (this._isGeminiProvider(agent)) {
            return this._resolveModel(agent) || window.GeminiAudioTurn?.DEFAULT_MODEL || "gemini-3.6-flash";
        }
        return this._resolveTranscriptionModel(agent);
    }

    /**
     * OpenAI-compatible audio transcription (multipart). No chat context.
     * @param {Blob} blob
     * @param {{ filename?: string }} [options]
     * @returns {Promise<string>} trimmed transcript text
     */
    async transcribeSpeechBlob(blob, options = {}) {
        await this._ensureArcadeAiBudget();
        if (!blob || blob.size < 32) {
            throw new Error("No audio captured for transcription.");
        }
        const agent = this.getSelectedAgent();
        if (!agent) {
            throw new Error("No agent selected.");
        }
        if (this._isGeminiProvider(agent)) {
            const apiKey = String(this._apiKey || this._keyInput?.value || "").trim();
            if (!apiKey) throw new Error("Enter a Gemini API key (AI Studio, starts with AIza…).");
            if (typeof window.GeminiAudioTurn?.transcribeOnly !== "function") {
                throw new Error("Gemini audio helper is not loaded.");
            }
            return window.GeminiAudioTurn.transcribeOnly({
                apiKey,
                baseUrl: window.GeminiAudioTurn.resolveBaseUrl(agent, this.defaultBaseUrl),
                model: this._resolveModel(agent) || window.GeminiAudioTurn.DEFAULT_MODEL,
                audioBlob: blob
            });
        }
        const model = this._resolveTranscriptionModel(agent);
        const filename = String(options.filename || "speech.webm").trim() || "speech.webm";
        const form = new FormData();
        form.append("file", blob, filename);
        form.append("model", model);
        const hostedArcade =
            this._useHostedAi() &&
            typeof window.playBilling?.fetchHostedTranscribe === "function";
        let res;
        if (hostedArcade) {
            res = await window.playBilling.fetchHostedTranscribe(form);
        } else {
            const url = this._resolveTranscribeUrl(agent);
            if (!url) {
                throw new Error("Agent has no transcription URL (set baseUrl or transcriptionUrl).");
            }
            const apiKey = this._clientApiKey();
            if (!apiKey) {
                throw new Error("Enter an API key for this provider.");
            }
            const authHeader = String(agent.authHeader || "Authorization").trim();
            const authPrefix = agent.authPrefix !== undefined ? String(agent.authPrefix) : "Bearer ";
            const headers = {
                [authHeader]: `${authPrefix}${apiKey}`
            };
            if (agent.extraHeaders && typeof agent.extraHeaders === "object") {
                for (const [k, v] of Object.entries(agent.extraHeaders)) {
                    if (k && v != null) headers[k] = String(v);
                }
            }
            res = await fetch(url, {
                method: "POST",
                headers,
                body: form
            });
        }
        if (await window.playBilling?.handlePaymentRequired?.(res, this._billingContext())) {
            this._billingPaused = true;
            throw new Error("AI budget used. Pay to continue.");
        }
        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`Transcription HTTP ${res.status}: ${rawText.slice(0, 500)}`);
        }
        let json;
        try {
            json = JSON.parse(rawText);
        } catch (_) {
            throw new Error("Transcription response was not JSON.");
        }
        const text = String(json?.text ?? "").trim();
        if (!text) {
            throw new Error("Transcription returned empty text.");
        }
        return text;
    }

    _resolveModel(agent) {
        const override = this._modelOverrideInput?.value?.trim();
        if (override) return override;
        return String(agent?.model || "").trim();
    }

    _resolveVoiceDefault(agent) {
        if (agent && Object.prototype.hasOwnProperty.call(agent, "voiceOn")) {
            return !!agent.voiceOn;
        }
        if (Object.prototype.hasOwnProperty.call(this.config, "voiceOn")) {
            return !!this.config.voiceOn;
        }
        return false;
    }

    _resolveSpeechUrl(agent) {
        if (!agent) return null;
        if (agent.speechUrl) return String(agent.speechUrl).trim();
        const base = String(agent.baseUrl || this.defaultBaseUrl || "").replace(/\/$/, "");
        const rawPath = agent.speechPath != null ? String(agent.speechPath) : "/audio/speech";
        const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
        if (!base) return null;
        return `${base}${path}`;
    }

    _resolveSpeechModel(agent) {
        const fromAgent = agent && String(agent.speechModel || "").trim();
        if (fromAgent) return fromAgent;
        const fromCfg = String(this.config.speechModel || "").trim();
        if (fromCfg) return fromCfg;
        if (this._isGeminiProvider(agent)) {
            return window.GeminiAudioTurn?.DEFAULT_SPEECH_MODEL || "gemini-3.1-flash-tts-preview";
        }
        return window.GroqTts?.MODEL_ENGLISH || "canopylabs/orpheus-v1-english";
    }

    /**
     * Groq / OpenAI-compatible TTS → WAV Blob.
     * @param {string} text
     * @param {{ voice?: string }} [options]
     * @returns {Promise<Blob>}
     */
    async synthesizeSpeechBlob(text, options = {}) {
        await this._ensureArcadeAiBudget();
        const agent = this.getSelectedAgent();
        if (!agent) throw new Error("No agent selected.");
        if (this._isGeminiProvider(agent)) {
            const apiKey = String(this._apiKey || this._keyInput?.value || "").trim();
            if (!apiKey) throw new Error("Enter a Gemini API key for TTS.");
            if (typeof window.GeminiAudioTurn?.synthesizeSpeech !== "function") {
                throw new Error("Gemini audio helper is not loaded.");
            }
            const voice = window.GeminiAudioTurn.isKnownVoice?.(options.voice)
                ? options.voice
                : window.GeminiAudioTurn.DEFAULT_VOICE || "Kore";
            return window.GeminiAudioTurn.synthesizeSpeech({
                apiKey,
                baseUrl: window.GeminiAudioTurn.resolveBaseUrl(agent, this.defaultBaseUrl),
                speechModel: this._resolveSpeechModel(agent),
                text,
                voice
            });
        }
        const voice = window.GroqTts?.isKnownVoice?.(options.voice)
            ? options.voice
            : window.GroqTts?.DEFAULT_VOICE || "autumn";
        const input =
            typeof window.GroqTts?.clampInput === "function"
                ? window.GroqTts.clampInput(text)
                : String(text || "").trim().slice(0, 200);
        if (!input) throw new Error("Nothing to speak.");
        const model = this._resolveSpeechModel(agent);
        const speechBody = {
            model,
            voice,
            input,
            response_format: "wav"
        };
        const hostedArcade =
            this._useHostedAi() &&
            typeof window.playBilling?.fetchHostedSpeech === "function";
        let res;
        if (hostedArcade) {
            res = await window.playBilling.fetchHostedSpeech(speechBody);
        } else {
            const url = this._resolveSpeechUrl(agent);
            if (!url) throw new Error("Agent has no speech URL (set baseUrl or speechUrl).");
            const apiKey = this._clientApiKey();
            if (!apiKey) throw new Error("Enter an API key for TTS.");
            const authHeader = String(agent.authHeader || "Authorization").trim();
            const authPrefix = agent.authPrefix !== undefined ? String(agent.authPrefix) : "Bearer ";
            const headers = {
                "Content-Type": "application/json",
                [authHeader]: `${authPrefix}${apiKey}`
            };
            if (agent.extraHeaders && typeof agent.extraHeaders === "object") {
                for (const [k, v] of Object.entries(agent.extraHeaders)) {
                    if (k && v != null) headers[k] = String(v);
                }
            }
            res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(speechBody)
            });
        }
        if (await window.playBilling?.handlePaymentRequired?.(res, this._billingContext())) {
            this._billingPaused = true;
            throw new Error("AI budget used. Pay to continue.");
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 400)}`);
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 44) {
            throw new Error("TTS returned empty audio.");
        }
        return new Blob([buf], { type: "audio/wav" });
    }

    _stopSpeaking() {
        this._speakGeneration += 1;
        window.__phonebotTtsSpeaking = false;
        this._clearCameraCountdownOverlay();
        this._clearLeanOverlay();
        if (window.speechSynthesis) {
            try {
                window.speechSynthesis.cancel();
            } catch (_) {}
        }
        const player = this._getAudioPlayer();
        if (player && typeof player.stop === "function") {
            player.stop();
        }
    }

    _getAudioPlayer() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("audioPlayer");
    }

    _setVoiceStatus(text) {
        if (this._voiceStatusEl) {
            this._voiceStatusEl.textContent = text || "";
        }
    }

    _onTtsVoiceChange() {
        const id = this._voiceSelect ? this._voiceSelect.value : "";
        if (this._isGeminiProvider()) {
            this._ttsVoice =
                typeof window.GeminiAudioTurn?.saveVoice === "function"
                    ? window.GeminiAudioTurn.saveVoice(id)
                    : id || "Kore";
        } else if (typeof window.GroqTts?.saveVoice === "function") {
            this._ttsVoice = window.GroqTts.saveVoice(id);
        } else {
            this._ttsVoice = id || "autumn";
        }
        if (this._voiceSelect) this._voiceSelect.value = this._ttsVoice;
    }

    _syncVoiceUiForSelectedAgent() {
        const gemini = this._isGeminiProvider();
        const voiceList = gemini
            ? Array.isArray(window.GeminiAudioTurn?.VOICES) && window.GeminiAudioTurn.VOICES.length
                ? window.GeminiAudioTurn.VOICES
                : [{ id: "Kore", label: "Kore — firm" }]
            : Array.isArray(window.GroqTts?.VOICES) && window.GroqTts.VOICES.length
              ? window.GroqTts.VOICES
              : [{ id: "autumn", label: "Autumn — ♀" }];
        this._ttsVoice = gemini
            ? typeof window.GeminiAudioTurn?.loadSavedVoice === "function"
                ? window.GeminiAudioTurn.loadSavedVoice()
                : "Kore"
            : typeof window.GroqTts?.loadSavedVoice === "function"
              ? window.GroqTts.loadSavedVoice()
              : "autumn";
        if (this._voiceSelectLabel) {
            this._voiceSelectLabel.textContent = gemini
                ? "Voice (Gemini TTS)"
                : "Voice (Groq Orpheus TTS)";
        }
        if (this._keyInput) {
            this._keyInput.placeholder = gemini ? "AIza… (Google AI Studio)" : "sk-… or gsk_…";
        }
        if (this._voiceSelect) {
            this._voiceSelect.replaceChildren();
            for (const v of voiceList) {
                const opt = document.createElement("option");
                opt.value = v.id;
                opt.textContent = v.label || v.id;
                this._voiceSelect.appendChild(opt);
            }
            if (![...this._voiceSelect.options].some((o) => o.value === this._ttsVoice)) {
                this._ttsVoice = voiceList[0].id;
            }
            this._voiceSelect.value = this._ttsVoice;
        }
        this._setVoiceStatus(
            this._useHostedAi()
                ? "Arcade session active. Chat, Whisper, and TTS use the hosted metered Groq key (clear key field = hosted)."
                : gemini
                ? "Gemini audio turn + TTS (AI Studio). Text history only — no Groq Whisper/Orpheus."
                : "Groq Orpheus TTS (uses API credits). Long replies play in sequence (200 chars per chunk)."
        );
    }

    /**
     * Speak with provider TTS → audioPlayer (mouth filter can analyse it).
     * Falls back to browser speechSynthesis if TTS or audioPlayer is unavailable.
     */
    _speak(text) {
        void this._speakAsync(text);
    }

    /**
     * @param {string} text
     * @returns {Promise<boolean>} true if this utterance finished without being superseded
     */
    async _speakAsync(text) {
        const content = String(text || "").trim();
        if (!content) return false;
        this._stopSpeaking();
        const generation = this._speakGeneration;
        const showListenPrompt = this._isConversationMode();
        if (showListenPrompt) this._updateLeanOverlay("listen");
        try {
            await this._speakSynthesizedAsync(content, generation);
            return generation === this._speakGeneration;
        } finally {
            if (showListenPrompt) this._clearLeanOverlay();
        }
    }

    async _speakSynthesizedAsync(content, generation) {
        const player = this._getAudioPlayer();
        const canPlay = player && typeof player.playBlob === "function";
        if (!canPlay) {
            await this._speakBrowserFallback(content);
            return;
        }
        const gemini = this._isGeminiProvider();
        const chunks = gemini
            ? [content]
            : typeof window.GroqTts?.splitInput === "function"
              ? window.GroqTts.splitInput(content)
              : [content];
        let usedBrowserFallback = false;
        try {
            this._apiKey = this._keyInput ? String(this._keyInput.value || "").trim() : this._apiKey;
            for (let i = 0; i < chunks.length; i++) {
                if (generation !== this._speakGeneration) return;
                const chunk = chunks[i];
                const partLabel =
                    chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
                this._setVoiceStatus(
                    gemini
                        ? `Gemini TTS (${this._ttsVoice})…`
                        : `Groq TTS (${this._ttsVoice})${partLabel}…`
                );
                const blob = await this.synthesizeSpeechBlob(chunk, { voice: this._ttsVoice });
                if (generation !== this._speakGeneration) return;
                await this._playSpeechBlob(blob, chunk, generation, {
                    speakingLabel: gemini
                        ? `Speaking (Gemini ${this._ttsVoice})…`
                        : `Speaking (${this._ttsVoice})${partLabel}…`,
                    idleLabel: gemini
                        ? "Gemini TTS (AI Studio)."
                        : "Groq Orpheus TTS (uses API credits).",
                    playLabel: gemini
                        ? `Gemini TTS (${this._ttsVoice})`
                        : `Groq TTS (${this._ttsVoice})${partLabel}`
                });
            }
        } catch (err) {
            console.warn("TTS error, falling back to browser speechSynthesis:", err);
            if (generation !== this._speakGeneration) return;
            this._setVoiceStatus(
                `${gemini ? "Gemini" : "Groq"} TTS failed — using browser voice. (${err?.message || err})`
            );
            usedBrowserFallback = true;
            await this._speakBrowserFallback(content);
        } finally {
            if (generation === this._speakGeneration && !usedBrowserFallback) {
                window.__phonebotTtsSpeaking = false;
            }
        }
    }

    _blobFromBase64Audio(base64, type = "audio/wav") {
        const encoded = String(base64 || "").trim();
        if (!encoded) return null;
        try {
            const binary = atob(encoded);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: String(type || "audio/wav") });
        } catch (_) {
            return null;
        }
    }

    async _playSpeechBlob(blob, fallbackText, generation, labels) {
        const player = this._getAudioPlayer();
        if (!player || typeof player.playBlob !== "function") {
            throw new Error("Audio player unavailable.");
        }
        this._setVoiceStatus(labels.speakingLabel);
        window.__phonebotTtsSpeaking = true;
        const playTimeoutMs = 60000;
        await Promise.race([
            player.playBlob(blob, labels.playLabel),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`TTS playback timed out after ${playTimeoutMs / 1000}s.`)),
                    playTimeoutMs
                )
            )
        ]);
        if (generation === this._speakGeneration) {
            this._setVoiceStatus(labels.idleLabel);
        }
    }

    async _speakProvidedAudioBlob(audioBlob, spokenText, generation) {
        const content = String(spokenText || "").trim();
        const player = this._getAudioPlayer();
        const canPlay = player && typeof player.playBlob === "function";
        if (!canPlay) {
            await this._speakBrowserFallback(content);
            return;
        }
        if (!audioBlob || audioBlob.size < 44) {
            if (content) await this._speakSynthesizedAsync(content, generation);
            return;
        }
        let usedBrowserFallback = false;
        try {
            await this._playSpeechBlob(audioBlob, content, generation, {
                speakingLabel: `Speaking (Gemini ${this._ttsVoice})…`,
                idleLabel: "Gemini audio turn (AI Studio).",
                playLabel: `Gemini (${this._ttsVoice})`
            });
        } catch (err) {
            console.warn("Gemini audio playback error, falling back to browser speechSynthesis:", err);
            if (generation !== this._speakGeneration) return;
            this._setVoiceStatus(`Gemini audio failed — using browser voice. (${err?.message || err})`);
            usedBrowserFallback = true;
            await this._speakBrowserFallback(content);
        } finally {
            if (generation === this._speakGeneration && !usedBrowserFallback) {
                window.__phonebotTtsSpeaking = false;
            }
        }
    }

    async _speakBrowserFallback(text) {
        const content = String(text || "").trim();
        if (!content) return;
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
            return;
        }
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(content);
            if (window.BrowserTts && typeof window.BrowserTts.applyMaleVoice === "function") {
                await window.BrowserTts.applyMaleVoice(utterance);
            }
            await new Promise((resolve) => {
                utterance.onstart = () => {
                    window.__phonebotTtsSpeaking = true;
                };
                utterance.onend = () => {
                    window.__phonebotTtsSpeaking = false;
                    resolve();
                };
                utterance.onerror = () => {
                    window.__phonebotTtsSpeaking = false;
                    resolve();
                };
                window.speechSynthesis.speak(utterance);
            });
        } catch (err) {
            window.__phonebotTtsSpeaking = false;
            console.warn("TTS error:", err);
        }
    }

    _clearCameraCountdownOverlay() {
        if (this._countdownOverlayEl && this._countdownOverlayEl.parentNode) {
            this._countdownOverlayEl.parentNode.removeChild(this._countdownOverlayEl);
        }
        this._countdownOverlayEl = null;
        this._countdownNumberEl = null;
        this._countdownLabelEl = null;
    }

    _clearLeanOverlay() {
        if (this._leanOverlayEl && this._leanOverlayEl.parentNode) {
            this._leanOverlayEl.parentNode.removeChild(this._leanOverlayEl);
        }
        this._leanOverlayEl = null;
        this._leanFillEl = null;
        this._leanMarkEl = null;
        this._leanLabelEl = null;
        this._leanHintEl = null;
        this._leanRecEl = null;
    }

    /**
     * Build (or reuse) the lean-in proximity gauge on the camera frame.
     * @returns {HTMLElement|null}
     */
    _ensureLeanOverlay() {
        if (this._leanOverlayEl && this._leanOverlayEl.isConnected) return this._leanOverlayEl;
        this._clearLeanOverlay();
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return null;

        const overlay = document.createElement("div");
        overlay.className = "sensor-camera-lean-overlay";
        overlay.setAttribute("aria-live", "polite");

        const rec = document.createElement("div");
        rec.className = "sensor-camera-lean-rec";
        const recDot = document.createElement("span");
        recDot.className = "sensor-camera-lean-rec-dot";
        recDot.setAttribute("aria-hidden", "true");
        const recText = document.createElement("span");
        recText.textContent = "Recording";
        rec.appendChild(recDot);
        rec.appendChild(recText);

        const meter = document.createElement("div");
        meter.className = "sensor-camera-lean-meter";
        meter.setAttribute("role", "meter");
        meter.setAttribute("aria-valuemin", "0");
        meter.setAttribute("aria-valuemax", "100");

        const fill = document.createElement("div");
        fill.className = "sensor-camera-lean-fill";
        const mark = document.createElement("div");
        mark.className = "sensor-camera-lean-mark";
        const enter = AgentInterface.LEAN_ENTER_SCALE;
        const floor = AgentInterface.LEAN_GAUGE_FLOOR;
        const markAlong = Math.max(
            0,
            Math.min(100, ((enter - floor) / Math.max(0.01, enter - floor + 0.12)) * 100)
        );
        mark.style.left = `${markAlong}%`;
        meter.appendChild(fill);
        meter.appendChild(mark);

        const label = document.createElement("div");
        label.className = "sensor-camera-lean-label";
        const hint = document.createElement("div");
        hint.className = "sensor-camera-lean-hint";

        overlay.appendChild(rec);
        overlay.appendChild(meter);
        overlay.appendChild(label);
        overlay.appendChild(hint);
        frameEl.appendChild(overlay);

        this._leanOverlayEl = overlay;
        this._leanFillEl = fill;
        this._leanMarkEl = mark;
        this._leanLabelEl = label;
        this._leanHintEl = hint;
        this._leanRecEl = rec;
        meter.setAttribute("aria-valuenow", "0");
        return overlay;
    }

    /**
     * @returns {number|null} Current lean scale (face width / frame), or null if unknown.
     */
    _getLeanScale() {
        const cv =
            this.robot && typeof this.robot.getProcessingByType === "function"
                ? this.robot.getProcessingByType("computervision")
                : null;
        if (!cv) return null;

        const model = String(cv.model || "").toLowerCase();
        if (model === "blazeface") {
            const raw = typeof cv.faceScale !== "undefined" ? cv.faceScale : cv._faceScale;
            return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
        }
        if (model === "movenet") {
            const poses = typeof cv.poses !== "undefined" ? cv.poses : null;
            const keypoints = poses?.[0]?.keypoints;
            if (!Array.isArray(keypoints) || !keypoints.length) return null;
            const byName = (name) =>
                keypoints.find((kp) => String(kp?.name || "").toLowerCase() === name) || null;
            const left = byName("left_eye");
            const right = byName("right_eye");
            const minScore = 0.15;
            if (
                left &&
                right &&
                (left.score || 0) >= minScore &&
                (right.score || 0) >= minScore &&
                Number.isFinite(Number(left.x)) &&
                Number.isFinite(Number(right.x))
            ) {
                return Math.abs(Number(left.x) - Number(right.x)) * 2.8;
            }
        }
        return null;
    }

    /**
     * Update lean gauge UI.
     * @param {"arm"|"lean"|"recording"|"listen"} phase
     * @param {{ elapsedSec?: number }} [options]
     */
    _updateLeanOverlay(phase, options = {}) {
        const overlay = this._ensureLeanOverlay();
        if (!overlay) return;

        const enter = AgentInterface.LEAN_ENTER_SCALE;
        const floor = AgentInterface.LEAN_GAUGE_FLOOR;
        const scale = this._getLeanScale();
        const denom = Math.max(0.01, enter - floor + 0.12);
        let fillPct = 0;
        if (Number.isFinite(scale)) {
            fillPct = Math.max(0, Math.min(1.15, (scale - floor) / denom)) * 100;
            fillPct = Math.min(100, fillPct);
        }

        if (this._leanFillEl) this._leanFillEl.style.width = `${fillPct}%`;
        const meter = this._leanFillEl?.parentElement;
        if (meter) meter.setAttribute("aria-valuenow", String(Math.round(fillPct)));

        const atTalk = Number.isFinite(scale) && scale >= enter;
        const phaseKey = String(phase || "lean");
        overlay.classList.remove(
            "sensor-camera-lean-overlay--arm",
            "sensor-camera-lean-overlay--leaning",
            "sensor-camera-lean-overlay--ready",
            "sensor-camera-lean-overlay--armed",
            "sensor-camera-lean-overlay--recording",
            "sensor-camera-lean-overlay--listen"
        );

        let label = "";
        let hint = "";
        if (phaseKey === "listen") {
            overlay.classList.add("sensor-camera-lean-overlay--listen");
            label = "Lean back to listen";
            hint = "Stay back while the robot talks — lean in again when it is your turn";
            if (this._leanFillEl) this._leanFillEl.style.width = "0%";
        } else if (phaseKey === "recording") {
            overlay.classList.add("sensor-camera-lean-overlay--recording");
            const sec = Math.max(0, Math.floor(Number(options.elapsedSec) || 0));
            label = "Lean back to listen";
            hint =
                sec > 0
                    ? `Recording ${sec}s — lean back when you are done speaking`
                    : "Recording — lean back when you are done speaking";
        } else if (phaseKey === "arm") {
            overlay.classList.add("sensor-camera-lean-overlay--arm");
            if (!Number.isFinite(scale)) {
                label = "Face the camera";
                hint = "Then lean back so the mic can arm";
            } else if (atTalk || this._isLeanedIn()) {
                label = "Lean back to listen";
                hint = "Move back until the bar drops below the talk mark";
                overlay.classList.add("sensor-camera-lean-overlay--ready");
            } else {
                label = "Ready — lean in to talk";
                hint = "Fill the bar past the talk mark to record";
                overlay.classList.add("sensor-camera-lean-overlay--armed");
            }
        } else {
            // Waiting for lean-in to start recording.
            if (!Number.isFinite(scale)) {
                label = "Face the camera";
                hint = "Lean in until the bar reaches the talk mark";
                overlay.classList.add("sensor-camera-lean-overlay--leaning");
            } else if (atTalk) {
                label = "Hold there…";
                hint = "Keep leaning in — recording will start";
                overlay.classList.add("sensor-camera-lean-overlay--ready");
            } else {
                label = "Lean in to talk";
                hint = "Move closer until the bar reaches the talk mark";
                overlay.classList.add("sensor-camera-lean-overlay--leaning");
            }
        }

        if (this._leanLabelEl) this._leanLabelEl.textContent = label;
        if (this._leanHintEl) this._leanHintEl.textContent = hint;
    }

    /**
     * @param {string} [label]
     */
    _ensureCameraCountdownOverlay(label = "Pose!") {
        const labelText = String(label || "Pose!").trim() || "Pose!";
        if (this._countdownOverlayEl && this._countdownOverlayEl.isConnected) {
            if (this._countdownLabelEl) this._countdownLabelEl.textContent = labelText;
            return this._countdownOverlayEl;
        }
        this._clearCameraCountdownOverlay();
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return null;
        const overlay = document.createElement("div");
        overlay.className = "sensor-camera-countdown-overlay";
        overlay.setAttribute("aria-live", "polite");
        const numberEl = document.createElement("div");
        numberEl.className = "sensor-camera-countdown-number";
        const labelEl = document.createElement("div");
        labelEl.className = "sensor-camera-countdown-label";
        labelEl.textContent = labelText;
        overlay.appendChild(numberEl);
        overlay.appendChild(labelEl);
        frameEl.appendChild(overlay);
        this._countdownOverlayEl = overlay;
        this._countdownNumberEl = numberEl;
        this._countdownLabelEl = labelEl;
        return overlay;
    }

    /**
     * Show a full-frame countdown on the camera (N…1), then clear.
     * @param {number} seconds
     * @param {number} generation Cancel if `_speakGeneration` changes
     * @param {{ label?: string, statusPrefix?: string }} [options]
     * @returns {Promise<boolean>} true if countdown completed for this generation
     */
    async _runCameraCountdown(seconds, generation, options = {}) {
        const total = Math.max(1, Math.round(Number(seconds) || 5));
        const label = String(options.label || "Pose!").trim() || "Pose!";
        const statusPrefix = String(options.statusPrefix || "Pose photo in").trim() || "Pose photo in";
        const overlay = this._ensureCameraCountdownOverlay(label);
        if (!overlay) {
            // No camera UI — still wait so pose timing stays consistent.
            for (let n = total; n >= 1; n--) {
                if (generation !== this._speakGeneration) return false;
                await new Promise((r) => setTimeout(r, 1000));
            }
            return generation === this._speakGeneration;
        }
        try {
            for (let n = total; n >= 1; n--) {
                if (generation !== this._speakGeneration) return false;
                if (this._countdownNumberEl) this._countdownNumberEl.textContent = String(n);
                if (this._statusEl) {
                    this._statusEl.textContent = `${statusPrefix} ${n}…`;
                    this._statusEl.className = "muted";
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            return generation === this._speakGeneration;
        } finally {
            this._clearCameraCountdownOverlay();
        }
    }

    _pickRecorderMimeType() {
        if (typeof MediaRecorder === "undefined") return "";
        for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
            if (MediaRecorder.isTypeSupported(t)) return t;
        }
        return "";
    }

    _extensionForRecorderMime(mime) {
        const m = String(mime || "").toLowerCase();
        if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
        if (m.includes("ogg")) return "ogg";
        if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
        return "webm";
    }

    /**
     * Lean-in-to-speak: BlazeFace faceScale (face box width / frame width) rises when closer.
     * Enter when clearly close; hold uses a looser exit band so brief jitter does not end recording.
     * @param {{ hold?: boolean }} [options]
     * @returns {boolean|null} true/false, or null when face is missing (unknown — not out).
     */
    _isLeanedIn(options = {}) {
        const scale = this._getLeanScale();
        if (!Number.isFinite(scale) || scale <= 0) return null;
        const enterScale = AgentInterface.LEAN_ENTER_SCALE;
        const exitScale = AgentInterface.LEAN_EXIT_SCALE;
        const threshold = options.hold ? exitScale : enterScale;
        return scale >= threshold;
    }

    /**
     * Poll vision until lean-in matches `wantLeanedIn` for a few stable samples.
     * Unknown face frames do not reset the streak.
     * @param {boolean} wantLeanedIn
     * @param {number} generation
     * @param {{ needed?: number, pollMs?: number, onTick?: function, hold?: boolean }} [options]
     * @returns {Promise<boolean>}
     */
    async _waitForStableLeanIn(wantLeanedIn, generation, options = {}) {
        const needed = Math.max(1, Number(options.needed) || 3);
        const pollMs = Math.max(50, Number(options.pollMs) || 100);
        const isActive =
            typeof options.isActive === "function"
                ? options.isActive
                : () => this._agentEnabled && this._isConversationMode();
        let streak = 0;
        while (generation === this._speakGeneration) {
            if (typeof options.onTick === "function") options.onTick();
            if (!isActive()) return false;
            const leaned = this._isLeanedIn({ hold: !!options.hold });
            if (leaned === null) {
                // Keep waiting; do not reset streak on missing/low-confidence frames.
            } else if (leaned === wantLeanedIn) {
                streak += 1;
                if (streak >= needed) return true;
            } else {
                streak = 0;
            }
            await new Promise((r) => setTimeout(r, pollMs));
        }
        return false;
    }

    /**
     * Conversation listen: wait for lean-in, record until lean-out, return blob.
     * @param {number} generation
     * @param {{ isActive?: () => boolean }} [options]
     * @returns {Promise<Blob|null>}
     */
    async _recordMicrophoneWhileLeanedIn(generation, options = {}) {
        if (typeof MediaRecorder === "undefined") {
            throw new Error("MediaRecorder is not supported in this browser.");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone capture is not available.");
        }

        const isActive =
            typeof options.isActive === "function"
                ? options.isActive
                : () => this._agentEnabled && this._isConversationMode();
        const maxRecordMs = 20000;
        let stream = null;
        let mediaRecorder = null;
        const chunks = [];

        const stopTracks = () => {
            if (!stream) return;
            for (const track of stream.getTracks()) {
                try {
                    track.stop();
                } catch (_) {}
            }
            stream = null;
        };

        const finishRecorder = (mimeType) =>
            new Promise((resolve) => {
                const finish = () => {
                    const type = mediaRecorder?.mimeType || mimeType || "audio/webm";
                    resolve(chunks.length ? new Blob(chunks, { type }) : null);
                };
                if (!mediaRecorder || mediaRecorder.state === "inactive") {
                    finish();
                    return;
                }
                mediaRecorder.addEventListener("stop", finish, { once: true });
                try {
                    mediaRecorder.stop();
                } catch (_) {
                    finish();
                }
            });

        try {
            // Rising edge: lean back first (if already close), then lean in to start.
            this._updateLeanOverlay("arm");

            const readyOut = await this._waitForStableLeanIn(false, generation, {
                needed: 3,
                isActive,
                onTick: () => {
                    this._updateLeanOverlay("arm");
                    if (this._statusEl) {
                        const leaned = this._isLeanedIn();
                        this._statusEl.textContent = leaned
                            ? "Lean back to listen — mic arms when you are back…"
                            : Number.isFinite(this._getLeanScale())
                              ? "Ready — lean in to talk…"
                              : "Face the camera, then lean in to talk…";
                        this._statusEl.className = "muted";
                    }
                }
            });
            if (!readyOut) return null;

            const leaned = await this._waitForStableLeanIn(true, generation, {
                needed: 2,
                isActive,
                onTick: () => {
                    this._updateLeanOverlay("lean");
                    if (this._statusEl) {
                        this._statusEl.textContent = "Lean in to talk — fill the bar to the talk mark…";
                        this._statusEl.className = "muted";
                    }
                }
            });
            if (!leaned || generation !== this._speakGeneration || !isActive()) return null;

            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            const mimeType = this._pickRecorderMimeType();
            mediaRecorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);
            mediaRecorder.addEventListener("dataavailable", (ev) => {
                if (ev.data && ev.data.size) chunks.push(ev.data);
            });
            mediaRecorder.start(200);

            this._updateLeanOverlay("recording", { elapsedSec: 0 });
            if (this._statusEl) {
                this._statusEl.textContent = "Recording — lean back to listen when done…";
                this._statusEl.className = "muted";
            }

            // Record until lean-out, cancel, or max duration.
            const startedAt = Date.now();
            const pollMs = 100;
            const neededDown = 8;
            let downStreak = 0;
            let hitMax = false;
            while (generation === this._speakGeneration) {
                if (!isActive()) break;
                const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
                this._updateLeanOverlay("recording", { elapsedSec });
                if (this._statusEl) {
                    this._statusEl.textContent = `Recording ${elapsedSec}s — lean back to listen when done…`;
                    this._statusEl.className = "muted";
                }
                if (Date.now() - startedAt >= maxRecordMs) {
                    hitMax = true;
                    break;
                }
                const stillIn = this._isLeanedIn({ hold: true });
                if (stillIn === false) {
                    downStreak += 1;
                    if (downStreak >= neededDown) break;
                } else if (stillIn === true) {
                    downStreak = 0;
                }
                await new Promise((r) => setTimeout(r, pollMs));
            }

            if (generation !== this._speakGeneration) {
                await finishRecorder(mimeType);
                mediaRecorder = null;
                return null;
            }
            if (hitMax && this._statusEl) {
                this._statusEl.textContent = "Max recording length — transcribing…";
                this._statusEl.className = "muted";
            }

            const blob = await finishRecorder(mimeType);
            mediaRecorder = null;
            return blob;
        } finally {
            if (mediaRecorder && mediaRecorder.state !== "inactive") {
                try {
                    mediaRecorder.stop();
                } catch (_) {}
            }
            stopTracks();
            this._clearLeanOverlay();
        }
    }

    /**
     * After TTS finishes: conversation mode starts lean-in listen; Simon Says queues pose capture.
     * Queued (not nested) so the parent send can finish and new sends are not blocked forever.
     * @param {string} spoken
     */
    async _afterAgentSpoke(spoken) {
        const content = String(spoken || "").trim();
        if (!content || !this._voiceOn) return;
        const finished = await this._speakAsync(content);
        if (!finished || !this._agentEnabled) return;
        if (this._isConversationMode()) {
            this._queueConversationListen(this._speakGeneration);
            return;
        }
        if (!this._isSimonSaysMode()) return;
        this._queueSimonSaysPoseCapture(this._speakGeneration);
    }

    /** Queue next conversation listen after the current send/TTS stack unwinds. */
    _maybeQueueConversationListenAfterTurn() {
        if (!this._agentEnabled || !this._isConversationMode()) return;
        this._queueConversationListen(this._speakGeneration);
    }

    /**
     * @param {number} generation Cancel if `_speakGeneration` changes
     */
    _queueConversationListen(generation) {
        setTimeout(() => {
            void this._runConversationListen(generation);
        }, 0);
    }

    /**
     * Conversation mode: lean-in mic record → Whisper+chat (Groq) or Gemini audio turn.
     * @param {number} generation
     */
    async _runConversationListen(generation) {
        if (generation !== this._speakGeneration) return;
        if (!this._isConversationMode() || !this._agentEnabled) return;
        if (this._conversationListenRunning) return;
        if (this._sendInProgress || this._simonPoseCycleRunning) {
            setTimeout(() => {
                void this._runConversationListen(generation);
            }, 300);
            return;
        }

        this._conversationListenRunning = true;
        this._syncSendButtonState();
        let shouldRetry = false;
        try {
            if (this._statusEl) {
                this._statusEl.textContent =
                    "Lean in to talk — fill the bar to the talk mark. Nothing is sent until you speak.";
                this._statusEl.className = "muted";
            }

            const blob = await this._recordMicrophoneWhileLeanedIn(generation);
            if (generation !== this._speakGeneration || !this._agentEnabled || !this._isConversationMode()) {
                return;
            }
            if (!blob || blob.size < 32) {
                if (this._statusEl) {
                    this._statusEl.textContent = "No audio captured — listening again…";
                    this._statusEl.className = "warn";
                }
                shouldRetry = true;
                return;
            }

            this._apiKey = this._keyInput?.value?.trim() || "";
            const agent = this.getSelectedAgent();
            if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
            if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

            if (this._isGeminiAudioTurn(agent)) {
                const sent = await this._submitGeminiAudioTurnFromBlob(blob, {
                    speechTranscriber: "Gemini audio turn"
                });
                if (!sent) shouldRetry = true;
                return;
            }

            if (
                this._useHostedAi() &&
                typeof window.playBilling?.fetchHostedVoiceTurn === "function"
            ) {
                const sent = await this._submitHostedVoiceTurnFromBlob(blob, {
                    filename: `speech.${this._extensionForRecorderMime(blob.type)}`
                });
                if (!sent && !this._billingPaused) shouldRetry = true;
                return;
            }

            if (this._statusEl) {
                this._statusEl.textContent = "Transcribing…";
                this._statusEl.className = "muted";
            }
            const model = this.getTranscriptionModelLabel();
            let text = "";
            try {
                text = await this.transcribeSpeechBlob(blob, {
                    filename: `speech.${this._extensionForRecorderMime(blob.type)}`
                });
            } catch (err) {
                console.error("Conversation transcription error:", err);
                if (this._statusEl) {
                    this._statusEl.textContent = err?.message || "Transcription failed";
                    this._statusEl.className = "error";
                }
                shouldRetry = true;
                return;
            }
            if (generation !== this._speakGeneration || !this._agentEnabled || !this._isConversationMode()) {
                return;
            }

            text = String(text || "").trim();
            if (!text) {
                if (this._statusEl) {
                    this._statusEl.textContent = "No speech heard — listening again…";
                    this._statusEl.className = "warn";
                }
                shouldRetry = true;
                return;
            }

            if (this._statusEl) {
                this._statusEl.textContent = "Sending transcript…";
                this._statusEl.className = "muted";
            }
            const sent = await this.submitPrompt(text, {
                fromSpeech: true,
                speechTranscriber: `API transcription (${model})`
            });
            if (!sent) shouldRetry = true;
        } catch (err) {
            console.error("Conversation listen error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Conversation listen failed";
                this._statusEl.className = "error";
            }
            shouldRetry = true;
        } finally {
            this._conversationListenRunning = false;
            this._syncSendButtonState();
            if (
                shouldRetry &&
                !this._billingPaused &&
                generation === this._speakGeneration &&
                this._agentEnabled &&
                this._isConversationMode()
            ) {
                setTimeout(() => {
                    if (
                        generation === this._speakGeneration &&
                        this._agentEnabled &&
                        this._isConversationMode()
                    ) {
                        this._queueConversationListen(generation);
                    }
                }, 1500);
            }
        }
    }

    /**
     * @param {number} generation Cancel if `_speakGeneration` changes
     */
    _queueSimonSaysPoseCapture(generation) {
        setTimeout(() => {
            void this._runSimonSaysPoseCapture(generation);
        }, 0);
    }

    /**
     * @param {number} generation
     */
    async _runSimonSaysPoseCapture(generation) {
        if (generation !== this._speakGeneration) return;
        if (!this._isSimonSaysMode() || !this._agentEnabled || !this._voiceOn) return;
        if (this._simonPoseCycleRunning) return;
        if (this._sendInProgress) {
            // Manual/API send in flight — retry once it clears (same generation).
            setTimeout(() => {
                void this._runSimonSaysPoseCapture(generation);
            }, 300);
            return;
        }

        this._simonPoseCycleRunning = true;
        this._syncSendButtonState();
        try {
            if (this._statusEl) {
                this._statusEl.textContent = "Get ready — pose photo in 20…";
                this._statusEl.className = "muted";
            }
            const countdownOk = await this._runCameraCountdown(20, generation);
            if (!countdownOk || generation !== this._speakGeneration || !this._agentEnabled) return;

            this._refreshCurrentCameraImageUrl();
            if (!String(this.currentCameraImageUrl || "").startsWith("data:image")) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Pose photo failed — start the camera first.";
                    this._statusEl.className = "warn";
                }
                return;
            }
            if (this._sendInProgress) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Pose photo skipped — another send is in progress.";
                    this._statusEl.className = "warn";
                }
                return;
            }
            if (this._statusEl) {
                this._statusEl.textContent = "Sending pose image…";
                this._statusEl.className = "muted";
            }
            await this.submitPromptWithRobotState("here is the pose image", {
                contextLabel: "User",
                speechTranscriber: "simon pose",
                forceCameraImage: true
            });
        } catch (err) {
            console.error("Simon Says pose capture error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Pose capture failed";
                this._statusEl.className = "error";
            }
        } finally {
            this._simonPoseCycleRunning = false;
            this._syncSendButtonState();
        }
    }

    _extractSpokenText(contentText, rawText) {
        const content = String(contentText || "").trim();
        if (!content) return "";
        // Only inspect the model content — never the raw HTTP envelope (that is valid JSON
        // with `choices`, and falling through yields "" so TTS stays silent).
        const payload =
            this._tryParseJson(content) || this._extractJsonObjectFromModelText(content);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return content;
        }
        if (Array.isArray(payload.choices) || payload.object === "chat.completion") {
            return content;
        }
        if (typeof payload.message === "string" && payload.message.trim()) {
            return payload.message.trim();
        }
        if (typeof payload.reply === "string" && payload.reply.trim()) {
            return payload.reply.trim();
        }
        if (typeof payload.text === "string" && payload.text.trim()) {
            return payload.text.trim();
        }
        // Agent JSON without a speakable field — don't speak the whole blob.
        if (Object.prototype.hasOwnProperty.call(payload, "actions")) {
            return "";
        }
        return content;
    }

    _buildBodyPlanFromRobotConfig() {
        const cfg = this.robot?.config || {};
        const configuredBodyPlan = this.config?.bodyPlan ?? cfg?.bodyPlan;
        if (configuredBodyPlan != null && String(configuredBodyPlan).trim() !== "") {
            return typeof configuredBodyPlan === "string"
                ? configuredBodyPlan
                : JSON.stringify(configuredBodyPlan, null, 2);
        }
        const bodyPlan = {
            robotName: cfg.name || "unnamed robot",
            actuators: Array.isArray(cfg.actuators)
                ? cfg.actuators.map((a) => ({
                      name: a?.name || "",
                      type: a?.type || "",
                      pin: a?.pin
                  }))
                : [],
            controlInputs: Object.keys(cfg.controlInputs || cfg.inputs || {}),
            sensors: Array.isArray(cfg.sensors)
                ? cfg.sensors.map((s) => (typeof s === "string" ? s : s?.name || s?.type || "sensor"))
                : [],
            joysticks: Array.isArray(cfg.joysticks) ? cfg.joysticks.map((j) => j?.name || "joystick") : []
        };
        return JSON.stringify(bodyPlan, null, 2);
    }

    _buildControlPlanFromRobotConfig() {
        const cfg = this.robot?.config || {};
        const configuredControlPlan = this.config?.controlPlan ?? cfg?.controlPlan;
        if (configuredControlPlan != null && String(configuredControlPlan).trim() !== "") {
            return typeof configuredControlPlan === "string"
                ? configuredControlPlan
                : JSON.stringify(configuredControlPlan, null, 2);
        }
        return "No control plan configured.";
    }

    _buildActionsFromRobotConfig() {
        const actions = Array.isArray(this.robot?.config?.actions) ? this.robot.config.actions : [];
        const forPrompt = actions.map((a) => {
            if (!a || typeof a !== "object") return a;
            return Object.fromEntries(Object.entries(a).filter(([k]) => k !== "functionPath"));
        });
        return JSON.stringify(forPrompt, null, 2);
    }

    _buildActionExamplesFromRobotConfig() {
        const examples = this.robot?.config?.actionExamples;
        if (!Array.isArray(examples) || !examples.length) {
            return "(no examples configured)";
        }
        return examples
            .map((ex, i) => {
                try {
                    return `Example ${i + 1}:\n${JSON.stringify(ex, null, 2)}`;
                } catch (_) {
                    return `Example ${i + 1}:\n${String(ex)}`;
                }
            })
            .join("\n\n");
    }

    _getCameraSensor() {
        return this.robot?.sensors?.find((sensor) => sensor && sensor.type === "camera") || null;
    }

    _captureFrameDataUrl(videoEl) {
        const sourceW = videoEl.videoWidth | 0;
        const sourceH = videoEl.videoHeight | 0;
        if (!sourceW || !sourceH) return null;
        const maxEdge = this.cameraCaptureMaxEdge;
        const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
        const targetW = Math.max(1, Math.round(sourceW * scale));
        const targetH = Math.max(1, Math.round(sourceH * scale));
        if (!this._captureCanvas) this._captureCanvas = document.createElement("canvas");
        if (!this._captureCtx) this._captureCtx = this._captureCanvas.getContext("2d", { willReadFrequently: true });
        if (!this._captureCtx) return null;
        this._captureCanvas.width = targetW;
        this._captureCanvas.height = targetH;
        this._captureCtx.drawImage(videoEl, 0, 0, targetW, targetH);
        const camera = this._getCameraSensor();
        if (
            camera?.wantsNormalizationGrid?.() &&
            typeof PhonebotNormalizationGrid !== "undefined" &&
            PhonebotNormalizationGrid.draw
        ) {
            PhonebotNormalizationGrid.draw(this._captureCtx, targetW, targetH);
        }
        return {
            dataUrl: this._captureCanvas.toDataURL("image/jpeg", this.cameraCaptureJpegQuality),
            width: targetW,
            height: targetH
        };
    }

    _refreshCurrentCameraImageUrl() {
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || videoEl.readyState < 2) {
            this.currentCameraImageUrl = "";
            return;
        }
        const frame = this._captureFrameDataUrl(videoEl);
        this.currentCameraImageUrl = frame?.dataUrl || "";
    }

    _sanitizeStateJsonForPrompt(jsonStr) {
        const raw = String(jsonStr || "").trim();
        if (!raw) return raw;
        try {
            const rows = JSON.parse(raw);
            if (!Array.isArray(rows)) return raw;
            for (const row of rows) {
                if (!row || typeof row !== "object") continue;
                const v = row.value;
                if (typeof v === "string" && v.startsWith("data:image")) {
                    row.value = "[see image attachment on this user message]";
                }
            }
            return JSON.stringify(rows, null, 2);
        } catch (_) {
            return raw;
        }
    }

    _buildCurrentStateForIntroductionPrompt() {
        this._refreshCurrentCameraImageUrl();
        const sm = this.robot?.stateMachine;
        if (sm && typeof sm.getStateAsJson === "function") {
            return this._sanitizeStateJsonForPrompt(sm.getStateAsJson());
        }
        return "";
    }

    /**
     * Appends the current camera frame to the last user message only (full text history, single vision image).
     * @param {Array<{role:string, content: unknown}>} messages
     */
    _attachCurrentCameraToLastUserMessage(messages) {
        const url = String(this.currentCameraImageUrl || "").trim();
        if (!url.startsWith("data:image")) return;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== "user") continue;
            const c = messages[i].content;
            if (Array.isArray(c)) return;
            const textPart = typeof c === "string" ? c : String(c ?? "");
            messages[i].content = [
                { type: "text", text: textPart },
                { type: "image_url", image_url: { url } }
            ];
            return;
        }
    }

    buildInstructionPromptFromTemplate(templateText) {
        const stateJson = this._buildCurrentStateForIntroductionPrompt();
        const template = String(templateText || "");
        return template
            .replace(/\{\{ROBOT_BODY_PLAN\}\}/g, this._buildBodyPlanFromRobotConfig())
            .replace(/\{\{ROBOT_CONTROL_PLAN\}\}/g, this._buildControlPlanFromRobotConfig())
            .replace(/\{\{ROBOT_STATE\}\}/g, stateJson)
            .replace(/\{\{state\}\}/g, stateJson)
            .replace(/\{state\}/g, stateJson)
            .replace(/\{\{ROBOT_ACTIONS\}\}/g, this._buildActionsFromRobotConfig())
            .replace(/\{\{ACTIONS-EXAMPLES\}\}/g, this._buildActionExamplesFromRobotConfig());
    }

    /**
     * Template used for first-turn auto-merge and (when no selection yet) hydrate.
     * Prefers the dropdown selection; otherwise mode `promptTemplate`, then introduction templates —
     * never “first template in the list”, which double-pastes game prompts.
     */
    _getIntroductionTemplateSpec() {
        const list = Array.isArray(this.promptTemplates) ? this.promptTemplates : [];
        const selected = String(this._templateSelect?.value || "").trim();
        if (selected && selected !== AgentInterface.TEMPLATE_VALUE_STATE) {
            const fromSelect = list.find((t) => String(t?.path || "").trim() === selected);
            if (fromSelect) return fromSelect;
        }
        const modeTpl = String(this.robot?._getActiveModeConfig?.()?.promptTemplate || "").trim();
        if (modeTpl) {
            const fromMode =
                list.find((t) => String(t?.path || "").trim() === modeTpl) ||
                list.find((t) => String(t?.name || "").trim().toLowerCase() === modeTpl.toLowerCase());
            if (fromMode) return fromMode;
            return { name: modeTpl, path: modeTpl };
        }
        return (
            list.find((t) => /introImagePrompt\.txt$/i.test(String(t?.path || "").trim())) ||
            list.find((t) => /introductionPrompt\.txt$/i.test(String(t?.path || "").trim())) ||
            list.find((t) => /introduction/i.test(String(t?.name || ""))) ||
            null
        );
    }

    /** First listed file template — used only to pre-fill the textarea, not for silent merge. */
    _getDefaultHydrateTemplateSpec() {
        return (
            this._getIntroductionTemplateSpec() ||
            (Array.isArray(this.promptTemplates) ? this.promptTemplates : []).find((t) =>
                String(t?.path || "").trim()
            ) ||
            null
        );
    }

    /** Loads the introduction template for the first voice turn (no startup send). */
    async _fetchIntroductionPromptContent() {
        const spec = this._getIntroductionTemplateSpec();
        const path = spec && String(spec.path || "").trim();
        if (!path) return "";
        try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) return "";
            const templateText = await res.text();
            return this.buildInstructionPromptFromTemplate(templateText);
        } catch (_) {
            return "";
        }
    }

    async _hydrateDefaultPromptFromIntroductionTemplate() {
        const modeTpl = this.robot?._getActiveModeConfig?.()?.promptTemplate;
        if (modeTpl != null && String(modeTpl).trim()) {
            await this.applyPromptTemplate(modeTpl);
            return;
        }
        const spec = this._getDefaultHydrateTemplateSpec();
        const path = spec && String(spec.path || "").trim();
        if (!path || !this._promptInput || !this._templateSelect) return;
        try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) return;
            const templateText = await res.text();
            this._promptInput.value = this.buildInstructionPromptFromTemplate(templateText);
            this._templateSelect.value = path;
        } catch (_) {
            /* leave textarea empty if file missing or offline */
        }
    }

    async _buildPromptFromSelectedTemplate() {
        const selected = this._templateSelect?.value || "";
        if (!selected) throw new Error("Select a prompt template.");
        if (selected === AgentInterface.TEMPLATE_VALUE_STATE) {
            const block = this._buildCurrentStateForIntroductionPrompt();
            return `Current state (json):\n${block || "[]"}`;
        }
        const res = await fetch(selected, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load template: ${selected}`);
        const templateText = await res.text();
        return this.buildInstructionPromptFromTemplate(templateText);
    }

    async _onInsertTemplate() {
        if (!this._promptInput || !this._insertTemplateBtn) return;
        this._insertTemplateBtn.disabled = true;
        try {
            const prompt = await this._buildPromptFromSelectedTemplate();
            this._promptInput.value = prompt;
            this._promptInput.focus();
            if (this._statusEl) {
                this._statusEl.className = "ok";
                this._statusEl.textContent = "Template inserted.";
            }
        } catch (err) {
            if (this._statusEl) {
                this._statusEl.className = "error";
                this._statusEl.textContent = err?.message || "Template insert failed.";
            }
        } finally {
            this._insertTemplateBtn.disabled = false;
        }
    }

    /**
     * Text sent to the API for one stored history turn.
     * Only the first history turn replays `fullPrompt` (intro + initial state). Later user turns
     * use short `text` so every request does not re-send stale state JSON (which grows fast with
     * Simon Says pose loops and can stall/fail the API with no clear UI error).
     * @param {object} m
     * @param {{ isFirstHistoryTurn?: boolean }} [options]
     */
    _historyTurnToChatContent(m, options = {}) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) return "";
        if (m.role === "assistant") return String(m.text || "");
        const full = typeof m.fullPrompt === "string" ? m.fullPrompt.trim() : "";
        const short = String(m.text || "").trim();
        if (options.isFirstHistoryTurn && full) return full;
        if (short) return short;
        return full;
    }

    /** Prior user/assistant turns for chat API (first user turn keeps intro fullPrompt). */
    _buildPriorConversationMessages() {
        const turns = this.messageHistory.filter(
            (m) => m && (m.role === "user" || m.role === "assistant")
        );
        return turns.map((m, i) => ({
            role: m.role,
            content: this._historyTurnToChatContent(m, { isFirstHistoryTurn: i === 0 })
        }));
    }

    _normalizePromptText(text) {
        return String(text || "")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .trim();
    }

    /**
     * On the first user message of a session, prefix the selected/introduction template so it
     * lives in history. If the User / User said section is already that exact template (hydrated
     * Send), keep a single copy — do not prepend again. Never treat short speech as "intro"
     * just because the template happens to contain those words.
     */
    async _mergeIntroductionIntoFirstUserMessage(fullUserContent, priorLength) {
        const body = String(fullUserContent || "");
        if (priorLength > 0) return body;
        const intro = await this._fetchIntroductionPromptContent();
        const head = this._normalizePromptText(intro);
        if (!head) return body;
        const bodyNorm = this._normalizePromptText(body);
        if (!bodyNorm) return body;

        const userMatch = body.match(/\n(?:User said|User|Robot notice):\n([\s\S]*)$/i);
        const userPart = userMatch ? this._normalizePromptText(userMatch[1]) : "";
        // Exact template-only send (textarea still holds the start prompt).
        if (userPart && userPart === head) {
            const stateMatch = body.match(
                /Current state \(json\):\n[\s\S]*?(?=\n\n(?:User said|User|Robot notice):|$)/i
            );
            const stateBlock = stateMatch ? stateMatch[0].trim() : "";
            return stateBlock ? `${head}\n\n${stateBlock}` : head;
        }

        if (bodyNorm.includes(head)) return body;
        const headPrefix = head.slice(0, Math.min(120, head.length)).trim();
        if (headPrefix.length >= 24 && bodyNorm.includes(headPrefix)) return body;
        return `${head}\n\n${body}`;
    }

    /** True once any user/assistant turn is in history (first lean-in send completed). */
    _hasConversationHistory() {
        return (this.messageHistory || []).some(
            (m) => m && (m.role === "user" || m.role === "assistant")
        );
    }

    /**
     * Lean-in modes must not call the LLM until the person leans in and speaks.
     * Blocks Send / robot notices that would otherwise fire the start prompt alone.
     * @param {string} userText
     * @param {{ fromSpeech?: boolean }} [options]
     * @returns {Promise<boolean>} true if the send may proceed
     */
    async _allowConversationOutbound(userText, options = {}) {
        if (!this._isConversationMode()) return true;
        if (this._hasConversationHistory()) return true;
        if (options.fromSpeech) return true;

        const textNorm = this._normalizePromptText(userText);
        const introNorm = this._normalizePromptText(await this._fetchIntroductionPromptContent());
        const isIntroOnly = !textNorm || (!!introNorm && textNorm === introNorm);
        if (isIntroOnly) {
            if (this._statusEl) {
                this._statusEl.textContent =
                    "Lean in and speak first — your words are sent with the start prompt.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        return true;
    }

    /**
     * @param {string} userText
     * @param {{ singleTurn?: boolean, messages?: Array<{role:string,content:string|unknown}> }} [options]
     * If `messages` is provided, it is sent as-is (then the last user message gets the current camera image if available).
     * If singleTurn, only `userText` is sent as one user message.
     */
    async sendPrompt(userText, options = {}) {
        await this._ensureArcadeAiBudget();
        const agent = this.getSelectedAgent();
        const prompt = String(userText || "").trim();
        if (!agent) {
            throw new Error("No agent selected.");
        }
        const gemini = this._isGeminiProvider(agent);
        const url = gemini ? "" : this._resolveChatUrl(agent);
        if (!gemini && !url) {
            throw new Error("Agent has no chatUrl and no baseUrl+chatPath.");
        }
        const model = this._resolveModel(agent);
        if (!model) {
            throw new Error("Set a model on the agent or use the model override field.");
        }
        const hostedArcadeChat =
            !gemini &&
            this._useHostedAi() &&
            typeof window.playBilling?.fetchHostedChat === "function";
        const apiKey = this._clientApiKey();
        if (!hostedArcadeChat && !apiKey) {
            throw new Error("Enter an API key for this provider.");
        }

        const authHeader = String(agent.authHeader || "Authorization").trim();
        const authPrefix = agent.authPrefix !== undefined ? String(agent.authPrefix) : "Bearer ";
        const singleTurn = !!options.singleTurn;
        const overrideMessages = Array.isArray(options.messages) ? options.messages : null;
        let conversationMessages;
        if (overrideMessages && overrideMessages.length) {
            conversationMessages = overrideMessages.map((m) => ({
                role: m.role,
                content: m.content
            }));
        } else if (singleTurn) {
            if (!prompt) {
                throw new Error("Enter a prompt.");
            }
            conversationMessages = [{ role: "user", content: prompt }];
        } else {
            if (!prompt) {
                throw new Error("Enter a prompt.");
            }
            conversationMessages = this.messageHistory
                .filter((m) => m && (m.role === "user" || m.role === "assistant"))
                .map((m) => ({
                    role: m.role,
                    content:
                        m.role === "user" && typeof m.fullPrompt === "string" && m.fullPrompt.trim()
                            ? m.fullPrompt
                            : String(m.text || "")
                }));

            if (!conversationMessages.length) {
                conversationMessages.push({ role: "user", content: prompt });
            }
        }

        let sendCameraImage;
        if (options.forceCameraImage === true) {
            sendCameraImage = true;
        } else if (options.skipVisionAttachment === true) {
            sendCameraImage = false;
        } else if (this._sendCameraImageInput) {
            sendCameraImage = !!this._sendCameraImageInput.checked;
            this._sendCameraImage = sendCameraImage;
        } else {
            sendCameraImage = !!this._sendCameraImage;
        }
        if (sendCameraImage) {
            this._attachCurrentCameraToLastUserMessage(conversationMessages);
        }

        if (gemini) {
            return await this._sendGeminiChat(agent, conversationMessages, apiKey, model);
        }

        const temperature = Number.isFinite(agent.temperature)
            ? agent.temperature
            : Number.isFinite(this.config.defaultChatTemperature)
              ? this.config.defaultChatTemperature
              : 0.35;
        const responseFormat =
            agent.responseFormat && typeof agent.responseFormat === "object"
                ? agent.responseFormat
                : this.config.chatResponseFormat && typeof this.config.chatResponseFormat === "object"
                  ? this.config.chatResponseFormat
                  : null;

        const body = {
            model,
            messages: conversationMessages,
            temperature,
            max_tokens: Number.isFinite(agent.maxTokens) ? Math.round(agent.maxTokens) : 1024
        };
        if (responseFormat) {
            body.response_format = responseFormat;
        }
        const reasoningEffort = String(agent.reasoningEffort || agent.reasoning_effort || "").trim();
        if (reasoningEffort) {
            body.reasoning_effort = reasoningEffort;
        }
        if (agent.extraBody && typeof agent.extraBody === "object") {
            Object.assign(body, agent.extraBody);
        }

        const headers = {
            "Content-Type": "application/json",
            [authHeader]: `${authPrefix}${apiKey}`
        };
        if (agent.extraHeaders && typeof agent.extraHeaders === "object") {
            for (const [k, v] of Object.entries(agent.extraHeaders)) {
                if (k && v != null) headers[k] = String(v);
            }
        }

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timeoutMs = 90000;
        const timeoutId =
            controller &&
            setTimeout(() => {
                try {
                    controller.abort();
                } catch (_) {}
            }, timeoutMs);
        let res;
        try {
            res = hostedArcadeChat
                ? await window.playBilling.fetchHostedChat(body, controller?.signal)
                : await fetch(url, {
                      method: String(agent.method || "POST").toUpperCase(),
                      headers,
                      body: JSON.stringify(body),
                      signal: controller?.signal
                  });
            if (await window.playBilling?.handlePaymentRequired?.(res, this._billingContext())) {
                this._billingPaused = true;
                throw new Error("AI budget used. Pay to continue.");
            }
        } catch (err) {
            if (err?.name === "AbortError") {
                throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
            }
            throw err;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 500)}`);
        }

        let json;
        try {
            json = JSON.parse(rawText);
        } catch (_) {
            throw new Error("Response was not JSON.");
        }
        const content =
            json?.choices?.[0]?.message?.content ??
            json?.choices?.[0]?.text ??
            json?.message?.content ??
            "";
        const contentText = this._stripThinkingBlocks(String(content || "").trim());
        return {
            rawText,
            json,
            contentText: contentText || JSON.stringify(json, null, 2)
        };
    }

    async _sendGeminiChat(agent, conversationMessages, apiKey, model) {
        if (typeof window.GeminiAudioTurn?.generateContent !== "function") {
            throw new Error("Gemini audio helper is not loaded.");
        }
        const temperature = Number.isFinite(agent.temperature)
            ? agent.temperature
            : Number.isFinite(this.config.defaultChatTemperature)
              ? this.config.defaultChatTemperature
              : 0.35;
        const responseFormat =
            agent.responseFormat && typeof agent.responseFormat === "object"
                ? agent.responseFormat
                : this.config.chatResponseFormat && typeof this.config.chatResponseFormat === "object"
                  ? this.config.chatResponseFormat
                  : null;
        const generationConfig = {
            temperature,
            maxOutputTokens: Number.isFinite(agent.maxTokens) ? Math.round(agent.maxTokens) : 1024,
            thinkingConfig: { thinkingLevel: "minimal" }
        };
        if (responseFormat?.type === "json_object") {
            generationConfig.responseMimeType = "application/json";
        }
        const result = await window.GeminiAudioTurn.generateContent({
            apiKey,
            baseUrl: window.GeminiAudioTurn.resolveBaseUrl(agent, this.defaultBaseUrl),
            model: model || window.GeminiAudioTurn.DEFAULT_MODEL,
            contents: window.GeminiAudioTurn.chatMessagesToContents(conversationMessages),
            generationConfig
        });
        const contentText = this._stripThinkingBlocks(String(result.text || "").trim());
        return {
            rawText: result.rawText,
            json: result.json,
            contentText: contentText || JSON.stringify(result.json, null, 2)
        };
    }

    /** Drop Qwen/Groq raw thinking (`<think>…</think>`) so history/TTS stay short. */
    _stripThinkingBlocks(text) {
        return String(text || "")
            .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
            .replace(/^\s+|\s+$/g, "");
    }

    _tryParseJson(text) {
        const raw = String(text || "").trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    /** Best-effort parse when the model wraps JSON in prose or markdown fences. */
    _extractJsonObjectFromModelText(text) {
        const raw = String(text || "").trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            const candidate = fenceMatch ? fenceMatch[1] : raw;
            const start = candidate.indexOf("{");
            const end = candidate.lastIndexOf("}");
            if (start >= 0 && end > start) {
                try {
                    return JSON.parse(candidate.slice(start, end + 1));
                } catch (_) {
                    return null;
                }
            }
            return null;
        }
    }

    _findNamedItem(list, name) {
        if (!Array.isArray(list)) return null;
        const key = String(name || "").trim().toLowerCase();
        if (!key) return null;
        return list.find((item) => String(item?.name || "").trim().toLowerCase() === key) || null;
    }

    _resolveActionFunction(functionPath) {
        const path = String(functionPath || "").trim();
        if (!path) throw new Error("Action has no functionPath.");
        const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
        if (!parts.length) throw new Error("Invalid functionPath.");

        let current = this.robot;
        for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i];
            const nextSegment = parts[i + 1];

            if (segment === "objectFilters") {
                const filterItem =
                    this.robot?.getObjectFilterByName?.(nextSegment) ||
                    this._findNamedItem(this.robot?.objectFilters, nextSegment);
                if (!filterItem) throw new Error(`Object filter not found: ${nextSegment}`);
                current = filterItem;
                i += 1;
                continue;
            }
            if (segment === "strategies") {
                const strat = this.robot?.strategies;
                if (!strat) throw new Error("Strategies not available on this robot.");
                current = strat;
                i += 1;
                continue;
            }
            if (segment === "aiModels" || segment === "processing") {
                const key = String(nextSegment || "").trim().toLowerCase();
                const list = this.robot?.processing;
                const byType =
                    Array.isArray(list) &&
                    list.find((m) => String(m?.type || "").trim().toLowerCase() === key);
                const model =
                    this.robot?.getProcessingByName?.(nextSegment) ||
                    this._findNamedItem(list, nextSegment) ||
                    this.robot?.getProcessingByType?.(nextSegment) ||
                    byType;
                if (!model) throw new Error(`Processing module not found: ${nextSegment}`);
                current = model;
                i += 1;
                continue;
            }

            if (current == null) {
                throw new Error(`Path segment not found: ${segment}`);
            }
            if (segment in current) {
                current = current[segment];
                continue;
            }
            if (Array.isArray(current)) {
                const named = this._findNamedItem(current, segment);
                if (!named) {
                    throw new Error(`Path segment not found: ${segment}`);
                }
                current = named;
                continue;
            }
            throw new Error(`Path segment not found: ${segment}`);
        }

        const fnName = parts[parts.length - 1];
        const fn = current?.[fnName];
        if (typeof fn !== "function") {
            throw new Error(`Function not found: ${fnName}`);
        }
        return { fn, receiver: current };
    }

    async act(actionName, actionArgs) {
        const actions = Array.isArray(this.robot?.config?.actions) ? this.robot.config.actions : [];
        const match = actions.find((a) =>
            String(a?.actionName || a?.name || "").trim().toLowerCase() === String(actionName || "").trim().toLowerCase()
        );
        if (!match) {
            throw new Error(`Unknown action: ${String(actionName || "")}`);
        }
        if (!match.functionPath) {
            throw new Error(`Action "${match.name}" has no functionPath.`);
        }

        const { fn, receiver } = this._resolveActionFunction(match.functionPath);
        const pathLower = String(match.functionPath || "").toLowerCase();
        if (Array.isArray(actionArgs) && pathLower.endsWith("setfilters")) {
            return await fn.call(receiver, actionArgs);
        }
        if (Array.isArray(actionArgs)) {
            return await fn.apply(receiver, actionArgs);
        }
        return await fn.call(receiver, actionArgs);
    }

    _collectActionsFromPayload(payload) {
        const specs = [];
        const rawActions = payload.actions;
        if (Array.isArray(rawActions)) {
            for (const item of rawActions) {
                if (!item || typeof item !== "object") continue;
                if (Object.prototype.hasOwnProperty.call(item, "actionName")) {
                    const actionName = item.actionName;
                    const actionArgs = Object.prototype.hasOwnProperty.call(item, "actionArgs")
                        ? item.actionArgs
                        : undefined;
                    specs.push({ actionName, actionArgs });
                    continue;
                }
                for (const [actionName, actionArgs] of Object.entries(item)) {
                    if (actionName === "__proto__" || actionName === "constructor") continue;
                    if (!String(actionName || "").trim()) continue;
                    specs.push({ actionName, actionArgs });
                }
            }
            return specs;
        }
        if (rawActions && typeof rawActions === "object") {
            for (const [actionName, actionArgs] of Object.entries(rawActions)) {
                if (!String(actionName || "").trim()) continue;
                specs.push({ actionName, actionArgs });
            }
            return specs;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "actionName")) {
            const actionArgs = Object.prototype.hasOwnProperty.call(payload, "actionArgs")
                ? payload.actionArgs
                : undefined;
            specs.push({ actionName: payload.actionName, actionArgs });
        }
        return specs;
    }

    async _maybeRunActionFromResponse(contentText, rawText) {
        const fromContent = this._tryParseJson(contentText) || this._extractJsonObjectFromModelText(contentText);
        const fromRaw = this._tryParseJson(rawText) || this._extractJsonObjectFromModelText(rawText);
        const payload = fromContent || fromRaw;
        if (!payload || typeof payload !== "object") return;

        const specs = this._collectActionsFromPayload(payload);
        if (!specs.length) return;

        const summaries = [];
        for (const { actionName, actionArgs } of specs) {
            try {
                await this.act(actionName, actionArgs);
                summaries.push(`${String(actionName)} ${JSON.stringify(actionArgs)} ✓`);
            } catch (err) {
                summaries.push(`${String(actionName)} ✗ ${err?.message || "error"}`);
            }
        }
        this.messageHistory.push({
            role: "system",
            text: `Actions run: ${summaries.join(" | ")}`,
            at: new Date().toISOString()
        });
    }

    /**
     * One Gemini audio-turn: this clip (or typed text) + compact text history → transcripts + reply audio.
     * @param {{ audioBlob?: Blob, typedUserText?: string, textHistory?: Array, systemOrIntro?: string, stateJson?: string, voice?: string }} args
     * @returns {Promise<{ userTranscript: string, assistantTranscript: string, audioBlob: Blob|null }>}
     */
    async sendGeminiAudioTurn({
        audioBlob = null,
        typedUserText = "",
        textHistory = null,
        systemOrIntro = "",
        stateJson = "",
        voice = ""
    } = {}) {
        const agent = this.getSelectedAgent();
        if (!agent) throw new Error("No agent selected.");
        if (!this._isGeminiProvider(agent)) {
            throw new Error("Selected agent is not a Gemini provider.");
        }
        if (typeof window.GeminiAudioTurn?.sendAudioTurn !== "function") {
            throw new Error("Gemini audio helper is not loaded.");
        }
        const apiKey = String(this._apiKey || this._keyInput?.value || "").trim();
        if (!apiKey) throw new Error("Enter a Gemini API key (AI Studio, starts with AIza…).");
        return window.GeminiAudioTurn.sendAudioTurn({
            apiKey,
            baseUrl: window.GeminiAudioTurn.resolveBaseUrl(agent, this.defaultBaseUrl),
            model: this._resolveModel(agent) || window.GeminiAudioTurn.DEFAULT_MODEL,
            speechModel: this._resolveSpeechModel(agent),
            audioBlob,
            typedUserText,
            textHistory: Array.isArray(textHistory) ? textHistory : this._buildPriorConversationMessages(),
            systemOrIntro,
            stateJson,
            voice: voice || this._ttsVoice,
            temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.3,
            maxTokens: Number.isFinite(agent.maxTokens) ? agent.maxTokens : 256
        });
    }

    /**
     * Conversation / wake-fallback path: Gemini audio turn, then play returned audio (no Groq).
     * @returns {Promise<boolean>}
     */
    async _submitGeminiAudioTurnFromBlob(blob, options = {}) {
        const speechTranscriber = String(options.speechTranscriber || "Gemini audio turn").trim();
        if (!this._agentEnabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Agent is off. Turn the agent on to send voice prompts.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        // Gemini audio turn is always driven by a lean-in mic clip.
        if (!(await this._allowConversationOutbound("(speech)", { fromSpeech: true }))) {
            return false;
        }
        if (this._sendInProgress) {
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return false;
        }

        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Gemini audio turn…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let replyAudio = null;
        let ok = false;
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const intro = await this._fetchIntroductionPromptContent();
            const prior = this._buildPriorConversationMessages();
            const finaleDue = this._isFortuneTellerFinaleDue();
            const result = await this.sendGeminiAudioTurn({
                audioBlob: blob,
                textHistory: prior,
                systemOrIntro: intro,
                stateJson: stateBlock,
                voice: this._ttsVoice,
                typedUserText: finaleDue ? AgentInterface.FORTUNE_TELLER_FINALE_LINE : ""
            });
            let userTranscript = String(result?.userTranscript || "").trim();
            const assistantTranscript = String(result?.assistantTranscript || "").trim();
            if (!userTranscript) {
                if (this._statusEl) {
                    this._statusEl.textContent = "No speech heard — listening again…";
                    this._statusEl.className = "warn";
                }
                return false;
            }
            if (!assistantTranscript && !(result?.audioBlob && result.audioBlob.size >= 44)) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Gemini returned no reply — listening again…";
                    this._statusEl.className = "error";
                }
                return false;
            }
            if (finaleDue) userTranscript = this._joinFortuneTellerFinale(userTranscript);
            const fullUserContent = `Current state (json):\n${stateBlock || "[]"}\n\nUser said:\n${userTranscript}`;
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            this.messageHistory.push({
                role: "user",
                text: prior.length ? userTranscript : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this.messageHistory.push({
                role: "assistant",
                text: assistantTranscript,
                at: new Date().toISOString()
            });
            if (assistantTranscript) {
                await this._maybeRunActionFromResponse(assistantTranscript, assistantTranscript);
            }
            this._renderHistory();
            spokenForFollowUp = assistantTranscript;
            replyAudio = result?.audioBlob || null;
            if (this._statusEl && !this._voiceOn) {
                this._statusEl.textContent = `Done. (heard you via ${speechTranscriber})`;
                this._statusEl.className = "ok";
            }
            ok = true;
        } catch (err) {
            console.error("Gemini audio turn error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Gemini audio turn failed";
                this._statusEl.className = "error";
            }
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
        if (ok && this._voiceOn && (spokenForFollowUp || replyAudio)) {
            this._stopSpeaking();
            const generation = this._speakGeneration;
            if (replyAudio && replyAudio.size >= 44) {
                await this._speakProvidedAudioBlob(replyAudio, spokenForFollowUp, generation);
            } else if (spokenForFollowUp) {
                await this._speakSynthesizedAsync(spokenForFollowUp, generation);
            }
            if (generation === this._speakGeneration && this._agentEnabled) {
                if (this._isConversationMode()) {
                    this._queueConversationListen(this._speakGeneration);
                } else if (this._isSimonSaysMode()) {
                    this._queueSimonSaysPoseCapture(this._speakGeneration);
                }
            }
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = `Done. (heard you via ${speechTranscriber})`;
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        }
        return ok;
    }

    /**
     * @returns {Promise<boolean>} true if the chat request completed successfully
     */
    async _submitSpeechPrompt(transcript, options = {}) {
        const text = String(transcript || "").trim();
        if (!text) return false;
        const speechTranscriber = String(options.speechTranscriber || "").trim();
        if (!this._agentEnabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Agent is off. Turn the agent on to send voice prompts.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (!(await this._allowConversationOutbound(text, { fromSpeech: true }))) {
            return false;
        }
        if (this._sendInProgress) {
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (this._simonPoseCycleRunning || this._conversationListenRunning) {
            this._stopSpeaking();
        }

        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let ok = false;
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const userText = this._withFortuneTellerFinaleIfDue(text);
            const fullUserContent = `Current state (json):\n${stateBlock || "[]"}\n\nUser said:\n${userText}`;
            const prior = this._buildPriorConversationMessages();
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            const conversationMessages = [...prior, { role: "user", content: outboundUser }];
            this.messageHistory.push({
                role: "user",
                text: prior.length ? userText : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this._renderHistory();
            const reply = await this.sendPrompt("", { messages: conversationMessages });
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                spokenForFollowUp = this._extractSpokenText(reply.contentText, reply.rawText);
                if (this._statusEl && speechTranscriber && spokenForFollowUp) {
                    this._statusEl.textContent = `Speaking… (input: ${speechTranscriber})`;
                    this._statusEl.className = "muted";
                }
            }
            if (this._statusEl && !spokenForFollowUp) {
                this._statusEl.textContent = speechTranscriber ? `Done. (heard you via ${speechTranscriber})` : "Done.";
                this._statusEl.className = "ok";
            }
            ok = true;
        } catch (err) {
            console.error("AgentInterface speech send error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Request failed";
                this._statusEl.className = "error";
            }
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
        if (ok && spokenForFollowUp) {
            await this._afterAgentSpoke(spokenForFollowUp);
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = speechTranscriber ? `Done. (heard you via ${speechTranscriber})` : "Done.";
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        }
        return ok;
    }

    /**
     * Hosted arcade voice turn: one Worker request performs transcription, chat, and TTS.
     * This is never used when the user has entered a BYOK key.
     */
    async _submitHostedVoiceTurnFromBlob(blob, options = {}) {
        if (!this._agentEnabled || !this._useHostedAi()) return false;
        if (this._sendInProgress) return false;

        const agent = this.getSelectedAgent();
        if (!agent || this._isGeminiProvider(agent)) return false;
        const model = this._resolveModel(agent);
        if (!model) throw new Error("Set a model on the agent or use the model override field.");

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Processing voice turn…";
            this._statusEl.className = "muted";
        }

        let result = null;
        let audioBlob = null;
        let ok = false;
        try {
            const marker = `__PHONEBOT_TRANSCRIPT_${crypto.randomUUID()}__`;
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const spokenSlot = this._withFortuneTellerFinaleIfDue(marker);
            const userTemplate = `Current state (json):\n${stateBlock || "[]"}\n\nUser said:\n${spokenSlot}`;
            const prior = this._buildPriorConversationMessages();
            const outboundTemplate = await this._mergeIntroductionIntoFirstUserMessage(
                userTemplate,
                prior.length
            );
            const conversationMessages = [...prior, { role: "user", content: outboundTemplate }];
            if (this._sendCameraImageInput) {
                this._sendCameraImage = !!this._sendCameraImageInput.checked;
            }
            if (this._sendCameraImage) {
                this._attachCurrentCameraToLastUserMessage(conversationMessages);
            }

            const temperature = Number.isFinite(agent.temperature)
                ? agent.temperature
                : Number.isFinite(this.config.defaultChatTemperature)
                  ? this.config.defaultChatTemperature
                  : 0.35;
            const responseFormat =
                agent.responseFormat && typeof agent.responseFormat === "object"
                    ? agent.responseFormat
                    : this.config.chatResponseFormat && typeof this.config.chatResponseFormat === "object"
                      ? this.config.chatResponseFormat
                      : null;
            const chatBody = {
                model,
                messages: conversationMessages,
                temperature,
                max_tokens: Number.isFinite(agent.maxTokens) ? Math.round(agent.maxTokens) : 1024
            };
            if (responseFormat) chatBody.response_format = responseFormat;
            const reasoningEffort = String(
                agent.reasoningEffort || agent.reasoning_effort || ""
            ).trim();
            if (reasoningEffort) chatBody.reasoning_effort = reasoningEffort;
            if (agent.extraBody && typeof agent.extraBody === "object") {
                Object.assign(chatBody, agent.extraBody);
            }

            const form = new FormData();
            form.append("file", blob, String(options.filename || "speech.webm"));
            form.append("filename", String(options.filename || "speech.webm"));
            form.append("transcribeModel", this._resolveTranscriptionModel(agent));
            form.append("chatBody", JSON.stringify(chatBody));
            form.append("transcriptMarker", marker);
            form.append("synthesizeSpeech", this._voiceOn ? "true" : "false");
            form.append("speechModel", this._resolveSpeechModel(agent));
            form.append("voice", this._ttsVoice);

            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timeoutMs = 90000;
            const timeoutId = controller
                ? setTimeout(() => {
                      try {
                          controller.abort();
                      } catch (_) {}
                  }, timeoutMs)
                : null;
            let response;
            try {
                response = await window.playBilling.fetchHostedVoiceTurn(form, controller?.signal);
                if (await window.playBilling.handlePaymentRequired(response, this._billingContext())) {
                    this._billingPaused = true;
                    throw new Error("AI budget used. Pay to continue.");
                }
                const raw = await response.text();
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
                result = JSON.parse(raw);
            } catch (err) {
                if (err?.name === "AbortError") {
                    throw new Error(`Voice turn timed out after ${Math.round(timeoutMs / 1000)}s.`);
                }
                throw err;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }

            const transcript = String(result?.transcript || "").trim();
            if (!transcript) throw new Error("No speech was detected.");
            const userText = this._withFortuneTellerFinaleIfDue(transcript);
            const outboundUser = outboundTemplate.replace(marker, transcript);
            const contentText = String(result?.contentText || "").trim();
            const rawText = JSON.stringify(result?.chat || {});
            this.messageHistory.push({
                role: "user",
                text: prior.length ? userText : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this.messageHistory.push({
                role: "assistant",
                text: contentText,
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(contentText, rawText);
            this._renderHistory();

            if (result?.audioBase64) {
                const binary = atob(result.audioBase64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                audioBlob = new Blob([bytes], { type: result.audioType || "audio/wav" });
            }
            console.info("Hosted voice turn timings (ms):", result?.timingsMs || {});
            window.playBilling?.recordAiCharge?.(result?.chargeCents);
            ok = true;
        } catch (err) {
            console.error("Hosted voice turn error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Hosted voice turn failed";
                this._statusEl.className = "error";
            }
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }

        if (!ok) return false;
        const spokenText = String(result?.spokenText || result?.contentText || "").trim();
        if (this._voiceOn && spokenText) {
            const generation = this._speakGeneration;
            const hostedChunks = Array.isArray(result?.audioChunks) ? result.audioChunks : [];
            try {
                if (hostedChunks.length) {
                    for (let i = 0; i < hostedChunks.length; i++) {
                        if (generation !== this._speakGeneration) break;
                        const entry = hostedChunks[i];
                        const blob = this._blobFromBase64Audio(entry?.base64, entry?.type);
                        if (!blob || blob.size < 44) continue;
                        const partLabel =
                            hostedChunks.length > 1 ? ` (${i + 1}/${hostedChunks.length})` : "";
                        await this._playSpeechBlob(blob, spokenText, generation, {
                            speakingLabel: `Speaking (hosted Groq ${this._ttsVoice})${partLabel}…`,
                            idleLabel: "Hosted arcade voice ready.",
                            playLabel: `Hosted Groq (${this._ttsVoice})${partLabel}`
                        });
                    }
                } else if (audioBlob?.size >= 44) {
                    await this._playSpeechBlob(audioBlob, spokenText, generation, {
                        speakingLabel: `Speaking (hosted Groq ${this._ttsVoice})…`,
                        idleLabel: "Hosted arcade voice ready.",
                        playLabel: `Hosted Groq (${this._ttsVoice})`
                    });
                } else {
                    await this._speakBrowserFallback(spokenText);
                }
            } catch (err) {
                console.warn("Hosted audio playback failed; using browser speech:", err);
                await this._speakBrowserFallback(spokenText);
            }
        }
        if (this._statusEl && this._agentEnabled) {
            this._statusEl.textContent = "Done. (single hosted voice turn)";
            this._statusEl.className = "ok";
        }
        this._maybeQueueConversationListenAfterTurn();
        return true;
    }

    async _onSend() {
        if (!this._sendBtn || !this._promptInput) return;
        if (!this._agentEnabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Agent is off. Turn the agent on to send.";
                this._statusEl.className = "warn";
            }
            return;
        }
        if (this._sendInProgress) {
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return;
        }
        // Manual send wins over an in-progress Simon pose / conversation listen cycle.
        if (this._simonPoseCycleRunning || this._conversationListenRunning) {
            this._stopSpeaking();
        }
        const text = String(this._promptInput.value || "").trim();
        if (!(await this._allowConversationOutbound(text, { fromSpeech: false }))) {
            // _stopSpeaking may have cancelled lean-in listen — resume waiting for speech.
            if (this._agentEnabled && this._isConversationMode()) {
                this._queueConversationListen(this._speakGeneration);
            }
            return;
        }
        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let ok = false;
        try {
            if (!text) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Enter a prompt.";
                    this._statusEl.className = "warn";
                }
                return;
            }
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const userText = this._withFortuneTellerFinaleIfDue(text);
            const fullUserContent = `Current state (json):\n${stateBlock || "[]"}\n\nUser:\n${userText}`;
            const prior = this._buildPriorConversationMessages();
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            this.messageHistory.push({
                role: "user",
                text: prior.length ? userText : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this._renderHistory();
            const conversationMessages = [...prior, { role: "user", content: outboundUser }];
            const reply = await this.sendPrompt("", { messages: conversationMessages });
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                spokenForFollowUp = this._extractSpokenText(reply.contentText, reply.rawText);
            }
            this._promptInput.value = "";
            if (this._statusEl && !spokenForFollowUp) {
                this._statusEl.textContent = "Done.";
                this._statusEl.className = "ok";
            }
            ok = true;
        } catch (err) {
            console.error("AgentInterface send error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Request failed";
                this._statusEl.className = "error";
            }
            spokenForFollowUp = "";
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
        if (ok && spokenForFollowUp) {
            await this._afterAgentSpoke(spokenForFollowUp);
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = "Done.";
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        }
    }

    /**
     * Used by external modules (e.g. SpeechToText model) to submit a prompt.
     * @param {string} text
     * @param {{ fromSpeech?: boolean, speechTranscriber?: string }} [options] If fromSpeech, sends full user/assistant history plus current state and transcript; the introduction template is merged into the first user message only and stored in history. speechTranscriber labels the STT path for status/TTS hints.
     * @returns {Promise<boolean>}
     */
    async submitPrompt(text, options = {}) {
        const next = String(text || "").trim();
        if (!next) return false;
        if (options.fromSpeech) {
            return await this._submitSpeechPrompt(next, options);
        }
        if (!this._agentEnabled) {
            return false;
        }
        if (!this._promptInput) return false;
        this._promptInput.value = next;
        await this._onSend();
        return true;
    }

    /**
     * Same request shape as voice prompts: prior user/assistant history plus one user message that starts with state machine JSON.
     * For proactive robot notices (e.g. strategies) so the model sees current state and conversation context.
     * @param {string} text Short text shown in the history bubble after the first turn (first turn may include merged introduction in the bubble).
     * @param {{ contextLabel?: string, speechTranscriber?: string, forceCameraImage?: boolean }} [options] contextLabel prefixes the payload block (default "Robot notice"). speechTranscriber labels status/TTS hints. forceCameraImage attaches the current camera frame even if the checkbox is off.
     * @returns {Promise<boolean>} false if agent off, empty text, send already in progress, or missing API key / agent
     */
    async submitPromptWithRobotState(text, options = {}) {
        const transcript = String(text || "").trim();
        if (!transcript) return false;
        if (!this._agentEnabled) return false;
        if (!(await this._allowConversationOutbound(transcript, { fromSpeech: false }))) {
            return false;
        }
        if (this._sendInProgress) {
            console.warn("AgentInterface: send already in progress; skipped submitPromptWithRobotState.");
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (
            (this._simonPoseCycleRunning || this._conversationListenRunning) &&
            options.speechTranscriber !== "simon pose"
        ) {
            this._stopSpeaking();
        }

        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        const speechTranscriber = String(options.speechTranscriber || "robot state").trim();
        const label = String(options.contextLabel || "Robot notice").trim() || "Robot notice";

        if (!agent) {
            if (this._statusEl) {
                this._statusEl.textContent = "No agent selected.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (!this._apiKey) {
            if (this._statusEl) {
                this._statusEl.textContent = "Enter an API key to receive robot notifications.";
                this._statusEl.className = "warn";
            }
            return false;
        }

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let ok = false;
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const fullUserContent = `Current state (json):\n${stateBlock || "[]"}\n\n${label}:\n${transcript}`;
            const prior = this._buildPriorConversationMessages();
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            const conversationMessages = [...prior, { role: "user", content: outboundUser }];
            this.messageHistory.push({
                role: "user",
                text: prior.length ? transcript : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this._renderHistory();
            const sendOpts = { messages: conversationMessages };
            if (options.forceCameraImage === true) sendOpts.forceCameraImage = true;
            const reply = await this.sendPrompt("", sendOpts);
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                spokenForFollowUp = this._extractSpokenText(reply.contentText, reply.rawText);
                if (this._statusEl && speechTranscriber && spokenForFollowUp) {
                    this._statusEl.textContent = `Speaking… (${speechTranscriber})`;
                    this._statusEl.className = "muted";
                }
            }
            if (this._statusEl && !spokenForFollowUp) {
                this._statusEl.textContent = speechTranscriber ? `Done. (${speechTranscriber})` : "Done.";
                this._statusEl.className = "ok";
            }
            ok = true;
        } catch (err) {
            console.error("AgentInterface submitPromptWithRobotState error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Request failed";
                this._statusEl.className = "error";
            }
            if (this.messageHistory.length && this.messageHistory[this.messageHistory.length - 1]?.role === "user") {
                this.messageHistory.pop();
            }
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
        if (ok && spokenForFollowUp) {
            await this._afterAgentSpoke(spokenForFollowUp);
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = speechTranscriber ? `Done. (${speechTranscriber})` : "Done.";
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        }
        return ok;
    }

    _renderHistory() {
        if (!this._historyEl) return;
        this._historyEl.replaceChildren();
        /** Full thread (API sends full history too — only provider token limits may trim). */
        for (const m of this.messageHistory) {
            const bubble = document.createElement("div");
            const roleClass = m.role === "user" ? "agent-history-user" : m.role === "system" ? "agent-history-system" : "agent-history-agent";
            bubble.className = "agent-history-bubble " + roleClass;
            const who = document.createElement("span");
            who.className = "agent-history-who";
            who.textContent = m.role === "user" ? "You" : m.role === "system" ? "System" : "Agent";
            const body = document.createElement("div");
            body.className = "agent-history-body";
            let displayText = m.text != null ? String(m.text) : "";
            if (
                m.role === "user" &&
                this._showFullSpeechPrompt &&
                typeof m.fullPrompt === "string" &&
                m.fullPrompt.trim() !== ""
            ) {
                displayText = m.fullPrompt;
            }
            body.textContent = displayText;
            bubble.appendChild(who);
            bubble.appendChild(body);
            this._historyEl.appendChild(bubble);
        }
        this._historyEl.scrollTop = this._historyEl.scrollHeight;
    }

    _syncKeyFromSelection() {
        const agent = this.getSelectedAgent();
        this._apiKey = agent ? this._loadKeyForAgent(agent.name) : "";
        if (this._keyInput) {
            this._keyInput.value = this._apiKey;
        }
        this._voiceOn = this._resolveVoiceDefault(agent);
        if (this._voiceInput) {
            this._voiceInput.checked = this._voiceOn;
        }
        this._syncVoiceUiForSelectedAgent();
        this._syncAiBudgetUi();
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "robot-agent-interface ai-model";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";

        const agentLabel = document.createElement("label");
        agentLabel.textContent = "Agent";
        const agentSelect = document.createElement("select");
        agentSelect.id = "robotAgentSelect";
        if (!this.agents.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no agents in config)";
            agentSelect.appendChild(opt);
            agentSelect.disabled = true;
        } else {
            this.agents.forEach((a, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = a.name || `Agent ${i}`;
                agentSelect.appendChild(opt);
            });
        }
        agentSelect.addEventListener("change", () => this._syncKeyFromSelection());

        const keyLabel = document.createElement("label");
        keyLabel.textContent = "API key (this provider)";
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.placeholder = "sk-… / gsk_… / AIza… (blank = hosted arcade key)";
        // Password managers ignore autocomplete="off"; "new-password" stops them refilling a cleared key.
        keyInput.autocomplete = "new-password";
        keyInput.name = `phonebot-agent-key-${Math.random().toString(36).slice(2)}`;
        keyInput.addEventListener("input", () => {
            this._apiKey = String(keyInput.value || "").trim();
            const agent = this.getSelectedAgent();
            if (agent) this._persistKeyForAgent(agent.name, this._apiKey);
            this._syncAiBudgetUi();
        });

        const clearKeyBtn = document.createElement("button");
        clearKeyBtn.type = "button";
        clearKeyBtn.className = "agent-key-clear-btn";
        clearKeyBtn.textContent = "Clear key (use hosted arcade key)";
        clearKeyBtn.addEventListener("click", () => {
            keyInput.value = "";
            this._apiKey = "";
            const agent = this.getSelectedAgent();
            if (agent) this._persistKeyForAgent(agent.name, "");
            this._syncVoiceUiForSelectedAgent();
            this._syncAiBudgetUi();
            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = "API key cleared.";
            }
        });

        const rememberWrap = document.createElement("label");
        rememberWrap.style.display = "flex";
        rememberWrap.style.alignItems = "center";
        rememberWrap.style.gap = "8px";
        const rememberInput = document.createElement("input");
        rememberInput.type = "checkbox";
        rememberInput.checked = this._rememberKey;
        rememberInput.addEventListener("change", () => {
            this._rememberKey = rememberInput.checked;
        });
        rememberWrap.appendChild(rememberInput);
        rememberWrap.appendChild(document.createTextNode("Remember key for selected agent"));

        const modelLabel = document.createElement("label");
        modelLabel.textContent = "Model override (optional)";
        const modelOverrideInput = document.createElement("input");
        modelOverrideInput.type = "text";
        modelOverrideInput.placeholder = "Leave blank to use agent config model";

        const voiceWrap = document.createElement("label");
        voiceWrap.style.display = "flex";
        voiceWrap.style.alignItems = "center";
        voiceWrap.style.gap = "8px";
        const voiceInput = document.createElement("input");
        voiceInput.type = "checkbox";
        voiceInput.checked = this._voiceOn;
        voiceInput.addEventListener("change", () => {
            this._voiceOn = !!voiceInput.checked;
            if (!this._voiceOn) {
                this._stopSpeaking();
            }
        });
        voiceWrap.appendChild(voiceInput);
        voiceWrap.appendChild(document.createTextNode("Speak agent replies"));

        const voiceSelectLabel = document.createElement("label");
        voiceSelectLabel.textContent = "Voice (Groq Orpheus TTS)";
        const voiceSelect = document.createElement("select");
        voiceSelect.id = "robotAgentTtsVoice";
        voiceSelect.addEventListener("change", () => this._onTtsVoiceChange());

        const voiceStatus = document.createElement("p");
        voiceStatus.className = "muted";
        voiceStatus.style.margin = "4px 0 0";
        voiceStatus.textContent =
            "Groq Orpheus TTS (uses API credits). Long replies play in sequence (200 chars per chunk).";

        const agentPowerBtn = document.createElement("button");
        agentPowerBtn.type = "button";
        agentPowerBtn.textContent = "Turn off agent";
        agentPowerBtn.style.marginTop = "6px";
        agentPowerBtn.style.width = "100%";
        agentPowerBtn.addEventListener("click", () => {
            this._setAgentEnabled(!this._agentEnabled);
        });

        const fullSpeechPromptWrap = document.createElement("label");
        fullSpeechPromptWrap.style.display = "flex";
        fullSpeechPromptWrap.style.alignItems = "center";
        fullSpeechPromptWrap.style.gap = "8px";
        const fullSpeechPromptInput = document.createElement("input");
        fullSpeechPromptInput.type = "checkbox";
        fullSpeechPromptInput.checked = this._showFullSpeechPrompt;
        fullSpeechPromptInput.addEventListener("change", () => {
            this._showFullSpeechPrompt = !!fullSpeechPromptInput.checked;
            this._renderHistory();
        });
        fullSpeechPromptWrap.appendChild(fullSpeechPromptInput);
        fullSpeechPromptWrap.appendChild(
            document.createTextNode("Show full prompt for voice (not just speech text)")
        );

        const templateLabel = document.createElement("label");
        templateLabel.textContent = "Prompt template";
        const templateSelect = document.createElement("select");
        if (!this.promptTemplates.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no prompt templates configured)";
            templateSelect.appendChild(opt);
        } else {
            this.promptTemplates.forEach((tpl) => {
                const opt = document.createElement("option");
                opt.value = String(tpl.path || "");
                opt.textContent = tpl.name || tpl.path || "template";
                templateSelect.appendChild(opt);
            });
        }
        const stateOpt = document.createElement("option");
        stateOpt.value = AgentInterface.TEMPLATE_VALUE_STATE;
        stateOpt.textContent = "Current state (JSON)";
        templateSelect.appendChild(stateOpt);

        const insertTemplateBtn = document.createElement("button");
        insertTemplateBtn.type = "button";
        insertTemplateBtn.textContent = "Insert template";
        insertTemplateBtn.addEventListener("click", () => this._onInsertTemplate());

        const promptLabel = document.createElement("label");
        promptLabel.textContent = "Prompt";
        const promptInput = document.createElement("textarea");
        promptInput.rows = 12;
        promptInput.className = "agent-prompt-input";
        promptInput.style.width = "100%";
        promptInput.style.boxSizing = "border-box";
        promptInput.style.marginTop = "4px";

        const sendCameraWrap = document.createElement("label");
        sendCameraWrap.style.display = "flex";
        sendCameraWrap.style.alignItems = "center";
        sendCameraWrap.style.gap = "8px";
        sendCameraWrap.style.marginTop = "6px";
        const sendCameraImageInput = document.createElement("input");
        sendCameraImageInput.type = "checkbox";
        sendCameraImageInput.checked = this._sendCameraImage;
        sendCameraImageInput.addEventListener("change", () => {
            this._sendCameraImage = !!sendCameraImageInput.checked;
        });
        sendCameraWrap.appendChild(sendCameraImageInput);
        sendCameraWrap.appendChild(document.createTextNode("Send camera image"));

        const sendBtn = document.createElement("button");
        sendBtn.type = "button";
        sendBtn.textContent = "Send";
        sendBtn.addEventListener("click", () => this._onSend());

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Select an agent, enter API key and prompt.";

        const aiBudget = document.createElement("p");
        aiBudget.className = "muted";
        aiBudget.hidden = true;
        aiBudget.style.margin = "4px 0";
        aiBudget.setAttribute("aria-live", "polite");

        const historyLabel = document.createElement("label");
        historyLabel.textContent = "History";
        const historyEl = document.createElement("div");
        historyEl.className = "agent-history-log";
        historyEl.setAttribute("role", "log");
        historyEl.setAttribute("aria-live", "polite");

        controls.appendChild(agentLabel);
        controls.appendChild(agentSelect);
        controls.appendChild(keyLabel);
        controls.appendChild(keyInput);
        controls.appendChild(clearKeyBtn);
        controls.appendChild(rememberWrap);
        controls.appendChild(aiBudget);
        controls.appendChild(modelLabel);
        controls.appendChild(modelOverrideInput);
        controls.appendChild(voiceWrap);
        controls.appendChild(voiceSelectLabel);
        controls.appendChild(voiceSelect);
        controls.appendChild(voiceStatus);
        controls.appendChild(agentPowerBtn);
        controls.appendChild(fullSpeechPromptWrap);
        controls.appendChild(historyLabel);
        controls.appendChild(historyEl);
        controls.appendChild(promptLabel);
        controls.appendChild(promptInput);
        controls.appendChild(sendCameraWrap);
        controls.appendChild(sendBtn);
        controls.appendChild(templateLabel);
        controls.appendChild(templateSelect);
        controls.appendChild(insertTemplateBtn);

        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._containerEl = wrap;
        this._agentSelect = agentSelect;
        this._keyInput = keyInput;
        this._rememberInput = rememberInput;
        this._voiceInput = voiceInput;
        this._voiceSelect = voiceSelect;
        this._voiceSelectLabel = voiceSelectLabel;
        this._voiceStatusEl = voiceStatus;
        this._fullSpeechPromptInput = fullSpeechPromptInput;
        this._modelOverrideInput = modelOverrideInput;
        this._templateSelect = templateSelect;
        this._insertTemplateBtn = insertTemplateBtn;
        this._promptInput = promptInput;
        this._sendCameraImageInput = sendCameraImageInput;
        this._sendBtn = sendBtn;
        this._agentPowerBtn = agentPowerBtn;
        this._statusEl = status;
        this._historyEl = historyEl;
        this._aiBudgetEl = aiBudget;

        this._voiceOn = this._resolveVoiceDefault(this.getSelectedAgent());
        this._voiceInput.checked = this._voiceOn;
        this._syncKeyFromSelection();
        // Browsers restore form values after load; re-assert what we actually stored.
        requestAnimationFrame(() => this._syncKeyFromSelection());
        this._syncVoiceUiForSelectedAgent();
        this._syncAiBudgetUi();
        this._syncSendButtonState();
        void this._hydrateDefaultPromptFromIntroductionTemplate();
    }

    destroy() {
        this._stopSpeaking();
        window.removeEventListener("phonebot:ai-budget", this._aiBudgetListener);
        if (this._containerEl && this._containerEl.parentNode) {
            this._containerEl.parentNode.removeChild(this._containerEl);
        }
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._voiceInput = null;
        this._voiceSelect = null;
        this._voiceSelectLabel = null;
        this._voiceStatusEl = null;
        this._fullSpeechPromptInput = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendCameraImageInput = null;
        this._sendBtn = null;
        this._agentPowerBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this._aiBudgetEl = null;
        this.messageHistory = [];
    }
}

window.AgentInterface = AgentInterface;
