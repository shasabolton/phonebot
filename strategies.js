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
        const frameG = c.frameSearchGraceMs ?? c.searchGraceMs;
        this.frameSearchGraceMs = Number.isFinite(frameG) ? frameG : 2000;
        const panG = c.panSearchGraceMs ?? c.searchPanWindowMs;
        this.panSearchGraceMs = Number.isFinite(panG) ? panG : 20000;
        /** After panSearchGraceMs from last find, hold yaw at 0 this long (and send filter hint once) before re-arming _lastFindTime. */
        this.changeFilterGraceMs = Number.isFinite(c.changeFilterGraceMs) ? c.changeFilterGraceMs : 20000;
        const validIds = new Set(RobotStrategies.strategyList().map((s) => s.id));
        const want = String(c.defaultStrategy || "trackWithoutSearch").trim();
        this.selectedStrategy = validIds.has(want) ? want : "trackWithoutSearch";
        this._lastFindTime = Date.now();
        this._timer = null;
        this._busy = false;
        this._strategySelect = null;
        this._statusEl = null;
        this._exceededSearchNotificationSent = false;
        /** ms epoch when the exceeded-search agent message was sent; null if not sent this cycle. */
        this._exceededSearchMessageSentAt = null;
        /** True while `submitPromptWithRobotState` is in flight for the exceeded-search notice. */
        this._exceededSearchNotifyPending = false;
        /** Filled in `buildGUI` — shows the long-search notice for the human when no LLM agent is configured. */
        this._exceededNotifyUiEl = null;
        this._stageTitleEl = null;
        this._stageDetailEl = null;
        this._stageTitle = "Ready";
        this._stageDetail = "";
    }

    _setStage(title, detail) {
        this._stageTitle = title != null ? String(title) : "—";
        this._stageDetail = detail != null ? String(detail) : "";
    }

    _formatRemaining(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return "0s";
        if (ms >= 120000) return `${Math.round(ms / 60000)} min`;
        const s = ms / 1000;
        return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
    }

    _flushStageUi() {
        if (this._stageTitleEl) this._stageTitleEl.textContent = this._stageTitle || "—";
        if (this._stageDetailEl) this._stageDetailEl.textContent = this._stageDetail || "";
    }

    _exceededSearchNotifyMessage() {
        return "You have been searching without finding the filtered object for a while. Choose a different filter when possible (one that might appear in the current view) so we can make progress toward the goal.";
    }

    _renderExceededSearchNotice() {
        if (!this._exceededNotifyUiEl) return;
        const msg = this._exceededSearchNotifyMessage();
        this._exceededNotifyUiEl.style.display = "";
        this._exceededNotifyUiEl.textContent = `${msg}\n— ${new Date().toLocaleString()}`;
    }

    _clearExceededSearchNotice() {
        if (!this._exceededNotifyUiEl) return;
        this._exceededNotifyUiEl.textContent = "";
        this._exceededNotifyUiEl.style.display = "none";
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
        this._setStage(
            "Tracking only",
            "Yaw PID stays on. No pan / long-search cycle in this mode."
        );
    }

    /**
     * While the filter sees a target: yaw PID on. For a short grace after loss: PID on.
     * Then for a bounded window: PID off, constant pan yaw.
     * For panSearchGraceMs <= since < panSearchGraceMs + changeFilterGraceMs: yaw 0, notify once, return.
     * After that window: re-arm _lastFindTime (grace → pan → … can repeat).
     * If the object filter's `timeSet` is newer than when the exceeded-search message was sent, re-arm immediately (filter changed during notify hold).
     */
    search360AndTrack() {
        const yawPid = this._getYawPid();
        const filter = this._getMainObjectFilter();
        const yawInput = this.robot.controlInputs?.yawSpeed;
        if (!yawPid || !filter) {
            this._setStage("Unavailable", "Add a yaw PID and an object filter to use search 360°.");
            return;
        }

        const hasObject = this._hasTrackableObject(filter);
        const now = Date.now();

        if (
            !hasObject &&
            this._exceededSearchNotificationSent &&
            Number.isFinite(filter.timeSet) &&
            Number.isFinite(this._exceededSearchMessageSentAt) &&
            filter.timeSet > this._exceededSearchMessageSentAt
        ) {
            this._exceededSearchNotificationSent = false;
            this._exceededSearchMessageSentAt = null;
            this._exceededSearchNotifyPending = false;
            this._lastFindTime = now;
            this._clearExceededSearchNotice();
            this._setStage("Filter updated", "Timing re-armed after a new filter. Grace period restarted.");
        }

        if (hasObject) {//turn pid on and track even if you are search panning
            this._lastFindTime = now;
            this._exceededSearchNotificationSent = false;
            this._exceededSearchMessageSentAt = null;
            this._exceededSearchNotifyPending = false;
            this._clearExceededSearchNotice();
            yawPid.setEnabled(true);
            this._setStage("Tracking", "Target visible — PID is tracking.");
            return;
        }

        const since = now - this._lastFindTime;
        if (since < this.frameSearchGraceMs) {
            yawPid.setEnabled(true);//PID will set yaw to 0 because you have not found the object in the frame
            const left = this.frameSearchGraceMs - since;
            this._setStage(
                "Grace (no target)",
                `Holding PID before pan — ${this._formatRemaining(left)} left until panning.`
            );
            return;
        }
        if (since < this.panSearchGraceMs) {//pan the camera, PID off alows you to do this
            yawPid.setEnabled(false);//stops it setting yawSpeed to 0
            if (yawInput) yawInput.setValue(this.searchPanYaw);
            const left = this.panSearchGraceMs - since;
            this._setStage("Panning", `Searching with constant yaw — ${this._formatRemaining(left)} left until notify phase.`);
            return;
        }

        //send message to the agent as you have not found the object after panning for a while
        const notifyHoldEnd = this.panSearchGraceMs + this.changeFilterGraceMs;
        if (since < notifyHoldEnd) {
            yawPid.setEnabled(true);//PID will prevent panning while you message the agent.
            if (yawInput) yawInput.setValue(0);
            if (!this._exceededSearchNotificationSent && !this._exceededSearchNotifyPending) {
                const ai = this.robot.agentInterface;
                const msg = this._exceededSearchNotifyMessage();
                if (ai && typeof ai.submitPromptWithRobotState === "function") {
                    this._exceededSearchNotifyPending = true;
                    void ai
                        .submitPromptWithRobotState(msg, {
                            contextLabel: "Search strategy (360° track)",
                            speechTranscriber: "strategy"
                        })
                        .then((ok) => {
                            this._exceededSearchNotifyPending = false;
                            if (ok) {
                                this._exceededSearchNotificationSent = true;
                                this._exceededSearchMessageSentAt = Date.now();
                                this._renderExceededSearchNotice();
                            }
                        })
                        .catch((err) => {
                            this._exceededSearchNotifyPending = false;
                            console.error("Strategy → agent notify failed:", err);
                        });
                } else {
                    this._exceededSearchNotificationSent = true;
                    this._exceededSearchMessageSentAt = Date.now();
                    this._renderExceededSearchNotice();
                }
            }
            const left = notifyHoldEnd - since;
            const extra =
                this._exceededSearchNotifyPending
                    ? "Sending notice to agent… "
                    : this._exceededSearchNotificationSent
                      ? "Notice sent — pick a new filter or wait for timeout. "
                      : "";
            this._setStage(
                "Waiting for new filter",
                `${extra}${this._formatRemaining(left)} left in this phase (then cycle re-arms).`
            );
            return;
        }

        this._lastFindTime = now;
        this._exceededSearchNotificationSent = false;
        this._exceededSearchMessageSentAt = null;
        this._exceededSearchNotifyPending = false;
        this._clearExceededSearchNotice();
        this._setStage("Cycle reset", "Starting a new grace → pan → notify sequence.");
    }

    _tick() {
        if (this._busy) return;
        this._busy = true;
        try {
            const fn = this[this.selectedStrategy];
            if (typeof fn === "function") fn.call(this);
            else this._setStage("—", "No handler for this strategy.");
        } catch (err) {
            console.error("Strategy tick failed:", err);
            this._setStage("Error", err?.message || "Strategy tick failed");
        } finally {
            this._busy = false;
            this._flushStageUi();
        }
    }

    setStrategy(strategyId) {
        const id = String(strategyId || "").trim();
        const valid = RobotStrategies.strategyList().some((s) => s.id === id);
        if (!valid) return;
        this.selectedStrategy = id;
        this._lastFindTime = Date.now();
        this._exceededSearchNotificationSent = false;
        this._exceededSearchMessageSentAt = null;
        this._exceededSearchNotifyPending = false;
        this._clearExceededSearchNotice();
        if (this._strategySelect && this._strategySelect.value !== id) {
            this._strategySelect.value = id;
        }
        if (this._statusEl) {
            this._statusEl.textContent = `Strategy: ${id} @ ${this.frequencyHz} Hz`;
        }
        this._setStage("Strategy changed", `Switched to “${id}”. Timing cycle reset.`);
        this._flushStageUi();
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

        const stageHeading = document.createElement("strong");
        stageHeading.textContent = "Stage";
        stageHeading.style.display = "block";
        stageHeading.style.marginTop = "10px";
        const stageTitle = document.createElement("p");
        stageTitle.className = "strategies-stage-title";
        stageTitle.style.margin = "4px 0 0 0";
        stageTitle.textContent = "Ready";
        const stageDetail = document.createElement("p");
        stageDetail.className = "muted strategies-stage-detail";
        stageDetail.style.margin = "2px 0 0 0";
        stageDetail.style.whiteSpace = "pre-wrap";
        stageDetail.textContent = "";

        const noticeLabel = document.createElement("label");
        noticeLabel.textContent = "Long search notice (you or the chat agent)";
        const noticeEl = document.createElement("div");
        noticeEl.className = "muted strategies-exceeded-msg";
        noticeEl.style.whiteSpace = "pre-wrap";
        noticeEl.style.marginTop = "8px";
        noticeEl.style.display = "none";
        noticeEl.textContent = "";

        wrap.appendChild(freqNote);
        wrap.appendChild(label);
        wrap.appendChild(select);
        wrap.appendChild(status);
        wrap.appendChild(stageHeading);
        wrap.appendChild(stageTitle);
        wrap.appendChild(stageDetail);
        wrap.appendChild(noticeLabel);
        wrap.appendChild(noticeEl);
        container.appendChild(wrap);

        this._strategySelect = select;
        this._statusEl = status;
        this._exceededNotifyUiEl = noticeEl;
        this._stageTitleEl = stageTitle;
        this._stageDetailEl = stageDetail;
        this._setStage("Ready", "Strategy runner started.");
        this._flushStageUi();
    }
}

window.RobotStrategies = RobotStrategies;
