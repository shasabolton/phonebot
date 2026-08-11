/**
 * Simon Says Pose Match — local MoveNet + pre-recorded Austin clips (no AI API).
 * Command audio is sequenced: [Simon Says?] + Put your + X + on your + Y.
 */
class SimonSaysPoseMatch {
    static AUDIO_DIR = "simonSays/audio";
    static OPENING_PHRASE = "Hello, Let's play a game of Simon Says! First to three wins.";
    static KEY_PHRASE = "Simon Says";
    static WIN_SCORE = 3;
    /** Cycled when Simon said and the pose was wrong. */
    static WRONG_POSE_PHRASES = Object.freeze([
        "Wrong pose. Try again.",
        "That doesn't look right. Try again.",
        "Not quite. Give it another go.",
        "Hmm, that's not it. Try once more.",
        "Almost? Nope. Try again."
    ]);
    static SIMON_DID_NOT_SAY_PHRASES = Object.freeze([
        "Hey, Simon did not say to do it. Got you. That's a point for me",
        "Gotcha — Simon never said that. Point for me.",
        "Nice try, but Simon didn't say. That's mine.",
        "Ah ah ah — no Simon says. I score.",
        "You moved and Simon didn't say. Point to Simon."
    ]);

    /** Joint id → pre-recorded clip filename (Groq Orpheus Austin). */
    static JOINT_AUDIO = Object.freeze({
        left_wrist: "left-hand.wav",
        right_wrist: "right-hand.wav",
        nose: "nose.wav",
        left_ear: "left-ear.wav",
        right_ear: "right-ear.wav",
        left_shoulder: "left-shoulder.wav",
        right_shoulder: "right-shoulder.wav",
        left_elbow: "left-elbow.wav",
        right_elbow: "right-elbow.wav",
        left_hip: "left-hip.wav",
        right_hip: "right-hip.wav",
        left_ankle: "left-foot.wav",
        right_ankle: "right-foot.wav"
    });

    /** At least one hand (MoveNet wrist) is always in the pair. */
    static HAND_JOINTS = Object.freeze(["left_wrist", "right_wrist"]);
    /** Non-hand targets (same-side elbow is filtered out vs the chosen hand). */
    static OTHER_JOINTS = Object.freeze([
        "nose",
        "left_ear",
        "right_ear",
        "left_shoulder",
        "right_shoulder",
        "left_elbow",
        "right_elbow",
        "left_hip",
        "right_hip",
        "left_ankle",
        "right_ankle"
    ]);
    static COMMAND_JOINTS = Object.freeze([
        "left_wrist",
        "right_wrist",
        "nose",
        "left_ear",
        "right_ear",
        "left_shoulder",
        "right_shoulder",
        "left_elbow",
        "right_elbow",
        "left_hip",
        "right_hip",
        "left_ankle",
        "right_ankle"
    ]);

    static MIN_KEYPOINT_SCORE = 0.3;
    /** Match if distance ≤ this × inter-eye distance. */
    static MATCH_EYE_TOLERANCE = 4;
    static FALLBACK_EYE_SPACING = 0.06;
    /** Pose must stay matched continuously for this long to count. */
    static MATCH_HOLD_MS = 450;
    /** Max time after the command to achieve that hold. */
    static POSE_CHECK_WINDOW_MS = 3000;
    static POSE_POLL_MS = 50;
    /** Chance a command includes "Simon Says" (rest are traps). */
    static SIMON_SAYS_PROBABILITY = 0.5;
    /** Prompt step-back after nose + hip are missing this long. */
    static FRAME_MISSING_MS = 2000;
    static FRAME_POLL_MS = 100;

    /**
     * @param {object} robot
     */
    constructor(robot) {
        this.robot = robot;
        this._running = false;
        this._generation = 0;
        this._lastPairKey = "";
        this._currentA = null;
        this._currentB = null;
        this._simonSaid = false;
        this._wrongPhraseIndex = 0;
        this._gotchaPhraseIndex = 0;
        this._playerScore = 0;
        this._simonScore = 0;
        this._audioBusy = false;
        this._stepBackPlaying = false;
        /** @type {number|null} */
        this._frameMissingSince = null;
    }

