class ObjectFilter {
    constructor(robot, name, config = {}) {
        this.robot = robot;
        this.name = name || config.name || "object filter";
        this.config = config;
        this.dataFeed = config.dataFeed || "coco";
        /** @type {(string|object)[]} strings = class labels (OR semantics); objects = structured rules (label, bbox, …). */
        this.filterCriteria = [];
        this.filters = [];
        this.minScore = Number.isFinite(config.minScore) ? config.minScore : 0.45;
        this.strategy = config.strategy || "largest";
        const or = String(config.outputRange || "zeroToOne").trim();
        this.outputRange = or === "pixels" ? "pixels" : "zeroToOne";
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
        /** ms epoch when filters were last set. Strategies may use this to re-arm search timing after a filter change. */
        this.timeSet = Date.now();

        if (Array.isArray(config.filters) && config.filters.length) {
            this._applyFilterCriteria(this._normalizeFilterSpecList(config.filters), false);
        } else {
            this._syncLabelFiltersFromCriteria();
        }
        this.timeSet = Date.now();
    }

    /**
     * Normalize one entry from JSON into either a lowercase label string or a plain object rule.
     * @param {unknown} item
     * @returns {string|object|null}
     */
    _normalizeOneFilterSpec(item) {
        if (item == null) return null;
        if (typeof item === "string") {
            const s = item.trim().toLowerCase();
            return s.length ? s : null;
        }
        if (typeof item === "number" && Number.isFinite(item)) {
            return String(item).trim().toLowerCase() || null;
        }
        if (typeof item === "object" && !Array.isArray(item)) {
            return { ...item };
        }
        return null;
    }

