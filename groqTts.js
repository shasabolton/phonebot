/**
 * Groq Orpheus TTS — voice catalog + helpers (API call lives in AgentInterface).
 * Audio is a real WAV so audioMouthFilter can drive the mouth servo.
 */
class GroqTts {
    static MODEL_ENGLISH = "canopylabs/orpheus-v1-english";
    static STORAGE_VOICE = "phonebot.agent.groqTtsVoice";
    /** Preferred default; falls back to first catalog entry if missing. */
    static PREFERRED_VOICE = "austin";
    static DEFAULT_VOICE = "austin";
    /** Free browser speechSynthesis — not an Orpheus voice id. */
    static WEB_VOICE_ID = "browser";
    static WEB_VOICE_LABEL = "Web TTS (free)";
    /** Orpheus on Groq rejects inputs longer than this. */
    static MAX_INPUT_CHARS = 200;

    static VOICES = [
        { id: "austin", label: "Austin — ♂" },
        { id: "autumn", label: "Autumn — ♀" },
        { id: "diana", label: "Diana — ♀" },
        { id: "hannah", label: "Hannah — ♀" },
        { id: "daniel", label: "Daniel — ♂" },
        { id: "troy", label: "Troy — ♂" }
    ];

    /** Web TTS + Groq Orpheus catalog for pickers that offer both. */
    static pickerVoices() {
        return [
            { id: GroqTts.WEB_VOICE_ID, label: GroqTts.WEB_VOICE_LABEL, provider: "browser" },
            ...GroqTts.VOICES.map((v) => ({ ...v, provider: "groq" }))
        ];
    }

    static isWebVoice(voiceId) {
        const id = String(voiceId || "")
            .trim()
            .toLowerCase();
        return id === GroqTts.WEB_VOICE_ID || id === "web";
    }

    /** First voice id in the catalog (fallback when preferred is gone). */
    static firstVoiceId(voices = GroqTts.VOICES) {
        const list = Array.isArray(voices) ? voices : [];
        if (!list.length) return GroqTts.PREFERRED_VOICE;
        const first = list[0];
        return typeof first === "string" ? first : String(first?.id || GroqTts.PREFERRED_VOICE);
    }

    /**
     * Prefer Austin when present; otherwise first catalog voice.
     * Passes through Web TTS id unchanged.
     * @param {string} [requested]
     * @param {{ id: string }[]|string[]} [voices]
     */
    static resolveVoice(requested, voices = GroqTts.VOICES) {
        if (GroqTts.isWebVoice(requested)) return GroqTts.WEB_VOICE_ID;
        if (typeof window.GroqModelSelect?.resolveOrpheusVoice === "function") {
            const ids = (Array.isArray(voices) ? voices : GroqTts.VOICES)
                .map((v) => (typeof v === "string" ? v : String(v?.id || "").trim()))
                .filter((id) => id && !GroqTts.isWebVoice(id));
            return window.GroqModelSelect.resolveOrpheusVoice(requested, ids);
        }
        const list = Array.isArray(voices) ? voices : GroqTts.VOICES;
        const ids = list
            .map((v) => (typeof v === "string" ? v : String(v?.id || "").trim()))
            .filter((id) => id && !GroqTts.isWebVoice(id));
        const want = String(requested || "").trim();
        if (want && ids.includes(want)) return want;
        if (ids.includes(GroqTts.PREFERRED_VOICE)) return GroqTts.PREFERRED_VOICE;
        return ids[0] || GroqTts.PREFERRED_VOICE;
    }

    static loadSavedVoice() {
        try {
            const v = localStorage.getItem(GroqTts.STORAGE_VOICE);
            if (v) return GroqTts.resolveVoice(v);
        } catch (_) {}
        return GroqTts.resolveVoice(GroqTts.PREFERRED_VOICE);
    }

    static saveVoice(voiceId) {
        const id = GroqTts.resolveVoice(voiceId);
        try {
            localStorage.setItem(GroqTts.STORAGE_VOICE, id);
        } catch (_) {}
        return id;
    }

    static isKnownVoice(voiceId) {
        if (GroqTts.isWebVoice(voiceId)) return true;
        return GroqTts.VOICES.some((v) => v.id === voiceId);
    }

    /** Spoken-body budget after reserving Orpheus vocal-direction tags. */
    static speechBodyBudget() {
        if (typeof window !== "undefined" && window.GroqModelSelect?.orpheusSpeechBodyBudget) {
            return window.GroqModelSelect.orpheusSpeechBodyBudget(GroqTts.MAX_INPUT_CHARS);
        }
        const prefix = "[clearly][confident] ";
        return Math.max(1, GroqTts.MAX_INPUT_CHARS - prefix.length);
    }

    /**
     * Clamp text to Groq Orpheus max length and prepend [clearly][confident].
     * @param {string} text
     * @returns {string}
     */
    static clampInput(text) {
        if (typeof window !== "undefined" && window.GroqModelSelect?.applyOrpheusVocalDirections) {
            return window.GroqModelSelect.applyOrpheusVocalDirections(text, GroqTts.MAX_INPUT_CHARS);
        }
        const prefix = "[clearly][confident] ";
        let s = String(text || "").trim();
        if (!s) return "";
        s = s.replace(/^(\[(?:clearly|confident(?:ly)?)\]\s*)+/i, "").trim();
        if (!s) return "";
        const maxBody = Math.max(1, GroqTts.MAX_INPUT_CHARS - prefix.length);
        const body = s.length <= maxBody ? s : `${s.slice(0, maxBody - 1)}…`;
        return `${prefix}${body}`;
    }

    /**
     * Split long text into Orpheus-sized chunks (body only; tags applied in clampInput).
     * @param {string} text
     * @returns {string[]}
     */
    static splitInput(text) {
        const s = String(text || "")
            .trim()
            .replace(/^(\[(?:clearly|confident(?:ly)?)\]\s*)+/i, "")
            .trim();
        if (!s) return [];
        const max = GroqTts.speechBodyBudget();
        if (s.length <= max) return [s];

        const chunks = [];
        let rest = s;
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
