class Robot {
    /** Runs characters' games; picked through those games, not the dashboard dropdown. */
    static CUSTOM_MODE = "custom";
    static GAMES_GROUP = "Games";
    static CHARACTER_GROUP = "Character";

    constructor(container, config, options = {}) {
        this.config = typeof config === 'string' ? JSON.parse(config) : config;
        this.container = container;
        this.name = this.config?.name;
        this.actuators = [];
        this.controlInputs = {};
        this.joysticks = [];
        this.actuatorMixes = [];
        this.mixEnabled = false;
        this.mixFrequencyHz = Number.isFinite(this.config?.mixFrequencyHz)
            ? Math.max(1, Math.min(60, this.config.mixFrequencyHz))
            : 30;
        this._mixTimer = null;
        this._mixToggleBtn = null;
        this._mixFreqInput = null;
        this.sensors = [];
        this.processing = [];
        this.agentInterface = null;
        this.objectFilters = [];
        this.targets = [];
        this.pidControllers = [];
        this.transmitter;
        this.mode = null;
        this.deciders = [];
        this.goal="";
        this._goalInputEl = null;
        this._modeSelect = null;
        this._localGame = null;
        /** Run toggle turned off (see pauseActivity). */
        this._paused = false;
        this._resumeWaiters = [];
        this._modeReady = false;
        this._modeActivationGeneration = 0;
        this.dashboardContainer = null;
        this._onModeChange =
            typeof options.onModeChange === "function" ? options.onModeChange : null;
        this._onRequestStart =
            typeof options.onRequestStart === "function" ? options.onRequestStart : null;
        this._onStartFlowAction =
            typeof options.onStartFlowAction === "function" ? options.onStartFlowAction : null;
        this._startFlowShouldSkipStep =
            typeof options.startFlowShouldSkipStep === "function"
                ? options.startFlowShouldSkipStep
                : null;
        this._resolveStartFlowStepText =
            typeof options.resolveStartFlowStepText === "function"
                ? options.resolveStartFlowStepText
                : null;
        this._startFlowOverlay = null;
        this._startFlowStep = 0;
        this._startFlowBusy = false;
        this._startFlowBrowserSwitchWired = false;
        this._charactersPanel = null;
        this._charactersBtn = null;
        /** `id|voice` of the character whose voice was last applied ("" = none). */
        this._appliedCharacterKey = "";
        /** Stored active character id; the event also fires for edits and repo loads. */
        this._activeCharacterId = window.PhonebotCharacters?.activeId?.() || null;
        this._onCharacterChange = () => this._onActiveCharacterChanged();
        this._destroyed = false;
        /** @type {GamesIndexEntry[]} */
        this._gamesIndex = [];
        /** Config modes merged with JS index games once games/index.json loads. */
        this._modesMap = null;
        this._onCustomGamesChange = () => this._populateModeSelect();

        this.stateMachine = null;
        this.strategies = null;
        // PID controllers read targets/sensors and may set control inputs.
        // Mix clock rematches control inputs + processing → actuators at mixFrequencyHz.
        // Modes sparsely override actuator mixes (and later, behaviors).

        // Each page load starts with no game selected.
        if (this._usesGamesIndex()) window.CustomMessagesGame.deactivateGame();
        this._initModeFromConfig(options.initialMode);
        this.buildRobot();
        if (options.dashboardContainer) {
            this.attachDashboard(options.dashboardContainer);
        }
        this.buildGUI();
        if (this._charactersEnabled()) {
            window.addEventListener(this._characterChangeEvent(), this._onCharacterChange);
            this._applyCharacterVoice();
        }
        if (this._usesGamesIndex()) {
            window.addEventListener(window.CustomMessagesGame.GAME_CHANGE_EVENT, this._onCustomGamesChange);
        }
        /** Resolves once games/index.json is merged into the game catalog. */
        this.gamesIndexReady = this._loadGamesIndex();
    }

    destroy() {
        this._destroyed = true;
        window.removeEventListener(this._characterChangeEvent(), this._onCharacterChange);
        if (window.CustomMessagesGame?.GAME_CHANGE_EVENT) {
            window.removeEventListener(window.CustomMessagesGame.GAME_CHANGE_EVENT, this._onCustomGamesChange);
        }
        this._charactersPanel?.close();
        this._charactersPanel = null;
        this._dismissStartFlowOverlay();
        this._stopLocalGame();
        this.teardownJoysticks();
        this.stopMixClock();
        this.teardownStrategies();
        this.teardownSensors();
        this.teardownProcessing();
        this.teardownAgentInterface();
        this.teardownObjectFilters();
        this.teardownPidControllers();
        this.teardownStateMachine();
    }

    step() {
        // get target error, apply feedback control, set control inputs
    }

    buildRobot() {
        (this.config.actuators || []).forEach(config => {
            this.addActuator(config);
        });
        this.buildControlInputs(this.config.controlInputs || this.config.inputs || {});
        this.buildJoysticks(this.config.joysticks || []);
        this.buildSensors(this.config.sensors || []);
        this.buildProcessing(this.config.processing || this.config.aiModels || []);
        this.buildAgentInterface();
        this.buildObjectFilters(this.config.objectFilters || []);
        this.buildPidControllers(this.config.pidControllers || []);
        this.buildStrategies();
        this.buildStateMachine();
        this.buildActuatorMixing();
    }

    buildControlInputs(inputConfig) {
        this.controlInputs = {};
        if (Array.isArray(inputConfig)) {
            for (const cfg of inputConfig) {
                if (!cfg?.name) continue;
                this.controlInputs[cfg.name] = new Input(cfg);
            }
            return;
        }

        for (const [name, cfg] of Object.entries(inputConfig || {})) {
            this.controlInputs[name] = new Input({ name, ...cfg });
        }
    }

    buildJoysticks(joystickConfigs) {
        this.teardownJoysticks();
        for (const cfg of joystickConfigs) {
            try {
                this.joysticks.push(new Joystick(this, cfg));
            } catch (err) {
                console.error("Joystick build failed:", err);
            }
        }
    }

    teardownJoysticks() {
        for (const j of this.joysticks) {
            if (typeof j.destroy === "function") j.destroy();
        }
        this.joysticks = [];
    }

    buildSensors(sensorConfigs) {
        this.teardownSensors();
        for (const item of sensorConfigs) {
            const cfg =
                typeof item === "string"
                    ? { type: item, name: item }
                    : { ...item, type: item.type || "sensor" };
            try {
                if (cfg.type === "camera") {
                    this.sensors.push(new Camera({ ...cfg, robot: this }));
                } else if (cfg.type === "microphone") {
                    const MicClass = window.Microphone;
                    if (typeof MicClass !== "function") {
                        throw new Error("Microphone class is unavailable. Check microphone.js loading.");
                    }
                    this.sensors.push(new MicClass(cfg));
                } else if (cfg.type === "gyro") {
                    this.sensors.push(new Gyro(cfg));
                } else {
                    this.sensors.push(new Sensor(cfg));
                }
            } catch (err) {
                console.error("Sensor build failed:", err);
            }
        }
    }

    teardownSensors() {
        for (const s of this.sensors) {
            if (typeof s.destroy === "function") s.destroy();
        }
        this.sensors = [];
    }

