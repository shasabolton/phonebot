/**
 * Story: Escape the Wall — plays pre-recorded Austin narration from audio/, then returns to menu.
 */
class EscapeTheWallStory {
    static AUDIO_DIR = "audio";
    static MANIFEST_URL = "audio/escape-the-wall.json";
    static FALLBACK_FILES = Object.freeze([
        "escape-the-wall-00.wav",
        "escape-the-wall-01.wav",
        "escape-the-wall-02.wav",
        "escape-the-wall-03.wav",
        "escape-the-wall-04.wav",
        "escape-the-wall-05.wav",
        "escape-the-wall-06.wav",
        "escape-the-wall-07.wav",
        "escape-the-wall-08.wav",
        "escape-the-wall-09.wav",
        "escape-the-wall-10.wav",
        "escape-the-wall-11.wav",
        "escape-the-wall-12.wav"
    ]);

    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        this._running = false;
        this._generation = 0;
        this._audioBusy = false;
        this._sessionCompleted = false;
    }

    start() {
        if (this.robot && this.robot._modeReady === false) {
            void this._startAfterPayment();
            return;
        }
        this._startStory();
    }

    async _startAfterPayment() {
        if (typeof this.robot?._activateCurrentMode !== "function") return;
        await this.robot._activateCurrentMode();
    }

    _startStory() {
        this.stop();
        this._running = true;
        this._audioBusy = false;
        this._sessionCompleted = false;
        this._generation += 1;
        const generation = this._generation;
        void this._runStory(generation);
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._audioBusy = false;
        this._cancelSpeech();
    }

    _isActive(generation) {
        return this._running && generation === this._generation;
    }

    _getAudioPlayer() {
        if (!this.robot || typeof this.robot.getProcessingByType !== "function") return null;
        return this.robot.getProcessingByType("audioPlayer");
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

    _audioUrl(fileName) {
        const base = String(EscapeTheWallStory.AUDIO_DIR || "audio").replace(/\/+$/, "");
        const name = String(fileName || "").replace(/^\/+/, "");
        return `${base}/${name}`;
    }

    _sleep(ms, generation) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(this._isActive(generation)), Math.max(0, ms));
        });
    }

    async _loadClipFiles() {
        try {
            const res = await fetch(EscapeTheWallStory.MANIFEST_URL, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const files = Array.isArray(data?.files)
                ? data.files.map((f) => (typeof f === "string" ? f : f?.file)).filter(Boolean)
                : [];
            if (files.length) return files;
        } catch (err) {
            console.warn("Escape the Wall: manifest load failed, using fallback list.", err);
        }
        return EscapeTheWallStory.FALLBACK_FILES.slice();
    }

    /**
     * @param {string[]} fileNames
     * @param {number} generation
     * @returns {Promise<boolean>}
     */
    async _playAudioFiles(fileNames, generation) {
        const files = (Array.isArray(fileNames) ? fileNames : []).filter(Boolean);
        if (!files.length) return this._isActive(generation);

        while (this._audioBusy) {
            if (!this._isActive(generation)) return false;
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (!this._isActive(generation)) return false;

        const player = this._getAudioPlayer();
        if (!player || typeof player.playSrc !== "function") {
            console.warn("Escape the Wall: audio player unavailable.");
            return false;
        }

        this._audioBusy = true;
        try {
            for (const file of files) {
                if (!this._isActive(generation)) return false;
                try {
                    await player.playSrc(this._audioUrl(file), file);
                } catch (err) {
                    console.warn("Escape the Wall clip failed:", file, err);
                    return false;
                }
            }
            return this._isActive(generation);
        } finally {
            this._audioBusy = false;
        }
    }

    _finish() {
        if (this._sessionCompleted) return;
        this._sessionCompleted = true;
        this._running = false;
        if (typeof this.robot?.onLocalGameEnded === "function") {
            this.robot.onLocalGameEnded("escape_the_wall_finished");
        }
    }

    async _runStory(generation) {
        const files = await this._loadClipFiles();
        if (!this._isActive(generation)) return;

        const played = await this._playAudioFiles(files, generation);
        if (!played) return;

        if (!this._isActive(generation)) return;
        this._finish();
    }
}

window.EscapeTheWallStory = EscapeTheWallStory;
