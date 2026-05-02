/**
 * Manages LLM chat agents (configurable base URL, path, model, API key).
 * Independent from Groq vision model — uses same-style OpenAI-compatible POST only.
 */
class AgentInterface {
    static STORAGE_KEY_PREFIX = "phonebot.agent.";
    static STORAGE_REMEMBER = "phonebot.agent.remember";

    /**
     * @param {Robot} robot
     * @param {object} config from robot.config.agentInterface
     */
    constructor(robot, config = {}) {
        this.robot = robot;
        this.config = typeof config === "object" && config ? config : {};
        this.name = this.config.name || "AI Agents";
        this.defaultBaseUrl = String(this.config.defaultBaseUrl || "https://api.groq.com/openai/v1").replace(/\/$/, "");
        this.agents = Array.isArray(this.config.agents) ? this.config.agents : [];
        this.promptTemplates = Array.isArray(this.config.promptTemplates)
            ? this.config.promptTemplates
            : [{ name: "Introduction prompt", path: "promptTemplates/introductionPrompt.txt" }];
        const stm = this.config.shortTermMemory;
        this.shortTermMemory = stm != null && typeof stm === "string" ? stm : "";
        this.messageHistory = [];
        this._apiKey = "";
        this._rememberKey = false;
        this._voiceOn = false;
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._voiceInput = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this._showFullSpeechPrompt = false;
        this._fullSpeechPromptInput = null;
        this._openingPromptAutoScheduled = false;
        this._agentEnabled = true;
        this._sendInProgress = false;
        this._agentPowerBtn = null;
        this._loadSavedKeyPreference();
        this._voiceOn = this._resolveVoiceDefault(null);
    }

    _setAgentEnabled(on) {
        this._agentEnabled = !!on;
        if (this._agentPowerBtn) {
            this._agentPowerBtn.textContent = this._agentEnabled ? "Turn off agent" : "Turn on agent";
        }
        if (!this._agentEnabled && window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        this._syncSendButtonState();
    }

    _syncSendButtonState() {
        if (!this._sendBtn) return;
        this._sendBtn.disabled = this._sendInProgress || !this._agentEnabled;
    }

    /**
     * Persists scratch notes for the next model turn. Visible in state at `agentInterface.shortTermMemory`.
     * @param {string|null|undefined} value
     */
    setShortTermMemory(value) {
        this.shortTermMemory = String(value == null ? "" : value);
    }

    _loadSavedKeyPreference() {
        try {
            this._rememberKey = localStorage.getItem(AgentInterface.STORAGE_REMEMBER) === "true";
        } catch (_) {
            this._rememberKey = false;
        }
    }

    _storageKeyForAgent(agentName) {
        return `${AgentInterface.STORAGE_KEY_PREFIX}key.${String(agentName || "default").replace(/\s+/g, "_")}`;
    }

    _loadKeyForAgent(agentName) {
        if (!this._rememberKey) return "";
        try {
            return localStorage.getItem(this._storageKeyForAgent(agentName)) || "";
        } catch (_) {
            return "";
        }
    }

    _persistKeyForAgent(agentName, key) {
        try {
            localStorage.setItem(AgentInterface.STORAGE_REMEMBER, this._rememberKey ? "true" : "false");
            if (this._rememberKey && key) {
                localStorage.setItem(this._storageKeyForAgent(agentName), key);
            } else {
                localStorage.removeItem(this._storageKeyForAgent(agentName));
            }
        } catch (_) {}
    }

    getSelectedAgent() {
        const idx = this._agentSelect ? Number(this._agentSelect.value) : 0;
        if (!Number.isFinite(idx) || idx < 0) return null;
        return this.agents[idx] || null;
    }

    _resolveChatUrl(agent) {
        if (!agent) return null;
        if (agent.chatUrl) return String(agent.chatUrl).trim();
        const base = String(agent.baseUrl || this.defaultBaseUrl || "").replace(/\/$/, "");
        const path = String(agent.chatPath || "/chat/completions").startsWith("/")
            ? agent.chatPath
            : `/${agent.chatPath}`;
        if (!base) return null;
        return `${base}${path}`;
    }

    _resolveModel(agent) {
        const override = this._modelOverrideInput?.value?.trim();
        if (override) return override;
        return String(agent?.model || "").trim();
    }

    _resolveVoiceDefault(agent) {
        if (agent && Object.prototype.hasOwnProperty.call(agent, "voiceOn")) {
            return !!agent.voiceOn;
        }
        if (Object.prototype.hasOwnProperty.call(this.config, "voiceOn")) {
            return !!this.config.voiceOn;
        }
        return false;
    }

    _speak(text) {
        const content = String(text || "").trim();
        if (!content) return;
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") return;
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(content);
            window.speechSynthesis.speak(utterance);
        } catch (err) {
            console.warn("TTS error:", err);
        }
    }

