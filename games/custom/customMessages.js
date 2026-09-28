/**
 * Custom Messages — author audio / text / prompt clips with triggers and loops.
 * Free local talking-head game: tiles under the Game menu; editor dialog for create/edit.
 * Named "games" store separate action collections; Custom Games mode picks which to load.
 */
class CustomMessagesGame {
    static STORAGE_KEY = "phonebot.customMessages.v2";
    static STORAGE_KEY_V1 = "phonebot.customMessages.v1";
    /** Portable single-game backup (download / upload). */
    static EXPORT_FORMAT = "phonebot.game.v1";
    /** Older backup formats still accepted on upload. */
    static LEGACY_EXPORT_FORMATS = Object.freeze(["phonebot.character.v1"]);
    /** Fired on window whenever the game store is saved. */
    static GAME_CHANGE_EVENT = "phonebot:gamechange";
    static FACE_POLL_MS = 200;
    static SPEECH_POLL_MS = 150;
    static REPEAT_GAP_MS = 1200;
    static FACE_STABLE_MS = 400;
    /** @type {string|null} Set by requestEditGame; consumed by the next start(). */
    static _pendingEditGameId = null;
    /** Debug: confirm popup before each triggered action runs, plus speech-edge console logs. */
    static DEBUG_CONFIRM_TRIGGERS = false;

    static TRIGGERS = Object.freeze([
        { id: "gameLoad", label: "Game load" },
        { id: "faceDetected", label: "Face detected" },
        { id: "noFaceDetected", label: "No face detected" },
        { id: "speechFinished", label: "Speech finished" },
        { id: "playNext", label: "Play next" }
    ]);

    static LOOPS = Object.freeze([
        { id: "once", label: "Play once" },
        { id: "repeat", label: "Repeat" }
    ]);

    /** Prompt reply word limit; 0 = no limit (nothing appended). Default matches Talking Heads chat. */
    static PROMPT_MAX_WORDS = Object.freeze([0, 10, 20, 30, 50, 75, 100, 150, 200]);
    static DEFAULT_PROMPT_MAX_WORDS = 50;

    /** Default matches the Talking Heads agent config. */
    static REASONING_EFFORTS = Object.freeze([
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" }
    ]);
    static DEFAULT_REASONING_EFFORT = "low";