    buildProcessing(processingConfigs) {
        this.teardownProcessing();
        for (const item of processingConfigs || []) {
            const cfg = typeof item === "string" ? { type: item } : { ...item };
            const type = String(cfg.type || "").trim().toLowerCase();
            try {
                let module = null;
                if (type === "groqvision" || type === "groq") {
                    const GroqVisionModelClass = window.GroqVisionAiModel;
                    if (typeof GroqVisionModelClass !== "function") {
                        throw new Error("GroqVisionAiModel class is unavailable. Check aiModelGroqVision.js loading.");
                    }
                    module = new GroqVisionModelClass(this, cfg);
                } else if (type === "computervision") {
                    const VisionClass = window.ComputerVisionAiModel;
                    if (typeof VisionClass !== "function") {
                        throw new Error("ComputerVisionAiModel class is unavailable. Check computerVision.js loading.");
                    }
                    module = new VisionClass(this, cfg);
                } else if (type === "speechtotext" || type === "speachtotext") {
                    const SpeechClass = window.SpeechToTextAiModel;
                    if (typeof SpeechClass !== "function") {
                        throw new Error("SpeechToTextAiModel class is unavailable. Check speechToText.js loading.");
                    }
                    module = new SpeechClass(this, cfg);
                } else if (type === "audioplayer") {
                    const AudioPlayerClass = window.AudioPlayerAiModel;
                    if (typeof AudioPlayerClass !== "function") {
                        throw new Error("AudioPlayerAiModel class is unavailable. Check audioPlayer.js loading.");
                    }
                    module = new AudioPlayerClass(this, cfg);
                } else if (type === "audiomouthfilter") {
                    const MouthFilterClass = window.AudioMouthFilterAiModel;
                    if (typeof MouthFilterClass !== "function") {
                        throw new Error("AudioMouthFilterAiModel class is unavailable. Check audioMouthFilter.js loading.");
                    }
                    module = new MouthFilterClass(this, cfg);
                } else if (type) {
                    console.warn(`Unknown processing type: ${cfg.type}`);
                }
                if (module) {
                    module._startupOn = !!cfg.on;
                    this.processing.push(module);
                }
            } catch (err) {
                console.error("Processing module build failed:", err);
            }
        }
    }

    teardownProcessing() {
        for (const module of this.processing) {
            if (typeof module.destroy === "function") module.destroy();
        }
        this.processing = [];
    }

    buildAgentInterface() {
        this.teardownAgentInterface();
        const cfg = this.config.agentInterface;
        if (!cfg || typeof cfg !== "object") return;
        const AgentClass = window.AgentInterface;
        if (typeof AgentClass !== "function") {
            console.error("AgentInterface class is unavailable. Check agentInterface.js loading.");
            return;
        }
        try {
            this.agentInterface = new AgentClass(this, cfg);
        } catch (err) {
            console.error("Agent interface build failed:", err);
            this.agentInterface = null;
        }
    }

    teardownAgentInterface() {
        if (this.agentInterface && typeof this.agentInterface.destroy === "function") {
            this.agentInterface.destroy();
        }
        this.agentInterface = null;
    }

    buildObjectFilters(filterConfigs) {
        this.teardownObjectFilters();
        for (const item of filterConfigs || []) {
            const cfg = typeof item === "string" ? { name: item } : { ...item };
            try {
                if (typeof window.ObjectFilter !== "function") {
                    throw new Error("ObjectFilter class is unavailable. Check objectFilter.js loading.");
                }
                const objectFilter = new window.ObjectFilter(this, cfg.name, cfg);
                objectFilter._startupOn = !!cfg.on;
                this.objectFilters.push(objectFilter);
            } catch (err) {
                console.error("Object filter build failed:", err);
            }
        }
    }

    teardownObjectFilters() {
        for (const objectFilter of this.objectFilters) {
            if (typeof objectFilter.destroy === "function") objectFilter.destroy();
        }
        this.objectFilters = [];
    }

    buildPidControllers(pidConfigs) {
        this.teardownPidControllers();
        for (const item of pidConfigs || []) {
            const cfg = typeof item === "string" ? { name: item } : { ...item };
            try {
                if (typeof window.PID !== "function") {
                    throw new Error("PID class is unavailable. Check pid.js loading.");
                }
                const pid = new window.PID(this, cfg.name, cfg);
                pid._startupOn = !!cfg.on;
                this.pidControllers.push(pid);
            } catch (err) {
                console.error("PID build failed:", err);
            }
        }
    }

    teardownPidControllers() {
        for (const pid of this.pidControllers) {
            if (typeof pid.destroy === "function") pid.destroy();
        }
        this.pidControllers = [];
    }

    buildStrategies() {
        this.teardownStrategies();
        const Strategies = window.RobotStrategies;
        if (typeof Strategies !== "function") {
            console.error("RobotStrategies class is unavailable. Check strategies.js loading.");
            return;
        }
        if (this.config.strategies === false) {
            this.strategies = null;
            return;
        }
        const raw = this.config.strategies;
        const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        try {
            this.strategies = new Strategies(this, cfg);
        } catch (err) {
            console.error("Strategies build failed:", err);
            this.strategies = null;
        }
    }

    teardownStrategies() {
        if (this.strategies && typeof this.strategies.destroy === "function") {
            this.strategies.destroy();
        }
        this.strategies = null;
    }

    buildStateMachine() {
        this.teardownStateMachine();
        const cfg = this.config.stateMachine;
        if (!Array.isArray(cfg) || !cfg.length) {
            this.stateMachine = null;
            return;
        }
        const SM = window.StateMachine;
        if (typeof SM !== "function") {
            console.error("StateMachine class is unavailable. Check stateMachine.js loading.");
            return;
        }
        try {
            this.stateMachine = new SM(this, cfg);
        } catch (err) {
            console.error("State machine build failed:", err);
            this.stateMachine = null;
        }
    }

    teardownStateMachine() {
        this.stateMachine = null;
    }

    getProcessingByType(type) {
        const key = String(type || "").trim().toLowerCase();
        return this.processing.find((module) => String(module?.type || "").toLowerCase() === key) || null;
    }

    getProcessingByName(name) {
        const key = String(name || "").trim().toLowerCase();
        return this.processing.find((module) => String(module?.name || "").toLowerCase() === key) || null;
    }

    getObjectFilterByName(name) {
        const key = String(name || "").trim().toLowerCase();
        return this.objectFilters.find((t) => String(t?.name || "").toLowerCase() === key) || null;
    }

    getControlInputValues() {
        const values = {};
        for (const [name, input] of Object.entries(this.controlInputs)) {
            values[name] = input.getValue();
        }
        return values;
    }

    applyMixing() {
        if (!this.actuatorMixes.length) return;
        const processing = Object.create(null);
        for (const module of this.processing) {
            if (!module) continue;
            if (module.type) processing[module.type] = module;
            if (module.name && module.name !== module.type) processing[module.name] = module;
        }
        const ctx = { controlInputs: this.getControlInputValues(), robot: this, processing };
        for (const { servo, mix } of this.actuatorMixes) {
            const us = mix(ctx);
            if (Number.isFinite(us)) {
                servo.setMicroseconds(us);
            }
        }
    }

    setMixFrequencyHz(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        this.mixFrequencyHz = Math.max(1, Math.min(60, Math.round(parsed)));
        if (this._mixFreqInput) this._mixFreqInput.value = String(this.mixFrequencyHz);
        if (this.mixEnabled) {
            this.stopMixClock();
            this.startMixClock();
        }
    }

    startMixClock() {
        this.stopMixClock();
        if (!this.actuatorMixes.length) return;
        const intervalMs = Math.max(16, Math.round(1000 / this.mixFrequencyHz));
        this._mixTimer = setInterval(() => this.applyMixing(), intervalMs);
        this.applyMixing();
    }

    stopMixClock() {
        if (this._mixTimer) {
            clearInterval(this._mixTimer);
            this._mixTimer = null;
        }
    }

    setMixEnabled(nextEnabled) {
        this.mixEnabled = !!nextEnabled && this.actuatorMixes.length > 0;
        if (this._mixToggleBtn) {
            this._mixToggleBtn.textContent = this.mixEnabled ? "On" : "Off";
        }
        if (this.mixEnabled) {
            this.startMixClock();
        } else {
            this.stopMixClock();
        }
    }

    _initModeFromConfig(preferredMode) {
        const modes = this._getModesMap();
        if (!modes) {
            this.mode = null;
            return;
        }
        const preferred = String(preferredMode || "").trim();
        if (preferred && modes[preferred] && this._isModeAllowed(preferred)) {
            this.mode = preferred;
            return;
        }
        const want = String(this.config.defaultMode || "").trim();
        if (want && modes[want]) {
            this.mode = want;
            return;
        }
        const first = Object.keys(modes)[0];
        this.mode = first || null;
    }

