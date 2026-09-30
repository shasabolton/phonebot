/**
 * Audio clips for custom games, kept in IndexedDB by `audioKey` so long clips stay out of the
 * ~5 MB localStorage quota. Clips are stored as ArrayBuffer + MIME (older Safari rejects Blobs).
 */
class CustomAudioStore {
    static DB_NAME = "phonebot.customAudio";
    static DB_VERSION = 1;
    static STORE_NAME = "clips";
    /** @type {Promise<IDBDatabase>|null} */
    static _dbPromise = null;
    static _persistRequested = false;
    /** Keys written by this page load; the orphan sweep skips them until their game is saved. */
    static _writtenThisSession = new Set();

    static isAvailable() {
        return typeof indexedDB !== "undefined";
    }

    static newKey() {
        return `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    static _open() {
        if (!CustomAudioStore._dbPromise) {
            CustomAudioStore._dbPromise = new Promise((resolve, reject) => {
                if (!CustomAudioStore.isAvailable()) {
                    reject(new Error("IndexedDB unavailable."));
                    return;
                }
                const req = indexedDB.open(CustomAudioStore.DB_NAME, CustomAudioStore.DB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(CustomAudioStore.STORE_NAME)) {
                        db.createObjectStore(CustomAudioStore.STORE_NAME);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error || new Error("IndexedDB open failed."));
            }).catch((err) => {
                CustomAudioStore._dbPromise = null;
                throw err;
            });
        }
        return CustomAudioStore._dbPromise;
    }

    /**
     * @param {IDBTransactionMode} mode
     * @param {(store: IDBObjectStore) => IDBRequest|void} fn
     */
    static async _run(mode, fn) {
        const db = await CustomAudioStore._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CustomAudioStore.STORE_NAME, mode);
            let result;
            const req = fn(tx.objectStore(CustomAudioStore.STORE_NAME));
            if (req) req.onsuccess = () => (result = req.result);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error("IndexedDB request failed."));
            tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
        });
    }

    /**
     * @param {string} key
     * @param {Blob} blob
     */
    static async put(key, blob) {
        const buffer = await blob.arrayBuffer();
        CustomAudioStore._writtenThisSession.add(key);
        await CustomAudioStore._run("readwrite", (store) =>
            store.put({ buffer, mime: blob.type || "audio/webm" }, key)
        );
        CustomAudioStore._requestPersist();
    }

    /**
     * @param {string} key
     * @returns {Promise<Blob|null>}
     */
    static async get(key) {
        const entry = await CustomAudioStore._run("readonly", (store) => store.get(key));
        if (!entry || !entry.buffer) return null;
        return new Blob([entry.buffer], { type: entry.mime || "audio/webm" });
    }

    /** @param {string|string[]} keys */
    static async remove(keys) {
        const list = (Array.isArray(keys) ? keys : [keys])
            .map((k) => String(k || ""))
            .filter(Boolean);
        if (!list.length) return;
        await CustomAudioStore._run("readwrite", (store) => {
            for (const key of list) store.delete(key);
        });
    }

    /** @returns {Promise<string[]>} */
    static async keys() {
        const out = await CustomAudioStore._run("readonly", (store) => store.getAllKeys());
        return Array.isArray(out) ? out.map(String) : [];
    }

    /** Ask the browser not to evict clips under storage pressure (installed PWAs usually get it). */
    static _requestPersist() {
        if (CustomAudioStore._persistRequested) return;
        CustomAudioStore._persistRequested = true;
        try {
            const pending = navigator.storage?.persist?.();
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch (_) {}
    }
}

/**
 * Custom Messages — author audio / text / prompt clips with triggers and loops.
 * Runs the games that belong to characters; the character editor opens this game's editor.
 * Each saved game is one action collection, owned by a character (`characterId` + `slug`).
 */
class CustomMessagesGame {
    static STORAGE_KEY = "phonebot.customMessages.v2";
    static STORAGE_KEY_V1 = "phonebot.customMessages.v1";
    /** A game folder's JSON file (and older single-file backups). */
    static EXPORT_FORMAT = "phonebot.game.v1";
    /** Older backup formats still accepted on upload. */
    static LEGACY_EXPORT_FORMATS = Object.freeze(["phonebot.character.v1"]);
    /** Fired on window whenever the game store is saved. */
    static GAME_CHANGE_EVENT = "phonebot:gamechange";
    /** Code games (JS classes) the robot can run as modes. */
    static GAMES_INDEX_URL = "games/index.json";
    static AUDIO_MIME_BY_EXT = Object.freeze({
        wav: "audio/wav",
        mp3: "audio/mpeg",
        ogg: "audio/ogg",
        opus: "audio/ogg",
        webm: "audio/webm",
        m4a: "audio/mp4",
        aac: "audio/aac",
        flac: "audio/flac"
    });
    /** @type {Promise<GamesIndexEntry[]>|null} */
    static _builtinIndexPromise = null;
    static FACE_POLL_MS = 200;
    static SPEECH_POLL_MS = 150;
    static REPEAT_GAP_MS = 1200;
    /** Shortest step in a run of messages, so loops through clips that end at once don't spin. */
    static MIN_STEP_MS = 300;
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
        { id: "playNext", label: "After another message" },
        { id: "playerTurn", label: "Player turn" }
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
     * On end values besides playing a message ("msg:<id>") or ending with a particular game
     * ("end:game:<id>" / "end:<built-in id>"). "" waits for the next trigger.
     */
    static ON_END_PLAY = Object.freeze([
        { id: "", label: "Wait for a trigger" },
        { id: "next", label: "Play next message" },
        { id: "first", label: "Play first message" }
    ]);
    static ON_END_ENDINGS = Object.freeze([
        { id: "end:home", label: "End game, go to home game" },
        { id: "end:none", label: "End game, no game" },
        { id: "end:next", label: "End game, next game" }
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
        /** Editing from the character editor: no triggers run and the game is not selected. */
        this._editOnly = false;
        this._running = false;
        this._generation = 0;
        this._audioBusy = false;
        this._faceTimer = null;
        /** Face triggers whose run is still going; the other face trigger can still take over. */
        this._faceTicksBusy = new Set();
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
        /** Bumped whenever a trigger plays a message; runs of On end / Repeat from before stop. */
        this._chainEpoch = 0;
        /** Player messages sent since the game (or its last history-clearing prompt) started. */
        this._playerTurn = 0;
        /** A player-turn action will end the game once this turn's reply has been spoken. */
        this._endPending = false;
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
        this._editorTurnLabel = null;
        this._editorDelayLabel = null;
        this._editorRepeatHint = null;
        /** @type {HTMLElement[]|null} The On end dropdown and its hint. */
        this._editorOnEnd = null;
        /** @type {HTMLAudioElement|null} Editor preview of the draft audio clip. */
        this._previewAudio = null;
        this._previewUrl = null;
        this._previewBtn = null;
        /** @type {HTMLInputElement|null} */
        this._editorAudioUrlInput = null;
        /** @type {HTMLAudioElement|null} URL clip playing outside the player (host has no CORS). */
        this._untappedAudio = null;
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
        this._chainEpoch = 0;
        this._playerTurn = 0;
        this._endPending = false;
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
            // No game selected: plain hold-to-talk chat with no actions or prompts.
            this._editOnly = false;
            this.messages = [];
            this._activeGameId = null;
            this._activeGameName = "";
            this._showChatHistory();
            this._armHoldToTalk();
            return;
        }
        this.messages = active.messages;
        this._activeGameId = active.gameId;
        this._activeGameName = active.gameName;
        if (this._editOnly) this._running = false;
        void this._loadAudioAndBegin(this._generation);
    }

    /** Clips load from IndexedDB before the editor opens or any trigger can play them. */
    async _loadAudioAndBegin(generation) {
        await CustomMessagesGame._loadAudio(this.messages);
        if (generation !== this._generation) return;
        if (this.messages.some((m) => m.audioBlob && !m.audioKey)) {
            // Clips saved inline in localStorage by older builds move into IndexedDB.
            await this._persistAll();
            if (generation !== this._generation) return;
        }
        if (this._editOnly) {
            this.openActionsList();
            return;
        }
        this._showChatHistory();
        this._armHoldToTalk();
        if (!this.messages.length) {
            this.openActionsList();
        }
        void this._runGameLoad(generation);
        this._startFacePoll(generation);
        this._startSpeechPoll(generation);
    }

    /**
     * `characterId` + `slug` name the owning character and the game's folder in it ("" for games
     * saved before characters owned games). `builtinId` is left on copies of the old shared games.
     * @returns {SavedGameSummary[]}
     */
    static listGames() {
        const store = CustomMessagesGame._loadStore();
        return (store.games || [])
            .map((c) => ({
                id: String(c.id || ""),
                name: String(c.name || "").trim() || "Untitled",
                characterId: String(c.characterId || ""),
                slug: String(c.slug || ""),
                builtinId: String(c.builtinId || "")
            }))
            .filter((c) => c.id);
    }

    /** @returns {SavedGameSummary|null} */
    static findCharacterGame(characterId, slug) {
        const owner = String(characterId || "");
        const want = String(slug || "");
        if (!owner || !want) return null;
        return (
            CustomMessagesGame.listGames().find((g) => g.characterId === owner && g.slug === want) ||
            null
        );
    }

    /**
     * Give a saved game to a character, as the game folder `slug`.
     * @returns {boolean}
     */
    static assignGame(gameId, { characterId, slug }) {
        const store = CustomMessagesGame._loadStore();
        const game = (store.games || []).find((c) => c && c.id === String(gameId || ""));
        if (!game || !characterId || !slug) return false;
        game.characterId = String(characterId);
        game.slug = String(slug);
        delete game.builtinId;
        CustomMessagesGame._saveStore(store);
        return true;
    }

    /** Delete every game a character owns. */
    static deleteCharacterGames(characterId) {
        const owner = String(characterId || "");
        if (!owner) return;
        for (const game of CustomMessagesGame.listGames()) {
            if (game.characterId === owner) CustomMessagesGame.deleteGame(game.id);
        }
    }

    /**
     * Code games from games/index.json. Resolves to [] when the index can't be fetched
     * (e.g. opened from file://).
     * @returns {Promise<GamesIndexEntry[]>}
     */
    static loadGamesIndex() {
        if (!CustomMessagesGame._builtinIndexPromise) {
            CustomMessagesGame._builtinIndexPromise = fetch(CustomMessagesGame.GAMES_INDEX_URL, {
                cache: "no-cache"
            })
                .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.json();
                })
                .then((index) =>
                    (Array.isArray(index?.games) ? index.games : [])
                        .filter((g) => g && g.id && g.path && g.type === "js")
                        .map((g) => ({
                            id: String(g.id),
                            name: String(g.name || "").trim() || String(g.id),
                            type: "js",
                            path: String(g.path),
                            className: String(g.className || ""),
                            computervisionModel: String(g.computervisionModel || "")
                        }))
                )
                .catch((err) => {
                    console.warn("Games index load failed:", err);
                    CustomMessagesGame._builtinIndexPromise = null;
                    return [];
                });
        }
        return CustomMessagesGame._builtinIndexPromise;
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
        return CustomMessagesGame.activeGame()?.name || "";
    }

    /** @returns {SavedGameSummary|null} */
    static activeGame() {
        const store = CustomMessagesGame._loadStore();
        const activeId = store.activeGameId ? String(store.activeGameId) : null;
        if (!activeId) return null;
        return CustomMessagesGame.listGames().find((g) => g.id === activeId) || null;
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

    /** Clear the active game so Custom runs as plain chat. */
    static deactivateGame() {
        const store = CustomMessagesGame._loadStore();
        if (!store.activeGameId) return;
        store.activeGameId = null;
        CustomMessagesGame._saveStore(store);
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
        const removed = (store.games || []).find((c) => c && c.id === want);
        if (!removed) return false;
        store.games = store.games.filter((c) => c && c.id !== want);
        if (store.activeGameId === want) {
            store.activeGameId = null;
        }
        CustomMessagesGame._saveStore(store);
        const audioKeys = (removed.messages || []).map((m) => m?.audioKey).filter(Boolean);
        CustomAudioStore.remove(audioKeys).catch((err) => {
            console.warn("Custom audio delete failed:", err);
        });
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
     * Create an empty game for a character (not made active).
     * @param {string} name
     * @param {{ characterId: string, slug: string }} owner
     * @returns {{ id: string, name: string }|null}
     */
    static createNamedGame(name, { characterId, slug }) {
        const label = String(name || "").trim();
        if (!label || !characterId || !slug) return null;
        const store = CustomMessagesGame._loadStore();
        const game = {
            id: CustomMessagesGame._newGameId(),
            name: label,
            messages: [],
            characterId: String(characterId),
            slug: String(slug)
        };
        if (!Array.isArray(store.games)) store.games = [];
        store.games.push(game);
        CustomMessagesGame._saveStore(store);
        return { id: game.id, name: game.name };
    }

    /**
     * Save a game file into the local store for a character, replacing the game already saved
     * under that `slug`. Relative `audioUrl`s point into the game's folder: `basePath` (the JSON
     * file's app-relative path) turns them into app paths; `files` (paths relative to the game
     * folder, e.g. from a zip) turns them into stored clips.
     * @param {object} payload
     * @param {{ characterId: string, slug: string, basePath?: string, files?: Map<string, Blob>|null }} options
     * @returns {Promise<{ id: string, name: string }|null>}
     */
    static async importGameFromExport(payload, { characterId, slug, basePath = "", files = null }) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        if (!characterId || !slug) return null;
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
        // Fresh keys so importing the same backup twice never shares (then deletes) a clip.
        for (const msg of messages) msg.audioKey = "";
        CustomMessagesGame._rebaseAudio(messages, { basePath, files });
        await CustomMessagesGame._storeAudioInDb(messages);
        const previous = CustomMessagesGame.findCharacterGame(characterId, slug);
        if (previous) CustomMessagesGame.deleteGame(previous.id);
        const store = CustomMessagesGame._loadStore();
        const game = {
            id: CustomMessagesGame._newGameId(),
            name,
            messages: messages.map((m) => CustomMessagesGame._serializeMessage(m)),
            characterId: String(characterId),
            slug: String(slug)
        };
        if (!Array.isArray(store.games)) store.games = [];
        store.games.push(game);
        CustomMessagesGame._saveStore(store);
        return { id: game.id, name: game.name };
    }

    /** @param {string} value @returns {boolean} true for paths with no scheme or leading slash. */
    static _isRelativePath(value) {
        const raw = String(value || "").trim();
        return !!raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("/");
    }

    /**
     * `relative` resolved against the file at `basePath`, both app-relative ("" if it escapes).
     * @param {string} basePath
     * @param {string} relative
     */
    static _resolveRelativePath(basePath, relative) {
        const origin = "https://game.invalid";
        try {
            const url = new URL(relative, `${origin}/${String(basePath || "").replace(/^\/+/, "")}`);
            return url.origin === origin ? decodeURIComponent(url.pathname.slice(1)) : "";
        } catch (_) {
            return "";
        }
    }

    /** @param {CustomMessage[]} messages @param {{ basePath?: string, files?: Map<string, Blob>|null }} source */
    static _rebaseAudio(messages, { basePath = "", files = null }) {
        if (!basePath && !files) return;
        for (const msg of messages) {
            if (msg.kind !== "audio" || !CustomMessagesGame._isRelativePath(msg.audioUrl)) continue;
            if (files) {
                const path = CustomMessagesGame._resolveRelativePath("game.json", msg.audioUrl);
                const blob = files.get(path);
                if (!blob) console.warn("Game audio file missing:", msg.audioUrl);
                msg.audioBlob = blob ? CustomMessagesGame._withAudioMime(blob, path) : null;
                msg.audioUrl = "";
                if (!msg.fileName) msg.fileName = path.split("/").pop();
            } else {
                msg.audioUrl = CustomMessagesGame._resolveRelativePath(basePath, msg.audioUrl);
            }
        }
    }

    /** Blobs from a zip have no type; the stored clip keeps the one its extension implies. */
    static _withAudioMime(blob, path) {
        if (blob.type) return blob;
        const ext = String(path).split(".").pop().toLowerCase();
        const type = CustomMessagesGame.AUDIO_MIME_BY_EXT[ext] || "audio/webm";
        return new Blob([blob], { type });
    }

    /** @param {string} mime @param {string} fileName */
    static _audioExtension(mime, fileName) {
        const fromName = String(fileName || "").match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
        if (fromName && CustomMessagesGame.AUDIO_MIME_BY_EXT[fromName]) return fromName;
        const type = String(mime || "").split(";")[0].trim().toLowerCase();
        if (type === "audio/x-wav" || type === "audio/wave") return "wav";
        const known = Object.entries(CustomMessagesGame.AUDIO_MIME_BY_EXT).find(([, m]) => m === type);
        return known ? known[0] : "webm";
    }

    /** @param {string} url @returns {boolean} true for URLs served by this app (same origin). */
    static _isAppUrl(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin;
        } catch (_) {
            return false;
        }
    }

    /**
     * A game as the files of its game folder: the game JSON plus clips under `audio/`, which the
     * JSON references by relative `audioUrl`. Clips at other sites stay as URLs.
     * @param {{ savedId?: string, payload?: object, basePath?: string }} source a saved game, or a
     *   repo game file (`payload`) and its app-relative path
     * @returns {Promise<{ json: object, files: { path: string, data: Blob }[] }|null>}
     */
    static async exportGameFolder({ savedId = "", payload = null, basePath = "" }) {
        let name = "";
        let messages = [];
        if (savedId) {
            const workspace = CustomMessagesGame.loadGameWorkspace(savedId);
            if (!workspace.gameId) return null;
            name = workspace.gameName;
            messages = workspace.messages;
            await CustomMessagesGame._loadAudio(messages);
        } else if (payload && typeof payload === "object") {
            name = String(payload.name || "").trim() || "Untitled";
            messages = CustomMessagesGame._deserializeMessageList(payload.messages);
            CustomMessagesGame._rebaseAudio(messages, { basePath });
        } else {
            return null;
        }
        /** @type {{ path: string, data: Blob }[]} */
        const files = [];
        const taken = new Set();
        const addClip = (fileName, fallbackStem, blob) => {
            const ext = CustomMessagesGame._audioExtension(blob.type, fileName);
            const stem =
                String(fileName || "")
                    .replace(/\.[a-z0-9]{2,5}$/i, "")
                    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
                    .trim() || fallbackStem;
            let name = `${stem}.${ext}`;
            for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.${ext}`;
            taken.add(name.toLowerCase());
            files.push({ path: `audio/${name}`, data: blob });
            return `audio/${name}`;
        };
        const out = [];
        for (const msg of messages) {
            const entry = CustomMessagesGame._serializeMessage(msg, { forExport: true });
            delete entry.audioKey;
            delete entry.audioBase64;
            delete entry.audioMime;
            if (msg.kind === "audio") {
                const url = entry.audioUrl;
                if (!url && msg.audioBlob?.size) {
                    entry.audioUrl = addClip(msg.fileName, msg.id, msg.audioBlob);
                } else if (url && CustomMessagesGame._isAppUrl(url)) {
                    try {
                        const res = await fetch(url);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const name = msg.fileName || CustomMessagesGame._fileNameFromUrl(url);
                        entry.audioUrl = addClip(name, msg.id, await res.blob());
                    } catch (err) {
                        console.warn("Game audio fetch for download failed:", url, err);
                        entry.audioUrl = new URL(url, window.location.href).href;
                    }
                }
            }
            out.push(entry);
        }
        return {
            json: { format: CustomMessagesGame.EXPORT_FORMAT, name, messages: out },
            files
        };
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
        this._endPending = false;
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
                  turnNumber: CustomMessagesGame._normalizeTurnNumber(existing.turnNumber),
                  loop: existing.loop,
                  onEnd: CustomMessagesGame._normalizeOnEnd(existing.onEnd),
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
                  audioBlob: existing.audioBlob || null,
                  audioUrl: existing.audioUrl || ""
              }
            : {
                  id: null,
                  kind: null,
                  trigger: "gameLoad",
                  turnNumber: 1,
                  loop: "once",
                  onEnd: "",
                  delaySec: 0,
                  constraints: CustomMessagesGame._normalizeConstraints(null),
                  text: "",
                  fileName: "",
                  sendCamera: false,
                  clearHistory: true,
                  maxWords: CustomMessagesGame.DEFAULT_PROMPT_MAX_WORDS,
                  reasoningEffort: CustomMessagesGame.DEFAULT_REASONING_EFFORT,
                  audioBlob: null,
                  audioUrl: ""
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
        this._stopUntappedAudio();
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
                                      messages: Array.isArray(c.messages) ? c.messages : [],
                                      ...(c.characterId && c.slug
                                          ? { characterId: String(c.characterId), slug: String(c.slug) }
                                          : {}),
                                      ...(c.builtinId ? { builtinId: String(c.builtinId) } : {})
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
        return list
            .map((entry, i) => {
                const msg = CustomMessagesGame._deserializeMessage(entry);
                if (msg && entry.onEnd === undefined) {
                    msg.onEnd = CustomMessagesGame._legacyOnEnd(entry, list[i + 1]);
                }
                return msg;
            })
            .filter(Boolean);
    }

    /**
     * Stored messages reference audio by `audioKey`; backups (`forExport`) embed it as base64.
     * @param {CustomMessage} msg
     * @param {{ forExport?: boolean }} [options]
     */
    static _serializeMessage(msg, { forExport = false } = {}) {
        const constraints = CustomMessagesGame._normalizeConstraints(msg.constraints);
        const out = {
            id: msg.id,
            kind: msg.kind,
            trigger: msg.trigger,
            ...(msg.trigger === "playerTurn"
                ? { turnNumber: CustomMessagesGame._normalizeTurnNumber(msg.turnNumber) }
                : {}),
            loop: msg.loop,
            onEnd: CustomMessagesGame._normalizeOnEnd(msg.onEnd),
            delaySec: CustomMessagesGame._normalizeDelaySec(msg.delaySec),
            constraints,
            text: msg.text || "",
            fileName: msg.fileName || "",
            sendCamera: msg.kind === "prompt" && !!msg.sendCamera,
            clearHistory: msg.kind === "prompt" && msg.clearHistory !== false,
            audioUrl:
                msg.kind === "audio" ? CustomMessagesGame._normalizeAudioUrl(msg.audioUrl) : "",
            audioKey: "",
            audioBase64: null,
            audioMime: ""
        };
        if (msg.kind === "prompt") {
            out.maxWords = CustomMessagesGame._normalizeMaxWords(msg.maxWords);
            out.reasoningEffort = CustomMessagesGame._normalizeReasoningEffort(msg.reasoningEffort);
        }
        const hasBlob =
            !!msg.audioBlob && typeof msg.audioBlob.size === "number" && msg.audioBlob.size > 0;
        if (!forExport && msg.audioKey) {
            // Keep the key even if the clip failed to load, so a later load can still find it.
            out.audioKey = msg.audioKey;
            out.audioMime = msg.audioBlob?.type || msg._audioMime || "audio/webm";
        } else if (hasBlob) {
            // Export, or no IndexedDB: inline base64, filled async by _persistAll.
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
            turnNumber: CustomMessagesGame._normalizeTurnNumber(entry.turnNumber),
            loop,
            onEnd: CustomMessagesGame._normalizeOnEnd(entry.onEnd),
            delaySec: CustomMessagesGame._normalizeDelaySec(entry.delaySec),
            constraints: CustomMessagesGame._normalizeConstraints(entry.constraints),
            text: String(entry.text || ""),
            fileName: String(entry.fileName || ""),
            sendCamera: kind === "prompt" && !!entry.sendCamera,
            clearHistory: kind === "prompt" && entry.clearHistory !== false,
            maxWords: CustomMessagesGame._normalizeMaxWords(entry.maxWords),
            reasoningEffort: CustomMessagesGame._normalizeReasoningEffort(entry.reasoningEffort),
            audioUrl: kind === "audio" ? CustomMessagesGame._normalizeAudioUrl(entry.audioUrl) : "",
            audioKey: String(entry.audioKey || ""),
            audioBlob: null,
            _audioBase64: entry.audioBase64 || null,
            _audioMime: entry.audioMime || ""
        };
        if (CustomMessagesGame._isTurnAttachment(msg)) {
            msg.clearHistory = false;
            msg.sendCamera = false;
            msg.delaySec = 0;
        }
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

    /**
     * Absolute http(s) URLs, or paths relative to the app such as `audio/intro.wav`.
     * @param {unknown} value
     * @returns {string} The trimmed value, or "" when it is not a usable URL.
     */
    static _normalizeAudioUrl(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        try {
            const url = new URL(raw, window.location.href);
            return url.protocol === "http:" || url.protocol === "https:" ? raw : "";
        } catch (_) {
            return "";
        }
    }

    /** @param {string} value @returns {string} */
    static _fileNameFromUrl(value) {
        try {
            const url = new URL(String(value || ""), window.location.href);
            const last = url.pathname.split("/").filter(Boolean).pop();
            return last ? decodeURIComponent(last) : url.hostname;
        } catch (_) {
            return "";
        }
    }

    /** Player turns are counted from 1. @param {unknown} value @returns {number} */
    static _normalizeTurnNumber(value) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 1) return 1;
        return Math.min(n, 999);
    }

    /** @param {unknown} value @returns {number} */
    /** @param {unknown} value @returns {string} a valid On end ("" = wait for a trigger). */
    static _normalizeOnEnd(value) {
        const v = String(value || "").trim();
        if (v === "next" || v === "first") return v;
        return /^(msg|end):./.test(v) ? v : "";
    }

    static _isEnding(onEnd) {
        return String(onEnd || "").startsWith("end:");
    }

    /**
     * On end for saves from before it existed: End game (plus its "Then" choice) ended the game,
     * and a following "After another message" action played after this one.
     * @param {object} entry @param {object|undefined} following
     */
    static _legacyOnEnd(entry, following) {
        if (entry.endGame) {
            const to = String(entry.endGameTo || "");
            return `end:${to === "none" || to === "next" ? to : "home"}`;
        }
        return String(following?.trigger || "") === "playNext" ? "next" : "";
    }

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

    /** e.g. "player turn 3" or "every 3rd player turn". @param {CustomMessage} msg */
    static _playerTurnSummary(msg) {
        const n = CustomMessagesGame._normalizeTurnNumber(msg?.turnNumber);
        if (msg?.loop !== "repeat") return `player turn ${n}`;
        return n === 1 ? "every player turn" : `every ${n} player turns`;
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

    /**
     * Fill `audioBlob` from IndexedDB for messages that reference a stored clip.
     * @param {CustomMessage[]} messages
     */
    static async _loadAudio(messages) {
        await Promise.all(
            (messages || []).map(async (msg) => {
                if (!msg?.audioKey || msg.audioBlob) return;
                try {
                    msg.audioBlob = await CustomAudioStore.get(msg.audioKey);
                    if (!msg.audioBlob) console.warn("Custom audio clip missing:", msg.audioKey);
                } catch (err) {
                    console.warn("Custom audio load failed:", err);
                }
            })
        );
    }

    /**
     * Move clips without an `audioKey` into IndexedDB. Without IndexedDB they fall back to
     * inline base64 in localStorage (quota-limited).
     * @param {CustomMessage[]} messages
     */
    static async _storeAudioInDb(messages) {
        for (const msg of messages || []) {
            if (!msg?.audioBlob || !msg.audioBlob.size || msg.audioKey) continue;
            try {
                const key = CustomAudioStore.newKey();
                await CustomAudioStore.put(key, msg.audioBlob);
                msg.audioKey = key;
                msg._audioBase64 = null;
                continue;
            } catch (err) {
                console.warn("Custom audio IndexedDB save failed; storing inline:", err);
            }
            if (!msg._audioBase64) {
                try {
                    msg._audioBase64 = await CustomMessagesGame._blobToBase64(msg.audioBlob);
                    msg._audioMime = msg.audioBlob.type || "audio/webm";
                } catch (err) {
                    console.warn("Custom message audio encode failed:", err);
                }
            }
        }
    }

    /** Delete IndexedDB clips no saved game references (e.g. left by a failed save). */
    static async sweepOrphanAudio() {
        if (!CustomAudioStore.isAvailable()) return;
        try {
            const stored = await CustomAudioStore.keys();
            const referenced = new Set();
            for (const game of CustomMessagesGame._loadStore().games || []) {
                for (const m of game?.messages || []) {
                    if (m?.audioKey) referenced.add(String(m.audioKey));
                }
            }
            const orphans = stored.filter(
                (key) => !referenced.has(key) && !CustomAudioStore._writtenThisSession.has(key)
            );
            await CustomAudioStore.remove(orphans);
        } catch (err) {
            console.warn("Custom audio sweep failed:", err);
        }
    }

    async _persistAll() {
        await CustomMessagesGame._storeAudioInDb(this.messages);
        CustomMessagesGame._saveMessages(this.messages, this._activeGameId);
    }

    /** Ids of messages some other message's On end plays. @returns {Set<string>} */
    _messagesPlayedByOthers() {
        const ids = new Set();
        this.messages.forEach((msg, i) => {
            if (msg.loop === "repeat" && msg.trigger !== "playerTurn") return;
            const target = this._onEndMessage(msg, CustomMessagesGame._normalizeOnEnd(msg.onEnd), i);
            if (target && target.id !== msg.id) ids.add(target.id);
        });
        return ids;
    }

    /**
     * The message an On end plays, if any.
     * @param {CustomMessage} msg @param {string} onEnd @param {number} [index] msg's position
     */
    _onEndMessage(msg, onEnd, index = this.messages.findIndex((m) => m.id === msg.id)) {
        if (onEnd === "first") return this.messages[0] || null;
        if (onEnd === "next") return index >= 0 ? this.messages[index + 1] || null : null;
        if (onEnd.startsWith("msg:")) {
            return this.messages.find((m) => m.id === onEnd.slice(4)) || null;
        }
        return null;
    }

    /** e.g. "Play next message", "Play “Hello there”", "End game, go to Chat". */
    _onEndLabel(onEnd) {
        const value = CustomMessagesGame._normalizeOnEnd(onEnd);
        const fixed = [...CustomMessagesGame.ON_END_PLAY, ...CustomMessagesGame.ON_END_ENDINGS].find(
            (o) => o.id === value
        );
        if (fixed) return fixed.label;
        if (value.startsWith("msg:")) {
            const target = this.messages.find((m) => m.id === value.slice(4));
            return target ? `Play “${CustomMessagesGame.tileLabel(target)}”` : "Play a deleted message";
        }
        const game = value.slice("end:".length);
        const choice = this._endGameChoices().find((g) => g.id === game);
        return `End game, go to ${choice ? choice.label : game}`;
    }

    /**
     * Games an On end can go to: the edited game's character's own games (`game:<id>`) and the
     * built-in games they play.
     * @returns {{ id: string, label: string }[]}
     */
    _endGameChoices() {
        const Chars = window.PhonebotCharacters;
        const owner = CustomMessagesGame.listGames().find((g) => g.id === this._activeGameId)
            ?.characterId;
        const character = owner && typeof Chars?.get === "function" ? Chars.get(owner) : null;
        if (!character) return [];
        const builtInLabels = new Map(
            (this.robot?.getCharacterGameOptions?.() || []).map((g) => [g.id, g.label])
        );
        return [
            ...Chars.characterGames(character).map((g) => ({
                id: `${Chars.GAME_PREFIX}${g.id}`,
                label: g.name || g.id
            })),
            ...character.builtInGames.map((id) => ({ id, label: builtInLabels.get(id) || id }))
        ];
    }

    static tileLabel(msg) {
        if (!msg) return "Message";
        if (msg.kind === "audio") {
            const name = String(msg.fileName || "").trim();
            if (name) return name;
            return (msg.audioUrl && CustomMessagesGame._fileNameFromUrl(msg.audioUrl)) || "Recording";
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

        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "custom-messages-cancel secondary";
        doneBtn.textContent = "Done";
        doneBtn.addEventListener("click", () => this._finishActionsList());

        actions.appendChild(addBtn);
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

    /** Done / backdrop: edit-only sessions go back to plain Custom (the character editor is underneath). */
    _finishActionsList() {
        this._closeActionsList();
        if (!this._editOnly) return;
        if (typeof this.robot?.restartCustomGame === "function") this.robot.restartCustomGame();
    }

    _closeActionsList() {
        if (this._actionsOverlay?.parentElement) {
            this._actionsOverlay.parentElement.removeChild(this._actionsOverlay);
        }
        this._actionsOverlay = null;
        this._tileListEl = null;
        this._actionsNameInput = null;
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
        const played = this._messagesPlayedByOthers();
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
            const triggerNote =
                msg.trigger === "playerTurn"
                    ? CustomMessagesGame._playerTurnSummary(msg)
                    : msg.trigger;
            const repeats = msg.loop === "repeat" && msg.trigger !== "playerTurn";
            const onEnd = CustomMessagesGame._normalizeOnEnd(msg.onEnd);
            const endNote = repeats
                ? " · repeats"
                : onEnd
                  ? ` · then ${this._onEndLabel(onEnd).toLowerCase()}`
                  : "";
            label.title = `${msg.kind} · ${triggerNote}${delayNote}${cameraNote}${clearNote}${promptNote}${constraintSuffix}${endNote}`;
            tile.appendChild(label);

            const badgeText = !repeats && CustomMessagesGame._isEnding(onEnd)
                ? "Ends game"
                : msg.trigger === "playNext" && !played.has(msg.id)
                  ? "Nothing plays this"
                  : "";
            if (badgeText) {
                const badge = document.createElement("span");
                badge.className = "custom-messages-tile-badge";
                badge.textContent = badgeText;
                tile.appendChild(badge);
            }

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.setAttribute("aria-label", "Edit message");
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.openEditor(msg);
            });

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
        this._editorTurnLabel = null;
        this._editorDelayLabel = null;
        this._editorRepeatHint = null;
        this._editorOnEnd = null;
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
                    draft.audioUrl = "";
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
            this._refreshEditorBody();
        });
        triggerLabel.appendChild(triggerSelect);

        const turnLabel = document.createElement("label");
        turnLabel.className = "custom-messages-turn-label";
        turnLabel.textContent = "On player turn";
        const turnInput = document.createElement("input");
        turnInput.type = "number";
        turnInput.className = "custom-messages-delay custom-messages-turn";
        turnInput.min = "1";
        turnInput.max = "999";
        turnInput.step = "1";
        turnInput.inputMode = "numeric";
        turnInput.value = String(CustomMessagesGame._normalizeTurnNumber(draft.turnNumber));
        turnInput.addEventListener("input", () => {
            draft.turnNumber = CustomMessagesGame._normalizeTurnNumber(turnInput.value);
        });
        turnInput.addEventListener("change", () => {
            draft.turnNumber = CustomMessagesGame._normalizeTurnNumber(turnInput.value);
            turnInput.value = String(draft.turnNumber);
        });
        turnLabel.appendChild(turnInput);

        const repeatLabel = document.createElement("label");
        repeatLabel.className = "custom-messages-camera-label custom-messages-end-game-label";
        const repeatCheck = document.createElement("input");
        repeatCheck.type = "checkbox";
        repeatCheck.className = "custom-messages-loop";
        repeatCheck.checked = draft.loop === "repeat";
        repeatCheck.addEventListener("change", () => {
            draft.loop = repeatCheck.checked ? "repeat" : "once";
            this._syncTriggerOptions();
        });
        repeatLabel.appendChild(repeatCheck);
        repeatLabel.appendChild(document.createTextNode(" Repeat"));
        const repeatHint = document.createElement("p");
        repeatHint.className = "custom-messages-hint muted custom-messages-end-game-hint";

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

        const onEndLabel = document.createElement("label");
        onEndLabel.textContent = "After it ends";
        const onEndSelect = this._buildOnEndSelect(draft);
        onEndSelect.addEventListener("change", () => {
            draft.onEnd = CustomMessagesGame._normalizeOnEnd(onEndSelect.value);
        });
        onEndLabel.appendChild(onEndSelect);
        const onEndHint = document.createElement("p");
        onEndHint.className = "custom-messages-hint muted custom-messages-end-game-hint";
        onEndHint.textContent =
            "Once this finishes playing, or once the reply to a prompt has been spoken.";

        options.appendChild(triggerLabel);
        options.appendChild(turnLabel);
        options.appendChild(delayLabel);
        options.appendChild(constraintsHeading);
        options.appendChild(faceConstraintLabel);
        options.appendChild(repeatLabel);
        options.appendChild(repeatHint);
        options.appendChild(onEndLabel);
        options.appendChild(onEndHint);
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
        this._editorLoop = repeatCheck;
        this._editorDelayInput = delayInput;
        this._editorFaceConstraint = faceConstraintSelect;
        this._editorTurnLabel = turnLabel;
        this._editorDelayLabel = delayLabel;
        this._editorRepeatHint = repeatHint;
        this._editorOnEnd = [onEndLabel, onEndHint];

        this._refreshEditorBody();
    }

    /**
     * On end choices: wait, the next / first message, any other message, or ending the game
     * and going to the home game, no game, the next game or a particular game.
     * @param {object} draft
     */
    _buildOnEndSelect(draft) {
        const select = document.createElement("select");
        select.className = "custom-messages-on-end";
        const add = (parent, value, text) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = text;
            parent.appendChild(opt);
        };
        const group = (label) => {
            const el = document.createElement("optgroup");
            el.label = label;
            select.appendChild(el);
            return el;
        };
        for (const o of CustomMessagesGame.ON_END_PLAY) add(select, o.id, o.label);
        const others = this.messages.filter((m) => m.id !== draft.id);
        if (others.length) {
            const messages = group("Play message");
            this.messages.forEach((m, i) => {
                if (m.id !== draft.id) {
                    add(messages, `msg:${m.id}`, `${i + 1}. ${CustomMessagesGame.tileLabel(m)}`);
                }
            });
        }
        const endings = group("End game");
        for (const o of CustomMessagesGame.ON_END_ENDINGS) add(endings, o.id, o.label);
        for (const g of this._endGameChoices()) add(endings, `end:${g.id}`, `End game, go to ${g.label}`);
        const value = CustomMessagesGame._normalizeOnEnd(draft.onEnd);
        if (value && ![...select.options].some((o) => o.value === value)) {
            add(select, value, `${this._onEndLabel(value)} (missing)`);
        }
        select.value = value;
        return select;
    }

    /** Prompts on the Player turn trigger ride along with the player's message. */
    static _isTurnAttachment(msg) {
        return !!msg && msg.kind === "prompt" && msg.trigger === "playerTurn";
    }

    /**
     * Turn number only applies to Player turn; attached prompts have no delay. On a player turn
     * Repeat means every Nth turn; elsewhere it replays the message, so there is no On end.
     */
    _syncTriggerOptions() {
        const draft = this._draft;
        if (!draft) return;
        const playerTurn = draft.trigger === "playerTurn";
        if (this._editorTurnLabel) this._editorTurnLabel.hidden = !playerTurn;
        if (this._editorDelayLabel) {
            this._editorDelayLabel.hidden = CustomMessagesGame._isTurnAttachment(draft);
        }
        if (this._editorRepeatHint) {
            this._editorRepeatHint.textContent = playerTurn
                ? "Plays every Nth player turn instead of only on turn N."
                : "Keeps playing it until another trigger plays something or Only fire if stops being met.";
        }
        const repeats = draft.loop === "repeat" && !playerTurn;
        for (const el of this._editorOnEnd || []) el.hidden = repeats;
    }

    _hasDraftMedia() {
        const draft = this._draft;
        if (!draft || !draft.kind) return false;
        if (draft.kind === "audio") {
            return (
                !!(draft.audioBlob && draft.audioBlob.size > 0) ||
                !!CustomMessagesGame._normalizeAudioUrl(draft.audioUrl)
            );
        }
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
        this._syncTriggerOptions();
        this._syncEditorOptionsVisibility();
    }

    _renderAudioEditor(body, draft) {
        const status = document.createElement("p");
        const showStatus = () => {
            if (CustomMessagesGame._normalizeAudioUrl(draft.audioUrl)) {
                status.textContent = `Ready: ${draft.fileName || "Audio"} (from URL)`;
                status.className = "custom-messages-status ok";
            } else if (String(draft.audioUrl || "").trim()) {
                status.textContent = "Enter an http(s) URL or a path like audio/clip.wav.";
                status.className = "custom-messages-status error";
            } else if (draft.audioBlob && draft.audioBlob.size) {
                status.textContent = `Ready: ${draft.fileName || "Recording"}`;
                status.className = "custom-messages-status ok";
            } else {
                status.textContent = "Record a clip, upload an audio file, or paste a URL.";
                status.className = "custom-messages-status muted";
            }
        };
        showStatus();

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
            draft.audioUrl = "";
            urlInput.value = "";
            showStatus();
            this._syncPreviewButton();
            this._syncEditorOptionsVisibility();
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        const urlInput = document.createElement("input");
        urlInput.type = "url";
        urlInput.className = "custom-messages-audio-url";
        urlInput.placeholder = "…or paste an audio file URL";
        urlInput.autocomplete = "off";
        urlInput.spellcheck = false;
        urlInput.value = draft.audioUrl || "";
        urlInput.addEventListener("input", () => {
            this._stopPreview();
            const raw = urlInput.value.trim();
            draft.audioUrl = raw;
            if (raw) {
                draft.audioBlob = null;
                draft._audioBase64 = null;
                draft.fileName = CustomMessagesGame._fileNameFromUrl(raw);
            }
            showStatus();
            this._syncPreviewButton();
            this._syncEditorOptionsVisibility();
        });
        this._editorAudioUrlInput = urlInput;

        row.appendChild(recordBtn);
        row.appendChild(playBtn);
        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(urlInput);
        body.appendChild(status);
        this._syncPreviewButton();
    }

    _syncPreviewButton() {
        const btn = this._previewBtn;
        if (!btn) return;
        const blob = this._draft?.audioBlob;
        const url = CustomMessagesGame._normalizeAudioUrl(this._draft?.audioUrl);
        btn.disabled = this._recording || !(url || (blob && blob.size > 0));
        btn.textContent = this._previewAudio ? "Stop" : "Play";
        btn.setAttribute("aria-label", this._previewAudio ? "Stop audio" : "Play audio");
    }

    _togglePreview() {
        if (this._previewAudio) {
            this._stopPreview();
            return;
        }
        if (this._recording) return;
        const remoteUrl = CustomMessagesGame._normalizeAudioUrl(this._draft?.audioUrl);
        const blob = this._draft?.audioBlob;
        if (!remoteUrl && (!blob || !blob.size)) return;
        const objectUrl = remoteUrl ? null : URL.createObjectURL(blob);
        const audio = new Audio(remoteUrl || objectUrl);
        this._previewAudio = audio;
        this._previewUrl = objectUrl;
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
        const attachment = CustomMessagesGame._isTurnAttachment(draft);
        if (draft.fileName && draft.text) {
            status.textContent = `Loaded: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
        } else if (attachment) {
            status.textContent =
                "Added to the player's message on this turn as a hidden instruction, e.g. \"Wrap up the game now.\"";
        } else if (draft.kind === "prompt") {
            status.textContent =
                "Type a prompt or leave empty. Sent to the agent (not TTS). Clears chat history by default.";
        } else {
            status.textContent = "Type text or upload a text file. Spoken with TTS.";
        }

        const input = document.createElement("textarea");
        input.className = "custom-messages-text";
        input.rows = 4;
        input.placeholder = attachment
            ? "Instruction added to the player's message…"
            : draft.kind === "prompt"
              ? "Prompt text for the agent (optional)…"
              : "Text to speak (TTS)…";
        input.value = draft.text || "";
        input.addEventListener("input", () => {
            draft.text = input.value;
            draft.fileName = draft.fileName && /\.txt$/i.test(draft.fileName) ? draft.fileName : "";
            this._syncEditorOptionsVisibility();
        });
        body.appendChild(input);

        if (draft.kind === "prompt" && !attachment) {
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
                    this._draft.fileName = this._draft.audioUrl
                        ? "recording.webm"
                        : this._draft.fileName || "recording.webm";
                    this._draft._audioBase64 = null;
                    this._draft.audioUrl = "";
                    if (this._editorAudioUrlInput) this._editorAudioUrlInput.value = "";
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
        const audioUrl =
            draft.kind === "audio" ? CustomMessagesGame._normalizeAudioUrl(draft.audioUrl) : "";
        const attachment = CustomMessagesGame._isTurnAttachment({ kind: draft.kind, trigger });
        const msg = {
            id: draft.id || CustomMessagesGame._newId(),
            kind: draft.kind,
            trigger,
            turnNumber: CustomMessagesGame._normalizeTurnNumber(draft.turnNumber),
            loop: draft.loop === "repeat" ? "repeat" : "once",
            onEnd: CustomMessagesGame._normalizeOnEnd(draft.onEnd),
            delaySec: attachment ? 0 : CustomMessagesGame._normalizeDelaySec(draft.delaySec),
            constraints: CustomMessagesGame._normalizeConstraints(draft.constraints),
            text: String(draft.text || ""),
            fileName: String(draft.fileName || ""),
            sendCamera: draft.kind === "prompt" && !attachment && !!draft.sendCamera,
            clearHistory: draft.kind === "prompt" && !attachment && draft.clearHistory !== false,
            maxWords: CustomMessagesGame._normalizeMaxWords(draft.maxWords),
            reasoningEffort: CustomMessagesGame._normalizeReasoningEffort(draft.reasoningEffort),
            audioUrl,
            audioKey: "",
            audioBlob: draft.kind === "audio" && !audioUrl ? draft.audioBlob : null,
            _audioBase64: null,
            _audioMime: ""
        };

        const idx = this.messages.findIndex((m) => m.id === msg.id);
        const previous = idx >= 0 ? this.messages[idx] : null;
        if (previous?.audioKey && msg.audioBlob && msg.audioBlob === previous.audioBlob) {
            msg.audioKey = previous.audioKey;
        }
        if (idx >= 0) this.messages[idx] = msg;
        else this.messages.push(msg);

        this._firedOnceIds.delete(msg.id);
        await this._persistAll();
        if (previous?.audioKey && previous.audioKey !== msg.audioKey) {
            CustomAudioStore.remove(previous.audioKey).catch((err) => {
                console.warn("Custom audio delete failed:", err);
            });
        }
        this._renderTiles();
        this._closeEditor();

        if (msg.trigger === "gameLoad" && this._running) {
            void this._playMessage(msg, this._generation);
        }
    }

    async _deleteMessage(id) {
        const want = String(id || "");
        const removed = this.messages.find((m) => m.id === want);
        this.messages = this.messages.filter((m) => m.id !== want);
        for (const m of this.messages) {
            if (m.onEnd === `msg:${want}`) m.onEnd = "";
        }
        this._firedOnceIds.delete(want);
        await this._persistAll();
        if (removed?.audioKey) {
            CustomAudioStore.remove(removed.audioKey).catch((err) => {
                console.warn("Custom audio delete failed:", err);
            });
        }
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

    /**
     * Fires once each time this saved game is started (picked in the Game dropdown), one
     * message (and whatever its On end plays) after another.
     */
    async _runGameLoad(generation) {
        const list = this.messages.filter((m) => m.trigger === "gameLoad");
        for (const msg of list) {
            if (!this._isActive(generation)) return;
            if (this._firedOnceIds.has(msg.id)) continue;
            if (!this._constraintsMet(msg)) continue;
            let epoch = 0;
            const played = await this._playMessage(msg, generation, {
                onPlayed: (e) => {
                    epoch = e;
                    this._firedOnceIds.add(msg.id);
                }
            });
            // Another trigger took over part way through; the rest of Game load gives way to it.
            if (played && epoch !== this._chainEpoch) return;
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
        if (!this._isActive(generation) || this._audioBusy) return;
        if (this._endPending) return;
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
            // Re-arm triggers for the condition we just left.
            for (const msg of this.messages) {
                if (msg.trigger === "faceDetected" && !facePresent) this._firedOnceIds.delete(msg.id);
                if (msg.trigger === "noFaceDetected" && facePresent) this._firedOnceIds.delete(msg.id);
            }
            return;
        }

        if (now - this._faceSince < CustomMessagesGame.FACE_STABLE_MS) return;

        const trigger = facePresent ? "faceDetected" : "noFaceDetected";
        if (this._faceTicksBusy.has(trigger)) return;
        const candidates = this.messages.filter(
            (m) => m.trigger === trigger && !this._firedOnceIds.has(m.id) && this._constraintsMet(m)
        );
        if (!candidates.length) return;

        this._faceTicksBusy.add(trigger);
        try {
            for (const msg of candidates) {
                if (!this._isActive(generation) || this._audioBusy) return;
                if (this._firedOnceIds.has(msg.id)) continue;
                if (!this._constraintsMet(msg)) continue;
                await this._playMessage(msg, generation, {
                    onPlayed: () => this._firedOnceIds.add(msg.id)
                });
            }
        } finally {
            this._faceTicksBusy.delete(trigger);
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
     * Messages whose own speech (the agent's reply) should be allowed to re-trigger
     * speechFinished after the in-flight play completes. Text/audio clips do not — that would
     * self-chain forever (Repeat replays them itself).
     * @param {CustomMessage} msg
     */
    static _speechFinishedMayRetriggerFromOwnSpeech(msg) {
        return msg?.kind === "prompt";
    }

    async _onSpeechTick(generation) {
        if (!this._isActive(generation) || this._endPending) return;
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
            (m) => !this._firedOnceIds.has(m.id) && !this._constraintsMet(m)
        );
        const runnable = candidates.filter(
            (m) => !this._firedOnceIds.has(m.id) && this._constraintsMet(m)
        );

        if (!runnable.length) {
            this._debugLog(
                "Speech finished but nothing runnable",
                candidates.map((m) => ({
                    action: CustomMessagesGame.tileLabel(m),
                    firedOnce: this._firedOnceIds.has(m.id),
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
                if (played) this._firedOnceIds.add(msg.id);
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
                for (const msg of mayRetrigger) this._firedOnceIds.delete(msg.id);
            } else if (!waitingOnConstraints) {
                this._speechFinishedPending = false;
            }
        } finally {
            this._speechTickBusy = false;
        }
    }

    /**
     * Plays a message its trigger fired, then carries on as its Repeat / On end say. Resolves
     * (true if the message played) once all of that is over.
     * @param {CustomMessage} msg
     * @param {number} generation
     * @param {{ turnFollowUp?: boolean, onPlayed?: ((epoch: number) => void)|null }} [options]
     *   turnFollowUp still plays while the game is waiting to end after a player turn.
     *   onPlayed runs as soon as the message itself has played, before whatever follows.
     */
    async _playMessage(msg, generation, { turnFollowUp = false, onPlayed = null } = {}) {
        let epoch = 0;
        const played = await this._playOne(msg, generation, {
            turnFollowUp,
            onStart: () => {
                epoch = ++this._chainEpoch;
            }
        });
        if (!played) return false;
        onPlayed?.(epoch);
        await this._playAfter(msg, generation, epoch);
        return true;
    }

    /** Whether a run of messages carries on: it stops once another trigger plays a message. */
    _runLive(generation, epoch) {
        return this._isActive(generation) && epoch === this._chainEpoch && !this._endPending;
    }

    /**
     * What follows a message that has played. Repeat plays it again until stopped; otherwise its
     * On end plays another message or ends the game. A message that can't play (Only fire if not
     * met) is passed over to its own On end.
     * @param {CustomMessage} msg
     * @param {number} generation
     * @param {number} epoch The run's `_chainEpoch`; it stops when another trigger bumps it.
     */
    async _playAfter(msg, generation, epoch) {
        const live = () => this._runLive(generation, epoch);
        let current = msg;
        let passedOver = 0;
        while (live()) {
            if (current.loop === "repeat" && current.trigger !== "playerTurn") {
                await this._repeat(current, generation, epoch);
                return;
            }
            const onEnd = CustomMessagesGame._normalizeOnEnd(current.onEnd);
            if (CustomMessagesGame._isEnding(onEnd)) {
                this._endGame(generation, onEnd.slice("end:".length));
                return;
            }
            const next = this._onEndMessage(current, onEnd);
            if (!next) return;
            const startedAt = Date.now();
            const played = await this._playOne(next, generation, { stillWanted: live });
            if (!live()) return;
            if (played) {
                passedOver = 0;
                const rest = CustomMessagesGame.MIN_STEP_MS - (Date.now() - startedAt);
                if (rest > 0 && !(await this._sleep(rest, generation))) return;
            } else if (++passedOver > this.messages.length) {
                return;
            }
            current = next;
        }
    }

    /** Repeat: plays the message again and again until another trigger plays something or its Only fire if stops being met. */
    async _repeat(msg, generation, epoch) {
        const live = () => this._runLive(generation, epoch);
        while (await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation)) {
            if (!live() || !this._constraintsMet(msg)) return;
            if (!(await this._playOne(msg, generation, { stillWanted: live }))) return;
        }
    }

    /**
     * Plays one message: its delay, then the audio / text / prompt. Resolves true once it has
     * finished (audio ended, text spoken, a prompt's reply spoken), false if it didn't play.
     * @param {CustomMessage} msg
     * @param {number} generation
     * @param {{ turnFollowUp?: boolean, stillWanted?: (() => boolean)|null, onStart?: (() => void)|null }} [options]
     *   stillWanted is checked again after waiting; onStart runs just before it plays.
     */
    async _playOne(msg, generation, { turnFollowUp = false, stillWanted = null, onStart = null } = {}) {
        const wanted = () =>
            this._isActive(generation) && (!stillWanted || stillWanted()) && this._constraintsMet(msg);
        if (!msg || !wanted()) return false;

        while (this._audioBusy) {
            if (!this._isActive(generation)) return false;
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (this._endPending && !turnFollowUp) return false;
        if (!wanted()) return false;

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
        // Re-check after delay — face / active game may have changed.
        if (!wanted()) return false;

        onStart?.();
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

        // Plays above resolve only once audio / TTS / the prompt's spoken reply has finished.
        return this._isActive(generation);
    }

    // —— Player turns ————————————————————————————————————————————————

    /** Player turn N matches turnNumber N, or every Nth turn when set to repeat. */
    static _turnDue(msg, turn) {
        const n = CustomMessagesGame._normalizeTurnNumber(msg.turnNumber);
        return msg.loop === "repeat" ? turn % n === 0 : turn === n;
    }

    /**
     * Called by the agent as a player message is about to be sent. Counts the turn and returns
     * the text of any Player turn prompts due now (to append to that message), plus `finish`,
     * which the agent calls once the reply has been spoken, or with false if the request failed.
     * @returns {{ text: string, finish: (ok: boolean) => void }}
     */
    beginPlayerTurn() {
        const generation = this._generation;
        if (!this._isActive(generation) || this._endPending) return { text: "", finish: () => {} };
        this._playerTurn += 1;
        const turn = this._playerTurn;
        const due = this.messages.filter(
            (m) =>
                m.trigger === "playerTurn" &&
                CustomMessagesGame._turnDue(m, turn) &&
                !(m.loop === "once" && this._firedOnceIds.has(m.id)) &&
                this._constraintsMet(m)
        );
        const prompts = due.filter((m) => m.kind === "prompt");
        const others = due.filter((m) => m.kind !== "prompt");
        for (const msg of prompts) {
            if (msg.loop === "once") this._firedOnceIds.add(msg.id);
        }
        if (prompts.some((m) => CustomMessagesGame._isEnding(m.onEnd))) this._endPending = true;
        if (due.length) {
            this._chainEpoch += 1;
            this._debugLog("Player turn", turn, due.map((m) => CustomMessagesGame.tileLabel(m)));
        }
        const text = prompts
            .map((m) => String(m.text || "").trim())
            .filter(Boolean)
            .join("\n\n");
        let finished = false;
        return {
            text,
            finish: (ok) => {
                if (finished) return;
                finished = true;
                this._finishPlayerTurn({ turn, generation, prompts, others }, ok);
            }
        };
    }

    /**
     * Plays the turn's audio / text actions, then ends the game if an attached prompt asked to.
     * A failed request un-counts the turn so its actions fire on the next attempt.
     */
    _finishPlayerTurn(pending, ok) {
        if (!this._isActive(pending.generation)) return;
        if (!ok) {
            if (this._playerTurn === pending.turn) this._playerTurn -= 1;
            for (const msg of pending.prompts) this._firedOnceIds.delete(msg.id);
            if (pending.prompts.some((m) => CustomMessagesGame._isEnding(m.onEnd))) {
                this._endPending = false;
            }
            return;
        }
        void this._runTurnFollowUps(pending);
    }

    async _runTurnFollowUps({ generation, prompts, others }) {
        for (const msg of others) {
            if (!this._isActive(generation)) return;
            if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) continue;
            const played = await this._playMessage(msg, generation, { turnFollowUp: true });
            if (played && msg.loop === "once") this._firedOnceIds.add(msg.id);
        }
        if (!this._isActive(generation)) return;
        const ender = prompts.find((m) => CustomMessagesGame._isEnding(m.onEnd));
        if (ender) {
            this._endGame(generation, ender.onEnd.slice("end:".length));
            return;
        }
        // Attached prompts carry on from their On end once the reply has been spoken.
        const chained = prompts.find((m) => CustomMessagesGame._normalizeOnEnd(m.onEnd));
        if (chained) await this._playAfter(chained, generation, this._chainEpoch);
    }

    /**
     * Stop every trigger and hand back to the robot, which moves on to `endTo`.
     * @param {number} generation
     * @param {string} [endTo] "home", "none", "next", or a game (`game:<id>` / built-in id)
     */
    _endGame(generation, endTo = "home") {
        if (!this._isActive(generation)) return;
        this._debugLog("Game ended", { activeGame: this._activeGameName || "(none)", endTo });
        this._running = false;
        this._generation += 1;
        this._endPending = false;
        this._stopFacePoll();
        this._stopSpeechPoll();
        if (typeof this.robot?.onLocalGameEnded === "function") {
            this.robot.onLocalGameEnded("custom_game_finished", String(endTo || "home"));
        }
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
            ["Repeat", msg.loop === "repeat" ? "Yes" : "No"],
            ["After it ends", this._onEndLabel(msg.onEnd)],
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

    async _playAudio(msg, generation) {
        const url = CustomMessagesGame._normalizeAudioUrl(msg.audioUrl);
        if (url) {
            await this._playAudioUrl(msg, url, generation);
            return this._isActive(generation);
        }
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

    /**
     * URL clips are fetched into a Blob so they play through the player's mouth-sync tap.
     * Cross-origin media without CORS plays silent through that tap, so hosts that block the
     * fetch get a plain audio element instead (audible, but the mouth doesn't move).
     * @param {CustomMessage} msg
     * @param {string} url
     * @param {number} generation
     */
    async _playAudioUrl(msg, url, generation) {
        if (msg._urlFetch?.src !== url) {
            let blob = null;
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                blob = await res.blob();
            } catch (err) {
                console.warn("Custom audio URL fetch failed; playing without mouth sync:", err);
            }
            msg._urlFetch = { src: url, blob };
            if (!this._isActive(generation)) return;
        }
        const blob = msg._urlFetch.blob;
        const player = this._getAudioPlayer();
        if (blob && blob.size && player && typeof player.playBlob === "function") {
            try {
                await player.playBlob(blob, CustomMessagesGame.tileLabel(msg));
            } catch (err) {
                console.warn("Custom audio playback failed:", err);
            }
            return;
        }
        await this._playUntappedUrl(url);
    }

    /** @param {string} url @returns {Promise<void>} Resolves when playback ends or is stopped. */
    _playUntappedUrl(url) {
        this._stopUntappedAudio();
        const audio = new Audio(url);
        this._untappedAudio = audio;
        return new Promise((resolve) => {
            const finish = () => {
                if (this._untappedAudio === audio) {
                    this._untappedAudio = null;
                    window.__phonebotTtsSpeaking = false;
                }
                resolve();
            };
            audio.addEventListener("ended", finish);
            audio.addEventListener("error", finish);
            audio.addEventListener("pause", finish);
            audio
                .play()
                .then(() => {
                    if (this._untappedAudio === audio) window.__phonebotTtsSpeaking = true;
                })
                .catch((err) => {
                    console.warn("Custom audio URL playback failed:", err);
                    finish();
                });
        });
    }

    _stopUntappedAudio() {
        const audio = this._untappedAudio;
        if (!audio) return;
        try {
            audio.pause();
        } catch (_) {}
        audio.removeAttribute("src");
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
                // A fresh conversation starts the player-turn count again.
                this._playerTurn = 0;
                for (const m of this.messages) {
                    if (m.trigger === "playerTurn") this._firedOnceIds.delete(m.id);
                }
            }
            const delaySec = CustomMessagesGame._normalizeDelaySec(msg.delaySec);
            // Always show the Simon-style timer for camera prompts (at least 1s), then flicker on capture.
            const cameraCountdownSeconds = sendCamera ? Math.max(1, Math.ceil(delaySec) || 1) : 0;
            await agent.submitPrompt(text, {
                gameAction: true,
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
 * @typedef {object} GamesIndexEntry
 * @property {string} id
 * @property {string} name
 * @property {"js"} type Code games only; JSON games live in character folders.
 * @property {string} path
 * @property {string} className Global class for the game.
 * @property {string} computervisionModel Vision model the game needs ("" = robot default).
 */

/**
 * @typedef {object} CustomMessageConstraints
 * @property {"any"|"present"|"absent"} face
 */

/**
 * @typedef {object} CustomMessage
 * @property {string} id
 * @property {"audio"|"text"|"prompt"} kind
 * @property {string} trigger
 * @property {number} turnNumber Player turn trigger: fire on this turn, or every Nth turn when repeating.
 * @property {"once"|"repeat"} loop "repeat" replays it until another trigger plays something or
 *   its constraints stop being met; on Player turn it means every Nth turn instead.
 * @property {string} onEnd Once it has played (prompts: once the reply is spoken): "" waits for a
 *   trigger; "next" / "first" / "msg:<id>" play that message; "end:home" / "end:none" /
 *   "end:next" / "end:<game id>" end the game and go to the home game, no game, the character's
 *   next game or that game.
 * @property {number} delaySec
 * @property {CustomMessageConstraints} constraints
 * @property {string} text
 * @property {string} fileName
 * @property {boolean} sendCamera
 * @property {boolean} clearHistory
 * @property {number} maxWords Prompt reply word limit; 0 = no limit.
 * @property {"low"|"medium"|"high"} reasoningEffort Sets the talking-head reasoning level when the prompt is sent.
 * @property {string} audioUrl Audio file URL (absolute or app-relative); when set it replaces the stored clip.
 * @property {{ src: string, blob: Blob|null }} [_urlFetch] Cached fetch of `audioUrl` (blob null = fetch blocked).
 * @property {string} audioKey IndexedDB key for the clip ("" when none / stored inline).
 * @property {Blob|null} audioBlob
 * @property {string|null} [_audioBase64]
 * @property {string} [_audioMime]
 */

/**
 * @typedef {object} SavedGameSummary
 * @property {string} id Local store id.
 * @property {string} name
 * @property {string} characterId Owning character ("" for games saved before characters owned games).
 * @property {string} slug The game's folder name inside its character.
 * @property {string} builtinId Copies of the old shared games/index.json JSON games.
 */

window.CustomMessagesGame = CustomMessagesGame;
