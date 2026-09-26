/**
 * Custom Messages — author audio / text / prompt clips with triggers and loops.
 * Free local talking-head game: tiles under the Game menu; editor dialog for create/edit.
 * Named "characters" store separate action collections; Characters mode picks which to load.
 */
class CustomMessagesGame {
    static STORAGE_KEY = "phonebot.customMessages.v2";
    static STORAGE_KEY_V1 = "phonebot.customMessages.v1";
    /** Portable single-character backup (download / upload). */
    static EXPORT_FORMAT = "phonebot.character.v1";
    static FACE_POLL_MS = 200;
    static SPEECH_POLL_MS = 150;
    static REPEAT_GAP_MS = 1200;
    static FACE_STABLE_MS = 400;
    static _pendingOpenActionsList = false;

    static TRIGGERS = Object.freeze([
        { id: "gameLoad", label: "Game load" },
        { id: "selected", label: "Selected" },
        { id: "faceDetected", label: "Face detected" },
        { id: "noFaceDetected", label: "No face detected" },
        { id: "speechFinished", label: "Speech finished" },
        { id: "playNext", label: "Play next" }
    ]);

    /** Prefix for Game-menu modes created by messages with trigger "selected". */
    static SELECTED_MODE_PREFIX = "customSelected:";

    static LOOPS = Object.freeze([
        { id: "once", label: "Play once" },
        { id: "repeat", label: "Repeat" }
    ]);

    /** Optional gates — all must hold in addition to the trigger firing. */
    static FACE_CONSTRAINTS = Object.freeze([
        { id: "any", label: "Any" },
        { id: "present", label: "Face present" },
        { id: "absent", label: "Face absent" }
    ]);

    /**
     * @param {object} robot
     * @param {{ selectedMessageId?: string|null }} [options]
     */
    constructor(robot, options = {}) {
        this.robot = robot;
        /** @type {CustomMessage[]} */
        this.messages = [];
        /** @type {string|null} */
        this._activeCharacterId = null;
        /** @type {string} */
        this._activeCharacterName = "";
        /** @type {string} */
        this._activeCharacterVoice = "";
        this._selectedMessageId = String(options.selectedMessageId || "").trim() || null;
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
        this._editorGameName = null;
        this._editorDelayInput = null;
        this._editorFaceConstraint = null;
        this._editorGameConstraint = null;
        this._actionsVoiceSelect = null;
        this._actionsNameInput = null;
        this._actionsTitleEl = null;
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
        const active = CustomMessagesGame.loadActiveWorkspace();
        this.messages = active.messages;
        this._activeCharacterId = active.characterId;
        this._activeCharacterName = active.characterName;
        this._activeCharacterVoice = active.characterVoice;
        this._showChatHistory();
        this._applyCharacterVoice(this._activeCharacterVoice);
        this._armHoldToTalk();
        const openActions =
            CustomMessagesGame._pendingOpenActionsList || !this.messages.length;
        CustomMessagesGame._pendingOpenActionsList = false;
        if (openActions) {
            this.openActionsList();
        }
        if (this._selectedMessageId) {
            void this._runSelected(this._generation, this._selectedMessageId);
        } else {
            void this._runGameLoad(this._generation);
        }
        this._startFacePoll(this._generation);
        this._startSpeechPoll(this._generation);
    }

    /**
     * Named games for the robot Game menu (messages with trigger "selected" on the active character).
     * @returns {{ modeId: string, messageId: string, label: string }[]}
     */
    static listMenuGames() {
        return CustomMessagesGame.loadActiveWorkspace()
            .messages.filter(
                (m) =>
                    m &&
                    m.trigger === "selected" &&
                    String(m.gameName || "").trim()
            )
            .map((m) => {
                const label = String(m.gameName || "").trim();
                return {
                    modeId: CustomMessagesGame.SELECTED_MODE_PREFIX + m.id,
                    messageId: m.id,
                    label
                };
            });
    }

    /** @param {string} modeId */
    static messageIdFromModeId(modeId) {
        const id = String(modeId || "");
        const prefix = CustomMessagesGame.SELECTED_MODE_PREFIX;
        if (!id.startsWith(prefix)) return null;
        return id.slice(prefix.length) || null;
    }

    /**
     * @returns {{ id: string, name: string }[]}
     */
    static listCharacters() {
        const store = CustomMessagesGame._loadStore();
        return (store.characters || [])
            .map((c) => ({
                id: String(c.id || ""),
                name: String(c.name || "").trim() || "Untitled"
            }))
            .filter((c) => c.id);
    }

