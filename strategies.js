/**
 * High-level behaviors: choose when the yaw tracker PID runs vs when yaw is driven manually.
 * Runs on its own timer at config.frequencyHz (default 10 Hz).
 */
class RobotStrategies {
    static strategyList() {
        return [
            { id: "trackWithoutSearch", label: "Track only (PID on)" },
            { id: "search360AndTrack", label: "Search 360° then track" }
        ];
    }

    constructor(robot, config = {}) {
        this.robot = robot;
        const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
        this.frequencyHz = Number.isFinite(c.frequencyHz) && c.frequencyHz > 0 ? c.frequencyHz : 10;
        this.searchPanYaw = Number.isFinite(c.searchPanYaw) ? c.searchPanYaw : 0.2;
        this.searchGraceMs = Number.isFinite(c.searchGraceMs) ? c.searchGraceMs : 2000;
        this.searchPanWindowMs = Number.isFinite(c.searchPanWindowMs) ? c.searchPanWindowMs : 10000;
        const validIds = new Set(RobotStrategies.strategyList().map((s) => s.id));
        const want = String(c.defaultStrategy || "trackWithoutSearch").trim();
        this.selectedStrategy = validIds.has(want) ? want : "trackWithoutSearch";
        this._lastFindTime = Date.now();
        this._timer = null;
        this._busy = false;
        this._strategySelect = null;
        this._statusEl = null;
        this._search360Notified = false;
    }

    _getYawPid() {
        return (
            this.robot.pidControllers?.find(
                (p) => String(p?.name || "").trim().toLowerCase() === "yaw object tracker pid"
            ) ||
            this.robot.pidControllers?.[0] ||
            null
        );
    }

    _getMainObjectFilter() {
        return this.robot.getObjectFilterByName("mainObjectFilter") || this.robot.objectFilters?.[0] || null;
    }

    _hasTrackableObject(filter) {
        if (!filter) return false;
        const res = filter.getResult();
        if (!res || res.output == null) return false;
        const x = Number(res.output.x);
        return Number.isFinite(x);
    }

    trackWithoutSearch() {
        const yawPid = this._getYawPid();
        if (yawPid) yawPid.setEnabled(true);
    }

    /**
     * While the filter sees a target: yaw PID on. For a short grace after loss: PID on.
     * Then for a bounded window: PID off, constant pan yaw. After that: PID off, yaw zero.
     */
    search360AndTrack() {
        const yawPid = this._getYawPid();
        const filter = this._getMainObjectFilter();
        const yawInput = this.robot.controlInputs?.yawSpeed;
        if (!yawPid || !filter) return;

        const hasObject = this._hasTrackableObject(filter);
        const now = Date.now();

        if (hasObject) {
            this._lastFindTime = now;
            this._search360Notified = false;
            yawPid.setEnabled(true);
            return;
        }

        const since = now - this._lastFindTime;
        if (since < this.searchGraceMs) {
            yawPid.setEnabled(true);
            return;
        }
        if (since < this.searchPanWindowMs) {
            yawPid.setEnabled(false);
            if (yawInput) yawInput.setValue(this.searchPanYaw);
            return;
        }

        yawPid.setEnabled(false);
        if (yawInput) yawInput.setValue(0);
        if (!this._search360Notified) {
            this._search360Notified = true;
            console.info(
                "[RobotStrategies] search360AndTrack: long search without target; consider a different filter or goal."
            );
        }
    }

    _tick() {
        if (this._busy) return;
        this._busy = true;
        try {
            const fn = this[this.selectedStrategy];
            if (typeof fn === "function") fn.call(this);
        } catch (err) {
            console.error("Strategy tick failed:", err);
        } finally {
            this._busy = false;
        }
    }

    setStrategy(strategyId) {
        const id = String(strategyId || "").trim();
        const valid = RobotStrategies.strategyList().some((s) => s.id === id);
        if (!valid) return;
        this.selectedStrategy = id;
        this._lastFindTime = Date.now();
        this._search360Notified = false;
        if (this._strategySelect && this._strategySelect.value !== id) {
            this._strategySelect.value = id;
        }
        if (this._statusEl) {
            this._statusEl.textContent = `Strategy: ${id} @ ${this.frequencyHz} Hz`;
        }
    }

    start() {
        if (this._timer) return;
        const intervalMs = Math.max(50, Math.round(1000 / this.frequencyHz));
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }

    destroy() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model strategies-panel";

        const freqNote = document.createElement("p");
        freqNote.className = "muted";
        freqNote.textContent = `Tick rate: ${this.frequencyHz} Hz`;

        const label = document.createElement("label");
        label.textContent = "Active strategy";
        const select = document.createElement("select");
        for (const { id, label: text } of RobotStrategies.strategyList()) {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = text;
            select.appendChild(opt);
        }
        select.value = this.selectedStrategy;
        select.addEventListener("change", () => this.setStrategy(select.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = `Strategy: ${this.selectedStrategy} @ ${this.frequencyHz} Hz`;

        wrap.appendChild(freqNote);
        wrap.appendChild(label);
        wrap.appendChild(select);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._strategySelect = select;
        this._statusEl = status;
    }
}

window.RobotStrategies = RobotStrategies;