    /** Optional gates — all must hold in addition to the trigger firing. */
    static FACE_CONSTRAINTS = Object.freeze([
        { id: "any", label: "Any" },
        { id: "present", label: "Face present" },
        { id: "absent", label: "Face absent" }
    ]);

    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        /** @type {CustomMessage[]} */
        this.messages = [];
        /** @type {string|null} */
        this._activeGameId = null;
        /** @type {string} */
        this._activeGameName = "";
        /** Editing from Custom Games → Edit/New: no triggers run and the game is not selected. */
        this._editOnly = false;
        this._running = false;
        this._generation = 0;
        this._audioBusy = false;
        this._faceTimer = null;
        this._faceTickBusy = false;
        this._lastFacePresent = null;
        this._faceSince = 0;
        this._speechTimer = null;
        this._speechTickBusy = false;
        this._lastSpeechSpeaking = null;
        this._speechFinishedPending = false;
        /** Bump on each silence→speak / speak→silence edge so in-flight plays can detect nested speech. */
        this._speechStartEpoch = 0;
        this._speechFinishEpoch = 0;
        this._firedOnceIds = new Set();
        this._playNextQueue = [];
        this._tileListEl = null;
        this._actionsOverlay = null;
        this._overlay = null;
        this._draft = null;
        this._recording = false;
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._recordStreamOwned = false;
        this._editorDelayInput = null;
        this._editorFaceConstraint = null;
        /** @type {HTMLAudioElement|null} Editor preview of the draft audio clip. */
        this._previewAudio = null;
        this._previewUrl = null;
        this._previewBtn = null;
        this._actionsNameInput = null;
        this._debugConfirmOverlay = null;
        /** @type {((ok: boolean) => void)|null} */
        this._debugConfirmResolve = null;
    }

    start() {
        this.stop();
        this._running = true;
        this._generation += 1;
        this._firedOnceIds = new Set();
        this._playNextQueue = [];
        this._lastFacePresent = null;
        this._faceSince = 0;
        this._lastSpeechSpeaking = null;
        this._speechFinishedPending = false;
        this._speechStartEpoch = 0;
        this._speechFinishEpoch = 0;
        const editGameId = CustomMessagesGame._pendingEditGameId;
        CustomMessagesGame._pendingEditGameId = null;
        this._editOnly = !!editGameId;
        const active = editGameId
            ? CustomMessagesGame.loadGameWorkspace(editGameId)
            : CustomMessagesGame.loadActiveWorkspace();
        if (!active.gameId) {
            // Actions only exist inside a saved game — send the player to the picker.
            this._running = false;
            const robot = this.robot;
            setTimeout(() => {
                if (robot?.mode === "custom" && typeof robot.setMode === "function") {
                    void robot.setMode("customGames");
                }
            }, 0);
            return;
        }
        this.messages = active.messages;
        this._activeGameId = active.gameId;
        this._activeGameName = active.gameName;
        if (this._editOnly) {
            this._running = false;
            this.openActionsList();
            return;
        }
        this._showChatHistory();
        this._armHoldToTalk();
        if (!this.messages.length) {
            this.openActionsList();
        }
        void this._runGameLoad(this._generation);
        this._startFacePoll(this._generation);
        this._startSpeechPoll(this._generation);
    }

    /**
     * @returns {{ id: string, name: string }[]}
     */
    static listGames() {
        const store = CustomMessagesGame._loadStore();
        return (store.games || [])
            .map((c) => ({
                id: String(c.id || ""),
                name: String(c.name || "").trim() || "Untitled"
            }))
            .filter((c) => c.id);
    }

    /**
     * Active saved game. `gameId` is null (and `messages` empty) when no game is chosen.
     * @returns {{ gameId: string|null, gameName: string, messages: CustomMessage[] }}
     */
    static loadActiveWorkspace() {
        const store = CustomMessagesGame._loadStore();
        return CustomMessagesGame.loadGameWorkspace(store.activeGameId);
    }

    /**
     * A saved game by id. `gameId` is null (and `messages` empty) when it does not exist.
     * @param {string|null} gameId
     * @returns {{ gameId: string|null, gameName: string, messages: CustomMessage[] }}
     */
    static loadGameWorkspace(gameId) {
        const store = CustomMessagesGame._loadStore();
        const want = gameId ? String(gameId) : null;
        if (want) {
            const game = (store.games || []).find((c) => c && c.id === want);
            if (game) {
                return {
                    gameId: game.id,
                    gameName: String(game.name || "").trim() || "Untitled",
                    messages: CustomMessagesGame._deserializeMessageList(game.messages)
                };
            }
        }
        return {
            gameId: null,
            gameName: "",
            messages: []
        };
    }

    /** Name of the active saved game, or "" when none is chosen. */
    static activeGameName() {
        const store = CustomMessagesGame._loadStore();
        const activeId = store.activeGameId ? String(store.activeGameId) : null;
        if (!activeId) return "";
        const game = (store.games || []).find((c) => c && c.id === activeId);
        return game ? String(game.name || "").trim() || "Untitled" : "";
    }

    /**
     * Update the name of a saved game.
     * @param {string} gameId
     * @param {{ name?: string }} patch
     * @returns {boolean}
     */
    static updateGameMeta(gameId, patch = {}) {
        const want = String(gameId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const game = (store.games || []).find((c) => c && c.id === want);
        if (!game) return false;
        if (patch.name != null) {
            const label = String(patch.name || "").trim();
            if (label) game.name = label;
        }
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /**
     * Make a saved game the active workspace.
     * @param {string} gameId
     * @returns {boolean}
     */
    static activateGame(gameId) {
        const want = String(gameId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const game = (store.games || []).find((c) => c && c.id === want);
        if (!game) return false;
        store.activeGameId = want;
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /**
     * Remove a saved game. Does not delete other games.
     * @param {string} gameId
     * @returns {boolean}
     */
    static deleteGame(gameId) {
        const want = String(gameId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const before = Array.isArray(store.games) ? store.games.length : 0;
        store.games = (store.games || []).filter((c) => c && c.id !== want);
        if (store.games.length === before) return false;
        if (store.activeGameId === want) {
            store.activeGameId = null;
        }
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /**
     * Next CustomMessagesGame start opens this game's editor only — the game is not made
     * active and no triggers run.
     * @param {string} gameId
     */
    static requestEditGame(gameId) {
        CustomMessagesGame._pendingEditGameId = String(gameId || "").trim() || null;
    }

    /**
     * Copy messages into a new named game. Does not make it the active game.
     * @param {string} name
     * @param {CustomMessage[]} [messages]
     * @returns {{ id: string, name: string }|null}
     */
    static saveAsNewGame(name, messages = []) {
        const label = String(name || "").trim();
        if (!label) return null;
        const store = CustomMessagesGame._loadStore();
        const serialized = (messages || []).map((m) => CustomMessagesGame._serializeMessage(m));
        const game = {
            id: CustomMessagesGame._newGameId(),
            name: label,
            messages: serialized
        };
        if (!Array.isArray(store.games)) store.games = [];
        store.games.push(game);
        CustomMessagesGame._saveStore(store);
        return { id: game.id, name: game.name };
    }

    /** Create an empty named game (not made active). */
    static createNamedGame(name) {
        return CustomMessagesGame.saveAsNewGame(name, []);
    }

    /**
     * Build a portable JSON payload for one game (includes audio as base64).
     * @param {{ name?: string, messages?: CustomMessage[] }} source
     * @returns {Promise<object>}
     */
    static async buildGameExport(source = {}) {
        const messages = Array.isArray(source.messages) ? source.messages : [];
        for (const msg of messages) {
            if (msg?.audioBlob && !msg._audioBase64) {
                try {
                    msg._audioBase64 = await CustomMessagesGame._blobToBase64(msg.audioBlob);
                    msg._audioMime = msg.audioBlob.type || "audio/webm";
                } catch (_) {
                    /* keep message without audio */
                }
            }
        }
        const name = String(source.name || "").trim() || "Untitled";
        return {
            format: CustomMessagesGame.EXPORT_FORMAT,
            exportedAt: new Date().toISOString(),
            name,
            messages: messages.map((m) => CustomMessagesGame._serializeMessage(m))
        };
    }

    /**
     * Import a game backup file into the local store (new id; does not replace others).
     * @param {object} payload
     * @returns {{ id: string, name: string }|null}
     */
    static importGameFromExport(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const format = String(payload.format || "").trim();
        if (
            format &&
            format !== CustomMessagesGame.EXPORT_FORMAT &&
            !CustomMessagesGame.LEGACY_EXPORT_FORMATS.includes(format)
        ) {
            return null;
        }
        const name = String(payload.name || "").trim() || "Untitled";
        const messages = CustomMessagesGame._deserializeMessageList(payload.messages);
        const store = CustomMessagesGame._loadStore();
        const game = {
            id: CustomMessagesGame._newGameId(),
            name,
            messages: messages.map((m) => CustomMessagesGame._serializeMessage(m))
        };
        if (!Array.isArray(store.games)) store.games = [];
        store.games.push(game);
        CustomMessagesGame._saveStore(store);
        return { id: game.id, name: game.name };
    }

    /**
     * Trigger a browser download of a JSON blob.
     * @param {string} filename
     * @param {object} data
     */
    static downloadJsonFile(filename, data) {
        const safeName =
            String(filename || "game")
                .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
                .replace(/\s+/g, "-")
                .slice(0, 64) || "game";
        const blob = new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.phonebot-game.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    /** Show the camera-frame hold-to-talk mic while Custom is active. */
    _armHoldToTalk() {
        const agent = this._getAgent();
        if (agent && typeof agent._armConversationPtt === "function") {
            agent._armConversationPtt();
        }
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._audioBusy = false;
        this._stopFacePoll();
        this._stopSpeechPoll();
        this._speechFinishedPending = false;
        this._speechStartEpoch = 0;
        this._speechFinishEpoch = 0;
        this._lastSpeechSpeaking = null;
        this._cancelSpeech();
        this._stopRecording(true);
        this._closeEditor();
        this._closeActionsList();
        this._closeDebugConfirm(false);
        this._hideChatHistoryEmphasis();
        const agent = this._getAgent();
        if (agent && typeof agent._stopSpeaking === "function") {
            agent._stopSpeaking();
        }
    }

    /** Keep the talking-head chat transcript visible while Custom is active. */
    _showChatHistory() {
        const root =
            this.robot?.dashboardContainer?.querySelector?.(".robot-dashboard--talking-head") ||
            document.querySelector(".robot-dashboard--talking-head");
        if (root) root.classList.add("robot-dashboard--custom-messages");
        const agent = this._getAgent();
        if (agent && typeof agent._renderHistory === "function") {
            agent._renderHistory();
        }
        const chatHost = root?.querySelector?.(".robot-dashboard-chat-host");
        if (chatHost) {
            chatHost.hidden = false;
            chatHost.removeAttribute("hidden");
            chatHost.style.display = "";
        }
        const historyEl =
            agent?._dashboardHistoryEl ||
            root?.querySelector?.(".robot-dashboard-chat-log");
        if (historyEl) {
            historyEl.scrollTop = historyEl.scrollHeight;
        }
    }

    _hideChatHistoryEmphasis() {
        const root =
            this.robot?.dashboardContainer?.querySelector?.(".robot-dashboard--talking-head") ||
            document.querySelector(".robot-dashboard--talking-head");
        if (root) root.classList.remove("robot-dashboard--custom-messages");
    }

    /**
     * @param {CustomMessage|null} existing
     */
    openEditor(existing = null) {
        this._closeEditor();
        this._draft = existing
            ? {
                  id: existing.id,
                  kind: existing.kind,
                  trigger: existing.trigger,
                  loop: existing.loop,
                  delaySec: CustomMessagesGame._normalizeDelaySec(existing.delaySec),
                  constraints: CustomMessagesGame._normalizeConstraints(existing.constraints),
                  text: existing.text || "",
                  fileName: existing.fileName || "",
                  sendCamera: !!existing.sendCamera,
                  clearHistory: existing.clearHistory !== false,
                  maxWords: CustomMessagesGame._normalizeMaxWords(existing.maxWords),
                  reasoningEffort: CustomMessagesGame._normalizeReasoningEffort(
                      existing.reasoningEffort
                  ),
                  audioBlob: existing.audioBlob || null
              }
            : {
                  id: null,
                  kind: null,
                  trigger: "gameLoad",
                  loop: "once",
                  delaySec: 0,
                  constraints: CustomMessagesGame._normalizeConstraints(null),
                  text: "",
                  fileName: "",
                  sendCamera: false,
                  clearHistory: true,
                  maxWords: CustomMessagesGame.DEFAULT_PROMPT_MAX_WORDS,
                  reasoningEffort: CustomMessagesGame.DEFAULT_REASONING_EFFORT,
                  audioBlob: null
              };
        this._mountEditor();
    }

    _isActive(generation) {
        return this._running && generation === this._generation;
    }

    _getAgent() {
        return this.robot?.agentInterface || null;
    }

    _getAudioPlayer() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("audioPlayer");
    }

    _getMicrophone() {
        const sensors = Array.isArray(this.robot?.sensors) ? this.robot.sensors : [];
        return (
            sensors.find((s) => String(s?.type || "").toLowerCase() === "microphone") || null
        );
    }

    _getComputerVision() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("computervision");
    }

    _cancelSpeech() {
        const player = this._getAudioPlayer();
        if (player && typeof player.stop === "function") {
            player.stop();
        }
        try {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        } catch (_) {}
        window.__phonebotTtsSpeaking = false;
    }

    _sleep(ms, generation) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(this._isActive(generation)), Math.max(0, ms));
        });
    }

    // —— Persistence ——————————————————————————————————————————————

    static _emptyStore() {
        return {
            version: 2,
            activeGameId: null,
            games: []
        };
    }

    /**
     * Older stores kept unsaved actions in `scratch` (or a bare v1 array). Actions must belong
     * to a game, so those become an "Untitled" game.
     * @param {object} store
     * @param {unknown[]} scratch
     */
    static _migrateScratchToGame(store, scratch) {
        const game = {
            id: CustomMessagesGame._newGameId(),
            name: "Untitled",
            messages: scratch
        };
        store.games.push(game);
        if (!store.activeGameId) store.activeGameId = game.id;
        CustomMessagesGame._saveStore(store);
        return store;
    }

    static _loadStore() {
        try {
            const rawV2 = localStorage.getItem(CustomMessagesGame.STORAGE_KEY);
            if (rawV2) {
                const parsed = JSON.parse(rawV2);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    // Stores saved before the rename use `characters` / `activeCharacterId`.
                    const activeGameId = parsed.activeGameId ?? parsed.activeCharacterId;
                    const games = Array.isArray(parsed.games) ? parsed.games : parsed.characters;
                    const store = {
                        version: 2,
                        activeGameId: activeGameId ? String(activeGameId) : null,
                        games: Array.isArray(games)
                            ? games
                                  .filter((c) => c && typeof c === "object")
                                  .map((c) => ({
                                      id: String(c.id || CustomMessagesGame._newGameId()),
                                      name: String(c.name || "").trim() || "Untitled",
                                      messages: Array.isArray(c.messages) ? c.messages : []
                                  }))
                            : []
                    };
                    if (Array.isArray(parsed.scratch) && parsed.scratch.length) {
                        return CustomMessagesGame._migrateScratchToGame(store, parsed.scratch);
                    }
                    return store;
                }
            }
            const rawV1 = localStorage.getItem(CustomMessagesGame.STORAGE_KEY_V1);
            if (rawV1) {
                const parsed = JSON.parse(rawV1);
                if (Array.isArray(parsed) && parsed.length) {
                    return CustomMessagesGame._migrateScratchToGame(
                        CustomMessagesGame._emptyStore(),
                        parsed
                    );
                }
            }
        } catch (err) {
            console.warn("Custom messages store load failed:", err);
        }
        return CustomMessagesGame._emptyStore();
    }

    static _saveStore(store) {
        try {
            const payload = {
                version: 2,
                activeGameId: store?.activeGameId || null,
                games: Array.isArray(store?.games) ? store.games : []
            };
            localStorage.setItem(CustomMessagesGame.STORAGE_KEY, JSON.stringify(payload));
        } catch (err) {
            console.warn("Custom messages store save failed:", err);
        }
        window.dispatchEvent(new CustomEvent(CustomMessagesGame.GAME_CHANGE_EVENT));
    }

    /** @deprecated Use loadActiveWorkspace — kept for older call sites. */
    static _loadMessages() {
        return CustomMessagesGame.loadActiveWorkspace().messages;
    }

    /**
     * @param {CustomMessage[]} messages
     * @param {string|null} [gameId] defaults to the active game
     */
    static _saveMessages(messages, gameId = null) {
        const store = CustomMessagesGame._loadStore();
        const serialized = (messages || []).map((m) => CustomMessagesGame._serializeMessage(m));
        const want = gameId || store.activeGameId;
        const game = want ? (store.games || []).find((c) => c && c.id === String(want)) : null;
        if (!game) {
            console.warn("Custom messages not saved: game not found.");
            return;
        }
        game.messages = serialized;
        CustomMessagesGame._saveStore(store);
    }

    static _deserializeMessageList(list) {
        if (!Array.isArray(list)) return [];
        return list.map((entry) => CustomMessagesGame._deserializeMessage(entry)).filter(Boolean);
    }

    static _serializeMessage(msg) {
        const constraints = CustomMessagesGame._normalizeConstraints(msg.constraints);
        const out = {
            id: msg.id,
            kind: msg.kind,
            trigger: msg.trigger,
            loop: msg.loop,
            delaySec: CustomMessagesGame._normalizeDelaySec(msg.delaySec),
            constraints,
            text: msg.text || "",
            fileName: msg.fileName || "",
            sendCamera: msg.kind === "prompt" && !!msg.sendCamera,
            clearHistory: msg.kind === "prompt" && msg.clearHistory !== false,
            audioBase64: null,
            audioMime: ""
        };
        if (msg.kind === "prompt") {
            out.maxWords = CustomMessagesGame._normalizeMaxWords(msg.maxWords);
            out.reasoningEffort = CustomMessagesGame._normalizeReasoningEffort(msg.reasoningEffort);
        }
        if (msg.audioBlob && typeof msg.audioBlob.size === "number" && msg.audioBlob.size > 0) {
            // Stored async via _persistAll; placeholder filled when available on the message.
            out.audioBase64 = msg._audioBase64 || null;
            out.audioMime = msg.audioBlob.type || msg._audioMime || "audio/webm";
        }
        return out;
    }

    static _deserializeMessage(entry) {
        if (!entry || typeof entry !== "object") return null;
        const kind = String(entry.kind || "").trim();
        if (kind !== "audio" && kind !== "text" && kind !== "prompt") return null;
        // Unknown or retired triggers (e.g. the old "selected") fall back to gameLoad.
        const trigger = String(entry.trigger || "gameLoad").trim();
        const loop = String(entry.loop || "once").trim() === "repeat" ? "repeat" : "once";
        /** @type {CustomMessage} */
        const msg = {
            id: String(entry.id || CustomMessagesGame._newId()),
            kind,
            trigger: CustomMessagesGame.TRIGGERS.some((t) => t.id === trigger)
                ? trigger
                : "gameLoad",
            loop,
            delaySec: CustomMessagesGame._normalizeDelaySec(entry.delaySec),
            constraints: CustomMessagesGame._normalizeConstraints(entry.constraints),
            text: String(entry.text || ""),
            fileName: String(entry.fileName || ""),
            sendCamera: kind === "prompt" && !!entry.sendCamera,
            clearHistory: kind === "prompt" && entry.clearHistory !== false,
            maxWords: CustomMessagesGame._normalizeMaxWords(entry.maxWords),
            reasoningEffort: CustomMessagesGame._normalizeReasoningEffort(entry.reasoningEffort),
            audioBlob: null,
            _audioBase64: entry.audioBase64 || null,
            _audioMime: entry.audioMime || ""
        };
        if (msg._audioBase64) {
            try {
                msg.audioBlob = CustomMessagesGame._base64ToBlob(
                    msg._audioBase64,
                    msg._audioMime || "audio/webm"
                );
            } catch (_) {
                msg.audioBlob = null;
            }
        }
        return msg;
    }

    /** @param {unknown} value @returns {number} */
    static _normalizeDelaySec(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.min(n, 86400);
    }

    /**
     * Missing values (older saves) take the default; 0 means no limit.
     * @param {unknown} value
     * @returns {number}
     */
    static _normalizeMaxWords(value) {
        if (value == null || value === "") return CustomMessagesGame.DEFAULT_PROMPT_MAX_WORDS;
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 0) return CustomMessagesGame.DEFAULT_PROMPT_MAX_WORDS;
        return Math.min(n, 1000);
    }

    /**
     * @param {unknown} value
     * @returns {"low"|"medium"|"high"}
     */
    static _normalizeReasoningEffort(value) {
        const raw = String(value || "").trim().toLowerCase();
        return CustomMessagesGame.REASONING_EFFORTS.some((r) => r.id === raw)
            ? raw
            : CustomMessagesGame.DEFAULT_REASONING_EFFORT;
    }

    /**
     * Prompt text sent to the agent, with the word limit appended at the end.
     * @param {string} text
     * @param {number} maxWords
     */
    static _composePromptText(text, maxWords) {
        const body = String(text || "").trim();
        const limit = CustomMessagesGame._normalizeMaxWords(maxWords);
        if (!limit) return body;
        const line = `Keep your replies under ${limit} words.`;
        return body ? `${body}\n\n${line}` : line;
    }

    /**
     * @param {unknown} value
     * @returns {{ face: "any"|"present"|"absent" }}
     */
    static _normalizeConstraints(value) {
        const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const faceRaw = String(src.face || "any").trim().toLowerCase();
        const face =
            faceRaw === "present" || faceRaw === "absent" ? faceRaw : "any";
        return { face };
    }

    /** @param {{ face?: string }|null|undefined} constraints */
    static _constraintsSummary(constraints) {
        const c = CustomMessagesGame._normalizeConstraints(constraints);
        const parts = [];
        if (c.face === "present") parts.push("face present");
        if (c.face === "absent") parts.push("face absent");
        return parts.length ? parts.join(", ") : "";
    }

    static _newId() {
        return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    static _newGameId() {
        return `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    static _base64ToBlob(base64, mime) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || "application/octet-stream" });
    }

    static async _blobToBase64(blob) {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    async _persistAll() {
        for (const msg of this.messages) {
            if (msg.audioBlob && !msg._audioBase64) {
                try {
                    msg._audioBase64 = await CustomMessagesGame._blobToBase64(msg.audioBlob);
                    msg._audioMime = msg.audioBlob.type || "audio/webm";
                } catch (err) {
                    console.warn("Custom message audio encode failed:", err);
                }
            }
        }
        CustomMessagesGame._saveMessages(this.messages, this._activeGameId);
    }

    static tileLabel(msg) {
        if (!msg) return "Message";
        if (msg.kind === "audio") {
            const name = String(msg.fileName || "").trim();
            return name || "Recording";
        }
        const words = String(msg.text || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4);
        if (words.length) return words.join(" ");
        return msg.kind === "prompt" ? "Prompt" : "Text";
    }

    /**
     * @param {{ name?: string }} patch
     */
    _persistActiveGameMeta(patch = {}) {
        if (!this._activeGameId) return;
        if (patch.name != null) {
            const label = String(patch.name || "").trim();
            if (label) this._activeGameName = label;
            else return;
        }
        CustomMessagesGame.updateGameMeta(this._activeGameId, {
            name: this._activeGameName
        });
    }

    // —— Actions list popup ————————————————————————————————————————

    openActionsList() {
        this._closeActionsList();

        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-actions-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Game Editor");

        const card = document.createElement("div");
        card.className = "custom-messages-card custom-messages-actions-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "Game Editor";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent = "A game is a collection of actions and triggers.";
        card.appendChild(hint);

        const meta = document.createElement("div");
        meta.className = "custom-messages-game-meta";

        const nameLabel = document.createElement("label");
        nameLabel.className = "custom-messages-game-meta-label";
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "custom-messages-game-meta-name-input";
        nameInput.placeholder = "Game name";
        nameInput.autocomplete = "off";
        nameInput.maxLength = 48;
        nameInput.value = this._activeGameName || "";
        nameInput.disabled = !this._activeGameId;
        nameInput.addEventListener("change", () => {
            this._persistActiveGameMeta({ name: nameInput.value });
        });
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                nameInput.blur();
            }
        });
        nameLabel.appendChild(nameInput);

        meta.appendChild(nameLabel);
        card.appendChild(meta);

        const list = document.createElement("div");
        list.className = "custom-messages-tiles";
        list.setAttribute("role", "list");
        card.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "custom-messages-add";
        addBtn.textContent = "+ Add";
        addBtn.addEventListener("click", () => this.openEditor(null));

        const downloadBtn = document.createElement("button");
        downloadBtn.type = "button";
        downloadBtn.className = "custom-messages-download secondary";
        downloadBtn.textContent = "Download";
        downloadBtn.title = "Save a backup file you can upload later";
        downloadBtn.addEventListener("click", () => void this._downloadGameBackup());

        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "custom-messages-cancel secondary";
        doneBtn.textContent = "Done";
        doneBtn.addEventListener("click", () => this._finishActionsList());

        actions.appendChild(addBtn);
        actions.appendChild(downloadBtn);
        actions.appendChild(doneBtn);
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._finishActionsList();
        });
        document.body.appendChild(overlay);

        this._actionsOverlay = overlay;
        this._tileListEl = list;
        this._actionsNameInput = nameInput;
        this._renderTiles();
    }

    /** Done / backdrop: edit-only sessions return to the Custom Games picker. */
    _finishActionsList() {
        this._closeActionsList();
        if (this._editOnly && typeof this.robot?.setMode === "function") {
            void this.robot.setMode("customGames");
        }
    }

    _closeActionsList() {
        if (this._actionsOverlay?.parentElement) {
            this._actionsOverlay.parentElement.removeChild(this._actionsOverlay);
        }
        this._actionsOverlay = null;
        this._tileListEl = null;
        this._actionsNameInput = null;
    }

    /** Download the active game as a restoreable JSON file. */
    async _downloadGameBackup() {
        const nameFromInput = String(this._actionsNameInput?.value || "").trim();
        const name =
            nameFromInput ||
            this._activeGameName ||
            "Untitled";
        try {
            await this._persistAll();
            const payload = await CustomMessagesGame.buildGameExport({
                name,
                messages: this.messages
            });
            CustomMessagesGame.downloadJsonFile(name, payload);
        } catch (err) {
            console.warn("Game download failed:", err);
            if (typeof window.alert === "function") {
                window.alert("Could not download game backup.");
            }
        }
    }

    _renderTiles() {
        const list = this._tileListEl;
        if (!list) return;
        list.innerHTML = "";
        if (!this.messages.length) {
            const empty = document.createElement("p");
            empty.className = "custom-messages-hint muted";
            empty.textContent = "No actions yet. Tap + Add to create one.";
            list.appendChild(empty);
            return;
        }
        for (const msg of this.messages) {
            const tile = document.createElement("div");
            tile.className = "custom-messages-tile";
            tile.setAttribute("role", "listitem");
            tile.dataset.id = msg.id;

            const label = document.createElement("span");
            label.className = "custom-messages-tile-label";
            label.textContent = CustomMessagesGame.tileLabel(msg);
            const delaySec = CustomMessagesGame._normalizeDelaySec(msg.delaySec);
            const delayNote = delaySec > 0 ? ` · delay ${delaySec}s` : "";
            const cameraNote = msg.kind === "prompt" && msg.sendCamera ? " · camera" : "";
            const clearNote =
                msg.kind === "prompt" && msg.clearHistory !== false ? " · clear history" : "";
            let promptNote = "";
            if (msg.kind === "prompt") {
                const maxWords = CustomMessagesGame._normalizeMaxWords(msg.maxWords);
                const effort = CustomMessagesGame._normalizeReasoningEffort(msg.reasoningEffort);
                promptNote = `${maxWords ? ` · max ${maxWords} words` : ""} · ${effort} reasoning`;
            }
            const constraintNote = CustomMessagesGame._constraintsSummary(msg.constraints);
            const constraintSuffix = constraintNote ? ` · if ${constraintNote}` : "";
            label.title = `${msg.kind} · ${msg.trigger} · ${msg.loop}${delayNote}${cameraNote}${clearNote}${promptNote}${constraintSuffix}`;

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.setAttribute("aria-label", "Edit message");
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.openEditor(msg);
            });

            tile.appendChild(label);
            tile.appendChild(editBtn);
            list.appendChild(tile);
        }
    }

    // —— Editor dialog ————————————————————————————————————————————

    _closeEditor() {
        this._stopRecording(true);
        this._stopPreview();
        this._previewBtn = null;
        if (this._overlay?.parentElement) {
            this._overlay.parentElement.removeChild(this._overlay);
        }
        this._overlay = null;
        this._draft = null;
        this._editorBody = null;
        this._editorOptions = null;
        this._editorSubmit = null;
        this._editorTrigger = null;
        this._editorLoop = null;
        this._editorDelayInput = null;
        this._editorFaceConstraint = null;
        if (this._actionsOverlay) this._renderTiles();
    }

    _mountEditor() {
        const draft = this._draft;
        if (!draft) return;

        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-editor-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Custom message");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = draft.id ? "Edit message" : "Custom message";
        card.appendChild(title);

        const kindRow = document.createElement("div");
        kindRow.className = "custom-messages-kind-row";
        for (const { id, label } of [
            { id: "audio", label: "Audio" },
            { id: "text", label: "Txt" },
            { id: "prompt", label: "Prompt" }
        ]) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "custom-messages-kind-btn";
            btn.dataset.kind = id;
            btn.textContent = label;
            if (draft.kind === id) btn.classList.add("is-active");
            btn.addEventListener("click", () => {
                draft.kind = id;
                if (id === "audio") {
                    draft.text = "";
                } else {
                    draft.audioBlob = null;
                    if (!draft.fileName || /\.(webm|wav|mp3|ogg|m4a)$/i.test(draft.fileName)) {
                        draft.fileName = "";
                    }
                }
                if (id === "prompt" && draft.clearHistory === undefined) {
                    draft.clearHistory = true;
                }
                this._refreshEditorBody();
            });
            kindRow.appendChild(btn);
        }
        card.appendChild(kindRow);

        const body = document.createElement("div");
        body.className = "custom-messages-body";
        card.appendChild(body);

        const options = document.createElement("div");
        options.className = "custom-messages-options";
        options.hidden = true;

        const triggerLabel = document.createElement("label");
        triggerLabel.textContent = "Trigger";
        const triggerSelect = document.createElement("select");
        triggerSelect.className = "custom-messages-trigger";
        for (const t of CustomMessagesGame.TRIGGERS) {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            triggerSelect.appendChild(opt);
        }
        triggerSelect.value = draft.trigger;
        triggerSelect.addEventListener("change", () => {
            draft.trigger = triggerSelect.value;
        });
        triggerLabel.appendChild(triggerSelect);

        const loopLabel = document.createElement("label");
        loopLabel.textContent = "Loop";
        const loopSelect = document.createElement("select");
        loopSelect.className = "custom-messages-loop";
        for (const t of CustomMessagesGame.LOOPS) {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            loopSelect.appendChild(opt);
        }
        loopSelect.value = draft.loop;
        loopSelect.addEventListener("change", () => {
            draft.loop = loopSelect.value;
        });
        loopLabel.appendChild(loopSelect);

        const delayLabel = document.createElement("label");
        delayLabel.className = "custom-messages-delay-label";
        delayLabel.textContent = "Delay (seconds)";
        const delayInput = document.createElement("input");
        delayInput.type = "number";
        delayInput.className = "custom-messages-delay";
        delayInput.min = "0";
        delayInput.max = "86400";
        delayInput.step = "0.1";
        delayInput.inputMode = "decimal";
        delayInput.placeholder = "0";
        delayInput.value =
            draft.delaySec > 0 ? String(draft.delaySec) : "0";
        delayInput.addEventListener("input", () => {
            draft.delaySec = CustomMessagesGame._normalizeDelaySec(delayInput.value);
        });
        delayInput.addEventListener("change", () => {
            draft.delaySec = CustomMessagesGame._normalizeDelaySec(delayInput.value);
            delayInput.value = String(draft.delaySec);
        });
        delayLabel.appendChild(delayInput);

        const constraintsHeading = document.createElement("p");
        constraintsHeading.className = "custom-messages-constraints-heading";
        constraintsHeading.textContent = "Only fire if (optional)";

        const faceConstraintLabel = document.createElement("label");
        faceConstraintLabel.textContent = "Face";
        const faceConstraintSelect = document.createElement("select");
        faceConstraintSelect.className = "custom-messages-face-constraint";
        for (const t of CustomMessagesGame.FACE_CONSTRAINTS) {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            faceConstraintSelect.appendChild(opt);
        }
        faceConstraintSelect.value = draft.constraints?.face || "any";
        faceConstraintSelect.addEventListener("change", () => {
            draft.constraints = CustomMessagesGame._normalizeConstraints({
                ...draft.constraints,
                face: faceConstraintSelect.value
            });
        });
        faceConstraintLabel.appendChild(faceConstraintSelect);

        options.appendChild(triggerLabel);
        options.appendChild(loopLabel);
        options.appendChild(delayLabel);
        options.appendChild(constraintsHeading);
        options.appendChild(faceConstraintLabel);
        card.appendChild(options);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const submitBtn = document.createElement("button");
        submitBtn.type = "button";
        submitBtn.className = "custom-messages-submit";
        submitBtn.textContent = "Submit";
        submitBtn.disabled = true;
        submitBtn.addEventListener("click", () => {
            void this._submitDraft();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "custom-messages-cancel secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._closeEditor());

        actions.appendChild(submitBtn);
        actions.appendChild(cancelBtn);

        if (draft.id) {
            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "custom-messages-delete secondary";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => {
                void this._deleteMessage(draft.id);
            });
            actions.appendChild(deleteBtn);
        }

        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        this._overlay = overlay;
        this._editorBody = body;
        this._editorOptions = options;
        this._editorSubmit = submitBtn;
        this._editorTrigger = triggerSelect;
        this._editorLoop = loopSelect;
        this._editorDelayInput = delayInput;
        this._editorFaceConstraint = faceConstraintSelect;

        this._refreshEditorBody();
    }

    _hasDraftMedia() {
        const draft = this._draft;
        if (!draft || !draft.kind) return false;
        if (draft.kind === "audio") return !!(draft.audioBlob && draft.audioBlob.size > 0);
        if (draft.kind === "prompt") return true;
        return String(draft.text || "").trim().length > 0;
    }

    _hasDraftContent() {
        return this._hasDraftMedia();
    }

    _syncEditorOptionsVisibility() {
        const mediaReady = this._hasDraftMedia();
        if (this._editorOptions) this._editorOptions.hidden = !mediaReady;
        if (this._editorSubmit) this._editorSubmit.disabled = !this._hasDraftContent();
    }

    _refreshEditorBody() {
        const body = this._editorBody;
        const draft = this._draft;
        if (!body || !draft) return;
        this._stopPreview();
        this._previewBtn = null;
        body.innerHTML = "";

        const kindBtns = this._overlay?.querySelectorAll(".custom-messages-kind-btn") || [];
        for (const btn of kindBtns) {
            btn.classList.toggle("is-active", btn.dataset.kind === draft.kind);
        }

        if (!draft.kind) {
            const hint = document.createElement("p");
            hint.className = "custom-messages-hint muted";
            hint.textContent = "Choose Audio, Txt, or Prompt.";
            body.appendChild(hint);
            this._syncEditorOptionsVisibility();
            return;
        }

        if (draft.kind === "audio") {
            this._renderAudioEditor(body, draft);
        } else {
            this._renderTextEditor(body, draft);
        }
        this._syncEditorOptionsVisibility();
    }

    _renderAudioEditor(body, draft) {
        const status = document.createElement("p");
        status.className = "custom-messages-status muted";
        if (draft.audioBlob && draft.audioBlob.size) {
            status.textContent = `Ready: ${draft.fileName || "Recording"}`;
            status.className = "custom-messages-status ok";
        } else {
            status.textContent = "Record a clip or upload an audio file.";
        }

        const row = document.createElement("div");
        row.className = "custom-messages-media-row";

        const recordBtn = document.createElement("button");
        recordBtn.type = "button";
        recordBtn.className = "custom-messages-record";
        recordBtn.textContent = this._recording ? "Stop" : "Record";
        recordBtn.addEventListener("click", () => {
            void this._toggleRecord(recordBtn, status);
        });

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "custom-messages-play secondary";
        playBtn.addEventListener("click", () => this._togglePreview());
        this._previewBtn = playBtn;

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "custom-messages-upload secondary";
        uploadBtn.textContent = "Upload";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "audio/*,.wav,.mp3,.ogg,.m4a,.webm";
        fileInput.hidden = true;
        fileInput.addEventListener("change", () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) return;
            this._stopPreview();
            draft.audioBlob = file;
            draft.fileName = file.name || "upload.audio";
            draft._audioBase64 = null;
            status.textContent = `Ready: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
            this._syncPreviewButton();
            this._syncEditorOptionsVisibility();
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        row.appendChild(recordBtn);
        row.appendChild(playBtn);
        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(status);
        this._syncPreviewButton();
    }

    _syncPreviewButton() {
        const btn = this._previewBtn;
        if (!btn) return;
        const blob = this._draft?.audioBlob;
        btn.disabled = this._recording || !(blob && blob.size > 0);
        btn.textContent = this._previewAudio ? "Stop" : "Play";
        btn.setAttribute("aria-label", this._previewAudio ? "Stop audio" : "Play audio");
    }

    _togglePreview() {
        if (this._previewAudio) {
            this._stopPreview();
            return;
        }
        const blob = this._draft?.audioBlob;
        if (this._recording || !blob || !blob.size) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this._previewAudio = audio;
        this._previewUrl = url;
        const finish = () => {
            if (this._previewAudio === audio) this._stopPreview();
        };
        audio.addEventListener("ended", finish);
        audio.addEventListener("error", finish);
        audio.play().catch((err) => {
            console.warn("Custom audio preview failed:", err);
            finish();
        });
        this._syncPreviewButton();
    }

    _stopPreview() {
        const audio = this._previewAudio;
        this._previewAudio = null;
        if (audio) {
            try {
                audio.pause();
            } catch (_) {}
            audio.removeAttribute("src");
        }
        if (this._previewUrl) {
            URL.revokeObjectURL(this._previewUrl);
            this._previewUrl = null;
        }
        this._syncPreviewButton();
    }

    _renderTextEditor(body, draft) {
        const status = document.createElement("p");
        status.className = "custom-messages-status muted";
        if (draft.fileName && draft.text) {
            status.textContent = `Loaded: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
        } else if (draft.kind === "prompt") {
            status.textContent =
                "Type a prompt or leave empty. Sent to the agent (not TTS). Clears chat history by default.";
        } else {
            status.textContent = "Type text or upload a text file. Spoken with TTS.";
        }

        const input = document.createElement("textarea");
        input.className = "custom-messages-text";
        input.rows = 4;
        input.placeholder =
            draft.kind === "prompt"
                ? "Prompt text for the agent (optional)…"
                : "Text to speak (TTS)…";
        input.value = draft.text || "";
        input.addEventListener("input", () => {
            draft.text = input.value;
            draft.fileName = draft.fileName && /\.txt$/i.test(draft.fileName) ? draft.fileName : "";
            this._syncEditorOptionsVisibility();
        });
        body.appendChild(input);

        if (draft.kind === "prompt") {
            if (draft.clearHistory === undefined) draft.clearHistory = true;
            draft.maxWords = CustomMessagesGame._normalizeMaxWords(draft.maxWords);
            draft.reasoningEffort = CustomMessagesGame._normalizeReasoningEffort(
                draft.reasoningEffort
            );

            const settings = document.createElement("div");
            settings.className = "custom-messages-prompt-settings";

            const maxWordsLabel = document.createElement("label");
            maxWordsLabel.textContent = "Max words";
            const maxWordsSelect = document.createElement("select");
            maxWordsSelect.className = "custom-messages-max-words";
            const wordOptions = [...CustomMessagesGame.PROMPT_MAX_WORDS];
            if (!wordOptions.includes(draft.maxWords)) {
                wordOptions.push(draft.maxWords);
                wordOptions.sort((a, b) => a - b);
            }
            for (const n of wordOptions) {
                const opt = document.createElement("option");
                opt.value = String(n);
                opt.textContent = n ? String(n) : "No limit";
                maxWordsSelect.appendChild(opt);
            }
            maxWordsSelect.value = String(draft.maxWords);
            maxWordsSelect.addEventListener("change", () => {
                draft.maxWords = CustomMessagesGame._normalizeMaxWords(maxWordsSelect.value);
            });
            maxWordsLabel.appendChild(maxWordsSelect);

            const reasoningLabel = document.createElement("label");
            reasoningLabel.textContent = "Reasoning";
            const reasoningSelect = document.createElement("select");
            reasoningSelect.className = "custom-messages-reasoning";
            for (const r of CustomMessagesGame.REASONING_EFFORTS) {
                const opt = document.createElement("option");
                opt.value = r.id;
                opt.textContent = r.label;
                reasoningSelect.appendChild(opt);
            }
            reasoningSelect.value = draft.reasoningEffort;
            reasoningSelect.addEventListener("change", () => {
                draft.reasoningEffort = CustomMessagesGame._normalizeReasoningEffort(
                    reasoningSelect.value
                );
            });
            reasoningLabel.appendChild(reasoningSelect);

            settings.appendChild(maxWordsLabel);
            settings.appendChild(reasoningLabel);
            body.appendChild(settings);

            const clearLabel = document.createElement("label");
            clearLabel.className = "custom-messages-camera-label";
            const clearCheck = document.createElement("input");
            clearCheck.type = "checkbox";
            clearCheck.className = "custom-messages-clear-history";
            clearCheck.checked = draft.clearHistory !== false;
            clearCheck.addEventListener("change", () => {
                draft.clearHistory = !!clearCheck.checked;
            });
            clearLabel.appendChild(clearCheck);
            clearLabel.appendChild(document.createTextNode(" Clear chat history"));
            body.appendChild(clearLabel);

            const cameraLabel = document.createElement("label");
            cameraLabel.className = "custom-messages-camera-label";
            const cameraCheck = document.createElement("input");
            cameraCheck.type = "checkbox";
            cameraCheck.className = "custom-messages-camera";
            cameraCheck.checked = !!draft.sendCamera;
            cameraCheck.addEventListener("change", () => {
                draft.sendCamera = !!cameraCheck.checked;
            });
            cameraLabel.appendChild(cameraCheck);
            cameraLabel.appendChild(document.createTextNode(" Camera"));
            body.appendChild(cameraLabel);
        }

        const row = document.createElement("div");
        row.className = "custom-messages-media-row";

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "custom-messages-upload secondary";
        uploadBtn.textContent = "Upload file";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = ".txt,text/plain";
        fileInput.hidden = true;
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) return;
            try {
                const text = await file.text();
                draft.text = text;
                draft.fileName = file.name || "upload.txt";
                input.value = text;
                status.textContent = `Loaded: ${draft.fileName}`;
                status.className = "custom-messages-status ok";
                this._syncEditorOptionsVisibility();
            } catch (err) {
                status.textContent = err?.message || "Could not read file.";
                status.className = "custom-messages-status error";
            }
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(status);
    }

    async _toggleRecord(recordBtn, statusEl) {
        if (this._recording) {
            await this._stopRecording(false);
            if (recordBtn) recordBtn.textContent = "Record";
            if (statusEl && this._draft?.audioBlob) {
                statusEl.textContent = `Ready: ${this._draft.fileName || "Recording"}`;
                statusEl.className = "custom-messages-status ok";
            }
            this._syncPreviewButton();
            this._syncEditorOptionsVisibility();
            return;
        }
        this._stopPreview();
        try {
            if (statusEl) {
                statusEl.textContent = "Recording… tap Stop when done.";
                statusEl.className = "custom-messages-status warn";
            }
            if (recordBtn) recordBtn.textContent = "Stop";
            await this._startRecording();
        } catch (err) {
            console.warn("Custom record failed:", err);
            if (recordBtn) recordBtn.textContent = "Record";
            if (statusEl) {
                statusEl.textContent = err?.message || "Recording failed.";
                statusEl.className = "custom-messages-status error";
            }
        }
        this._syncPreviewButton();
    }

    _pickRecorderMimeType() {
        if (typeof MediaRecorder === "undefined") return "";
        for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
            try {
                if (MediaRecorder.isTypeSupported(t)) return t;
            } catch (_) {}
        }
        return "";
    }

    async _startRecording() {
        if (typeof MediaRecorder === "undefined") {
            throw new Error("Recording not supported in this browser.");
        }
        this._stopRecording(true);

        let stream = null;
        const mic = this._getMicrophone();
        if (mic && typeof mic.start === "function") {
            const ok = await mic.start();
            if (ok && typeof mic.getStream === "function") {
                stream = mic.getStream();
            }
        }
        if (!stream) {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            this._recordStreamOwned = true;
            this._ownedRecordStream = stream;
        } else {
            this._recordStreamOwned = false;
            this._ownedRecordStream = null;
        }

        const mimeType = this._pickRecorderMimeType();
        const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
        this._mediaRecorder = recorder;
        this._recordChunks = [];
        this._recording = true;
        recorder.addEventListener("dataavailable", (e) => {
            if (e.data && e.data.size > 0) this._recordChunks.push(e.data);
        });
        recorder.start(250);
    }

    /**
     * @param {boolean} discard
     */
    _stopRecording(discard) {
        return new Promise((resolve) => {
            const mr = this._mediaRecorder;
            this._mediaRecorder = null;
            this._recording = false;

            const releaseOwned = () => {
                if (this._recordStreamOwned && this._ownedRecordStream) {
                    for (const track of this._ownedRecordStream.getTracks()) {
                        try {
                            track.stop();
                        } catch (_) {}
                    }
                }
                this._ownedRecordStream = null;
                this._recordStreamOwned = false;
                const mic = this._getMicrophone();
                if (mic && typeof mic.stop === "function" && !mic._holdWanted && !mic._recordWanted) {
                    try {
                        mic.stop();
                    } catch (_) {}
                }
            };

            if (!mr) {
                this._recordChunks = [];
                releaseOwned();
                resolve(null);
                return;
            }

            const finish = () => {
                const chunks = this._recordChunks;
                this._recordChunks = [];
                const type = mr.mimeType || this._pickRecorderMimeType() || "audio/webm";
                const blob = !discard && chunks.length ? new Blob(chunks, { type }) : null;
                if (blob && this._draft) {
                    this._draft.audioBlob = blob;
                    this._draft.fileName = this._draft.fileName || "recording.webm";
                    this._draft._audioBase64 = null;
                }
                releaseOwned();
                resolve(blob);
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
    }

    async _submitDraft() {
        const draft = this._draft;
        if (!draft || !this._hasDraftContent()) return;
        if (this._recording) await this._stopRecording(false);

        const trigger = draft.trigger || "gameLoad";
        const msg = {
            id: draft.id || CustomMessagesGame._newId(),
            kind: draft.kind,
            trigger,
            loop: draft.loop === "repeat" ? "repeat" : "once",
            delaySec: CustomMessagesGame._normalizeDelaySec(draft.delaySec),
            constraints: CustomMessagesGame._normalizeConstraints(draft.constraints),
            text: String(draft.text || ""),
            fileName: String(draft.fileName || ""),
            sendCamera: draft.kind === "prompt" && !!draft.sendCamera,
            clearHistory: draft.kind === "prompt" && draft.clearHistory !== false,
            maxWords: CustomMessagesGame._normalizeMaxWords(draft.maxWords),
            reasoningEffort: CustomMessagesGame._normalizeReasoningEffort(draft.reasoningEffort),
            audioBlob: draft.kind === "audio" ? draft.audioBlob : null,
            _audioBase64: null,
            _audioMime: ""
        };

        const idx = this.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) this.messages[idx] = msg;
        else this.messages.push(msg);

        this._firedOnceIds.delete(msg.id);
        await this._persistAll();
        this._renderTiles();
        this._closeEditor();

        if (msg.trigger === "gameLoad" && this._running) {
            void this._playMessage(msg, this._generation);
        }
    }

    async _deleteMessage(id) {
        const want = String(id || "");
        this.messages = this.messages.filter((m) => m.id !== want);
        this._firedOnceIds.delete(want);
        await this._persistAll();
        this._renderTiles();
        this._closeEditor();
    }

    // —— Runtime ——————————————————————————————————————————————————

    _isFacePresent() {
        const cv = this._getComputerVision();
        return !!(cv && cv.faceScale != null);
    }

    /**
     * Constraints are AND gates on top of the trigger — trigger must also fire.
     * @param {CustomMessage} msg
     */
    _constraintsMet(msg) {
        const c = CustomMessagesGame._normalizeConstraints(msg?.constraints);
        if (c.face === "present" && !this._isFacePresent()) return false;
        if (c.face === "absent" && this._isFacePresent()) return false;
        return true;
    }

    /** Fires once each time this saved game is started (picked in Custom Games). */
    async _runGameLoad(generation) {
        const list = this.messages.filter((m) => m.trigger === "gameLoad");
        for (const msg of list) {
            if (!this._isActive(generation)) return;
            if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) continue;
            if (!this._constraintsMet(msg)) continue;
            const played = await this._playMessage(msg, generation);
            if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
            if (played && msg.loop === "repeat") {
                while (this._isActive(generation)) {
                    const gap = await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation);
                    if (!gap) return;
                    if (!this._constraintsMet(msg)) continue;
                    await this._playMessage(msg, generation);
                }
                return;
            }
        }
    }

    _startFacePoll(generation) {
        this._stopFacePoll();
        this._faceTimer = setInterval(() => {
            if (!this._isActive(generation)) {
                this._stopFacePoll();
                return;
            }
            void this._onFaceTick(generation);
        }, CustomMessagesGame.FACE_POLL_MS);
    }

    _stopFacePoll() {
        if (this._faceTimer) {
            clearInterval(this._faceTimer);
            this._faceTimer = null;
        }
    }

    async _onFaceTick(generation) {
        if (!this._isActive(generation) || this._audioBusy || this._faceTickBusy) return;
        const facePresent = this._isFacePresent();
        const now = Date.now();

        if (this._lastFacePresent === null) {
            this._lastFacePresent = facePresent;
            this._faceSince = now;
            return;
        }

        if (facePresent !== this._lastFacePresent) {
            this._lastFacePresent = facePresent;
            this._faceSince = now;
            // Re-arm once-triggers for the condition we just left.
            for (const msg of this.messages) {
                if (msg.loop !== "once") continue;
                if (msg.trigger === "faceDetected" && !facePresent) this._firedOnceIds.delete(msg.id);
                if (msg.trigger === "noFaceDetected" && facePresent) this._firedOnceIds.delete(msg.id);
            }
            return;
        }

        if (now - this._faceSince < CustomMessagesGame.FACE_STABLE_MS) return;

        const trigger = facePresent ? "faceDetected" : "noFaceDetected";
        const candidates = this.messages.filter(
            (m) => m.trigger === trigger && this._constraintsMet(m)
        );
        if (!candidates.length) return;

        this._faceTickBusy = true;
        try {
            for (const msg of candidates) {
                if (!this._isActive(generation) || this._audioBusy) return;
                if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) continue;
                if (!this._constraintsMet(msg)) continue;
                const played = await this._playMessage(msg, generation);
                if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
                if (played && msg.loop === "repeat") {
                    this._faceSince = Date.now();
                }
            }
        } finally {
            this._faceTickBusy = false;
        }
    }

    _isSpeechSpeaking() {
        try {
            if (window.speechSynthesis?.speaking) return true;
        } catch (_) {}
        return !!window.__phonebotTtsSpeaking;
    }

    _startSpeechPoll(generation) {
        this._stopSpeechPoll();
        this._lastSpeechSpeaking = this._isSpeechSpeaking();
        this._speechFinishedPending = false;
        this._speechStartEpoch = 0;
        this._speechFinishEpoch = 0;
        this._speechTimer = setInterval(() => {
            if (!this._isActive(generation)) {
                this._stopSpeechPoll();
                return;
            }
            void this._onSpeechTick(generation);
        }, CustomMessagesGame.SPEECH_POLL_MS);
    }

    _stopSpeechPoll() {
        if (this._speechTimer) {
            clearInterval(this._speechTimer);
            this._speechTimer = null;
        }
    }

    /**
     * Messages whose own speech (agent reply / repeat loop) should be allowed to
     * re-trigger speechFinished after the in-flight play completes.
     * Once-only text/audio clips do not — that would self-chain forever.
     * @param {CustomMessage} msg
     */
    static _speechFinishedMayRetriggerFromOwnSpeech(msg) {
        if (!msg) return false;
        if (msg.kind === "prompt") return true;
        if (msg.loop === "repeat") return true;
        return false;
    }

    async _onSpeechTick(generation) {
        if (!this._isActive(generation)) return;
        const speaking = this._isSpeechSpeaking();

        if (this._lastSpeechSpeaking === null) {
            this._lastSpeechSpeaking = speaking;
            return;
        }

        if (speaking && !this._lastSpeechSpeaking) {
            this._speechStartEpoch += 1;
            this._debugLog("Speech started", {
                speechTickBusy: this._speechTickBusy,
                audioBusy: this._audioBusy
            });
            for (const msg of this.messages) {
                if (msg.loop !== "once") continue;
                if (msg.trigger === "speechFinished") this._firedOnceIds.delete(msg.id);
            }
        }

        if (this._lastSpeechSpeaking && !speaking) {
            this._speechFinishedPending = true;
            this._speechFinishEpoch += 1;
            this._debugLog("Speech finished", {
                epoch: this._speechFinishEpoch,
                speechTickBusy: this._speechTickBusy,
                audioBusy: this._audioBusy
            });
        }
        this._lastSpeechSpeaking = speaking;

        if (!this._speechFinishedPending || this._speechTickBusy || this._audioBusy) return;

        const candidates = this.messages.filter((m) => m.trigger === "speechFinished");
        if (!candidates.length) {
            this._speechFinishedPending = false;
            return;
        }

        const waitingOnConstraints = candidates.some(
            (m) =>
                !(m.loop === "once" && this._firedOnceIds.has(m.id)) &&
                !this._constraintsMet(m)
        );
        const runnable = candidates.filter(
            (m) =>
                !(m.loop === "once" && this._firedOnceIds.has(m.id)) &&
                this._constraintsMet(m)
        );

        if (!runnable.length) {
            this._debugLog(
                "Speech finished but nothing runnable",
                candidates.map((m) => ({
                    action: CustomMessagesGame.tileLabel(m),
                    firedOnce: m.loop === "once" && this._firedOnceIds.has(m.id),
                    constraintsMet: this._constraintsMet(m),
                    constraints: CustomMessagesGame._constraintsSummary(m.constraints) || "none"
                })),
                { activeGame: this._activeGameName || "(none)" }
            );
            // Trigger already fired; keep pending while constraints may still become true.
            if (!waitingOnConstraints) this._speechFinishedPending = false;
            return;
        }

        // Consume this finish; a nested speak→silence during play bumps the epochs
        // and sets pending again so the next idle tick can run.
        this._speechFinishedPending = false;
        const epochAtStart = this._speechFinishEpoch;
        const startEpochAtStart = this._speechStartEpoch;
        /** @type {CustomMessage[]} */
        const mayRetrigger = [];

        this._speechTickBusy = true;
        try {
            for (const msg of runnable) {
                if (!this._isActive(generation)) return;
                if (!this._constraintsMet(msg)) continue;
                const played = await this._playMessage(msg, generation);
                if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
                if (played && CustomMessagesGame._speechFinishedMayRetriggerFromOwnSpeech(msg)) {
                    mayRetrigger.push(msg);
                }
            }
            // The play promise often resolves before the poller sees the falling edge
            // of the reply TTS, so a speech *start* during play also counts as nested.
            const nestedStart = this._speechStartEpoch !== startEpochAtStart;
            const nestedFinish = this._speechFinishEpoch !== epochAtStart;
            this._debugLog("Speech-finished play done", {
                nestedStart,
                nestedFinish,
                speakingNow: this._lastSpeechSpeaking,
                reArm: mayRetrigger.map((m) => CustomMessagesGame.tileLabel(m))
            });
            if ((nestedStart || nestedFinish) && mayRetrigger.length) {
                // Re-arm retriggerable messages (prompt replies / repeat loops). If the
                // finish edge was already seen, pending is still true; otherwise the next
                // falling edge sets it. Once-only text/audio clips are not re-armed —
                // their own TTS would otherwise self-chain forever.
                for (const msg of mayRetrigger) {
                    if (msg.loop === "once") this._firedOnceIds.delete(msg.id);
                }
            } else if (!waitingOnConstraints) {
                this._speechFinishedPending = false;
            }
        } finally {
            this._speechTickBusy = false;
        }
    }

    /**
     * @param {CustomMessage} msg
     * @param {number} generation
     */
    async _playMessage(msg, generation) {
        if (!msg || !this._isActive(generation)) return false;
        if (!this._constraintsMet(msg)) return false;

        while (this._audioBusy) {
            if (!this._isActive(generation)) return false;
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (!this._isActive(generation)) return false;
        if (!this._constraintsMet(msg)) return false;

        if (CustomMessagesGame.DEBUG_CONFIRM_TRIGGERS) {
            const confirmed = await this._debugConfirmTrigger(msg, generation);
            if (!confirmed || !this._isActive(generation)) return false;
        }

        const delayMs = CustomMessagesGame._normalizeDelaySec(msg.delaySec) * 1000;
        // Photo prompts own the delay as the on-camera countdown timer.
        const cameraOwnsDelay = msg.kind === "prompt" && !!msg.sendCamera;
        if (delayMs > 0 && !cameraOwnsDelay) {
            const delayed = await this._sleep(delayMs, generation);
            if (!delayed) return false;
        }
        if (!this._isActive(generation)) return false;
        // Re-check after delay — face / active game may have changed.
        if (!this._constraintsMet(msg)) return false;

        this._audioBusy = true;
        try {
            if (msg.kind === "audio") {
                await this._playAudio(msg, generation);
            } else if (msg.kind === "text") {
                await this._playText(msg, generation);
            } else if (msg.kind === "prompt") {
                await this._playPrompt(msg, generation);
            }
        } finally {
            this._audioBusy = false;
        }

        if (!this._isActive(generation)) return false;
        await this._playFollowingNext(msg, generation);
        return this._isActive(generation);
    }

    // —— Debug trigger confirm ———————————————————————————————————————

    _debugLog(...args) {
        if (!CustomMessagesGame.DEBUG_CONFIRM_TRIGGERS) return;
        console.info("[Custom debug]", ...args);
    }

    static _triggerLabel(triggerId) {
        const t = CustomMessagesGame.TRIGGERS.find((x) => x.id === triggerId);
        return t ? t.label : String(triggerId || "Unknown");
    }

    /**
     * Show a modal describing the fired trigger and its action; resolves true on Confirm.
     * Serialized so overlapping triggers queue instead of stacking popups.
     * @param {CustomMessage} msg
     * @param {number} generation
     * @returns {Promise<boolean>}
     */
    async _debugConfirmTrigger(msg, generation) {
        while (this._debugConfirmOverlay) {
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (!this._isActive(generation)) return false;

        const triggerLabel = CustomMessagesGame._triggerLabel(msg.trigger);
        const kindLabel =
            msg.kind === "prompt"
                ? msg.sendCamera
                    ? "Prompt + camera photo"
                    : "Prompt"
                : msg.kind === "audio"
                  ? "Audio clip"
                  : "Text (TTS)";
        const text = String(msg.text || "").trim();
        const delaySec = CustomMessagesGame._normalizeDelaySec(msg.delaySec);
        const constraints = CustomMessagesGame._constraintsSummary(msg.constraints) || "none";
        const rows = [
            ["Trigger", triggerLabel],
            ["Action", `${kindLabel} — ${CustomMessagesGame.tileLabel(msg)}`],
            ["Loop", msg.loop === "repeat" ? "Repeat" : "Play once"],
            ["Delay", `${delaySec}s`],
            ["Constraints", constraints],
            ["Active game", this._activeGameName || "(none)"]
        ];
        if (text) rows.push(["Text", text.length > 160 ? `${text.slice(0, 160)}…` : text]);

        this._debugLog("Trigger fired:", triggerLabel, "→", kindLabel, CustomMessagesGame.tileLabel(msg));

        return await new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "custom-messages-overlay custom-messages-debug-overlay";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");
            overlay.setAttribute("aria-label", "Trigger fired");

            const card = document.createElement("div");
            card.className = "custom-messages-card";

            const title = document.createElement("h2");
            title.className = "custom-messages-title";
            title.textContent = "Trigger fired (debug)";
            card.appendChild(title);

            for (const [label, value] of rows) {
                const row = document.createElement("div");
                row.className = "custom-messages-debug-row";
                row.style.margin = "4px 0";
                const strong = document.createElement("strong");
                strong.textContent = `${label}: `;
                row.appendChild(strong);
                row.appendChild(document.createTextNode(value));
                card.appendChild(row);
            }

            const actions = document.createElement("div");
            actions.className = "custom-messages-actions";

            const confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className = "custom-messages-submit";
            confirmBtn.textContent = "Confirm";
            confirmBtn.addEventListener("click", () => this._closeDebugConfirm(true));

            const skipBtn = document.createElement("button");
            skipBtn.type = "button";
            skipBtn.className = "custom-messages-cancel secondary";
            skipBtn.textContent = "Skip";
            skipBtn.addEventListener("click", () => this._closeDebugConfirm(false));

            actions.appendChild(confirmBtn);
            actions.appendChild(skipBtn);
            card.appendChild(actions);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            this._debugConfirmOverlay = overlay;
            this._debugConfirmResolve = resolve;
            confirmBtn.focus();
        });
    }

    /** @param {boolean} ok */
    _closeDebugConfirm(ok) {
        const overlay = this._debugConfirmOverlay;
        const resolve = this._debugConfirmResolve;
        this._debugConfirmOverlay = null;
        this._debugConfirmResolve = null;
        if (overlay) overlay.remove();
        if (resolve) resolve(!!ok);
    }

    async _playFollowingNext(afterMsg, generation) {
        const idx = this.messages.findIndex((m) => m.id === afterMsg.id);
        if (idx < 0) return;
        for (let i = idx + 1; i < this.messages.length; i++) {
            const next = this.messages[i];
            if (next.trigger !== "playNext") break;
            if (!this._isActive(generation)) return;
            if (next.loop === "once" && this._firedOnceIds.has(next.id)) continue;
            if (!this._constraintsMet(next)) continue;
            const played = await this._playMessage(next, generation);
            if (played && next.loop === "once") this._firedOnceIds.add(next.id);
            if (played && next.loop === "repeat") {
                while (this._isActive(generation)) {
                    const gap = await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation);
                    if (!gap) return;
                    if (!this._constraintsMet(next)) continue;
                    await this._playMessage(next, generation);
                }
            }
            // Only chain the immediate contiguous playNext block once through.
            // Nested _playMessage already continues the chain; stop here.
            return;
        }
    }

    async _playAudio(msg, generation) {
        const blob = msg.audioBlob;
        if (!blob || !blob.size) return;
        const player = this._getAudioPlayer();
        if (!player || typeof player.playBlob !== "function") {
            console.warn("Custom: audio player unavailable.");
            return;
        }
        try {
            await player.playBlob(blob, CustomMessagesGame.tileLabel(msg));
        } catch (err) {
            console.warn("Custom audio playback failed:", err);
        }
        return this._isActive(generation);
    }

    async _playText(msg, generation) {
        const text = String(msg.text || "").trim();
        if (!text) return;
        const agent = this._getAgent();
        if (agent && typeof agent._speakAsync === "function") {
            try {
                await agent._speakAsync(text);
            } catch (err) {
                console.warn("Custom TTS failed:", err);
            }
            return this._isActive(generation);
        }
        // Browser fallback
        try {
            if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                await new Promise((resolve) => {
                    const u = new SpeechSynthesisUtterance(text);
                    u.onend = () => resolve();
                    u.onerror = () => resolve();
                    window.speechSynthesis.speak(u);
                });
            }
        } catch (_) {}
        return this._isActive(generation);
    }

    async _playPrompt(msg, generation) {
        const text = CustomMessagesGame._composePromptText(msg.text, msg.maxWords);
        const reasoningEffort = CustomMessagesGame._normalizeReasoningEffort(msg.reasoningEffort);
        const sendCamera = !!msg.sendCamera;
        const clearHistory = msg.clearHistory !== false;
        const agent = this._getAgent();
        if (!agent || typeof agent.submitPrompt !== "function") {
            console.warn("Custom: agent unavailable for prompt.");
            return;
        }
        try {
            if (clearHistory) {
                agent.messageHistory = [];
                if (typeof agent._renderHistory === "function") agent._renderHistory();
            }
            const delaySec = CustomMessagesGame._normalizeDelaySec(msg.delaySec);
            // Always show the Simon-style timer for camera prompts (at least 1s), then flicker on capture.
            const cameraCountdownSeconds = sendCamera ? Math.max(1, Math.ceil(delaySec) || 1) : 0;
            await agent.submitPrompt(text, {
                allowEmpty: true,
                reasoningEffort,
                forceCameraImage: sendCamera,
                cameraCountdownSeconds,
                cameraCountdownLabel: "Photo!",
                cameraStatusPrefix: "Photo in",
                cameraOverlayIsActive: () => this._isActive(generation)
            });
        } catch (err) {
            console.warn("Custom prompt failed:", err);
        }
        return this._isActive(generation);
    }
}

/**
 * @typedef {object} CustomMessageConstraints
 * @property {"any"|"present"|"absent"} face
 */

/**
 * @typedef {object} CustomMessage
 * @property {string} id
 * @property {"audio"|"text"|"prompt"} kind
 * @property {string} trigger
 * @property {"once"|"repeat"} loop
 * @property {number} delaySec
 * @property {CustomMessageConstraints} constraints
 * @property {string} text
 * @property {string} fileName
 * @property {boolean} sendCamera
 * @property {boolean} clearHistory
 * @property {number} maxWords Prompt reply word limit; 0 = no limit.
 * @property {"low"|"medium"|"high"} reasoningEffort Sets the talking-head reasoning level when the prompt is sent.
 * @property {Blob|null} audioBlob
 * @property {string|null} [_audioBase64]
 * @property {string} [_audioMime]
 */

/**
 * Custom Games mode — pick a saved custom-messages collection or start a new empty one.
 */
class CustomGamesPicker {
    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        this._overlay = null;
        this._nameOverlay = null;
        this._listEl = null;
        this._closing = false;
    }

    start() {
        this.stop();
        this._closing = false;
        this._mount();
    }

    stop() {
        this._closing = true;
        this._closeNamePrompt();
        this._unmount();
    }

    _unmount() {
        if (this._overlay?.parentElement) {
            this._overlay.parentElement.removeChild(this._overlay);
        }
        this._overlay = null;
        this._listEl = null;
    }

    _closeNamePrompt() {
        if (this._nameOverlay?.parentElement) {
            this._nameOverlay.parentElement.removeChild(this._nameOverlay);
        }
        this._nameOverlay = null;
    }

    _goCustom() {
        if (this._closing) return;
        const robot = this.robot;
        if (robot && typeof robot.setMode === "function") {
            void robot.setMode("custom");
        }
    }

    _goMenu() {
        if (this._closing) return;
        const robot = this.robot;
        if (robot && typeof robot.setMode === "function") {
            void robot.setMode("menu");
        }
    }

    _onNew() {
        this._promptNewGameName();
    }

    /** Restore a game from a previously downloaded backup file. */
    _onUpload() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json,.phonebot-game.json,.phonebot-character.json";
        input.hidden = true;
        input.addEventListener("change", async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const saved = CustomMessagesGame.importGameFromExport(parsed);
                if (!saved) {
                    if (typeof window.alert === "function") {
                        window.alert("That file is not a valid game backup.");
                    }
                    return;
                }
                this._renderGameList();
            } catch (err) {
                console.warn("Game upload failed:", err);
                if (typeof window.alert === "function") {
                    window.alert("Could not read that game backup file.");
                }
            }
        });
        document.body.appendChild(input);
        input.click();
        // Remove if the user cancels the picker (change never fires).
        setTimeout(() => {
            if (input.parentElement && !input.files?.length) input.remove();
        }, 60_000);
    }

    /** Play / load this game (name control). */
    _onSelect(gameId) {
        if (!CustomMessagesGame.activateGame(gameId)) return;
        this._goCustom();
    }

    /** Open the messages dialog without selecting (playing) the game. */
    _onEdit(gameId) {
        CustomMessagesGame.requestEditGame(gameId);
        this._goCustom();
    }

    _onDelete(gameId, gameName) {
        const label = String(gameName || "this game").trim() || "this game";
        const ok =
            typeof window.confirm === "function"
                ? window.confirm(`Delete “${label}”? This cannot be undone.`)
                : true;
        if (!ok) return;
        if (!CustomMessagesGame.deleteGame(gameId)) return;
        this._renderGameList();
    }

    _promptNewGameName() {
        this._closeNamePrompt();
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-name-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "New game");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "New game";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent = "Name this game. Existing games are kept.";
        card.appendChild(hint);

        const label = document.createElement("label");
        label.className = "custom-messages-game-name-label";
        label.textContent = "Game name";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "custom-messages-game-name";
        input.placeholder = "e.g. Pirate guide";
        input.autocomplete = "off";
        input.maxLength = 48;
        label.appendChild(input);
        card.appendChild(label);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const createBtn = document.createElement("button");
        createBtn.type = "button";
        createBtn.className = "custom-messages-submit";
        createBtn.textContent = "Create";
        const sync = () => {
            createBtn.disabled = !String(input.value || "").trim();
        };
        sync();
        input.addEventListener("input", sync);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                createBtn.click();
            }
        });
        createBtn.addEventListener("click", () => {
            const name = String(input.value || "").trim();
            if (!name) return;
            const saved = CustomMessagesGame.createNamedGame(name);
            if (!saved) return;
            this._closeNamePrompt();
            CustomMessagesGame.requestEditGame(saved.id);
            this._goCustom();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "custom-messages-cancel secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._closeNamePrompt());

        actions.appendChild(createBtn);
        actions.appendChild(cancelBtn);
        card.appendChild(actions);
        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeNamePrompt();
        });
        document.body.appendChild(overlay);
        this._nameOverlay = overlay;
        setTimeout(() => input.focus(), 0);
    }

    _renderGameList() {
        const list = this._listEl;
        if (!list) return;
        list.innerHTML = "";

        const games = CustomMessagesGame.listGames();
        if (!games.length) {
            const empty = document.createElement("p");
            empty.className = "custom-messages-hint muted";
            empty.textContent = "No games yet. Tap New to create one.";
            list.appendChild(empty);
            return;
        }

        for (const game of games) {
            const tile = document.createElement("div");
            tile.className = "custom-messages-tile custom-messages-game-row";
            tile.setAttribute("role", "listitem");

            const nameBtn = document.createElement("button");
            nameBtn.type = "button";
            nameBtn.className = "custom-messages-game-row-name";
            nameBtn.textContent = game.name;
            nameBtn.title = `Play ${game.name}`;
            nameBtn.addEventListener("click", () => this._onSelect(game.id));

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.textContent = "Edit";
            editBtn.setAttribute("aria-label", `Edit ${game.name}`);
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onEdit(game.id);
            });

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "custom-messages-tile-edit custom-messages-game-delete";
            deleteBtn.textContent = "Delete";
            deleteBtn.setAttribute("aria-label", `Delete ${game.name}`);
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onDelete(game.id, game.name);
            });

            tile.appendChild(nameBtn);
            tile.appendChild(editBtn);
            tile.appendChild(deleteBtn);
            list.appendChild(tile);
        }
    }

    _mount() {
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-games-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Custom Games");

        const card = document.createElement("div");
        card.className = "custom-messages-card custom-messages-actions-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "Custom Games";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent =
            "Tap a name to play, Edit for messages, Upload to restore a backup, or create a new game.";
        card.appendChild(hint);

        const list = document.createElement("div");
        list.className = "custom-messages-tiles";
        list.setAttribute("role", "list");
        card.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const newBtn = document.createElement("button");
        newBtn.type = "button";
        newBtn.className = "custom-messages-add";
        newBtn.textContent = "New";
        newBtn.addEventListener("click", () => this._onNew());

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "custom-messages-upload secondary";
        uploadBtn.textContent = "Upload";
        uploadBtn.title = "Restore a game from a backup file";
        uploadBtn.addEventListener("click", () => this._onUpload());

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "custom-messages-cancel secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._goMenu());

        actions.appendChild(newBtn);
        actions.appendChild(uploadBtn);
        actions.appendChild(cancelBtn);
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._goMenu();
        });
        document.body.appendChild(overlay);
        this._overlay = overlay;
        this._listEl = list;
        this._renderGameList();
    }
}

window.CustomMessagesGame = CustomMessagesGame;
window.CustomGamesPicker = CustomGamesPicker;
