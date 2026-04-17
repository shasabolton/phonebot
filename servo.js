class Servo {
    constructor(name, pin, homeAngle, minAngle, maxAngle) {
        this.type = "servo";
        this.name = name;
        this.pin = pin;
        this.homeAngle = homeAngle;
        this.minAngle = minAngle;
        this.maxAngle = maxAngle;
        this.angle = homeAngle;
        this.gui = this.makeGui();
    }

    setAngle(angle) {
        const clamped = Math.min(this.maxAngle, Math.max(this.minAngle, Number(angle)));
        this.angle = clamped;

        if (this._angleSlider && Number(this._angleSlider.value) !== clamped) {
            this._angleSlider.value = String(clamped);
        }
        const label = `Angle: ${clamped}`;
        if (this._angleP && this._angleP.textContent !== label) {
            this._angleP.textContent = label;
        }
    }

    getAngle() {
        return this.angle;
    }

    angleToMicroseconds(angle) {
        const span = this.maxAngle - this.minAngle;
        if (span <= 0) return 1500;
        const ratio = (angle - this.minAngle) / span;
        return Math.round(1000 + ratio * 1000);
    }

    getHomeMicroseconds() {
        return this.angleToMicroseconds(this.homeAngle);
    }

    getMinMicroseconds() {
        return this.angleToMicroseconds(this.minAngle);
    }

    getMaxMicroseconds() {
        return this.angleToMicroseconds(this.maxAngle);
    }

    getMicroseconds() {
        return this.angleToMicroseconds(this.angle);
    }

    makeGui() {
        const gui = document.createElement("div");
        gui.innerHTML = `
        <h3>${this.name}</h3>
        <p>Pin: ${this.pin}</p>
        <p>Home Angle: ${this.homeAngle}</p>
        <p>Min Angle: ${this.minAngle}</p>
        <p>Max Angle: ${this.maxAngle}</p>
        <input type="range" min="${this.minAngle}" max="${this.maxAngle}" value="${this.angle}" step="1">
        <p class="servo-angle-display">Angle: ${this.angle}</p>
        `;
        this._angleSlider = gui.querySelector('input[type="range"]');
        this._angleP = gui.querySelector(".servo-angle-display");
        this._angleSlider.addEventListener("input", () => {
            this.setAngle(Number(this._angleSlider.value));
        });
        return gui;
    }
}