    /**
     * Active working set (current character or untitled scratch).
     * @returns {{ characterId: string|null, characterName: string, characterVoice: string, messages: CustomMessage[] }}
     */
    static loadActiveWorkspace() {
        const store = CustomMessagesGame._loadStore();
        const activeId = store.activeCharacterId ? String(store.activeCharacterId) : null;
        if (activeId) {
            const character = (store.characters || []).find((c) => c && c.id === activeId);
            if (character) {
                return {
                    characterId: character.id,
                    characterName: String(character.name || "").trim() || "Untitled",
                    characterVoice:
                        String(character.voice || "").trim() || CustomMessagesGame._defaultVoiceId(),
                    messages: CustomMessagesGame._deserializeMessageList(character.messages)
                };
            }
        }
        return {
            characterId: null,
            characterName: "",
            characterVoice: CustomMessagesGame._defaultVoiceId(),
            messages: CustomMessagesGame._deserializeMessageList(store.scratch)
        };
    }

    /**
     * @returns {{ id: string, label: string }[]}
     */
    static _pickerVoices() {
        if (typeof window.GroqTts?.pickerVoices === "function") {
            return window.GroqTts.pickerVoices();
        }
        return [
            { id: "browser", label: "Web TTS (free)" },
            ...(Array.isArray(window.GroqTts?.VOICES) ? window.GroqTts.VOICES : [])
        ];
    }

    static _defaultVoiceId() {
        if (typeof window.GroqTts?.loadSavedVoice === "function") {
            const saved = String(window.GroqTts.loadSavedVoice() || "").trim();
            if (saved) return saved;
        }
        if (typeof window.GroqTts?.WEB_VOICE_ID === "string" && window.GroqTts.WEB_VOICE_ID) {
            return window.GroqTts.WEB_VOICE_ID;
        }
        return "browser";
    }