    _extractSpokenText(contentText, rawText) {
        const content = String(contentText || "").trim();
        if (!content) return "";
        const payload = this._tryParseJson(content) || this._tryParseJson(rawText);
        if (!payload || typeof payload !== "object") {
            return content;
        }
        if (typeof payload.message === "string" && payload.message.trim()) {
            return payload.message.trim();
        }
        if (typeof payload.reply === "string" && payload.reply.trim()) {
            return payload.reply.trim();
        }
        if (typeof payload.text === "string" && payload.text.trim()) {
            return payload.text.trim();
        }
        return "";
    }

    _buildBodyPlanFromRobotConfig() {
        const cfg = this.robot?.config || {};
        const configuredBodyPlan = this.config?.bodyPlan ?? cfg?.bodyPlan;
        if (configuredBodyPlan != null && String(configuredBodyPlan).trim() !== "") {
            return typeof configuredBodyPlan === "string"
                ? configuredBodyPlan
                : JSON.stringify(configuredBodyPlan, null, 2);
        }
        const bodyPlan = {
            robotName: cfg.name || "unnamed robot",
            actuators: Array.isArray(cfg.actuators)
                ? cfg.actuators.map((a) => ({
                      name: a?.name || "",
                      type: a?.type || "",
                      pin: a?.pin
                  }))
                : [],
            controlInputs: Object.keys(cfg.controlInputs || cfg.inputs || {}),
            sensors: Array.isArray(cfg.sensors)
                ? cfg.sensors.map((s) => (typeof s === "string" ? s : s?.name || s?.type || "sensor"))
                : [],
            joysticks: Array.isArray(cfg.joysticks) ? cfg.joysticks.map((j) => j?.name || "joystick") : []
        };
        return JSON.stringify(bodyPlan, null, 2);
    }

    _buildControlPlanFromRobotConfig() {
        const cfg = this.robot?.config || {};
        const configuredControlPlan = this.config?.controlPlan ?? cfg?.controlPlan;
        if (configuredControlPlan != null && String(configuredControlPlan).trim() !== "") {
            return typeof configuredControlPlan === "string"
                ? configuredControlPlan
                : JSON.stringify(configuredControlPlan, null, 2);
        }
        return "No control plan configured.";
    }

    _buildActionsFromRobotConfig() {
        const actions = Array.isArray(this.robot?.config?.actions) ? this.robot.config.actions : [];
        const forPrompt = actions.map((a) => {
            if (!a || typeof a !== "object") return a;
            return Object.fromEntries(Object.entries(a).filter(([k]) => k !== "functionPath"));
        });
        return JSON.stringify(forPrompt, null, 2);
    }

    _buildActionExamplesFromRobotConfig() {
        const examples = this.robot?.config?.actionExamples;
        if (!Array.isArray(examples) || !examples.length) {
            return "(no examples configured)";
        }
        return examples
            .map((ex, i) => {
                try {
                    return `Example ${i + 1}:\n${JSON.stringify(ex, null, 2)}`;
                } catch (_) {
                    return `Example ${i + 1}:\n${String(ex)}`;
                }
            })
            .join("\n\n");
    }

    _buildCurrentStateForIntroductionPrompt() {
        const sm = this.robot?.stateMachine;
        if (sm && typeof sm.getStateAsJson === "function") {
            return sm.getStateAsJson();
        }
        return "";
    }

    buildInstructionPromptFromTemplate(templateText) {
        const stateJson = this._buildCurrentStateForIntroductionPrompt();
        const template = String(templateText || "");
        return template
            .replace(/\{\{ROBOT_BODY_PLAN\}\}/g, this._buildBodyPlanFromRobotConfig())
            .replace(/\{\{ROBOT_CONTROL_PLAN\}\}/g, this._buildControlPlanFromRobotConfig())
            .replace(/\{\{ROBOT_STATE\}\}/g, stateJson)
            .replace(/\{\{state\}\}/g, stateJson)
            .replace(/\{state\}/g, stateJson)
            .replace(/\{\{ROBOT_ACTIONS\}\}/g, this._buildActionsFromRobotConfig())
            .replace(/\{\{ACTIONS-EXAMPLES\}\}/g, this._buildActionExamplesFromRobotConfig());
    }

