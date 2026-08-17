/**
 * Groq Orpheus TTS — voice catalog + helpers (API call lives in AgentInterface).
 * Audio is a real WAV so audioMouthFilter can drive the mouth servo.
 */
class GroqTts {
    static MODEL_ENGLISH = "canopylabs/orpheus-v1-english";
    static STORAGE_VOICE = "phonebot.agent.groqTtsVoice";
    static DEFAULT_VOICE = "autumn";
    /** Orpheus on Groq rejects inputs longer than this. */
    static MAX_INPUT_CHARS = 200;

    static VOICES = [
        { id: "autumn", label: "Autumn — ♀" },
        { id: "diana", label: "Diana — ♀" },
        { id: "hannah", label: "Hannah — ♀" },
        { id: "austin", label: "Austin — ♂" },
        { id: "daniel", label: "Daniel — ♂" },
        { id: "troy", label: "Troy — ♂" }
    ];

    static loadSavedVoice() {
        try {
            const v = localStorage.getItem(GroqTts.STORAGE_VOICE);
            if (v && GroqTts.isKnownVoice(v)) return v;
        } catch (_) {}
        return GroqTts.DEFAULT_VOICE;
    }

    static saveVoice(voiceId) {
        const id = GroqTts.isKnownVoice(voiceId) ? voiceId : GroqTts.DEFAULT_VOICE;
        try {
            localStorage.setItem(GroqTts.STORAGE_VOICE, id);
        } catch (_) {}
        return id;
    }

    static isKnownVoice(voiceId) {
        return GroqTts.VOICES.some((v) => v.id === voiceId);
    }

    /** Clamp text to Groq Orpheus max length (single-chunk fallback). */
    static clampInput(text) {
        const s = String(text || "").trim();
        if (s.length <= GroqTts.MAX_INPUT_CHARS) return s;
        return `${s.slice(0, GroqTts.MAX_INPUT_CHARS - 1)}…`;
    }

    /**
     * Split long text into Orpheus-sized chunks, preferring sentence then word boundaries.
     * @param {string} text
     * @returns {string[]}
     */
    static splitInput(text) {
        const s = String(text || "").trim();
        if (!s) return [];
        if (s.length <= GroqTts.MAX_INPUT_CHARS) return [s];

        const chunks = [];
        let rest = s;
        const max = GroqTts.MAX_INPUT_CHARS;
        const minBreak = Math.floor(max * 0.45);

        while (rest.length > 0) {
            if (rest.length <= max) {
                chunks.push(rest);
                break;
            }
            const window = rest.slice(0, max);
            let cut = max;

            for (let i = window.length - 1; i >= minBreak; i--) {
                const ch = window[i];
                if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
                    cut = i + 1;
                    break;
                }
            }
            if (cut === max) {
                const space = window.lastIndexOf(" ");
                if (space >= minBreak) cut = space;
            }

            const piece = rest.slice(0, cut).trim();
            if (!piece) break;
            chunks.push(piece);
            rest = rest.slice(cut).trim();
        }

        return chunks.length ? chunks : [GroqTts.clampInput(s)];
    }
}

window.GroqTts = GroqTts;