    start() {
        this.stop();
        this._running = true;
        this._playerScore = 0;
        this._simonScore = 0;
        this._frameMissingSince = null;
        this._stepBackPlaying = false;
        this._audioBusy = false;
        this._generation += 1;
        const generation = this._generation;
        void this._runFramingWatch(generation);
        void this._runLoop(generation);
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._currentA = null;
        this._currentB = null;
        this._frameMissingSince = null;
        this._stepBackPlaying = false;
        this._audioBusy = false;
        this._clearPoseHighlight();
        this._cancelSpeech();
    }

    _scoreLine() {
        return `Simon ${this._simonScore}, you ${this._playerScore}`;
    }

    _numClip(n) {
        const v = Math.max(0, Math.min(5, Math.floor(Number(n) || 0)));
        return `num-${v}.wav`;
    }

    /** Announce "Simon x, you y" from sequenced clips. */
    async _announceScore(generation) {
        return this._playAudioFiles(
            [
                "score-simon.wav",
                this._numClip(this._simonScore),
                "score-you.wav",
                this._numClip(this._playerScore)
            ],
            generation
        );
    }

    /**
     * After a point: optional "point to you", then score line; stop if someone hit WIN_SCORE.
     * @param {"player"|"simon"} who
     * @returns {Promise<"continue"|"won"|false>} false = cancelled
     */
    async _onScored(who, generation) {
        if (who === "player") {
            const said = await this._playAudioFiles(["point-to-you.wav"], generation);
            if (!said) return false;
        }
        this._setStatus(this._scoreLine(), who === "player" ? "ok" : "warn");
        const scored = await this._announceScore(generation);
        if (!scored) return false;

        const target = SimonSaysPoseMatch.WIN_SCORE;
        if (this._playerScore >= target || this._simonScore >= target) {
            const playerWon = this._playerScore >= target;
            const winClip = playerWon ? "you-win.wav" : "simon-wins.wav";
            this._setStatus(
                playerWon
                    ? `You win! ${this._scoreLine()}`
                    : `Simon wins! ${this._scoreLine()}`,
                playerWon ? "ok" : "warn"
            );
            const ended = await this._playAudioFiles([winClip], generation);
            if (!ended) return false;
            return "won";
        }
        return "continue";
    }

    _isActive(generation) {
        return this._running && generation === this._generation;
    }

    _clearPoseHighlight() {
        const cv = this._getMoveNet();
        if (cv && typeof cv.setPoseMatchHighlight === "function") {
            cv.setPoseMatchHighlight(null);
        }
    }

