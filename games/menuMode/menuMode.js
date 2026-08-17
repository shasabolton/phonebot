/**
 * Menu Mode — pre-recorded Austin clips while the user picks a game from the mode menu.
 * Intro plays once per browser session; idle nudges cycle every 5s until a game is chosen.
 */
class MenuMode {
    static AUDIO_DIR = "games/menuMode/audio";
    static INTRO_STORAGE_KEY = "phonebot.menuMode.introPlayed";
    static IDLE_MS = 5000;
    static INTRO_FILE = "intro.wav";
    static NUDGE_FILES = Object.freeze([
        "nudge-0.wav",
        "nudge-1.wav",
        ["nudge-2a.wav", "nudge-2b.wav"],
        "nudge-3.wav",
        "nudge-4.wav",
        "nudge-5.wav"
    ]);

    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        this._running = false;
        this._generation = 0;
        this._audioBusy = false;
    }

    start() {
        this.stop();
        this._running = true;
        this._audioBusy = false;
        this._generation += 1;
        const generation = this._generation;
        void this._runLoop(generation);
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._audioBusy = false;
        this._cancelSpeech();
    }

    static _introPlayedThisSession() {
        try {
            return sessionStorage.getItem(MenuMode.INTRO_STORAGE_KEY) === "1";
        } catch (_) {
            return false;
        }
    }

    static _markIntroPlayed() {
        try {
            sessionStorage.setItem(MenuMode.INTRO_STORAGE_KEY, "1");
        } catch (_) {}
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
        const base = String(MenuMode.AUDIO_DIR || "games/menuMode/audio").replace(/\/+$/, "");
        const name = String(fileName || "").replace(/^\/+/, "");
        return `${base}/${name}`;
    }

    _sleep(ms, generation) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(this._isActive(generation)), Math.max(0, ms));
        });
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
            console.warn("Menu Mode: audio player unavailable.");
            return false;
        }

        this._audioBusy = true;
        try {
            for (const file of files) {
                if (!this._isActive(generation)) return false;
                try {
                    await player.playSrc(this._audioUrl(file), file);
                } catch (err) {
                    console.warn("Menu Mode clip failed:", file, err);
                    return false;
                }
            }
            return this._isActive(generation);
        } finally {
            this._audioBusy = false;
        }
    }

    async _runLoop(generation) {
        if (!MenuMode._introPlayedThisSession()) {
            const played = await this._playAudioFiles([MenuMode.INTRO_FILE], generation);
            if (!played) return;
            MenuMode._markIntroPlayed();
        }

        let nudgeIndex = 0;
        while (this._isActive(generation)) {
            const idle = await this._sleep(MenuMode.IDLE_MS, generation);
            if (!idle) return;

            const entry = MenuMode.NUDGE_FILES[nudgeIndex % MenuMode.NUDGE_FILES.length];
            nudgeIndex += 1;
            const files = Array.isArray(entry) ? entry : [entry];
            const played = await this._playAudioFiles(files, generation);
            if (!played) return;
        }
    }
}

window.MenuMode = MenuMode;