    /** Config modes plus modes added for JS games in games/index.json. */
    _getModesMap() {
        if (this._modesMap) return this._modesMap;
        const modes = this.config?.modes;
        if (!modes || typeof modes !== "object" || Array.isArray(modes)) return null;
        if (!Object.keys(modes).length) return null;
        return modes;
    }

    /** Robots with a Custom mode list games/index.json code games and characters' games. */
    _usesGamesIndex() {
        return !!this.config?.modes?.custom && typeof window.CustomMessagesGame === "function";
    }

    _loadGamesIndex() {
        if (!this._usesGamesIndex()) return Promise.resolve();
        return window.CustomMessagesGame.loadGamesIndex().then((entries) => {
            if (this._destroyed) return;
            this._gamesIndex = entries;
            this._modesMap = { ...this.config.modes, ...this._indexModes(entries) };
            this._populateModeSelect();
        });
    }

    /** A mode for each JS index game that no config mode already runs. */
    _indexModes(entries) {
        const claimed = new Set();
        for (const [id, cfg] of Object.entries(this.config.modes || {})) {
            claimed.add(id);
            if (cfg?.game) claimed.add(String(cfg.game));
        }
        const extra = {};
        for (const entry of entries) {
            if (entry.type !== "js" || claimed.has(entry.id)) continue;
            extra[entry.id] = { label: entry.name, game: entry.id };
            if (entry.computervisionModel) extra[entry.id].computervisionModel = entry.computervisionModel;
        }
        return extra;
    }

    /** Built-in (code) games: config modes plus JS index games, without the Custom mode itself. */
    _builtInGameCatalog() {
        const modes = this._getModesMap();
        if (!modes) return [];
        return Object.entries(modes)
            .filter(([id]) => id !== Robot.CUSTOM_MODE)
            .map(([id, cfg]) => ({ id, label: String(cfg?.label || id), group: Robot.GAMES_GROUP }));
    }

    /**
     * Every game the dashboard can list: the active character's games (`game:<id>`, run by the
     * Custom engine), then built-in games.
     * @returns {{ id: string, label: string, group: string }[]}
     */
    getGameCatalog() {
        const builtIns = this._builtInGameCatalog();
        const character = this._activeCharacter();
        if (!character || !this._usesGamesIndex()) return builtIns;
        const own = window.PhonebotCharacters.characterGames(character).map((g) => ({
            id: `game:${g.id}`,
            label: g.name,
            group: Robot.CHARACTER_GROUP
        }));
        return [...own, ...builtIns];
    }

    /** Games in the dashboard dropdown: the active character's games plus the default mode. */
    getDashboardGames() {
        const allowed = this._characterModeFilter();
        return this.getGameCatalog().filter((g) => !allowed || allowed.has(g.id));
    }

    /** Built-in games a character can also play: all of them except the default mode. */
    getCharacterGameOptions() {
        const home = String(this.config.defaultMode || "").trim();
        return this._builtInGameCatalog().filter((g) => g.id !== home);
    }

    /**
     * Where the active character goes when `endedId` finishes: their home game, no game, the
     * game after it in the dashboard list (wrapping round to the first), or a particular game.
     * "" = no game (also when there is no character or the target isn't playable).
     * @param {string} endedId
     * @param {string} [endTo] "home", "none", "next", or a game id (`game:<id>` / built-in id)
     */
    _gameEndTarget(endedId, endTo = "home") {
        const character = this._activeCharacter();
        if (!character || endTo === "none") return "";
        const playable = window.PhonebotCharacters.playableIds(character);
        const games = this.getGameCatalog()
            .map((g) => g.id)
            .filter((id) => playable.has(id));
        if (endTo === "next") {
            if (!games.length) return "";
            return games[(games.indexOf(endedId) + 1) % games.length];
        }
        const target = endTo === "home" ? character.homeGame : endTo;
        return games.includes(target) ? target : "";
    }

    /**
     * Play a dropdown entry: a mode id, or one of the active character's games (`game:<id>`),
     * which runs in the Custom engine (repo games are fetched fresh each time).
     * @param {string} gameId
     */
    async selectGame(gameId) {
        const id = String(gameId || "");
        if (!id.startsWith("game:")) return this.setMode(id);
        const Game = window.CustomMessagesGame;
        const character = this._activeCharacter();
        if (typeof Game !== "function" || !character) return false;
        let storeId = "";
        try {
            storeId = await window.PhonebotCharacters.loadGame(
                character.id,
                id.slice("game:".length)
            );
        } catch (err) {
            console.warn("Character game load failed:", err);
            return false;
        }
        if (!storeId || !Game.activateGame(storeId)) return false;
        return this.restartCustomGame();
    }

    /** Open a game's editor (read only for repo games); the game is not made active and no triggers run. */
    editCustomGame(gameId) {
        const Game = window.CustomMessagesGame;
        if (typeof Game !== "function" || !gameId) return false;
        Game.requestEditGame(gameId);
        return this.restartCustomGame();
    }

    /** Enter Custom mode, or restart it so it loads the active (or pending-edit) game. */
    restartCustomGame() {
        if (this.mode !== Robot.CUSTOM_MODE) return this.setMode(Robot.CUSTOM_MODE);
        this._stopLocalGame();
        if (!this.getStartFlowConfig() || !this._startFlowOverlay) {
            this._syncLocalGameForMode();
        }
        return true;
    }

    /** Robot config opts in with `characters: true` (talking head). */
    _charactersEnabled() {
        return !!this.config?.characters && typeof window.PhonebotCharacters === "function";
    }

    _characterChangeEvent() {
        return window.PhonebotCharacters?.CHANGE_EVENT || "phonebot:characterchange";
    }

    _activeCharacter() {
        return this._charactersEnabled() ? window.PhonebotCharacters.activeCharacter() : null;
    }

    /** Game ids the active character plays, plus the default mode; null = show all. */
    _characterModeFilter() {
        const character = this._activeCharacter();
        if (!character) return null;
        const allowed = window.PhonebotCharacters.playableIds(character);
        const home = String(this.config.defaultMode || "").trim();
        if (home) allowed.add(home);
        return allowed;
    }

    /** Custom mode stays reachable for any character; its games are filtered in the dropdown. */
    _isModeAllowed(modeId) {
        if (modeId === Robot.CUSTOM_MODE) return true;
        const allowed = this._characterModeFilter();
        return !allowed || allowed.has(modeId);
    }

    openCharacters() {
        const PanelClass = window.CharactersPanel;
        if (typeof PanelClass !== "function") {
            console.error("CharactersPanel is unavailable. Check characters/characters.js loading.");
            return;
        }
        if (!this._charactersPanel) this._charactersPanel = new PanelClass(this);
        this._charactersPanel.open();
    }

    _syncCharactersButton() {
        if (!this._charactersBtn) return;
        const name = this._activeCharacter()?.name;
        this._charactersBtn.textContent = name ? `Characters (${name})` : "Characters";
    }

    _applyCharacterVoice() {
        const character = this._activeCharacter();
        this.getProcessingByType("audioPlayer")?.setVoiceFx?.(character?.voiceFx || null);
        const voice = String(character?.voice || "").trim();
        const key = character ? `${character.id}|${voice}` : "";
        if (key === this._appliedCharacterKey) return;
        this._appliedCharacterKey = key;
        if (voice && typeof this.agentInterface?.setTtsVoice === "function") {
            this.agentInterface.setTtsVoice(voice);
        }
    }

    _onActiveCharacterChanged() {
        this._populateModeSelect();
        this._syncCharactersButton();
        this._applyCharacterVoice();
        const activeId = window.PhonebotCharacters.activeId() || null;
        if (activeId !== this._activeCharacterId) {
            this._activeCharacterId = activeId;
            this.showNoGame();
            return;
        }
        if (this.mode && !this._isModeAllowed(this.mode)) {
            const home =
                String(this.config.defaultMode || "").trim() || this.getDashboardGames()[0]?.id;
            if (home) void this.setMode(home);
        }
    }

