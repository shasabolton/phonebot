class Robot {
    constructor(container, config) {
        this.config = typeof config === 'string' ? JSON.parse(config) : config;
        this.container = container;
        this.name = this.config?.name;
        this.actuators = [];
        this.inputs = {};
        this.mixers = [];
        this.sensors = [];
        this.targets = [];
        this.pidControllers = [];
        this.transmitter;
        //pid contolers read targets and sensors and modify mixers. Mixers modify actuators.
        //actuator have their own sliders. Mixers sliders overide actuator sliders.
        
        this.buildRobot();
        this.buildGUI();
    }

    step(){
        //get target error
        //apply  feedback controll
        //set mixers
        
    }

    buildRobot(){
        (this.config.actuators || []).forEach(config => {
            this.addActuator(config);
        });
        this.buildInputs(this.config.inputs || {});
        this.buildMixers(this.config.mixers || []);
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

    buildMixers(mixerConfigList) {
        this.mixers = [];
        for (const mixerConfig of mixerConfigList) {
            const resolvedInputs = (mixerConfig.inputs || [])
                .map((inputName) => this.inputs[inputName])
                .filter(Boolean);
            const resolvedOutputs = (mixerConfig.outputs || [])
                .map((outputIdx) => this.actuators[outputIdx])
                .filter(Boolean);
            this.mixers.push(new Mixer({
                ...mixerConfig,
                inputs: resolvedInputs,
                outputs: resolvedOutputs
            }));
        }
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

    buildActionsMessage(){
        const parts = [];
        for (const actuator of this.actuators) {
            if (actuator.type === "servo") {
                parts.push(`${actuator.pin}:${Math.round(actuator.getMicroseconds())}`);
            }
        }
        return parts.join(",");
    }

    buildPinSetupMessage(){
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
