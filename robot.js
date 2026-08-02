class Robot {
    constructor(container, config) {
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
        this.stateMachine = null;
        this.strategies = null;
        // PID controllers read targets/sensors and may set control inputs.
        // Mix clock rematches control inputs + processing → actuators at mixFrequencyHz.
        // Modes sparsely override actuator mixes (and later, behaviors).

        this._initModeFromConfig();
        this.buildRobot();
        this.buildGUI();
    }

    destroy() {
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

    _initModeFromConfig() {
        const modes = this._getModesMap();
        if (!modes) {
            this.mode = null;
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

    _getModesMap() {
        const modes = this.config?.modes;
        if (!modes || typeof modes !== "object" || Array.isArray(modes)) return null;
        const keys = Object.keys(modes);
        return keys.length ? modes : null;
    }

    getModeList() {
        const modes = this._getModesMap();
        if (!modes) return [];
        return Object.entries(modes).map(([id, cfg]) => ({
            id,
            label: String(cfg?.label || id)
        }));
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
     * @param {string} id
     * @returns {boolean}
     */
    setMode(id) {
        const modes = this._getModesMap();
        if (!modes) return false;
        const want = String(id || "").trim();
        if (!want || !modes[want]) return false;
        if (this.mode === want) {
            if (this._modeSelect) this._modeSelect.value = this.mode;
            return true;
        }
        this.mode = want;
        const wasEnabled = this.mixEnabled;
        this._rebuildActuatorMixes({ restoreEnabled: wasEnabled });
        if (this._modeSelect) this._modeSelect.value = this.mode;
        return true;
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

    buildModesGUI(container) {
        if (!container) return;
        const modes = this.getModeList();
        if (!modes.length) return;

        const wrap = document.createElement("div");
        wrap.className = "robot-modes";

        const label = document.createElement("label");
        label.textContent = "Mode";
        const select = document.createElement("select");
        select.className = "robot-modes-select";
        for (const { id, label: text } of modes) {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = text;
            select.appendChild(opt);
        }
        if (this.mode && modes.some((m) => m.id === this.mode)) {
            select.value = this.mode;
        }
        select.addEventListener("change", () => this.setMode(select.value));

        wrap.appendChild(label);
        wrap.appendChild(select);
        container.appendChild(wrap);
        this._modeSelect = select;
    }

    buildGUI() {
        if (!this.container) return;
        const title = document.createElement('h3');
        title.textContent = this.name || 'Robot';
        this.container.appendChild(title);

        this.buildModesGUI(this.container);

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
