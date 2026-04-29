class Robot {
    constructor(container, config) {
        this.config = typeof config === 'string' ? JSON.parse(config) : config;
        this.container = container;
        this.name = this.config?.name;
        this.actuators = [];
        this.controlInputs = {};
        this.joysticks = [];
        this.actuatorMixes = [];
        this.inputUnsubscribes = [];
        this.sensors = [];
        this.aiModels = [];
        this.agentInterface = null;
        this.objectFilters = [];
        this.targets = [];
        this.pidControllers = [];
        this.transmitter;
        this.mode = "track";
        this.deciders = [];
        this.goal="";
        this._goalInputEl = null;
        //if mode === track, if trackcoods!= null it means open cv has found the trackTarget.
        // PID controllers read targets/sensors and may set control inputs. Mix functions map control inputs to actuators.
        // Actuators have their own sliders; mixing updates angles when control inputs change.

        this.buildRobot();
        this.buildGUI();
    }

    destroy() {
        this.teardownJoysticks();
        this.teardownInputMixSubscriptions();
        this.teardownSensors();
        this.teardownAiModels();
        this.teardownAgentInterface();
        this.teardownObjectFilters();
        this.teardownPidControllers();
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
        this.buildAiModels(this.config.aiModels || []);
        this.buildAgentInterface();
        this.buildObjectFilters(this.config.objectFilters || []);
        this.buildPidControllers(this.config.pidControllers || []);
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
                    this.sensors.push(new Camera(cfg));
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

    buildAiModels(aiModelConfigs) {
        this.teardownAiModels();
        for (const item of aiModelConfigs || []) {
            const cfg = typeof item === "string" ? { type: item } : { ...item };
            const type = String(cfg.type || "").trim().toLowerCase();
            try {
                if (type === "coco") {
                    const CocoModelClass = window.CocoAiModel;
                    if (typeof CocoModelClass !== "function") {
                        throw new Error("CocoAiModel class is unavailable. Check aiModelCoco.js loading.");
                    }
                    this.aiModels.push(new CocoModelClass(this, cfg));
                } else if (type === "tracker") {
                    const TrackerModelClass = window.GenericTrackerAiModel;
                    if (typeof TrackerModelClass !== "function") {
                        throw new Error("GenericTrackerAiModel class is unavailable. Check aiModelTracker.js loading.");
                    }
                    this.aiModels.push(new TrackerModelClass(this, cfg));
                } else if (type === "groqvision" || type === "groq") {
                    const GroqVisionModelClass = window.GroqVisionAiModel;
                    if (typeof GroqVisionModelClass !== "function") {
                        throw new Error("GroqVisionAiModel class is unavailable. Check aiModelGroqVision.js loading.");
                    }
                    this.aiModels.push(new GroqVisionModelClass(this, cfg));
                } else if (type === "objectmatcher") {
                    const MatcherClass = window.ObjectMatcherAiModel;
                    if (typeof MatcherClass !== "function") {
                        throw new Error("ObjectMatcherAiModel class is unavailable. Check objectMatcher.js loading.");
                    }
                    this.aiModels.push(new MatcherClass(this, cfg));
                } else if (type) {
                    console.warn(`Unknown AI model type: ${cfg.type}`);
                }
            } catch (err) {
                console.error("AI model build failed:", err);
            }
        }
    }

    teardownAiModels() {
        for (const model of this.aiModels) {
            if (typeof model.destroy === "function") model.destroy();
        }
        this.aiModels = [];
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

    getAiModelByType(type) {
        const key = String(type || "").trim().toLowerCase();
        return this.aiModels.find((model) => String(model?.type || "").toLowerCase() === key) || null;
    }

    getAiModelByName(name) {
        const key = String(name || "").trim().toLowerCase();
        return this.aiModels.find((model) => String(model?.name || "").toLowerCase() === key) || null;
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
        const ctx = { controlInputs: this.getControlInputValues(), robot: this };
        for (const { servo, mix } of this.actuatorMixes) {
            const us = mix(ctx);
            if (Number.isFinite(us)) {
                servo.setMicroseconds(us);
            }
        }
    }

    buildActuatorMixing() {
        this.teardownInputMixSubscriptions();
        this.actuatorMixes = [];
        const actuatorConfigs = this.config.actuators || [];
        for (let i = 0; i < actuatorConfigs.length; i++) {
            const cfg = actuatorConfigs[i];
            const servo = this.actuators[i];
            if (typeof cfg?.mix === 'function' && servo) {
                this.actuatorMixes.push({ servo, mix: cfg.mix });
            }
        }
        if (!this.actuatorMixes.length) return;
        const onInputChange = () => this.applyMixing();
        for (const input of Object.values(this.controlInputs)) {
            this.inputUnsubscribes.push(input.onChange(onInputChange));
        }
        this.applyMixing();
    }

    teardownInputMixSubscriptions() {
        for (const unsub of this.inputUnsubscribes) {
            unsub();
        }
        this.inputUnsubscribes = [];
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
            if (Array.isArray(current)) {
                current = this._resolveNamedCollectionItem(current, segment);
            } else {
                current = current[segment];
            }
        }
        if (typeof current === "function") return undefined;
        return current;
    }

    buildState() {
        const configuredPaths = Array.isArray(this.config?.state) ? this.config.state : [];
        const state = {
            robotName: this.name || "Robot",
            mode: this.mode,
            goal: this.goal
        };

        if (!configuredPaths.length) {
            state.controlInputs = this.getControlInputValues();
            return state;
        }

        for (const path of configuredPaths) {
            const key = String(path || "").trim();
            if (!key) continue;
            state[key] = this._readStatePath(key);
        }
        return state;
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

    _toTitleCase(input) {
        return String(input || "")
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\b\w/g, (m) => m.toUpperCase());
    }

    _derivePanelTitle(node, fallbackTitle) {
        if (!node) return fallbackTitle;
        const heading = node.querySelector("h2, h3, h4, h5, legend");
        if (heading && heading.textContent) {
            const text = heading.textContent.trim();
            if (text) return text;
        }
        const label = node.querySelector(":scope > label");
        if (label && label.textContent) {
            const text = label.textContent.trim();
            if (text) return text;
        }
        return fallbackTitle;
    }

    _wrapCollapsible(node, title) {
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
    }

    _makePanelsCollapsible() {
        const majorPanels = [
            { selector: ".robot-goal", fallback: "Goal" },
            { selector: ".robot-sensors", fallback: "Sensors" },
            { selector: ".robot-ai-models", fallback: "AI Models" },
            { selector: ".robot-agent-interfaces", fallback: "Agent Interfaces" },
            { selector: ".robot-object-filters", fallback: "Object Filters" },
            { selector: ".robot-pid", fallback: "PID Controllers" },
            { selector: ".robot-inputs", fallback: "Inputs" },
            { selector: ".robot-actuators", fallback: "Actuators" }
        ];
        for (const panel of majorPanels) {
            const node = this.container.querySelector(panel.selector);
            if (!node) continue;
            const title = this._derivePanelTitle(node, panel.fallback);
            this._wrapCollapsible(node, title);
        }

        const subPanels = Array.from(this.container.querySelectorAll(".ai-model, .joystick-wrap"));
        for (const node of subPanels) {
            const fallbackClass = String(node.className || "").split(" ")[0] || "Panel";
            const title = this._derivePanelTitle(node, this._toTitleCase(fallbackClass));
            this._wrapCollapsible(node, title);
        }
    }

    buildGUI() {
        if (!this.container) return;
        const title = document.createElement('h3');
        title.textContent = this.name || 'Robot';
        this.container.appendChild(title);

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

        const aiModelsDiv = document.createElement('div');
        aiModelsDiv.className = 'robot-ai-models';
        const aiTitle = document.createElement('h4');
        aiTitle.textContent = 'AI Models';
        aiModelsDiv.appendChild(aiTitle);
        const requestedAiModels = Array.isArray(this.config.aiModels) ? this.config.aiModels.length : 0;
        for (const model of this.aiModels) {
            if (typeof model.buildGUI === 'function') {
                model.buildGUI(aiModelsDiv);
            }
        }
        if (!this.aiModels.length) {
            const none = document.createElement('p');
            none.className = requestedAiModels ? 'error' : 'muted';
            none.textContent = requestedAiModels
                ? 'AI models were requested but failed to load. Check browser console.'
                : 'No AI models configured for this robot.';
            aiModelsDiv.appendChild(none);
        }
        this.container.appendChild(aiModelsDiv);

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
        for (const actuator of this.actuators) {
            if (actuator.gui) {
                actuatorsDiv.appendChild(actuator.gui);
            }
        }
        this.container.appendChild(actuatorsDiv);
        this._makePanelsCollapsible();
    }
}
