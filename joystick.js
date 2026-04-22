class Joystick {
    /**
     * @param {Robot} robot
     * @param {{ name?: string, x: string, y: string }} config — `x` / `y` are names of {@link Input}s on the robot
     */
    constructor(robot, config) {
        this.robot = robot;
        this.name = config?.name || "joystick";
        const xName = config?.x;
        const yName = config?.y;
        this.inputX = xName != null ? robot.inputs[xName] : null;
        this.inputY = yName != null ? robot.inputs[yName] : null;
        if (!this.inputX || !this.inputY) {
            throw new Error(`Joystick "${this.name}" needs valid x and y input names (got x=${xName}, y=${yName})`);
        }
        this._padSize = 160;
        this._knobR = 10;
        this._maxOffset = this._padSize / 2 - this._knobR;
        this._dragging = false;
        this.gui = this.buildGui();
        this._unsubs = [];
        this._syncKnobFromInputs = () => {
            if (this._dragging) return;
            this._placeKnobFromValues();
        };
        this._unsubs.push(this.inputX.onChange(this._syncKnobFromInputs));
        this._unsubs.push(this.inputY.onChange(this._syncKnobFromInputs));
        this._placeKnobFromValues();
    }

    destroy() {
        for (const u of this._unsubs) u();
        this._unsubs = [];
    }

    valueToNorm(value, input) {
        const span = input.max - input.min;
        if (!Number.isFinite(span) || span === 0) return 0;
        return (2 * (value - input.min)) / span - 1;
    }

    normToValue(n, input) {
        const t = (Number(n) + 1) / 2;
        return input.min + t * (input.max - input.min);
    }

    _placeKnobFromValues() {
        const nx = this.valueToNorm(this.inputX.getValue(), this.inputX);
        const ny = this.valueToNorm(this.inputY.getValue(), this.inputY);
        this._setKnobNorm(nx, ny, false);
    }

    _setKnobNorm(nx, ny, writeInputs) {
        const clampedX = Math.min(1, Math.max(-1, nx));
        const clampedY = Math.min(1, Math.max(-1, ny));
        const px = clampedX * this._maxOffset;
        // +ny = up on pad (screen Y increases downward, so negate for knob position)
        const py = -clampedY * this._maxOffset;
        this._knob.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;

        if (writeInputs) {
            this.inputX.setValue(this.normToValue(clampedX, this.inputX));
            this.inputY.setValue(this.normToValue(clampedY, this.inputY));
        }
    }

    _normFromPointer(clientX, clientY) {
        const rect = this._pad.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let nx = (clientX - cx) / this._maxOffset;
        // +ny = up, -ny = down (invert screen Y)
        let ny = -(clientY - cy) / this._maxOffset;
        const len = Math.hypot(nx, ny);
        if (len > 1 && len > 0) {
            nx /= len;
            ny /= len;
        }
        return { nx, ny };
    }

    buildGui() {
        const wrap = document.createElement("div");
        wrap.className = "joystick-wrap";

        const title = document.createElement("h4");
        title.textContent = this.name;
        wrap.appendChild(title);

        const pad = document.createElement("div");
        pad.className = "joystick-pad";
        pad.style.width = `${this._padSize}px`;
        pad.style.height = `${this._padSize}px`;
        this._pad = pad;

        const knob = document.createElement("div");
        knob.className = "joystick-knob";
        knob.style.width = `${this._knobR * 2}px`;
        knob.style.height = `${this._knobR * 2}px`;
        this._knob = knob;
        pad.appendChild(knob);

        const onPointerDown = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this._dragging = true;
            pad.setPointerCapture(e.pointerId);
            const { nx, ny } = this._normFromPointer(e.clientX, e.clientY);
            this._setKnobNorm(nx, ny, true);
        };
        const onPointerMove = (e) => {
            if (!this._dragging) return;
            const { nx, ny } = this._normFromPointer(e.clientX, e.clientY);
            this._setKnobNorm(nx, ny, true);
        };
        const onPointerUp = (e) => {
            if (!this._dragging) return;
            this._dragging = false;
            try {
                pad.releasePointerCapture(e.pointerId);
            } catch (_) {
                /* ignore */
            }
        };

        pad.addEventListener("pointerdown", onPointerDown);
        pad.addEventListener("pointermove", onPointerMove);
        pad.addEventListener("pointerup", onPointerUp);
        pad.addEventListener("pointercancel", onPointerUp);

        wrap.appendChild(pad);
        return wrap;
    }
}