    /**
     * Update name/voice for a saved character.
     * @param {string} characterId
     * @param {{ name?: string, voice?: string }} patch
     * @returns {boolean}
     */
    static updateCharacterMeta(characterId, patch = {}) {
        const want = String(characterId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const character = (store.characters || []).find((c) => c && c.id === want);
        if (!character) return false;
        if (patch.name != null) {
            const label = String(patch.name || "").trim();
            if (label) character.name = label;
        }
        if (patch.voice != null) {
            const voice = String(patch.voice || "").trim();
            if (voice) character.voice = voice;
        }
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /**
     * Make a saved character the active workspace.
     * @param {string} characterId
     * @returns {boolean}
     */
    static activateCharacter(characterId) {
        const want = String(characterId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const character = (store.characters || []).find((c) => c && c.id === want);
        if (!character) return false;
        store.activeCharacterId = want;
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /**
     * Remove a saved character. Does not delete other characters.
     * @param {string} characterId
     * @returns {boolean}
     */
    static deleteCharacter(characterId) {
        const want = String(characterId || "").trim();
        if (!want) return false;
        const store = CustomMessagesGame._loadStore();
        const before = Array.isArray(store.characters) ? store.characters.length : 0;
        store.characters = (store.characters || []).filter((c) => c && c.id !== want);
        if (store.characters.length === before) return false;
        if (store.activeCharacterId === want) {
            store.activeCharacterId = null;
            store.scratch = [];
        }
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /** Next CustomMessagesGame start should open the messages panel. */
    static requestOpenActionsList() {
        CustomMessagesGame._pendingOpenActionsList = true;
    }

    /**
     * Copy messages into a new named character and activate it.
     * @param {string} name
     * @param {CustomMessage[]} [messages]
     * @returns {{ id: string, name: string }|null}
     */
    static saveAsNewCharacter(name, messages = []) {
        const label = String(name || "").trim();
        if (!label) return null;
        const store = CustomMessagesGame._loadStore();
        const serialized = (messages || []).map((m) => CustomMessagesGame._serializeMessage(m));
        const character = {
            id: CustomMessagesGame._newCharacterId(),
            name: label,
            voice: CustomMessagesGame._defaultVoiceId(),
            messages: serialized
        };
        if (!Array.isArray(store.characters)) store.characters = [];
        store.characters.push(character);
        store.activeCharacterId = character.id;
        CustomMessagesGame._saveStore(store);
        return { id: character.id, name: character.name };
    }

    /** Create an empty named character and activate it. */
    static createNamedCharacter(name) {
        return CustomMessagesGame.saveAsNewCharacter(name, []);
    }

    /**
     * Build a portable JSON payload for one character (includes audio as base64).
     * @param {{ name?: string, voice?: string, messages?: CustomMessage[] }} source
     * @returns {Promise<object>}
     */
    static async buildCharacterExport(source = {}) {
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
        const voice =
            String(source.voice || "").trim() || CustomMessagesGame._defaultVoiceId();
        return {
            format: CustomMessagesGame.EXPORT_FORMAT,
            exportedAt: new Date().toISOString(),
            name,
            voice,
            messages: messages.map((m) => CustomMessagesGame._serializeMessage(m))
        };
    }

    /**
     * Import a character backup file into the local store (new id; does not replace others).
     * @param {object} payload
     * @returns {{ id: string, name: string }|null}
     */
    static importCharacterFromExport(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const format = String(payload.format || "").trim();
        if (format && format !== CustomMessagesGame.EXPORT_FORMAT) return null;
        const name = String(payload.name || "").trim() || "Untitled";
        const voice =
            String(payload.voice || "").trim() || CustomMessagesGame._defaultVoiceId();
        const messages = CustomMessagesGame._deserializeMessageList(payload.messages);
        const store = CustomMessagesGame._loadStore();
        const character = {
            id: CustomMessagesGame._newCharacterId(),
            name,
            voice,
            messages: messages.map((m) => CustomMessagesGame._serializeMessage(m))
        };
        if (!Array.isArray(store.characters)) store.characters = [];
        store.characters.push(character);
        CustomMessagesGame._saveStore(store);
        return { id: character.id, name: character.name };
    }

    /**
     * Trigger a browser download of a JSON blob.
     * @param {string} filename
     * @param {object} data
     */
    static downloadJsonFile(filename, data) {
        const safeName =
            String(filename || "character")
                .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
                .replace(/\s+/g, "-")
                .slice(0, 64) || "character";
        const blob = new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.phonebot-character.json`;
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
        this._lastSpeechSpeaking = null;
        this._cancelSpeech();
        this._stopRecording(true);
        this._closeEditor();
        this._closeActionsList();
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
                  gameName: existing.gameName || "",
                  constraints: CustomMessagesGame._normalizeConstraints(existing.constraints),
                  text: existing.text || "",
                  fileName: existing.fileName || "",
                  sendCamera: !!existing.sendCamera,
                  clearHistory: existing.clearHistory !== false,
                  audioBlob: existing.audioBlob || null
              }
            : {
                  id: null,
                  kind: null,
                  trigger: "gameLoad",
                  loop: "once",
                  delaySec: 0,
                  gameName: "",
                  constraints: CustomMessagesGame._normalizeConstraints(null),
                  text: "",
                  fileName: "",
                  sendCamera: false,
                  clearHistory: true,
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
            activeCharacterId: null,
            scratch: [],
            characters: []
        };
    }

    static _loadStore() {
        try {
            const rawV2 = localStorage.getItem(CustomMessagesGame.STORAGE_KEY);
            if (rawV2) {
                const parsed = JSON.parse(rawV2);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return {
                        version: 2,
                        activeCharacterId: parsed.activeCharacterId
                            ? String(parsed.activeCharacterId)
                            : null,
                        scratch: Array.isArray(parsed.scratch) ? parsed.scratch : [],
                        characters: Array.isArray(parsed.characters)
                            ? parsed.characters
                                  .filter((c) => c && typeof c === "object")
                                  .map((c) => ({
                                      id: String(c.id || CustomMessagesGame._newCharacterId()),
                                      name: String(c.name || "").trim() || "Untitled",
                                      voice:
                                          String(c.voice || "").trim() ||
                                          CustomMessagesGame._defaultVoiceId(),
                                      messages: Array.isArray(c.messages) ? c.messages : []
                                  }))
                            : []
                    };
                }
            }
            const rawV1 = localStorage.getItem(CustomMessagesGame.STORAGE_KEY_V1);
            if (rawV1) {
                const parsed = JSON.parse(rawV1);
                if (Array.isArray(parsed)) {
                    const migrated = {
                        ...CustomMessagesGame._emptyStore(),
                        scratch: parsed
                    };
                    CustomMessagesGame._saveStore(migrated);
                    return migrated;
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
                activeCharacterId: store?.activeCharacterId || null,
                scratch: Array.isArray(store?.scratch) ? store.scratch : [],
                characters: Array.isArray(store?.characters) ? store.characters : []
            };
            localStorage.setItem(CustomMessagesGame.STORAGE_KEY, JSON.stringify(payload));
        } catch (err) {
            console.warn("Custom messages store save failed:", err);
        }
    }

    /** @deprecated Use loadActiveWorkspace — kept for older call sites. */
    static _loadMessages() {
        return CustomMessagesGame.loadActiveWorkspace().messages;
    }

    static _saveMessages(messages) {
        const store = CustomMessagesGame._loadStore();
        const serialized = (messages || []).map((m) => CustomMessagesGame._serializeMessage(m));
        const activeId = store.activeCharacterId ? String(store.activeCharacterId) : null;
        if (activeId) {
            const character = (store.characters || []).find((c) => c && c.id === activeId);
            if (character) {
                character.messages = serialized;
                CustomMessagesGame._saveStore(store);
                return;
            }
            store.activeCharacterId = null;
        }
        store.scratch = serialized;
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
            gameName: msg.trigger === "selected" ? String(msg.gameName || "").trim() : "",
            constraints,
            text: msg.text || "",
            fileName: msg.fileName || "",
            sendCamera: msg.kind === "prompt" && !!msg.sendCamera,
            clearHistory: msg.kind === "prompt" && msg.clearHistory !== false,
            audioBase64: null,
            audioMime: ""
        };
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
            gameName: String(entry.gameName || "").trim(),
            constraints: CustomMessagesGame._normalizeConstraints(entry.constraints),
            text: String(entry.text || ""),
            fileName: String(entry.fileName || ""),
            sendCamera: kind === "prompt" && !!entry.sendCamera,
            clearHistory: kind === "prompt" && entry.clearHistory !== false,
            audioBlob: null,
            _audioBase64: entry.audioBase64 || null,
            _audioMime: entry.audioMime || ""
        };
        if (msg.trigger !== "selected") msg.gameName = "";
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
     * @param {unknown} value
     * @returns {{ face: "any"|"present"|"absent", game: string }}
     */
    static _normalizeConstraints(value) {
        const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const faceRaw = String(src.face || "any").trim().toLowerCase();
        const face =
            faceRaw === "present" || faceRaw === "absent" ? faceRaw : "any";
        const game = String(src.game || "").trim();
        return { face, game };
    }

    /** @param {{ face?: string, game?: string }|null|undefined} constraints */
    static _constraintsSummary(constraints) {
        const c = CustomMessagesGame._normalizeConstraints(constraints);
        const parts = [];
        if (c.face === "present") parts.push("face present");
        if (c.face === "absent") parts.push("face absent");
        if (c.game) parts.push(`game=${c.game}`);
        return parts.length ? parts.join(", ") : "";
    }

    static _newId() {
        return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    static _newCharacterId() {
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
        CustomMessagesGame._saveMessages(this.messages);
        if (typeof this.robot?.refreshModesSelect === "function") {
            this.robot.refreshModesSelect();
        }
    }

    static tileLabel(msg) {
        if (!msg) return "Message";
        if (msg.trigger === "selected") {
            const gameName = String(msg.gameName || "").trim();
            if (gameName) return gameName;
        }
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

    // —— Voice helpers ——————————————————————————————————————————————

    _fillVoiceSelect(select, selectedId) {
        if (!select) return;
        select.innerHTML = "";
        for (const v of CustomMessagesGame._pickerVoices()) {
            const opt = document.createElement("option");
            opt.value = v.id;
            opt.textContent = v.label || v.id;
            select.appendChild(opt);
        }
        const want =
            String(selectedId || "").trim() ||
            this._activeCharacterVoice ||
            CustomMessagesGame._defaultVoiceId();
        if ([...select.options].some((o) => o.value === want)) {
            select.value = want;
        } else if (typeof window.GroqTts?.WEB_VOICE_ID === "string") {
            select.value = window.GroqTts.WEB_VOICE_ID;
        }
    }

    /**
     * @param {string} voiceId
     * @param {{ persist?: boolean }} [options]
     */
    _applyCharacterVoice(voiceId, options = {}) {
        const id =
            String(voiceId || "").trim() ||
            this._activeCharacterVoice ||
            CustomMessagesGame._defaultVoiceId();
        this._activeCharacterVoice = id;
        const agent = this._getAgent();
        if (agent && typeof agent.setTtsVoice === "function") {
            agent.setTtsVoice(id);
        } else if (typeof window.GroqTts?.saveVoice === "function") {
            window.GroqTts.saveVoice(id);
        }
        if (this._actionsVoiceSelect) this._fillVoiceSelect(this._actionsVoiceSelect, id);
        if (options.persist !== false && this._activeCharacterId) {
            CustomMessagesGame.updateCharacterMeta(this._activeCharacterId, { voice: id });
        }
    }

    /**
     * @param {{ name?: string, voice?: string }} patch
     */
    _persistActiveCharacterMeta(patch = {}) {
        if (!this._activeCharacterId) return;
        if (patch.name != null) {
            const label = String(patch.name || "").trim();
            if (label) this._activeCharacterName = label;
            else return;
        }
        if (patch.voice != null) {
            const voice = String(patch.voice || "").trim();
            if (voice) this._activeCharacterVoice = voice;
        }
        CustomMessagesGame.updateCharacterMeta(this._activeCharacterId, {
            name: this._activeCharacterName,
            voice: this._activeCharacterVoice
        });
        if (this._actionsTitleEl && this._activeCharacterName) {
            this._actionsTitleEl.textContent = this._activeCharacterName;
        }
        if (typeof this.robot?.refreshModesSelect === "function") {
            this.robot.refreshModesSelect();
        }
    }

    // —— Actions list popup ————————————————————————————————————————

    openActionsList() {
        this._closeActionsList();

        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-actions-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Character messages");

        const card = document.createElement("div");
        card.className = "custom-messages-card custom-messages-actions-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = this._activeCharacterName || "Character messages";
        card.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "custom-messages-character-meta";

        const nameLabel = document.createElement("label");
        nameLabel.className = "custom-messages-character-meta-label";
        nameLabel.textContent = "Name";
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "custom-messages-character-name-input";
        nameInput.placeholder = "Character name";
        nameInput.autocomplete = "off";
        nameInput.maxLength = 48;
        nameInput.value = this._activeCharacterName || "";
        nameInput.disabled = !this._activeCharacterId;
        nameInput.addEventListener("change", () => {
            this._persistActiveCharacterMeta({ name: nameInput.value });
        });
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                nameInput.blur();
            }
        });
        nameLabel.appendChild(nameInput);

        const voiceLabel = document.createElement("label");
        voiceLabel.className = "custom-messages-character-meta-label";
        voiceLabel.textContent = "Voice";
        const voiceSelect = document.createElement("select");
        voiceSelect.className = "custom-messages-character-voice-input";
        voiceSelect.setAttribute("aria-label", "Character voice");
        voiceSelect.disabled = !this._activeCharacterId;
        this._fillVoiceSelect(voiceSelect, this._activeCharacterVoice);
        voiceSelect.addEventListener("change", () => {
            this._applyCharacterVoice(voiceSelect.value, { persist: true });
        });
        voiceLabel.appendChild(voiceSelect);

        meta.appendChild(nameLabel);
        meta.appendChild(voiceLabel);
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
        downloadBtn.addEventListener("click", () => void this._downloadCharacterBackup());

        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "custom-messages-cancel secondary";
        doneBtn.textContent = "Done";
        doneBtn.addEventListener("click", () => this._closeActionsList());

        actions.appendChild(addBtn);
        actions.appendChild(downloadBtn);
        actions.appendChild(doneBtn);
        card.appendChild(actions);

        overlay.appendChild(card);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) this._closeActionsList();
        });
        document.body.appendChild(overlay);

        this._actionsOverlay = overlay;
        this._tileListEl = list;
        this._actionsTitleEl = title;
        this._actionsNameInput = nameInput;
        this._actionsVoiceSelect = voiceSelect;
        this._renderTiles();
    }

    _closeActionsList() {
        if (this._actionsOverlay?.parentElement) {
            this._actionsOverlay.parentElement.removeChild(this._actionsOverlay);
        }
        this._actionsOverlay = null;
        this._tileListEl = null;
        this._actionsTitleEl = null;
        this._actionsNameInput = null;
        this._actionsVoiceSelect = null;
    }

    /** Download the active character (messages + voice) as a restoreable JSON file. */
    async _downloadCharacterBackup() {
        const nameFromInput = String(this._actionsNameInput?.value || "").trim();
        const name =
            nameFromInput ||
            this._activeCharacterName ||
            "Untitled";
        const voice =
            String(this._actionsVoiceSelect?.value || "").trim() ||
            this._activeCharacterVoice ||
            CustomMessagesGame._defaultVoiceId();
        try {
            await this._persistAll();
            const payload = await CustomMessagesGame.buildCharacterExport({
                name,
                voice,
                messages: this.messages
            });
            CustomMessagesGame.downloadJsonFile(name, payload);
        } catch (err) {
            console.warn("Character download failed:", err);
            if (typeof window.alert === "function") {
                window.alert("Could not download character backup.");
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
            const constraintNote = CustomMessagesGame._constraintsSummary(msg.constraints);
            const constraintSuffix = constraintNote ? ` · if ${constraintNote}` : "";
            label.title = msg.trigger === "selected"
                ? `${msg.kind} · selected · ${msg.gameName || "unnamed"} · ${msg.loop}${delayNote}${cameraNote}${clearNote}${constraintSuffix}`
                : `${msg.kind} · ${msg.trigger} · ${msg.loop}${delayNote}${cameraNote}${clearNote}${constraintSuffix}`;

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
        this._editorGameName = null;
        this._editorGameNameLabel = null;
        this._editorFaceConstraint = null;
        this._editorGameConstraint = null;
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
            this._syncGameNameField();
            this._syncEditorOptionsVisibility();
        });
        triggerLabel.appendChild(triggerSelect);

        const gameNameLabel = document.createElement("label");
        gameNameLabel.className = "custom-messages-game-name-label";
        gameNameLabel.textContent = "Game name";
        const gameNameInput = document.createElement("input");
        gameNameInput.type = "text";
        gameNameInput.className = "custom-messages-game-name";
        gameNameInput.placeholder = "Name shown in Game menu";
        gameNameInput.autocomplete = "off";
        gameNameInput.maxLength = 48;
        gameNameInput.value = draft.gameName || "";
        gameNameInput.addEventListener("input", () => {
            draft.gameName = gameNameInput.value;
            this._fillGameConstraintSelect();
            this._syncEditorOptionsVisibility();
        });
        gameNameLabel.appendChild(gameNameInput);

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

        const gameConstraintLabel = document.createElement("label");
        gameConstraintLabel.textContent = "Game equals";
        const gameConstraintSelect = document.createElement("select");
        gameConstraintSelect.className = "custom-messages-game-constraint";
        gameConstraintSelect.addEventListener("change", () => {
            draft.constraints = CustomMessagesGame._normalizeConstraints({
                ...draft.constraints,
                game: gameConstraintSelect.value
            });
        });
        gameConstraintLabel.appendChild(gameConstraintSelect);

        options.appendChild(triggerLabel);
        options.appendChild(gameNameLabel);
        options.appendChild(loopLabel);
        options.appendChild(delayLabel);
        options.appendChild(constraintsHeading);
        options.appendChild(faceConstraintLabel);
        options.appendChild(gameConstraintLabel);
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
        this._editorGameName = gameNameInput;
        this._editorGameNameLabel = gameNameLabel;
        this._editorFaceConstraint = faceConstraintSelect;
        this._editorGameConstraint = gameConstraintSelect;

        this._refreshEditorBody();
        this._syncGameNameField();
        this._fillGameConstraintSelect();
    }

    _syncGameNameField() {
        const draft = this._draft;
        const show = !!draft && draft.trigger === "selected";
        const label = this._editorGameNameLabel;
        if (label) {
            label.hidden = !show;
            // Inline display beats author `label { display:block }` on mobile WebViews.
            label.style.display = show ? "" : "none";
        }
        this._fillGameConstraintSelect();
    }

    /** Populate "Game equals" constraint options from Selected-trigger game names. */
    _fillGameConstraintSelect() {
        const select = this._editorGameConstraint;
        const draft = this._draft;
        if (!select || !draft) return;
        const names = new Set();
        for (const m of this.messages) {
            if (m?.trigger === "selected") {
                const name = String(m.gameName || "").trim();
                if (name) names.add(name);
            }
        }
        const draftGame = String(draft.gameName || "").trim();
        if (draft.trigger === "selected" && draftGame) names.add(draftGame);
        const current = String(draft.constraints?.game || "").trim();
        if (current) names.add(current);

        select.innerHTML = "";
        const anyOpt = document.createElement("option");
        anyOpt.value = "";
        anyOpt.textContent = "Any";
        select.appendChild(anyOpt);
        for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        select.value = current && [...select.options].some((o) => o.value === current) ? current : "";
        draft.constraints = CustomMessagesGame._normalizeConstraints({
            ...draft.constraints,
            game: select.value
        });
    }

    _hasDraftMedia() {
        const draft = this._draft;
        if (!draft || !draft.kind) return false;
        if (draft.kind === "audio") return !!(draft.audioBlob && draft.audioBlob.size > 0);
        if (draft.kind === "prompt") return true;
        return String(draft.text || "").trim().length > 0;
    }

    _hasDraftContent() {
        const draft = this._draft;
        if (!this._hasDraftMedia()) return false;
        if (draft.trigger === "selected" && !String(draft.gameName || "").trim()) return false;
        return true;
    }

    _syncEditorOptionsVisibility() {
        const mediaReady = this._hasDraftMedia();
        if (this._editorOptions) this._editorOptions.hidden = !mediaReady;
        if (this._editorSubmit) this._editorSubmit.disabled = !this._hasDraftContent();
        if (mediaReady) this._syncGameNameField();
    }

    _refreshEditorBody() {
        const body = this._editorBody;
        const draft = this._draft;
        if (!body || !draft) return;
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
            draft.audioBlob = file;
            draft.fileName = file.name || "upload.audio";
            draft._audioBase64 = null;
            status.textContent = `Ready: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
            this._syncEditorOptionsVisibility();
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        row.appendChild(recordBtn);
        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(status);
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
            this._syncEditorOptionsVisibility();
            return;
        }
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
            gameName: trigger === "selected" ? String(draft.gameName || "").trim() : "",
            constraints: CustomMessagesGame._normalizeConstraints(draft.constraints),
            text: String(draft.text || ""),
            fileName: String(draft.fileName || ""),
            sendCamera: draft.kind === "prompt" && !!draft.sendCamera,
            clearHistory: draft.kind === "prompt" && draft.clearHistory !== false,
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

        if (msg.trigger === "gameLoad" && this._running && !this._selectedMessageId) {
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

    /** Active Game-menu selected game name, or "" when none. */
    _activeSelectedGameName() {
        const want = String(this._selectedMessageId || "").trim();
        if (!want) return "";
        const msg = this.messages.find((m) => m && m.id === want);
        return String(msg?.gameName || "").trim();
    }

    /**
     * Constraints are AND gates on top of the trigger — trigger must also fire.
     * @param {CustomMessage} msg
     */
    _constraintsMet(msg) {
        const c = CustomMessagesGame._normalizeConstraints(msg?.constraints);
        if (c.face === "present" && !this._isFacePresent()) return false;
        if (c.face === "absent" && this._isFacePresent()) return false;
        if (c.game) {
            if (this._activeSelectedGameName() !== c.game) return false;
        }
        return true;
    }

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

    /**
     * Play the message tied to a Game-menu "selected" entry (and its playNext chain).
     * @param {number} generation
     * @param {string} messageId
     */
    async _runSelected(generation, messageId) {
        const want = String(messageId || "").trim();
        if (!want) return;
        const msg = this.messages.find((m) => m.id === want && m.trigger === "selected");
        if (!msg) {
            console.warn("Custom: selected game message not found:", want);
            return;
        }
        if (!this._isActive(generation)) return;
        if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) return;
        if (!this._constraintsMet(msg)) return;
        const played = await this._playMessage(msg, generation);
        if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
        if (played && msg.loop === "repeat") {
            while (this._isActive(generation)) {
                const gap = await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation);
                if (!gap) return;
                if (!this._constraintsMet(msg)) continue;
                await this._playMessage(msg, generation);
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

    async _onSpeechTick(generation) {
        if (!this._isActive(generation)) return;
        const speaking = this._isSpeechSpeaking();

        if (this._lastSpeechSpeaking === null) {
            this._lastSpeechSpeaking = speaking;
            return;
        }

        if (speaking && !this._lastSpeechSpeaking) {
            for (const msg of this.messages) {
                if (msg.loop !== "once") continue;
                if (msg.trigger === "speechFinished") this._firedOnceIds.delete(msg.id);
            }
        }

        if (this._lastSpeechSpeaking && !speaking) {
            this._speechFinishedPending = true;
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
            // Trigger already fired; keep pending while constraints may still become true.
            if (!waitingOnConstraints) this._speechFinishedPending = false;
            return;
        }

        this._speechTickBusy = true;
        try {
            for (const msg of runnable) {
                if (!this._isActive(generation)) return;
                if (!this._constraintsMet(msg)) continue;
                const played = await this._playMessage(msg, generation);
                if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
            }
            if (!waitingOnConstraints) this._speechFinishedPending = false;
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
        const text = String(msg.text || "").trim();
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
 * @property {string} game empty = any; otherwise must match active Selected game name
 */

/**
 * @typedef {object} CustomMessage
 * @property {string} id
 * @property {"audio"|"text"|"prompt"} kind
 * @property {string} trigger
 * @property {"once"|"repeat"} loop
 * @property {number} delaySec
 * @property {string} gameName
 * @property {CustomMessageConstraints} constraints
 * @property {string} text
 * @property {string} fileName
 * @property {boolean} sendCamera
 * @property {boolean} clearHistory
 * @property {Blob|null} audioBlob
 * @property {string|null} [_audioBase64]
 * @property {string} [_audioMime]
 */

/**
 * Characters mode — pick a saved custom-messages collection or start a new empty one.
 */
class CustomCharactersPicker {
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
        if (robot && typeof robot.refreshModesSelect === "function") {
            robot.refreshModesSelect();
        }
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
        this._promptNewCharacterName();
    }

    /** Restore a character from a previously downloaded backup file. */
    _onUpload() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json,.phonebot-character.json";
        input.hidden = true;
        input.addEventListener("change", async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const saved = CustomMessagesGame.importCharacterFromExport(parsed);
                if (!saved) {
                    if (typeof window.alert === "function") {
                        window.alert("That file is not a valid character backup.");
                    }
                    return;
                }
                if (typeof this.robot?.refreshModesSelect === "function") {
                    this.robot.refreshModesSelect();
                }
                this._renderCharacterList();
            } catch (err) {
                console.warn("Character upload failed:", err);
                if (typeof window.alert === "function") {
                    window.alert("Could not read that character backup file.");
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

    /** Play / load this character (name control). */
    _onSelect(characterId) {
        if (!CustomMessagesGame.activateCharacter(characterId)) return;
        this._goCustom();
    }

    /** Load character and open the messages dialog. */
    _onEdit(characterId) {
        if (!CustomMessagesGame.activateCharacter(characterId)) return;
        CustomMessagesGame.requestOpenActionsList();
        this._goCustom();
    }

    _onDelete(characterId, characterName) {
        const label = String(characterName || "this character").trim() || "this character";
        const ok =
            typeof window.confirm === "function"
                ? window.confirm(`Delete “${label}”? This cannot be undone.`)
                : true;
        if (!ok) return;
        if (!CustomMessagesGame.deleteCharacter(characterId)) return;
        if (typeof this.robot?.refreshModesSelect === "function") {
            this.robot.refreshModesSelect();
        }
        this._renderCharacterList();
    }

    _promptNewCharacterName() {
        this._closeNamePrompt();
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-name-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "New character");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "New character";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent = "Name this character. Existing characters are kept.";
        card.appendChild(hint);

        const label = document.createElement("label");
        label.className = "custom-messages-game-name-label";
        label.textContent = "Character name";
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
            const saved = CustomMessagesGame.createNamedCharacter(name);
            if (!saved) return;
            this._closeNamePrompt();
            CustomMessagesGame.requestOpenActionsList();
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

    _renderCharacterList() {
        const list = this._listEl;
        if (!list) return;
        list.innerHTML = "";

        const characters = CustomMessagesGame.listCharacters();
        if (!characters.length) {
            const empty = document.createElement("p");
            empty.className = "custom-messages-hint muted";
            empty.textContent = "No characters yet. Tap New to create one.";
            list.appendChild(empty);
            return;
        }

        for (const character of characters) {
            const tile = document.createElement("div");
            tile.className = "custom-messages-tile custom-messages-character-row";
            tile.setAttribute("role", "listitem");

            const nameBtn = document.createElement("button");
            nameBtn.type = "button";
            nameBtn.className = "custom-messages-character-name";
            nameBtn.textContent = character.name;
            nameBtn.title = `Play ${character.name}`;
            nameBtn.addEventListener("click", () => this._onSelect(character.id));

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.textContent = "Edit";
            editBtn.setAttribute("aria-label", `Edit ${character.name}`);
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onEdit(character.id);
            });

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "custom-messages-tile-edit custom-messages-character-delete";
            deleteBtn.textContent = "Delete";
            deleteBtn.setAttribute("aria-label", `Delete ${character.name}`);
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this._onDelete(character.id, character.name);
            });

            tile.appendChild(nameBtn);
            tile.appendChild(editBtn);
            tile.appendChild(deleteBtn);
            list.appendChild(tile);
        }
    }

    _mount() {
        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay custom-messages-characters-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Characters");

        const card = document.createElement("div");
        card.className = "custom-messages-card custom-messages-actions-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = "Characters";
        card.appendChild(title);

        const hint = document.createElement("p");
        hint.className = "custom-messages-hint muted";
        hint.textContent =
            "Tap a name to play, Edit for messages, Upload to restore a backup, or create a new character.";
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
        uploadBtn.title = "Restore a character from a backup file";
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
        this._renderCharacterList();
    }
}

window.CustomMessagesGame = CustomMessagesGame;
window.CustomCharactersPicker = CustomCharactersPicker;
