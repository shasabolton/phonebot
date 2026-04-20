class Input {
    constructor(config) {
        this.name = config?.name || "input";
        this.min = Number(config?.min ?? -1);
        this.max = Number(config?.max ?? 1);
        this.home = Number(config?.home ?? 0);
        this.value = this.clamp(this.home);
        this.listeners = new Set();
        this.gui = this.makeGui();
    }

    clamp(value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return this.home;
        return Math.min(this.max, Math.max(this.min, numericValue));
    }

    setValue(value) {
        const clamped = this.clamp(value);
        if (clamped === this.value) return;
        this.value = clamped;
        this.syncGui();
        this.emitChange();
    }

    getValue() {
        return this.value;
    }

    onChange(handler) {
        if (typeof handler !== "function") return () => {};
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    emitChange() {
        for (const handler of this.listeners) {
            handler(this.value, this);
        }
    }

    syncGui() {
        if (this._slider && Number(this._slider.value) !== this.value) {
            this._slider.value = String(this.value);
        }
        if (this._valueLabel) {
            this._valueLabel.textContent = `Value: ${this.value.toFixed(2)}`;
        }
    }

    makeGui() {
        const gui = document.createElement("div");
        gui.innerHTML = `
        <h4>${this.name}</h4>
        <input type="range" min="${this.min}" max="${this.max}" value="${this.value}" step="0.01">
        <p class="input-value-display">Value: ${this.value.toFixed(2)}</p>
        `;
        this._slider = gui.querySelector('input[type="range"]');
        this._valueLabel = gui.querySelector(".input-value-display");
        this._slider.addEventListener("input", () => {
            this.setValue(Number(this._slider.value));
        });
        return gui;
    }
}
