/**
 * Simon Says Pose Match — local MoveNet + Groq TTS (via agent audio player).
 * Command: bring two body keypoints together (within ~eye-spacing).
 */
class SimonSaysPoseMatch {
    static OPENING_PHRASE = "Hello, Let's play a game of Simon Says!";
    static KEY_PHRASE = "Simon Says";
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
    static MATCH_EYE_TOLERANCE = 3;
    static FALLBACK_EYE_SPACING = 0.06;
    /** Pose must stay matched continuously for this long to count. */
    static MATCH_HOLD_MS = 450;
    /** Max time after the command to achieve that hold. */
    static POSE_CHECK_WINDOW_MS = 3000;
    static POSE_POLL_MS = 50;
    static SIMON_SAYS_PROBABILITY = 0.8;

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
    }

    start() {
        this.stop();
        this._running = true;
        this._generation += 1;
        const generation = this._generation;
        void this._runLoop(generation);
    }

    stop() {
        this._running = false;
        this._generation += 1;
        this._currentA = null;
        this._currentB = null;
        this._clearPoseHighlight();
        this._cancelSpeech();
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

    _cancelSpeech() {
        const agent = this._getAgent();
        if (agent && typeof agent._stopSpeaking === "function") {
            agent._stopSpeaking();
            return;
        }
        try {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        } catch (_) {}
        window.__phonebotTtsSpeaking = false;
    }

    /**
     * Speak via agent TTS (Groq Orpheus or Gemini; mouth servo can follow audioPlayer).
     * @param {string} text
     * @param {number} generation
     * @returns {Promise<boolean>} true if utterance finished while still active
     */
    async _speak(text, generation) {
        const content = String(text || "").trim();
        if (!content) return this._isActive(generation);
        if (!this._isActive(generation)) return false;

        const agent = this._getAgent();
        if (agent && typeof agent._speakAsync === "function") {
            // Sync API key from the UI before first TTS call.
            if (agent._keyInput) {
                agent._apiKey = agent._keyInput.value?.trim() || agent._apiKey;
            }
            const finished = await agent._speakAsync(content);
            return finished && this._isActive(generation);
        }

        this._setStatus("Agent TTS unavailable — is the agent panel loaded?", "error");
        return this._isActive(generation);
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
        return `touch your ${this._labelJoint(a)} to your ${this._labelJoint(b)}`;
    }

    /** Next wrong-pose line, cycling through {@link WRONG_POSE_PHRASES}. */
    _nextWrongPosePhrase() {
        const list = SimonSaysPoseMatch.WRONG_POSE_PHRASES;
        if (!list.length) return "Wrong pose. Try again.";
        const phrase = list[this._wrongPhraseIndex % list.length];
        this._wrongPhraseIndex = (this._wrongPhraseIndex + 1) % list.length;
        return phrase;
    }

    /** Next trap-gotcha line, cycling through {@link SIMON_DID_NOT_SAY_PHRASES}. */
    _nextSimonDidNotSayPhrase() {
        const list = SimonSaysPoseMatch.SIMON_DID_NOT_SAY_PHRASES;
        if (!list.length) {
            return "Hey, Simon did not say to do it. Got you. That's a point for me";
        }
        const phrase = list[this._gotchaPhraseIndex % list.length];
        this._gotchaPhraseIndex = (this._gotchaPhraseIndex + 1) % list.length;
        return phrase;
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
        if (this._simonSaid) {
            const okKey = await this._speak(SimonSaysPoseMatch.KEY_PHRASE, generation);
            if (!okKey) return false;
        }
        return this._speak(this._commandPhrase(this._currentA, this._currentB), generation);
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
        const opened = await this._speak(SimonSaysPoseMatch.OPENING_PHRASE, generation);
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
                        // Correct — silent, next round (step 2).
                        this._setStatus("Correct — next round…", "ok");
                    } else {
                        const said = await this._speak(this._nextWrongPosePhrase(), generation);
                        if (!said) return;
                        // Retry same command from step 4 (re-say Simon Says + command).
                        needAnnounce = true;
                    }
                } else if (correct) {
                    const said = await this._speak(this._nextSimonDidNotSayPhrase(), generation);
                    if (!said) return;
                    this._setStatus("Gotcha — next round…", "warn");
                } else {
                    // Correctly ignored the trap — silent next round.
                    this._setStatus("Good — you ignored the trap. Next…", "ok");
                }
            }
        }
        this._clearPoseHighlight();
    }
}

window.SimonSaysPoseMatch = SimonSaysPoseMatch;