    /**
     * Wait until a camera video element has non-zero dimensions (user may need to allow permission / tap Start).
     * @param {number} maxMs
     * @returns {Promise<boolean>}
     */
    async _waitForCameraVideoReady(maxMs) {
        const cam = this.robot?.sensors?.find((s) => typeof s.getVideoElement === "function");
        if (!cam) return true;
        const videoEl = () => cam.getVideoElement?.();
        const ok = () => {
            const v = videoEl();
            return !!(v && v.videoWidth > 0 && v.videoHeight > 0);
        };
        if (ok()) return true;
        return new Promise((resolve) => {
            const deadline = Date.now() + maxMs;
            const v = videoEl();
            const tick = () => {
                if (!this._containerEl) {
                    cleanup();
                    resolve(false);
                    return;
                }
                if (ok()) {
                    cleanup();
                    resolve(true);
                    return;
                }
                if (Date.now() >= deadline) {
                    cleanup();
                    resolve(false);
                }
            };
            const onVid = () => tick();
            const cleanup = () => {
                clearInterval(iv);
                if (v) {
                    v.removeEventListener("loadeddata", onVid);
                    v.removeEventListener("playing", onVid);
                }
            };
            if (v) {
                v.addEventListener("loadeddata", onVid);
                v.addEventListener("playing", onVid);
            }
            const iv = setInterval(tick, 200);
        });
    }

