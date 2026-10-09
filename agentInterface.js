/**
 * Manages Groq LLM chat agents (base URL, path, model, API key).
 * Models for chat / vision / STT / TTS are selected once per mode session
 * via groqModelSelect.js (BYOK list or hosted Worker session).
 */
class AgentInterface {
    static STORAGE_KEY_PREFIX = "phonebot.agent.";
    static STORAGE_REMEMBER = "phonebot.agent.remember";
    /** Manual Groq chat model for BYOK; empty = automatic pick. */
    static STORAGE_CHAT_MODEL = "phonebot.agent.chatModel";
    /** Telnyx picks (`stt`, `chat`, `voice`) are saved under this prefix; empty = the agent's default (chat: Auto). */
    static STORAGE_TELNYX_PREFIX = "phonebot.telnyx.";
    /** Telnyx chat models tried per turn before giving up. */
    static TELNYX_CHAT_ATTEMPTS = 3;
    /** Telnyx streaming speech-to-text models tried per turn before giving up. */
    static TELNYX_STT_ATTEMPTS = 3;
    /** Telnyx voices tried per turn before giving up. */
    static TELNYX_VOICE_ATTEMPTS = 3;
    /** Keep streaming briefly after finger-up; the Worker adds its own silence tail for the recogniser. */
    static TELNYX_RELEASE_TAIL_MS = 200;
    /** Per-model sampling temperatures, used only for manually picked models. First match wins. */
    static MODEL_TEMPERATURES = [
        { match: /gpt-oss/i, temperature: 0.7 },
        { match: /qwen/i, temperature: 0.6 }
    ];
    /** Sentinel `<select>` value: insert live state JSON (not a file path). */
    static TEMPLATE_VALUE_STATE = "__robot_state_json__";
    /** Heading for text a game sends, so the model never takes it for something the player said. */
    static GAME_INSTRUCTION_LABEL = "Game instruction (not said by the player)";
    /** Appended to the outgoing user message only; never stored in history. */
    static SINGLE_TURN_REMINDER = "Reply with one turn only, then stop and wait for the player's answer.";

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
            : window.GroqTts?.resolveVoice?.() || "austin";
        this._speakGeneration = 0;
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._voiceInput = null;
        this._voiceSelect = null;
        this._voiceSelectLabel = null;
        this._voiceStatusEl = null;
        this._chatModelRow = null;
        this._chatModelSelect = null;
        this._chatModelRefreshBtn = null;
        this._chatModelHintEl = null;
        this._chatModelChoice = this._loadChatModelChoice();
        /** Last BYOK model list: options for the picker and the automatic pick's id. */
        this._chatModelOptions = [];
        this._chatModelAutoId = null;
        this._chatModelListError = "";
        this._telnyxRow = null;
        this._telnyxSttSelect = null;
        this._telnyxChatSelect = null;
        this._telnyxVoiceSelect = null;
        this._telnyxRefreshBtn = null;
        this._telnyxHintEl = null;
        /** Live lists from the player's Telnyx account (key in `_telnyxListsKey`). */
        this._telnyxLists = { stt: [], chat: [], voices: [], skippedUltra: 0 };
        this._telnyxListsKey = "";
        this._telnyxListsToken = 0;
        this._telnyxListsLoading = false;
        this._telnyxListError = "";
        this._telnyxListsTimer = 0;
        /** @type {Promise<void>|null} */
        this._telnyxListsPromise = null;
        /** Telnyx key typed this session, kept for Telnyx voices while another agent is selected. */
        this._telnyxSessionKey = "";
        /** Telnyx chat models that failed this session; Auto skips them. */
        this._telnyxBadModels = new Set();
        /** Telnyx streaming speech-to-text models ("provider|model") that failed this session. */
        this._telnyxBadStt = new Set();
        /** Telnyx voices that failed this session. */
        this._telnyxBadVoices = new Set();
        /** What answered this session, for `telnyxPreferences()`. */
        this._telnyxWorked = { chat: new Set(), stt: new Set(), voice: new Set() };
        /** The active character's voice, set by the robot; null when no character (or it keeps the current voice). */
        this._characterVoice = null;
        if (window.TelnyxVoice) window.TelnyxVoice.keySource = () => this.telnyxApiKey();
        window.telnyxPreferences = () => this.telnyxPreferences();
        /** Streamed hold-to-talk turn in progress (capturing or waiting for the reply). */
        this._telnyxTurn = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        /** Sparse ChatGPT-style chat under the talking-head video. */
        this._dashboardChatEl = null;
        this._dashboardHistoryEl = null;
        this._dashboardPromptInput = null;
        this._dashboardMicBtn = null;
        this._showFullSpeechPrompt = false;
        this._fullSpeechPromptInput = null;
        this._agentEnabled = true;
        this._sendInProgress = false;
        /** True while conversation-mode timed mic capture / transcribe is running. */
        this._conversationListenRunning = false;
        this._billingPaused = false;
        /**
         * Text send blocked by missing AI credit ("Not now"); resent once a key is entered or credit is added.
         * @type {{ text: string, typed: boolean, options: object, modeGeneration: number }|null}
         */
        this._pendingSend = null;
        this._pendingKeyTimer = 0;
        this._aiBudgetEl = null;
        /** Resolved once per mode/session: { chat, vision, stt, tts }. */
        this._sessionModels = null;
        this._sessionModelsPromise = null;
        this._aiBudgetListener = () => {
            this._syncAiBudgetUi();
            if (this._isTelnyxProvider()) void this._loadTelnyxLists();
            void this._resumePendingSend();
        };
        window.addEventListener("phonebot:ai-budget", this._aiBudgetListener);
        this._passwordHandler = (password) => this._applyPasswordFromPaywall(password);
        window.playBilling?.setPasswordHandler?.(this._passwordHandler);
        this._agentPowerBtn = null;
        /** When true, attach current camera JPEG to the last user message on send. */
        this._sendCameraImage = this.config.sendCameraImage !== false;
        this._sendCameraImageInput = null;
        /** DOM overlay for camera countdown (photo send). */
        this._countdownOverlayEl = null;
        this._countdownNumberEl = null;
        this._countdownLabelEl = null;
        /** requestAnimationFrame id driving the countdown clock sweep. */
        this._countdownSweepRaf = 0;
        /** White shutter flash on the camera frame when a photo is taken. */
        this._shutterOverlayEl = null;
        /** Bumps to cancel an in-flight photo countdown/flicker. */
        this._photoOverlayGeneration = 0;
        /** Hold-to-talk overlay on the camera frame (conversation + Parrot). */
        this._pttOverlayEl = null;
        this._pttBtnEl = null;
        this._pttLabelEl = null;
        this._pttState = "hidden";
        this._pttRecording = false;
        this._pttFinishing = false;
        this._pttFinishToken = 0;
        this._pttRecordStream = null;
        this._pttMediaRecorder = null;
        this._pttRecordChunks = [];
        this._pttRecordStartedAt = 0;
        this._pttMaxTimer = null;
        this._pttWaitResolve = null;
        this._pttWaitGeneration = 0;
        /** Cancels in-flight mode auto-start when the mode changes again. */
        this._modeStartGeneration = 0;
        /**
         * Talking-head reasoning_effort set by a prompt (e.g. Custom prompt actions). Applies to
         * every later send until another prompt changes it; cleared on mode change.
         * @type {"low"|"medium"|"high"|null}
         */
        this._reasoningEffort = null;
        this._loadSavedKeyPreference();
        this._voiceOn = this._resolveVoiceDefault(null);
    }

  static PTT_MIN_HOLD_MS = 250;
    /** Keep capturing after finger-up so the last words aren't cut off. */
    static PTT_RELEASE_TAIL_MS = 500;
    static PTT_MAX_RECORD_MS = 20000;

    /** True when a hold-to-talk game is active (Custom runs every JSON game). */
    _isConversationMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "custom";
    }

    /** Custom Messages game — its prompt actions carry their own instructions. */
    _isCustomMessagesMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "custom";
    }

    /**
     * Called when the robot mode select changes (or after GUI build).
     * Prompt-template games auto-send so the robot talks first; Parrot only arms hold-to-talk.
     * @param {string} [_modeId]
     */
    onRobotModeChanged(_modeId) {
        this._stopSpeaking();
        this._modeStartGeneration += 1;
        this._pendingSend = null;
        this._sessionModels = null;
        this._sessionModelsPromise = null;
        this._reasoningEffort = null;
        // Fresh transcript per game (Custom included — re-selecting Custom after leaving wipes prior chat).
        this.messageHistory = [];
        this._renderHistory();
        const generation = this._modeStartGeneration;
        if (this._isSimonSaysPoseMatchMode()) return;
        if (this._modeHasPromptTemplate()) {
            void this._kickOffPromptTemplateGame({ generation, clearHistory: false });
            return;
        }
        if (this._agentEnabled && this._usesPttInput()) {
            this._armConversationPtt();
        } else {
            this._clearPttOverlay();
        }
    }

    /**
     * Resolve Groq chat/vision/STT/TTS once for this mode session (hosted or BYOK).
     * @returns {Promise<{ chat: string|null, vision: string|null, stt: string|null, tts: string|null }|null>}
     */
    async ensureSessionGroqModels() {
        if (this._isTelnyxProvider()) return null;
        if (this._sessionModels) return this._sessionModels;
        if (this._sessionModelsPromise) return this._sessionModelsPromise;

        this._sessionModelsPromise = (async () => {
            const apiKey = this._clientApiKey();
            // The player's own key wins over a hosted credit session still active on this page.
            const hosted = apiKey ? null : window.playBilling?.getActiveSession?.()?.groqModels;
            if (hosted?.chat || hosted?.stt || hosted?.tts) {
                this._sessionModels = {
                    chat: hosted.chat || null,
                    vision: hosted.vision || hosted.chat || null,
                    stt: hosted.stt || null,
                    tts: hosted.tts || null
                };
                this._applySessionModelsToRuntime(this._sessionModels);
                return this._sessionModels;
            }

            const select = window.GroqModelSelect;
            if (!apiKey || typeof select?.fetchGroqModels !== "function") {
                return null;
            }
            try {
                const models = await select.fetchGroqModels(apiKey);
                this._chatModelOptions = select.listChatModelOptions(models);
                this._chatModelAutoId = select.selectGroqModels(models).chat;
                this._chatModelListError = "";
                this._renderChatModelOptions();
                this._syncChatModelUi();
                const choice = this._chatModelChoice;
                const selected = select.selectGroqModels(models, { overrides: { chat: choice } });
                this._sessionModels = {
                    chat: selected.chat || null,
                    vision: selected.vision || null,
                    stt: selected.stt || null,
                    tts: selected.tts || null
                };
                this._applySessionModelsToRuntime(this._sessionModels);
                if (this._statusEl && this._sessionModels.chat) {
                    const bits = [
                        this._sessionModels.chat && `chat ${this._sessionModels.chat}`,
                        this._sessionModels.vision && `vision ${this._sessionModels.vision}`,
                        this._sessionModels.stt && `stt ${this._sessionModels.stt}`,
                        this._sessionModels.tts && `tts ${this._sessionModels.tts}`
                    ].filter(Boolean);
                    const missing =
                        choice && selected.chat !== choice ? ` (${choice} unavailable, using automatic pick)` : "";
                    this._statusEl.textContent = `Groq models: ${bits.join(" · ")}${missing}`;
                }
                return this._sessionModels;
            } catch (err) {
                this._chatModelListError = String(err?.message || err);
                this._syncChatModelUi();
                if (this._statusEl) {
                    this._statusEl.textContent = `Groq model select failed: ${this._chatModelListError}`;
                }
                return null;
            }
        })();

        try {
            return await this._sessionModelsPromise;
        } finally {
            this._sessionModelsPromise = null;
        }
    }

    _applySessionModelsToRuntime(models) {
        if (!models) return;
        for (const agent of this.agents) {
            if (!agent || typeof agent !== "object") continue;
            if (this._isGeminiProvider(agent) || this._isTelnyxProvider(agent)) continue;
            if (models.chat) agent.model = models.chat;
            if (models.stt) agent.transcriptionModel = models.stt;
            if (models.tts) agent.speechModel = models.tts;
        }
        if (models.stt) this.config.transcriptionModel = models.stt;
        if (models.tts) this.config.speechModel = models.tts;

        const vision =
            typeof this.robot?.getProcessingByType === "function"
                ? this.robot.getProcessingByType("groqvision")
                : null;
        if (vision && models.vision) {
            vision.model = models.vision;
            if (vision._modelInput) vision._modelInput.value = models.vision;
            try {
                localStorage.setItem("phonebot.groq.model", models.vision);
            } catch (_) {}
        }
    }

    _sessionChatModel(wantVision) {
        const m = this._sessionModels;
        if (!m) return null;
        if (wantVision && m.vision) return m.vision;
        return m.chat || null;
    }

    /** Active mode declares an LLM start prompt (not Parrot). */
    _modeHasPromptTemplate() {
        return !!String(this.robot?._getActiveModeConfig?.()?.promptTemplate || "").trim();
    }

    /** Conversation games and Parrot use the hold-to-talk button. */
    _usesPttInput() {
        return this._isConversationMode() || this._isParrotMode();
    }

    /**
     * Load the mode prompt and send it so the robot opens the game.
     * @param {{ generation?: number, clearHistory?: boolean }} [options]
     */
    async _kickOffPromptTemplateGame(options = {}) {
        const generation =
            Number.isFinite(options.generation) && options.generation > 0
                ? options.generation
                : ++this._modeStartGeneration;
        if (!this._agentEnabled || !this._modeHasPromptTemplate()) {
            if (this._usesPttInput() && this._agentEnabled) this._armConversationPtt();
            else this._clearPttOverlay();
            return;
        }
        if (options.clearHistory) {
            this.messageHistory = [];
            this._renderHistory();
        }
        await this.ensureSessionGroqModels();
        if (generation !== this._modeStartGeneration || !this._agentEnabled) return;
        const modeTpl = String(this.robot?._getActiveModeConfig?.()?.promptTemplate || "").trim();
        if (modeTpl) {
            await this.applyPromptTemplate(modeTpl);
        }
        if (generation !== this._modeStartGeneration || !this._agentEnabled) return;

        // Let a previous mode's in-flight send finish (it discards itself via modeGeneration).
        const waitStarted = Date.now();
        while (this._sendInProgress && Date.now() - waitStarted < 60000) {
            if (generation !== this._modeStartGeneration) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (generation !== this._modeStartGeneration || !this._agentEnabled) return;

        const text = String(this._promptInput?.value || "").trim();
        if (!text) {
            if (this._usesPttInput()) this._armConversationPtt();
            else this._clearPttOverlay();
            return;
        }
        if (this._isConversationMode()) {
            this._ensurePttOverlay();
            this._setPttState("thinking");
        } else {
            this._clearPttOverlay();
        }
        await this._onSend({ isKickoff: true, modeGeneration: generation, text });
        if (generation !== this._modeStartGeneration) return;
        if (this._isConversationMode() && this._agentEnabled && !this._hasConversationHistory()) {
            this._armConversationPtt();
        }
    }

    /** Local MoveNet + agent-TTS Simon Says (no chat LLM). */
    _isSimonSaysPoseMatchMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "simonsaysposematch";
    }

    /** Local hold-to-talk echo (no LLM / TTS). */
    _isParrotMode() {
        return String(this.robot?.mode || "").trim().toLowerCase() === "parrot";
    }

    /**
     * Hold-to-talk mic capture for local games (e.g. Parrot).
     * Cancels when `isActive()` is false or speaking is stopped.
     * @param {{ isActive?: () => boolean }} [options]
     * @returns {Promise<Blob|null>}
     */
    async captureHoldRecording(options = {}) {
        const generation = this._speakGeneration;
        const isActive =
            typeof options.isActive === "function"
                ? () => generation === this._speakGeneration && !!options.isActive()
                : () => generation === this._speakGeneration;
        return this._recordMicrophoneWhileHeld(generation, { isActive });
    }

    /** @deprecated Use captureHoldRecording */
    async captureLeanInRecording(options = {}) {
        return this.captureHoldRecording(options);
    }

    _billingContext() {
        return { robotSlug: this.robot?._robotSlug?.() };
    }

    /** The key field is the source of truth, so clearing it drops any remembered key. */
    _clientApiKey() {
        if (this._keyInput) return String(this._keyInput.value || "").trim();
        return String(this._apiKey || "").trim();
    }

    hasClientApiKey() {
        return !!this._clientApiKey();
    }

    /** Without a key of their own, Groq and Telnyx agents use hosted AI credit (Gemini has no hosted path). */
    _useHostedAi() {
        if (this._clientApiKey() || !window.playBilling) return false;
        return !this._isGeminiProvider();
    }

    /** Hosted credit on the Groq agents' Worker routes; Telnyx has its own (`_telnyxAccess`). */
    _useHostedGroq() {
        return this._useHostedAi() && !this._isTelnyxProvider();
    }

    /** True while the play session is active with credit left. */
    _hostedCreditLeft() {
        const session = window.playBilling?.getActiveSession?.();
        const budget = Math.max(0, Number(session?.aiBudgetCents) || 0);
        const spent = Math.max(0, Number(session?.aiSpentCents) || 0);
        return session?.status === "active" && budget - spent > 0;
    }

    /** Before any hosted AI request: shows the top-up popup when credit is $0. */
    async _ensureHostedAiCredit() {
        if (!this._useHostedAi()) return;
        const sessionBefore = window.playBilling.getActiveSessionId();
        const allowed = await window.playBilling.ensureAiCredit(this._billingContext());
        // A password entered on the popup switches this request to the player's own key.
        if (!allowed && this._clientApiKey()) {
            this._billingPaused = false;
            return;
        }
        this._billingPaused = !allowed;
        if (!allowed) {
            throw AgentInterface._creditRequiredError("Top up AI credit to continue.");
        }
        if (window.playBilling.getActiveSessionId() !== sessionBefore) {
            this._sessionModels = null;
        }
    }

    static CREDIT_REQUIRED = "AI_CREDIT_REQUIRED";

    static _creditRequiredError(message) {
        const err = new Error(message);
        err.code = AgentInterface.CREDIT_REQUIRED;
        return err;
    }

    /** True when a send can go out now: a key of their own, or hosted credit left. */
    async _aiAvailableForPendingSend() {
        if (this._clientApiKey()) {
            if (this._isGeminiProvider() || this._isTelnyxProvider()) return true;
            if (typeof window.GroqModelSelect?.fetchAndSelectGroqModels !== "function") return true;
            // Model lookup fails on a bad or half-typed key; keep waiting rather than burn the prompt.
            return !!(await this.ensureSessionGroqModels());
        }
        if (!this._useHostedAi()) return false;
        const session = window.playBilling.getActiveSession();
        const budget = Math.max(0, Number(session?.aiBudgetCents) || 0);
        const spent = Math.max(0, Number(session?.aiSpentCents) || 0);
        return budget - spent > 0;
    }

    async _resumePendingSend() {
        const pending = this._pendingSend;
        if (!pending || this._sendInProgress || !this._agentEnabled) return;
        if (pending.modeGeneration !== this._modeStartGeneration) {
            this._pendingSend = null;
            return;
        }
        if (!(await this._aiAvailableForPendingSend())) return;
        if (this._pendingSend !== pending || this._sendInProgress || !this._agentEnabled) return;
        if (pending.modeGeneration !== this._modeStartGeneration) {
            this._pendingSend = null;
            return;
        }
        this._pendingSend = null;
        if (pending.typed) {
            // Typed text stayed in the chat box; send whatever is there now (they may have edited it).
            if (!this._readPromptText()) return;
            await this._onSend({ ...pending.options, resumed: true });
            return;
        }
        await this._onSend({
            ...pending.options,
            text: pending.text,
            modeGeneration: pending.modeGeneration,
            resumed: true
        });
    }

    _schedulePendingResumeForKey() {
        clearTimeout(this._pendingKeyTimer);
        if (!this._pendingSend) return;
        this._pendingKeyTimer = setTimeout(() => {
            this._pendingKeyTimer = 0;
            void this._resumePendingSend();
        }, 800);
    }

    _setClientApiKey(key) {
        this._apiKey = String(key || "").trim();
        if (this._keyInput) this._keyInput.value = this._apiKey;
        const agent = this.getSelectedAgent();
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);
        this._sessionModels = null;
        this._sessionModelsPromise = null;
        this._syncAiBudgetUi();
        this._syncChatModelUi();
    }

    /**
     * Payment popup "Password": the player's own Groq key. Checked against Groq before it replaces
     * hosted credit; a held send then goes out on the key.
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    async _applyPasswordFromPaywall(password) {
        const key = String(password || "").trim();
        if (!key) return { ok: false, error: "Enter a password." };
        if (
            !this._isGeminiProvider() &&
            !this._isTelnyxProvider() &&
            typeof window.GroqModelSelect?.fetchAndSelectGroqModels === "function"
        ) {
            try {
                await window.GroqModelSelect.fetchAndSelectGroqModels(key);
            } catch (_) {
                return { ok: false, error: "That password didn't work." };
            }
        }
        this._setClientApiKey(key);
        if (this._isTelnyxProvider()) void this._loadTelnyxLists();
        void this.ensureSessionGroqModels();
        void this._resumePendingSend();
        return { ok: true };
    }

    _syncAiBudgetUi() {
        if (!this._aiBudgetEl) return;
        if (!window.playBilling) {
            this._aiBudgetEl.hidden = true;
            return;
        }
        this._aiBudgetEl.hidden = false;
        if (this._clientApiKey()) {
            this._aiBudgetEl.textContent = "Hosted AI quota: BYOK active — 0% used.";
            this._aiBudgetEl.className = "ok";
            return;
        }
        const session = window.playBilling.getActiveSession();
        const budget = Math.max(0, Number(session?.aiBudgetCents) || 0);
        const spent = Math.min(budget, Math.max(0, Number(session?.aiSpentCents) || 0));
        const percent = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
        const format = (cents) =>
            window.playBilling?.formatPrice?.(cents, session?.currency || "aud") ??
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
            this._modeStartGeneration += 1;
            this._pendingSend = null;
            this._clearPttOverlay();
        } else if (this._modeHasPromptTemplate() && !this._hasConversationHistory()) {
            void this._kickOffPromptTemplateGame({ clearHistory: false });
        } else if (this._usesPttInput()) {
            this._armConversationPtt();
        } else {
            this._clearPttOverlay();
        }
        this._syncSendButtonState();
    }

    _syncSendButtonState() {
        if (!this._sendBtn) return;
        this._sendBtn.disabled =
            this._sendInProgress ||
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

    _loadChatModelChoice() {
        try {
            return String(localStorage.getItem(AgentInterface.STORAGE_CHAT_MODEL) || "").trim();
        } catch (_) {
            return "";
        }
    }

    _setChatModelChoice(id) {
        this._chatModelChoice = String(id || "").trim();
        try {
            if (this._chatModelChoice) {
                localStorage.setItem(AgentInterface.STORAGE_CHAT_MODEL, this._chatModelChoice);
            } else {
                localStorage.removeItem(AgentInterface.STORAGE_CHAT_MODEL);
            }
        } catch (_) {}
        this._sessionModels = null;
        this._sessionModelsPromise = null;
        void this.ensureSessionGroqModels();
    }

    _renderChatModelOptions() {
        const selectEl = this._chatModelSelect;
        if (!selectEl) return;
        const price = (usd) => `$${usd.toFixed(2)}`;
        selectEl.replaceChildren();
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = this._chatModelAutoId ? `Automatic (${this._chatModelAutoId})` : "Automatic (cheapest)";
        selectEl.appendChild(auto);
        for (const m of this._chatModelOptions) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent =
                `${m.id} — ${price(m.inputUsdPerMillion)} in / ${price(m.outputUsdPerMillion)} out per M` +
                (m.vision ? " · vision" : "");
            selectEl.appendChild(opt);
        }
        const choice = this._chatModelChoice;
        if (choice && !this._chatModelOptions.some((m) => m.id === choice)) {
            const opt = document.createElement("option");
            opt.value = choice;
            opt.textContent = this._chatModelOptions.length ? `${choice} (not available)` : `${choice} (saved)`;
            selectEl.appendChild(opt);
        }
        selectEl.value = choice;
    }

    /** The picker only applies to the player's own Groq key; hosted credit keeps the Worker's pick. */
    _syncChatModelUi() {
        if (!this._chatModelSelect) return;
        if (this._chatModelRow) this._chatModelRow.hidden = this._isGeminiProvider() || this._isTelnyxProvider();
        const byok = !!this._clientApiKey();
        this._chatModelSelect.disabled = !byok;
        if (this._chatModelRefreshBtn) this._chatModelRefreshBtn.disabled = !byok;
        if (this._chatModelHintEl) {
            this._chatModelHintEl.textContent = !byok
                ? "Enter your own Groq key to choose a model. Hosted credit uses the automatic pick."
                : this._chatModelListError
                  ? `Couldn't load the model list: ${this._chatModelListError}`
                  : !this._chatModelOptions.length
                    ? "Model list not loaded yet. Click Refresh models."
                    : "Applies to this browser's Groq key. Vision-capable picks also handle camera turns.";
        }
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

    _isTelnyxProvider(agent = this.getSelectedAgent()) {
        return String(agent?.provider || "").trim().toLowerCase() === "telnyx";
    }

    _isTelnyxVoiceId(voiceId) {
        return !!window.TelnyxVoice?.isVoiceId?.(voiceId);
    }

    /**
     * Telnyx pick saved from the agent panel; empty means Auto (the agent's voice for `voice`).
     * `stt` values are "provider|model".
     * @param {"stt"|"chat"|"voice"} kind
     */
    _telnyxChoice(kind, _agent) {
        try {
            return String(localStorage.getItem(AgentInterface.STORAGE_TELNYX_PREFIX + kind) || "").trim();
        } catch (_) {
            return "";
        }
    }

    /** Tested models or voices from the agent config in robots.js, best first. */
    _telnyxPreferred(kind, agent = this.getSelectedAgent()) {
        const list = { stt: agent?.preferredStreamingTranscription, chat: agent?.preferredChatModels, voice: agent?.preferredVoices }[kind];
        return (Array.isArray(list) ? list : [list]).map((v) => String(v || "").trim()).filter(Boolean);
    }

    /**
     * The active character's voice. Telnyx uses it when the account offers it, else the most reliable
     * voice of the same gender; a Telnyx voice under Groq becomes the Groq voice of the same gender.
     * @param {string} voiceId "" when there is no character or it keeps the current voice
     * @param {string} [gender] the character's saved voiceGender, used when the voice can't be looked up
     */
    setCharacterVoice(voiceId, gender = "") {
        const id = String(voiceId || "").trim();
        this._characterVoice = id ? { id, gender: window.TelnyxVoice?.normalGender?.(gender) || "" } : null;
        if (id && !this._isTelnyxVoiceId(id)) {
            this.setTtsVoice(id);
        } else if (id) {
            const wanted = this._voiceGender(id) || this._characterVoice.gender;
            const groq = (window.GroqTts?.VOICES || []).find((v) => this._voiceGender(v.id) === wanted);
            if (groq) this.setTtsVoice(groq.id);
        }
        this._renderTelnyxOptions();
    }

    /** "male", "female" or "" for a voice in the live Telnyx list or the Groq catalog. */
    _voiceGender(voiceId) {
        const normal = window.TelnyxVoice?.normalGender || (() => "");
        const telnyx = (this._telnyxLists.voices || []).find((v) => v.id === voiceId);
        if (telnyx?.gender) return normal(telnyx.gender);
        const label = String((window.GroqTts?.VOICES || []).find((v) => v.id === voiceId)?.label || "");
        return /♂/.test(label) ? "male" : /♀/.test(label) ? "female" : "";
    }

    /**
     * Telnyx voices to try, in order. With a character: its own voice when Telnyx offers it, then the
     * most reliable stand-ins of the same gender. Without: the pick in the agent panel (else the
     * agent's voice in robots.js), then stand-ins of that voice's gender. Voices that failed this
     * session go last; until the voice list loads, voices are tried unchecked.
     * @param {{ ignorePick?: boolean }} [options] ignorePick: what Default would use
     * @returns {string[]}
     */
    _telnyxVoiceChoices(agent = this.getSelectedAgent(), options = {}) {
        const voices = this._telnyxLists.voices || [];
        const offered = (id) => this._isTelnyxVoiceId(id) && (!voices.length || voices.some((v) => v.id === id));
        const character = this._characterVoice;
        const pick = options.ignorePick ? "" : this._telnyxChoice("voice", agent);
        const wanted = character ? [character.id] : [pick, String(agent?.voice || "").trim()].filter(Boolean);
        const gender = wanted.map((id) => this._voiceGender(id)).find(Boolean) || character?.gender || "";
        const standIns = window.TelnyxVoice?.rankVoices
            ? window.TelnyxVoice.rankVoices(voices, {
                  gender,
                  language: navigator.language,
                  tested: [...this._telnyxPreferred("voice", agent), ...this._telnyxWorked.voice]
              }).map((v) => v.id)
            : [];
        const candidates = [...wanted.filter(offered), ...standIns];
        if (!voices.length) candidates.push(...this._telnyxPreferred("voice", agent));
        const list = [];
        for (const id of candidates) if (!this._telnyxBadVoices.has(id) && !list.includes(id)) list.push(id);
        for (const id of candidates) if (!list.includes(id)) list.push(id);
        return list.slice(0, AgentInterface.TELNYX_VOICE_ATTEMPTS);
    }

    _telnyxVoice(agent = this.getSelectedAgent()) {
        return this._telnyxVoiceChoices(agent)[0] || "";
    }

    _noteTelnyxVoiceFailures(failed) {
        const ids = (Array.isArray(failed) ? failed : []).filter(Boolean);
        if (!ids.length) return;
        console.error("Telnyx voices failed and were skipped:", ids);
        for (const id of ids) this._telnyxBadVoices.add(id);
        this._renderTelnyxOptions();
    }

    _setTelnyxChoice(kind, value) {
        try {
            const v = String(value || "").trim();
            if (v) localStorage.setItem(AgentInterface.STORAGE_TELNYX_PREFIX + kind, v);
            else localStorage.removeItem(AgentInterface.STORAGE_TELNYX_PREFIX + kind);
        } catch (_) {}
    }

    /**
     * Telnyx chat models to try, in order: the player's pick, the tested models from robots.js, then
     * the automatic ranking. Models Telnyx no longer offers are skipped (until the lists load, the
     * pick and tested models are tried unchecked), and so are models that failed this session.
     * @param {{ ignorePick?: boolean }} [options] ignorePick: what Auto would use
     * @returns {{ id: string, thinkingOff: boolean }[]}
     */
    _telnyxChatModels(agent = this.getSelectedAgent(), options = {}) {
        const ranked = this._telnyxLists.chat || [];
        const pick = options.ignorePick ? "" : this._telnyxChoice("chat", agent);
        const rejectsKwargs = window.TelnyxVoice?.REJECTS_TEMPLATE_KWARGS || /mistral/i;
        const offered = (id) => ranked.find((m) => m.id === id) || (ranked.length ? null : { id, thinkingOff: !rejectsKwargs.test(id) });
        const usable = (m) => !this._telnyxBadModels.has(m.id);
        const list = [];
        const add = (m) => {
            if (m && !list.some((x) => x.id === m.id)) list.push(m);
        };
        add(pick && offered(pick));
        const tested = this._telnyxPreferred("chat", agent).map(offered).filter(Boolean);
        const auto = ranked.filter((m) => m.auto);
        for (const m of [...tested, ...auto].filter(usable)) add(m);
        if (!list.length) for (const m of [...tested, ...auto]) add(m);
        return list.slice(0, AgentInterface.TELNYX_CHAT_ATTEMPTS).map((m) => ({ id: m.id, thinkingOff: !!m.thinkingOff }));
    }

    /** Remember models that failed so Auto moves on to the next one for the rest of the session. */
    _noteTelnyxModelFailures(failed) {
        const ids = (Array.isArray(failed) ? failed : []).filter(Boolean);
        if (!ids.length) return;
        console.error("Telnyx chat models failed and were skipped:", ids);
        for (const id of ids) this._telnyxBadModels.add(id);
        this._renderTelnyxOptions();
    }

    /** Streaming speech-to-text models with the tested ones first (see TelnyxVoice.rankSttModels). */
    _rankedTelnyxStt(agent = this.getSelectedAgent()) {
        const listed = this._telnyxLists.stt || [];
        const rank = window.TelnyxVoice?.rankSttModels;
        return rank
            ? rank(listed, this._telnyxPreferred("stt", agent))
            : listed.map((m) => ({ ...m, value: `${m.provider}|${m.model}`, tested: false }));
    }

    /**
     * Streaming speech-to-text models to try, in order: the player's pick, then the tested ones from
     * robots.js, then the best guesses. Same skipping rules as `_telnyxChatModels`.
     * @param {{ ignorePick?: boolean }} [options]
     * @returns {{ provider: string, model: string }[]}
     */
    _telnyxSttChoices(agent = this.getSelectedAgent(), options = {}) {
        const listed = new Set((this._telnyxLists.stt || []).map((m) => `${m.provider}|${m.model}`));
        const offered = (v) => !!v && (!listed.size || listed.has(v));
        const ranked = this._rankedTelnyxStt(agent).map((m) => m.value);
        const pick = options.ignorePick ? "" : this._telnyxChoice("stt", agent);
        const candidates = [...this._telnyxPreferred("stt", agent), ...ranked].filter(offered);
        const values = [];
        const add = (v) => {
            if (v && !values.includes(v)) values.push(v);
        };
        if (offered(pick)) add(pick);
        for (const v of candidates) if (!this._telnyxBadStt.has(v)) add(v);
        if (!values.length) for (const v of candidates) add(v);
        return values.slice(0, AgentInterface.TELNYX_STT_ATTEMPTS).map((v) => {
            const [provider, ...model] = v.split("|");
            return { provider, model: model.join("|") };
        });
    }

    /** @returns {{ provider: string, model: string }} */
    _telnyxSttChoice(agent = this.getSelectedAgent()) {
        return this._telnyxSttChoices(agent)[0] || { provider: "", model: "" };
    }

    _noteTelnyxSttFailures(failed) {
        const values = (Array.isArray(failed) ? failed : []).filter(Boolean);
        if (!values.length) return;
        console.error("Telnyx streaming speech-to-text models failed and were skipped:", values);
        for (const v of values) this._telnyxBadStt.add(v);
        this._renderTelnyxOptions();
    }

    _noteTelnyxWorked(kind, value) {
        if (value) this._telnyxWorked[kind].add(value);
    }

    /**
     * Console helper (`telnyxPreferences()`): the tested-model lists for the Telnyx agent in
     * robots.js with what worked this session added and anything Telnyx no longer offers removed,
     * ready to paste. Models that failed are only reported: one failure may be a passing glitch.
     * @returns {string}
     */
    telnyxPreferences() {
        const agent = this.agents.find((a) => this._isTelnyxProvider(a));
        const offered = {
            chat: new Set((this._telnyxLists.chat || []).map((m) => m.id)),
            stt: new Set((this._telnyxLists.stt || []).map((m) => `${m.provider}|${m.model}`)),
            voice: new Set((this._telnyxLists.voices || []).map((v) => v.id))
        };
        const gone = [];
        const merge = (kind) => {
            const current = this._telnyxPreferred(kind, agent).filter((v) => {
                const listed = !offered[kind].size || offered[kind].has(v);
                if (!listed) gone.push(v);
                return listed;
            });
            return [...current, ...[...this._telnyxWorked[kind]].filter((v) => !current.includes(v))];
        };
        const lines = [
            `preferredChatModels: ${JSON.stringify(merge("chat"))},`,
            `preferredStreamingTranscription: ${JSON.stringify(merge("stt"))},`,
            `preferredVoices: ${JSON.stringify(merge("voice"))},`
        ];
        const worked = [...this._telnyxWorked.chat, ...this._telnyxWorked.stt, ...this._telnyxWorked.voice];
        const failed = [...this._telnyxBadModels, ...this._telnyxBadStt, ...this._telnyxBadVoices];
        console.info(
            "Paste over the matching lines of the Telnyx agent in robots.js.\n" +
                `Worked this session: ${worked.join(", ") || "nothing yet"}.\n` +
                `Failed this session (still listed; remove them if they keep failing): ${failed.join(", ") || "nothing"}.\n` +
                `Removed because Telnyx no longer offers them: ${gone.join(", ") || "nothing"}.`
        );
        return lines.join("\n");
    }

    /**
     * The player's Telnyx key: the key box while the Telnyx agent is selected, else the key last
     * used with it (this session or remembered), so other panels can use Telnyx voices.
     */
    telnyxApiKey() {
        if (this._isTelnyxProvider()) {
            const key = this._clientApiKey();
            if (key) this._telnyxSessionKey = key;
            return key;
        }
        const agent = this.agents.find((a) => this._isTelnyxProvider(a));
        return this._telnyxSessionKey || (agent ? this._loadKeyForAgent(agent.name) : "");
    }

    /**
     * What Telnyx requests use: the player's key (free to the arcade), else TelnyxVoice.HOSTED (the
     * Worker's key, charged to AI credit) when hosted AI applies, else "".
     */
    _telnyxAccess() {
        const key = this.telnyxApiKey();
        if (key) return key;
        return this._useHostedAi() && window.TelnyxVoice ? window.TelnyxVoice.HOSTED : "";
    }

    _isHostedTelnyx(access) {
        return !!access && access === window.TelnyxVoice?.HOSTED;
    }

    _telnyxSpeechLabel() {
        return `Telnyx speech (${this._useHostedAi() ? "AI credit" : "your key"}).`;
    }

    /** The Worker said hosted credit ran out: show the top-up popup. @returns {Error} to throw */
    async _telnyxPaymentRequired(session) {
        this._billingPaused = true;
        await window.playBilling?.handlePaymentRequired?.(
            new Response(JSON.stringify({ session: session || null }), { status: 402, headers: { "Content-Type": "application/json" } }),
            this._billingContext()
        );
        return AgentInterface._creditRequiredError("AI budget used. Pay to continue.");
    }

    /**
     * Where Telnyx voices come from for other panels: "key" (the player's own), "hosted" (the
     * arcade's account on AI credit, while a play session is active) or "" (none).
     */
    telnyxVoiceSource() {
        const access = this._telnyxAccess();
        if (!access) return "";
        if (!this._isHostedTelnyx(access)) return "key";
        return window.playBilling?.getActiveSessionId?.() ? "hosted" : "";
    }

    /**
     * Telnyx voices for other panels (the character editor), loading them if needed.
     * @returns {Promise<{ hasKey: boolean, source: string, voices: object[], error: string }>}
     */
    async telnyxVoices(options = {}) {
        if (this._isHostedTelnyx(this._telnyxAccess()) && !window.playBilling?.getActiveSessionId?.()) {
            await window.playBilling?.resumeAiSession?.(this._billingContext()).catch((err) => {
                console.warn("Play session could not be resumed for Telnyx voices:", err);
            });
        }
        const source = this.telnyxVoiceSource();
        if (!source) return { hasKey: false, source, voices: [], error: "" };
        await this._loadTelnyxLists(options);
        // A newer load may have started meanwhile (the key changed); wait for that one.
        await this._telnyxListsPromise;
        return { hasKey: true, source, voices: this._telnyxLists.voices, error: this._telnyxListError };
    }

    /** Add a voice saved from Voice Design to the Telnyx voice lists. */
    addTelnyxVoice(voice) {
        if (!voice?.id || this._telnyxLists.voices.some((v) => v.id === voice.id)) return;
        this._telnyxLists = { ...this._telnyxLists, voices: [voice, ...this._telnyxLists.voices] };
        this._renderTelnyxOptions();
        this._syncTelnyxUi();
    }

    /**
     * Loads the account's streaming speech-to-text models, chat models and voices into the
     * Telnyx pickers. Skipped when this key's lists are already loaded unless `force`.
     * @returns {Promise<void>} settles once the lists are loaded
     */
    _loadTelnyxLists(options = {}) {
        const key = this._telnyxAccess();
        const api = window.TelnyxVoice;
        // Hosted lists need a play session; they load when credit is added (phonebot:ai-budget).
        if (!key || !api || (this._isHostedTelnyx(key) && !window.playBilling?.getActiveSessionId?.())) {
            this._syncTelnyxUi();
            return Promise.resolve();
        }
        if (!options.force && key === this._telnyxListsKey) return this._telnyxListsPromise || Promise.resolve();
        this._telnyxListsPromise = this._fetchTelnyxLists(key, api);
        return this._telnyxListsPromise;
    }

    async _fetchTelnyxLists(key, api) {
        const token = ++this._telnyxListsToken;
        this._telnyxListsKey = key;
        this._telnyxListsLoading = true;
        this._telnyxListError = "";
        this._syncTelnyxUi();
        const [stt, chat, voices] = await Promise.allSettled([
            api.listStreamingSttModels(key),
            api.listChatModels(key),
            api.listVoices(key)
        ]);
        if (token !== this._telnyxListsToken) return;
        this._telnyxListsLoading = false;
        const errors = [];
        for (const [name, result] of [
            ["speech-to-text models", stt],
            ["chat models", chat],
            ["voices", voices]
        ]) {
            if (result.status !== "rejected") continue;
            console.error(`Telnyx ${name} could not be loaded:`, result.reason);
            errors.push(result.reason?.message || String(result.reason));
        }
        if (errors.length) this._telnyxListsKey = "";
        this._telnyxLists = {
            stt: stt.value || [],
            chat: chat.value || [],
            voices: voices.value?.voices || [],
            skippedUltra: voices.value?.skippedUltra || 0
        };
        this._telnyxListError = errors.join(" · ");
        this._renderTelnyxOptions();
        this._syncTelnyxUi();
    }

    /**
     * Fill a picker with grouped options, keeping a saved pick that the list doesn't have.
     * @param {HTMLSelectElement|null} select
     * @param {{ label?: string, options: { value: string, label: string, title?: string }[] }[]} groups
     * @param {string} choice
     * @param {(value: string) => string} [labelFor] label for a pick missing from the list
     */
    _fillTelnyxSelect(select, groups, choice, labelFor = (v) => v) {
        if (!select) return;
        select.replaceChildren();
        const known = new Set();
        for (const group of groups) {
            if (!group.options.length) continue;
            let parent = select;
            if (group.label) {
                parent = document.createElement("optgroup");
                parent.label = group.label;
                select.appendChild(parent);
            }
            for (const o of group.options) {
                const opt = document.createElement("option");
                opt.value = o.value;
                opt.textContent = o.label;
                if (o.title) opt.title = o.title;
                parent.appendChild(opt);
                if (o.value) known.add(o.value);
            }
        }
        if (choice && !known.has(choice)) {
            const opt = document.createElement("option");
            opt.value = choice;
            opt.textContent = known.size ? `${labelFor(choice)} (not on your account)` : labelFor(choice);
            select.prepend(opt);
        }
        select.value = choice;
    }

    _renderTelnyxOptions() {
        const agent = this.getSelectedAgent();
        const { stt, chat, voices } = this._telnyxLists;
        const sttLabel = (value) => {
            const [provider, ...model] = value.split("|");
            return `${model.join("|") || "default model"} (${provider})`;
        };
        const sttOption = (m) => ({
            value: m.value,
            label: this._telnyxBadStt.has(m.value) ? `${sttLabel(m.value)}, failed this session` : sttLabel(m.value)
        });
        const rankedStt = this._rankedTelnyxStt(agent);
        const autoStt = this._telnyxSttChoices(agent, { ignorePick: true })[0];
        this._fillTelnyxSelect(
            this._telnyxSttSelect,
            [
                { options: [{ value: "", label: autoStt ? `Auto (now ${sttLabel(`${autoStt.provider}|${autoStt.model}`)})` : "Auto" }] },
                { label: "Tested (robots.js), tried first", options: rankedStt.filter((m) => m.tested).map(sttOption) },
                { label: "Others, best guess first", options: rankedStt.filter((m) => !m.tested).map(sttOption) }
            ],
            this._telnyxChoice("stt", agent),
            (v) => (stt.length ? `${sttLabel(v)}, Auto is used instead` : sttLabel(v))
        );
        const cost = (m) =>
            Number.isFinite(m.costPerTurn) ? `${m.currency === "USD" ? "$" : `${m.currency} `}${(m.costPerTurn * 1000).toFixed(2)} per 1,000 turns` : "";
        const chatOption = (m) => {
            const failed = this._telnyxBadModels.has(m.id) ? "failed this session" : "";
            const details = [m.sizeLabel, cost(m), m.tier === "unlisted" ? "preview" : "", m.reason, failed].filter(Boolean);
            return { value: m.id, label: details.length ? `${m.id} (${details.join(", ")})` : m.id, title: m.id };
        };
        const autoChat = this._telnyxChatModels(agent, { ignorePick: true })[0];
        const testedIds = this._telnyxPreferred("chat", agent);
        const tested = testedIds.map((id) => chat.find((m) => m.id === id)).filter(Boolean);
        const untested = chat.filter((m) => !testedIds.includes(m.id));
        this._fillTelnyxSelect(
            this._telnyxChatSelect,
            [
                { options: [{ value: "", label: autoChat ? `Auto (now ${autoChat.id})` : "Auto" }] },
                { label: "Tested (robots.js), tried first", options: tested.map(chatOption) },
                { label: "Picked automatically, best first", options: untested.filter((m) => m.auto).map(chatOption) },
                { label: "Not picked automatically", options: untested.filter((m) => !m.auto).map(chatOption) }
            ],
            this._telnyxChoice("chat", agent),
            (v) => (chat.length ? `${v}, Auto is used instead` : v)
        );
        const providerNames = window.TelnyxVoice?.PROVIDER_NAMES || {};
        const byProvider = new Map();
        const voiceLabel = (v) => {
            const details = [v.language, v.gender, this._telnyxBadVoices.has(v.id) ? "failed this session" : ""].filter(Boolean);
            return details.length ? `${v.name} (${details.join(", ")})` : v.name;
        };
        for (const v of voices) {
            if (!byProvider.has(v.provider)) byProvider.set(v.provider, []);
            byProvider.get(v.provider).push({ value: v.id, label: voiceLabel(v), title: v.id });
        }
        const character = this._characterVoice;
        const usedId = this._telnyxVoiceChoices(agent, { ignorePick: true })[0] || "";
        const used = voices.find((v) => v.id === usedId);
        const usedName = used ? voiceLabel(used) : usedId || "none available";
        const defaultLabel = !character
            ? `Default: ${usedName}`
            : usedId === character.id
              ? `Character's voice: ${usedName}`
              : `Character's voice isn't available here; stand-in: ${usedName}`;
        this._fillTelnyxSelect(
            this._telnyxVoiceSelect,
            [
                { options: [{ value: "", label: defaultLabel, title: character ? character.id : "" }] },
                ...[...byProvider].map(([provider, options]) => ({
                    label: `${providerNames[provider] || provider} voices`,
                    options
                }))
            ],
            character ? "" : this._telnyxChoice("voice", agent),
            (v) => (voices.length ? `${v}, Default is used instead` : v)
        );
        if (this._telnyxVoiceSelect) {
            this._telnyxVoiceSelect.disabled = !!character;
            this._telnyxVoiceSelect.title = character
                ? "The active character sets the voice (Characters, then Edit)."
                : "Voice when no character is active.";
        }
    }

    _syncTelnyxUi() {
        const telnyx = this._isTelnyxProvider();
        if (this._telnyxRow) this._telnyxRow.hidden = !telnyx;
        if (!telnyx) return;
        const access = this._telnyxAccess();
        const hosted = this._isHostedTelnyx(access);
        const canLoad = !!access && (!hosted || !!window.playBilling?.getActiveSessionId?.());
        if (this._telnyxRefreshBtn) this._telnyxRefreshBtn.disabled = !canLoad || this._telnyxListsLoading;
        if (!this._telnyxHintEl) return;
        const { stt, chat, voices, skippedUltra } = this._telnyxLists;
        this._telnyxHintEl.className = canLoad && this._telnyxListError ? "error" : "muted";
        this._telnyxHintEl.textContent = !access
            ? "Enter your Telnyx API key (it starts with KEY) to load your account's models and voices."
            : !canLoad
              ? "No key: Telnyx runs on hosted AI credit. The models and voices load once credit is added, or enter your own Telnyx API key."
              : this._telnyxListsLoading
                ? "Loading models and voices from Telnyx…"
                : this._telnyxListError
                  ? `Some Telnyx lists didn't load: ${this._telnyxListError}`
                  : stt.length || chat.length || voices.length
                    ? `${hosted ? "Hosted (AI credit)" : "From your account"}: ${stt.length} streaming speech-to-text models, ` +
                      `${chat.length} chat models billed by Telnyx (${chat.filter((m) => m.auto).length} picked automatically), ${voices.length} voices` +
                      (skippedUltra ? ` (${skippedUltra} Ultra voices left out because they can't stream).` : ".")
                    : "Lists not loaded yet. Click Refresh Telnyx lists.";
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
        if (this._isTelnyxProvider(agent)) {
            return String(agent.transcriptionModel || "").trim() || "openai/whisper-large-v3-turbo";
        }
        if (this._sessionModels?.stt) return this._sessionModels.stt;
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
        if (this._isTelnyxProvider(agent) && this._isConversationMode()) {
            const { provider, model } = this._telnyxSttChoice(agent);
            return `Telnyx streaming ${model || provider}`;
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
        await this._ensureHostedAiCredit();
        await this.ensureSessionGroqModels();
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
            this._useHostedGroq() &&
            typeof window.playBilling?.fetchHostedTranscribe === "function";
        let res;
        if (this._isTelnyxProvider(agent) && this._useHostedAi()) {
            res = await window.TelnyxVoice.fetch("/ai/audio/transcriptions", { method: "POST", body: form }, window.TelnyxVoice.HOSTED);
        } else if (hostedArcade) {
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
            throw AgentInterface._creditRequiredError("AI budget used. Pay to continue.");
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

    _resolveModel(agent, options = {}) {
        if (this._isTelnyxProvider(agent)) return this._telnyxChatModels(agent)[0]?.id || "";
        const wantVision =
            options.wantVision != null
                ? !!options.wantVision
                : !!(this._sendCameraImageInput?.checked ?? this._sendCameraImage);
        const fromSession = this._sessionChatModel(wantVision);
        if (fromSession) return fromSession;
        return String(agent?.model || "").trim();
    }

    /** True if any message already carries a multimodal image part. */
    _messagesIncludeVisionImage(messages) {
        if (!Array.isArray(messages)) return false;
        return messages.some(
            (m) =>
                Array.isArray(m?.content) &&
                m.content.some((p) => p && (p.type === "image_url" || p.type === "image"))
        );
    }

    /**
     * Set the talking-head reasoning_effort used by every send until changed again.
     * @param {string|null} value low|medium|high, or null to fall back to the agent config.
     */
    setReasoningEffort(value) {
        const v = String(value || "").trim().toLowerCase();
        this._reasoningEffort = v === "low" || v === "medium" || v === "high" ? v : null;
    }

    /**
     * Cross-model reasoning_effort (low|medium|high). Prefer "low" for Talking Head.
     * Qwen gets "none": its thinking outgrows small max_tokens and Groq's per-minute output cap.
     */
    _resolveReasoningEffort(agent, modelId, override = null) {
        if (/qwen/i.test(String(modelId || ""))) return "none";
        const raw =
            override || this._reasoningEffort || agent?.reasoningEffort || agent?.reasoning_effort || "low";
        if (typeof window.GroqModelSelect?.normalizeReasoningEffort === "function") {
            return window.GroqModelSelect.normalizeReasoningEffort(raw);
        }
        const v = String(raw || "").trim().toLowerCase();
        if (v === "medium" || v === "high") return v;
        return "low";
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
        if (this._sessionModels?.tts) return this._sessionModels.tts;
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
        const telnyxVoice = this._isTelnyxVoiceId(options.voice) ? String(options.voice).trim() : "";
        if (telnyxVoice || this._isTelnyxProvider()) {
            const apiKey = this._telnyxAccess();
            if (!apiKey) throw new Error("Enter your Telnyx API key (on the Telnyx agent) for Telnyx speech.");
            if (this._isHostedTelnyx(apiKey)) await this._ensureHostedAiCredit();
            if (typeof window.TelnyxVoice?.synthesizeSpeech !== "function") {
                throw new Error("Telnyx helper is not loaded.");
            }
            const voices = telnyxVoice ? [telnyxVoice] : this._telnyxVoiceChoices();
            if (!voices.length) throw new Error("No Telnyx voice is available. Click Refresh Telnyx lists.");
            const failed = [];
            try {
                for (const [i, voice] of voices.entries()) {
                    try {
                        const blob = await window.TelnyxVoice.synthesizeSpeech(apiKey, this._cleanSpeechText(text), voice);
                        if (!telnyxVoice) this._noteTelnyxWorked("voice", voice);
                        return blob;
                    } catch (err) {
                        if (err?.status === 402 && this._isHostedTelnyx(apiKey)) throw await this._telnyxPaymentRequired(err.session);
                        if (i === voices.length - 1 || /HTTP (401|402|403|429)\b/.test(String(err?.message))) throw err;
                        console.error(`Telnyx voice ${voice} failed; trying the next one.`, err);
                        failed.push(voice);
                    }
                }
            } finally {
                if (!telnyxVoice) this._noteTelnyxVoiceFailures(failed);
            }
        }
        if (this._isBrowserTtsVoice(options.voice ?? this._ttsVoice)) {
            throw new Error("Web TTS does not return an audio blob.");
        }
        await this._ensureHostedAiCredit();
        await this.ensureSessionGroqModels();
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
        const voice = window.GroqTts?.resolveVoice
            ? window.GroqTts.resolveVoice(options.voice)
            : window.GroqTts?.isKnownVoice?.(options.voice)
              ? options.voice
              : window.GroqTts?.DEFAULT_VOICE || "austin";
        if (this._isBrowserTtsVoice(voice)) {
            throw new Error("Web TTS does not return an audio blob.");
        }
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
            throw AgentInterface._creditRequiredError("AI budget used. Pay to continue.");
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

    /**
     * All of `text` as one WAV Blob, for saving as a clip. Groq TTS takes ~200 characters per
     * request, so longer text is synthesized in parts and joined.
     * @param {string} text
     * @param {{ voice?: string }} [options] voice defaults to the selected voice.
     * @returns {Promise<Blob>}
     */
    async synthesizeSpeechFile(text, options = {}) {
        const voice = String(options.voice || "").trim() || this._ttsVoice;
        const telnyx = this._isTelnyxProvider() || this._isTelnyxVoiceId(voice);
        if (!telnyx && this._isBrowserTtsVoice(voice)) {
            throw new Error("Web TTS can't make an audio file. Choose a different voice.");
        }
        const content = String(text || "").trim();
        const chunks = this._isGeminiProvider() || telnyx
            ? [this._cleanSpeechText(content)].filter(Boolean)
            : typeof window.GroqTts?.splitInput === "function"
              ? window.GroqTts.splitInput(content)
              : [content].filter(Boolean);
        if (!chunks.length) throw new Error("Nothing to speak.");
        const blobs = [];
        for (const chunk of chunks) blobs.push(await this.synthesizeSpeechBlob(chunk, { voice }));
        return blobs.length === 1 ? blobs[0] : this._joinAudioBlobs(blobs);
    }

    /** Decode clips and join them end to end as one mono 16-bit WAV. @param {Blob[]} blobs */
    async _joinAudioBlobs(blobs) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (typeof Ctx !== "function") throw new Error("This browser can't join audio clips.");
        const ctx = new Ctx();
        try {
            const decoded = [];
            for (const blob of blobs) {
                decoded.push(await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0)));
            }
            const pcm = new Int16Array(decoded.reduce((n, b) => n + b.length, 0));
            let offset = 0;
            for (const buffer of decoded) {
                const channels = Array.from({ length: buffer.numberOfChannels || 1 }, (_, c) =>
                    buffer.getChannelData(c)
                );
                for (let i = 0; i < buffer.length; i++) {
                    let sum = 0;
                    for (const data of channels) sum += data[i] || 0;
                    const x = Math.max(-1, Math.min(1, sum / channels.length));
                    pcm[offset++] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
                }
            }
            return AgentInterface._pcm16ToWavBlob(pcm, ctx.sampleRate);
        } finally {
            try {
                await ctx.close();
            } catch (_) {}
        }
    }

    /** Mono 16-bit PCM samples as a WAV Blob. @param {Int16Array} pcm @param {number} sampleRate */
    static _pcm16ToWavBlob(pcm, sampleRate) {
        const header = new DataView(new ArrayBuffer(44));
        const writeStr = (offset, s) => {
            for (let i = 0; i < s.length; i++) header.setUint8(offset + i, s.charCodeAt(i));
        };
        writeStr(0, "RIFF");
        header.setUint32(4, 36 + pcm.byteLength, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        header.setUint32(16, 16, true);
        header.setUint16(20, 1, true);
        header.setUint16(22, 1, true);
        header.setUint32(24, sampleRate, true);
        header.setUint32(28, sampleRate * 2, true);
        header.setUint16(32, 2, true);
        header.setUint16(34, 16, true);
        writeStr(36, "data");
        header.setUint32(40, pcm.byteLength, true);
        return new Blob([header.buffer, pcm.buffer], { type: "audio/wav" });
    }

    _stopSpeaking() {
        this._speakGeneration += 1;
        window.__phonebotTtsSpeaking = false;
        this._clearCameraPhotoOverlays();
        this._abortPttRecording();
        this._cancelPttWait();
        if (window.speechSynthesis) {
            try {
                window.speechSynthesis.cancel();
            } catch (_) {}
        }
        const player = this._getAudioPlayer();
        if (player && typeof player.stop === "function") {
            player.stop();
        }
        if (this._usesPttInput() && this._agentEnabled) {
            this._armConversationPtt();
        } else {
            this._clearPttOverlay();
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

    _isBrowserTtsVoice(voiceId = this._ttsVoice) {
        return typeof window.GroqTts?.isWebVoice === "function"
            ? window.GroqTts.isWebVoice(voiceId)
            : String(voiceId || "").trim().toLowerCase() === "browser";
    }

    /**
     * Persist / apply a TTS voice id (Web TTS or provider catalog).
     * @param {string} voiceId
     * @returns {string}
     */
    setTtsVoice(voiceId) {
        const id = String(voiceId || "").trim();
        if (this._isTelnyxVoiceId(id)) {
            this._setTelnyxChoice("voice", id);
            this._renderTelnyxOptions();
            return id;
        }
        if (this._isGeminiProvider()) {
            this._ttsVoice =
                typeof window.GeminiAudioTurn?.saveVoice === "function"
                    ? window.GeminiAudioTurn.saveVoice(id)
                    : id || "Kore";
        } else if (typeof window.GroqTts?.saveVoice === "function") {
            this._ttsVoice = window.GroqTts.saveVoice(id);
        } else {
            this._ttsVoice = id || window.GroqTts?.resolveVoice?.() || "austin";
        }
        if (this._voiceSelect) this._voiceSelect.value = this._ttsVoice;
        return this._ttsVoice;
    }

    _onTtsVoiceChange() {
        const id = this._voiceSelect ? this._voiceSelect.value : "";
        this.setTtsVoice(id);
    }

    _syncVoiceUiForSelectedAgent() {
        const gemini = this._isGeminiProvider();
        const voiceList = gemini
            ? Array.isArray(window.GeminiAudioTurn?.VOICES) && window.GeminiAudioTurn.VOICES.length
                ? window.GeminiAudioTurn.VOICES
                : [{ id: "Kore", label: "Kore — firm" }]
            : typeof window.GroqTts?.pickerVoices === "function"
              ? window.GroqTts.pickerVoices()
              : Array.isArray(window.GroqTts?.VOICES) && window.GroqTts.VOICES.length
                ? [
                      {
                          id: window.GroqTts.WEB_VOICE_ID || "browser",
                          label: window.GroqTts.WEB_VOICE_LABEL || "Web TTS (free)"
                      },
                      ...window.GroqTts.VOICES
                  ]
                : [
                      { id: "browser", label: "Web TTS (free)" },
                      { id: "austin", label: "Austin — ♂" }
                  ];
        this._ttsVoice = gemini
            ? typeof window.GeminiAudioTurn?.loadSavedVoice === "function"
                ? window.GeminiAudioTurn.loadSavedVoice()
                : "Kore"
            : typeof window.GroqTts?.loadSavedVoice === "function"
              ? window.GroqTts.loadSavedVoice()
              : "austin";
        if (gemini && this._isBrowserTtsVoice(this._ttsVoice)) {
            this._ttsVoice =
                typeof window.GeminiAudioTurn?.DEFAULT_VOICE === "string"
                    ? window.GeminiAudioTurn.DEFAULT_VOICE
                    : "Kore";
        }
        const telnyx = this._isTelnyxProvider();
        if (this._voiceSelectLabel) {
            this._voiceSelectLabel.textContent = gemini
                ? "Voice (Gemini TTS)"
                : "Voice (Web TTS or Groq Orpheus)";
            this._voiceSelectLabel.hidden = telnyx;
        }
        if (this._voiceSelect) this._voiceSelect.hidden = telnyx;
        if (this._keyInput) {
            this._keyInput.placeholder = gemini
                ? "AIza… (Google AI Studio)"
                : telnyx
                  ? "KEY… (your Telnyx API key)"
                  : "sk-… or gsk_…";
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
                this._ttsVoice =
                    window.GroqTts?.resolveVoice?.(null, window.GroqTts?.VOICES) ||
                    voiceList.find((v) => v.id !== (window.GroqTts?.WEB_VOICE_ID || "browser"))?.id ||
                    voiceList[0].id;
            }
            this._voiceSelect.value = this._ttsVoice;
        }
        if (telnyx) {
            this._setVoiceStatus(
                `Telnyx: hold-to-talk turns stream speech-to-text, chat and voice through the phonebot Worker ${
                    this._useHostedAi() ? "on hosted AI credit" : "on your key"
                }; typed messages use plain Telnyx speech.`
            );
            return;
        }
        this._setVoiceStatus(
            this._isBrowserTtsVoice()
                ? "Web TTS (free browser speech). No API credits used for speech."
                : this._useHostedGroq()
                  ? "No API key: chat, Whisper, and TTS use hosted AI credit (top-up popup when it runs out)."
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
        const showPtt = this._isConversationMode();
        if (showPtt) this._setPttState("talking");
        try {
            await this._speakSynthesizedAsync(content, generation);
            return generation === this._speakGeneration;
        } finally {
            if (showPtt && generation === this._speakGeneration) {
                this._armConversationPtt();
            }
        }
    }

    async _speakSynthesizedAsync(content, generation) {
        const telnyx = this._isTelnyxProvider();
        if (!telnyx && this._isBrowserTtsVoice()) {
            this._setVoiceStatus("Speaking (Web TTS)…");
            await this._speakBrowserFallback(content);
            if (generation === this._speakGeneration) {
                this._setVoiceStatus("Web TTS (free browser speech). No API credits used for speech.");
            }
            return;
        }
        const player = this._getAudioPlayer();
        const canPlay = player && typeof player.playBlob === "function";
        if (!canPlay) {
            await this._speakBrowserFallback(content);
            return;
        }
        const gemini = this._isGeminiProvider();
        const chunks = gemini || telnyx
            ? [this._cleanSpeechText(content)].filter(Boolean)
            : typeof window.GroqTts?.splitInput === "function"
              ? window.GroqTts.splitInput(content)
              : [content];
        if (!chunks.length) return;
        const voice = telnyx ? this._telnyxVoice() : this._ttsVoice;
        const provider = gemini ? "Gemini" : telnyx ? "Telnyx" : "Groq";
        let usedBrowserFallback = false;
        try {
            this._apiKey = this._keyInput ? String(this._keyInput.value || "").trim() : this._apiKey;
            for (let i = 0; i < chunks.length; i++) {
                if (generation !== this._speakGeneration) return;
                const chunk = chunks[i];
                const partLabel =
                    chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
                this._setVoiceStatus(`${provider} TTS (${voice})${partLabel}…`);
                const blob = await this.synthesizeSpeechBlob(chunk, { voice: this._ttsVoice });
                if (generation !== this._speakGeneration) return;
                await this._playSpeechBlob(blob, chunk, generation, {
                    speakingLabel: gemini
                        ? `Speaking (Gemini ${voice})…`
                        : `Speaking (${voice})${partLabel}…`,
                    idleLabel: gemini
                        ? "Gemini TTS (AI Studio)."
                        : telnyx
                          ? this._telnyxSpeechLabel()
                          : "Groq Orpheus TTS (uses API credits).",
                    playLabel: `${provider} TTS (${voice})${partLabel}`
                });
            }
        } catch (err) {
            console.warn("TTS error, falling back to browser speechSynthesis:", err);
            if (generation !== this._speakGeneration) return;
            this._setVoiceStatus(`${provider} TTS failed — using browser voice. (${err?.message || err})`);
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
        const showPtt = this._isConversationMode();
        if (showPtt) this._setPttState("talking");
        this._setVoiceStatus(labels.speakingLabel);
        window.__phonebotTtsSpeaking = true;
        try {
            await this._withPlaybackTimeout(player.playBlob(blob, labels.playLabel));
        } finally {
            window.__phonebotTtsSpeaking = false;
            if (generation === this._speakGeneration) {
                this._setVoiceStatus(labels.idleLabel);
                if (showPtt) this._armConversationPtt();
            }
        }
    }

    /** Rejects if playback runs past a minute; time spent with the robot paused doesn't count. */
    _withPlaybackTimeout(playback, timeoutMs = 60000) {
        let timer = null;
        let settled = false;
        const timeout = new Promise((_, reject) => {
            const arm = () => {
                if (settled) return;
                timer = setTimeout(async () => {
                    if (this.robot?.isPaused?.()) {
                        await this.robot.whenResumed();
                        arm();
                        return;
                    }
                    reject(new Error(`TTS playback timed out after ${timeoutMs / 1000}s.`));
                }, timeoutMs);
            };
            arm();
        });
        return Promise.race([playback, timeout]).finally(() => {
            settled = true;
            clearTimeout(timer);
        });
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
        const clean = window.GroqModelSelect?.cleanSpeechText;
        const content = typeof clean === "function" ? clean(text, []) : String(text || "").trim();
        if (!content) return;
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
            return;
        }
        await this.robot?.whenResumed?.();
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
        this._stopCameraCountdownSweep();
        if (this._countdownOverlayEl && this._countdownOverlayEl.parentNode) {
            this._countdownOverlayEl.parentNode.removeChild(this._countdownOverlayEl);
        }
        this._countdownOverlayEl = null;
        this._countdownNumberEl = null;
        this._countdownLabelEl = null;
    }

    _clearCameraShutterOverlay() {
        if (this._shutterOverlayEl && this._shutterOverlayEl.parentNode) {
            this._shutterOverlayEl.parentNode.removeChild(this._shutterOverlayEl);
        }
        this._shutterOverlayEl = null;
    }

    _clearCameraPhotoOverlays() {
        this._photoOverlayGeneration += 1;
        this._clearCameraCountdownOverlay();
        this._clearCameraShutterOverlay();
    }

    /**
     * @returns {HTMLElement|null}
     */
    _ensureCameraShutterOverlay() {
        if (this._shutterOverlayEl && this._shutterOverlayEl.isConnected) {
            return this._shutterOverlayEl;
        }
        this._clearCameraShutterOverlay();
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return null;
        const overlay = document.createElement("div");
        overlay.className = "sensor-camera-shutter-overlay";
        overlay.setAttribute("aria-hidden", "true");
        frameEl.appendChild(overlay);
        this._shutterOverlayEl = overlay;
        return overlay;
    }

    /**
     * Brief white flash so a photo capture is obvious even with no countdown.
     * @param {{ generation?: number, isActive?: () => boolean }} [options]
     * @returns {Promise<boolean>}
     */
    async _runCameraShutterFlicker(options = {}) {
        const generation =
            options.generation != null ? options.generation : this._photoOverlayGeneration;
        const isActive =
            typeof options.isActive === "function"
                ? options.isActive
                : () => generation === this._photoOverlayGeneration;
        const sleep = (ms) =>
            new Promise((resolve) => {
                setTimeout(resolve, ms);
            });
        const overlay = this._ensureCameraShutterOverlay();
        if (!overlay) {
            await sleep(120);
            return isActive();
        }
        try {
            // Double flash reads clearly even when the capture itself is instant.
            for (let i = 0; i < 2; i++) {
                if (!isActive()) return false;
                overlay.classList.add("is-flash");
                await sleep(85);
                overlay.classList.remove("is-flash");
                if (!isActive()) return false;
                if (i === 0) await sleep(45);
            }
            return isActive();
        } finally {
            this._clearCameraShutterOverlay();
        }
    }

    _clearPttOverlay() {
        this._abortPttRecording();
        this._cancelPttWait();
        if (this._pttOverlayEl && this._pttOverlayEl.parentNode) {
            this._pttOverlayEl.parentNode.removeChild(this._pttOverlayEl);
        }
        this._pttOverlayEl = null;
        this._pttBtnEl = null;
        this._pttLabelEl = null;
        this._pttState = "hidden";
        this._syncDashboardMicState("hidden", {
            disabled: true,
            label: "Hold to talk"
        });
    }

    /**
     * @returns {SVGElement}
     */
    _createPttMicIcon() {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("class", "sensor-camera-ptt-icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const body = document.createElementNS(ns, "rect");
        body.setAttribute("x", "9");
        body.setAttribute("y", "3");
        body.setAttribute("width", "6");
        body.setAttribute("height", "11");
        body.setAttribute("rx", "3");
        const stand = document.createElementNS(ns, "path");
        stand.setAttribute(
            "d",
            "M7 11a5 5 0 0 0 10 0M12 16v3"
        );
        stand.setAttribute("fill", "none");
        stand.setAttribute("stroke", "currentColor");
        stand.setAttribute("stroke-width", "2");
        stand.setAttribute("stroke-linecap", "round");
        svg.appendChild(body);
        svg.appendChild(stand);
        return svg;
    }

    /**
     * Build (or reuse) the hold-to-talk button on the camera frame.
     * @returns {HTMLElement|null}
     */
    _ensurePttOverlay() {
        if (this._pttOverlayEl && this._pttOverlayEl.isConnected) return this._pttOverlayEl;
        this._clearPttOverlay();
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return null;

        const overlay = document.createElement("div");
        overlay.className = "sensor-camera-ptt-overlay sensor-camera-ptt-overlay--idle";
        overlay.setAttribute("aria-live", "polite");

        const stack = document.createElement("div");
        stack.className = "sensor-camera-ptt-stack";

        const label = document.createElement("p");
        label.className = "sensor-camera-ptt-label";
        label.textContent = "Hold button while you talk";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sensor-camera-ptt-btn";
        btn.setAttribute("aria-label", "Hold button while you talk");
        btn.appendChild(this._createPttMicIcon());

        const endHold = (ev) => {
            if (ev?.pointerId != null && btn.hasPointerCapture(ev.pointerId)) {
                try {
                    btn.releasePointerCapture(ev.pointerId);
                } catch (_) {}
            }
            void this._onPttPointerUp(ev);
        };

        btn.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            try {
                btn.setPointerCapture(e.pointerId);
            } catch (_) {}
            void this._onPttPointerDown(e);
        });
        btn.addEventListener("pointerup", endHold);
        btn.addEventListener("pointercancel", endHold);
        btn.addEventListener("lostpointercapture", () => {
            if (this._pttRecording) void this._onPttPointerUp({ type: "lostpointercapture" });
        });

        stack.appendChild(label);
        stack.appendChild(btn);
        overlay.appendChild(stack);
        frameEl.appendChild(overlay);

        this._pttOverlayEl = overlay;
        this._pttBtnEl = btn;
        this._pttLabelEl = label;
        return overlay;
    }

    /**
     * @param {"idle"|"listening"|"processing"|"thinking"|"talking"} state
     * @param {{ hint?: string, label?: string }} [options]
     */
    _setPttState(state, options = {}) {
        const phase = String(state || "idle").trim().toLowerCase();
        this._pttState = phase;
        const overlay = this._ensurePttOverlay();

        const labels = {
            idle: "Hold button while you talk",
            listening: "Listening",
            processing: "Processing…",
            thinking: "Thinking",
            talking: "Talking"
        };

        const labelText =
            String(options.label || options.hint || "").trim() || labels[phase] || labels.idle;
        const disabled =
            phase === "processing" ||
            phase === "thinking" ||
            phase === "talking" ||
            (phase === "idle" && !this._pttCanInteract());

        if (overlay) {
            overlay.classList.remove(
                "sensor-camera-ptt-overlay--idle",
                "sensor-camera-ptt-overlay--listening",
                "sensor-camera-ptt-overlay--processing",
                "sensor-camera-ptt-overlay--thinking",
                "sensor-camera-ptt-overlay--talking"
            );
            overlay.classList.add(`sensor-camera-ptt-overlay--${phase}`);

            if (this._pttLabelEl) {
                this._pttLabelEl.textContent = labelText;
            }
            if (this._pttBtnEl) {
                this._pttBtnEl.disabled = disabled;
                this._pttBtnEl.setAttribute("aria-label", labelText);
                this._pttBtnEl.setAttribute("aria-pressed", phase === "listening" ? "true" : "false");
            }
        }
        this._syncDashboardMicState(phase, { disabled, label: labelText });
    }

    /**
     * Mirror camera-frame PTT affordance onto the dashboard composer mic.
     * @param {string} phase
     * @param {{ disabled?: boolean, label?: string }} [options]
     */
    _syncDashboardMicState(phase, options = {}) {
        const btn = this._dashboardMicBtn;
        if (!btn) return;
        const p = String(phase || this._pttState || "idle").trim().toLowerCase();
        const disabled =
            options.disabled != null
                ? !!options.disabled
                : p === "hidden" ||
                  p === "processing" ||
                  p === "thinking" ||
                  p === "talking" ||
                  (p === "idle" && !this._pttCanInteract());
        const label =
            String(options.label || "").trim() ||
            (p === "listening" ? "Listening" : "Hold to talk");
        btn.disabled = disabled;
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", p === "listening" ? "true" : "false");
        btn.classList.toggle("is-listening", p === "listening");
        btn.classList.toggle("is-busy", p === "processing" || p === "thinking" || p === "talking");
    }

    _armConversationPtt() {
        if (!this._usesPttInput() || !this._agentEnabled) {
            this._clearPttOverlay();
            return;
        }
        this._ensurePttOverlay();
        this._setPttState("idle");
    }

    _pttCanInteract() {
        return (
            this._agentEnabled &&
            !this._pttRecording &&
            !this._sendInProgress &&
            !this._conversationListenRunning &&
            (this._pttState === "idle" || this._pttState === "hidden") &&
            (this._isConversationMode() || this._isParrotMode() || !!this._pttWaitResolve)
        );
    }

    _cancelPttWait() {
        if (typeof this._pttWaitResolve === "function") {
            const resolve = this._pttWaitResolve;
            this._pttWaitResolve = null;
            this._pttWaitGeneration = 0;
            resolve(null);
        }
    }

    _abortPttRecording() {
        if (this._pttMaxTimer) {
            clearTimeout(this._pttMaxTimer);
            this._pttMaxTimer = null;
        }
        this._pttFinishToken += 1;
        this._pttFinishing = false;
        if (this._telnyxTurn) {
            this._telnyxTurn.cancel();
            this._telnyxTurn = null;
        }
        if (this._pttMediaRecorder && this._pttMediaRecorder.state !== "inactive") {
            try {
                this._pttMediaRecorder.stop();
            } catch (_) {}
        }
        this._pttMediaRecorder = null;
        this._pttRecordChunks = [];
        if (this._pttRecordStream) {
            for (const track of this._pttRecordStream.getTracks()) {
                try {
                    track.stop();
                } catch (_) {}
            }
        }
        this._pttRecordStream = null;
        this._pttRecording = false;
        this._pttRecordStartedAt = 0;
    }

    async _onPttPointerDown(_ev) {
        if (this._pttRecording) return;
        if (!this._pttCanInteract() && !this._pttWaitResolve) return;
        try {
            if (this._usesTelnyxStreamTurn()) await this._startTelnyxStreamTurn();
            else await this._startPttRecording();
        } catch (err) {
            console.error("PTT recording start failed:", err);
            this._abortPttRecording();
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Could not open microphone.";
                this._statusEl.className = "error";
            }
            this._armConversationPtt();
        }
    }

    async _onPttPointerUp(_ev) {
        if (!this._pttRecording || this._pttFinishing) return;
        if (this._telnyxTurn) {
            await this._finishTelnyxStreamTurn();
            return;
        }
        const blob = await this._finishPttRecording();
        const waitResolve = this._pttWaitResolve;
        if (typeof waitResolve === "function") {
            this._pttWaitResolve = null;
            this._pttWaitGeneration = 0;
            waitResolve(blob);
            return;
        }
        if (this._isConversationMode() && this._agentEnabled) {
            void this._handleConversationPttBlob(blob);
        } else if (this._usesPttInput()) {
            this._armConversationPtt();
        }
    }

    /** Telnyx hold-to-talk streams the whole turn through the Worker instead of recording a clip. */
    _usesTelnyxStreamTurn() {
        return (
            this._isTelnyxProvider() &&
            this._isConversationMode() &&
            this._agentEnabled &&
            !this._pttWaitResolve
        );
    }

    /** Must not await before `turn.open()`: the microphone's audio context is created inside the press. */
    async _startTelnyxStreamTurn() {
        const key = this._clientApiKey();
        const hosted = !key && this._useHostedAi();
        if (!key && !hosted) throw new Error("Enter your Telnyx API key in the agent panel first.");
        if (hosted && !this._hostedCreditLeft()) {
            void this._ensureHostedAiCredit().catch(() => {});
            throw AgentInterface._creditRequiredError("Add AI credit (or enter your Telnyx API key) to talk.");
        }
        if (typeof window.TelnyxStreamTurn !== "function") {
            throw new Error("Telnyx streaming didn't load (telnyxVoice.js).");
        }
        const stt = this._telnyxSttChoices();
        if (!stt.length) {
            throw new Error(
                `No Telnyx streaming speech-to-text model is available${this._telnyxListError ? `: ${this._telnyxListError}` : "."} Click Refresh Telnyx lists.`
            );
        }
        this._abortPttRecording();
        const turn = new window.TelnyxStreamTurn({
            key,
            session: hosted ? window.playBilling.getActiveSessionId() : "",
            stt,
            voice: this._telnyxVoiceChoices(),
            speak: !!this._voiceOn,
            onPartial: (text) => {
                if (this._telnyxTurn !== turn || !text || !this._statusEl) return;
                this._statusEl.textContent = `Heard: ${text}`;
                this._statusEl.className = "muted";
            },
            onError: (err) => {
                window.playBilling?.recordAiCharge?.(err?.chargeCents);
                if (err?.status === 402) void this._telnyxPaymentRequired(err.session);
                if (this._statusEl) {
                    this._statusEl.textContent = err?.message || "Telnyx stream failed.";
                    this._statusEl.className = "error";
                }
                // Still holding: drop the turn now. After release the running turn handles it.
                if (this._telnyxTurn === turn && this._pttRecording && !this._pttFinishing) {
                    this._abortPttRecording();
                    this._armConversationPtt();
                }
            }
        });
        this._telnyxTurn = turn;
        this._pttRecording = true;
        this._pttRecordStartedAt = Date.now();
        this._setPttState("listening");
        this._pttMaxTimer = setTimeout(() => {
            void this._onPttPointerUp({ type: "maxduration" });
        }, AgentInterface.PTT_MAX_RECORD_MS);
        await turn.open();
    }

    async _finishTelnyxStreamTurn() {
        const turn = this._telnyxTurn;
        if (!turn || this._pttFinishing) return;
        this._pttFinishing = true;
        const finishToken = ++this._pttFinishToken;
        if (this._pttMaxTimer) {
            clearTimeout(this._pttMaxTimer);
            this._pttMaxTimer = null;
        }
        const holdMs = Date.now() - (this._pttRecordStartedAt || Date.now());
        try {
            await new Promise((r) => setTimeout(r, AgentInterface.TELNYX_RELEASE_TAIL_MS));
            if (finishToken !== this._pttFinishToken || this._telnyxTurn !== turn) return;
            this._pttRecording = false;
            this._pttRecordStartedAt = 0;
        } finally {
            if (finishToken === this._pttFinishToken) this._pttFinishing = false;
        }
        if (holdMs < AgentInterface.PTT_MIN_HOLD_MS) {
            turn.cancel();
            this._telnyxTurn = null;
            this._setPttState("idle", { hint: "Didn't catch that — hold a little longer" });
            return;
        }
        await this._runTelnyxStreamTurn(turn);
    }

    /**
     * Sends the chat request as the player lets go; the Worker adds the transcript at the marker,
     * then streams back the reply and its speech, which plays as it arrives.
     * @param {TelnyxStreamTurn} turn
     */
    async _runTelnyxStreamTurn(turn) {
        const generation = this._speakGeneration;
        const agent = this.getSelectedAgent();
        const voice = this._telnyxVoice(agent);
        const player = this._getAudioPlayer();
        const playLabel = `Telnyx (${voice})`;
        this._sendInProgress = true;
        this._syncSendButtonState();
        this._setPttState("processing");
        if (this._statusEl) {
            this._statusEl.textContent = "Finishing the transcript…";
            this._statusEl.className = "muted";
        }
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._clientApiKey());

        const gameTurn = this._beginGamePlayerTurn();
        const textOnly = (content) =>
            Array.isArray(content)
                ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n\n")
                : String(content ?? "");
        let clipsReady = Promise.resolve();
        let userEntry = null;
        let reply = "";
        let replyPushed = false;
        const pieces = [];
        let stream = null;
        let playback = null;
        const live = () => generation === this._speakGeneration && this._agentEnabled;
        const startPlayback = async () => {
            await clipsReady;
            if (!live()) return;
            if (this._isConversationMode()) this._setPttState("talking");
            this._setVoiceStatus(`Speaking (Telnyx ${voice})…`);
            window.__phonebotTtsSpeaking = true;
            stream = typeof player?.startMp3Stream === "function" ? player.startMp3Stream(playLabel) : null;
            if (!stream) return;
            stream.done.catch((err) => console.error("Telnyx streamed playback failed:", err));
            for (const bytes of pieces.splice(0)) stream.push(bytes);
        };

        let ok = false;
        let done = null;
        try {
            const marker = `__PHONEBOT_TRANSCRIPT_${crypto.randomUUID()}__`;
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const userTemplate = this._withGameTurnInstruction(
                this._buildUserTurnContent(stateBlock, null, marker),
                gameTurn.text
            );
            const prior = this._buildPriorConversationMessages();
            const outboundTemplate = await this._mergeIntroductionIntoFirstUserMessage(userTemplate, prior.length);
            const messages = this._withSingleTurnReminder(
                this._toChatTemplate(this._withSystemPrompt([...prior, { role: "user", content: outboundTemplate }]))
            ).map((m) => ({ role: m.role, content: textOnly(m.content) }));
            await this._loadTelnyxLists();
            const models = this._telnyxChatModels(agent);
            if (!models.length) {
                throw new Error(
                    `No Telnyx chat model is available${this._telnyxListError ? `: ${this._telnyxListError}` : "."} Click Refresh Telnyx lists.`
                );
            }
            const chat = {
                models,
                model: models[0].id,
                messages,
                temperature: this._resolveTemperature(agent, models[0].id, null),
                max_tokens: this._resolveMaxTokens(agent, messages)
            };

            done = await turn.release(
                { chat, transcriptMarker: marker },
                {
                    onTranscript: (text) => {
                        if (!live() || userEntry) return;
                        const outboundUser = outboundTemplate.replace(marker, () => text);
                        userEntry = {
                            role: "user",
                            text: prior.length ? this._withGameTurnInstruction(text, gameTurn.text) : outboundUser,
                            fullPrompt: outboundUser,
                            at: new Date().toISOString()
                        };
                        this.messageHistory.push(userEntry);
                        this._renderHistory();
                        this._setPttState("thinking");
                        if (this._statusEl) {
                            this._statusEl.textContent = `Heard: ${text} — thinking…`;
                            this._statusEl.className = "muted";
                        }
                        clipsReady = gameTurn.clipsDone();
                    },
                    onReply: (text) => {
                        reply = String(text || "").trim();
                    },
                    onAudio: (bytes) => {
                        if (!live()) return;
                        if (stream) stream.push(bytes);
                        else pieces.push(bytes);
                        if (!playback) playback = startPlayback();
                    }
                }
            );
            window.playBilling?.recordAiCharge?.(done?.chargeCents);
            this._noteTelnyxModelFailures(done?.failedModels);
            this._noteTelnyxSttFailures(done?.failedStt);
            this._noteTelnyxVoiceFailures(done?.failedVoices);
            this._noteTelnyxWorked("chat", done?.model);
            this._noteTelnyxWorked("stt", done?.sttModel);
            this._noteTelnyxWorked("voice", done?.voice);
            if (done && userEntry && live()) {
                reply = String(done.reply || reply).trim();
                await clipsReady;
                this.messageHistory.push({ role: "assistant", text: reply, at: new Date().toISOString() });
                replyPushed = true;
                this._renderHistory();
                await this._maybeRunActionFromResponse(reply, reply);
                console.info(
                    `Telnyx stream turn (${done.sttModel || "speech-to-text not reported"}, ${done.model || "chat model not reported"}) timings (ms):`,
                    done.timings || {},
                    `speech retries: ${done.speechRetries || 0}`
                );
                ok = true;
            }
        } catch (err) {
            turn.cancel();
            if (!err?.logged) console.error("Telnyx stream turn failed:", err);
            this._noteTelnyxModelFailures(err?.failedModels);
            this._noteTelnyxSttFailures(err?.failedStt);
            this._noteTelnyxVoiceFailures(err?.failedVoices);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Telnyx voice turn failed.";
                this._statusEl.className = "error";
            }
            reply = String(err?.reply || reply).trim();
            if (userEntry && !replyPushed && !reply) {
                const at = this.messageHistory.lastIndexOf(userEntry);
                if (at >= 0) this.messageHistory.splice(at, 1);
                this._renderHistory();
            } else if (userEntry && !replyPushed && reply) {
                this.messageHistory.push({ role: "assistant", text: reply, at: new Date().toISOString() });
                replyPushed = true;
                this._renderHistory();
            }
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }

        try {
            if (playback) await playback;
            if (!live()) return;
            if (stream) {
                stream.end();
                await this._withPlaybackTimeout(stream.done);
            } else if (pieces.length && player && typeof player.playBlob === "function") {
                await this._playSpeechBlob(new Blob(pieces.splice(0), { type: "audio/mpeg" }), reply, generation, {
                    speakingLabel: `Speaking (Telnyx ${voice})…`,
                    idleLabel: this._telnyxSpeechLabel(),
                    playLabel
                });
            } else if (this._voiceOn && reply && replyPushed) {
                if (ok) await this._speakSynthesizedAsync(reply, generation);
                else await this._speakBrowserFallback(reply);
            }
        } catch (err) {
            console.error("Telnyx reply playback failed:", err);
            if (live() && reply) await this._speakBrowserFallback(reply);
        } finally {
            if (this._telnyxTurn === turn) this._telnyxTurn = null;
            window.__phonebotTtsSpeaking = false;
            if (generation === this._speakGeneration) {
                this._setVoiceStatus(this._telnyxSpeechLabel());
                if (ok && this._statusEl && this._agentEnabled) {
                    this._statusEl.textContent = "Done. (Telnyx streaming turn)";
                    this._statusEl.className = "ok";
                }
                if (this._agentEnabled && this._isConversationMode()) this._armConversationPtt();
            }
            gameTurn.finish(ok);
        }
    }

    async _startPttRecording() {
        if (typeof MediaRecorder === "undefined") {
            throw new Error("MediaRecorder is not supported in this browser.");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone capture is not available.");
        }
        this._abortPttRecording();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
        const mimeType = this._pickRecorderMimeType();
        const mediaRecorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
        const chunks = [];
        mediaRecorder.addEventListener("dataavailable", (ev) => {
            if (ev.data && ev.data.size) chunks.push(ev.data);
        });

        this._pttRecordStream = stream;
        this._pttMediaRecorder = mediaRecorder;
        this._pttRecordChunks = chunks;
        this._pttRecording = true;
        this._pttRecordStartedAt = Date.now();
        mediaRecorder.start(200);
        this._setPttState("listening");
        this._pttMaxTimer = setTimeout(() => {
            void this._onPttPointerUp({ type: "maxduration" });
        }, AgentInterface.PTT_MAX_RECORD_MS);
    }

    async _finishPttRecording() {
        if (!this._pttRecording || this._pttFinishing) return null;
        this._pttFinishing = true;
        const finishToken = ++this._pttFinishToken;
        if (this._pttMaxTimer) {
            clearTimeout(this._pttMaxTimer);
            this._pttMaxTimer = null;
        }

        // Measure hold at finger-up; trailing capture does not count toward the minimum.
        const holdMs = Date.now() - (this._pttRecordStartedAt || Date.now());
        const mediaRecorder = this._pttMediaRecorder;
        const chunks = this._pttRecordChunks;
        const stream = this._pttRecordStream;
        const mimeType = mediaRecorder?.mimeType || this._pickRecorderMimeType() || "audio/webm";
        const startedAt = this._pttRecordStartedAt;

        try {
            // Keep capturing briefly after release so speech isn't cut off early.
            await new Promise((r) => setTimeout(r, AgentInterface.PTT_RELEASE_TAIL_MS));
            if (
                finishToken !== this._pttFinishToken ||
                !this._pttRecording ||
                this._pttMediaRecorder !== mediaRecorder ||
                this._pttRecordStartedAt !== startedAt
            ) {
                return null;
            }

            const blob = await new Promise((resolve) => {
                const finish = () => {
                    const type = mediaRecorder?.mimeType || mimeType;
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

            if (
                finishToken !== this._pttFinishToken ||
                this._pttMediaRecorder !== mediaRecorder
            ) {
                return null;
            }

            if (stream) {
                for (const track of stream.getTracks()) {
                    try {
                        track.stop();
                    } catch (_) {}
                }
            }
            this._pttMediaRecorder = null;
            this._pttRecordStream = null;
            this._pttRecordChunks = [];
            this._pttRecording = false;
            this._pttRecordStartedAt = 0;

            if (holdMs < AgentInterface.PTT_MIN_HOLD_MS) return null;
            return blob;
        } finally {
            if (finishToken === this._pttFinishToken) {
                this._pttFinishing = false;
            }
        }
    }

    /**
     * Parrot mode: wait for hold-to-talk, return clip on release.
     * @param {number} generation
     * @param {{ isActive?: () => boolean }} [options]
     * @returns {Promise<Blob|null>}
     */
    async _recordMicrophoneWhileHeld(generation, options = {}) {
        const isActive =
            typeof options.isActive === "function"
                ? options.isActive
                : () => this._agentEnabled && this._usesPttInput();

        while (generation === this._speakGeneration && isActive()) {
            this._ensurePttOverlay();
            this._setPttState("idle");
            const blob = await new Promise((resolve) => {
                this._pttWaitResolve = resolve;
                this._pttWaitGeneration = generation;
            });
            if (generation !== this._speakGeneration || !isActive()) return null;
            if (blob && blob.size >= 32) return blob;
            if (blob) {
                this._setPttState("idle", { hint: "Didn't catch that — try again" });
                await new Promise((r) => setTimeout(r, 900));
            }
        }
        return null;
    }

    /**
     * Process a hold-to-talk clip in conversation mode.
     * @param {Blob|null} blob
     */
    async _handleConversationPttBlob(blob) {
        const generation = this._speakGeneration;
        if (!this._isConversationMode() || !this._agentEnabled) return;
        if (this._conversationListenRunning || this._sendInProgress) return;

        if (!blob || blob.size < 32) {
            this._setPttState("idle", { hint: "Didn't catch that — hold a little longer" });
            if (this._statusEl) {
                this._statusEl.textContent = "No audio captured — hold the button while you speak.";
                this._statusEl.className = "warn";
            }
            return;
        }

        this._conversationListenRunning = true;
        this._syncSendButtonState();
        try {
            this._setPttState("processing");
            if (this._statusEl) {
                this._statusEl.textContent = "Processing…";
                this._statusEl.className = "muted";
            }

            this._apiKey = this._keyInput?.value?.trim() || "";
            const agent = this.getSelectedAgent();
            if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
            if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

            if (generation !== this._speakGeneration || !this._agentEnabled || !this._isConversationMode()) {
                return;
            }

            if (this._isGeminiAudioTurn(agent)) {
                this._setPttState("thinking");
                await this._submitGeminiAudioTurnFromBlob(blob, {
                    speechTranscriber: "Gemini audio turn"
                });
                return;
            }

            if (
                this._useHostedGroq() &&
                typeof window.playBilling?.fetchHostedVoiceTurn === "function"
            ) {
                this._setPttState("thinking");
                await this._submitHostedVoiceTurnFromBlob(blob, {
                    filename: `speech.${this._extensionForRecorderMime(blob.type)}`
                });
                return;
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
                this._armConversationPtt();
                return;
            }
            if (generation !== this._speakGeneration || !this._agentEnabled || !this._isConversationMode()) {
                return;
            }

            text = String(text || "").trim();
            if (!text) {
                this._setPttState("idle", { hint: "Didn't catch that — try again" });
                if (this._statusEl) {
                    this._statusEl.textContent = "No speech heard — hold the button and speak clearly.";
                    this._statusEl.className = "warn";
                }
                this._armConversationPtt();
                return;
            }

            this._setPttState("thinking");
            if (this._statusEl) {
                this._statusEl.textContent = "Sending transcript…";
                this._statusEl.className = "muted";
            }
            await this._submitSpeechPrompt(text, {
                speechTranscriber: `API transcription (${model})`
            });
        } catch (err) {
            console.error("Conversation PTT error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Voice input failed";
                this._statusEl.className = "error";
            }
            this._armConversationPtt();
        } finally {
            this._conversationListenRunning = false;
            this._syncSendButtonState();
        }
    }

    /**
     * @param {string} [label]
     */
    _ensureCameraCountdownOverlay(label = "Photo!") {
        const labelText = String(label || "Photo!").trim() || "Photo!";
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
        const sweepEl = document.createElement("div");
        sweepEl.className = "sensor-camera-countdown-sweep";
        sweepEl.setAttribute("aria-hidden", "true");
        const handEl = document.createElement("div");
        handEl.className = "sensor-camera-countdown-hand";
        handEl.setAttribute("aria-hidden", "true");
        overlay.appendChild(sweepEl);
        overlay.appendChild(handEl);
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

    _stopCameraCountdownSweep() {
        if (this._countdownSweepRaf) cancelAnimationFrame(this._countdownSweepRaf);
        this._countdownSweepRaf = 0;
    }

    /**
     * Sweep a clock hand once around the countdown overlay, revealing the camera behind it.
     * @param {HTMLElement} overlay
     * @param {number} durationMs
     */
    _startCameraCountdownSweep(overlay, durationMs) {
        this._stopCameraCountdownSweep();
        const start = performance.now();
        const tick = (now) => {
            if (overlay !== this._countdownOverlayEl) return;
            const progress = Math.min(1, (now - start) / durationMs);
            overlay.style.setProperty("--sweep-deg", `${(progress * 360).toFixed(2)}deg`);
            this._countdownSweepRaf = progress < 1 ? requestAnimationFrame(tick) : 0;
        };
        overlay.style.setProperty("--sweep-deg", "0deg");
        this._countdownSweepRaf = requestAnimationFrame(tick);
    }

    /**
     * Show a full-frame countdown on the camera (N…1), then clear.
     * @param {number} seconds
     * @param {number} [generation] Cancel if `_speakGeneration` changes (Simon Says). Ignored when `options.isActive` is set.
     * @param {{ label?: string, statusPrefix?: string, isActive?: () => boolean }} [options]
     * @returns {Promise<boolean>} true if countdown completed for this generation
     */
    async _runCameraCountdown(seconds, generation, options = {}) {
        const raw = Number(seconds);
        if (!Number.isFinite(raw) || raw <= 0) return true;
        const total = Math.max(1, Math.ceil(raw));
        const label = String(options.label || "Photo!").trim() || "Photo!";
        const statusPrefix = String(options.statusPrefix || "Photo in").trim() || "Photo in";
        const isActive =
            typeof options.isActive === "function"
                ? options.isActive
                : () => generation == null || generation === this._speakGeneration;
        const overlay = this._ensureCameraCountdownOverlay(label);
        if (!overlay) {
            // No camera UI — still wait so pose timing stays consistent.
            for (let n = total; n >= 1; n--) {
                if (!isActive()) return false;
                await new Promise((r) => setTimeout(r, 1000));
            }
            return isActive();
        }
        try {
            this._startCameraCountdownSweep(overlay, total * 1000);
            for (let n = total; n >= 1; n--) {
                if (!isActive()) return false;
                if (this._countdownNumberEl) this._countdownNumberEl.textContent = String(n);
                if (this._statusEl) {
                    this._statusEl.textContent = `${statusPrefix} ${n}…`;
                    this._statusEl.className = "muted";
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
            return isActive();
        } finally {
            this._clearCameraCountdownOverlay();
        }
    }

    /**
     * Countdown (optional) → capture frame → shutter flicker → attach to last user message.
     * Used by every photo-send path so overlays stay consistent.
     * @param {Array<{role:string, content: unknown}>} messages
     * @param {{
     *   cameraCountdownSeconds?: number,
     *   skipCameraCountdown?: boolean,
     *   cameraCountdownLabel?: string,
     *   cameraStatusPrefix?: string,
     *   isActive?: () => boolean
     * }} [options]
     * @returns {Promise<boolean>} true if a data-image was attached
     */
    async _attachCameraPhotoWithOverlays(messages, options = {}) {
        const overlayGen = ++this._photoOverlayGeneration;
        const isActive =
            typeof options.isActive === "function"
                ? () => options.isActive() && overlayGen === this._photoOverlayGeneration
                : () => overlayGen === this._photoOverlayGeneration;

        const skipCountdown = options.skipCameraCountdown === true;
        let countdownSec = skipCountdown
            ? 0
            : Math.max(0, Number(options.cameraCountdownSeconds) || 0);
        // Custom / callers can pass fractional delay; show at least 1s of timer when > 0.
        if (countdownSec > 0 && countdownSec < 1) countdownSec = 1;

        if (countdownSec > 0) {
            const ok = await this._runCameraCountdown(countdownSec, null, {
                label: options.cameraCountdownLabel || "Photo!",
                statusPrefix: options.cameraStatusPrefix || "Photo in",
                isActive
            });
            if (!ok) return false;
        }

        if (!isActive()) return false;
        this._refreshCurrentCameraImageUrl();
        const hasImage = String(this.currentCameraImageUrl || "").startsWith("data:image");

        // Always flicker when we intended to send a photo, so capture is visible with no delay.
        await this._runCameraShutterFlicker({ generation: overlayGen, isActive });
        if (!isActive()) return false;

        if (hasImage) {
            this._attachCurrentCameraToLastUserMessage(messages);
            return true;
        }
        return false;
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
     * After TTS finishes: conversation mode shows hold-to-talk.
     * @param {string} spoken
     */
    async _afterAgentSpoke(spoken) {
        const content = String(spoken || "").trim();
        if (!content || !this._voiceOn) return;
        const finished = await this._speakAsync(content);
        if (!finished || !this._agentEnabled) return;
        if (this._isConversationMode()) this._armConversationPtt();
    }

    /** Show hold-to-talk when a conversation turn completes without TTS. */
    _maybeQueueConversationListenAfterTurn() {
        if (!this._agentEnabled || !this._isConversationMode()) return;
        this._armConversationPtt();
    }

    /**
     * @param {number} generation Cancel if `_speakGeneration` changes
     */
    _queueConversationListen(_generation) {
        this._armConversationPtt();
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
        // Never speak a chat.completion API envelope.
        if (Array.isArray(payload.choices) || payload.object === "chat.completion") {
            return "";
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

    /**
     * User-turn body for chat/voice. Only includes Current state when there is real state JSON —
     * talking head has no stateMachine, so we must not inject a fake `[]` (models echo it; TTS
     * then voices the brackets).
     * The player's own words go unlabeled (the user role already says who is speaking); a
     * transcript-style "User said:" label invites the model to write the player's next line.
     * Game instructions and robot notices keep their heading.
     * @param {unknown} stateBlock
     * @param {string|null} label null for the player's words, else e.g. GAME_INSTRUCTION_LABEL
     * @param {string} body
     * @returns {string}
     */
    _buildUserTurnContent(stateBlock, label, body) {
        const state = String(stateBlock || "").trim();
        const text = String(body ?? "");
        if (state) return `Current state (json):\n${state}\n\n${label || "User said"}:\n${text}`;
        return label ? `${label}:\n${text}` : text;
    }

    /**
     * Tell the active game a player message is going out. `text` is the game's instruction
     * for this turn, and any reasoning level it sets applies from this request on. The game may
     * start a clip now, while the request is on its way: call `clipsDone()` once the reply has
     * arrived and before adding it to the history, so the clip is heard and recorded before it.
     * Call `finish(ok)` once the reply has been spoken.
     * @returns {{ text: string, clipsDone: () => Promise<void>, finish: (ok: boolean) => void }}
     */
    _beginGamePlayerTurn() {
        const game = this.robot?._localGame;
        const turn = typeof game?.beginPlayerTurn === "function" ? game.beginPlayerTurn() : null;
        if (turn?.reasoningEffort) this.setReasoningEffort(turn.reasoningEffort);
        // Speaking a clip re-arms hold-to-talk; the request is still on its way.
        const beforeReply = Promise.resolve(turn?.beforeReply).catch(() => {}).then(() => {
            if (this._sendInProgress && this._isConversationMode()) this._setPttState("thinking");
        });
        return {
            text: String(turn?.text || "").trim(),
            clipsDone: async () => {
                await beforeReply;
                if (typeof turn?.recordSpoken === "function") turn.recordSpoken();
            },
            finish: typeof turn?.finish === "function" ? turn.finish : () => {}
        };
    }

    /** Append a game's per-turn instruction to a user message, as sent and as shown in the chat. */
    _withGameTurnInstruction(content, instruction) {
        const extra = String(instruction || "").trim();
        if (!extra) return content;
        return `${content}\n\n${AgentInterface.GAME_INSTRUCTION_LABEL}:\n${extra}`;
    }

    /** Request messages with the single-turn reminder added to the last user message. */
    _withSingleTurnReminder(messages) {
        const last = messages[messages.length - 1];
        if (last?.role !== "user") return messages;
        const reminder = AgentInterface.SINGLE_TURN_REMINDER;
        const content = Array.isArray(last.content)
            ? [...last.content, { type: "text", text: `${AgentInterface.GAME_INSTRUCTION_LABEL}:\n${reminder}` }]
            : this._withGameTurnInstruction(last.content, reminder);
        return [...messages.slice(0, -1), { ...last, content }];
    }

    /** A prompt the game sent on its own, headed so it doesn't read as the player's words. */
    _asGameInstruction(text) {
        const body = String(text || "").trim();
        return body ? `${AgentInterface.GAME_INSTRUCTION_LABEL}:\n${body}` : "";
    }

    /**
     * Character bio prompt: `character` when given, else the active character for robots with
     * `characters: true`; "" when none.
     * @param {{ name?: string, bio?: string }|null} [character]
     */
    _characterPrompt(character = null) {
        if (!character) {
            if (!this.robot?.config?.characters) return "";
            character = window.PhonebotCharacters?.activeCharacter?.();
        }
        if (!character) return "";
        return [
            `You are ${character.name}. Stay in character in every reply, including while running games.`,
            String(character.bio || "").trim()
        ]
            .filter(Boolean)
            .join("\n\n");
    }

    /** [tag] directions the active voice can perform; [] for Web TTS, Gemini and Telnyx. */
    _speechDirectionTags() {
        if (this._isGeminiProvider() || this._isTelnyxProvider() || this._isBrowserTtsVoice()) return [];
        const tags = window.GroqModelSelect?.ORPHEUS_ALLOWED_DIRECTIONS;
        return Array.isArray(tags) ? tags : [];
    }

    /** How spoken replies must be written so TTS reads them cleanly. */
    _speechStylePrompt() {
        const tags = this._speechDirectionTags();
        const bracketRule = tags.length
            ? `You may occasionally add one sound or tone cue in square brackets, chosen only from: ${tags
                  .map((t) => `[${t}]`)
                  .join(", ")}. Use at most one per reply and never any other square brackets.`
            : "Never use square brackets.";
        return [
            "Everything you say is read aloud by a text-to-speech voice.",
            "Write spoken words as plain sentences: no emojis, markdown, asterisks, bullet points or special symbols, and no stage directions or narrated actions.",
            bracketRule,
            "This does not change any reply format you have been asked to use."
        ].join(" ");
    }

    /**
     * Turn-taking rules every game gets for free, so game authors don't have to spell out
     * that a real person answers between replies.
     */
    _conversationPrompt() {
        return [
            "This is a live spoken conversation: after each of your replies, the player answers out loud.",
            "Write only your own next turn, then stop.",
            "Never write, guess or react to an answer the player hasn't given yet, and never play both sides.",
            `Text headed "${AgentInterface.GAME_INSTRUCTION_LABEL}" comes from the game, not the player; follow it without mentioning it.`
        ].join(" ");
    }

    /** Conversation and speech rules plus the character bio (when any), sent as one system message. */
    _systemPrompt(character = null) {
        return [this._conversationPrompt(), this._speechStylePrompt(), this._characterPrompt(character)]
            .filter(Boolean)
            .join("\n\n");
    }

    /** Prepend the system prompt; rebuilt per request, never stored in history. */
    _withSystemPrompt(messages) {
        const prompt = this._systemPrompt();
        return prompt ? [{ role: "system", content: prompt }, ...messages] : messages;
    }

    /**
     * Chat-template shape: one system message first, then user/assistant turns that alternate.
     * Back-to-back same-role turns (a failed send left a user turn, a game clip recorded next
     * to a reply) are merged; empty turns are dropped.
     * @param {Array<{ role: string, content: unknown }>} messages
     */
    _toChatTemplate(messages) {
        const isEmpty = (c) => (Array.isArray(c) ? c.length === 0 : !String(c ?? "").trim());
        const asParts = (c) => (Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }]);
        const join = (a, b) =>
            typeof a === "string" && typeof b === "string" ? `${a}\n\n${b}` : [...asParts(a), ...asParts(b)];
        const systems = [];
        const turns = [];
        for (const m of messages || []) {
            if (!m) continue;
            if (m.role === "system") {
                if (!isEmpty(m.content)) systems.push(String(m.content).trim());
                continue;
            }
            if ((m.role !== "user" && m.role !== "assistant") || isEmpty(m.content)) continue;
            const last = turns[turns.length - 1];
            if (last?.role === m.role) last.content = join(last.content, m.content);
            else turns.push({ role: m.role, content: m.content });
        }
        return systems.length ? [{ role: "system", content: systems.join("\n\n") }, ...turns] : turns;
    }

    /** TTS-safe text; keeps only the [tag] directions the active voice supports. */
    _cleanSpeechText(text) {
        const clean = window.GroqModelSelect?.cleanSpeechText;
        return typeof clean === "function"
            ? clean(text, this._speechDirectionTags())
            : String(text || "").trim();
    }

    /** The agent's max tokens, the same at every reasoning level; thinking and reply share it. */
    _resolveMaxTokens(agent, messages) {
        const base = Number.isFinite(agent?.maxTokens) ? Math.round(agent.maxTokens) : 1024;
        if (typeof window.GroqChatRecover?.ensureVisionMaxTokens === "function") {
            return window.GroqChatRecover.ensureVisionMaxTokens(base, messages);
        }
        const hasVision =
            Array.isArray(messages) &&
            messages.some(
                (m) =>
                    Array.isArray(m?.content) &&
                    m.content.some((p) => p && (p.type === "image_url" || p.type === "image"))
            );
        return hasVision ? Math.max(base, 512) : base;
    }

    /**
     * A manually picked Groq model (BYOK) runs at its recommended temperature; JSON-output agents
     * and the automatic pick keep the agent's configured temperature.
     */
    _resolveTemperature(agent, model, responseFormat) {
        if (this._chatModelChoice && !responseFormat && this._clientApiKey() && !this._isTelnyxProvider(agent)) {
            const tuned = AgentInterface.MODEL_TEMPERATURES.find((t) => t.match.test(String(model || "")));
            if (tuned) return tuned.temperature;
        }
        return Number.isFinite(agent?.temperature)
            ? agent.temperature
            : Number.isFinite(this.config.defaultChatTemperature)
              ? this.config.defaultChatTemperature
              : 0.35;
    }

    _assistantContentFromChatJson(json) {
        if (typeof window.GroqChatRecover?.extractAssistantContentText === "function") {
            return window.GroqChatRecover.extractAssistantContentText(json);
        }
        const msg = json?.choices?.[0]?.message;
        const raw =
            (typeof msg?.content === "string" && msg.content) ||
            json?.choices?.[0]?.text ||
            "";
        return this._stripThinkingBlocks(String(raw || "").trim());
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
     * Copy camera overlay / force-attach options onto a sendPrompt options object.
     * @param {object} target
     * @param {object} source
     */
    _assignCameraSendOptions(target, source = {}) {
        if (!target || !source) return target;
        if (source.forceCameraImage === true) target.forceCameraImage = true;
        if (source.skipCameraCountdown === true) target.skipCameraCountdown = true;
        if (source.cameraCountdownSeconds != null) {
            target.cameraCountdownSeconds = source.cameraCountdownSeconds;
        }
        if (source.cameraCountdownLabel != null) {
            target.cameraCountdownLabel = source.cameraCountdownLabel;
        }
        if (source.cameraStatusPrefix != null) {
            target.cameraStatusPrefix = source.cameraStatusPrefix;
        }
        if (typeof source.cameraOverlayIsActive === "function") {
            target.cameraOverlayIsActive = source.cameraOverlayIsActive;
        }
        return target;
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
     * Custom mode never merges a template.
     */
    _getIntroductionTemplateSpec() {
        if (this._isCustomMessagesMode()) return null;
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

    /** Loads the mode / introduction template used for the opening kickoff send. */
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
            return block ? `Current state (json):\n${block}` : "Current state (json):\n(none)";
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

        const userMatch = body.match(
            /(?:^|\n)(?:User said|User|Robot notice|Game instruction \(not said by the player\)):\n([\s\S]*)$/i
        );
        const userPart = userMatch ? this._normalizePromptText(userMatch[1]) : "";
        // Exact template-only send (textarea still holds the start prompt).
        if (userPart && userPart === head) {
            const stateMatch = body.match(
                /Current state \(json\):\n[\s\S]*?(?=\n\n(?:User said|User|Robot notice|Game instruction \(not said by the player\)):|$)/i
            );
            const stateBlock = stateMatch ? stateMatch[0].trim() : "";
            return stateBlock ? `${head}\n\n${stateBlock}` : head;
        }

        if (bodyNorm.includes(head)) return body;
        const headPrefix = head.slice(0, Math.min(120, head.length)).trim();
        if (headPrefix.length >= 24 && bodyNorm.includes(headPrefix)) return body;
        const headed = /^(?:Current state \(json\)|User said|User|Robot notice|Game instruction \(not said by the player\)):\n/i.test(
            body
        );
        return `${head}\n\n${headed ? body : `User said:\n${body}`}`;
    }

    /** True once any user/assistant turn is in history (kickoff or player turn completed). */
    _hasConversationHistory() {
        return (this.messageHistory || []).some(
            (m) => m && (m.role === "user" || m.role === "assistant")
        );
    }

    /**
     * @param {string} userText
     * @param {{ singleTurn?: boolean, messages?: Array<{role:string,content:string|unknown}>, systemPrompt?: string, reasoningEffort?: string }} [options]
     * If `messages` is provided, it is sent as-is (then the last user message gets the current camera image if available).
     * If singleTurn, only `userText` is sent as one user message.
     * systemPrompt replaces the usual speech rules + active character bio ("" sends none).
     * reasoningEffort applies to this request only.
     */
    async sendPrompt(userText, options = {}) {
        await this._ensureHostedAiCredit();
        await this.ensureSessionGroqModels();
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
        const hostedArcadeChat =
            !gemini &&
            this._useHostedGroq() &&
            typeof window.playBilling?.fetchHostedChat === "function";
        const hostedTelnyxChat = this._isTelnyxProvider(agent) && this._useHostedAi();
        const apiKey = this._clientApiKey();
        if (!hostedArcadeChat && !hostedTelnyxChat && !apiKey) {
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
        if (typeof options.systemPrompt === "string") {
            const system = options.systemPrompt.trim();
            if (system) conversationMessages.unshift({ role: "system", content: system });
        } else {
            conversationMessages = this._withSystemPrompt(conversationMessages);
        }
        conversationMessages = this._toChatTemplate(conversationMessages);

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
            await this._attachCameraPhotoWithOverlays(conversationMessages, {
                cameraCountdownSeconds: options.cameraCountdownSeconds,
                skipCameraCountdown: options.skipCameraCountdown === true,
                cameraCountdownLabel: options.cameraCountdownLabel,
                cameraStatusPrefix: options.cameraStatusPrefix,
                isActive: options.cameraOverlayIsActive
            });
        }

        if (this._isTelnyxProvider(agent)) await this._loadTelnyxLists();
        const model = this._resolveModel(agent, {
            wantVision: sendCameraImage || this._messagesIncludeVisionImage(conversationMessages)
        });
        if (!model) {
            throw new Error(
                this._isTelnyxProvider(agent)
                    ? `No Telnyx chat model is available${this._telnyxListError ? `: ${this._telnyxListError}` : "."} Click Refresh Telnyx lists.`
                    : "Set a model on the agent or pick a chat model."
            );
        }
        if (
            this._messagesIncludeVisionImage(conversationMessages) &&
            this._sessionModels &&
            !this._sessionModels.vision
        ) {
            throw new Error(
                "Camera image attached but no Groq vision model is available. Uncheck Send camera image or wait for model select."
            );
        }

        if (gemini) {
            return await this._sendGeminiChat(agent, conversationMessages, apiKey, model);
        }

        const responseFormat =
            agent.responseFormat && typeof agent.responseFormat === "object"
                ? agent.responseFormat
                : this.config.chatResponseFormat && typeof this.config.chatResponseFormat === "object"
                  ? this.config.chatResponseFormat
                  : null;

        const telnyx = this._isTelnyxProvider(agent);
        const streamReply =
            !telnyx &&
            !hostedArcadeChat &&
            !responseFormat &&
            typeof window.GroqChatRecover?.readChatCompletionStream === "function";
        const reasoningEffort = telnyx ? null : this._resolveReasoningEffort(agent, model, options.reasoningEffort);
        const body = {
            model,
            messages: responseFormat ? conversationMessages : this._withSingleTurnReminder(conversationMessages),
            temperature: this._resolveTemperature(agent, model, responseFormat),
            max_tokens: this._resolveMaxTokens(agent, conversationMessages)
        };
        if (responseFormat) {
            body.response_format = responseFormat;
        }
        if (streamReply) {
            body.stream = true;
            body.stream_options = { include_usage: true };
        }
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

        const send = async (model) => {
            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timeoutMs = telnyx ? 30000 : 90000;
            const timeoutId =
                controller &&
                setTimeout(() => {
                    try {
                        controller.abort();
                    } catch (_) {}
                }, timeoutMs);
            let res;
            try {
                res = hostedTelnyxChat
                    ? await window.TelnyxVoice.fetch(
                          "/ai/openai/chat/completions",
                          {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(body),
                              signal: controller?.signal
                          },
                          window.TelnyxVoice.HOSTED
                      )
                    : hostedArcadeChat
                    ? await window.playBilling.fetchHostedChat(body, controller?.signal)
                    : await fetch(url, {
                          method: String(agent.method || "POST").toUpperCase(),
                          headers,
                          body: JSON.stringify(body),
                          signal: controller?.signal
                      });
                if (await window.playBilling?.handlePaymentRequired?.(res, this._billingContext())) {
                    this._billingPaused = true;
                    throw AgentInterface._creditRequiredError("AI budget used. Pay to continue.");
                }
            } catch (err) {
                if (err?.name === "AbortError") {
                    throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
                }
                throw err;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }

            if (!res.ok) {
                return this._chatErrorReply(res.status, await res.text(), model);
            }
            if (body.stream && res.body && /text\/event-stream/i.test(res.headers.get("Content-Type") || "")) {
                const streamed = await window.GroqChatRecover.readChatCompletionStream(res, model);
                if (streamed.errorText) return this._chatErrorReply(400, streamed.errorText, model);
                if (streamed.cut) {
                    console.warn("AgentInterface: model started a second message; kept only the first reply.", {
                        model: streamed.json.model,
                        requestId: streamed.json.x_groq?.id,
                        reasoning: streamed.json.choices[0].message.reasoning
                    });
                }
                return this._chatReplyFromJson(streamed.json, JSON.stringify(streamed.json));
            }

            const rawText = await res.text();
            let json;
            try {
                json = JSON.parse(rawText);
            } catch (_) {
                throw new Error("Response was not JSON.");
            }
            return this._chatReplyFromJson(json, rawText);
        };

        if (!telnyx) return await send(model);
        return await this._sendTelnyxChatWithFallback(agent, body, send);
    }

    /**
     * Tries the Telnyx chat models in order until one replies. Key, credit and rate-limit errors
     * stop straight away: another model would fail the same way.
     */
    async _sendTelnyxChatWithFallback(agent, body, send) {
        const models = this._telnyxChatModels(agent);
        const failed = [];
        try {
            for (const [i, m] of models.entries()) {
                body.model = m.id;
                if (m.thinkingOff) body.chat_template_kwargs = { enable_thinking: false };
                else delete body.chat_template_kwargs;
                try {
                    const result = await send(m.id);
                    this._noteTelnyxWorked("chat", m.id);
                    return result;
                } catch (err) {
                    if (
                        i === models.length - 1 ||
                        err?.code === AgentInterface.CREDIT_REQUIRED ||
                        /^HTTP (401|402|403|429)\b/.test(String(err?.message))
                    ) {
                        throw err;
                    }
                    console.error(`Telnyx chat model ${m.id} failed; trying the next one.`, err);
                    failed.push(m.id);
                }
            }
        } finally {
            this._noteTelnyxModelFailures(failed);
        }
        throw new Error("No Telnyx chat model is available. Click Refresh Telnyx lists.");
    }

    /** `{ rawText, json, contentText }` for a chat completion; throws when it has no content. */
    _chatReplyFromJson(json, rawText) {
        const contentText = this._assistantContentFromChatJson(json);
        if (!contentText) {
            const finish = json?.choices?.[0]?.finish_reason || "unknown";
            throw new Error(
                `Model returned empty content (finish_reason=${finish}). Increase max tokens for vision/reasoning turns.`
            );
        }
        return { rawText, json, contentText };
    }

    /** Reply salvaged from a Groq tool_use_failed error; otherwise throws the HTTP error. */
    _chatErrorReply(status, rawText, model) {
        const salvaged = this._trySalvageGroqChatError(status, rawText, model);
        const salvagedText = String(salvaged?.contentText || "").trim();
        if (!salvagedText) {
            throw new Error(`HTTP ${status}: ${String(rawText || "").slice(0, 500)}`);
        }
        return {
            rawText,
            json: salvaged.payload,
            contentText: this._stripThinkingBlocks(salvagedText) || salvagedText,
            salvagedFrom: "tool_use_failed"
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
        const systemInstruction = conversationMessages
            .filter((m) => m?.role === "system" && typeof m.content === "string")
            .map((m) => m.content)
            .join("\n\n");
        const result = await window.GeminiAudioTurn.generateContent({
            apiKey,
            baseUrl: window.GeminiAudioTurn.resolveBaseUrl(agent, this.defaultBaseUrl),
            model: model || window.GeminiAudioTurn.DEFAULT_MODEL,
            contents: window.GeminiAudioTurn.chatMessagesToContents(conversationMessages),
            systemInstruction: systemInstruction || undefined,
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

    /**
     * Local fallback when window.GroqChatRecover is missing or stale.
     * Handles gpt-oss Harmony leaks with unquoted `"arguments": prose…}`.
     * @param {number} status
     * @param {string} rawText
     * @param {string} [model]
     * @returns {{ contentText: string, payload: object }|null}
     */
    _trySalvageGroqChatErrorLocal(status, rawText, model = "") {
        if (status < 400) return null;
        const raw = String(rawText || "");
        if (!/tool_use_failed|tool choice is none|failed_generation/i.test(raw)) return null;

        let failed = "";
        try {
            const obj = JSON.parse(raw);
            const err = obj?.error && typeof obj.error === "object" ? obj.error : obj;
            failed = err?.failed_generation;
        } catch (_) {
            failed = "";
        }

        const blob = typeof failed === "string" ? failed : failed != null ? JSON.stringify(failed) : raw;
        let text = "";

        const quoted = blob.match(/"arguments"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (quoted) {
            try {
                text = JSON.parse(`"${quoted[1]}"`);
            } catch (_) {
                text = quoted[1];
            }
        }
        if (!text) {
            // Bare prose (invalid JSON): "arguments": Ah, the mystery…}
            const bare = blob.match(/"arguments"\s*:\s*(?!"|\{)([\s\S]*?)\s*\}\s*$/);
            if (bare) text = bare[1].replace(/\}\s*$/, "").trim();
        }
        if (!text && typeof failed === "string" && !failed.trim().startsWith("{")) {
            text = failed.trim();
        }
        text = String(text || "").trim();
        if (!text) return null;

        return {
            contentText: text,
            payload: {
                id: "phonebot-salvaged",
                object: "chat.completion",
                model: model || "unknown",
                choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
                usage: {
                    prompt_tokens: 0,
                    completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
                    total_tokens: Math.max(1, Math.ceil(text.length / 4))
                },
                phonebot_salvaged_from: "tool_use_failed"
            }
        };
    }

    _trySalvageGroqChatError(status, rawText, model = "") {
        if (typeof window.GroqChatRecover?.trySalvageGroqChatError === "function") {
            const fromMod = window.GroqChatRecover.trySalvageGroqChatError(status, rawText, model);
            if (fromMod?.contentText) return fromMod;
        }
        return this._trySalvageGroqChatErrorLocal(status, rawText, model);
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
        await this.robot?.whenResumed?.();
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
            systemOrIntro: [this._systemPrompt(), String(systemOrIntro || "").trim()]
                .filter(Boolean)
                .join("\n\n"),
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
        // Gemini audio turn is driven by a hold-to-talk mic clip.
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
        if (this._isConversationMode()) this._setPttState("thinking");
        if (this._statusEl) {
            this._statusEl.textContent = "Thinking…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let replyAudio = null;
        let ok = false;
        const gameTurn = this._beginGamePlayerTurn();
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const intro = await this._fetchIntroductionPromptContent();
            const prior = this._buildPriorConversationMessages();
            const result = await this.sendGeminiAudioTurn({
                audioBlob: blob,
                textHistory: prior,
                systemOrIntro: this._withGameTurnInstruction(intro, gameTurn.text),
                stateJson: stateBlock,
                voice: this._ttsVoice
            });
            const userTranscript = String(result?.userTranscript || "").trim();
            const assistantTranscript = String(result?.assistantTranscript || "").trim();
            if (!userTranscript) {
                if (this._statusEl) {
                    this._statusEl.textContent = "No speech heard — hold the button and speak clearly.";
                    this._statusEl.className = "warn";
                }
                this._armConversationPtt();
                gameTurn.finish(false);
                return false;
            }
            if (!assistantTranscript && !(result?.audioBlob && result.audioBlob.size >= 44)) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Gemini returned no reply — try again.";
                    this._statusEl.className = "error";
                }
                this._armConversationPtt();
                gameTurn.finish(false);
                return false;
            }
            const fullUserContent = this._withGameTurnInstruction(
                this._buildUserTurnContent(stateBlock, null, userTranscript),
                gameTurn.text
            );
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            this.messageHistory.push({
                role: "user",
                text: prior.length
                    ? this._withGameTurnInstruction(userTranscript, gameTurn.text)
                    : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            await gameTurn.clipsDone();
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
            this._armConversationPtt();
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
                }
            }
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = `Done. (heard you via ${speechTranscriber})`;
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        }
        gameTurn.finish(ok);
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
        if (this._sendInProgress) {
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (this._conversationListenRunning) {
            this._stopSpeaking();
        }

        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._isConversationMode()) this._setPttState("thinking");
        if (this._statusEl) {
            this._statusEl.textContent = "Thinking…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let ok = false;
        const gameTurn = this._beginGamePlayerTurn();
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const fullUserContent = this._withGameTurnInstruction(
                this._buildUserTurnContent(stateBlock, null, text),
                gameTurn.text
            );
            const prior = this._buildPriorConversationMessages();
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            const conversationMessages = [...prior, { role: "user", content: outboundUser }];
            this.messageHistory.push({
                role: "user",
                text: prior.length ? this._withGameTurnInstruction(text, gameTurn.text) : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            this._renderHistory();
            const reply = await this.sendPrompt("", { messages: conversationMessages });
            await gameTurn.clipsDone();
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
        } else if (this._agentEnabled && this._isConversationMode()) {
            this._armConversationPtt();
        }
        gameTurn.finish(ok);
        return ok;
    }

    /**
     * Hosted arcade voice turn: one Worker request performs transcription, chat, and TTS.
     * This is never used when the user has entered a BYOK key.
     */
    async _submitHostedVoiceTurnFromBlob(blob, options = {}) {
        if (!this._agentEnabled || !this._useHostedGroq()) return false;
        if (this._sendInProgress) return false;

        const agent = this.getSelectedAgent();
        if (!agent || this._isGeminiProvider(agent)) return false;

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._isConversationMode()) this._setPttState("thinking");
        if (this._statusEl) {
            this._statusEl.textContent = "Thinking…";
            this._statusEl.className = "muted";
        }

        let result = null;
        let audioBlob = null;
        let ok = false;
        const gameTurn = this._beginGamePlayerTurn();
        try {
            await this._ensureHostedAiCredit();
            await this.ensureSessionGroqModels();
            const marker = `__PHONEBOT_TRANSCRIPT_${crypto.randomUUID()}__`;
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const userTemplate = this._withGameTurnInstruction(
                this._buildUserTurnContent(stateBlock, null, marker),
                gameTurn.text
            );
            const prior = this._buildPriorConversationMessages();
            const outboundTemplate = await this._mergeIntroductionIntoFirstUserMessage(
                userTemplate,
                prior.length
            );
            const conversationMessages = this._toChatTemplate(
                this._withSystemPrompt([...prior, { role: "user", content: outboundTemplate }])
            );
            if (this._sendCameraImageInput) {
                this._sendCameraImage = !!this._sendCameraImageInput.checked;
            }
            if (this._sendCameraImage) {
                await this._attachCameraPhotoWithOverlays(conversationMessages, {
                    isActive: () => this._agentEnabled && this._sendInProgress
                });
            }

            const model = this._resolveModel(agent, {
                wantVision:
                    !!this._sendCameraImage || this._messagesIncludeVisionImage(conversationMessages)
            });
            if (!model) throw new Error("Set a model on the agent or pick a chat model.");

            const responseFormat =
                agent.responseFormat && typeof agent.responseFormat === "object"
                    ? agent.responseFormat
                    : this.config.chatResponseFormat && typeof this.config.chatResponseFormat === "object"
                      ? this.config.chatResponseFormat
                      : null;
            const reasoningEffort = this._resolveReasoningEffort(agent, model);
            const chatBody = {
                model,
                messages: responseFormat ? conversationMessages : this._withSingleTurnReminder(conversationMessages),
                temperature: this._resolveTemperature(agent, model, responseFormat),
                max_tokens: this._resolveMaxTokens(agent, conversationMessages)
            };
            if (responseFormat) chatBody.response_format = responseFormat;
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
            form.append("synthesizeSpeech", this._voiceOn && !this._isBrowserTtsVoice() ? "true" : "false");
            form.append("speechModel", this._resolveSpeechModel(agent));
            form.append("voice", this._isBrowserTtsVoice() ? (window.GroqTts?.PREFERRED_VOICE || "austin") : this._ttsVoice);

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
                    throw AgentInterface._creditRequiredError("AI budget used. Pay to continue.");
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
            const outboundUser = outboundTemplate.replace(marker, transcript);
            const contentText = String(result?.contentText || "").trim();
            const rawText = JSON.stringify(result?.chat || {});
            this.messageHistory.push({
                role: "user",
                text: prior.length
                    ? this._withGameTurnInstruction(transcript, gameTurn.text)
                    : outboundUser,
                fullPrompt: outboundUser,
                at: new Date().toISOString()
            });
            await gameTurn.clipsDone();
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
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }

        if (!ok) {
            if (this._agentEnabled && this._isConversationMode()) this._armConversationPtt();
            gameTurn.finish(false);
            return false;
        }
        const spokenText = String(result?.spokenText || result?.contentText || "").trim();
        if (this._voiceOn && spokenText) {
            const generation = this._speakGeneration;
            const hostedChunks = Array.isArray(result?.audioChunks) ? result.audioChunks : [];
            try {
                if (this._isBrowserTtsVoice()) {
                    await this._speakBrowserFallback(spokenText);
                } else if (hostedChunks.length) {
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
        gameTurn.finish(true);
        return true;
    }

    async _onSend(options = {}) {
        if (!this._promptInput && !this._dashboardPromptInput) return;
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
        // Manual send wins over an in-progress conversation listen cycle.
        if (this._conversationListenRunning) {
            this._stopSpeaking();
        }
        // Kickoffs and game prompts pass `text`; only the player's own typing lives in the chat box.
        const typed = options.text == null;
        const text = typed ? this._readPromptText() : String(options.text).trim();
        const isKickoff = !!options.isKickoff;
        if (!options.resumed) this._pendingSend = null;
        let heldForCredit = false;
        const modeGeneration = options.modeGeneration;
        const modeStillCurrent = () =>
            modeGeneration == null || modeGeneration === this._modeStartGeneration;
        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._isConversationMode()) this._setPttState("thinking");
        if (this._statusEl) {
            this._statusEl.textContent = isKickoff ? "Starting…" : "Sending…";
            this._statusEl.className = "muted";
        }
        let spokenForFollowUp = "";
        let ok = false;
        let pendingUserTurn = null;
        let gameTurn = null;
        try {
            if (!text && !options.allowEmpty) {
                if (this._statusEl) {
                    this._statusEl.textContent = "Enter a prompt.";
                    this._statusEl.className = "warn";
                }
                return;
            }
            if (!modeStillCurrent()) return;
            // Typed chat is a player turn; kickoffs and game-sent prompts are not.
            if (!isKickoff && !options.gameAction) gameTurn = this._beginGamePlayerTurn();
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const label = options.gameAction ? AgentInterface.GAME_INSTRUCTION_LABEL : null;
            const fullUserContent = this._withGameTurnInstruction(
                this._buildUserTurnContent(stateBlock, label, text),
                gameTurn?.text
            );
            const prior = this._buildPriorConversationMessages();
            const outboundUser = await this._mergeIntroductionIntoFirstUserMessage(fullUserContent, prior.length);
            if (!modeStillCurrent()) return;
            const historyText = options.gameAction
                ? this._asGameInstruction(text)
                : this._withGameTurnInstruction(text, gameTurn?.text);
            pendingUserTurn = {
                role: "user",
                text: prior.length ? historyText : outboundUser,
                fullPrompt: outboundUser,
                isKickoff: isKickoff || undefined,
                at: new Date().toISOString()
            };
            this.messageHistory.push(pendingUserTurn);
            this._renderHistory();
            const conversationMessages = [...prior, { role: "user", content: outboundUser }];
            const sendOpts = { messages: conversationMessages };
            this._assignCameraSendOptions(sendOpts, options);
            const reply = await this.sendPrompt("", sendOpts);
            if (!modeStillCurrent()) {
                this._clearCameraPhotoOverlays();
                if (this.messageHistory.length && this.messageHistory[this.messageHistory.length - 1]?.role === "user") {
                    this.messageHistory.pop();
                    this._renderHistory();
                }
                gameTurn?.finish(false);
                return;
            }
            await gameTurn?.clipsDone();
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
            this._clearSentPromptSource(options);
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
            if (
                pendingUserTurn &&
                modeStillCurrent() &&
                this.messageHistory[this.messageHistory.length - 1] === pendingUserTurn
            ) {
                this.messageHistory.pop();
                this._renderHistory();
            }
            if (!typed) this._clearSentPromptSource(options);
            if (err?.code === AgentInterface.CREDIT_REQUIRED && modeStillCurrent() && this._agentEnabled) {
                const { resumed: _resumed, text: _text, ...rest } = options;
                this._pendingSend = {
                    text,
                    typed,
                    options: rest,
                    modeGeneration: this._modeStartGeneration
                };
                heldForCredit = true;
                if (this._statusEl) {
                    this._statusEl.textContent =
                        "Waiting for AI credit — the robot will carry on automatically.";
                    this._statusEl.className = "warn";
                }
            }
            spokenForFollowUp = "";
            ok = false;
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
        if (!modeStillCurrent()) {
            gameTurn?.finish(false);
            return;
        }
        if (ok && spokenForFollowUp) {
            await this._afterAgentSpoke(spokenForFollowUp);
            if (this._statusEl && this._agentEnabled) {
                this._statusEl.textContent = "Done.";
                this._statusEl.className = "ok";
            }
        } else if (ok) {
            this._maybeQueueConversationListenAfterTurn();
        } else if (this._agentEnabled && this._isConversationMode()) {
            this._armConversationPtt();
        }
        gameTurn?.finish(ok);
        // Credit may have been bought from the out-of-credit popup while this request was failing.
        if (heldForCredit && !options.resumed) void this._resumePendingSend();
    }

    /** Kickoff text came from the prompt textarea; game prompts passed as `text` never touched either box. */
    _clearSentPromptSource(options = {}) {
        if (options.text == null) {
            this._clearPromptInputs();
        } else if (options.isKickoff && this._promptInput) {
            this._promptInput.value = "";
        }
    }

    /**
     * Used by external modules (e.g. SpeechToText model) to submit a prompt.
     * @param {string} text
     * @param {{ fromSpeech?: boolean, speechTranscriber?: string, allowEmpty?: boolean, forceCameraImage?: boolean, cameraCountdownSeconds?: number, skipCameraCountdown?: boolean, cameraCountdownLabel?: string, cameraStatusPrefix?: string, cameraOverlayIsActive?: () => boolean, reasoningEffort?: "low"|"medium"|"high", gameAction?: boolean }} [options] gameAction marks text the game sent on its own: it is sent and stored as a game instruction, not as the player's words, and is not a player turn. If fromSpeech, sends full user/assistant history plus current state and transcript; the introduction template is merged into the first user message only and stored in history. speechTranscriber labels the STT path for status/TTS hints. allowEmpty permits an empty prompt body. forceCameraImage attaches the current camera frame even if the checkbox is off. Camera countdown/flicker overlays run on every photo attach. reasoningEffort sets the talking-head reasoning level for this and every later send until changed.
     * @returns {Promise<boolean>}
     */
    async submitPrompt(text, options = {}) {
        const next = String(text || "").trim();
        if (!next && options.allowEmpty !== true) return false;
        if (options.fromSpeech) {
            return await this._submitSpeechPrompt(next, options);
        }
        if (!this._agentEnabled) {
            return false;
        }
        if (!this._promptInput && !this._dashboardPromptInput) return false;
        const sendOpts = {
            text: next,
            allowEmpty: options.allowEmpty === true,
            forceCameraImage: options.forceCameraImage === true,
            gameAction: options.gameAction === true
        };
        this._assignCameraSendOptions(sendOpts, options);
        if (options.reasoningEffort) this.setReasoningEffort(options.reasoningEffort);
        await this._onSend(sendOpts);
        return true;
    }

    /**
     * One-off reply to `prompt` as `character` would say it: sends only the speech rules, the
     * character's bio and the prompt — no chat history, state, intro template or camera — and
     * stores nothing. Works with the agent turned off.
     * @param {string} prompt
     * @param {{ character?: { name?: string, bio?: string }|null, reasoningEffort?: string }} [options]
     *   character defaults to the active one.
     * @returns {Promise<string>} The text the robot would speak.
     */
    async generateReply(prompt, { character = null, reasoningEffort = null } = {}) {
        const text = String(prompt || "").trim();
        if (!text) throw new Error("Enter a prompt.");
        const reply = await this.sendPrompt("", {
            messages: [{ role: "user", content: text }],
            systemPrompt: this._systemPrompt(character),
            reasoningEffort,
            skipVisionAttachment: true
        });
        return this._extractSpokenText(reply.contentText, reply.rawText);
    }

    /**
     * Add a game action that is spoken without a request to the chat history, as a live prompt
     * would be: its prompt (if any) as a game-instruction user turn and the spoken text as the reply.
     * @param {string} spokenText
     * @param {{ prompt?: string }} [options]
     */
    recordSpokenTurn(spokenText, { prompt = "" } = {}) {
        const said = String(spokenText || "").trim();
        if (!said) return;
        const at = new Date().toISOString();
        const ask = String(prompt || "").trim();
        if (ask) {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            this.messageHistory.push({
                role: "user",
                text: this._asGameInstruction(ask),
                fullPrompt: this._buildUserTurnContent(stateBlock, AgentInterface.GAME_INSTRUCTION_LABEL, ask),
                at
            });
        }
        this.messageHistory.push({ role: "assistant", text: said, at });
        this._renderHistory();
    }

    /**
     * Same request shape as voice prompts: prior user/assistant history plus one user message that starts with state machine JSON.
     * For proactive robot notices (e.g. strategies) so the model sees current state and conversation context.
     * @param {string} text Short text shown in the history bubble after the first turn (first turn may include merged introduction in the bubble).
     * @param {{ contextLabel?: string, speechTranscriber?: string, forceCameraImage?: boolean, cameraCountdownSeconds?: number, skipCameraCountdown?: boolean, cameraCountdownLabel?: string, cameraStatusPrefix?: string, cameraOverlayIsActive?: () => boolean }} [options] contextLabel prefixes the payload block (default "Robot notice"). speechTranscriber labels status/TTS hints. forceCameraImage attaches the current camera frame even if the checkbox is off.
     * @returns {Promise<boolean>} false if agent off, empty text, send already in progress, or missing API key / agent
     */
    async submitPromptWithRobotState(text, options = {}) {
        const transcript = String(text || "").trim();
        if (!transcript) return false;
        if (!this._agentEnabled) return false;
        if (this._sendInProgress) {
            console.warn("AgentInterface: send already in progress; skipped submitPromptWithRobotState.");
            if (this._statusEl) {
                this._statusEl.textContent = "Already sending — wait for the current request to finish.";
                this._statusEl.className = "warn";
            }
            return false;
        }
        if (this._conversationListenRunning) {
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
        if (!this._apiKey && !this._useHostedAi()) {
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
            const fullUserContent = this._buildUserTurnContent(stateBlock, label, transcript);
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
            this._assignCameraSendOptions(sendOpts, options);
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
        this._renderHistoryInto(this._historyEl, { includeKickoff: true, includeSystem: true });
        this._renderHistoryInto(this._dashboardHistoryEl, {
            includeKickoff: true,
            includeSystem: false,
            compact: true
        });
        this._updateDashboardPromptPlaceholder();
    }

    /**
     * @param {HTMLElement|null} el
     * @param {{ includeKickoff?: boolean, includeSystem?: boolean, compact?: boolean }} [options]
     */
    _renderHistoryInto(el, options = {}) {
        if (!el) return;
        el.replaceChildren();
        const includeKickoff = options.includeKickoff !== false;
        const includeSystem = options.includeSystem !== false;
        const compact = !!options.compact;
        for (const m of this.messageHistory) {
            if (!m) continue;
            if (!includeKickoff && m.isKickoff) continue;
            if (!includeSystem && m.role === "system") continue;
            const bubble = document.createElement("div");
            const roleClass =
                m.role === "user"
                    ? "agent-history-user"
                    : m.role === "system"
                      ? "agent-history-system"
                      : "agent-history-agent";
            bubble.className = "agent-history-bubble " + roleClass;
            let displayText = m.text != null ? String(m.text) : "";
            if (
                m.role === "user" &&
                this._showFullSpeechPrompt &&
                typeof m.fullPrompt === "string" &&
                m.fullPrompt.trim() !== ""
            ) {
                displayText = m.fullPrompt;
            }
            if (compact) {
                bubble.textContent = displayText;
            } else {
                const who = document.createElement("span");
                who.className = "agent-history-who";
                who.textContent =
                    m.role === "user" ? "You" : m.role === "system" ? "System" : "Agent";
                const body = document.createElement("div");
                body.className = "agent-history-body";
                body.textContent = displayText;
                bubble.appendChild(who);
                bubble.appendChild(body);
            }
            el.appendChild(bubble);
        }
        el.scrollTop = el.scrollHeight;
    }

    /** "Ask Robot" until the agent has spoken; then "Reply to Robot". */
    _updateDashboardPromptPlaceholder() {
        const input = this._dashboardPromptInput;
        if (!input) return;
        const hasAgentReply = (this.messageHistory || []).some(
            (m) => m && m.role === "assistant" && String(m.text || "").trim()
        );
        input.placeholder = hasAgentReply ? "Reply to Robot" : "Ask Robot";
    }

    _readPromptText() {
        const dash = String(this._dashboardPromptInput?.value || "").trim();
        if (dash) return dash;
        return String(this._promptInput?.value || "").trim();
    }

    _clearPromptInputs() {
        if (this._promptInput) this._promptInput.value = "";
        if (this._dashboardPromptInput) this._dashboardPromptInput.value = "";
    }

    _bindDashboardMicPointers(btn) {
        if (!btn) return;
        const endHold = (ev) => {
            if (ev?.pointerId != null && btn.hasPointerCapture(ev.pointerId)) {
                try {
                    btn.releasePointerCapture(ev.pointerId);
                } catch (_) {}
            }
            void this._onPttPointerUp(ev);
        };
        btn.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            try {
                btn.setPointerCapture(e.pointerId);
            } catch (_) {}
            void this._onPttPointerDown(e);
        });
        btn.addEventListener("pointerup", endHold);
        btn.addEventListener("pointercancel", endHold);
        btn.addEventListener("lostpointercapture", () => {
            if (this._pttRecording) void this._onPttPointerUp({ type: "lostpointercapture" });
        });
    }

    /**
     * Sparse ChatGPT-style transcript + composer for the talking-head dashboard.
     * @param {HTMLElement} container
     */
    buildDashboardChat(container) {
        if (!container) return;
        if (this._dashboardChatEl && this._dashboardChatEl.parentNode) {
            this._dashboardChatEl.parentNode.removeChild(this._dashboardChatEl);
        }

        const root = document.createElement("div");
        root.className = "robot-dashboard-chat";

        const historyEl = document.createElement("div");
        historyEl.className = "robot-dashboard-chat-log agent-history-log";
        historyEl.setAttribute("role", "log");
        historyEl.setAttribute("aria-live", "polite");

        const composer = document.createElement("div");
        composer.className = "robot-dashboard-chat-composer";

        const promptInput = document.createElement("input");
        promptInput.type = "text";
        promptInput.className = "robot-dashboard-chat-input";
        promptInput.autocomplete = "off";
        promptInput.enterKeyHint = "send";
        promptInput.setAttribute("aria-label", "Message");
        promptInput.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            void this._onSend();
        });

        const micBtn = document.createElement("button");
        micBtn.type = "button";
        micBtn.className = "robot-dashboard-chat-mic";
        micBtn.setAttribute("aria-label", "Hold to talk");
        micBtn.appendChild(this._createPttMicIcon());
        this._bindDashboardMicPointers(micBtn);

        composer.appendChild(promptInput);
        composer.appendChild(micBtn);
        root.appendChild(historyEl);
        root.appendChild(composer);
        container.appendChild(root);

        this._dashboardChatEl = root;
        this._dashboardHistoryEl = historyEl;
        this._dashboardPromptInput = promptInput;
        this._dashboardMicBtn = micBtn;
        this._updateDashboardPromptPlaceholder();
        this._renderHistory();
        this._syncDashboardMicState(this._pttState || "idle");
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
        this._syncChatModelUi();
        this._renderTelnyxOptions();
        this._syncTelnyxUi();
        if (this._isTelnyxProvider()) void this._loadTelnyxLists();
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
        keyInput.placeholder = "gsk_… (blank = hosted arcade key)";
        // Password managers ignore autocomplete="off"; "new-password" stops them refilling a cleared key.
        keyInput.autocomplete = "new-password";
        keyInput.name = `phonebot-agent-key-${Math.random().toString(36).slice(2)}`;
        keyInput.addEventListener("input", () => {
            this._apiKey = String(keyInput.value || "").trim();
            const agent = this.getSelectedAgent();
            if (agent) this._persistKeyForAgent(agent.name, this._apiKey);
            // Re-resolve when switching BYOK key ↔ hosted for this mode session.
            this._sessionModels = null;
            this._sessionModelsPromise = null;
            this._syncAiBudgetUi();
            this._syncChatModelUi();
            if (this._apiKey) void this.ensureSessionGroqModels();
            this._schedulePendingResumeForKey();
            clearTimeout(this._telnyxListsTimer);
            this._syncTelnyxUi();
            if (this._isTelnyxProvider()) {
                this._telnyxListsTimer = setTimeout(() => void this._loadTelnyxLists(), 600);
            }
        });

        const clearKeyBtn = document.createElement("button");
        clearKeyBtn.type = "button";
        clearKeyBtn.className = "agent-key-clear-btn";
        clearKeyBtn.textContent = "Clear key (use hosted arcade key)";
        clearKeyBtn.addEventListener("click", () => {
            keyInput.value = "";
            this._apiKey = "";
            if (this._isTelnyxProvider()) this._telnyxSessionKey = "";
            const agent = this.getSelectedAgent();
            if (agent) this._persistKeyForAgent(agent.name, "");
            this._sessionModels = null;
            this._sessionModelsPromise = null;
            this._syncVoiceUiForSelectedAgent();
            this._syncAiBudgetUi();
            this._syncChatModelUi();
            this._syncTelnyxUi();
            void this.ensureSessionGroqModels();
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

        const chatModelRow = document.createElement("div");
        const chatModelLabel = document.createElement("label");
        chatModelLabel.textContent = "Chat model";
        chatModelLabel.htmlFor = "robotAgentChatModel";
        const chatModelSelect = document.createElement("select");
        chatModelSelect.id = "robotAgentChatModel";
        chatModelSelect.style.width = "100%";
        chatModelSelect.addEventListener("change", () => this._setChatModelChoice(chatModelSelect.value));
        const chatModelRefreshBtn = document.createElement("button");
        chatModelRefreshBtn.type = "button";
        chatModelRefreshBtn.textContent = "Refresh models";
        chatModelRefreshBtn.addEventListener("click", () => {
            this._sessionModels = null;
            this._sessionModelsPromise = null;
            void this.ensureSessionGroqModels();
        });
        const chatModelHint = document.createElement("p");
        chatModelHint.className = "muted";
        chatModelHint.style.margin = "4px 0 0";
        chatModelRow.appendChild(chatModelLabel);
        chatModelRow.appendChild(chatModelSelect);
        chatModelRow.appendChild(chatModelRefreshBtn);
        chatModelRow.appendChild(chatModelHint);

        const telnyxRow = document.createElement("div");
        telnyxRow.hidden = true;
        const telnyxSelect = (id, text, kind) => {
            const label = document.createElement("label");
            label.textContent = text;
            label.htmlFor = id;
            const select = document.createElement("select");
            select.id = id;
            select.style.width = "100%";
            select.addEventListener("change", () => this._setTelnyxChoice(kind, select.value));
            telnyxRow.appendChild(label);
            telnyxRow.appendChild(select);
            return select;
        };
        const telnyxSttSelect = telnyxSelect("robotAgentTelnyxStt", "Speech-to-text (streaming)", "stt");
        const telnyxChatSelect = telnyxSelect("robotAgentTelnyxChat", "Chat model", "chat");
        const telnyxVoiceSelect = telnyxSelect("robotAgentTelnyxVoice", "Voice (streaming)", "voice");
        const telnyxRefreshBtn = document.createElement("button");
        telnyxRefreshBtn.type = "button";
        telnyxRefreshBtn.textContent = "Refresh Telnyx lists";
        telnyxRefreshBtn.addEventListener("click", () => void this._loadTelnyxLists({ force: true }));
        const telnyxHint = document.createElement("p");
        telnyxHint.className = "muted";
        telnyxHint.style.margin = "4px 0 0";
        telnyxRow.appendChild(telnyxRefreshBtn);
        telnyxRow.appendChild(telnyxHint);

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
        voiceSelectLabel.textContent = "Voice (Web TTS or Groq Orpheus)";
        const voiceSelect = document.createElement("select");
        voiceSelect.id = "robotAgentTtsVoice";
        voiceSelect.addEventListener("change", () => this._onTtsVoiceChange());

        const voiceStatus = document.createElement("p");
        voiceStatus.className = "muted";
        voiceStatus.style.margin = "4px 0 0";
        voiceStatus.textContent =
            "Web TTS is free. Groq Orpheus TTS uses API credits (200 chars per chunk).";

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
        controls.appendChild(chatModelRow);
        controls.appendChild(telnyxRow);
        controls.appendChild(aiBudget);
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
        this._chatModelRow = chatModelRow;
        this._chatModelSelect = chatModelSelect;
        this._chatModelRefreshBtn = chatModelRefreshBtn;
        this._chatModelHintEl = chatModelHint;
        this._renderChatModelOptions();
        this._telnyxRow = telnyxRow;
        this._telnyxSttSelect = telnyxSttSelect;
        this._telnyxChatSelect = telnyxChatSelect;
        this._telnyxVoiceSelect = telnyxVoiceSelect;
        this._telnyxRefreshBtn = telnyxRefreshBtn;
        this._telnyxHintEl = telnyxHint;
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
        requestAnimationFrame(() => {
            this._syncKeyFromSelection();
            if (this._clientApiKey() && !this._isGeminiProvider() && !this._isTelnyxProvider()) {
                void this.ensureSessionGroqModels();
            }
        });
        this._syncVoiceUiForSelectedAgent();
        this._syncAiBudgetUi();
        this._syncSendButtonState();
        void this._hydrateDefaultPromptFromIntroductionTemplate();
    }

    destroy() {
        this._stopSpeaking();
        window.removeEventListener("phonebot:ai-budget", this._aiBudgetListener);
        if (window.playBilling?._passwordHandler === this._passwordHandler) {
            window.playBilling.setPasswordHandler(null);
        }
        clearTimeout(this._pendingKeyTimer);
        clearTimeout(this._telnyxListsTimer);
        this._telnyxListsToken += 1;
        this._pendingSend = null;
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
        this._chatModelRow = null;
        this._chatModelSelect = null;
        this._chatModelRefreshBtn = null;
        this._chatModelHintEl = null;
        this._telnyxRow = null;
        this._telnyxSttSelect = null;
        this._telnyxChatSelect = null;
        this._telnyxVoiceSelect = null;
        this._telnyxRefreshBtn = null;
        this._telnyxHintEl = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendCameraImageInput = null;
        this._sendBtn = null;
        this._agentPowerBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this._dashboardChatEl = null;
        this._dashboardHistoryEl = null;
        this._dashboardPromptInput = null;
        this._dashboardMicBtn = null;
        this._aiBudgetEl = null;
        this.messageHistory = [];
    }
}

window.AgentInterface = AgentInterface;
