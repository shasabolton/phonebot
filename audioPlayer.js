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

        /** Web Audio tap so processors (e.g. audioMouthFilter) can read playback level. */
        this._audioContext = null;
        this._mediaSource = null;
        this._analyserNode = null;
        this._levelData = null;
    }

    /** HTMLAudioElement used for playback (created lazily). */
    getAudioElement() {
        return this._ensureAudio();
    }

    /**
     * Route playback through Web Audio once so analysers can tap it.
     * Safe to call repeatedly; MediaElementSource is created only once.
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
            this._analyserNode = this._audioContext.createAnalyser();
            this._analyserNode.fftSize = 1024;
            this._levelData = new Uint8Array(this._analyserNode.fftSize);
            this._mediaSource.connect(this._analyserNode);
            this._analyserNode.connect(this._audioContext.destination);
            return this._analyserNode;
        } catch (err) {
            console.warn("Audio player playback tap failed:", err);
            return null;
        }
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
        });
        audio.addEventListener("pause", () => this._syncTransportButtons());
        audio.addEventListener("play", () => this._syncTransportButtons());
        audio.addEventListener("error", () => {
            this._setStatus("Could not play this file.", true);
            this._syncTransportButtons();
        });
        this._audio = audio;
        return audio;
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
            this._syncTransportButtons();
            return;
        }
        this._audio.pause();
        try {
            this._audio.currentTime = 0;
        } catch (_) {}
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

        const status = document.createElement("p");
        status.className = "muted";
        status.textContent = "Loading audio folder…";

        wrap.appendChild(title);
        wrap.appendChild(selectLabel);
        wrap.appendChild(uploadRow);
        wrap.appendChild(controls);
        wrap.appendChild(status);
        container.appendChild(wrap);

        this._selectEl = select;
        this._playPauseBtn = playPauseBtn;
        this._stopBtn = stopBtn;
        this._fileInput = fileInput;
        this._statusEl = status;

        this._rebuildSelect();
        this._syncTransportButtons();
        void this.loadFolderListing();
    }

    destroy() {
        this.stop();
        if (this._mediaSource) {
            try {
                this._mediaSource.disconnect();
            } catch (_) {}
            this._mediaSource = null;
        }
        if (this._analyserNode) {
            try {
                this._analyserNode.disconnect();
            } catch (_) {}
            this._analyserNode = null;
        }
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