    async _runOpeningPromptAuto() {
        if (!this._agentEnabled) return;
        if (!this._promptInput || !this._sendBtn) return;
        const agent = this.getSelectedAgent();
        if (!agent) return;
        this._apiKey = this._keyInput?.value?.trim() || "";
        if (!this._apiKey) {
            if (this._statusEl) {
                this._statusEl.textContent = "Enter an API key to send the opening prompt automatically.";
                this._statusEl.className = "warn";
            }
            return;
        }
        const spec = this._getIntroductionTemplateSpec();
        const path = spec && String(spec.path || "").trim();
        if (!path) return;
        let templateText = "";
        try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) return;
            templateText = await res.text();
        } catch (_) {
            return;
        }
        const content = this.buildInstructionPromptFromTemplate(templateText);
        this._promptInput.value = content;
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending opening prompt…";
            this._statusEl.className = "muted";
        }
        this.messageHistory.push({ role: "user", text: content, at: new Date().toISOString() });
        this._renderHistory();
        try {
            const reply = await this.sendPrompt(content);
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                this._speak(this._extractSpokenText(reply.contentText, reply.rawText));
            }
            if (this._statusEl) {
                this._statusEl.textContent = "Opening prompt sent.";
                this._statusEl.className = "ok";
            }
        } catch (err) {
            console.error("Opening prompt auto-send error:", err);
            if (this.messageHistory.length && this.messageHistory[this.messageHistory.length - 1]?.role === "user") {
                this.messageHistory.pop();
            }
            this._renderHistory();
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Opening prompt failed.";
                this._statusEl.className = "error";
            }
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
    }

    async _scheduleOpeningPromptAfterInit() {
        if (this._openingPromptAutoScheduled) return;
        this._openingPromptAutoScheduled = true;
        try {
            const hasCam = this.robot?.sensors?.some((s) => typeof s.getVideoElement === "function");
            if (hasCam) {
                const ready = await this._waitForCameraVideoReady(120000);
                if (!ready) {
                    if (this._statusEl) {
                        this._statusEl.textContent =
                            "Start the camera to send the opening prompt automatically (or press Send after the camera is on).";
                        this._statusEl.className = "warn";
                    }
                    return;
                }
            } else {
                await new Promise((r) => setTimeout(r, 800));
            }
            await new Promise((r) => setTimeout(r, 400));
            if (this._agentEnabled) {
                await this._runOpeningPromptAuto();
            }
        } catch (err) {
            console.error("Opening prompt schedule error:", err);
        }
    }

    _getIntroductionTemplateSpec() {
        const list = Array.isArray(this.promptTemplates) ? this.promptTemplates : [];
        return (
            list.find((t) => /introductionPrompt\.txt$/i.test(String(t?.path || "").trim())) ||
            list.find((t) => /introduction/i.test(String(t?.name || ""))) ||
            list.find((t) => String(t?.path || "").trim()) ||
            null
        );
    }

    async _hydrateDefaultPromptFromIntroductionTemplate() {
        const spec = this._getIntroductionTemplateSpec();
        const path = spec && String(spec.path || "").trim();
        if (!path || !this._promptInput || !this._templateSelect) return;
        try {
            const res = await fetch(path, { cache: "no-store" });
            if (!res.ok) return;
            const templateText = await res.text();
            this._promptInput.value = this.buildInstructionPromptFromTemplate(templateText);
            this._templateSelect.value = path;
        } catch (_) {
            /* leave textarea empty if file missing or offline */
        }
    }

    async _buildPromptFromSelectedTemplate() {
        const selected = this._templateSelect?.value || "";
        if (!selected) throw new Error("Select a prompt template.");
        const res = await fetch(selected, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load template: ${selected}`);
        const templateText = await res.text();
        return this.buildInstructionPromptFromTemplate(templateText);
    }

    async _onInsertTemplate() {
        if (!this._promptInput || !this._insertTemplateBtn) return;
        this._insertTemplateBtn.disabled = true;
        try {
            const prompt = await this._buildPromptFromSelectedTemplate();
            this._promptInput.value = prompt;
            this._promptInput.focus();
            if (this._statusEl) {
                this._statusEl.className = "ok";
                this._statusEl.textContent = "Template inserted.";
            }
        } catch (err) {
            if (this._statusEl) {
                this._statusEl.className = "error";
                this._statusEl.textContent = err?.message || "Template insert failed.";
            }
        } finally {
            this._insertTemplateBtn.disabled = false;
        }
    }

    /**
     * @param {string} userText
     * @param {{ singleTurn?: boolean, messages?: Array<{role:string,content:string}> }} [options]
     * If `messages` is provided, it is sent as-is. If singleTurn, only `userText` is sent as one user message.
     */
    async sendPrompt(userText, options = {}) {
        const agent = this.getSelectedAgent();
        const prompt = String(userText || "").trim();
        if (!agent) {
            throw new Error("No agent selected.");
        }
        const url = this._resolveChatUrl(agent);
        if (!url) {
            throw new Error("Agent has no chatUrl and no baseUrl+chatPath.");
        }
        const model = this._resolveModel(agent);
        if (!model) {
            throw new Error("Set a model on the agent or use the model override field.");
        }
        const apiKey = String(this._apiKey || "").trim();
        if (!apiKey) {
            throw new Error("Enter an API key for this provider.");
        }

        const authHeader = String(agent.authHeader || "Authorization").trim();
        const authPrefix = agent.authPrefix !== undefined ? String(agent.authPrefix) : "Bearer ";
        const singleTurn = !!options.singleTurn;
        const overrideMessages = Array.isArray(options.messages) ? options.messages : null;
        let conversationMessages;
        if (overrideMessages && overrideMessages.length) {
            conversationMessages = overrideMessages;
        } else if (singleTurn) {
            if (!prompt) {
                throw new Error("Enter a prompt.");
            }
            conversationMessages = [{ role: "user", content: prompt }];
        } else {
            if (!prompt) {
                throw new Error("Enter a prompt.");
            }
            conversationMessages = this.messageHistory
                .filter((m) => m && (m.role === "user" || m.role === "assistant"))
                .map((m) => ({
                    role: m.role,
                    content: String(m.text || "")
                }));

            if (!conversationMessages.length) {
                conversationMessages.push({ role: "user", content: prompt });
            }
        }

        const body = {
            model,
            messages: conversationMessages,
            temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.7,
            max_tokens: Number.isFinite(agent.maxTokens) ? Math.round(agent.maxTokens) : 1024
        };

        const headers = {
            "Content-Type": "application/json",
            [authHeader]: `${authPrefix}${apiKey}`
        };
        if (agent.extraHeaders && typeof agent.extraHeaders === "object") {
            for (const [k, v] of Object.entries(agent.extraHeaders)) {
                if (k && v != null) headers[k] = String(v);
            }
        }

        const res = await fetch(url, {
            method: String(agent.method || "POST").toUpperCase(),
            headers,
            body: JSON.stringify(body)
        });

        const rawText = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${rawText.slice(0, 500)}`);
        }

        let json;
        try {
            json = JSON.parse(rawText);
        } catch (_) {
            throw new Error("Response was not JSON.");
        }
        const content =
            json?.choices?.[0]?.message?.content ??
            json?.choices?.[0]?.text ??
            json?.message?.content ??
            "";
        const contentText = String(content || "").trim();
        return {
            rawText,
            json,
            contentText: contentText || JSON.stringify(json, null, 2)
        };
    }

    _tryParseJson(text) {
        const raw = String(text || "").trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    _findNamedItem(list, name) {
        if (!Array.isArray(list)) return null;
        const key = String(name || "").trim().toLowerCase();
        if (!key) return null;
        return list.find((item) => String(item?.name || "").trim().toLowerCase() === key) || null;
    }

    _resolveActionFunction(functionPath) {
        const path = String(functionPath || "").trim();
        if (!path) throw new Error("Action has no functionPath.");
        const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
        if (!parts.length) throw new Error("Invalid functionPath.");

        let current = this.robot;
        for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i];
            const nextSegment = parts[i + 1];

            if (segment === "objectFilters") {
                const filterItem =
                    this.robot?.getObjectFilterByName?.(nextSegment) ||
                    this._findNamedItem(this.robot?.objectFilters, nextSegment);
                if (!filterItem) throw new Error(`Object filter not found: ${nextSegment}`);
                current = filterItem;
                i += 1;
                continue;
            }
            if (segment === "aiModels" || segment === "processing") {
                const key = String(nextSegment || "").trim().toLowerCase();
                const byType =
                    Array.isArray(this.robot?.aiModels) &&
                    this.robot.aiModels.find((m) => String(m?.type || "").trim().toLowerCase() === key);
                const model =
                    this.robot?.getAiModelByName?.(nextSegment) ||
                    this._findNamedItem(this.robot?.aiModels, nextSegment) ||
                    this.robot?.getAiModelByType?.(nextSegment) ||
                    byType;
                if (!model) throw new Error(`AI model not found: ${nextSegment}`);
                current = model;
                i += 1;
                continue;
            }

            if (current == null || !(segment in current)) {
                throw new Error(`Path segment not found: ${segment}`);
            }
            current = current[segment];
        }

        const fnName = parts[parts.length - 1];
        const fn = current?.[fnName];
        if (typeof fn !== "function") {
            throw new Error(`Function not found: ${fnName}`);
        }
        return { fn, receiver: current };
    }

    async act(actionName, actionArgs) {
        const actions = Array.isArray(this.robot?.config?.actions) ? this.robot.config.actions : [];
        const match = actions.find((a) =>
            String(a?.actionName || a?.name || "").trim().toLowerCase() === String(actionName || "").trim().toLowerCase()
        );
        if (!match) {
            throw new Error(`Unknown action: ${String(actionName || "")}`);
        }
        if (!match.functionPath) {
            throw new Error(`Action "${match.name}" has no functionPath.`);
        }

        const { fn, receiver } = this._resolveActionFunction(match.functionPath);
        if (Array.isArray(actionArgs)) {
            return await fn.apply(receiver, actionArgs);
        }
        return await fn.call(receiver, actionArgs);
    }

    _collectActionsFromPayload(payload) {
        const specs = [];
        const rawActions = payload.actions;
        if (Array.isArray(rawActions)) {
            for (const item of rawActions) {
                if (!item || typeof item !== "object") continue;
                if (Object.prototype.hasOwnProperty.call(item, "actionName")) {
                    const actionName = item.actionName;
                    const actionArgs = Object.prototype.hasOwnProperty.call(item, "actionArgs")
                        ? item.actionArgs
                        : undefined;
                    specs.push({ actionName, actionArgs });
                    continue;
                }
                for (const [actionName, actionArgs] of Object.entries(item)) {
                    if (actionName === "__proto__" || actionName === "constructor") continue;
                    if (!String(actionName || "").trim()) continue;
                    specs.push({ actionName, actionArgs });
                }
            }
            return specs;
        }
        if (rawActions && typeof rawActions === "object") {
            for (const [actionName, actionArgs] of Object.entries(rawActions)) {
                if (!String(actionName || "").trim()) continue;
                specs.push({ actionName, actionArgs });
            }
            return specs;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "actionName")) {
            const actionArgs = Object.prototype.hasOwnProperty.call(payload, "actionArgs")
                ? payload.actionArgs
                : undefined;
            specs.push({ actionName: payload.actionName, actionArgs });
        }
        return specs;
    }

    async _maybeRunActionFromResponse(contentText, rawText) {
        const fromContent = this._tryParseJson(contentText);
        const fromRaw = this._tryParseJson(rawText);
        const payload = fromContent || fromRaw;
        if (!payload || typeof payload !== "object") return;

        const specs = this._collectActionsFromPayload(payload);
        if (!specs.length) return;

        const summaries = [];
        for (const { actionName, actionArgs } of specs) {
            try {
                await this.act(actionName, actionArgs);
                summaries.push(`${String(actionName)} ${JSON.stringify(actionArgs)} ✓`);
            } catch (err) {
                summaries.push(`${String(actionName)} ✗ ${err?.message || "error"}`);
            }
        }
        this.messageHistory.push({
            role: "system",
            text: `Actions run: ${summaries.join(" | ")}`,
            at: new Date().toISOString()
        });
    }

    async _submitSpeechPrompt(transcript) {
        const text = String(transcript || "").trim();
        if (!text) return;
        if (!this._agentEnabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Agent is off. Turn the agent on to send voice prompts.";
                this._statusEl.className = "warn";
            }
            return;
        }

        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending…";
            this._statusEl.className = "muted";
        }
        try {
            const stateBlock = this._buildCurrentStateForIntroductionPrompt();
            const fullUserContent = `Current state (json):\n${stateBlock || "[]"}\n\nUser said:\n${text}`;
            const prior = this.messageHistory
                .filter((m) => m && (m.role === "user" || m.role === "assistant"))
                .map((m) => ({
                    role: m.role,
                    content: String(m.text || "")
                }));
            const conversationMessages = [...prior, { role: "user", content: fullUserContent }];
            this.messageHistory.push({
                role: "user",
                text,
                fullPrompt: fullUserContent,
                at: new Date().toISOString()
            });
            this._renderHistory();
            const reply = await this.sendPrompt("", { messages: conversationMessages });
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                this._speak(this._extractSpokenText(reply.contentText, reply.rawText));
            }
            if (this._statusEl) {
                this._statusEl.textContent = "Done.";
                this._statusEl.className = "ok";
            }
        } catch (err) {
            console.error("AgentInterface speech send error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Request failed";
                this._statusEl.className = "error";
            }
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
    }

    async _onSend() {
        if (!this._sendBtn || !this._promptInput) return;
        if (!this._agentEnabled) {
            if (this._statusEl) {
                this._statusEl.textContent = "Agent is off. Turn the agent on to send.";
                this._statusEl.className = "warn";
            }
            return;
        }
        const text = String(this._promptInput.value || "").trim();
        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendInProgress = true;
        this._syncSendButtonState();
        if (this._statusEl) {
            this._statusEl.textContent = "Sending…";
            this._statusEl.className = "muted";
        }
        try {
            this.messageHistory.push({ role: "user", text, at: new Date().toISOString() });
            this._renderHistory();
            const reply = await this.sendPrompt(text);
            this.messageHistory.push({
                role: "assistant",
                text: reply.contentText || "",
                at: new Date().toISOString()
            });
            await this._maybeRunActionFromResponse(reply.contentText, reply.rawText);
            this._renderHistory();
            if (this._voiceOn) {
                this._speak(this._extractSpokenText(reply.contentText, reply.rawText));
            }
            this._promptInput.value = "";
            if (this._statusEl) {
                this._statusEl.textContent = "Done.";
                this._statusEl.className = "ok";
            }
        } catch (err) {
            console.error("AgentInterface send error:", err);
            if (this._statusEl) {
                this._statusEl.textContent = err?.message || "Request failed";
                this._statusEl.className = "error";
            }
        } finally {
            this._sendInProgress = false;
            this._syncSendButtonState();
        }
    }

    /**
     * Used by external modules (e.g. SpeechToText model) to submit a prompt.
     * @param {string} text
     * @param {{ fromSpeech?: boolean }} [options] If fromSpeech, sends full user/assistant history plus current state and this transcript (introduction is not re-fetched).
     * @returns {Promise<boolean>}
     */
    async submitPrompt(text, options = {}) {
        if (!this._agentEnabled) {
            return false;
        }
        const next = String(text || "").trim();
        if (!next) return false;
        if (options.fromSpeech) {
            await this._submitSpeechPrompt(next);
            return true;
        }
        if (!this._promptInput) return false;
        this._promptInput.value = next;
        await this._onSend();
        return true;
    }

    _renderHistory() {
        if (!this._historyEl) return;
        this._historyEl.replaceChildren();
        for (const m of this.messageHistory.slice(-20)) {
            const bubble = document.createElement("div");
            const roleClass = m.role === "user" ? "agent-history-user" : m.role === "system" ? "agent-history-system" : "agent-history-agent";
            bubble.className = "agent-history-bubble " + roleClass;
            const who = document.createElement("span");
            who.className = "agent-history-who";
            who.textContent = m.role === "user" ? "You" : m.role === "system" ? "System" : "Agent";
            const body = document.createElement("div");
            body.className = "agent-history-body";
            let displayText = m.text != null ? String(m.text) : "";
            if (
                m.role === "user" &&
                this._showFullSpeechPrompt &&
                typeof m.fullPrompt === "string" &&
                m.fullPrompt.trim() !== ""
            ) {
                displayText = m.fullPrompt;
            }
            body.textContent = displayText;
            bubble.appendChild(who);
            bubble.appendChild(body);
            this._historyEl.appendChild(bubble);
        }
        this._historyEl.scrollTop = this._historyEl.scrollHeight;
    }

    _syncKeyFromSelection() {
        const agent = this.getSelectedAgent();
        this._apiKey = agent ? this._loadKeyForAgent(agent.name) : "";
        if (this._keyInput) {
            this._keyInput.value = this._apiKey;
        }
        this._voiceOn = this._resolveVoiceDefault(agent);
        if (this._voiceInput) {
            this._voiceInput.checked = this._voiceOn;
        }
    }

    buildGUI(container) {
        if (!container) return;
        const wrap = document.createElement("div");
        wrap.className = "robot-agent-interface ai-model";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const controls = document.createElement("div");
        controls.className = "ai-model-controls";

        const agentLabel = document.createElement("label");
        agentLabel.textContent = "Agent";
        const agentSelect = document.createElement("select");
        agentSelect.id = "robotAgentSelect";
        if (!this.agents.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no agents in config)";
            agentSelect.appendChild(opt);
            agentSelect.disabled = true;
        } else {
            this.agents.forEach((a, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = a.name || `Agent ${i}`;
                agentSelect.appendChild(opt);
            });
        }
        agentSelect.addEventListener("change", () => this._syncKeyFromSelection());

        const keyLabel = document.createElement("label");
        keyLabel.textContent = "API key (this provider)";
        const keyInput = document.createElement("input");
        keyInput.type = "password";
        keyInput.placeholder = "sk-… or gsk_…";
        keyInput.autocomplete = "off";

        const rememberWrap = document.createElement("label");
        rememberWrap.style.display = "flex";
        rememberWrap.style.alignItems = "center";
        rememberWrap.style.gap = "8px";
        const rememberInput = document.createElement("input");
        rememberInput.type = "checkbox";
        rememberInput.checked = this._rememberKey;
        rememberInput.addEventListener("change", () => {
            this._rememberKey = rememberInput.checked;
        });
        rememberWrap.appendChild(rememberInput);
        rememberWrap.appendChild(document.createTextNode("Remember key for selected agent"));

        const modelLabel = document.createElement("label");
        modelLabel.textContent = "Model override (optional)";
        const modelOverrideInput = document.createElement("input");
        modelOverrideInput.type = "text";
        modelOverrideInput.placeholder = "Leave blank to use agent config model";

        const voiceWrap = document.createElement("label");
        voiceWrap.style.display = "flex";
        voiceWrap.style.alignItems = "center";
        voiceWrap.style.gap = "8px";
        const voiceInput = document.createElement("input");
        voiceInput.type = "checkbox";
        voiceInput.checked = this._voiceOn;
        voiceInput.addEventListener("change", () => {
            this._voiceOn = !!voiceInput.checked;
            if (!this._voiceOn && window.speechSynthesis) {
                window.speechSynthesis.cancel();
            }
        });
        voiceWrap.appendChild(voiceInput);
        voiceWrap.appendChild(document.createTextNode("Speak agent replies"));

        const agentPowerBtn = document.createElement("button");
        agentPowerBtn.type = "button";
        agentPowerBtn.textContent = "Turn off agent";
        agentPowerBtn.style.marginTop = "6px";
        agentPowerBtn.style.width = "100%";
        agentPowerBtn.addEventListener("click", () => {
            this._setAgentEnabled(!this._agentEnabled);
        });

        const fullSpeechPromptWrap = document.createElement("label");
        fullSpeechPromptWrap.style.display = "flex";
        fullSpeechPromptWrap.style.alignItems = "center";
        fullSpeechPromptWrap.style.gap = "8px";
        const fullSpeechPromptInput = document.createElement("input");
        fullSpeechPromptInput.type = "checkbox";
        fullSpeechPromptInput.checked = this._showFullSpeechPrompt;
        fullSpeechPromptInput.addEventListener("change", () => {
            this._showFullSpeechPrompt = !!fullSpeechPromptInput.checked;
            this._renderHistory();
        });
        fullSpeechPromptWrap.appendChild(fullSpeechPromptInput);
        fullSpeechPromptWrap.appendChild(
            document.createTextNode("Show full prompt for voice (not just speech text)")
        );

        const templateLabel = document.createElement("label");
        templateLabel.textContent = "Prompt template";
        const templateSelect = document.createElement("select");
        if (!this.promptTemplates.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(no prompt templates configured)";
            templateSelect.appendChild(opt);
        } else {
            this.promptTemplates.forEach((tpl) => {
                const opt = document.createElement("option");
                opt.value = String(tpl.path || "");
                opt.textContent = tpl.name || tpl.path || "template";
                templateSelect.appendChild(opt);
            });
        }
        const insertTemplateBtn = document.createElement("button");
        insertTemplateBtn.type = "button";
        insertTemplateBtn.textContent = "Insert template";
        insertTemplateBtn.addEventListener("click", () => this._onInsertTemplate());

        const promptLabel = document.createElement("label");
        promptLabel.textContent = "Prompt";
        const promptInput = document.createElement("textarea");
        promptInput.rows = 12;
        promptInput.className = "agent-prompt-input";
        promptInput.style.width = "100%";
        promptInput.style.boxSizing = "border-box";
        promptInput.style.marginTop = "4px";

        const sendBtn = document.createElement("button");
        sendBtn.type = "button";
        sendBtn.textContent = "Send";
        sendBtn.addEventListener("click", () => this._onSend());

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Select an agent, enter API key and prompt.";

        const historyLabel = document.createElement("label");
        historyLabel.textContent = "History";
        const historyEl = document.createElement("div");
        historyEl.className = "agent-history-log";
        historyEl.setAttribute("role", "log");
        historyEl.setAttribute("aria-live", "polite");

        controls.appendChild(agentLabel);
        controls.appendChild(agentSelect);
        controls.appendChild(keyLabel);
        controls.appendChild(keyInput);
        controls.appendChild(rememberWrap);
        controls.appendChild(modelLabel);
        controls.appendChild(modelOverrideInput);
        controls.appendChild(voiceWrap);
        controls.appendChild(agentPowerBtn);
        controls.appendChild(fullSpeechPromptWrap);
        controls.appendChild(historyLabel);
        controls.appendChild(historyEl);
        controls.appendChild(promptLabel);
        controls.appendChild(promptInput);
        controls.appendChild(sendBtn);
        controls.appendChild(templateLabel);
        controls.appendChild(templateSelect);
        controls.appendChild(insertTemplateBtn);

        wrap.appendChild(title);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._containerEl = wrap;
        this._agentSelect = agentSelect;
        this._keyInput = keyInput;
        this._rememberInput = rememberInput;
        this._voiceInput = voiceInput;
        this._fullSpeechPromptInput = fullSpeechPromptInput;
        this._modelOverrideInput = modelOverrideInput;
        this._templateSelect = templateSelect;
        this._insertTemplateBtn = insertTemplateBtn;
        this._promptInput = promptInput;
        this._sendBtn = sendBtn;
        this._agentPowerBtn = agentPowerBtn;
        this._statusEl = status;
        this._historyEl = historyEl;

        this._voiceOn = this._resolveVoiceDefault(this.getSelectedAgent());
        this._voiceInput.checked = this._voiceOn;
        this._syncKeyFromSelection();
        this._syncSendButtonState();
        void this._hydrateDefaultPromptFromIntroductionTemplate();
        void this._scheduleOpeningPromptAfterInit();
    }

    destroy() {
        if (this._containerEl && this._containerEl.parentNode) {
            this._containerEl.parentNode.removeChild(this._containerEl);
        }
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._voiceInput = null;
        this._fullSpeechPromptInput = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._agentPowerBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        this.messageHistory = [];
    }
}

window.AgentInterface = AgentInterface;