    _normalizeFilterSpecList(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const item of list) {
            const n = this._normalizeOneFilterSpec(item);
            if (n != null) out.push(n);
        }
        return out;
    }

    /** `this.filters` = label strings only (backward compat, GUI, addFilter). */
    _syncLabelFiltersFromCriteria() {
        const labels = [];
        for (const c of this.filterCriteria) {
            if (typeof c === "string") {
                labels.push(c);
                continue;
            }
            if (c && typeof c === "object") {
                const t = String(c.type || c.kind || "").toLowerCase();
                if (c.label != null) labels.push(String(c.label).trim().toLowerCase());
                else if (c.class != null) labels.push(String(c.class).trim().toLowerCase());
                else if (t === "label" && c.value != null) labels.push(String(c.value).trim().toLowerCase());
            }
        }
        this.filters = [...new Set(labels.filter(Boolean))];
    }

    _applyFilterCriteria(criteria, bumpTime = true) {
        this.filterCriteria = criteria;
        this._syncLabelFiltersFromCriteria();
        if (this._criteriaWantsLastCenter()) {
            const model = this._getFeedModel();
            if (model && typeof model.makeCenterObject === "function") {
                model.makeCenterObject();
            } else {
                const fallback =
                    this.robot?.getProcessingByType?.("computervision") ||
                    this.robot?.getProcessingByName?.("computervision");
                if (fallback && typeof fallback.makeCenterObject === "function") {
                    fallback.makeCenterObject();
                }
            }
        }
        if (this._filterInput) {
            this._filterInput.value = this._formatFiltersForTextInput();
        }
        if (bumpTime) this.timeSet = Date.now();
    }

    _criteriaWantsLastCenter() {
        return this.filterCriteria.some(
            (c) =>
                (typeof c === "string" && c === "lastcenter") ||
                (c &&
                    typeof c === "object" &&
                    String(c.type || c.kind || "").toLowerCase() === "lastcenter")
        );
    }

    _formatFiltersForTextInput() {
        if (!this.filterCriteria.length) return "";
        const allStrings = this.filterCriteria.every((x) => typeof x === "string");
        if (allStrings) return this.filterCriteria.join(", ");
        return JSON.stringify(this.filterCriteria);
    }

    /**
     * Set filter criteria in one argument: comma-separated string, array of strings, array of mixed strings/objects, or one object.
     * @param {string|string[]|object|null|undefined} spec
     */
    setFilters(spec) {
        if (spec == null) {
            this._applyFilterCriteria([]);
            return;
        }
        if (typeof spec === "string") {
            const parts = String(spec)
                .split(",")
                .map((v) => v.trim().toLowerCase())
                .filter((v) => v.length > 0);
            this._applyFilterCriteria(parts);
            return;
        }
        if (Array.isArray(spec)) {
            this._applyFilterCriteria(this._normalizeFilterSpecList(spec));
            return;
        }
        if (typeof spec === "object") {
            const one = this._normalizeOneFilterSpec(spec);
            this._applyFilterCriteria(one ? [one] : []);
            return;
        }
        this._applyFilterCriteria([]);
    }

    setFiltersFromString(text) {
        this.setFilters(text);
    }

    addFilter(filter) {
        const next = this._normalizeOneFilterSpec(filter);
        if (!next) return;
        if (typeof next === "string" && this.filterCriteria.includes(next)) return;
        this.filterCriteria.push(next);
        this._syncLabelFiltersFromCriteria();
        if (this._criteriaWantsLastCenter()) {
            const model = this._getFeedModel();
            if (model && typeof model.makeCenterObject === "function") model.makeCenterObject();
        }
        if (this._filterInput) this._filterInput.value = this._formatFiltersForTextInput();
        this.timeSet = Date.now();
    }

    removeFilter(filter) {
        const key = String(filter || "").trim().toLowerCase();
        if (!key) return;
        this.filterCriteria = this.filterCriteria.filter((c) => {
            if (typeof c === "string") return c !== key;
            if (c && typeof c === "object") {
                const lab =
                    c.label != null
                        ? String(c.label).trim().toLowerCase()
                        : c.class != null
                          ? String(c.class).trim().toLowerCase()
                          : c.value != null && String(c.type || "").toLowerCase() === "label"
                            ? String(c.value).trim().toLowerCase()
                            : null;
                return lab !== key;
            }
            return true;
        });
        this._syncLabelFiltersFromCriteria();
        if (this._filterInput) this._filterInput.value = this._formatFiltersForTextInput();
        this.timeSet = Date.now();
    }

    getResult() {
        return this.result;
    }

    _getFeedModel() {
        return this.robot.getProcessingByType(this.dataFeed) || this.robot.getProcessingByName(this.dataFeed);
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
        const r = String(range || "").trim();
        const normalized = r === "minusOneToOne" ? "zeroToOne" : r;
        const valid = ["zeroToOne", "pixels"];
        if (!valid.includes(normalized)) return;
        this.outputRange = normalized;
        if (this._outputRangeSelect) this._outputRangeSelect.value = normalized;
    }

    setInvertX(nextInvert) {
        this.invertX = !!nextInvert;
        if (this._invertXInput) this._invertXInput.checked = this.invertX;
    }

    _pickDetection(detections) {
        if (!detections.length) return null;
        if (this.strategy === "highestScore") {
            return detections.slice().sort((a, b) => b.score - a.score)[0];
        }
        if (this.strategy === "closestCenter") {
            const centerLine = 0.5;
            return detections.slice().sort((a, b) => {
                const aCx = a.bbox[0] + a.bbox[2] / 2;
                const bCx = b.bbox[0] + b.bbox[2] / 2;
                return Math.abs(aCx - centerLine) - Math.abs(bCx - centerLine);
            })[0];
        }
        return detections.slice().sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
    }

    /**
     * Axis-aligned rectangles [x,y,w,h] intersect (pixel space).
     */
    _bboxIntersects(a, b) {
        const [ax, ay, aw, ah] = a;
        const [bx, by, bw, bh] = b;
        return !(ax + aw < bx || ax > bx + bw || ay + ah < by || ay > by + bh);
    }

    _objectCriterionMatches(detection, c, frameWidth, frameHeight) {
        if (!c || typeof c !== "object") return false;
        const cls = String(detection.class || "").toLowerCase();
        const t = String(c.type || c.kind || "").toLowerCase();

        if (t === "lastcenter") return false;

        if (t === "label" && c.value != null) {
            return cls === String(c.value).trim().toLowerCase();
        }
        if (c.label != null) {
            return cls === String(c.label).trim().toLowerCase();
        }
        if (c.class != null) {
            return cls === String(c.class).trim().toLowerCase();
        }

        if (t === "bbox") {
            const [dx, dy, dw, dh] = detection.bbox;
            const x = Number(c.x);
            const y = Number(c.y);
            const w = Number(c.width ?? c.w);
            const h = Number(c.height ?? c.h);
            if (![x, y, w, h].every(Number.isFinite)) return false;
            return this._bboxIntersects([dx, dy, dw, dh], [x, y, w, h]);
        }

        if (t === "color" || t === "colour") {
            return false;
        }

        if (Array.isArray(c.values) && c.values.length) {
            const set = new Set(c.values.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean));
            return set.has(cls);
        }

        return false;
    }

    _detectionMatchesCriteria(d, frameWidth, frameHeight) {
        if (!this.filterCriteria.length) return true;
        const cls = String(d.class || "").toLowerCase();
        for (const c of this.filterCriteria) {
            if (typeof c === "string") {
                if (cls === c) return true;
                continue;
            }
            if (typeof c === "object" && c && this._objectCriterionMatches(d, c, frameWidth, frameHeight)) {
                return true;
            }
        }
        return false;
    }

    filter() {
        const feedModel = this._getFeedModel();
        if (!feedModel || typeof feedModel.getLatestDetections !== "function") {
            this.result = null;
            return;
        }
        const detections = feedModel.getLatestDetections();
        const frameSize = typeof feedModel.getFrameSize === "function" ? feedModel.getFrameSize() : null;
        const frameWidth = Number(frameSize?.width) || 640;
        const frameHeight = Number(frameSize?.height) || 480;
        const filtered = detections.filter((d) => {
            const scoreOk = Number(d.score) >= this.minScore;
            return scoreOk && this._detectionMatchesCriteria(d, frameWidth, frameHeight);
        });
        const picked = this._pickDetection(filtered);
        if (!picked) {
            this.result = null;
            return;
        }
        const [x, y, width, height] = picked.bbox;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        if (![centerX, centerY].every(Number.isFinite)) {
            this.result = null;
            return;
        }
        const centerX01 = this.invertX ? 1 - centerX : centerX;
        const pixelOffsetRaw = (centerX - 0.5) * frameWidth;
        const pixelOffsetX = Number((this.invertX ? -pixelOffsetRaw : pixelOffsetRaw).toFixed(2));
        const outputX = this.outputRange === "pixels" ? pixelOffsetX : Number(centerX01.toFixed(4));
        this.result = {
            label: picked.class,
            score: Number(picked.score.toFixed(3)),
            bbox: { x, y, width, height },
            center: { x: centerX, y: centerY },
            normalized: { x: centerX01 },
            pixels: { x: pixelOffsetX },
            output: { x: outputX, range: this.outputRange },
            invertX: this.invertX,
            bboxUnit: picked.bboxUnit || "normalized01"
        };
    }

    _renderOutput() {
        if (!this._outputEl) return;
        this._outputEl.textContent = JSON.stringify(
            {
                objectFilter: this.name,
                feed: this.dataFeed,
                filters: this.filters,
                filterCriteria: this.filterCriteria,
                minScore: this.minScore,
                strategy: this.strategy,
                outputRange: this.outputRange,
                invertX: this.invertX,
                result: this.result
            },
            null,
            2
        );
    }

    _tick() {
        if (this._busy || !this.enabled) return;
        this._busy = true;
        try {
            this.filter();
            if (this._statusEl) {
                this._statusEl.className = "muted";
                this._statusEl.textContent = this.result
                    ? `Tracking ${this.result.label} (x=${Number(this.result.output.x).toFixed(3)} ${this.result.output.range === "pixels" ? "px" : "0–1"})`
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
        filtersLabel.textContent = "Filters (comma-separated labels, or JSON array)";
        const filtersInput = document.createElement("input");
        filtersInput.type = "text";
        filtersInput.value = this._formatFiltersForTextInput();
        filtersInput.placeholder = "cup, bottle or [\"cup\",\"bottle\"]";
        filtersInput.addEventListener("change", () => {
            const raw = String(filtersInput.value || "").trim();
            if (!raw) {
                this.setFilters([]);
                return;
            }
            if (raw.startsWith("[")) {
                try {
                    const parsed = JSON.parse(raw);
                    this.setFilters(parsed);
                } catch {
                    this.setFiltersFromString(raw);
                }
            } else {
                this.setFiltersFromString(raw);
            }
        });

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
            { value: "zeroToOne", label: "0 to 1 (0.5 = screen center)" },
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
