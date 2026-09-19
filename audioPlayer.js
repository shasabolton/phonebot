/**
 * Processing module: play audio from the project's audio/ folder or an uploaded file.
 * Folder listing comes from audio/files.json (static sites cannot enumerate directories).
 */
class AudioPlayerAiModel {
    static AUDIO_DIR = "audio";
    static MANIFEST_URL = "audio/files.json";
    static AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|webm|m4a|aac|flac|opus)$/i;

    constructor(robot, config = {}) {
        this.robot = robot;
        this.type = "audioPlayer";
        this.name = config.name || "Audio player";
        this.audioDir = String(config.audioDir || AudioPlayerAiModel.AUDIO_DIR).replace(/\/+$/, "");
        this.manifestUrl = String(config.manifestUrl || AudioPlayerAiModel.MANIFEST_URL);

        /** @type {{ id: string, label: string, url: string, source: "folder"|"upload" }[]} */
        this._entries = [];
        this._selectedId = "";
        this._loadedId = "";
        this._objectUrls = [];
        this._audio = null;

        /** Optional extra filenames from robot config.files */
        this._configFiles = Array.isArray(config.files) ? config.files.slice() : [];

        this._selectEl = null;
        this._playPauseBtn = null;
        this._stopBtn = null;
        this._fileInput = null;
        this._statusEl = null;
        this._delaySlider = null;
        this._delayValueEl = null;
        this._makeupSlider = null;
        this._makeupValueEl = null;
        this._compThresholdSlider = null;
        this._compThresholdValueEl = null;
        this._compressorToggleEl = null;

        /**
         * Playback vs analysis offset in ms (−500…500).
         * Positive: hear later than analyser (mouth can lead).
         * Negative: analyser later than hear (mouth lags).
         */
        this.delayMs = AudioPlayerAiModel._clampDelayMs(config.delayMs);

        /**
         * Dynamics compressor + makeup gain on all playback (files, TTS, parrot).
         * Raises quiet speech and holds peaks so level stays more consistent.
         */
        this.compressorEnabled = config.compressor !== false && config.compressorEnabled !== false;
        this.compressorThreshold = AudioPlayerAiModel._clampCompThreshold(
            config.compressorThreshold ?? config.thresholdDb ?? -24
        );
        this.compressorKnee = AudioPlayerAiModel._clampCompKnee(config.compressorKnee ?? 12);
        this.compressorRatio = AudioPlayerAiModel._clampCompRatio(config.compressorRatio ?? 4);
        this.compressorAttack = AudioPlayerAiModel._clampCompAttack(config.compressorAttack ?? 0.005);
        this.compressorRelease = AudioPlayerAiModel._clampCompRelease(config.compressorRelease ?? 0.15);
        this.makeupGain = AudioPlayerAiModel._clampMakeupGain(config.makeupGain ?? 2);

        /** Web Audio tap so processors (e.g. audioMouthFilter) can read playback level. */
        this._audioContext = null;
        this._mediaSource = null;
        this._compressorNode = null;
        this._makeupGainNode = null;
        this._analyserNode = null;
        this._delayNode = null;
        this._levelData = null;

        /** Object URL for programmatic playback (e.g. local TTS). */
        this._ttsObjectUrl = "";
        this._playEndedWaiters = [];
    }

    static _clampDelayMs(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(-500, Math.min(500, Math.round(n)));
    }

    static _clampCompThreshold(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return -24;
        return Math.max(-100, Math.min(0, n));
    }

    static _clampCompKnee(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 12;
        return Math.max(0, Math.min(40, n));
    }

    static _clampCompRatio(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 4;
        return Math.max(1, Math.min(20, n));
    }

    static _clampCompAttack(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0.005;
        return Math.max(0, Math.min(1, n));
    }

    static _clampCompRelease(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0.15;
        return Math.max(0, Math.min(1, n));
    }

    static _clampMakeupGain(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 2;
        return Math.max(0.25, Math.min(8, n));
    }

    /** HTMLAudioElement used for playback (created lazily). */
    getAudioElement() {
        return this._ensureAudio();
    }

    /**
     * Route playback through Web Audio once so analysers can tap it.
     * Safe to call repeatedly; MediaElementSource is created only once.
     * Graph: source → [compressor → makeup] → analyser / delay → speakers
     * @returns {AnalyserNode|null}
     */
    ensurePlaybackTap() {
        const audio = this._ensureAudio();
        if (this._analyserNode) return this._analyserNode;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            this._audioContext = this._audioContext || new Ctx();
            if (this._audioContext.state === "suspended") {
                void this._audioContext.resume().catch(() => {});
            }
            this._mediaSource = this._audioContext.createMediaElementSource(audio);
            this._compressorNode = this._audioContext.createDynamicsCompressor();
            this._makeupGainNode = this._audioContext.createGain();
            this._analyserNode = this._audioContext.createAnalyser();
            this._analyserNode.fftSize = 1024;
            this._levelData = new Uint8Array(this._analyserNode.fftSize);
            this._delayNode = this._audioContext.createDelay(0.5);
            this._applyCompressorParams();
            this._applyDelayRouting();
            return this._analyserNode;
        } catch (err) {
            console.warn("Audio player playback tap failed:", err);
            return null;
        }
    }

    _disconnectGraph() {
        for (const node of [
            this._mediaSource,
            this._compressorNode,
            this._makeupGainNode,
            this._analyserNode,
            this._delayNode
        ]) {
            if (!node) continue;
            try {
                node.disconnect();
            } catch (_) {}
        }
    }

    _applyCompressorParams() {
        if (!this._audioContext) return;
        const t = this._audioContext.currentTime;
        if (this._compressorNode) {
            const c = this._compressorNode;
            try {
                c.threshold.setValueAtTime(this.compressorThreshold, t);
                c.knee.setValueAtTime(this.compressorKnee, t);
                c.ratio.setValueAtTime(this.compressorRatio, t);
                c.attack.setValueAtTime(this.compressorAttack, t);
                c.release.setValueAtTime(this.compressorRelease, t);
            } catch (_) {
                c.threshold.value = this.compressorThreshold;
                c.knee.value = this.compressorKnee;
                c.ratio.value = this.compressorRatio;
                c.attack.value = this.compressorAttack;
                c.release.value = this.compressorRelease;
            }
        }
        if (this._makeupGainNode) {
            const gain = this.compressorEnabled ? this.makeupGain : 1;
            try {
                this._makeupGainNode.gain.setValueAtTime(gain, t);
            } catch (_) {
                this._makeupGainNode.gain.value = gain;
            }
        }
    }

    /**
     * Rewire analyser vs speakers according to delayMs.
     * delayMs ≥ 0: tap → analyser; tap → delay → destination
     * delayMs < 0: tap → destination; tap → delay → analyser
     * When compressor is on: source → compressor → makeup → tap
     */
    _applyDelayRouting() {
        if (!this._mediaSource || !this._analyserNode || !this._delayNode || !this._audioContext) {
            return;
        }
        this._disconnectGraph();
        const absSec = Math.abs(this.delayMs) / 1000;
        try {
            this._delayNode.delayTime.setValueAtTime(absSec, this._audioContext.currentTime);
        } catch (_) {
            this._delayNode.delayTime.value = absSec;
        }

        let tap = this._mediaSource;
        if (this.compressorEnabled && this._compressorNode && this._makeupGainNode) {
            this._mediaSource.connect(this._compressorNode);
            this._compressorNode.connect(this._makeupGainNode);
            tap = this._makeupGainNode;
            this._applyCompressorParams();
        }

        if (this.delayMs >= 0) {
            tap.connect(this._analyserNode);
            tap.connect(this._delayNode);
            this._delayNode.connect(this._audioContext.destination);
        } else {
            tap.connect(this._audioContext.destination);
            tap.connect(this._delayNode);
            this._delayNode.connect(this._analyserNode);
        }
    }

    setDelayMs(value) {
        this.delayMs = AudioPlayerAiModel._clampDelayMs(value);
        if (this._delaySlider) this._delaySlider.value = String(this.delayMs);
        if (this._delayValueEl) this._delayValueEl.textContent = String(this.delayMs);
        if (this._analyserNode && this._delayNode) {
            this._applyDelayRouting();
        }
    }

    setCompressorEnabled(on) {
        this.compressorEnabled = !!on;
        if (this._compressorToggleEl) this._compressorToggleEl.checked = this.compressorEnabled;
        if (this._analyserNode && this._delayNode) {
            this._applyDelayRouting();
        } else {
            this._applyCompressorParams();
        }
    }

    setMakeupGain(value) {
        this.makeupGain = AudioPlayerAiModel._clampMakeupGain(value);
        if (this._makeupSlider) this._makeupSlider.value = String(this.makeupGain);
        if (this._makeupValueEl) this._makeupValueEl.textContent = this.makeupGain.toFixed(2);
        this._applyCompressorParams();
    }

    setCompressorThreshold(value) {
        this.compressorThreshold = AudioPlayerAiModel._clampCompThreshold(value);
        if (this._compThresholdSlider) this._compThresholdSlider.value = String(this.compressorThreshold);
        if (this._compThresholdValueEl) {
            this._compThresholdValueEl.textContent = String(Math.round(this.compressorThreshold));
        }
        this._applyCompressorParams();
    }

    getAnalyserNode() {
        return this._analyserNode || this.ensurePlaybackTap();
    }

    /** RMS amplitude 0…1 (1 ≈ full-scale square wave). */
    getAudioLevel() {
        const analyser = this.getAnalyserNode();
        if (!analyser || !this._levelData) return 0;
        analyser.getByteTimeDomainData(this._levelData);
        let sumSquares = 0;
        for (let i = 0; i < this._levelData.length; i++) {
            const norm = (this._levelData[i] - 128) / 128;
            sumSquares += norm * norm;
        }
        return Math.sqrt(sumSquares / this._levelData.length);
    }

    _setStatus(text, isError = false) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.className = isError ? "error" : "muted";
    }

    _syncTransportButtons() {
        const audio = this._audio;
        const hasSrc = !!(audio && audio.src);
        const playing = !!(audio && !audio.paused && !audio.ended);
        if (this._playPauseBtn) {
            this._playPauseBtn.textContent = playing ? "Pause" : "Play";
            this._playPauseBtn.disabled = !hasSrc && !this._selectedId;
        }
        if (this._stopBtn) {
            this._stopBtn.disabled = !hasSrc;
        }
    }

    _rebuildSelect() {
        if (!this._selectEl) return;
        const select = this._selectEl;
        const prev = this._selectedId;
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = this._entries.length ? "Select a file…" : "No audio files found";
        select.appendChild(placeholder);

        for (const entry of this._entries) {
            const opt = document.createElement("option");
            opt.value = entry.id;
            opt.textContent = entry.source === "upload" ? `${entry.label} (upload)` : entry.label;
            select.appendChild(opt);
        }

        if (prev && this._entries.some((e) => e.id === prev)) {
            select.value = prev;
            this._selectedId = prev;
        } else {
            select.value = "";
            this._selectedId = "";
        }
    }

    _entryById(id) {
        return this._entries.find((e) => e.id === id) || null;
    }

    _folderUrl(filename) {
        const name = String(filename || "").replace(/^\/+/, "");
        const parts = name.split("/").map((p) => encodeURIComponent(p));
        return `${this.audioDir}/${parts.join("/")}`;
    }

    _addFolderFile(filename) {
        const label = String(filename || "").trim();
        if (!label) return;
        if (!AudioPlayerAiModel.AUDIO_EXTENSIONS.test(label)) return;
        const id = `folder:${label}`;
        if (this._entries.some((e) => e.id === id)) return;
        this._entries.push({
            id,
            label,
            url: this._folderUrl(label),
            source: "folder"
        });
    }

    _normalizeManifestList(raw) {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === "object") {
            if (Array.isArray(raw.files)) return raw.files;
            if (Array.isArray(raw.audio)) return raw.audio;
        }
        return [];
    }

    async loadFolderListing() {
        for (const name of this._configFiles) {
            if (typeof name === "string") this._addFolderFile(name);
        }
        try {
            const res = await fetch(this.manifestUrl, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const names = this._normalizeManifestList(data);
            for (const name of names) {
                if (typeof name === "string") this._addFolderFile(name);
                else if (name && typeof name.name === "string") this._addFolderFile(name.name);
            }
            this._rebuildSelect();
            const folderCount = this._entries.filter((e) => e.source === "folder").length;
            this._setStatus(
                folderCount
                    ? `Loaded ${folderCount} file(s) from ${this.audioDir}/.`
                    : `No files listed in ${this.manifestUrl}.`
            );
        } catch (err) {
            console.warn("Audio player manifest load failed:", err);
            this._rebuildSelect();
            const folderCount = this._entries.filter((e) => e.source === "folder").length;
            if (folderCount) {
                this._setStatus(`Loaded ${folderCount} file(s) from config (manifest unavailable).`);
            } else {
                this._setStatus(
                    `Could not load ${this.manifestUrl}. Use Upload, or add files to the manifest.`,
                    true
                );
            }
        }
    }

    _ensureAudio() {
        if (this._audio) return this._audio;
        const audio = new Audio();
        audio.preload = "metadata";
        audio.addEventListener("ended", () => {
            this._setStatus("Playback finished.");
            this._syncTransportButtons();
            this._resolvePlayEndedWaiters();
        });
        audio.addEventListener("pause", () => this._syncTransportButtons());
        audio.addEventListener("play", () => this._syncTransportButtons());
        audio.addEventListener("error", () => {
            this._setStatus("Could not play this file.", true);
            this._syncTransportButtons();
            this._resolvePlayEndedWaiters();
        });
        this._audio = audio;
        return audio;
    }

    _resolvePlayEndedWaiters() {
        const waiters = this._playEndedWaiters.splice(0, this._playEndedWaiters.length);
        for (const resolve of waiters) {
            try {
                resolve();
            } catch (_) {}
        }
    }

    _revokeTtsUrl() {
        if (!this._ttsObjectUrl) return;
        try {
            URL.revokeObjectURL(this._ttsObjectUrl);
        } catch (_) {}
        this._ttsObjectUrl = "";
    }

    /**
     * Play a Blob/File through the same Web Audio tap used by audioMouthFilter.
     * @param {Blob|File} blob
     * @param {string} [label]
     * @returns {Promise<void>} Resolves when playback ends or is stopped.
     */
    async playBlob(blob, label = "TTS") {
        if (!blob) throw new Error("No audio blob to play.");
        const audio = this._ensureAudio();
        this._resolvePlayEndedWaiters();
        this._revokeTtsUrl();
        this._ttsObjectUrl = URL.createObjectURL(blob);
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch (_) {}
        audio.src = this._ttsObjectUrl;
        audio.load();
        this._loadedId = `blob:${Date.now()}`;
        this.ensurePlaybackTap();
        if (this._audioContext && this._audioContext.state === "suspended") {
            await this._audioContext.resume().catch(() => {});
        }
        const ended = new Promise((resolve) => {
            this._playEndedWaiters.push(resolve);
        });
        try {
            await audio.play();
            this._setStatus(`Playing: ${label}`);
            window.__phonebotTtsSpeaking = true;
        } catch (err) {
            this._resolvePlayEndedWaiters();
            window.__phonebotTtsSpeaking = false;
            console.error("Audio playBlob failed:", err);
            this._setStatus(`Could not play: ${err?.message || "unknown"}`, true);
            throw err;
        }
        this._syncTransportButtons();
        await ended;
        window.__phonebotTtsSpeaking = false;
        this._syncTransportButtons();
    }

    /**
     * Play a static URL (e.g. pre-recorded Simon Says clips) through the same tap.
     * @param {string} url
     * @param {string} [label]
     * @returns {Promise<void>}
     */
    async playSrc(url, label = "Audio") {
        const src = String(url || "").trim();
        if (!src) throw new Error("No audio URL to play.");
        const audio = this._ensureAudio();
        this._resolvePlayEndedWaiters();
        this._revokeTtsUrl();
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch (_) {}
        audio.src = src;
        audio.load();
        this._loadedId = `src:${src}`;
        this.ensurePlaybackTap();
        if (this._audioContext && this._audioContext.state === "suspended") {
            await this._audioContext.resume().catch(() => {});
        }
        const ended = new Promise((resolve) => {
            this._playEndedWaiters.push(resolve);
        });
        try {
            await audio.play();
            this._setStatus(`Playing: ${label}`);
            window.__phonebotTtsSpeaking = true;
        } catch (err) {
            this._resolvePlayEndedWaiters();
            window.__phonebotTtsSpeaking = false;
            console.error("Audio playSrc failed:", err);
            this._setStatus(`Could not play: ${err?.message || "unknown"}`, true);
            throw err;
        }
        this._syncTransportButtons();
        await ended;
        window.__phonebotTtsSpeaking = false;
        this._syncTransportButtons();
    }

    _loadSelected() {
        const entry = this._entryById(this._selectedId);
        if (!entry) {
            this.stop();
            return null;
        }
        const audio = this._ensureAudio();
        if (this._loadedId !== entry.id) {
            audio.pause();
            audio.src = entry.url;
            audio.load();
            this._loadedId = entry.id;
        }
        return entry;
    }

    async play() {
        const entry = this._loadSelected();
        if (!entry) {
            this._setStatus("Select a file first.", true);
            return;
        }
        const audio = this._ensureAudio();
        this.ensurePlaybackTap();
        if (this._audioContext && this._audioContext.state === "suspended") {
            await this._audioContext.resume().catch(() => {});
        }
        try {
            await audio.play();
            this._setStatus(`Playing: ${entry.label}`);
        } catch (err) {
            console.error("Audio play failed:", err);
            this._setStatus(`Could not play: ${err?.message || "unknown"}`, true);
        }
        this._syncTransportButtons();
    }

    pause() {
        if (!this._audio) return;
        this._audio.pause();
        this._setStatus("Paused.");
        this._syncTransportButtons();
    }

    async togglePlayPause() {
        const audio = this._audio;
        if (audio && !audio.paused && !audio.ended) {
            this.pause();
            return;
        }
        await this.play();
    }

    stop() {
        if (!this._audio) {
            this._resolvePlayEndedWaiters();
            this._syncTransportButtons();
            return;
        }
        this._audio.pause();
        try {
            this._audio.currentTime = 0;
        } catch (_) {}
        window.__phonebotTtsSpeaking = false;
        this._resolvePlayEndedWaiters();
        this._setStatus("Stopped.");
        this._syncTransportButtons();
    }

    _onSelectChange() {
        this._selectedId = this._selectEl ? this._selectEl.value : "";
        if (!this._selectedId) {
            this.stop();
            this._setStatus("No file selected.");
            return;
        }
        const entry = this._loadSelected();
        if (entry) {
            this.stop();
            this._setStatus(`Selected: ${entry.label}`);
        }
        this._syncTransportButtons();
    }

    _onUpload(files) {
        const list = Array.from(files || []);
        if (!list.length) return;
        let added = 0;
        for (const file of list) {
            if (!file || !file.type.startsWith("audio/") && !AudioPlayerAiModel.AUDIO_EXTENSIONS.test(file.name)) {
                continue;
            }
            const url = URL.createObjectURL(file);
            this._objectUrls.push(url);
            const id = `upload:${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`;
            this._entries.push({
                id,
                label: file.name,
                url,
                source: "upload"
            });
            this._selectedId = id;
            added += 1;
        }
        this._rebuildSelect();
        if (this._selectEl) this._selectEl.value = this._selectedId;
        if (added) {
            this._loadSelected();
            this.stop();
            this._setStatus(`Uploaded ${added} file(s). Ready to play.`);
        } else {
            this._setStatus("No supported audio files in selection.", true);
        }
        this._syncTransportButtons();
    }

    buildGUI(container) {
        if (!container) return;

        const wrap = document.createElement("div");
        wrap.className = "ai-model ai-model-audio-player";

        const title = document.createElement("h4");
        title.textContent = this.name;

        const selectLabel = document.createElement("label");
        selectLabel.textContent = "File";
        const select = document.createElement("select");
        select.className = "audio-player-select";
        select.addEventListener("change", () => this._onSelectChange());
        selectLabel.appendChild(select);

        const uploadRow = document.createElement("div");
        uploadRow.className = "audio-player-upload-row";
        const uploadBtn = document.createElement("button");
        uploadBtn.type = "button";
        uploadBtn.textContent = "Upload…";
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "audio/*,.mp3,.wav,.ogg,.webm,.m4a,.aac,.flac,.opus";
        fileInput.multiple = true;
        fileInput.hidden = true;
        uploadBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
            this._onUpload(fileInput.files);
            fileInput.value = "";
        });
        uploadRow.appendChild(uploadBtn);
        uploadRow.appendChild(fileInput);

        const controls = document.createElement("div");
        controls.className = "ai-model-controls audio-player-controls";

        const playPauseBtn = document.createElement("button");
        playPauseBtn.type = "button";
        playPauseBtn.textContent = "Play";
        playPauseBtn.addEventListener("click", () => {
            void this.togglePlayPause();
        });

        const stopBtn = document.createElement("button");
        stopBtn.type = "button";
        stopBtn.textContent = "Stop";
        stopBtn.addEventListener("click", () => this.stop());

        controls.appendChild(playPauseBtn);
        controls.appendChild(stopBtn);

        const delayLabel = document.createElement("label");
        delayLabel.className = "audio-player-slider-label";
        delayLabel.innerHTML =
            'Delay <span class="audio-player-delay-value">0</span> ms <span class="muted">(+ hear later / mouth leads; − mouth lags)</span>';
        const delaySlider = document.createElement("input");
        delaySlider.type = "range";
        delaySlider.min = "-500";
        delaySlider.max = "500";
        delaySlider.step = "1";
        delaySlider.value = String(this.delayMs);
        delaySlider.addEventListener("input", () => this.setDelayMs(Number(delaySlider.value)));

        const compressorRow = document.createElement("label");
        compressorRow.className = "audio-player-slider-label audio-player-compressor-toggle";
        const compressorToggle = document.createElement("input");
        compressorToggle.type = "checkbox";
        compressorToggle.checked = this.compressorEnabled;
        compressorToggle.addEventListener("change", () => this.setCompressorEnabled(compressorToggle.checked));
        compressorRow.appendChild(compressorToggle);
        compressorRow.appendChild(
            document.createTextNode(" Compressor (louder / more even; files + TTS + parrot)")
        );

        const makeupLabel = document.createElement("label");
        makeupLabel.className = "audio-player-slider-label";
        makeupLabel.innerHTML =
            'Makeup gain <span class="audio-player-makeup-value">2.00</span>× <span class="muted">(post-compressor boost)</span>';
        const makeupSlider = document.createElement("input");
        makeupSlider.type = "range";
        makeupSlider.min = "0.25";
        makeupSlider.max = "8";
        makeupSlider.step = "0.05";
        makeupSlider.value = String(this.makeupGain);
        makeupSlider.addEventListener("input", () => this.setMakeupGain(Number(makeupSlider.value)));

        const compThresholdLabel = document.createElement("label");
        compThresholdLabel.className = "audio-player-slider-label";
        compThresholdLabel.innerHTML =
            'Comp threshold <span class="audio-player-comp-threshold-value">-24</span> dB <span class="muted">(lower = more compression)</span>';
        const compThresholdSlider = document.createElement("input");
        compThresholdSlider.type = "range";
        compThresholdSlider.min = "-60";
        compThresholdSlider.max = "0";
        compThresholdSlider.step = "1";
        compThresholdSlider.value = String(this.compressorThreshold);
        compThresholdSlider.addEventListener("input", () =>
            this.setCompressorThreshold(Number(compThresholdSlider.value))
        );

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Loading audio folder…";

        wrap.appendChild(title);
        wrap.appendChild(selectLabel);
        wrap.appendChild(uploadRow);
        wrap.appendChild(controls);
        wrap.appendChild(delayLabel);
        wrap.appendChild(delaySlider);
        wrap.appendChild(compressorRow);
        wrap.appendChild(makeupLabel);
        wrap.appendChild(makeupSlider);
        wrap.appendChild(compThresholdLabel);
        wrap.appendChild(compThresholdSlider);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._selectEl = select;
        this._playPauseBtn = playPauseBtn;
        this._stopBtn = stopBtn;
        this._fileInput = fileInput;
        this._statusEl = status;
        this._delaySlider = delaySlider;
        this._delayValueEl = delayLabel.querySelector(".audio-player-delay-value");
        this._compressorToggleEl = compressorToggle;
        this._makeupSlider = makeupSlider;
        this._makeupValueEl = makeupLabel.querySelector(".audio-player-makeup-value");
        this._compThresholdSlider = compThresholdSlider;
        this._compThresholdValueEl = compThresholdLabel.querySelector(".audio-player-comp-threshold-value");

        this.setDelayMs(this.delayMs);
        this.setMakeupGain(this.makeupGain);
        this.setCompressorThreshold(this.compressorThreshold);
        this.setCompressorEnabled(this.compressorEnabled);
        this._rebuildSelect();
        this._syncTransportButtons();
        void this.loadFolderListing();
    }

    destroy() {
        this.stop();
        this._revokeTtsUrl();
        this._disconnectGraph();
        this._mediaSource = null;
        this._compressorNode = null;
        this._makeupGainNode = null;
        this._analyserNode = null;
        this._delayNode = null;
        this._levelData = null;
        if (this._audioContext) {
            try {
                void this._audioContext.close();
            } catch (_) {}
            this._audioContext = null;
        }
        if (this._audio) {
            this._audio.removeAttribute("src");
            this._audio.load();
            this._audio = null;
        }
        this._loadedId = "";
        for (const url of this._objectUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch (_) {}
        }
        this._objectUrls = [];
        this._entries = [];
    }
}

window.AudioPlayerAiModel = AudioPlayerAiModel;
