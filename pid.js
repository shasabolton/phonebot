class PID {
    constructor(robot, name, config = {}) {
        this.robot = robot;
        this.name = name || config.name || "pid";
        this.feedback = config.feedback || "";
        this.controlInputName = config.controlInput || config.input || "";
        this.goal = Number.isFinite(config.goal) ? config.goal : 0;
        this.kp = Number.isFinite(config.kp) ? config.kp : 0.5;
        this.ki = Number.isFinite(config.ki) ? config.ki : 0;
        this.kd = Number.isFinite(config.kd) ? config.kd : 0;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 0;
        this.runBoundToFeedback = !this.frequencyHz || config.frequencyHz === "feedback";
        this.enabled = false;
        this.integral = 0;
        this.prevError = 0;
        this.lastOutput = 0;
        this._timer = null;
        this._busy = false;
        this._toggleBtn = null;
        this._statusEl = null;
        this._outputEl = null;
    }

    _resolveObjectFilterFromFeedback() {
        const token = String(this.feedback || "").split(".")[0];
        if (!token) return null;
        return this.robot.getObjectFilterByName(token);
    }

    _resolveFeedbackValue() {
        const path = String(this.feedback || "");
        const parts = path.split(".");
        const objectFilterName = parts[0];
        if (!objectFilterName) return null;
        const objectFilter = this.robot.getObjectFilterByName(objectFilterName);
        if (!objectFilter) return null;
        let cursor = { result: objectFilter.getResult() };
        for (let i = 1; i < parts.length; i++) {
            const key = parts[i];
            cursor = cursor?.[key];
            if (cursor === undefined || cursor === null) return null;
        }
        const value = Number(cursor);
        return Number.isFinite(value) ? value : null;
    }

    _resolveFrequencyHz() {
        if (!this.runBoundToFeedback && this.frequencyHz > 0) return this.frequencyHz;
        const objectFilter = this._resolveObjectFilterFromFeedback();
        if (objectFilter && typeof objectFilter._resolveFrequencyHz === "function") {
            const hz = Number(objectFilter._resolveFrequencyHz());
            if (Number.isFinite(hz) && hz > 0) return hz;
        }
        return 1;
    }

    setGain(name, value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        if (name === "kp") this.kp = parsed;
        if (name === "ki") this.ki = parsed;
        if (name === "kd") this.kd = parsed;
    }

    _renderOutput(feedbackValue = null) {
        if (!this._outputEl) return;
        this._outputEl.textContent = JSON.stringify({
            pid: this.name,
            feedback: this.feedback,
            controlInput: this.controlInputName,
            goal: this.goal,
            kp: this.kp,
            ki: this.ki,
            kd: this.kd,
            feedbackValue,
            lastOutput: this.lastOutput
        }, null, 2);
    }

    _tick() {
        if (this._busy || !this.enabled) return;
        this._busy = true;
        try {
            const feedbackValue = this._resolveFeedbackValue();
            if (feedbackValue === null) {
                this.integral = 0;
                this.prevError = 0;
                this.lastOutput = 0;
                const input = this.robot.controlInputs[this.controlInputName];
                if (input) {
                    input.setValue(0);
                }
                if (this._statusEl) {
                    this._statusEl.className = "muted";
                    this._statusEl.textContent = "No feedback — output zeroed.";
                }
                this._renderOutput(null);
                return;
            }

            const hz = this._resolveFrequencyHz();
            const dt = 1 / hz;
            const error = this.goal - feedbackValue;
            this.integral += error * dt;
            const derivative = (error - this.prevError) / dt;
            this.prevError = error;
            const output = this.kp * error + this.ki * this.integral + this.kd * derivative;
            this.lastOutput = output;

            const input = this.robot.controlInputs[this.controlInputName];
            if (input) {
                input.setValue(output);
            }

            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = `Output ${output.toFixed(3)} -> ${this.controlInputName}`;
            }
            this._renderOutput(feedbackValue);
        } catch (err) {
            console.error("PID error:", err);
            if (this._statusEl) {
                this._statusEl.className = "error";
                this._statusEl.textContent = `PID error: ${err?.message || "unknown error"}`;
            }
        } finally {
            this._busy = false;
        }
    }

    _startLoop() {
        this._stopLoop();
        const hz = this._resolveFrequencyHz();
        const intervalMs = Math.max(50, Math.round(1000 / hz));
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }

    _stopLoop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    setEnabled(nextEnabled) {
        this.enabled = !!nextEnabled;
        if (this._toggleBtn) this._toggleBtn.textContent = this.enabled ? "On" : "Off";
        if (this.enabled) {
            this.integral = 0;
            this.prevError = 0;
            this.lastOutput = 0;
            this._startLoop();
        } else {
            this._stopLoop();
            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = "PID off.";
            }
            this._renderOutput(null);
        }
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model pid-panel";

        const title = document.createElement("h4");
        title.textContent = `PID: ${this.name}`;

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", () => this.setEnabled(!this.enabled));

        const kpLabel = document.createElement("label");
        kpLabel.textContent = "Kp";
        const kpInput = document.createElement("input");
        kpInput.type = "number";
        kpInput.step = "0.001";
        kpInput.value = String(this.kp);
        kpInput.addEventListener("change", () => this.setGain("kp", kpInput.value));

        const kiLabel = document.createElement("label");
        kiLabel.textContent = "Ki";
        const kiInput = document.createElement("input");
        kiInput.type = "number";
        kiInput.step = "0.001";
        kiInput.value = String(this.ki);
        kiInput.addEventListener("change", () => this.setGain("ki", kiInput.value));

        const kdLabel = document.createElement("label");
        kdLabel.textContent = "Kd";
        const kdInput = document.createElement("input");
        kdInput.type = "number";
        kdInput.step = "0.001";
        kdInput.value = String(this.kd);
        kdInput.addEventListener("change", () => this.setGain("kd", kdInput.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "PID off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        wrap.appendChild(title);
        wrap.appendChild(toggleBtn);
        wrap.appendChild(kpLabel);
        wrap.appendChild(kpInput);
        wrap.appendChild(kiLabel);
        wrap.appendChild(kiInput);
        wrap.appendChild(kdLabel);
        wrap.appendChild(kdInput);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._statusEl = status;
        this._outputEl = output;
        this._renderOutput(null);
    }

    destroy() {
        this._stopLoop();
    }
}

window.PID = PID;