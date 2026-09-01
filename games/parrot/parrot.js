/**
 * Parrot — hold to record, then play the clip back through the robot mouth (no AI).
 */
class ParrotGame {
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
        const agent = this._getAgent();
        if (agent && typeof agent._stopSpeaking === "function") {
            agent._stopSpeaking();
        }
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

    /**
     * @param {Blob} blob
     * @param {number} generation
     * @returns {Promise<boolean>}
     */
    async _playRecording(blob, generation) {
        if (!blob || !blob.size) return this._isActive(generation);

        while (this._audioBusy) {
            if (!this._isActive(generation)) return false;
            const waited = await this._sleep(40, generation);
            if (!waited) return false;
        }
        if (!this._isActive(generation)) return false;

        const player = this._getAudioPlayer();
        if (!player || typeof player.playBlob !== "function") {
            console.warn("Parrot: audio player unavailable.");
            return false;
        }

        const agent = this._getAgent();
        if (agent && typeof agent._setPttState === "function") {
            agent._setPttState("talking");
        }

        this._audioBusy = true;
        try {
            await player.playBlob(blob, "parrot");
            return this._isActive(generation);
        } catch (err) {
            console.warn("Parrot playback failed:", err);
            return false;
        } finally {
            this._audioBusy = false;
            if (agent && typeof agent._armConversationPtt === "function") {
                agent._armConversationPtt();
            }
        }
    }

    async _runLoop(generation) {
        while (this._isActive(generation)) {
            const agent = this._getAgent();
            if (!agent || typeof agent.captureHoldRecording !== "function") {
                console.warn("Parrot: hold-to-speak capture unavailable.");
                return;
            }

            let blob = null;
            try {
                blob = await agent.captureHoldRecording({
                    isActive: () => this._isActive(generation)
                });
            } catch (err) {
                console.warn("Parrot record failed:", err);
                const waited = await this._sleep(800, generation);
                if (!waited) return;
                continue;
            }

            if (!this._isActive(generation)) return;
            if (!blob || !blob.size) {
                const waited = await this._sleep(200, generation);
                if (!waited) return;
                continue;
            }

            const played = await this._playRecording(blob, generation);
            if (!played) return;

            const gap = await this._sleep(400, generation);
            if (!gap) return;
        }
    }
}

window.ParrotGame = ParrotGame;
