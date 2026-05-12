/**
 * High-level behaviors: choose when the yaw tracker PID runs vs when yaw is driven manually.
 * Runs on its own timer at config.frequencyHz (default 10 Hz).
 */
class RobotStrategies {
    static strategyList() {
        return [
            { id: "trackWithoutSearch", label: "Track only (PID on)" },
            { id: "search360AndTrack", label: "Search 360° then track" },
            { id: "manual", label: "Manual (PID off, joystick)" }
        ];
    }

    constructor(robot, config = {}) {
        this.robot = robot;
        const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
        this.frequencyHz = Number.isFinite(c.frequencyHz) && c.frequencyHz > 0 ? c.frequencyHz : 10;
        this.searchPanYaw = Number.isFinite(c.searchPanYaw) ? c.searchPanYaw : 0.05;
        const frameG = c.frameSearchGraceMs ?? c.searchGraceMs;
        this.frameSearchGraceMs = Number.isFinite(frameG) ? frameG : 2000;
        const panG = c.panSearchGraceMs ?? c.searchPanWindowMs;
        this.panSearchGraceMs = Number.isFinite(panG) ? panG : 20000;
        /** After panSearchGraceMs from last find, hold yaw at 0 this long (and send filter hint once) before re-arming _lastFindTime. */
        this.changeFilterGraceMs = Number.isFinite(c.changeFilterGraceMs) ? c.changeFilterGraceMs : 20000;
        /** If true, search360AndTrack may call the agent when the filter target is missing too long; default off. */
        this.letAgentChangeFilter = !!c.letAgentChangeFilter;
        const validIds = new Set(RobotStrategies.strategyList().map((s) => s.id));
        const want = String(c.defaultStrategy || "trackWithoutSearch").trim();
        this.selectedStrategy = validIds.has(want) ? want : "trackWithoutSearch";
        this._lastFindTime = Date.now();
        this._timer = null;
        this._busy = false;
        this._strategySelect = null;
        this._searchPanYawInput = null;
        this._letAgentChangeFilterInput = null;
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
        this._strategyArrowCanvas = null;
        this._strategyArrowCtx = null;
    }

    _getCameraSensor() {
        return this.robot.sensors.find((sensor) => sensor && sensor.type === "camera");
    }

    _getYPid() {
        return (
            this.robot.pidControllers?.find(
                (p) => String(p?.name || "").trim().toLowerCase() === "y object tracker pid"
            ) || null
        );
    }

    /**
     * Same resolution as PID._resolveFeedbackValue: path like mainObjectFilter.result.output.x
     */
    _readPidFeedbackValue(pid) {
        if (!pid) return null;
        const path = String(pid.feedback || "");
        const parts = path.split(".").map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) return null;
        const objectFilter = this.robot.getObjectFilterByName(parts[0]);
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

    _ensureStrategyArrowOverlay() {
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return false;
        if (!this._strategyArrowCanvas) {
            const canvas = document.createElement("canvas");
            canvas.className = "strategy-pid-arrow-overlay";
            frameEl.appendChild(canvas);
            this._strategyArrowCanvas = canvas;
            this._strategyArrowCtx = canvas.getContext("2d");
        }
        return !!this._strategyArrowCtx;
    }

    _resizeStrategyArrowOverlay(videoEl) {
        if (!this._strategyArrowCanvas || !videoEl) return;
        const w = videoEl.clientWidth || videoEl.videoWidth || 0;
        const h = videoEl.clientHeight || videoEl.videoHeight || 0;
        if (!w || !h) return;
        if (this._strategyArrowCanvas.width !== w) this._strategyArrowCanvas.width = w;
        if (this._strategyArrowCanvas.height !== h) this._strategyArrowCanvas.height = h;
    }

    _clearStrategyArrowOverlay() {
        if (!this._strategyArrowCtx || !this._strategyArrowCanvas) return;
        this._strategyArrowCtx.clearRect(0, 0, this._strategyArrowCanvas.width, this._strategyArrowCanvas.height);
    }

    _removeStrategyArrowOverlay() {
        if (this._strategyArrowCanvas?.parentNode) {
            this._strategyArrowCanvas.parentNode.removeChild(this._strategyArrowCanvas);
        }
        this._strategyArrowCanvas = null;
        this._strategyArrowCtx = null;
    }

