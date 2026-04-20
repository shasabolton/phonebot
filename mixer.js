class Mixer {
    constructor(config) {
        this.name = config.name;
        this.inputs = config.inputs || [];
        this.outputs = config.outputs || [];
        this.weights = config.weights || [];
        //weights = [[1,-1],[-1,1]] row = actuator, column = input
        this.unsubscribeHandlers = [];
        this.subscribeToInputs();
        this.mix();
    }

    subscribeToInputs() {
        this.unsubscribe();
        for (const input of this.inputs) {
            if (!input || typeof input.onChange !== "function") continue;
            const unsubscribe = input.onChange(() => this.mix());
            this.unsubscribeHandlers.push(unsubscribe);
        }
    }

    unsubscribe() {
        for (const handler of this.unsubscribeHandlers) {
            handler();
        }
        this.unsubscribeHandlers = [];
    }

    mix() {
        for (let i = 0; i < this.outputs.length; i++) {
            let output = 0;
            for (let j = 0; j < this.inputs.length; j++) {
                const inputValue = typeof this.inputs[j]?.getValue === "function"
                    ? this.inputs[j].getValue()
                    : Number(this.inputs[j] ?? 0);
                const weight = Number(this.weights?.[i]?.[j] ?? 0);
                output += inputValue * weight;
            }
            const mappedAngle = output * 90 + 90;
            if (this.outputs[i] && typeof this.outputs[i].setAngle === "function") {
                this.outputs[i].setAngle(mappedAngle);
            }
        }
    }
}