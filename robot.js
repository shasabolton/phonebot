class Robot {
    constructor(container, config) {
        this.config = typeof config === 'string' ? JSON.parse(config) : config;
        this.container = container;
        this.name = this.config?.name;
        this.actuators = [];
        this.inputs = {};
        this.joysticks = [];
        this.actuatorMixes = [];
        this.inputUnsubscribes = [];
        this.sensors = [];
        this.targets = [];
        this.pidControllers = [];
        this.transmitter;
        // PID controllers read targets and sensors and may set inputs. Mix functions map inputs to actuators.
        // Actuators have their own sliders; mixing updates angles when inputs change.

        this.buildRobot();
        this.buildGUI();
    }

    step() {
        // get target error, apply feedback control, set inputs
    }

    buildRobot() {
        (this.config.actuators || []).forEach(config => {
            this.addActuator(config);
        });
        this.buildInputs(this.config.inputs || {});
        this.buildJoysticks(this.config.joysticks || []);
        this.buildActuatorMixing();
    }

    buildInputs(inputConfig) {
        this.inputs = {};
        if (Array.isArray(inputConfig)) {
            for (const cfg of inputConfig) {
                if (!cfg?.name) continue;
                this.inputs[cfg.name] = new Input(cfg);
            }
            return;
        }

        for (const [name, cfg] of Object.entries(inputConfig || {})) {
            this.inputs[name] = new Input({ name, ...cfg });
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

    getInputValues() {
        const values = {};
        for (const [name, input] of Object.entries(this.inputs)) {
            values[name] = input.getValue();
        }
        return values;
    }

    applyMixing() {
        if (!this.actuatorMixes.length) return;
        const ctx = { inputs: this.getInputValues(), robot: this };
        for (const { servo, mix } of this.actuatorMixes) {
            const angle = mix(ctx);
            if (Number.isFinite(angle)) {
                servo.setAngle(angle);
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
        for (const input of Object.values(this.inputs)) {
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

    setInput(name, value) {
        const input = this.inputs[name];
        if (!input) return false;
        input.setValue(value);
        return true;
    }

    addActuator(config) {
        switch (config.type) {
            case "servo":
                this.actuators.push(new Servo(config.name, config.pin, config.homeAngle, config.minAngle, config.maxAngle));
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

        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'robot-inputs';
        for (const joystick of this.joysticks) {
            if (joystick.gui) {
                inputsDiv.appendChild(joystick.gui);
            }
        }
        for (const input of Object.values(this.inputs)) {
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