    /** Paint target joints red with match-distance bubbles on the camera overlay. */
    _syncPoseHighlight() {
        const cv = this._getMoveNet();
        if (!cv || typeof cv.setPoseMatchHighlight !== "function") return;
        if (!this._currentA || !this._currentB) {
            cv.setPoseMatchHighlight(null);
            return;
        }
        cv.setPoseMatchHighlight({
            names: [this._currentA, this._currentB],
            eyeTolerance: SimonSaysPoseMatch.MATCH_EYE_TOLERANCE,
            fallbackEyeSpacing: SimonSaysPoseMatch.FALLBACK_EYE_SPACING
        });
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

    _audioUrl(fileName) {
        const base = String(SimonSaysPoseMatch.AUDIO_DIR || "simonSays/audio").replace(/\/+$/, "");
        const name = String(fileName || "").replace(/^\/+/, "");
        return `${base}/${name}`;
    }

    _jointAudioFile(jointName) {
        return SimonSaysPoseMatch.JOINT_AUDIO[jointName] || null;
    }

    /**
     * Play pre-recorded clips in order via audioPlayer (mouth sync).
     * @param {string[]} fileNames
     * @param {number} generation
     * @returns {Promise<boolean>} true if all clips finished while still active
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
            this._setStatus("Audio player unavailable for Simon Says clips.", "error");
            return false;
        }

        this._audioBusy = true;
        try {
            for (const file of files) {
                if (!this._isActive(generation)) return false;
                try {
                    await player.playSrc(this._audioUrl(file), file);
                } catch (err) {
                    console.warn("Simon Says clip failed:", file, err);
                    this._setStatus(`Could not play ${file}`, "error");
                    return false;
                }
            }
            return this._isActive(generation);
        } finally {
            this._audioBusy = false;
        }
    }

    /** True when nose and at least one hip are confidently in view (waist → head). */
    _hasWaistToHeadFrame(keypoints) {
        const nose = this._byName(keypoints, "nose");
        if (!this._isVisible(nose)) return false;
        const leftHip = this._byName(keypoints, "left_hip");
        const rightHip = this._byName(keypoints, "right_hip");
        return this._isVisible(leftHip) || this._isVisible(rightHip);
    }

    /**
     * While the game runs: if nose + hip stay out of view for FRAME_MISSING_MS, play step-back.
     * Waits for other clips to finish so we don't cut off commands mid-sentence.
     */
    async _runFramingWatch(generation) {
        const needMs = SimonSaysPoseMatch.FRAME_MISSING_MS;
        const pollMs = SimonSaysPoseMatch.FRAME_POLL_MS;

        while (this._isActive(generation)) {
            if (this._hasWaistToHeadFrame(this._getKeypoints())) {
                this._frameMissingSince = null;
            } else if (this._frameMissingSince == null) {
                this._frameMissingSince = performance.now();
            } else if (
                !this._audioBusy &&
                !this._stepBackPlaying &&
                performance.now() - this._frameMissingSince >= needMs
            ) {
                this._stepBackPlaying = true;
                this._setStatus("Step back — need waist to head in view", "warn");
                try {
                    const played = await this._playAudioFiles(["step-back.wav"], generation);
                    if (!played) return;
                } finally {
                    this._stepBackPlaying = false;
                    // Require another full missing stretch before repeating.
                    this._frameMissingSince = performance.now();
                }
            }

            const ok = await this._sleep(pollMs, generation);
            if (!ok) return;
        }
    }

    _sleep(ms, generation) {
        return new Promise((resolve) => {
            setTimeout(() => resolve(this._isActive(generation)), Math.max(0, ms));
        });
    }

    _getMoveNet() {
        const cv =
            this.robot && typeof this.robot.getProcessingByType === "function"
                ? this.robot.getProcessingByType("computervision")
                : null;
        if (!cv || String(cv.model || "").toLowerCase() !== "movenet") return null;
        return cv;
    }

    _getKeypoints() {
        const cv = this._getMoveNet();
        if (!cv) return [];
        // Prefer intrinsic pixel keypoints so match distance matches overlay bubbles.
        const raw = Array.isArray(cv._poses) ? cv._poses : null;
        const rawKp = raw?.[0]?.keypoints;
        if (Array.isArray(rawKp) && rawKp.length) return rawKp;
        const poses = typeof cv.poses !== "undefined" ? cv.poses : null;
        const keypoints = poses?.[0]?.keypoints;
        return Array.isArray(keypoints) ? keypoints : [];
    }

    _byName(keypoints, name) {
        const want = String(name || "").toLowerCase();
        return keypoints.find((kp) => String(kp?.name || "").toLowerCase() === want) || null;
    }

    _isVisible(kp) {
        return (
            !!kp &&
            (kp.score || 0) >= SimonSaysPoseMatch.MIN_KEYPOINT_SCORE &&
            Number.isFinite(Number(kp.x)) &&
            Number.isFinite(Number(kp.y))
        );
    }

    _dist(a, b) {
        const dx = Number(a.x) - Number(b.x);
        const dy = Number(a.y) - Number(b.y);
        return Math.hypot(dx, dy);
    }

    _eyeSpacing(keypoints) {
        const left = this._byName(keypoints, "left_eye");
        const right = this._byName(keypoints, "right_eye");
        if (this._isVisible(left) && this._isVisible(right)) {
            const d = this._dist(left, right);
            // Pixel space: eyes are typically tens of px apart; normalized fallback is ~0.06.
            if (d > 1) return d;
            if (d > 0.01) return d;
        }
        const cv = this._getMoveNet();
        const fw = Number(cv?._frameWidth) || 0;
        const fh = Number(cv?._frameHeight) || 0;
        if (fw > 1 && fh > 1) {
            return SimonSaysPoseMatch.FALLBACK_EYE_SPACING * Math.min(fw, fh);
        }
        return SimonSaysPoseMatch.FALLBACK_EYE_SPACING;
    }

    _visibleCommandJoints(keypoints) {
        const out = [];
        for (const name of SimonSaysPoseMatch.COMMAND_JOINTS) {
            const kp = this._byName(keypoints, name);
            if (this._isVisible(kp)) out.push(name);
        }
        return out;
    }

    _pairKey(a, b) {
        return [a, b].map((n) => String(n).toLowerCase()).sort().join("|");
    }

    _labelJoint(name) {
        return String(name || "")
            .replace(/_/g, " ")
            .replace(/\bwrist\b/gi, "hand")
            .replace(/\bankle\b/gi, "foot")
            .trim();
    }

    _commandPhrase(a, b) {
        return `Put your ${this._labelJoint(a)} on your ${this._labelJoint(b)}`;
    }

    /** Next wrong-pose line, cycling through {@link WRONG_POSE_PHRASES}. */
    _nextWrongPoseClip() {
        const list = SimonSaysPoseMatch.WRONG_POSE_PHRASES;
        const i = list.length ? this._wrongPhraseIndex % list.length : 0;
        this._wrongPhraseIndex = list.length ? (i + 1) % list.length : 0;
        return `wrong-pose-${i}.wav`;
    }

    /** Next trap-gotcha line, cycling through {@link SIMON_DID_NOT_SAY_PHRASES}. */
    _nextSimonDidNotSayClip() {
        const list = SimonSaysPoseMatch.SIMON_DID_NOT_SAY_PHRASES;
        const i = list.length ? this._gotchaPhraseIndex % list.length : 0;
        this._gotchaPhraseIndex = list.length ? (i + 1) % list.length : 0;
        return `gotcha-${i}.wav`;
    }

    _jointSide(name) {
        const n = String(name || "").toLowerCase();
        if (n.startsWith("left_")) return "left";
        if (n.startsWith("right_")) return "right";
        return null;
    }

    _isWrist(name) {
        return name === "left_wrist" || name === "right_wrist";
    }

    _isElbow(name) {
        return name === "left_elbow" || name === "right_elbow";
    }

    /**
     * Valid command: at least one hand; hands may touch; never same-side elbow with a hand.
     * @param {string} hand
     * @param {string} other
     */
    _isValidPair(hand, other) {
        if (hand === other) return false;
        // Hands together.
        if (this._isWrist(hand) && this._isWrist(other)) return true;
        if (!this._isWrist(hand) || this._isWrist(other)) return false;
        if (this._isElbow(other) && this._jointSide(hand) === this._jointSide(other)) {
            return false;
        }
        return true;
    }

    /**
     * Pick one visible hand + target (or both hands). ≠ last pair when possible.
     * @returns {[string, string]|null} [hand, other]
     */
    _pickPair(keypoints) {
        const visible = new Set(this._visibleCommandJoints(keypoints));
        const hands = SimonSaysPoseMatch.HAND_JOINTS.filter((h) => visible.has(h));
        if (!hands.length) return null;

        const build = (skipLast) => {
            const out = [];
            // Allow clap / hands together when both are visible.
            if (hands.length === 2) {
                const a = "left_wrist";
                const b = "right_wrist";
                if (!skipLast || this._pairKey(a, b) !== this._lastPairKey) {
                    out.push([a, b]);
                }
            }
            for (const hand of hands) {
                for (const other of SimonSaysPoseMatch.OTHER_JOINTS) {
                    if (!visible.has(other)) continue;
                    if (!this._isValidPair(hand, other)) continue;
                    if (skipLast && this._pairKey(hand, other) === this._lastPairKey) continue;
                    out.push([hand, other]);
                }
            }
            return out;
        };

        const candidates = build(true);
        const pool = candidates.length ? candidates : build(false);
        if (!pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    /**
     * True when the two commanded joints are close enough (eye-spacing units).
     */
    _isPoseCorrect(keypoints, nameA, nameB) {
        const a = this._byName(keypoints, nameA);
        const b = this._byName(keypoints, nameB);
        if (!this._isVisible(a) || !this._isVisible(b)) return false;
        const eye = this._eyeSpacing(keypoints);
        const limit = eye * SimonSaysPoseMatch.MATCH_EYE_TOLERANCE;
        return this._dist(a, b) <= limit;
    }

    _setStatus(text, cls = "muted") {
        const el = this.robot?.agentInterface?._statusEl;
        if (!el) return;
        el.className = cls;
        el.textContent = text;
    }

    async _announceCommand(generation) {
        const jointA = this._jointAudioFile(this._currentA);
        const jointB = this._jointAudioFile(this._currentB);
        if (!jointA || !jointB) {
            this._setStatus("Missing joint audio clip for this pose.", "error");
            return false;
        }
        const clips = [];
        if (this._simonSaid) clips.push("simon-says.wav");
        clips.push("put-your.wav", jointA, "on-your.wav", jointB);
        return this._playAudioFiles(clips, generation);
    }

    /**
     * Poll MoveNet until the pose is held for MATCH_HOLD_MS, or the check window ends.
     * @returns {Promise<boolean|null>} true = held match; false = never held long enough; null = cancelled
     */
    async _waitAndCheck(generation) {
        const holdNeed = SimonSaysPoseMatch.MATCH_HOLD_MS;
        const windowMs = SimonSaysPoseMatch.POSE_CHECK_WINDOW_MS;
        const pollMs = SimonSaysPoseMatch.POSE_POLL_MS;
        const started = performance.now();
        let holdStart = null;

        while (this._isActive(generation)) {
            const now = performance.now();
            const elapsed = now - started;
            const matched = this._isPoseCorrect(
                this._getKeypoints(),
                this._currentA,
                this._currentB
            );

            if (matched) {
                if (holdStart == null) holdStart = now;
                const heldMs = now - holdStart;
                if (heldMs >= holdNeed) {
                    this._setStatus(`Held ${Math.round(heldMs)}ms — match!`, "ok");
                    return true;
                }
                this._setStatus(
                    `Holding… ${Math.round(heldMs)}/${holdNeed}ms`,
                    "muted"
                );
            } else {
                holdStart = null;
                const left = Math.max(0, Math.ceil((windowMs - elapsed) / 1000));
                this._setStatus(`Strike a pose… ${left}s`, "muted");
            }

            if (elapsed >= windowMs) {
                return false;
            }

            const ok = await this._sleep(pollMs, generation);
            if (!ok) return null;
        }
        return null;
    }

    async _runLoop(generation) {
        this._setStatus("Simon Says Pose Match — stand in view of the camera…");
        const opened = await this._playAudioFiles(["opening.wav"], generation);
        if (!opened) return;

        // 2) Pick pose → announce → check → score; repeat.
        while (this._isActive(generation)) {
            let pair = this._pickPair(this._getKeypoints());
            let waitForPose = 0;
            while (!pair && this._isActive(generation)) {
                this._setStatus("Waiting for a clear MoveNet pose…", "warn");
                const ok = await this._sleep(400, generation);
                if (!ok) return;
                waitForPose += 1;
                if (waitForPose > 40) {
                    this._setStatus("No pose seen — is the camera and MoveNet on?", "warn");
                }
                pair = this._pickPair(this._getKeypoints());
            }
            if (!this._isActive(generation) || !pair) return;

            this._currentA = pair[0];
            this._currentB = pair[1];
            this._lastPairKey = this._pairKey(this._currentA, this._currentB);
            this._simonSaid = Math.random() < SimonSaysPoseMatch.SIMON_SAYS_PROBABILITY;
            this._syncPoseHighlight();

            // Fresh command (or retry after wrong pose when Simon said).
            let needAnnounce = true;
            while (this._isActive(generation) && needAnnounce) {
                needAnnounce = false;
                this._syncPoseHighlight();
                this._setStatus(
                    this._simonSaid
                        ? `Simon says: ${this._commandPhrase(this._currentA, this._currentB)}`
                        : `Trap (no Simon): ${this._commandPhrase(this._currentA, this._currentB)}`
                );

                const announced = await this._announceCommand(generation);
                if (!announced) return;

                const correct = await this._waitAndCheck(generation);
                if (correct == null) return;

                if (this._simonSaid) {
                    if (correct) {
                        // Correct pose — no score, next round.
                        this._setStatus(
                            `Correct — ${this._scoreLine()}. Next…`,
                            "ok"
                        );
                    } else {
                        const said = await this._playAudioFiles(
                            [this._nextWrongPoseClip()],
                            generation
                        );
                        if (!said) return;
                        // Retry same command from step 4 (re-say Simon Says + command).
                        needAnnounce = true;
                    }
                } else if (correct) {
                    // Fell for the trap — Simon scores.
                    this._simonScore += 1;
                    const said = await this._playAudioFiles(
                        [this._nextSimonDidNotSayClip()],
                        generation
                    );
                    if (!said) return;
                    const result = await this._onScored("simon", generation);
                    if (result === false) return;
                    if (result === "won") {
                        this._running = false;
                        break;
                    }
                } else {
                    // Correctly ignored the trap — player scores.
                    this._playerScore += 1;
                    const result = await this._onScored("player", generation);
                    if (result === false) return;
                    if (result === "won") {
                        this._running = false;
                        break;
                    }
                }
            }
            if (!this._running) break;
        }
        this._clearPoseHighlight();
    }
}

window.SimonSaysPoseMatch = SimonSaysPoseMatch;