    /** Dropdown entry for what's playing: the mode, or the active game in Custom mode. */
    dashboardGameId() {
        if (this.mode !== "custom") return String(this.mode || "");
        const active = window.CustomMessagesGame?.activeGame?.();
        const character = this._activeCharacter();
        return active && character && active.characterId === character.id ? `game:${active.slug}` : "";
    }

    _syncModeSelectValue() {
        const select = this._modeSelect;
        if (!select) return;
        const want = this.dashboardGameId();
        if (want && [...select.options].some((o) => o.value === want)) {
            select.value = want;
        } else {
            select.selectedIndex = -1;
        }
    }

    _getActiveModeConfig() {
        const modes = this._getModesMap();
        if (!modes || !this.mode) return null;
        return modes[this.mode] || null;
    }

    _lookupModeActuatorPatch(modeConfig, actuatorName) {
        const acts = modeConfig?.actuators;
        if (!acts || typeof acts !== "object") return null;
        const name = String(actuatorName || "").trim();
        if (!name) return null;
        if (acts[name] && typeof acts[name] === "object") return acts[name];
        const lower = name.toLowerCase();
        for (const [key, patch] of Object.entries(acts)) {
            if (String(key).trim().toLowerCase() === lower && patch && typeof patch === "object") {
                return patch;
            }
        }
        return null;
    }

    /**
     * Resolve mix functions: base actuator config, then active mode patch by actuator name.
     */
    _resolveActuatorMixes() {
        const mixes = [];
        const modeConfig = this._getActiveModeConfig();
        const actuatorConfigs = this.config.actuators || [];
        for (let i = 0; i < actuatorConfigs.length; i++) {
            const cfg = actuatorConfigs[i];
            const servo = this.actuators[i];
            if (!servo) continue;
            const patch = this._lookupModeActuatorPatch(modeConfig, cfg?.name || servo.name);
            const mix = typeof patch?.mix === "function" ? patch.mix : cfg?.mix;
            if (typeof mix === "function") {
                mixes.push({ servo, mix });
            }
        }
        return mixes;
    }

    /**
     * Switch robot mode (sparse config overrides). Rebuilds actuator mixes; preserves mix on/off.
     * Modes may set `promptTemplate` (path or template name) to load into the agent UI.
     * @param {string} id
     * @returns {boolean}
     */
    async setMode(id) {
        const modes = this._getModesMap();
        if (!modes) return false;
        const want = String(id || "").trim();
        if (!want || !modes[want]) return false;
        if (this.mode === want) {
            this._syncModeSelectValue();
            if (!this._modeReady) return this._activateCurrentMode();
            return true;
        }
        ++this._modeActivationGeneration;
        this._modeReady = false;
        this._stopLocalGame();
        if (this.agentInterface && typeof this.agentInterface._stopSpeaking === "function") {
            this.agentInterface._stopSpeaking();
        }
        this.mode = want;
        this._syncModeSelectValue();
        if (typeof this._onModeChange === "function") {
            try {
                this._onModeChange(this.mode);
            } catch (err) {
                console.error("onModeChange failed:", err);
            }
        }
        const wasEnabled = this.mixEnabled;
        this._rebuildActuatorMixes({ restoreEnabled: wasEnabled });
        this._modeReady = true;
        this._applyModeBehavior();
        return true;
    }

