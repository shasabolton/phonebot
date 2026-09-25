/**
 * Custom Messages — author audio / text / prompt clips with triggers and loops.
 * Free local talking-head game: tiles under the Game menu; editor dialog for create/edit.
 */
class CustomMessagesGame {
    static STORAGE_KEY = "phonebot.customMessages.v1";
    static FACE_POLL_MS = 200;
    static REPEAT_GAP_MS = 1200;
    static FACE_STABLE_MS = 400;

    static TRIGGERS = Object.freeze([
        { id: "gameLoad", label: "Game load" },
        { id: "faceDetected", label: "Face detected" },
        { id: "noFaceDetected", label: "No face detected" },
        { id: "playNext", label: "Play next" }
    ]);

    static LOOPS = Object.freeze([
        { id: "once", label: "Play once" },
        { id: "repeat", label: "Repeat" }
    ]);

    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        /** @type {CustomMessage[]} */
        this.messages = [];
        this._running = false;
        this._generation = 0;
        this._audioBusy = false;
        this._faceTimer = null;
        this._faceTickBusy = false;
        this._lastFacePresent = null;
        this._faceSince = 0;
        this._firedOnceIds = new Set();
        this._playNextQueue = [];
        this._uiRoot = null;
        this._tileListEl = null;
        this._overlay = null;
        this._draft = null;
        this._recording = false;
        this._mediaRecorder = null;
        this._recordChunks = [];
        this._recordStreamOwned = false;
    }

    start() {
        this.stop();
        this._running = true;
        this._generation += 1;
        this._firedOnceIds = new Set();
        this._playNextQueue = [];
        this._lastFacePresent = null;
        this._faceSince = 0;
        this.messages = CustomMessagesGame._loadMessages();
        this._mountChrome();
        this._renderTiles();
        if (!this.messages.length) {
            this.openEditor(null);
        }
        void this._runGameLoad(this._generation);
        this._startFacePoll(this._generation);
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._audioBusy = false;
        this._stopFacePoll();
        this._cancelSpeech();
        this._stopRecording(true);
        this._closeEditor();
        this._unmountChrome();
        const agent = this._getAgent();
        if (agent && typeof agent._stopSpeaking === "function") {
            agent._stopSpeaking();
        }
    }

    /**
     * @param {CustomMessage|null} existing
     */
    openEditor(existing = null) {
        this._closeEditor();
        this._draft = existing
            ? {
                  id: existing.id,
                  kind: existing.kind,
                  trigger: existing.trigger,
                  loop: existing.loop,
                  text: existing.text || "",
                  fileName: existing.fileName || "",
                  audioBlob: existing.audioBlob || null
              }
            : {
                  id: null,
                  kind: null,
                  trigger: "gameLoad",
                  loop: "once",
                  text: "",
                  fileName: "",
                  audioBlob: null
              };
        this._mountEditor();
    }

    _isActive(generation) {
        return this._running && generation === this._generation;
    }

    _getAgent() {
        return this.robot?.agentInterface || null;
    }

    _getAudioPlayer() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("audioPlayer");
    }

    _getMicrophone() {
        const sensors = Array.isArray(this.robot?.sensors) ? this.robot.sensors : [];
        return (
            sensors.find((s) => String(s?.type || "").toLowerCase() === "microphone") || null
        );
    }

    _getComputerVision() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("computervision");
    }

    _cancelSpeech() {
        const player = this._getAudioPlayer();
        if (player && typeof player.stop === "function") {
            player.stop();
        }
        try {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        } catch (_) {}
        window.__phonebotTtsSpeaking = false;
    }

    _sleep(ms, generation) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(this._isActive(generation)), Math.max(0, ms));
        });
    }

    // —— Persistence ——————————————————————————————————————————————

    static _loadMessages() {
        try {
            const raw = localStorage.getItem(CustomMessagesGame.STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map((entry) => CustomMessagesGame._deserializeMessage(entry))
                .filter(Boolean);
        } catch (err) {
            console.warn("Custom messages load failed:", err);
            return [];
        }
    }

    static _saveMessages(messages) {
        try {
            const payload = (messages || []).map((m) => CustomMessagesGame._serializeMessage(m));
            localStorage.setItem(CustomMessagesGame.STORAGE_KEY, JSON.stringify(payload));
        } catch (err) {
            console.warn("Custom messages save failed:", err);
        }
    }

    static _serializeMessage(msg) {
        const out = {
            id: msg.id,
            kind: msg.kind,
            trigger: msg.trigger,
            loop: msg.loop,
            text: msg.text || "",
            fileName: msg.fileName || "",
            audioBase64: null,
            audioMime: ""
        };
        if (msg.audioBlob && typeof msg.audioBlob.size === "number" && msg.audioBlob.size > 0) {
            // Stored async via _persistAll; placeholder filled when available on the message.
            out.audioBase64 = msg._audioBase64 || null;
            out.audioMime = msg.audioBlob.type || msg._audioMime || "audio/webm";
        }
        return out;
    }

    static _deserializeMessage(entry) {
        if (!entry || typeof entry !== "object") return null;
        const kind = String(entry.kind || "").trim();
        if (kind !== "audio" && kind !== "text" && kind !== "prompt") return null;
        const trigger = String(entry.trigger || "gameLoad").trim();
        const loop = String(entry.loop || "once").trim() === "repeat" ? "repeat" : "once";
        /** @type {CustomMessage} */
        const msg = {
            id: String(entry.id || CustomMessagesGame._newId()),
            kind,
            trigger: CustomMessagesGame.TRIGGERS.some((t) => t.id === trigger)
                ? trigger
                : "gameLoad",
            loop,
            text: String(entry.text || ""),
            fileName: String(entry.fileName || ""),
            audioBlob: null,
            _audioBase64: entry.audioBase64 || null,
            _audioMime: entry.audioMime || ""
        };
        if (msg._audioBase64) {
            try {
                msg.audioBlob = CustomMessagesGame._base64ToBlob(
                    msg._audioBase64,
                    msg._audioMime || "audio/webm"
                );
            } catch (_) {
                msg.audioBlob = null;
            }
        }
        return msg;
    }

    static _newId() {
        return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    static _base64ToBlob(base64, mime) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || "application/octet-stream" });
    }

    static async _blobToBase64(blob) {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    async _persistAll() {
        for (const msg of this.messages) {
            if (msg.audioBlob && !msg._audioBase64) {
                try {
                    msg._audioBase64 = await CustomMessagesGame._blobToBase64(msg.audioBlob);
                    msg._audioMime = msg.audioBlob.type || "audio/webm";
                } catch (err) {
                    console.warn("Custom message audio encode failed:", err);
                }
            }
        }
        CustomMessagesGame._saveMessages(this.messages);
    }

    static tileLabel(msg) {
        if (!msg) return "Message";
        if (msg.kind === "audio") {
            const name = String(msg.fileName || "").trim();
            return name || "Recording";
        }
        const words = String(msg.text || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4);
        if (words.length) return words.join(" ");
        return msg.kind === "prompt" ? "Prompt" : "Text";
    }

    // —— Chrome (tiles) ————————————————————————————————————————————

    _footerHost() {
        const root =
            this.robot?.dashboardContainer?.querySelector?.(".robot-dashboard--talking-head") ||
            document.querySelector(".robot-dashboard--talking-head");
        if (!root) return null;
        let footer = root.querySelector(".robot-dashboard-footer");
        if (!footer) {
            footer = document.createElement("div");
            footer.className = "robot-dashboard-footer";
            root.appendChild(footer);
        }
        return footer;
    }

    _mountChrome() {
        const footer = this._footerHost();
        if (!footer) return;
        footer.setAttribute("aria-hidden", "false");
        footer.innerHTML = "";

        const wrap = document.createElement("div");
        wrap.className = "custom-messages-chrome";

        const list = document.createElement("div");
        list.className = "custom-messages-tiles";
        list.setAttribute("role", "list");

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "custom-messages-add";
        addBtn.textContent = "+ Add";
        addBtn.addEventListener("click", () => this.openEditor(null));

        wrap.appendChild(list);
        wrap.appendChild(addBtn);
        footer.appendChild(wrap);

        this._uiRoot = wrap;
        this._tileListEl = list;
    }

    _unmountChrome() {
        if (this._uiRoot?.parentElement) {
            this._uiRoot.parentElement.innerHTML = "";
            this._uiRoot.parentElement.setAttribute("aria-hidden", "true");
        }
        this._uiRoot = null;
        this._tileListEl = null;
    }

    _renderTiles() {
        const list = this._tileListEl;
        if (!list) return;
        list.innerHTML = "";
        for (const msg of this.messages) {
            const tile = document.createElement("div");
            tile.className = "custom-messages-tile";
            tile.setAttribute("role", "listitem");
            tile.dataset.id = msg.id;

            const label = document.createElement("span");
            label.className = "custom-messages-tile-label";
            label.textContent = CustomMessagesGame.tileLabel(msg);
            label.title = `${msg.kind} · ${msg.trigger} · ${msg.loop}`;

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "custom-messages-tile-edit";
            editBtn.setAttribute("aria-label", "Edit message");
            editBtn.textContent = "Edit";
            editBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.openEditor(msg);
            });

            tile.appendChild(label);
            tile.appendChild(editBtn);
            list.appendChild(tile);
        }
    }

    // —— Editor dialog ————————————————————————————————————————————

    _closeEditor() {
        this._stopRecording(true);
        if (this._overlay?.parentElement) {
            this._overlay.parentElement.removeChild(this._overlay);
        }
        this._overlay = null;
        this._draft = null;
    }

    _mountEditor() {
        const draft = this._draft;
        if (!draft) return;

        const overlay = document.createElement("div");
        overlay.className = "custom-messages-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Custom message");

        const card = document.createElement("div");
        card.className = "custom-messages-card";

        const title = document.createElement("h2");
        title.className = "custom-messages-title";
        title.textContent = draft.id ? "Edit message" : "Custom message";
        card.appendChild(title);

        const kindRow = document.createElement("div");
        kindRow.className = "custom-messages-kind-row";
        for (const { id, label } of [
            { id: "audio", label: "Audio" },
            { id: "text", label: "Txt" },
            { id: "prompt", label: "Prompt" }
        ]) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "custom-messages-kind-btn";
            btn.dataset.kind = id;
            btn.textContent = label;
            if (draft.kind === id) btn.classList.add("is-active");
            btn.addEventListener("click", () => {
                draft.kind = id;
                if (id === "audio") {
                    draft.text = "";
                } else {
                    draft.audioBlob = null;
                    if (!draft.fileName || /\.(webm|wav|mp3|ogg|m4a)$/i.test(draft.fileName)) {
                        draft.fileName = "";
                    }
                }
                this._refreshEditorBody();
            });
            kindRow.appendChild(btn);
        }
        card.appendChild(kindRow);

        const body = document.createElement("div");
        body.className = "custom-messages-body";
        card.appendChild(body);

        const options = document.createElement("div");
        options.className = "custom-messages-options";
        options.hidden = true;

        const triggerLabel = document.createElement("label");
        triggerLabel.textContent = "Trigger";
        const triggerSelect = document.createElement("select");
        triggerSelect.className = "custom-messages-trigger";
        for (const t of CustomMessagesGame.TRIGGERS) {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            triggerSelect.appendChild(opt);
        }
        triggerSelect.value = draft.trigger;
        triggerSelect.addEventListener("change", () => {
            draft.trigger = triggerSelect.value;
        });
        triggerLabel.appendChild(triggerSelect);

        const loopLabel = document.createElement("label");
        loopLabel.textContent = "Loop";
        const loopSelect = document.createElement("select");
        loopSelect.className = "custom-messages-loop";
        for (const t of CustomMessagesGame.LOOPS) {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            loopSelect.appendChild(opt);
        }
        loopSelect.value = draft.loop;
        loopSelect.addEventListener("change", () => {
            draft.loop = loopSelect.value;
        });
        loopLabel.appendChild(loopSelect);

        options.appendChild(triggerLabel);
        options.appendChild(loopLabel);
        card.appendChild(options);

        const actions = document.createElement("div");
        actions.className = "custom-messages-actions";

        const submitBtn = document.createElement("button");
        submitBtn.type = "button";
        submitBtn.className = "custom-messages-submit";
        submitBtn.textContent = "Submit";
        submitBtn.disabled = true;
        submitBtn.addEventListener("click", () => {
            void this._submitDraft();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "custom-messages-cancel secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => this._closeEditor());

        actions.appendChild(submitBtn);
        actions.appendChild(cancelBtn);

        if (draft.id) {
            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "custom-messages-delete secondary";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => {
                void this._deleteMessage(draft.id);
            });
            actions.appendChild(deleteBtn);
        }

        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        this._overlay = overlay;
        this._editorBody = body;
        this._editorOptions = options;
        this._editorSubmit = submitBtn;
        this._editorTrigger = triggerSelect;
        this._editorLoop = loopSelect;

        this._refreshEditorBody();
    }

    _hasDraftContent() {
        const draft = this._draft;
        if (!draft || !draft.kind) return false;
        if (draft.kind === "audio") return !!(draft.audioBlob && draft.audioBlob.size > 0);
        return String(draft.text || "").trim().length > 0;
    }

    _syncEditorOptionsVisibility() {
        const ready = this._hasDraftContent();
        if (this._editorOptions) this._editorOptions.hidden = !ready;
        if (this._editorSubmit) this._editorSubmit.disabled = !ready;
    }

    _refreshEditorBody() {
        const body = this._editorBody;
        const draft = this._draft;
        if (!body || !draft) return;
        body.innerHTML = "";

        const kindBtns = this._overlay?.querySelectorAll(".custom-messages-kind-btn") || [];
        for (const btn of kindBtns) {
            btn.classList.toggle("is-active", btn.dataset.kind === draft.kind);
        }

        if (!draft.kind) {
            const hint = document.createElement("p");
            hint.className = "custom-messages-hint muted";
            hint.textContent = "Choose Audio, Txt, or Prompt.";
            body.appendChild(hint);
            this._syncEditorOptionsVisibility();
            return;
        }

        if (draft.kind === "audio") {
            this._renderAudioEditor(body, draft);
        } else {
            this._renderTextEditor(body, draft);
        }
        this._syncEditorOptionsVisibility();
    }

    _renderAudioEditor(body, draft) {
        const status = document.createElement("p");
        status.className = "custom-messages-status muted";
        if (draft.audioBlob && draft.audioBlob.size) {
            status.textContent = `Ready: ${draft.fileName || "Recording"}`;
            status.className = "custom-messages-status ok";
        } else {
            status.textContent = "Record a clip or upload an audio file.";
        }

        const row = document.createElement("div");
        row.className = "custom-messages-media-row";

        const recordBtn = document.createElement("button");
        recordBtn.type = "button";
        recordBtn.className = "custom-messages-record";
        recordBtn.textContent = this._recording ? "Stop" : "Record";
        recordBtn.addEventListener("click", () => {
            void this._toggleRecord(recordBtn, status);
        });

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "custom-messages-upload secondary";
        uploadBtn.textContent = "Upload";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "audio/*,.wav,.mp3,.ogg,.m4a,.webm";
        fileInput.hidden = true;
        fileInput.addEventListener("change", () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) return;
            draft.audioBlob = file;
            draft.fileName = file.name || "upload.audio";
            draft._audioBase64 = null;
            status.textContent = `Ready: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
            this._syncEditorOptionsVisibility();
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        row.appendChild(recordBtn);
        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(status);
    }

    _renderTextEditor(body, draft) {
        const status = document.createElement("p");
        status.className = "custom-messages-status muted";
        if (draft.fileName && draft.text) {
            status.textContent = `Loaded: ${draft.fileName}`;
            status.className = "custom-messages-status ok";
        } else if (draft.kind === "prompt") {
            status.textContent = "Type a prompt or upload a text file. Sent to the agent (not TTS).";
        } else {
            status.textContent = "Type text or upload a text file. Spoken with TTS.";
        }

        const input = document.createElement("textarea");
        input.className = "custom-messages-text";
        input.rows = 4;
        input.placeholder =
            draft.kind === "prompt"
                ? "Prompt text for the agent…"
                : "Text to speak (TTS)…";
        input.value = draft.text || "";
        input.addEventListener("input", () => {
            draft.text = input.value;
            draft.fileName = draft.fileName && /\.txt$/i.test(draft.fileName) ? draft.fileName : "";
            this._syncEditorOptionsVisibility();
        });
        body.appendChild(input);

        const row = document.createElement("div");
        row.className = "custom-messages-media-row";

        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.className = "custom-messages-upload secondary";
        uploadBtn.textContent = "Upload file";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = ".txt,text/plain";
        fileInput.hidden = true;
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) return;
            try {
                const text = await file.text();
                draft.text = text;
                draft.fileName = file.name || "upload.txt";
                input.value = text;
                status.textContent = `Loaded: ${draft.fileName}`;
                status.className = "custom-messages-status ok";
                this._syncEditorOptionsVisibility();
            } catch (err) {
                status.textContent = err?.message || "Could not read file.";
                status.className = "custom-messages-status error";
            }
        });
        uploadBtn.addEventListener("click", () => fileInput.click());

        row.appendChild(uploadBtn);
        row.appendChild(fileInput);
        body.appendChild(row);
        body.appendChild(status);
    }

    async _toggleRecord(recordBtn, statusEl) {
        if (this._recording) {
            await this._stopRecording(false);
            if (recordBtn) recordBtn.textContent = "Record";
            if (statusEl && this._draft?.audioBlob) {
                statusEl.textContent = `Ready: ${this._draft.fileName || "Recording"}`;
                statusEl.className = "custom-messages-status ok";
            }
            this._syncEditorOptionsVisibility();
            return;
        }
        try {
            if (statusEl) {
                statusEl.textContent = "Recording… tap Stop when done.";
                statusEl.className = "custom-messages-status warn";
            }
            if (recordBtn) recordBtn.textContent = "Stop";
            await this._startRecording();
        } catch (err) {
            console.warn("Custom record failed:", err);
            if (recordBtn) recordBtn.textContent = "Record";
            if (statusEl) {
                statusEl.textContent = err?.message || "Recording failed.";
                statusEl.className = "custom-messages-status error";
            }
        }
    }

    _pickRecorderMimeType() {
        if (typeof MediaRecorder === "undefined") return "";
        for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
            try {
                if (MediaRecorder.isTypeSupported(t)) return t;
            } catch (_) {}
        }
        return "";
    }

    async _startRecording() {
        if (typeof MediaRecorder === "undefined") {
            throw new Error("Recording not supported in this browser.");
        }
        this._stopRecording(true);

        let stream = null;
        const mic = this._getMicrophone();
        if (mic && typeof mic.start === "function") {
            const ok = await mic.start();
            if (ok && typeof mic.getStream === "function") {
                stream = mic.getStream();
            }
        }
        if (!stream) {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            this._recordStreamOwned = true;
            this._ownedRecordStream = stream;
        } else {
            this._recordStreamOwned = false;
            this._ownedRecordStream = null;
        }

        const mimeType = this._pickRecorderMimeType();
        const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
        this._mediaRecorder = recorder;
        this._recordChunks = [];
        this._recording = true;
        recorder.addEventListener("dataavailable", (e) => {
            if (e.data && e.data.size > 0) this._recordChunks.push(e.data);
        });
        recorder.start(250);
    }

    /**
     * @param {boolean} discard
     */
    _stopRecording(discard) {
        return new Promise((resolve) => {
            const mr = this._mediaRecorder;
            this._mediaRecorder = null;
            this._recording = false;

            const releaseOwned = () => {
                if (this._recordStreamOwned && this._ownedRecordStream) {
                    for (const track of this._ownedRecordStream.getTracks()) {
                        try {
                            track.stop();
                        } catch (_) {}
                    }
                }
                this._ownedRecordStream = null;
                this._recordStreamOwned = false;
                const mic = this._getMicrophone();
                if (mic && typeof mic.stop === "function" && !mic._holdWanted && !mic._recordWanted) {
                    try {
                        mic.stop();
                    } catch (_) {}
                }
            };

            if (!mr) {
                this._recordChunks = [];
                releaseOwned();
                resolve(null);
                return;
            }

            const finish = () => {
                const chunks = this._recordChunks;
                this._recordChunks = [];
                const type = mr.mimeType || this._pickRecorderMimeType() || "audio/webm";
                const blob = !discard && chunks.length ? new Blob(chunks, { type }) : null;
                if (blob && this._draft) {
                    this._draft.audioBlob = blob;
                    this._draft.fileName = this._draft.fileName || "recording.webm";
                    this._draft._audioBase64 = null;
                }
                releaseOwned();
                resolve(blob);
            };

            if (mr.state === "inactive") {
                finish();
                return;
            }
            mr.addEventListener("stop", finish, { once: true });
            try {
                mr.stop();
            } catch (_) {
                finish();
            }
        });
    }

    async _submitDraft() {
        const draft = this._draft;
        if (!draft || !this._hasDraftContent()) return;
        if (this._recording) await this._stopRecording(false);

        const msg = {
            id: draft.id || CustomMessagesGame._newId(),
            kind: draft.kind,
            trigger: draft.trigger || "gameLoad",
            loop: draft.loop === "repeat" ? "repeat" : "once",
            text: String(draft.text || ""),
            fileName: String(draft.fileName || ""),
            audioBlob: draft.kind === "audio" ? draft.audioBlob : null,
            _audioBase64: null,
            _audioMime: ""
        };

        const idx = this.messages.findIndex((m) => m.id === msg.id);
        if (idx >= 0) this.messages[idx] = msg;
        else this.messages.push(msg);

        this._firedOnceIds.delete(msg.id);
        await this._persistAll();
        this._renderTiles();
        this._closeEditor();

        if (msg.trigger === "gameLoad" && this._running) {
            void this._playMessage(msg, this._generation);
        }
    }

    async _deleteMessage(id) {
        const want = String(id || "");
        this.messages = this.messages.filter((m) => m.id !== want);
        this._firedOnceIds.delete(want);
        await this._persistAll();
        this._renderTiles();
        this._closeEditor();
    }

    // —— Runtime ——————————————————————————————————————————————————

    async _runGameLoad(generation) {
        const list = this.messages.filter((m) => m.trigger === "gameLoad");
        for (const msg of list) {
            if (!this._isActive(generation)) return;
            if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) continue;
            await this._playMessage(msg, generation);
            if (msg.loop === "once") this._firedOnceIds.add(msg.id);
            if (msg.loop === "repeat") {
                while (this._isActive(generation)) {
                    const gap = await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation);
                    if (!gap) return;
                    await this._playMessage(msg, generation);
                }
                return;
            }
        }
    }

    _startFacePoll(generation) {
        this._stopFacePoll();
        this._faceTimer = setInterval(() => {
            if (!this._isActive(generation)) {
                this._stopFacePoll();
                return;
            }
            void this._onFaceTick(generation);
        }, CustomMessagesGame.FACE_POLL_MS);
    }

    _stopFacePoll() {
        if (this._faceTimer) {
            clearInterval(this._faceTimer);
            this._faceTimer = null;
        }
    }

    async _onFaceTick(generation) {
        if (!this._isActive(generation) || this._audioBusy || this._faceTickBusy) return;
        const cv = this._getComputerVision();
        const facePresent = cv && cv.faceScale != null;
        const now = Date.now();

        if (this._lastFacePresent === null) {
            this._lastFacePresent = facePresent;
            this._faceSince = now;
            return;
        }

        if (facePresent !== this._lastFacePresent) {
            this._lastFacePresent = facePresent;
            this._faceSince = now;
            // Re-arm once-triggers for the condition we just left.
            for (const msg of this.messages) {
                if (msg.loop !== "once") continue;
                if (msg.trigger === "faceDetected" && !facePresent) this._firedOnceIds.delete(msg.id);
                if (msg.trigger === "noFaceDetected" && facePresent) this._firedOnceIds.delete(msg.id);
            }
            return;
        }

        if (now - this._faceSince < CustomMessagesGame.FACE_STABLE_MS) return;

        const trigger = facePresent ? "faceDetected" : "noFaceDetected";
        const candidates = this.messages.filter((m) => m.trigger === trigger);
        if (!candidates.length) return;

        this._faceTickBusy = true;
        try {
            for (const msg of candidates) {
                if (!this._isActive(generation) || this._audioBusy) return;
                if (msg.loop === "once" && this._firedOnceIds.has(msg.id)) continue;
                await this._playMessage(msg, generation);
                if (msg.loop === "once") this._firedOnceIds.add(msg.id);
                if (msg.loop === "repeat") {
                    this._faceSince = Date.now();
                }
            }
        } finally {
            this._faceTickBusy = false;
        }
    }

    /**
     * @param {CustomMessage} msg
     * @param {number} generation
     */
    async _playMessage(msg, generation) {
        if (!msg || !this._isActive(generation)) return false;

        while (this._audioBusy) {
            if (!this._isActive(generation)) return false;
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (!this._isActive(generation)) return false;

        this._audioBusy = true;
        try {
            if (msg.kind === "audio") {
                await this._playAudio(msg, generation);
            } else if (msg.kind === "text") {
                await this._playText(msg, generation);
            } else if (msg.kind === "prompt") {
                await this._playPrompt(msg, generation);
            }
        } finally {
            this._audioBusy = false;
        }

        if (!this._isActive(generation)) return false;
        await this._playFollowingNext(msg, generation);
        return this._isActive(generation);
    }

    async _playFollowingNext(afterMsg, generation) {
        const idx = this.messages.findIndex((m) => m.id === afterMsg.id);
        if (idx < 0) return;
        for (let i = idx + 1; i < this.messages.length; i++) {
            const next = this.messages[i];
            if (next.trigger !== "playNext") break;
            if (!this._isActive(generation)) return;
            if (next.loop === "once" && this._firedOnceIds.has(next.id)) continue;
            await this._playMessage(next, generation);
            if (next.loop === "once") this._firedOnceIds.add(next.id);
            if (next.loop === "repeat") {
                while (this._isActive(generation)) {
                    const gap = await this._sleep(CustomMessagesGame.REPEAT_GAP_MS, generation);
                    if (!gap) return;
                    await this._playMessage(next, generation);
                }
            }
            // Only chain the immediate contiguous playNext block once through.
            // Nested _playMessage already continues the chain; stop here.
            return;
        }
    }

    async _playAudio(msg, generation) {
        const blob = msg.audioBlob;
        if (!blob || !blob.size) return;
        const player = this._getAudioPlayer();
        if (!player || typeof player.playBlob !== "function") {
            console.warn("Custom: audio player unavailable.");
            return;
        }
        try {
            await player.playBlob(blob, CustomMessagesGame.tileLabel(msg));
        } catch (err) {
            console.warn("Custom audio playback failed:", err);
        }
        return this._isActive(generation);
    }

    async _playText(msg, generation) {
        const text = String(msg.text || "").trim();
        if (!text) return;
        const agent = this._getAgent();
        if (agent && typeof agent._speakAsync === "function") {
            try {
                await agent._speakAsync(text);
            } catch (err) {
                console.warn("Custom TTS failed:", err);
            }
            return this._isActive(generation);
        }
        // Browser fallback
        try {
            if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                await new Promise((resolve) => {
                    const u = new SpeechSynthesisUtterance(text);
                    u.onend = () => resolve();
                    u.onerror = () => resolve();
                    window.speechSynthesis.speak(u);
                });
            }
        } catch (_) {}
        return this._isActive(generation);
    }

    async _playPrompt(msg, generation) {
        const text = String(msg.text || "").trim();
        if (!text) return;
        const agent = this._getAgent();
        if (!agent || typeof agent.submitPrompt !== "function") {
            console.warn("Custom: agent unavailable for prompt.");
            return;
        }
        try {
            await agent.submitPrompt(text);
        } catch (err) {
            console.warn("Custom prompt failed:", err);
        }
        return this._isActive(generation);
    }
}

/**
 * @typedef {object} CustomMessage
 * @property {string} id
 * @property {"audio"|"text"|"prompt"} kind
 * @property {string} trigger
 * @property {"once"|"repeat"} loop
 * @property {string} text
 * @property {string} fileName
 * @property {Blob|null} audioBlob
 * @property {string|null} [_audioBase64]
 * @property {string} [_audioMime]
 */

window.CustomMessagesGame = CustomMessagesGame;
