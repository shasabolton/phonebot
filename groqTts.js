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

    /** Clamp text to Groq Orpheus max length. */
    static clampInput(text) {
        const s = String(text || "").trim();
        if (s.length <= GroqTts.MAX_INPUT_CHARS) return s;
        return `${s.slice(0, GroqTts.MAX_INPUT_CHARS - 1)}…`;
    }
}

window.GroqTts = GroqTts;
