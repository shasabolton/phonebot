class ObjectFilter {
    constructor(robot, name, config = {}) {
        this.robot = robot;
        this.name = name || config.name || "object filter";
        this.config = config;
        this.dataFeed = config.dataFeed || "coco";
        this.filters = Array.isArray(config.filters) ? [...config.filters] : [];
        this.minScore = Number.isFinite(config.minScore) ? config.minScore : 0.45;
        this.strategy = config.strategy || "largest";
        this.outputRange = config.outputRange === "pixels" ? "pixels" : "minusOneToOne";
        this.invertX = !!config.invertX;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 0;
        this.runBoundToFeed = !this.frequencyHz || config.frequencyHz === "dataFeed" || config.freq === "dataFeed";
        this.result = null;
        this.enabled = false;
        this._timer = null;
        this._busy = false;
        this._toggleBtn = null;
        this._statusEl = null;
        this._outputEl = null;
        this._freqInput = null;
        this._filterInput = null;
        this._scoreInput = null;
        this._strategySelect = null;
        this._outputRangeSelect = null;
        this._invertXInput = null;
    }

    addFilter(filter) {
        const next = String(filter || "").trim().toLowerCase();
        if (!next || this.filters.includes(next)) return;
        this.filters.push(next);
    }

    removeFilter(filter) {
        const next = String(filter || "").trim().toLowerCase();
        this.filters = this.filters.filter((f) => f !== next);
    }

    getResult() {
        return this.result;
    }

    _getFeedModel() {
        return this.robot.getAiModelByType(this.dataFeed) || this.robot.getAiModelByName(this.dataFeed);
    }

    _resolveFrequencyHz() {
        if (!this.runBoundToFeed && this.frequencyHz > 0) return this.frequencyHz;
        const model = this._getFeedModel();
        if (model && typeof model.getFrequencyHz === "function") {
            const feedHz = Number(model.getFrequencyHz());
            if (Number.isFinite(feedHz) && feedHz > 0) return feedHz;
        }
        return 1;
    }

    setFiltersFromString(text) {
        this.filters = String(text || "")
            .split(",")
            .map((v) => v.trim().toLowerCase())
            .filter((v) => v.length > 0);
        if (this._filterInput) {
            this._filterInput.value = this.filters.join(", ");
        }
    }

    setMinScore(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        this.minScore = Math.max(0, Math.min(1, parsed));
        if (this._scoreInput) this._scoreInput.value = String(this.minScore);
    }

    setFrequencyHz(value) {
        if (String(value) === "dataFeed") {
            this.runBoundToFeed = true;
            this.frequencyHz = 0;
        } else {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) return;
            this.runBoundToFeed = false;
            this.frequencyHz = Math.max(0.2, Math.min(20, parsed));
        }
        if (this.enabled) this._startLoop();
    }

    setStrategy(strategy) {
        const valid = ["largest", "highestScore", "closestCenter"];
        if (!valid.includes(strategy)) return;
        this.strategy = strategy;
        if (this._strategySelect) this._strategySelect.value = strategy;
    }

    setOutputRange(range) {
        const valid = ["minusOneToOne", "pixels"];
        if (!valid.includes(range)) return;
        this.outputRange = range;
        if (this._outputRangeSelect) this._outputRangeSelect.value = range;
    }

    setInvertX(nextInvert) {
        this.invertX = !!nextInvert;
        if (this._invertXInput) this._invertXInput.checked = this.invertX;
    }

    _pickDetection(detections, frameWidth) {
        if (!detections.length) return null;
        if (this.strategy === "highestScore") {
            return detections.slice().sort((a, b) => b.score - a.score)[0];
        }
        if (this.strategy === "closestCenter") {
            const centerX = frameWidth / 2;
            return detections.slice().sort((a, b) => {
                const aCx = a.bbox[0] + a.bbox[2] / 2;
                const bCx = b.bbox[0] + b.bbox[2] / 2;
                return Math.abs(aCx - centerX) - Math.abs(bCx - centerX);
            })[0];
        }
        return detections.slice().sort((a, b) => (b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3]))[0];
    }

    filter() {
        const feedModel = this._getFeedModel();
        if (!feedModel || typeof feedModel.getLatestDetections !== "function") {
            this.result = null;
            return;
        }
        const detections = feedModel.getLatestDetections();
        const filtered = detections.filter((d) => {
            const scoreOk = Number(d.score) >= this.minScore;
            const filterOk = !this.filters.length || this.filters.includes(String(d.class || "").toLowerCase());
            return scoreOk && filterOk;
        });
        const frameSize = typeof feedModel.getFrameSize === "function" ? feedModel.getFrameSize() : null;
        const frameWidth = Number(frameSize?.width) || 640;
        const picked = this._pickDetection(filtered, frameWidth);
        if (!picked) {
            this.result = null;
            return;
        }
        const [x, y, width, height] = picked.bbox;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const normalizedXRaw = (((centerX / frameWidth) * 2) - 1);
        const normalizedX = Number((this.invertX ? -normalizedXRaw : normalizedXRaw).toFixed(4));
        const pixelOffsetRaw = centerX - (frameWidth / 2);
        const pixelOffsetX = Number((this.invertX ? -pixelOffsetRaw : pixelOffsetRaw).toFixed(2));
        const outputX = this.outputRange === "pixels" ? pixelOffsetX : normalizedX;
        this.result = {
            label: picked.class,
            score: Number(picked.score.toFixed(3)),
            bbox: { x, y, width, height },
            center: { x: centerX, y: centerY },
            normalized: { x: normalizedX },
            pixels: { x: pixelOffsetX },
            output: { x: outputX, range: this.outputRange },
            invertX: this.invertX
        };
    }

    _renderOutput() {
        if (!this._outputEl) return;
        this._outputEl.textContent = JSON.stringify({
            objectFilter: this.name,
            feed: this.dataFeed,
            filters: this.filters,
            minScore: this.minScore,
            strategy: this.strategy,
            outputRange: this.outputRange,
            invertX: this.invertX,
            result: this.result
        }, null, 2);
    }

    _tick() {
        if (this._busy || !this.enabled) return;
        this._busy = true;
        try {
            this.filter();
            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = this.result
                    ? `Tracking ${this.result.label} (x=${Number(this.result.output.x).toFixed(3)} ${this.result.output.range === "pixels" ? "px" : ""})`
                    : "No matching object found.";
            }
            this._renderOutput();
        } catch (err) {
            console.error("Object filter error:", err);
            if (this._statusEl) {
                this._statusEl.className = "error";
                this._statusEl.textContent = `Object filter error: ${err?.message || "unknown error"}`;
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
            this._startLoop();
        } else {
            this._stopLoop();
            this.result = null;
            this._renderOutput();
            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = "Object filter off.";
            }
        }
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model tracker-panel";

        const title = document.createElement("h4");
        title.textContent = `Object filter: ${this.name}`;

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", () => this.setEnabled(!this.enabled));

        const filtersLabel = document.createElement("label");
        filtersLabel.textContent = "Filters (comma separated labels)";
        const filtersInput = document.createElement("input");
        filtersInput.type = "text";
        filtersInput.value = this.filters.join(", ");
        filtersInput.placeholder = "cup, bottle";
        filtersInput.addEventListener("change", () => this.setFiltersFromString(filtersInput.value));

        const scoreLabel = document.createElement("label");
        scoreLabel.textContent = "Minimum score (0-1)";
        const scoreInput = document.createElement("input");
        scoreInput.type = "number";
        scoreInput.min = "0";
        scoreInput.max = "1";
        scoreInput.step = "0.05";
        scoreInput.value = String(this.minScore);
        scoreInput.addEventListener("change", () => this.setMinScore(scoreInput.value));

        const strategyLabel = document.createElement("label");
        strategyLabel.textContent = "Selection strategy";
        const strategySelect = document.createElement("select");
        [
            { value: "largest", label: "Largest bbox" },
            { value: "highestScore", label: "Highest score" },
            { value: "closestCenter", label: "Closest to center" }
        ].forEach((optCfg) => {
            const option = document.createElement("option");
            option.value = optCfg.value;
            option.textContent = optCfg.label;
            strategySelect.appendChild(option);
        });
        strategySelect.value = this.strategy;
        strategySelect.addEventListener("change", () => this.setStrategy(strategySelect.value));

        const outputRangeLabel = document.createElement("label");
        outputRangeLabel.textContent = "Output range";
        const outputRangeSelect = document.createElement("select");
        [
            { value: "minusOneToOne", label: "-1 to 1 (normalized)" },
            { value: "pixels", label: "Pixels from center" }
        ].forEach((optCfg) => {
            const option = document.createElement("option");
            option.value = optCfg.value;
            option.textContent = optCfg.label;
            outputRangeSelect.appendChild(option);
        });
        outputRangeSelect.value = this.outputRange;
        outputRangeSelect.addEventListener("change", () => this.setOutputRange(outputRangeSelect.value));

        const invertWrap = document.createElement("label");
        invertWrap.textContent = "Invert X";
        const invertInput = document.createElement("input");
        invertInput.type = "checkbox";
        invertInput.checked = this.invertX;
        invertInput.addEventListener("change", () => this.setInvertX(invertInput.checked));
        invertWrap.appendChild(invertInput);

        const freqLabel = document.createElement("label");
        freqLabel.textContent = "Frequency (Hz, or 0 for data feed)";
        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = "0";
        freqInput.max = "20";
        freqInput.step = "0.2";
        freqInput.value = this.runBoundToFeed ? "0" : String(this.frequencyHz || 0);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Object filter off.";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        wrap.appendChild(title);
        wrap.appendChild(toggleBtn);
        wrap.appendChild(filtersLabel);
        wrap.appendChild(filtersInput);
        wrap.appendChild(scoreLabel);
        wrap.appendChild(scoreInput);
        wrap.appendChild(strategyLabel);
        wrap.appendChild(strategySelect);
        wrap.appendChild(outputRangeLabel);
        wrap.appendChild(outputRangeSelect);
        wrap.appendChild(invertWrap);
        wrap.appendChild(freqLabel);
        wrap.appendChild(freqInput);
        wrap.appendChild(status);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._statusEl = status;
        this._outputEl = output;
        this._freqInput = freqInput;
        this._filterInput = filtersInput;
        this._scoreInput = scoreInput;
        this._strategySelect = strategySelect;
        this._outputRangeSelect = outputRangeSelect;
        this._invertXInput = invertInput;
        this._renderOutput();
    }

    destroy() {
        this._stopLoop();
    }
}

window.ObjectFilter = ObjectFilter;
