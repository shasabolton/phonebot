/**
 * Browser Web Speech (speechSynthesis) helpers.
 * Autonomously picks a male voice — no user selection UI.
 */
class BrowserTts {
    static MALE_NAME_RE =
        /\b(male|david|mark|daniel|george|james|thomas|alex|fred|bruce|ravi|guy|arthur|aaron|brian|eric|ryan|sam|will|william|noah|oliver|matthew|microsoft\s+david|google\s+uk\s+english\s+male|google\s+us\s+english\s+male)\b/i;
    static FEMALE_NAME_RE =
        /\b(female|zira|hazel|susan|samantha|karen|moira|tessa|fiona|veena|helen|catherine|martha|linda|amy|emma|jenny|sara|sarah|victoria|google\s+uk\s+english\s+female|google\s+us\s+english\s+female)\b/i;

    /** @type {SpeechSynthesisVoice|null} */
    static _cachedMaleVoice = null;

    static ensureVoicesReady() {
        return new Promise((resolve) => {
            const synth = window.speechSynthesis;
            if (!synth || typeof synth.getVoices !== "function") {
                resolve([]);
                return;
            }
            const list = () => synth.getVoices() || [];
            const ready = list();
            if (ready.length) {
                resolve(ready);
                return;
            }
            let settled = false;
            const finish = (voices) => {
                if (settled) return;
                settled = true;
                synth.removeEventListener("voiceschanged", onChange);
                clearTimeout(timeout);
                resolve(voices);
            };
            const onChange = () => {
                const voices = list();
                if (voices.length) finish(voices);
            };
            synth.addEventListener("voiceschanged", onChange);
            const timeout = setTimeout(() => finish(list()), 1500);
            // Some browsers only populate after an initial getVoices() call.
            list();
        });
    }

    /**
     * Pick a male-leaning English voice from the browser catalog.
     * @param {SpeechSynthesisVoice[]} voices
     * @param {string} [langPrefix="en"]
     * @returns {SpeechSynthesisVoice|null}
     */
    static pickMaleVoice(voices, langPrefix = "en") {
        const all = Array.isArray(voices) ? voices : [];
        const prefix = String(langPrefix || "en").toLowerCase();
        const en = all.filter((v) => String(v.lang || "").toLowerCase().startsWith(prefix));
        const pool = en.length ? en : all;
        if (!pool.length) return null;

        const maleTagged = pool.find((v) => /\bmale\b/i.test(v.name || ""));
        if (maleTagged) return maleTagged;

        const namedMale = pool.find(
            (v) =>
                BrowserTts.MALE_NAME_RE.test(v.name || "") &&
                !BrowserTts.FEMALE_NAME_RE.test(v.name || "")
        );
        if (namedMale) return namedMale;

        const notFemale = pool.find(
            (v) =>
                !/\bfemale\b/i.test(v.name || "") &&
                !BrowserTts.FEMALE_NAME_RE.test(v.name || "")
        );
        if (notFemale) return notFemale;

        return pool[0] || null;
    }

    /**
     * Resolve and cache a male voice, then assign it on the utterance.
     * @param {SpeechSynthesisUtterance} utterance
     * @returns {Promise<SpeechSynthesisVoice|null>}
     */
    static async applyMaleVoice(utterance) {
        if (!utterance) return null;
        if (BrowserTts._cachedMaleVoice) {
            utterance.voice = BrowserTts._cachedMaleVoice;
            if (BrowserTts._cachedMaleVoice.lang) {
                utterance.lang = BrowserTts._cachedMaleVoice.lang;
            }
            return BrowserTts._cachedMaleVoice;
        }
        const voices = await BrowserTts.ensureVoicesReady();
        const voice = BrowserTts.pickMaleVoice(voices);
        if (voice) {
            BrowserTts._cachedMaleVoice = voice;
            utterance.voice = voice;
            if (voice.lang) utterance.lang = voice.lang;
        }
        return voice;
    }
}

window.BrowserTts = BrowserTts;
