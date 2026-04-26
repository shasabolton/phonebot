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
        this.trackers = [];
        this.targets = [];
        this.pidControllers = [];
        this.transmitter;
        this.mode = "track";
        this.deciders = [];
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
        this.teardownTrackers();
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
        this.buildTrackers(this.config.trackers || []);
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

    buildTrackers(trackerConfigs) {
        this.teardownTrackers();
        for (const item of trackerConfigs || []) {
            const cfg = typeof item === "string" ? { name: item } : { ...item };
            try {
                if (typeof window.Tracker !== "function") {
                    throw new Error("Tracker class is unavailable. Check tracker.js loading.");
                }
                const tracker = new window.Tracker(this, cfg.name, cfg);
                this.trackers.push(tracker);
            } catch (err) {
                console.error("Tracker build failed:", err);
            }
        }
    }

    teardownTrackers() {
        for (const tracker of this.trackers) {
            if (typeof tracker.destroy === "function") tracker.destroy();
        }
        this.trackers = [];
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

    getTrackerByName(name) {
        const key = String(name || "").trim().toLowerCase();
        return this.trackers.find((tracker) => String(tracker?.name || "").toLowerCase() === key) || null;
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

    buildGUI() {
        if (!this.container) return;
        const title = document.createElement('h3');
        title.textContent = this.name || 'Robot';
        this.container.appendChild(title);

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

        const trackersDiv = document.createElement('div');
        trackersDiv.className = 'robot-trackers';
        const trackersTitle = document.createElement('h4');
        trackersTitle.textContent = 'Trackers';
        trackersDiv.appendChild(trackersTitle);
        for (const tracker of this.trackers) {
            if (typeof tracker.buildGUI === 'function') {
                tracker.buildGUI(trackersDiv);
            }
        }
        if (!this.trackers.length) {
            const none = document.createElement('p');
            none.className = 'muted';
            none.textContent = 'No trackers configured for this robot.';
            trackersDiv.appendChild(none);
        }
        this.container.appendChild(trackersDiv);

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
    }
}
