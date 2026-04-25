class GroqVisionAiModel {
    static MIN_FREQUENCY_HZ = 0.2;
    static MAX_FREQUENCY_HZ = 2;
    static MIN_TICK_INTERVAL_MS = 300;
    static STORAGE_KEY_API = "phonebot.groq.apiKey";
    static STORAGE_KEY_MODEL = "phonebot.groq.model";
    static STORAGE_KEY_REMEMBER = "phonebot.groq.remember";

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "groqvision";
        this.name = config.name || "Groq Vision";
        this.enabled = false;
        this.frequencyHz = Number.isFinite(config.frequencyHz) ? config.frequencyHz : 1;
        this.frequencyHz = Math.max(
            GroqVisionAiModel.MIN_FREQUENCY_HZ,
            Math.min(GroqVisionAiModel.MAX_FREQUENCY_HZ, this.frequencyHz)
        );
        this.model = String(config.model || "meta-llama/llama-4-scout-17b-16e-instruct");
        this.apiKey = "";
        this.rememberKey = false;
        this._timer = null;
        this._running = false;
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._detections = [];
        this._sceneDescription = "";
        this._rateLimits = {};
        this._frameWidth = 0;
        this._frameHeight = 0;
        this._toggleBtn = null;
        this._freqInput = null;
        this._keyInput = null;
        this._modelInput = null;
        this._rememberInput = null;
        this._statusEl = null;
        this._outputEl = null;
        this._limitsEl = null;

        this._loadSavedSettings();
    }

    _loadSavedSettings() {
        try {
            const remember = localStorage.getItem(GroqVisionAiModel.STORAGE_KEY_REMEMBER);
            this.rememberKey = remember === "true";
            const savedModel = localStorage.getItem(GroqVisionAiModel.STORAGE_KEY_MODEL);
            if (savedModel) this.model = savedModel;
            if (this.rememberKey) {
                const savedKey = localStorage.getItem(GroqVisionAiModel.STORAGE_KEY_API);
                if (savedKey) this.apiKey = savedKey;
            }
        } catch (_) {
            this.rememberKey = false;
        }
    }

    _persistSettings() {
        try {
            localStorage.setItem(GroqVisionAiModel.STORAGE_KEY_MODEL, this.model);
            localStorage.setItem(GroqVisionAiModel.STORAGE_KEY_REMEMBER, this.rememberKey ? "true" : "false");
            if (this.rememberKey && this.apiKey) {
                localStorage.setItem(GroqVisionAiModel.STORAGE_KEY_API, this.apiKey);
            } else {
                localStorage.removeItem(GroqVisionAiModel.STORAGE_KEY_API);
            }
        } catch (_) {
            // Ignore storage errors (private mode / restricted storage).
        }
    }

    _getCameraSensor() {
        return this.robot.sensors.find((sensor) => sensor && sensor.type === "camera");
    }

    _ensureOverlay() {
        if (this._overlayCanvas) return true;
        const camera = this._getCameraSensor();
        const frameEl = camera?.getFrameElement?.();
        if (!frameEl) return false;
        const canvas = document.createElement("canvas");
        canvas.className = "sensor-camera-overlay";
        frameEl.appendChild(canvas);
        this._overlayCanvas = canvas;
        this._overlayCtx = canvas.getContext("2d");
        return true;
    }

    _resizeOverlayToVideo(videoEl) {
        if (!this._overlayCanvas) return;
        const w = videoEl.clientWidth || videoEl.videoWidth || 0;
        const h = videoEl.clientHeight || videoEl.videoHeight || 0;
        if (!w || !h) return;
        if (this._overlayCanvas.width !== w) this._overlayCanvas.width = w;
        if (this._overlayCanvas.height !== h) this._overlayCanvas.height = h;
    }

    _clearOverlay() {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._overlayCtx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
    }

    _drawDetections(videoEl, detections) {
        if (!this._overlayCtx || !this._overlayCanvas) return;
        this._resizeOverlayToVideo(videoEl);
        this._clearOverlay();
        const ctx = this._overlayCtx;
        const widthScale = (videoEl.clientWidth || videoEl.videoWidth) / videoEl.videoWidth;
        const heightScale = (videoEl.clientHeight || videoEl.videoHeight) / videoEl.videoHeight;
        ctx.lineWidth = 2;
        ctx.font = "12px Arial";
        ctx.textBaseline = "top";

        detections.forEach((item) => {
            const [x, y, w, h] = item.bbox;
            const bx = x * widthScale;
            const by = y * heightScale;
            const bw = w * widthScale;
            const bh = h * heightScale;
            const label = `${item.class} ${(item.score * 100).toFixed(0)}%`;

            ctx.strokeStyle = "#ffcc00";
            ctx.strokeRect(bx, by, bw, bh);
            const labelW = ctx.measureText(label).width + 8;
            const labelH = 16;
            ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
            ctx.fillRect(bx, Math.max(0, by - labelH), labelW, labelH);
            ctx.fillStyle = "#ffcc00";
            ctx.fillText(label, bx + 4, Math.max(0, by - labelH + 2));
        });
    }

    _renderResponseOutput() {
        if (!this._outputEl) return;
        const response = {
            model: this.type,
            groqModel: this.model,
            detectedAt: new Date().toISOString(),
            objectCount: this._detections.length,
            sceneDescription: this._sceneDescription,
            rateLimits: this._rateLimits,
            objects: this._detections.map((item) => ({
                name: item.class,
                score: Number(item.score.toFixed(3)),
                bbox: {
                    x: Number(item.bbox[0].toFixed(1)),
                    y: Number(item.bbox[1].toFixed(1)),
                    width: Number(item.bbox[2].toFixed(1)),
                    height: Number(item.bbox[3].toFixed(1))
                }
            }))
        };
        this._outputEl.textContent = JSON.stringify(response, null, 2);
    }

    _captureRateLimitHeaders(res) {
        if (!res?.headers) return;
        const next = {};
        const readNum = (name) => {
            const raw = res.headers.get(name);
            if (raw == null) return null;
            const parsed = Number(String(raw).replace(/,/g, ""));
            return Number.isFinite(parsed) ? parsed : null;
        };
        const readText = (name) => {
            const raw = res.headers.get(name);
            return raw == null ? "" : String(raw).trim();
        };

        const requestLimit = readNum("x-ratelimit-limit-requests");
        const requestRemaining = readNum("x-ratelimit-remaining-requests");
        const requestReset = readText("x-ratelimit-reset-requests");
        if (requestLimit != null || requestRemaining != null || requestReset) {
            next.requestsPerDay = {
                label: "Requests per day",
                limit: requestLimit,
                remaining: requestRemaining,
                reset: requestReset
            };
        }

        const tokenLimit = readNum("x-ratelimit-limit-tokens");
        const tokenRemaining = readNum("x-ratelimit-remaining-tokens");
        const tokenReset = readText("x-ratelimit-reset-tokens");
        if (tokenLimit != null || tokenRemaining != null || tokenReset) {
            next.tokensPerMinute = {
                label: "Tokens per minute",
                limit: tokenLimit,
                remaining: tokenRemaining,
                reset: tokenReset
            };
        }

        const retryAfterRaw = readText("retry-after");
        if (retryAfterRaw) {
            const retrySeconds = Number(retryAfterRaw);
            next.retryAfter = {
                label: "Retry after",
                limit: Number.isFinite(retrySeconds) ? retrySeconds : null,
                remaining: null,
                reset: retryAfterRaw ? `${retryAfterRaw}s` : ""
            };
        }

        if (Object.keys(next).length) {
            this._rateLimits = { ...this._rateLimits, ...next };
            this._renderRateLimits();
        }
    }

    _renderRateLimits() {
        if (!this._limitsEl) return;
        this._limitsEl.innerHTML = "";

        const entries = Object.values(this._rateLimits || {});
        if (!entries.length) {
            const none = document.createElement("p");
            none.className = "muted";
            none.textContent = "No rate-limit headers received yet.";
            this._limitsEl.appendChild(none);
            return;
        }

        for (const entry of entries) {
            const row = document.createElement("div");
            row.style.marginBottom = "8px";

            const limit = Number(entry.limit);
            const remaining = Number(entry.remaining);
            const hasNumbers = Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0;
            const used = hasNumbers ? Math.max(0, Math.min(limit, limit - remaining)) : null;
            const usedPct = hasNumbers ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;

            const title = document.createElement("div");
            title.className = "muted";
            title.style.marginBottom = "2px";
            if (hasNumbers) {
                title.textContent = `${entry.label}: ${Math.round(used)} / ${Math.round(limit)} used`;
            } else {
                title.textContent = `${entry.label}: ${entry.reset || "n/a"}`;
            }

            const barWrap = document.createElement("div");
            barWrap.style.height = "8px";
            barWrap.style.background = "#ddd";
            barWrap.style.borderRadius = "4px";
            barWrap.style.overflow = "hidden";

            const bar = document.createElement("div");
            bar.style.height = "100%";
            bar.style.width = `${usedPct}%`;
            bar.style.background = usedPct >= 90 ? "#d9534f" : usedPct >= 75 ? "#f0ad4e" : "#5cb85c";
            barWrap.appendChild(bar);

            const footer = document.createElement("div");
            footer.className = "muted";
            footer.style.fontSize = "0.85em";
            footer.style.marginTop = "2px";
            if (hasNumbers) {
                const remainingText = `${Math.max(0, Math.round(remaining))} remaining`;
                const resetText = entry.reset ? `, resets in ${entry.reset}` : "";
                footer.textContent = `${remainingText}${resetText}`;
            } else {
                footer.textContent = entry.reset ? `Resets in ${entry.reset}` : "";
            }

            row.appendChild(title);
            row.appendChild(barWrap);
            row.appendChild(footer);
            this._limitsEl.appendChild(row);
        }
    }

    _captureFrameDataUrl(videoEl) {
        const sourceW = videoEl.videoWidth | 0;
        const sourceH = videoEl.videoHeight | 0;
        if (!sourceW || !sourceH) return null;
        const maxEdge = 640;
        const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
        const targetW = Math.max(1, Math.round(sourceW * scale));
        const targetH = Math.max(1, Math.round(sourceH * scale));
        if (!this._captureCanvas) this._captureCanvas = document.createElement("canvas");
        if (!this._captureCtx) this._captureCtx = this._captureCanvas.getContext("2d", { willReadFrequently: true });
        if (!this._captureCtx) return null;
        this._captureCanvas.width = targetW;
        this._captureCanvas.height = targetH;
        this._captureCtx.drawImage(videoEl, 0, 0, targetW, targetH);
        return {
            dataUrl: this._captureCanvas.toDataURL("image/jpeg", 0.7),
            width: targetW,
            height: targetH
        };
    }

    _extractJsonObject(text) {
        const raw = String(text || "").trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            const candidate = fenceMatch ? fenceMatch[1] : raw;
            const start = candidate.indexOf("{");
            const end = candidate.lastIndexOf("}");
            if (start >= 0 && end > start) {
                try {
                    return JSON.parse(candidate.slice(start, end + 1));
                } catch (_) {
                    return null;
                }
            }
            return null;
        }
    }

    _normalizeDetections(payload, frameWidth, frameHeight) {
        const list = Array.isArray(payload?.detections) ? payload.detections : [];
        const normalized = [];
        for (const item of list) {
            const label = String(item?.label || item?.class || "").trim();
            if (!label) continue;
            const scoreRaw = Number(item?.score);
            const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(1, scoreRaw)) : 0.5;
            const box = item?.bbox || {};
            const xNorm = Number(box?.x);
            const yNorm = Number(box?.y);
            const wNorm = Number(box?.width);
            const hNorm = Number(box?.height);
            if (![xNorm, yNorm, wNorm, hNorm].every(Number.isFinite)) continue;
            const x = Math.max(0, Math.min(frameWidth, xNorm * frameWidth));
            const y = Math.max(0, Math.min(frameHeight, yNorm * frameHeight));
            const width = Math.max(1, Math.min(frameWidth - x, wNorm * frameWidth));
            const height = Math.max(1, Math.min(frameHeight - y, hNorm * frameHeight));
            normalized.push({
                class: label,
                score,
                bbox: [x, y, width, height]
            });
        }
        return normalized;
    }

    async _queryGroq(imageDataUrl, frameWidth, frameHeight) {
        if (!this.apiKey) {
            throw new Error("Enter a Groq API key.");
        }
        const prompt = [
            "Analyze this image and return JSON only.",
            "Schema:",
            "{",
            '  "sceneDescription": "short sentence",',
            '  "detections": [',
            "    {",
            '      "label": "object label",',
            '      "score": 0.0,',
            '      "bbox": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 }',
            "    }",
            "  ]",
            "}",
            "bbox values must be normalized to 0..1 relative to image width/height.",
            "Only include clearly visible objects."
        ].join("\n");

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                temperature: 0.2,
                max_tokens: 700,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image_url", image_url: { url: imageDataUrl } }
                        ]
                    }
                ]
            })
        });
        this._captureRateLimitHeaders(res);

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Groq request failed (${res.status}): ${body || "unknown error"}`);
        }

        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content;
        const parsed = this._extractJsonObject(text);
        if (!parsed) {
            throw new Error("Could not parse JSON response from Groq.");
        }
        const detections = this._normalizeDetections(parsed, frameWidth, frameHeight);
        const sceneDescription = String(parsed?.sceneDescription || "").trim();
        return { detections, sceneDescription };
    }

    async _tick() {
        if (this._running || !this.enabled) return;
        const camera = this._getCameraSensor();
        const videoEl = camera?.getVideoElement?.();
        if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight || videoEl.readyState < 2) {
            if (this._statusEl) this._statusEl.textContent = "Waiting for camera stream...";
            return;
        }
        this._running = true;
        try {
            this._ensureOverlay();
            this._frameWidth = videoEl.videoWidth || 0;
            this._frameHeight = videoEl.videoHeight || 0;
            const frame = this._captureFrameDataUrl(videoEl);
            if (!frame) throw new Error("Could not capture camera frame.");
            const result = await this._queryGroq(frame.dataUrl, this._frameWidth, this._frameHeight);
            this._detections = result.detections;
            this._sceneDescription = result.sceneDescription;
            this._drawDetections(videoEl, this._detections);
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = `Running: ${this._detections.length} object(s)`;
                this._statusEl.className = "muted";
            }
        } catch (err) {
            console.error("Groq vision error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = `Groq error: ${err?.message || "unknown error"}`;
                this._statusEl.className = "error";
            }
        } finally {
            this._running = false;
        }
    }

    _startLoop() {
        this._stopLoop();
        const intervalMs = Math.max(
            GroqVisionAiModel.MIN_TICK_INTERVAL_MS,
            Math.round(1000 / this.frequencyHz)
        );
        this._timer = setInterval(() => this._tick(), intervalMs);
        this._tick();
    }

    _stopLoop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async setEnabled(nextEnabled) {
        this.enabled = !!nextEnabled;
        if (this._toggleBtn) this._toggleBtn.textContent = this.enabled ? "On" : "Off";
        if (this.enabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Starting Groq vision model...";
                this._statusEl.className = "muted";
            }
            this._startLoop();
        } else {
            this._stopLoop();
            this._detections = [];
            this._sceneDescription = "";
            this._clearOverlay();
            this._renderResponseOutput();
            if (this._statusEl) {
                this._statusEl.textContent = "Model off.";
                this._statusEl.className = "muted";
            }
        }
    }

    setFrequencyHz(nextHz) {
        const parsed = Number(nextHz);
        if (!Number.isFinite(parsed)) return;
        this.frequencyHz = Math.max(
            GroqVisionAiModel.MIN_FREQUENCY_HZ,
            Math.min(GroqVisionAiModel.MAX_FREQUENCY_HZ, parsed)
        );
        if (this._freqInput) this._freqInput.value = String(this.frequencyHz);
        if (this.enabled) this._startLoop();
    }

    getFrequencyHz() {
        return this.frequencyHz;
    }

    getLatestDetections() {
        return this._detections.map((item) => ({
            class: item.class,
            score: item.score,
            bbox: Array.isArray(item.bbox) ? [...item.bbox] : [0, 0, 0, 0]
        }));
    }

    getFrameSize() {
        return { width: this._frameWidth, height: this._frameHeight };
    }

    getSceneDescription() {
        return this._sceneDescription;
    }

    setModel(nextModel) {
        const normalized = String(nextModel || "").trim();
        if (!normalized) return;
        this.model = normalized;
        if (this._modelInput) this._modelInput.value = this.model;
        this._persistSettings();
    }

    setApiKey(nextKey) {
        this.apiKey = String(nextKey || "").trim();
        if (this._keyInput) this._keyInput.value = this.apiKey;
        this._persistSettings();
    }

    setRememberKey(nextRemember) {
        this.rememberKey = !!nextRemember;
        if (this._rememberInput) this._rememberInput.checked = this.rememberKey;
        this._persistSettings();
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-groqvision";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "ai-model-toggle-btn";
        toggleBtn.textContent = "Off";
        toggleBtn.addEventListener("click", async () => {
            toggleBtn.disabled = true;
            await this.setEnabled(!this.enabled);
            toggleBtn.disabled = false;
        });

        const keyLabel = document.createElement("label");
        keyLabel.textContent = "Groq API key";
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.placeholder = "gsk_...";
        keyInput.autocomplete = "off";
        keyInput.value = this.apiKey;
        keyInput.addEventListener("change", () => this.setApiKey(keyInput.value));
        keyInput.addEventListener("blur", () => this.setApiKey(keyInput.value));

        const rememberLabel = document.createElement("label");
        rememberLabel.textContent = "Remember key on this browser";
        const rememberInput = document.createElement("input");
        rememberInput.type = "checkbox";
        rememberInput.checked = this.rememberKey;
        rememberInput.addEventListener("change", () => this.setRememberKey(rememberInput.checked));
        rememberLabel.appendChild(rememberInput);

        const modelLabel = document.createElement("label");
        modelLabel.textContent = "Groq model ID";
        const modelInput = document.createElement("input");
        modelInput.type = "text";
        modelInput.value = this.model;
        modelInput.addEventListener("change", () => this.setModel(modelInput.value));
        modelInput.addEventListener("blur", () => this.setModel(modelInput.value));

        const freqLabel = document.createElement("label");
        freqLabel.textContent = "Vision frequency (Hz)";
        const freqInput = document.createElement("input");
        freqInput.type = "number";
        freqInput.min = String(GroqVisionAiModel.MIN_FREQUENCY_HZ);
        freqInput.max = String(GroqVisionAiModel.MAX_FREQUENCY_HZ);
        freqInput.step = "0.2";
        freqInput.value = String(this.frequencyHz);
        freqInput.addEventListener("change", () => this.setFrequencyHz(freqInput.value));
        freqInput.addEventListener("blur", () => this.setFrequencyHz(freqInput.value));

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Model off.";

        const limitsTitle = document.createElement("p");
        limitsTitle.className = "muted";
        limitsTitle.textContent = "Rate limits";

        const limits = document.createElement("div");
        limits.className = "ai-model-limits";

        const output = document.createElement("pre");
        output.className = "ai-model-output";
        output.textContent = "{}";

        controls.appendChild(toggleBtn);
        controls.appendChild(keyLabel);
        controls.appendChild(keyInput);
        controls.appendChild(rememberLabel);
        controls.appendChild(modelLabel);
        controls.appendChild(modelInput);
        controls.appendChild(freqLabel);
        controls.appendChild(freqInput);
        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        wrap.appendChild(limitsTitle);
        wrap.appendChild(limits);
        wrap.appendChild(output);
        container.appendChild(wrap);

        this._toggleBtn = toggleBtn;
        this._freqInput = freqInput;
        this._keyInput = keyInput;
        this._modelInput = modelInput;
        this._rememberInput = rememberInput;
        this._statusEl = status;
        this._limitsEl = limits;
        this._outputEl = output;
        this._renderRateLimits();
    }

    destroy() {
        this._stopLoop();
        this._clearOverlay();
        if (this._overlayCanvas && this._overlayCanvas.parentNode) {
            this._overlayCanvas.parentNode.removeChild(this._overlayCanvas);
        }
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._detections = [];
    }
}

window.GroqVisionAiModel = GroqVisionAiModel;