    _robotSlug() {
        return String(this.name || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    async _activateCurrentMode() {
        const generation = ++this._modeActivationGeneration;
        this._modeReady = false;
        if (this.agentInterface && typeof this.agentInterface.ensureSessionGroqModels === "function") {
            await this.agentInterface.ensureSessionGroqModels();
        }
        if (generation !== this._modeActivationGeneration) return false;
        this._modeReady = true;
        this._applyModeBehavior();
        return true;
    }

    _applyModeBehavior() {
        this._applyActiveModePromptTemplate();
        this._syncComputerVisionForMode();
        if (this.agentInterface && typeof this.agentInterface.onRobotModeChanged === "function") {
            this.agentInterface.onRobotModeChanged(this.mode);
        }
        if (!this.getStartFlowConfig() || !this._startFlowOverlay) {
            this._syncLocalGameForMode();
        }
    }

    /**
     * Per-mode vision model (e.g. talking head: BlazeFace by default, MoveNet for Simon Says Basic).
     */
    _syncComputerVisionForMode() {
        const cv =
            typeof this.getProcessingByType === "function"
                ? this.getProcessingByType("computervision")
                : null;
        if (!cv || typeof cv.setModel !== "function") return;

        const modeConfig = this._getActiveModeConfig();
        const fromMode = modeConfig?.computervisionModel;
        if (fromMode != null && String(fromMode).trim()) {
            void cv.setModel(fromMode);
            return;
        }

        const procList = Array.isArray(this.config?.processing) ? this.config.processing : [];
        const procCfg = procList.find(
            (p) => String(p?.type || "").trim().toLowerCase() === "computervision"
        );
        if (procCfg?.model != null && String(procCfg.model).trim()) {
            void cv.setModel(procCfg.model);
        }
    }

    /** If the active mode declares `promptTemplate`, select and insert it in the agent UI. */
    _applyActiveModePromptTemplate() {
        const modeConfig = this._getActiveModeConfig();
        const spec = modeConfig?.promptTemplate;
        if (spec == null || spec === "") return;
        const agent = this.agentInterface;
        if (agent && typeof agent.applyPromptTemplate === "function") {
            void agent.applyPromptTemplate(spec);
        }
    }

    /**
     * Run toggle off: hold playing audio where it is; game triggers, timers, and agent replies
     * wait on whenResumed() until resumeActivity().
     */
    pauseActivity() {
        if (this._paused) return;
        this._paused = true;
        this.getProcessingByType("audioPlayer")?.pauseForRobot?.();
        this._localGame?.pauseAudio?.();
        try {
            window.speechSynthesis?.pause();
        } catch (_) {}
    }

    resumeActivity() {
        if (!this._paused) return;
        this._paused = false;
        try {
            window.speechSynthesis?.resume();
        } catch (_) {}
        this.getProcessingByType("audioPlayer")?.resumeForRobot?.();
        this._localGame?.resumeAudio?.();
        const waiters = this._resumeWaiters.splice(0);
        for (const resolve of waiters) resolve();
    }

    isPaused() {
        return this._paused;
    }

    /** Resolves now when running, else once the run toggle is turned back on. */
    whenResumed() {
        if (!this._paused) return Promise.resolve();
        return new Promise((resolve) => this._resumeWaiters.push(resolve));
    }

    _stopLocalGame() {
        if (this._localGame && typeof this._localGame.stop === "function") {
            try {
                this._localGame.stop();
            } catch (err) {
                console.warn("Local game stop failed:", err);
            }
        }
        this._localGame = null;
    }

    /**
     * Start/stop local (non-LLM) games declared on the active mode via `game`.
     */
    _syncLocalGameForMode() {
        this._stopLocalGame();
        if (!this._modeReady) return;
        const gameId = String(this._getActiveModeConfig()?.game || "").trim();
        if (!gameId) return;
        if (gameId === "simonSaysPoseMatch") {
            const GameClass = window.SimonSaysPoseMatch;
            if (typeof GameClass !== "function") {
                console.error("SimonSaysPoseMatch is unavailable. Check games/simonSays.js loading.");
                return;
            }
            this._localGame = new GameClass(this);
            this._localGame.start();
            return;
        }
        if (gameId === "parrot") {
            const GameClass = window.ParrotGame;
            if (typeof GameClass !== "function") {
                console.error("ParrotGame is unavailable. Check games/parrot/parrot.js loading.");
                return;
            }
            this._localGame = new GameClass(this);
            this._localGame.start();
            return;
        }
        if (gameId === "customMessages") {
            const GameClass = window.CustomMessagesGame;
            if (typeof GameClass !== "function") {
                console.error("CustomMessagesGame is unavailable. Check games/custom/customMessages.js loading.");
                return;
            }
            this._localGame = new GameClass(this);
            this._localGame.start();
            return;
        }
        const entry = this._gamesIndex.find((e) => e.type === "js" && e.id === gameId);
        if (entry) void this._startIndexJsGame(entry);
    }

    /** Run a JS game from games/index.json, loading its script first if needed. */
    async _startIndexJsGame(entry) {
        const generation = this._modeActivationGeneration;
        const mode = this.mode;
        if (typeof window[entry.className] !== "function") {
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src = entry.path;
                    script.onload = resolve;
                    script.onerror = () => reject(new Error(`Failed to load ${entry.path}`));
                    document.body.appendChild(script);
                });
            } catch (err) {
                console.error("Game script load failed:", err);
                return;
            }
        }
        const GameClass = window[entry.className];
        if (typeof GameClass !== "function") {
            console.error(`${entry.className} is unavailable. Check ${entry.path} loading.`);
            return;
        }
        const stillWanted =
            generation === this._modeActivationGeneration &&
            this.mode === mode &&
            this._modeReady &&
            !this._localGame;
        if (!stillWanted) return;
        this._localGame = new GameClass(this);
        this._localGame.start();
    }

    /**
     * @param {string} [_reason]
     * @param {string} [endTo] Character games' On end choice (see _gameEndTarget); code games go home.
     */
    onLocalGameEnded(_reason, endTo = "home") {
        const target = this._gameEndTarget(this.dashboardGameId(), endTo);
        const runsInCustom = target.startsWith("game:");
        // Character games restart in place, which needs a ready mode; setMode only restarts
        // the current mode (e.g. Simon Says again) when it is not ready.
        if (!runsInCustom) this._modeReady = false;
        if (String(this.name || "").toLowerCase() !== "talking head") return;
        if (!target) {
            this.showNoGame();
            return;
        }
        void this.selectGame(target).then((ok) => {
            if (!ok) this.showNoGame();
        });
    }

    /** Default mode with no game selected; Custom with no active game is the plain chat. */
    showNoGame() {
        window.CustomMessagesGame?.deactivateGame?.();
        const home = String(this.config.defaultMode || "").trim();
        if (!home) return;
        if (this.mode === home) {
            this._stopLocalGame();
            this._modeReady = false;
        }
        void this.setMode(home);
    }

    _rebuildActuatorMixes({ restoreEnabled = null, startFromConfig = false } = {}) {
        this.stopMixClock();
        this.mixEnabled = false;
        this.actuatorMixes = this._resolveActuatorMixes();
        if (!this.actuatorMixes.length) {
            if (this._mixToggleBtn) this._mixToggleBtn.textContent = "Off";
            return;
        }
        if (startFromConfig) {
            const startOn = this.config.mixOn !== false;
            if (startOn) this.setMixEnabled(true);
            else this.applyMixing();
            return;
        }
        if (restoreEnabled) {
            this.setMixEnabled(true);
        } else {
            this.applyMixing();
            if (this._mixToggleBtn) this._mixToggleBtn.textContent = "Off";
        }
    }

    buildActuatorMixing() {
        this._rebuildActuatorMixes({ startFromConfig: true });
    }

    setControlInput(name, value) {
        const input = this.controlInputs[name];
        if (!input) return false;
        input.setValue(value);
        return true;
    }

    setGoal(goal) {
        this.goal = String(goal == null ? "" : goal);
        if (this._goalInputEl && this._goalInputEl.value !== this.goal) {
            this._goalInputEl.value = this.goal;
        }
    }

    _resolveNamedCollectionItem(list, segment) {
        const key = String(segment || "").trim();
        if (!key || !Array.isArray(list)) return undefined;
        if (/^\d+$/.test(key)) {
            const idx = parseInt(key, 10);
            return idx >= 0 && idx < list.length ? list[idx] : undefined;
        }
        const lower = key.toLowerCase();
        return (
            list.find(
                (item) =>
                    String(item?.type || "")
                        .trim()
                        .toLowerCase() === lower ||
                    String(item?.name || "")
                        .trim()
                        .toLowerCase() === lower
            ) || undefined
        );
    }

    _readStatePath(path) {
        const segments = String(path || "")
            .split(".")
            .map((segment) => segment.trim())
            .filter(Boolean);
        if (!segments.length) return undefined;
        let current = this;
        for (const segment of segments) {
            if (current == null) return undefined;
            if (current === this && segment === "aiModels") {
                current = this.processing;
                continue;
            }
            if (Array.isArray(current)) {
                current = this._resolveNamedCollectionItem(current, segment);
            } else {
                current = current[segment];
            }
        }
        if (typeof current === "function") return undefined;
        return current;
    }

    /** Resolve a dot path on the robot (e.g. objectFilters.mainObjectFilter.filters). */
    readStatePath(path) {
        return this._readStatePath(path);
    }

    addActuator(config) {
        switch (config.type) {
            case "servo":
                this.actuators.push(new Servo(config));
                break;
            default:
                throw new Error(`Unknown actuator type: ${config.type}`);
        }
    }

    buildActionsMessage() {
        const parts = [];
        for (const actuator of this.actuators) {
            if (actuator.type === "servo") {
                parts.push(`${actuator.pin}:${Math.round(actuator.getMicroseconds())}`);
            }
        }
        return parts.join(",");
    }

    buildPinSetupMessage() {
        const parts = [];
        for (const actuator of this.actuators) {
            if (actuator.type === "servo") {
                const minUs = Math.round(actuator.getMinMicroseconds());
                const maxUs = Math.round(actuator.getMaxMicroseconds());
                const homeUs = Math.round(actuator.getHomeMicroseconds());
                parts.push(`${actuator.pin}:servo:${minUs}:${maxUs}:${homeUs}`);
            }
        }
        return parts.join(",");
    }

    /**
     * For Run Controls stop: briefly disable PIDs, drive control inputs + mixing to neutral/home,
     * then caller should transmit `message` and call `restorePids()`.
     * @returns {{ message: string, restorePids: () => void }}
     */
    syncActuatorsToHomeForTransmit() {
        const pidSnapshots = Array.isArray(this.pidControllers)
            ? this.pidControllers.map((p) => !!(p && p.enabled))
            : [];
        for (const p of this.pidControllers || []) {
            if (p && typeof p.setEnabled === "function") p.setEnabled(false);
        }
        for (const j of this.joysticks || []) {
            if (j && typeof j.home === "function") j.home();
        }
        for (const input of Object.values(this.controlInputs || {})) {
            if (input && typeof input.setValue === "function") input.setValue(input.home);
        }
        if (this.actuatorMixes && this.actuatorMixes.length) {
            this.applyMixing();
        } else {
            for (const a of this.actuators || []) {
                if (a?.type === "servo" && typeof a.setMicroseconds === "function" && typeof a.getHomeMicroseconds === "function") {
                    a.setMicroseconds(a.getHomeMicroseconds());
                }
            }
        }
        const message = this.buildActionsMessage();
        const restorePids = () => {
            const list = this.pidControllers || [];
            for (let i = 0; i < list.length; i++) {
                const p = list[i];
                if (pidSnapshots[i] && p && typeof p.setEnabled === "function") {
                    p.setEnabled(true);
                }
            }
        };
        return { message, restorePids };
    }

    _toTitleCase(input) {
        return String(input || "")
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\b\w/g, (m) => m.toUpperCase());
    }

    _derivePanelTitle(node, fallbackTitle) {
        if (!node) return { title: fallbackTitle, sourceEl: null };
        const heading = node.querySelector(":scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > legend");
        if (heading && heading.textContent) {
            const text = heading.textContent.trim();
            if (text) return { title: text, sourceEl: heading };
        }
        const label = node.querySelector(":scope > label");
        if (label && label.textContent) {
            const text = label.textContent.trim();
            if (text) return { title: text, sourceEl: label };
        }
        return { title: fallbackTitle, sourceEl: null };
    }

    _wrapCollapsible(node, title, sourceEl = null) {
        if (!node || !node.parentNode) return;
        if (node.parentNode.tagName === "DETAILS") return;
        const details = document.createElement("details");
        details.className = "cursor-collapsible-panel";
        details.open = false;
        const summary = document.createElement("summary");
        summary.textContent = title;
        details.appendChild(summary);
        node.parentNode.insertBefore(details, node);
        details.appendChild(node);
        if (sourceEl && sourceEl.parentNode === node) {
            sourceEl.parentNode.removeChild(sourceEl);
        }
    }

    /** Turn on modules marked `on: true` in robot config after GUI exists (toggle labels sync). */
    _applyStartupModuleEnabled() {
        const run = async () => {
            for (const m of this.processing) {
                if (!m._startupOn || typeof m.setEnabled !== "function") continue;
                try {
                    await Promise.resolve(m.setEnabled(true));
                } catch (err) {
                    console.error("Startup enable failed (processing):", err);
                }
            }
            for (const f of this.objectFilters) {
                if (!f._startupOn || typeof f.setEnabled !== "function") continue;
                try {
                    f.setEnabled(true);
                } catch (err) {
                    console.error("Startup enable failed (object filter):", err);
                }
            }
            for (const p of this.pidControllers) {
                if (!p._startupOn || typeof p.setEnabled !== "function") continue;
                try {
                    p.setEnabled(true);
                } catch (err) {
                    console.error("Startup enable failed (PID):", err);
                }
            }
        };
        void run();
    }

    _makePanelsCollapsible() {
        const majorPanels = [
            { selector: ".robot-goal", fallback: "goal" },
            { selector: ".robot-sensors", fallback: "sensors" },
            { selector: ".robot-processing", fallback: "processing" },
            { selector: ".robot-agent-interfaces", fallback: "agentInterface" },
            { selector: ".robot-object-filters", fallback: "objectFilters" },
            { selector: ".robot-pid", fallback: "pidControllers" },
            { selector: ".robot-strategies", fallback: "strategies" },
            { selector: ".robot-inputs", fallback: "controlInputs" },
            { selector: ".robot-actuators", fallback: "actuators" }
        ];
        for (const panel of majorPanels) {
            const node = this.container.querySelector(panel.selector);
            if (!node) continue;
            const derived = this._derivePanelTitle(node, panel.fallback);
            this._wrapCollapsible(node, derived.title, derived.sourceEl);
        }

        const subPanels = Array.from(this.container.querySelectorAll(".ai-model, .joystick-wrap"));
        for (const node of subPanels) {
            const fallbackClass = String(node.className || "").split(" ")[0] || "Panel";
            const derived = this._derivePanelTitle(node, this._toTitleCase(fallbackClass));
            this._wrapCollapsible(node, derived.title, derived.sourceEl);
        }
    }

    getDashboardKind() {
        const raw = this.config?.dashboard;
        if (raw != null && String(raw).trim()) return String(raw).trim();
        if (String(this.name || "").toLowerCase() === "talking head") return "talkingHead";
        return "default";
    }

    attachDashboard(container) {
        this.dashboardContainer = container || null;
        if (!container) return;
        this.buildDashboard(container);
    }

    buildDashboard(container) {
        if (!container) return;
        container.innerHTML = "";
        const kind = this.getDashboardKind();
        if (kind === "talkingHead") {
            this._buildTalkingHeadDashboard(container);
            return;
        }
        this._buildDefaultDashboard(container);
    }

    _buildTalkingHeadDashboard(container) {
        const root = document.createElement("div");
        root.className = "robot-dashboard robot-dashboard--talking-head";

        this.buildModesGUI(root);

        const camHost = document.createElement("div");
        camHost.className = "robot-dashboard-camera";
        root.appendChild(camHost);

        const chatHost = document.createElement("div");
        chatHost.className = "robot-dashboard-chat-host";
        root.appendChild(chatHost);

        container.appendChild(root);

        const camera =
            this.sensors.find((s) => String(s?.type || "").toLowerCase() === "camera") || null;
        if (camera && typeof camera.buildDashboardPreview === "function") {
            camera.buildDashboardPreview(camHost);
        } else {
            const missing = document.createElement("p");
            missing.className = "muted";
            missing.textContent = "No camera configured for this robot.";
            camHost.appendChild(missing);
        }

        if (this.agentInterface && typeof this.agentInterface.buildDashboardChat === "function") {
            this.agentInterface.buildDashboardChat(chatHost);
        }

        this._mountStartFlowOverlay(camHost);
    }

    getStartFlowConfig() {
        const flow = this.config?.startFlow;
        if (!flow || typeof flow !== "object" || Array.isArray(flow)) return null;
        const steps = Array.isArray(flow.steps) ? flow.steps.filter(Boolean) : [];
        if (!steps.length) return null;
        return {
            autoStart: flow.autoStart !== false,
            steps
        };
    }

    _mountStartFlowOverlay(host) {
        if (!host) return;
        const flow = this.getStartFlowConfig();
        if (!flow) return;

        this._dismissStartFlowOverlay();
        this._startFlowStep = 0;
        this._startFlowBusy = false;

        const overlay = document.createElement("div");
        overlay.className = "robot-start-flow";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Robot start setup");

        const card = document.createElement("div");
        card.className = "robot-start-flow-card";
        const textEl = document.createElement("p");
        textEl.className = "robot-start-flow-text";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "robot-start-flow-btn";
        btn.addEventListener("click", () => {
            void this._advanceStartFlow();
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "robot-start-flow-btn robot-start-flow-btn--cancel";
        cancelBtn.hidden = true;
        cancelBtn.addEventListener("click", () => {
            void this._skipStartFlowStep();
        });

        card.appendChild(textEl);
        card.appendChild(btn);
        card.appendChild(cancelBtn);
        overlay.appendChild(card);
        host.appendChild(overlay);

        this._startFlowOverlay = overlay;
        this._startFlowTextEl = textEl;
        this._startFlowBtn = btn;
        this._startFlowCancelBtn = cancelBtn;
        this._moveToNextApplicableStartFlowStep(0);
        this._renderStartFlowStep();
    }

    _shouldSkipStartFlowStep(step) {
        if (!step || typeof step !== "object") return true;
        if (typeof this._startFlowShouldSkipStep === "function") {
            try {
                return !!this._startFlowShouldSkipStep(step);
            } catch (err) {
                console.warn("startFlowShouldSkipStep failed:", err);
            }
        }
        return false;
    }

    /** Find the next step index >= fromIndex that should be shown, or steps.length if done. */
    _moveToNextApplicableStartFlowStep(fromIndex) {
        const flow = this.getStartFlowConfig();
        if (!flow) {
            this._startFlowStep = 0;
            return;
        }
        let i = Math.max(0, fromIndex | 0);
        while (i < flow.steps.length && this._shouldSkipStartFlowStep(flow.steps[i])) {
            i += 1;
        }
        this._startFlowStep = i;
    }

    _renderStartFlowStep() {
        const flow = this.getStartFlowConfig();
        if (!flow || !this._startFlowOverlay) return;
        if (this._startFlowStep >= flow.steps.length) {
            void this._finishStartFlow();
            return;
        }
        const step = flow.steps[this._startFlowStep];
        if (!step || this._shouldSkipStartFlowStep(step)) {
            this._moveToNextApplicableStartFlowStep(this._startFlowStep + 1);
            this._renderStartFlowStep();
            return;
        }
        let text = String(step.text || step.message || "").trim() || "Continue";
        if (typeof this._resolveStartFlowStepText === "function") {
            try {
                const resolved = this._resolveStartFlowStepText(step);
                if (resolved != null && String(resolved).trim()) {
                    text = String(resolved).trim();
                }
            } catch (err) {
                console.warn("resolveStartFlowStepText failed:", err);
            }
        }
        const label = String(step.button || step.buttonLabel || "Done").trim() || "Done";
        if (this._startFlowTextEl) {
            this._startFlowTextEl.textContent = text;
            this._startFlowTextEl.classList.remove("robot-start-flow-text--browser-switch");
        }
        if (this._startFlowBtn) {
            this._startFlowBtn.textContent = label;
            this._startFlowBtn.disabled = false;
            this._startFlowBtn.hidden = false;
        }
        const cancelLabel = String(step.cancelButton || "").trim();
        if (this._startFlowCancelBtn) {
            if (cancelLabel) {
                this._startFlowCancelBtn.textContent = cancelLabel;
                this._startFlowCancelBtn.hidden = false;
                this._startFlowCancelBtn.disabled = false;
            } else {
                this._startFlowCancelBtn.hidden = true;
            }
        }
        this._startFlowOverlay.hidden = false;

        if (String(step.action || "").trim() === "bluetoothPair") {
            const secure = typeof window !== "undefined" && window.isSecureContext;
            if (!navigator.bluetooth || !secure) {
                this.showStartFlowBrowserSwitch(
                    !secure
                        ? "Web Bluetooth requires a secure context (HTTPS or localhost)."
                        : "Web Bluetooth is not available in this browser."
                );
            }
        }
    }

    /**
     * Same Chrome/Bluefy handoff UI as the WiFi/Bluetooth transmitter when the
     * current browser cannot pair.
     */
    showStartFlowBrowserSwitch(message) {
        if (!this._startFlowTextEl) return;
        const msg =
            String(message || "").trim() ||
            "Web Bluetooth is not available in this browser.";
        const html =
            typeof browserRefusedSwitchHtml === "function"
                ? browserRefusedSwitchHtml(msg)
                : "<span class='error'>" + msg + "</span>";
        this._startFlowTextEl.innerHTML = html;
        this._startFlowTextEl.classList.add("robot-start-flow-text--browser-switch");
        if (this._startFlowBtn) this._startFlowBtn.hidden = true;
        if (this._startFlowCancelBtn) {
            this._startFlowCancelBtn.hidden = false;
            this._startFlowCancelBtn.disabled = false;
            if (!String(this._startFlowCancelBtn.textContent || "").trim()) {
                this._startFlowCancelBtn.textContent = "Cancel";
            }
        }
        this._wireStartFlowBrowserSwitchClicks();
    }

    _wireStartFlowBrowserSwitchClicks() {
        if (!this._startFlowOverlay || this._startFlowBrowserSwitchWired) return;
        this._startFlowBrowserSwitchWired = true;
        this._startFlowOverlay.addEventListener("click", (e) => {
            const t = e.target;
            const el = t && (t instanceof Element ? t : t.parentElement);
            if (!el) return;
            if (el.closest('[data-action="open-in-chrome"]')) {
                e.preventDefault();
                if (typeof openCurrentPageInChrome === "function") openCurrentPageInChrome();
                return;
            }
            if (el.closest('[data-action="open-in-bluefy"]')) {
                e.preventDefault();
                if (typeof openCurrentPageInBluefy === "function") openCurrentPageInBluefy();
                return;
            }
            if (el.closest('[data-action="open-browser-install"]')) {
                e.preventDefault();
                if (typeof openBrowserInstallStore === "function") openBrowserInstallStore();
            }
        });
    }

    async _skipStartFlowStep() {
        const flow = this.getStartFlowConfig();
        if (!flow) return;
        // Allow Cancel even while a probe is in progress (e.g. hung network check).
        this._startFlowBusy = false;
        this._moveToNextApplicableStartFlowStep(this._startFlowStep + 1);
        if (this._startFlowStep >= flow.steps.length) {
            await this._finishStartFlow();
            return;
        }
        this._renderStartFlowStep();
    }

    setStartFlowFeedback(message) {
        const text = String(message || "").trim();
        if (!text || !this._startFlowTextEl) return;
        this._startFlowTextEl.textContent = text;
        this._startFlowTextEl.classList.remove("robot-start-flow-text--browser-switch");
    }

    async _advanceStartFlow() {
        const flow = this.getStartFlowConfig();
        if (!flow || this._startFlowBusy) return;
        const step = flow.steps[this._startFlowStep];
        if (!step) {
            await this._finishStartFlow();
            return;
        }

        const action = String(step.action || "").trim();
        if (action && typeof this._onStartFlowAction === "function") {
            this._startFlowBusy = true;
            if (this._startFlowBtn) {
                this._startFlowBtn.disabled = true;
                const busyLabel = String(step.busyButton || step.busyLabel || "").trim();
                if (busyLabel) this._startFlowBtn.textContent = busyLabel;
            }
            if (this._startFlowCancelBtn) this._startFlowCancelBtn.disabled = true;
            let ok = true;
            try {
                ok = await this._onStartFlowAction(action, step);
            } catch (err) {
                console.error("Start flow action failed:", err);
                ok = false;
            } finally {
                this._startFlowBusy = false;
            }
            // User may have Cancel'd while the action was in flight.
            if (!this._startFlowOverlay) return;
            if (!ok) {
                // Browser-switch UI owns the card; don't restore the Pair button over it.
                const showingBrowserSwitch = !!(
                    this._startFlowTextEl &&
                    this._startFlowTextEl.classList.contains(
                        "robot-start-flow-text--browser-switch"
                    )
                );
                if (!showingBrowserSwitch && this._startFlowBtn) {
                    this._startFlowBtn.disabled = false;
                    this._startFlowBtn.hidden = false;
                    this._startFlowBtn.textContent =
                        String(step.button || step.buttonLabel || "Done").trim() || "Done";
                }
                if (this._startFlowCancelBtn) this._startFlowCancelBtn.disabled = false;
                return;
            }
        }

        this._moveToNextApplicableStartFlowStep(this._startFlowStep + 1);
        if (this._startFlowStep >= flow.steps.length) {
            await this._finishStartFlow();
            return;
        }
        this._renderStartFlowStep();
    }

    async _finishStartFlow() {
        const flow = this.getStartFlowConfig();
        const shouldAutoStart = !!(flow && flow.autoStart);
        if (this._startFlowBtn) this._startFlowBtn.disabled = true;
        this._dismissStartFlowOverlay();
        // Kick local games (e.g. Simon Says opening) in this click gesture so autoplay works.
        const wasReady = this._modeReady;
        const modeAllowed = wasReady || (await this._activateCurrentMode());
        if (!modeAllowed) return;
        if (wasReady) this._syncLocalGameForMode();
        if (shouldAutoStart && typeof this._onRequestStart === "function") {
            try {
                await this._onRequestStart();
            } catch (err) {
                console.error("Start flow auto-start failed:", err);
            }
        }
    }

    _dismissStartFlowOverlay() {
        if (this._startFlowOverlay && this._startFlowOverlay.parentNode) {
            this._startFlowOverlay.parentNode.removeChild(this._startFlowOverlay);
        }
        this._startFlowOverlay = null;
        this._startFlowTextEl = null;
        this._startFlowBtn = null;
        this._startFlowCancelBtn = null;
        this._startFlowBusy = false;
        this._startFlowBrowserSwitchWired = false;
    }

    _buildDefaultDashboard(container) {
        const root = document.createElement("div");
        root.className = "robot-dashboard robot-dashboard--default";
        const title = document.createElement("h3");
        title.className = "robot-dashboard-title";
        title.textContent = this.name || "Robot";
        root.appendChild(title);
        this.buildModesGUI(root);
        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = "Open the menu for transmitter, setup, and detailed panels.";
        root.appendChild(hint);
        container.appendChild(root);
    }

    buildModesGUI(container) {
        if (!container) return;
        if (!this._getModesMap()) return;

        const wrap = document.createElement("div");
        wrap.className = "robot-modes";

        const label = document.createElement("label");
        label.textContent = "Game";
        const select = document.createElement("select");
        select.className = "robot-modes-select";
        select.addEventListener("change", () => {
            select.disabled = true;
            void this.selectGame(select.value).finally(() => {
                select.disabled = false;
                this._syncModeSelectValue();
            });
        });

        wrap.appendChild(label);
        wrap.appendChild(select);
        container.appendChild(wrap);
        this._modeSelect = select;
        this._populateModeSelect();
    }

    /** Rebuild Game dropdown options (character, games index or saved games changed). */
    _populateModeSelect() {
        const select = this._modeSelect;
        if (!select) return;
        select.replaceChildren();
        const games = this.getDashboardGames();
        // With a character, its games come first and built-in games sit in their own group.
        const builtInGroup = games.some((g) => g.group === Robot.CHARACTER_GROUP)
            ? document.createElement("optgroup")
            : null;
        if (builtInGroup) builtInGroup.label = "Built-in games";
        for (const { id, label: text, group } of games) {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = text;
            if (builtInGroup && group === Robot.GAMES_GROUP) builtInGroup.appendChild(opt);
            else select.appendChild(opt);
        }
        if (builtInGroup?.children.length) select.appendChild(builtInGroup);
        this._syncModeSelectValue();
    }

    buildGUI() {
        if (!this.container) return;
        const title = document.createElement('h3');
        title.textContent = this.name || 'Robot';
        this.container.appendChild(title);

        if (this._charactersEnabled()) {
            const charactersBtn = document.createElement("button");
            charactersBtn.type = "button";
            charactersBtn.className = "robot-characters-btn";
            charactersBtn.addEventListener("click", () => this.openCharacters());
            this.container.appendChild(charactersBtn);
            this._charactersBtn = charactersBtn;
            this._syncCharactersButton();
        }

        // Modes live on the dashboard when the robot has a custom/default dashboard host.
        if (!this.dashboardContainer) {
            this.buildModesGUI(this.container);
        }

        const goalWrap = document.createElement("div");
        goalWrap.className = "robot-goal";
        const goalLabel = document.createElement("label");
        goalLabel.textContent = "Goal";
        const goalInput = document.createElement("input");
        goalInput.type = "text";
        goalInput.placeholder = "Describe current goal";
        goalInput.value = this.goal;
        goalInput.addEventListener("input", () => this.setGoal(goalInput.value));
        goalWrap.appendChild(goalLabel);
        goalWrap.appendChild(goalInput);
        this.container.appendChild(goalWrap);
        this._goalInputEl = goalInput;

        const sensorsDiv = document.createElement('div');
        sensorsDiv.className = 'robot-sensors';
        for (const sensor of this.sensors) {
            if (typeof sensor.buildGUI === 'function') {
                sensor.buildGUI(sensorsDiv);
            }
        }
        this.container.appendChild(sensorsDiv);

        const processingDiv = document.createElement('div');
        processingDiv.className = 'robot-processing';
        const processingTitle = document.createElement('h4');
        processingTitle.textContent = 'Processing';
        processingDiv.appendChild(processingTitle);
        const requestedProcessing = Array.isArray(this.config.processing)
            ? this.config.processing.length
            : Array.isArray(this.config.aiModels)
              ? this.config.aiModels.length
              : 0;
        for (const module of this.processing) {
            if (typeof module.buildGUI === 'function') {
                module.buildGUI(processingDiv);
            }
        }
        if (!this.processing.length) {
            const none = document.createElement('p');
            none.className = requestedProcessing ? 'error' : 'muted';
            none.textContent = requestedProcessing
                ? 'Processing modules were requested but failed to load. Check browser console.'
                : 'No processing modules configured for this robot.';
            processingDiv.appendChild(none);
        }
        this.container.appendChild(processingDiv);

        if (this.agentInterface && typeof this.agentInterface.buildGUI === "function") {
            const agentDiv = document.createElement("div");
            agentDiv.className = "robot-agent-interfaces";
            this.agentInterface.buildGUI(agentDiv);
            this.container.appendChild(agentDiv);
            // Payment validation must finish before agent hooks or a local game can run.
            void this._activateCurrentMode();
        } else if (!this.getStartFlowConfig()) {
            void this._activateCurrentMode();
        }

        const filtersDiv = document.createElement('div');
        filtersDiv.className = 'robot-object-filters';
        const filtersTitle = document.createElement('h4');
        filtersTitle.textContent = 'Object filters';
        filtersDiv.appendChild(filtersTitle);
        for (const objectFilter of this.objectFilters) {
            if (typeof objectFilter.buildGUI === 'function') {
                objectFilter.buildGUI(filtersDiv);
            }
        }
        if (!this.objectFilters.length) {
            const none = document.createElement('p');
            none.className = 'muted';
            none.textContent = 'No object filters configured for this robot.';
            filtersDiv.appendChild(none);
        }
        this.container.appendChild(filtersDiv);

        const pidDiv = document.createElement('div');
        pidDiv.className = 'robot-pid';
        const pidTitle = document.createElement('h4');
        pidTitle.textContent = 'PID Controllers';
        pidDiv.appendChild(pidTitle);
        for (const pid of this.pidControllers) {
            if (typeof pid.buildGUI === 'function') {
                pid.buildGUI(pidDiv);
            }
        }
        if (!this.pidControllers.length) {
            const none = document.createElement('p');
            none.className = 'muted';
            none.textContent = 'No PID controllers configured for this robot.';
            pidDiv.appendChild(none);
        }
        this.container.appendChild(pidDiv);

        const strategiesDiv = document.createElement("div");
        strategiesDiv.className = "robot-strategies";
        const strategiesTitle = document.createElement("h4");
        strategiesTitle.textContent = "Strategies";
        strategiesDiv.appendChild(strategiesTitle);
        if (this.strategies && typeof this.strategies.buildGUI === "function") {
            this.strategies.buildGUI(strategiesDiv);
        } else {
            const none = document.createElement("p");
            none.className = "muted";
            none.textContent = "No strategies runner (disabled or RobotStrategies unavailable).";
            strategiesDiv.appendChild(none);
        }
        this.container.appendChild(strategiesDiv);

        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'robot-inputs';
        for (const joystick of this.joysticks) {
            if (joystick.gui) {
                inputsDiv.appendChild(joystick.gui);
            }
        }
        for (const input of Object.values(this.controlInputs)) {
            if (input.gui) {
                inputsDiv.appendChild(input.gui);
            }
        }
        this.container.appendChild(inputsDiv);

        const actuatorsDiv = document.createElement('div');
        actuatorsDiv.className = 'robot-actuators';

        const actuatorsHeader = document.createElement('div');
        actuatorsHeader.className = 'robot-actuators-header';
        const actuatorsTitle = document.createElement('h4');
        actuatorsTitle.textContent = 'Actuators';
        actuatorsHeader.appendChild(actuatorsTitle);

        if (this.actuatorMixes.length) {
            const mixControls = document.createElement('div');
            mixControls.className = 'robot-actuators-mix-controls';

            const mixLabel = document.createElement('span');
            mixLabel.className = 'muted';
            mixLabel.textContent = 'Mix';

            const mixToggle = document.createElement('button');
            mixToggle.type = 'button';
            mixToggle.className = 'ai-model-toggle-btn';
            mixToggle.textContent = this.mixEnabled ? 'On' : 'Off';
            mixToggle.addEventListener('click', () => {
                this.setMixEnabled(!this.mixEnabled);
            });

            const freqLabel = document.createElement('label');
            freqLabel.className = 'robot-actuators-mix-freq';
            freqLabel.textContent = 'Hz';
            const freqInput = document.createElement('input');
            freqInput.type = 'number';
            freqInput.min = '1';
            freqInput.max = '60';
            freqInput.step = '1';
            freqInput.value = String(this.mixFrequencyHz);
            freqInput.addEventListener('change', () => this.setMixFrequencyHz(freqInput.value));
            freqInput.addEventListener('blur', () => this.setMixFrequencyHz(freqInput.value));
            freqLabel.appendChild(freqInput);

            mixControls.appendChild(mixLabel);
            mixControls.appendChild(mixToggle);
            mixControls.appendChild(freqLabel);
            actuatorsHeader.appendChild(mixControls);

            this._mixToggleBtn = mixToggle;
            this._mixFreqInput = freqInput;
        }

        actuatorsDiv.appendChild(actuatorsHeader);
        for (const actuator of this.actuators) {
            if (actuator.gui) {
                actuatorsDiv.appendChild(actuator.gui);
            }
        }
        this.container.appendChild(actuatorsDiv);
        this._makePanelsCollapsible();
        this._applyStartupModuleEnabled();
        if (this.strategies && typeof this.strategies.start === "function") {
            this.strategies.start();
        }
    }
}