    /**
     * Normalized coords: x = fraction of frame width, y = fraction of frame height (0,0 top-left).
     */
    _normToOverlayPx(videoEl, nx, ny) {
        const Vision = typeof window !== "undefined" ? window.ComputerVisionAiModel : null;
        if (Vision && typeof Vision.objectFitContainVideoTransform === "function") {
            const t = Vision.objectFitContainVideoTransform(videoEl);
            if (t) {
                return {
                    x: t.offsetX + nx * t.vw * t.scale,
                    y: t.offsetY + ny * t.vh * t.scale
                };
            }
        }
        const vw = videoEl.videoWidth || 1;
        const vh = videoEl.videoHeight || 1;
        const sx = (videoEl.clientWidth || vw) / vw;
        const sy = (videoEl.clientHeight || vh) / vh;
        return { x: nx * vw * sx, y: ny * vh * sy };
    }

    _drawArrowLine(ctx, x0, y0, x1, y1) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) return;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const ah = Math.min(14, len * 0.35);
        const ang = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ah * Math.cos(ang - Math.PI / 7), y1 - ah * Math.sin(ang - Math.PI / 7));
        ctx.lineTo(x1 - ah * Math.cos(ang + Math.PI / 7), y1 - ah * Math.sin(ang + Math.PI / 7));
        ctx.closePath();
        ctx.fill();
    }

    /** Draw arrow from (feedback x, feedback y) to (goal x, goal y) in normalized image space. */
    _drawTrackOnlyPidGoalArrow() {
        const yawPid = this._getYawPid();
        const yPid = this._getYPid();
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!yawPid || !yPid || !videoEl || !videoEl.videoWidth || !videoEl.videoHeight) {
            this._clearStrategyArrowOverlay();
            return;
        }
        if (!this._ensureStrategyArrowOverlay()) return;
        this._resizeStrategyArrowOverlay(videoEl);
        const ctx = this._strategyArrowCtx;
        const cvs = this._strategyArrowCanvas;
        if (!ctx || !cvs?.width) return;

        const fbX = this._readPidFeedbackValue(yawPid);
        const fbY = this._readPidFeedbackValue(yPid);
        const goalX = Number(yawPid.goal);
        const goalY = Number(yPid.goal);
        if (![fbX, fbY, goalX, goalY].every(Number.isFinite)) {
            ctx.clearRect(0, 0, cvs.width, cvs.height);
            return;
        }

        const p0 = this._normToOverlayPx(videoEl, fbX, fbY);
        const p1 = this._normToOverlayPx(videoEl, goalX, goalY);

        ctx.clearRect(0, 0, cvs.width, cvs.height);
        ctx.save();
        ctx.strokeStyle = "#00e676";
        ctx.fillStyle = "#00e676";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.setLineDash([6, 4]);
        this._drawArrowLine(ctx, p0.x, p0.y, p1.x, p1.y);
        ctx.setLineDash([]);
        ctx.fillStyle = "#80ffd0";
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
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

    /**
     * Agent "shift" action: same flow box as tapping the camera frame at (fromX, fromY) in normalized 0–1
     * (or use fromCell 11–99 from intersection labels — resolved to the same point before this runs),
     * then set yaw PID goal to toX and y/speed PID goal to toY (same units as tracker goals, typically 0–1).
     * @param {{ fromX?: number, fromY?: number, fromCell?: number, toX?: number, toY?: number }} spec
     */
    async shiftCameraFeature(spec) {
        const o = typeof spec === "object" && spec ? spec : {};
        let fromX = Number(o.fromX);
        let fromY = Number(o.fromY);
        if (!(Number.isFinite(fromX) && Number.isFinite(fromY)) && o.fromCell != null) {
            const Grid = typeof window !== "undefined" ? window.PhonebotNormalizationGrid : null;
            const p = Grid && typeof Grid.fromCellToNormXY === "function" ? Grid.fromCellToNormXY(o.fromCell) : null;
            if (p) {
                fromX = p.fromX;
                fromY = p.fromY;
            }
        }
        const toX = Number(o.toX);
        const toY = Number(o.toY);
        if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) {
            console.warn("shiftCameraFeature: need numeric fromX, fromY", spec);
            return false;
        }
        const nx = Math.min(1, Math.max(0, fromX));
        const ny = Math.min(1, Math.max(0, fromY));

        const cv =
            (this.robot.getAiModelByType && this.robot.getAiModelByType("computervision")) ||
            this.robot.aiModels?.find((m) => String(m?.type || "").toLowerCase() === "computervision") ||
            null;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        const fw = videoEl?.videoWidth | 0;
        const fh = videoEl?.videoHeight | 0;
        if (!cv || typeof cv.createFlowObjectAt !== "function" || !fw || !fh) {
            console.warn("shiftCameraFeature: computer vision or camera frame unavailable");
            return false;
        }

        const px = nx * fw;
        const py = ny * fh;
        await cv.createFlowObjectAt(px, py);

        const yawPid = this._getYawPid();
        const yPid = this._getYPid();
        if (yawPid && Number.isFinite(toX)) yawPid.setGoal(toX);
        if (yPid && Number.isFinite(toY)) yPid.setGoal(toY);
        return true;
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
        this._drawTrackOnlyPidGoalArrow();
    }

    /** Yaw PID off every tick so joystick / inputs are not overwritten by automation. */
    manual() {
        const yawPid = this._getYawPid();
        if (yawPid) yawPid.setEnabled(false);
        this._setStage(
            "Manual control",
            "Yaw PID is off. Use the joystick — this strategy does not set yaw or re-enable PID."
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
                if (!this.letAgentChangeFilter) {
                    this._exceededSearchNotificationSent = true;
                    this._exceededSearchMessageSentAt = Date.now();
                } else {
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
            }
            const left = notifyHoldEnd - since;
            let extra = "";
            if (!this.letAgentChangeFilter && this._exceededSearchNotificationSent) {
                extra = "Agent filter hint disabled — ";
            } else if (this._exceededSearchNotifyPending) {
                extra = "Sending notice to agent… ";
            } else if (this._exceededSearchNotificationSent) {
                extra = "Notice sent — pick a new filter or wait for timeout. ";
            }
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
            if (this.selectedStrategy !== "trackWithoutSearch") {
                this._clearStrategyArrowOverlay();
            }
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
        this._removeStrategyArrowOverlay();
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

        const panWrap = document.createElement("div");
        panWrap.style.marginTop = "10px";
        const panLabel = document.createElement("label");
        panLabel.style.display = "block";
        panLabel.textContent = "Search pan yaw (360° search phase)";
        const panInput = document.createElement("input");
        panInput.type = "number";
        panInput.step = "0.005";
        panInput.min = "-1";
        panInput.max = "1";
        panInput.value = String(this.searchPanYaw);
        panInput.style.marginTop = "4px";
        panInput.style.width = "100%";
        panInput.style.boxSizing = "border-box";
        const panHint = document.createElement("p");
        panHint.className = "muted";
        panHint.style.margin = "4px 0 0 0";
        panHint.textContent =
            "Constant yaw speed while searching (no target). Ignored in track-only and manual modes.";
        const applyPanYaw = () => {
            const v = Number(panInput.value);
            if (Number.isFinite(v)) {
                this.searchPanYaw = Math.max(-1, Math.min(1, v));
                panInput.value = String(this.searchPanYaw);
            }
        };
        panInput.addEventListener("change", applyPanYaw);
        panInput.addEventListener("blur", applyPanYaw);
        panWrap.appendChild(panLabel);
        panWrap.appendChild(panInput);
        panWrap.appendChild(panHint);

        const agentFilterWrap = document.createElement("label");
        agentFilterWrap.style.display = "flex";
        agentFilterWrap.style.alignItems = "center";
        agentFilterWrap.style.gap = "8px";
        agentFilterWrap.style.marginTop = "10px";
        const agentFilterCb = document.createElement("input");
        agentFilterCb.type = "checkbox";
        agentFilterCb.checked = this.letAgentChangeFilter;
        agentFilterCb.addEventListener("change", () => {
            this.letAgentChangeFilter = !!agentFilterCb.checked;
        });
        agentFilterWrap.appendChild(agentFilterCb);
        agentFilterWrap.appendChild(
            document.createTextNode("Let agent change filter (360° search — notify chat when target missing too long)")
        );
        const agentFilterHint = document.createElement("p");
        agentFilterHint.className = "muted";
        agentFilterHint.style.margin = "4px 0 0 0";
        agentFilterHint.textContent =
            "When off, no agent message is sent during the long-search phase; the hold timer still runs before the cycle resets.";

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
        wrap.appendChild(panWrap);
        wrap.appendChild(agentFilterWrap);
        wrap.appendChild(agentFilterHint);
        wrap.appendChild(status);
        wrap.appendChild(stageHeading);
        wrap.appendChild(stageTitle);
        wrap.appendChild(stageDetail);
        wrap.appendChild(noticeLabel);
        wrap.appendChild(noticeEl);
        container.appendChild(wrap);

        this._strategySelect = select;
        this._searchPanYawInput = panInput;
        this._letAgentChangeFilterInput = agentFilterCb;
        this._statusEl = status;
        this._exceededNotifyUiEl = noticeEl;
        this._stageTitleEl = stageTitle;
        this._stageDetailEl = stageDetail;
        this._setStage("Ready", "Strategy runner started.");
        this._flushStageUi();
    }
}

window.RobotStrategies = RobotStrategies;
