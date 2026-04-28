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
        this.messageHistory = [];
        this._apiKey = "";
        this._rememberKey = false;
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this._loadSavedKeyPreference();
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
        return JSON.stringify(actions, null, 2);
    }

    _buildStateConfigFromRobotConfig() {
        const cfg = this.robot?.config || {};
        const state = cfg.state;
        if (state == null) return "[]";
        if (typeof state === "string") return state.trim() || "(empty)";
        return JSON.stringify(state, null, 2);
    }

    buildInstructionPromptFromTemplate(templateText) {
        const template = String(templateText || "");
        return template
            .replace(/\{\{ROBOT_BODY_PLAN\}\}/g, this._buildBodyPlanFromRobotConfig())
            .replace(/\{\{ROBOT_CONTROL_PLAN\}\}/g, this._buildControlPlanFromRobotConfig())
            .replace(/\{\{ROBOT_STATE\}\}/g, this._buildStateConfigFromRobotConfig())
            .replace(/\{\{ROBOT_ACTIONS\}\}/g, this._buildActionsFromRobotConfig());
    }

    async _buildPromptFromSelectedTemplate() {
        const selected = this._templateSelect?.value || "";
        if (!selected) throw new Error("Select a prompt template.");
        if (selected === "__robot_state__") {
            return JSON.stringify(this.robot?.buildState?.() || {}, null, 2);
        }
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
            if ((this._templateSelect?.value || "") === "__robot_state__") {
                const existing = String(this._promptInput.value || "").trim();
                this._promptInput.value = existing ? `${existing}\n\nState:\n${prompt}` : `State:\n${prompt}`;
            } else {
                this._promptInput.value = prompt;
            }
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

    async sendPrompt(userText) {
        const agent = this.getSelectedAgent();
        const prompt = String(userText || "").trim();
        if (!agent) {
            throw new Error("No agent selected.");
        }
        if (!prompt) {
            throw new Error("Enter a prompt.");
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
        const conversationMessages = this.messageHistory
            .filter((m) => m && (m.role === "user" || m.role === "assistant"))
            .map((m) => ({
                role: m.role,
                content: String(m.text || "")
            }));

        if (!conversationMessages.length) {
            conversationMessages.push({ role: "user", content: prompt });
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

            if (segment === "trackers" || segment === "objectFilters") {
                const filterItem =
                    this.robot?.getObjectFilterByName?.(nextSegment) ||
                    this._findNamedItem(this.robot?.objectFilters, nextSegment);
                if (!filterItem) throw new Error(`Object filter not found: ${nextSegment}`);
                current = filterItem;
                i += 1;
                continue;
            }
            if (segment === "aiModels") {
                const model = this.robot?.getAiModelByName?.(nextSegment) || this._findNamedItem(this.robot?.aiModels, nextSegment);
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

    async _maybeRunActionFromResponse(contentText, rawText) {
        const fromContent = this._tryParseJson(contentText);
        const fromRaw = this._tryParseJson(rawText);
        const payload = fromContent || fromRaw;
        if (!payload || typeof payload !== "object") return;
        if (!Object.prototype.hasOwnProperty.call(payload, "actionName")) return;
        if (!Object.prototype.hasOwnProperty.call(payload, "actionArgs")) return;

        const actionName = payload.actionName;
        const actionArgs = payload.actionArgs;
        await this.act(actionName, actionArgs);
        this.messageHistory.push({
            role: "system",
            text: `Action executed: ${String(actionName)} with args ${JSON.stringify(actionArgs)}`,
            at: new Date().toISOString()
        });
    }

    async _onSend() {
        if (!this._sendBtn || !this._promptInput) return;
        const text = this._promptInput.value;
        this._apiKey = this._keyInput?.value?.trim() || "";
        const agent = this.getSelectedAgent();
        if (this._rememberInput) this._rememberKey = !!this._rememberInput.checked;
        if (agent) this._persistKeyForAgent(agent.name, this._apiKey);

        this._sendBtn.disabled = true;
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
            this._sendBtn.disabled = false;
        }
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
            body.textContent = m.text != null ? String(m.text) : "";
            bubble.appendChild(who);
            bubble.appendChild(body);
            this._historyEl.appendChild(bubble);
        }
        this._historyEl.scrollTop = this._historyEl.scrollHeight;
    }

    _syncKeyFromSelection() {
        const agent = this.getSelectedAgent();
        if (!this._keyInput) return;
        this._apiKey = agent ? this._loadKeyForAgent(agent.name) : "";
        this._keyInput.value = this._apiKey;
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

        const templateLabel = document.createElement("label");
        templateLabel.textContent = "Prompt template";
        const templateSelect = document.createElement("select");
        const stateOpt = document.createElement("option");
        stateOpt.value = "__robot_state__";
        stateOpt.textContent = "State";
        templateSelect.appendChild(stateOpt);
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
        this._modelOverrideInput = modelOverrideInput;
        this._templateSelect = templateSelect;
        this._insertTemplateBtn = insertTemplateBtn;
        this._promptInput = promptInput;
        this._sendBtn = sendBtn;
        this._statusEl = status;
        this._historyEl = historyEl;

        this._syncKeyFromSelection();
    }

    destroy() {
        if (this._containerEl && this._containerEl.parentNode) {
            this._containerEl.parentNode.removeChild(this._containerEl);
        }
        this._containerEl = null;
        this._agentSelect = null;
        this._keyInput = null;
        this._rememberInput = null;
        this._modelOverrideInput = null;
        this._templateSelect = null;
        this._insertTemplateBtn = null;
        this._promptInput = null;
        this._sendBtn = null;
        this._statusEl = null;
        this._historyEl = null;
        this.messageHistory = [];
    }
}

window.AgentInterface = AgentInterface;
