/**
 * Telnyx: live model and voice lists, plain (REST) speech, and the streamed hold-to-talk turn.
 * On the player's own key, REST calls go straight to Telnyx (it allows browser calls). With the
 * HOSTED key they go through the phonebot Worker on the Worker's key and the play session's AI
 * credit. Browser WebSockets cannot send an Authorization header, so streamed turns always go
 * through the Worker (`/api/telnyx/stream`, see worker/src/telnyxStream.js).
 */
class TelnyxVoice {
    static API_BASE = "https://api.telnyx.com/v2";
    /** Passed instead of a key: use the Worker's Telnyx key, charged to AI credit. */
    static HOSTED = "phonebot-hosted";
    static VOICE_PROVIDERS = ["telnyx", "minimax", "aws", "azure", "xai", "soniox"];
    /** Picker group names; "designed" holds voices saved from Voice Design on the account. */
    static PROVIDER_NAMES = {
        designed: "Your designed",
        telnyx: "Telnyx",
        minimax: "MiniMax",
        aws: "AWS Polly",
        azure: "Azure",
        xai: "xAI",
        soniox: "Soniox"
    };
    /** Voice Design models: Qwen3TTS follows the description closely, MiniMax makes its own take on it. */
    static DESIGN_PROVIDERS = [
        { id: "telnyx", label: "Telnyx Qwen3TTS (follows the description closely)" },
        { id: "minimax", label: "MiniMax (its own take on the description)" }
    ];
    /** localStorage override for the stream socket, e.g. ws://localhost:8787/api/telnyx/stream under `wrangler dev`. */
    static STORAGE_STREAM_URL = "phonebot.telnyx.streamUrl";
    /** Model lists without a `task` field: drop speech, embedding and guard models. */
    static NOT_CHAT_MODEL = /whisper|nova-|embed|rerank|guard|tts|-lora$/i;
    /** Chat tasks once spelling is normalised (Telnyx sends "text generation", "text-generation" and "text-to-text"). */
    static CHAT_TASKS = ["text-generation", "text-to-text", "image-text-to-text"];
    /** A typical game turn, for comparing prices: a long prompt (character, rules, history) and a short spoken reply. */
    static TURN_INPUT_TOKENS = 1500;
    static TURN_OUTPUT_TOKENS = 150;
    /** Automatic choice needs room for a game's prompt and history... */
    static MIN_CHAT_CONTEXT = 8192;
    /** ...and a model big enough to play 20 Questions, unless Telnyx recommends it for assistants. */
    static MIN_CHAT_PARAMETERS = 20e9;
    /** These reject `chat_template_kwargs`, which is how thinking is turned off for voice speed. */
    static REJECTS_TEMPLATE_KWARGS = /mistral/i;

    static _withKeyHint(message) {
        const text = String(message || "");
        if (!/\b10009\b|malformed|Authentication failed|credentials/i.test(text)) return text;
        return `${text} Telnyx API keys start with "KEY".`;
    }

    /** `status` and, from the Worker's 402, `session` are kept on the error for the paywall. */
    static async _errorFrom(label, response) {
        const raw = await response.text().catch(() => "");
        let detail = raw.slice(0, 400);
        let session = null;
        try {
            const parsed = JSON.parse(raw);
            const first = parsed?.errors?.[0];
            if (first) detail = `${first.code ? `${first.code} ` : ""}${first.detail || first.title || detail}`;
            else if (typeof parsed?.error === "string") detail = parsed.error;
            else if (typeof parsed?.error?.message === "string") detail = parsed.error.message;
            session = parsed?.session || null;
        } catch (_) {}
        const error = new Error(TelnyxVoice._withKeyHint(`${label} failed (HTTP ${response.status}): ${detail}`));
        error.status = response.status;
        error.session = session;
        return error;
    }

    /** A Telnyx API path (e.g. "/ai/openai/models") on the player's key, or through the Worker for HOSTED. */
    static fetch(path, init = {}, key) {
        if (key === TelnyxVoice.HOSTED) {
            if (typeof window.playBilling?.fetchHostedTelnyx !== "function") {
                return Promise.reject(new Error("Hosted Telnyx needs the arcade billing script."));
            }
            return window.playBilling.fetchHostedTelnyx(path, init);
        }
        return fetch(`${TelnyxVoice.API_BASE}${path}`, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${key}` }
        });
    }

    static async _getJson(label, path, key) {
        const response = await TelnyxVoice.fetch(path, {}, key);
        if (!response.ok) throw await TelnyxVoice._errorFrom(label, response);
        return response.json();
    }

    static async _postJson(label, path, key, body) {
        const response = await TelnyxVoice.fetch(
            path,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
            key
        );
        if (!response.ok) throw await TelnyxVoice._errorFrom(label, response);
        return response.json();
    }

    /** Telnyx voice ids look like "Telnyx.KokoroTTS.af_heart"; Groq and browser voice ids never contain a dot. */
    static isVoiceId(id) {
        return /^[A-Za-z][\w-]*\.\S/.test(String(id || "").trim());
    }

    /**
     * Streaming speech-to-text models on the account. `languages` is null when Telnyx doesn't say;
     * `hosted` is Telnyx's flag for models it runs itself (null when not sent).
     * @returns {Promise<{ provider: string, model: string, languages: string[]|null, hosted: boolean|null }[]>}
     */
    static async listStreamingSttModels(key) {
        const payload = await TelnyxVoice._getJson(
            "Telnyx speech-to-text model list",
            "/speech-to-text/providers?service_type=streaming",
            key
        );
        const streaming = (types) =>
            Array.isArray(types) ? types.find((t) => (typeof t === "string" ? t : t?.type) === "streaming") : {};
        const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
        const models = [];
        for (const entry of list) {
            const provider = String(entry?.provider || entry?.name || "").trim();
            const nested = Array.isArray(entry?.models) ? entry.models : [entry];
            for (const m of nested) {
                const model = String((typeof m === "string" ? m : m?.model || m?.id) || "").trim();
                const stream = streaming(m?.service_types ?? entry?.service_types);
                if (!provider || !model || !stream) continue;
                const languages = Array.isArray(stream.languages) ? stream.languages.map((l) => String(l)) : null;
                const hosted = m?.hosted ?? entry?.hosted;
                models.push({ provider, model, languages, hosted: typeof hosted === "boolean" ? hosted : null });
            }
        }
        if (!models.length) {
            throw new Error(`Telnyx listed no streaming speech-to-text models this page could read: ${JSON.stringify(payload).slice(0, 300)}`);
        }
        return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    }

    /**
     * Streaming speech-to-text models in the order to try them: the tested ones (`preferred`, as
     * "provider|model") the account still has; then the rest, models that hear the player's language
     * first (listing it or "auto"), then ones Telnyx runs itself (`hosted`), then general models before
     * specialised ones (one or two languages, e.g. medical English), then other models from the tested
     * providers. Within a provider the highest version number comes first, and a base model before its
     * variants, so a retired model is replaced by its successor.
     * @param {{ provider: string, model: string, languages?: string[]|null, hosted?: boolean|null }[]} list
     * @param {string[]} [preferred]
     * @param {{ language?: string }} [options] BCP 47 tag, default the browser's language
     * @returns {{ provider: string, model: string, value: string, tested: boolean, language: boolean|null, hosted: boolean|null }[]}
     */
    static rankSttModels(list, preferred = [], { language = globalThis.navigator?.language || "en" } = {}) {
        const value = (m) => `${m.provider}|${m.model}`;
        const tested = (Array.isArray(preferred) ? preferred : []).map((v) => String(v || "").trim()).filter(Boolean);
        const testedProviders = [...new Set(tested.map((v) => v.split("|")[0].toLowerCase()))];
        const version = (model) => Math.max(-1, ...(String(model).match(/\d+(?:\.\d+)?/g) || []).map(Number));
        const wanted = String(language).toLowerCase().replace(/_/g, "-");
        const base = wanted.split("-")[0];
        /** true, false, or null when Telnyx lists no languages. */
        const hears = (languages) =>
            Array.isArray(languages)
                ? languages.some((l) => {
                      const tag = String(l).toLowerCase().replace(/_/g, "-");
                      return tag === "auto" || tag === "multi" || tag === wanted || tag === base || tag.startsWith(`${base}-`);
                  })
                : null;
        const order = (flag) => (flag === true ? 0 : flag === null ? 1 : 2);
        const specialised = (languages) =>
            Array.isArray(languages) && languages.length <= 2 && !languages.some((l) => /^(auto|multi)$/i.test(String(l)));
        const testedAt = (m) => {
            const at = tested.indexOf(m.value);
            return at >= 0 ? at : tested.length;
        };
        const providerRank = (m) => {
            const at = testedProviders.indexOf(m.provider.toLowerCase());
            return at >= 0 ? at : testedProviders.length;
        };
        return (Array.isArray(list) ? list : [])
            .map((m) => ({
                provider: m.provider,
                model: m.model,
                value: value(m),
                tested: tested.includes(value(m)),
                language: hears(m.languages),
                hosted: typeof m.hosted === "boolean" ? m.hosted : null,
                specialised: specialised(m.languages)
            }))
            .sort(
                (a, b) =>
                    testedAt(a) - testedAt(b) ||
                    order(a.language) - order(b.language) ||
                    order(a.hosted) - order(b.hosted) ||
                    a.specialised - b.specialised ||
                    providerRank(a) - providerRank(b) ||
                    a.provider.localeCompare(b.provider) ||
                    version(b.model) - version(a.model) ||
                    a.model.length - b.model.length ||
                    a.model.localeCompare(b.model)
            );
    }

    /**
     * Console helper (`telnyxSttModels()`): the raw streaming speech-to-text provider list, to see
     * which details Telnyx sends for ranking. Store it, then copy: `s = await telnyxSttModels(); copy(s)`.
     * @returns {Promise<string>}
     */
    static async dumpSttModels(key = TelnyxVoice.keySource?.()) {
        if (!key) throw new Error("No Telnyx key: select the Telnyx agent and enter your key first.");
        const payload = await TelnyxVoice._getJson(
            "Telnyx speech-to-text model list",
            "/speech-to-text/providers?service_type=streaming",
            key
        );
        console.log(payload);
        return JSON.stringify(payload);
    }

    /** Returns the player's Telnyx key; set by the agent panel so console helpers can use it. */
    static keySource = null;

    /**
     * Console helper (`telnyxModels()`): every model on the account with the details used to
     * choose a chat model. Prints a table and returns one line per model, ready to copy:
     * `copy(await telnyxModels())`.
     * @returns {Promise<string>}
     */
    static async dumpModels(key = TelnyxVoice.keySource?.()) {
        if (!key) throw new Error("No Telnyx key: select the Telnyx agent and enter your key first.");
        const payload = await TelnyxVoice._getJson("Telnyx model list", "/ai/openai/models", key);
        const list = Array.isArray(payload?.data) ? payload.data : [];
        const rows = list
            .map((m) => ({
                id: m.id,
                task: m.task,
                size: m.parameters_str || m.parameters,
                tier: m.tier,
                in: m.pricing?.input ?? m.pricing?.prompt,
                out: m.pricing?.output ?? m.pricing?.completion,
                cur: m.pricing?.currency,
                ctx: m.context_length,
                maxOut: m.max_completion_tokens,
                owner: m.owned_by,
                assistants: m.recommended_for_assistants,
                vision: m.is_vision_supported,
                created: m.created,
                service: m.service_tiers
            }))
            .sort((a, b) => String(a.task).localeCompare(String(b.task)) || String(a.id).localeCompare(String(b.id)));
        console.table(rows);
        const fields = [...new Set(list.flatMap((m) => Object.keys(m || {})))];
        return [`${rows.length} models; fields sent: ${fields.join(", ")}`, ...rows.map((r) => JSON.stringify(r))].join("\n");
    }

    /**
     * Chat models Telnyx bills for, best first (see rankChatModels).
     * @returns {Promise<ReturnType<typeof TelnyxVoice.rankChatModels>>}
     */
    static async listChatModels(key) {
        let payload;
        try {
            payload = await TelnyxVoice._getJson("Telnyx chat model list", "/ai/openai/models", key);
        } catch (error) {
            console.error("Telnyx /ai/openai/models failed; trying /ai/models.", error);
            payload = await TelnyxVoice._getJson("Telnyx chat model list", "/ai/models", key);
        }
        const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
        return TelnyxVoice.rankChatModels(list);
    }

    /** "25.8B", "1.0T", "70600000000" -> parameters, or 0 when unknown. */
    static _parameterCount(raw) {
        const n = Number(raw?.parameters);
        if (n > 0) return n;
        const match = /^\s*([\d.]+)\s*([KMBT])?\s*$/i.exec(String(raw?.parameters_str || ""));
        if (!match) return 0;
        return Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[String(match[2] || "").toLowerCase()] || 1);
    }

    /**
     * Orders chat models from the account's own model list using only what each model says about
     * itself, so it keeps working as models are added and retired:
     *   - only chat models Telnyx prices: an unpriced one needs the upstream provider's own key (e.g. Groq);
     *   - picked automatically if it runs on the default service tier, has room for a game's prompt and
     *     is big enough (or Telnyx recommends it for assistants);
     *   - then listed models before "unlisted" (preview) ones, then the cheapest per game turn.
     * Models that miss the bar stay in the list (after the automatic ones) with the reason, for picking by hand.
     * @returns {{ id: string, auto: boolean, reason: string, costPerTurn: number, currency: string,
     *   size: number, sizeLabel: string, tier: string, hosted: boolean, thinkingOff: boolean }[]}
     */
    static rankChatModels(list) {
        const T = TelnyxVoice;
        const raws = (Array.isArray(list) ? list : []).map((m) => (typeof m === "string" ? { id: m } : m || {}));
        const priceOf = (raw) => ({
            input: Number(raw.pricing?.input ?? raw.pricing?.prompt),
            output: Number(raw.pricing?.output ?? raw.pricing?.completion)
        });
        const priced = (raw) => {
            const { input, output } = priceOf(raw);
            return input > 0 && output > 0;
        };
        // If Telnyx ever stops sending prices at all, don't throw every model away.
        const needPrice = raws.some(priced);
        const models = [];
        for (const raw of raws) {
            const id = String(raw.id || raw.name || "").trim();
            if (!id) continue;
            const task = String(raw.task || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
            if (task ? !T.CHAT_TASKS.includes(task) : T.NOT_CHAT_MODEL.test(id)) continue;
            if (needPrice && !priced(raw)) continue;
            const { input, output } = priceOf(raw);
            const size = T._parameterCount(raw);
            const context = Number(raw.context_length) || 0;
            const service = Array.isArray(raw.service_tiers) ? raw.service_tiers.map((s) => String(s).toLowerCase()) : null;
            const recommended = raw.recommended_for_assistants === true;
            const hosted = String(raw.owned_by || "").toLowerCase() === "telnyx";
            const sizeLabel = size ? String(raw.parameters_str || "").trim() || `${(size / 1e9).toFixed(1)}B` : "";
            let reason = "";
            if (service && !service.includes("default")) reason = `${service.join("/")} service tier only`;
            else if (context && context < T.MIN_CHAT_CONTEXT) reason = `only ${context} tokens of context`;
            else if (!recommended && !(size >= T.MIN_CHAT_PARAMETERS)) reason = size ? `${sizeLabel} may be too small` : "size unknown";
            models.push({
                id,
                auto: !reason,
                reason,
                costPerTurn: input > 0 && output > 0 ? (input * T.TURN_INPUT_TOKENS + output * T.TURN_OUTPUT_TOKENS) / 1e6 : Infinity,
                currency: String(raw.pricing?.currency || "USD"),
                size,
                sizeLabel,
                tier: String(raw.tier || "").toLowerCase(),
                hosted,
                // Proxied models (OpenAI, Google...) may reject the open-model switch that turns thinking off.
                thinkingOff: hosted && !T.REJECTS_TEMPLATE_KWARGS.test(id)
            });
        }
        const preview = (m) => (m.tier === "unlisted" ? 1 : 0);
        return models.sort(
            (a, b) =>
                Number(b.auto) - Number(a.auto) ||
                preview(a) - preview(b) ||
                a.costPerTurn - b.costPerTurn ||
                a.id.localeCompare(b.id)
        );
    }

    /**
     * Voices that can stream, from every voice provider the account can reach. Ultra voices are
     * left out: the streaming voice socket refuses them.
     * @returns {Promise<{ voices: { id: string, name: string, provider: string, language: string, gender: string }[], skippedUltra: number }>}
     */
    static async listVoices(key) {
        const [designed, ...results] = await Promise.allSettled([
            TelnyxVoice.listDesignedVoices(key),
            ...TelnyxVoice.VOICE_PROVIDERS.map((provider) =>
                TelnyxVoice._getJson(`Telnyx ${provider} voice list`, `/text-to-speech/voices?provider=${provider}`, key)
            )
        ]);
        if (designed.status === "rejected") console.warn("Telnyx designed voices unavailable:", designed.reason);
        const voices = designed.status === "fulfilled" ? [...designed.value] : [];
        const seen = new Set(voices.map((v) => v.id));
        let skippedUltra = 0;
        const errors = [];
        results.forEach((result, i) => {
            const provider = TelnyxVoice.VOICE_PROVIDERS[i];
            if (result.status === "rejected") {
                console.warn(`Telnyx ${provider} voices unavailable:`, result.reason);
                errors.push(result.reason);
                return;
            }
            for (const v of TelnyxVoice._voiceEntries(result.value)) {
                const id = String((typeof v === "string" ? v : v?.voice_id || v?.voice || v?.id || v?.name) || "");
                if (!id || seen.has(id)) continue;
                if (/\.Ultra\./i.test(id)) {
                    skippedUltra += 1;
                    continue;
                }
                seen.add(id);
                voices.push({
                    id,
                    name: String(v?.name || id),
                    provider,
                    language: String(v?.language || v?.language_code || ""),
                    gender: String(v?.gender || ""),
                    // Not in Telnyx's current docs, but some voice lists have sent them.
                    accent: String(v?.accent || ""),
                    age: String(v?.age || "")
                });
            }
        });
        if (errors.length === results.length) throw errors[0];
        return { voices, skippedUltra };
    }

    /** "male", "female" or "" from whatever a voice list says ("Male", "F", "woman"...). */
    static normalGender(gender) {
        const g = String(gender || "").trim().toLowerCase();
        return g.startsWith("f") || g.startsWith("w") ? "female" : g.startsWith("m") ? "male" : "";
    }

    /**
     * Stand-in voices, most reliable first, from the live voice list: the right gender (any gender if
     * none match) speaking the player's language, then voices tested in robots.js or that worked this
     * session, then the player's exact accent, then Telnyx's own voices (no third-party provider in
     * between), then the rest. Designed voices are left out: they belong to one character.
     * @param {{ id: string, provider: string, language: string, gender: string, name: string }[]} voices
     * @param {{ gender?: string, language?: string, tested?: string[] }} [options] language like "en-AU"
     * @returns {typeof voices}
     */
    static rankVoices(voices, options = {}) {
        const gender = TelnyxVoice.normalGender(options.gender);
        const tested = Array.isArray(options.tested) ? options.tested : [];
        const wanted = String(options.language || "").toLowerCase().replace("_", "-");
        const base = wanted.split("-")[0];
        const languageOf = (v) => {
            const l = String(v.language || "").toLowerCase().replace("_", "-");
            return /english/.test(l) ? "en" : l;
        };
        const languageRank = (v) => {
            const l = languageOf(v);
            return !wanted || l.split("-")[0] === base ? 0 : !l ? 1 : 2;
        };
        const accentRank = (v) => (languageOf(v) === wanted ? 0 : 1);
        const testedRank = (v) => {
            const at = tested.indexOf(v.id);
            return at >= 0 ? at : tested.length;
        };
        const pool = (Array.isArray(voices) ? voices : []).filter((v) => v?.id && v.provider !== "designed");
        const matching = gender ? pool.filter((v) => TelnyxVoice.normalGender(v.gender) === gender) : pool;
        return (matching.length ? matching : pool).slice().sort(
            (a, b) =>
                languageRank(a) - languageRank(b) ||
                testedRank(a) - testedRank(b) ||
                accentRank(a) - accentRank(b) ||
                Number(b.provider === "telnyx") - Number(a.provider === "telnyx") ||
                String(a.provider).localeCompare(String(b.provider)) ||
                String(a.name).localeCompare(String(b.name))
        );
    }

    /**
     * Voices saved from Voice Design (voice clones) on the account.
     * @returns {Promise<{ id: string, name: string, provider: string, language: string, gender: string }[]>}
     */
    static async listDesignedVoices(key) {
        const payload = await TelnyxVoice._getJson("Telnyx saved voice list", "/voice_clones", key);
        const list = Array.isArray(payload?.data) ? payload.data : [];
        return list
            .filter((c) => c && (c.provider_voice_id || c.id))
            .map((c) => ({
                id: TelnyxVoice._cloneVoiceId(c),
                name: String(c.name || c.id),
                provider: "designed",
                language: String(c.language || ""),
                gender: String(c.gender || "")
            }));
    }

    /** Speech voice id of a saved clone: "<Telnyx|Minimax>.<model>.<voice>". */
    static _cloneVoiceId(clone, provider = clone?.provider) {
        const minimax = String(provider || "").toLowerCase() === "minimax";
        const model =
            clone?.model_id || clone?.provider_supported_models?.[0] || (minimax ? "speech-2.8-turbo" : "Qwen3TTS");
        return `${minimax ? "Minimax" : "Telnyx"}.${model}.${clone?.provider_voice_id || clone?.id}`;
    }

    /**
     * Voice Design step 1: a typed description becomes a draft voice reading `text`. Passing the
     * current design's id adds a new version to it instead of starting another design.
     * @param {{ prompt: string, text: string, provider?: string, voiceDesignId?: string|null, name?: string }} options
     * @returns {Promise<{ id: string, version: number, provider: string, sample: Blob }>}
     */
    static async designVoice(key, options) {
        const prompt = String(options.prompt || "").trim().slice(0, 2000);
        const text = String(options.text || "").trim().slice(0, 500);
        if (!prompt) throw new Error("Describe the voice first.");
        if (!text) throw new Error("Type a sentence for the voice to read.");
        const provider = options.provider === "minimax" ? "minimax" : "telnyx";
        const design = { prompt, text, language: "English", provider };
        if (options.voiceDesignId) design.voice_design_id = String(options.voiceDesignId);
        else design.name = `${String(options.name || "phonebot voice").trim()} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const data = (await TelnyxVoice._postJson("Telnyx voice design", "/voice_designs", key, design))?.data || {};
        if (!data.id) throw new Error("Telnyx voice design returned no design id.");
        const response = await TelnyxVoice.fetch(
            `/voice_designs/${encodeURIComponent(data.id)}/sample?version=${encodeURIComponent(data.version)}`,
            {},
            key
        );
        if (!response.ok) throw await TelnyxVoice._errorFrom("Telnyx voice design sample", response);
        const sample = await response.blob();
        return {
            id: String(data.id),
            version: Number(data.version) || 1,
            provider,
            sample: sample.type ? sample : new Blob([sample], { type: "audio/wav" })
        };
    }

    /**
     * Voice Design step 2: saves one version as a voice on the account. Its id works for plain and
     * streamed speech.
     * @param {{ voiceDesignId: string, version?: number, provider?: string, gender?: string, name?: string }} options
     * @returns {Promise<{ id: string, name: string, provider: string, language: string, gender: string }>}
     */
    static async saveDesignedVoice(key, options) {
        if (!options.voiceDesignId) throw new Error("Generate a sample first.");
        const provider = options.provider === "minimax" ? "minimax" : "telnyx";
        const gender = ["male", "female", "neutral"].includes(options.gender) ? options.gender : "neutral";
        const clone = {
            name: String(options.name || "").trim().slice(0, 255) || `phonebot voice ${new Date().toISOString().slice(0, 16)}`,
            voice_design_id: String(options.voiceDesignId),
            language: "en",
            gender,
            provider
        };
        if (options.version) clone.version = Number(options.version);
        const data = (await TelnyxVoice._postJson("Telnyx voice save", "/voice_clones", key, clone))?.data || {};
        return {
            id: TelnyxVoice._cloneVoiceId(data, provider),
            name: String(data.name || clone.name),
            provider: "designed",
            language: "en",
            gender
        };
    }

    /** Telnyx documents `{ voices: [...] }`; also accept `data` wrappers and per-provider groupings. */
    static _voiceEntries(payload) {
        const list = payload?.voices ?? payload?.data ?? payload;
        if (Array.isArray(list)) return list;
        if (list && typeof list === "object") {
            return Object.values(list).flatMap((value) => (Array.isArray(value) ? value : []));
        }
        return [];
    }

    /**
     * Plain (REST) speech as one MP3 Blob. Retries once on Telnyx's generic synthesis failure.
     * @returns {Promise<Blob>}
     */
    static async synthesizeSpeech(key, text, voice) {
        const input = String(text || "").trim();
        if (!input) throw new Error("Nothing to speak.");
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await TelnyxVoice.fetch(
                "/text-to-speech/speech",
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: input, voice }) },
                key
            );
            if (response.ok) {
                const blob = await response.blob();
                if (blob.size < 44) throw new Error("Telnyx speech returned empty audio.");
                return blob.type ? blob : new Blob([blob], { type: "audio/mpeg" });
            }
            lastError = await TelnyxVoice._errorFrom(`Telnyx speech (${voice})`, response);
            if (response.status < 500 && !/90103/.test(lastError.message)) break;
        }
        throw lastError;
    }

    /** WebSocket URL of the Worker's stream route, next to the billing API unless overridden. */
    static streamUrl() {
        let override = "";
        try {
            override = String(localStorage.getItem(TelnyxVoice.STORAGE_STREAM_URL) || "").trim();
        } catch (_) {}
        const configured =
            override ||
            window.PHONEBOT_TELNYX_STREAM_URL ||
            document.querySelector('meta[name="phonebot-telnyx-stream"]')?.content ||
            "";
        if (configured) return String(configured);
        const api =
            window.playBilling?.apiBaseUrl ||
            document.querySelector('meta[name="phonebot-billing-api"]')?.content ||
            "/api";
        const url = new URL(`${String(api).replace(/\/+$/, "")}/telnyx/stream`, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.href;
    }
}

/**
 * One streamed hold-to-talk turn: microphone → 16 kHz PCM → Worker socket while the player talks,
 * then transcript, reply text and MP3 reply audio back. Both Telnyx sockets open as soon as the
 * player starts talking, so connecting is hidden while they speak.
 * A text turn (`input: "text"`, opened with `openText()`) has no microphone: the voice connects
 * while the prompt is built, then `release` sends it and the reply streams back the same way.
 */
class TelnyxStreamTurn {
    static INPUT_RATE = 16000;
    static FRAME_BYTES = 3200;
    static _context = null;
    static _workletReady = null;

    /**
     * `key` is the player's Telnyx key, or "" with `session` (a play session id) to use the Worker's
     * key on AI credit.
     * @param {{ key: string, session?: string, input?: "audio"|"text", stt?: { provider: string, model: string }[], voice: string[],
     *   speak: boolean, onPartial?: (text: string) => void, onError?: (err: Error) => void }} options
     */
    constructor(options) {
        this._options = options;
        this._handlers = { onPartial: options.onPartial };
        this._ws = null;
        this._outbox = [];
        this._buffered = [];
        this._bufferedBytes = 0;
        this._samples = 0;
        this._capturing = false;
        this._settled = false;
        this._reply = "";
        this._opening = null;
        this._result = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
        this._result.catch(() => {});
    }

    /** Seconds of speech sent so far. */
    get seconds() {
        return this._samples / TelnyxStreamTurn.INPUT_RATE;
    }

    /** Created on the first turn, inside the press gesture, and reused after. */
    static async _captureContext() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error("This browser has no Web Audio for microphone streaming.");
        if (!TelnyxStreamTurn._context) {
            TelnyxStreamTurn._context = new Ctx();
            TelnyxStreamTurn._workletReady = TelnyxStreamTurn._context.audioWorklet.addModule(
                new URL("pcmCapture.js", document.baseURI).href
            );
        }
        const ctx = TelnyxStreamTurn._context;
        if (ctx.state !== "running") await ctx.resume();
        await TelnyxStreamTurn._workletReady;
        return ctx;
    }

    /** Opens the Worker socket and the microphone. */
    open() {
        this._opening = this._open().catch((err) => {
            this._fail(err);
            throw err;
        });
        return this._opening;
    }

    /** Opens only the Worker socket, for a text turn. */
    openText() {
        this._openSocket();
        this._opening = Promise.resolve();
        return this._opening;
    }

    async _open() {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is not available.");
        this._openSocket();
        const ctx = await TelnyxStreamTurn._captureContext();
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false
        });
        this._micStream = stream;
        if (this._settled) {
            this._stopCapture();
            return;
        }
        this._resampler = TelnyxStreamTurn._createResampler(ctx.sampleRate, TelnyxStreamTurn.INPUT_RATE);
        this._source = ctx.createMediaStreamSource(stream);
        this._node = new AudioWorkletNode(ctx, "pcm-capture");
        this._node.port.onmessage = (event) => this._onCaptured(event.data);
        this._source.connect(this._node);
        this._node.connect(ctx.destination);
        this._capturing = true;
    }

    _openSocket() {
        const { key, session, input, stt, voice, speak } = this._options;
        const url = new URL(TelnyxVoice.streamUrl());
        if (session) url.searchParams.set("session", session);
        const ws = new WebSocket(url);
        this._ws = ws;
        const start = { type: "start", key, voice: voice[0] || "", voiceOptions: voice, speak };
        if (input === "text") start.input = "text";
        else Object.assign(start, { stt: stt[0], sttOptions: stt });
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify(start));
            for (const data of this._outbox.splice(0)) ws.send(data);
        });
        ws.addEventListener("message", (event) => this._onMessage(event));
        let opened = false;
        ws.addEventListener("open", () => {
            opened = true;
        });
        ws.addEventListener("close", (event) => {
            const reason = event.reason ? ` ${event.reason}` : "";
            this._fail(
                new Error(
                    opened
                        ? `The Telnyx stream at ${url.origin}${url.pathname} closed before the reply finished (code ${event.code}${reason}).`
                        : `Could not connect to the Telnyx stream at ${url.origin}${url.pathname} (code ${event.code}${reason}). ` +
                          `Check the Worker has the /api/telnyx/stream route and that ALLOWED_ORIGINS includes ${window.location.origin}.`
                )
            );
        });
    }

    _sendRaw(data) {
        const ws = this._ws;
        if (!ws) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
        else if (ws.readyState === WebSocket.CONNECTING) this._outbox.push(data);
    }

    _onCaptured(data) {
        const flushed = data instanceof Float32Array ? null : data?.flushed;
        if (this._resampler && (this._capturing || flushed)) {
            const pcm = this._resampler.push(flushed || data);
            if (pcm.length) {
                this._buffered.push(pcm);
                this._bufferedBytes += pcm.byteLength;
                this._samples += pcm.length;
                if (this._bufferedBytes >= TelnyxStreamTurn.FRAME_BYTES) this._sendFrames();
            }
        }
        if (flushed && this._flushWaiter) this._flushWaiter();
    }

    _sendFrames() {
        if (!this._bufferedBytes) return;
        const out = new Int16Array(this._bufferedBytes / 2);
        let offset = 0;
        for (const chunk of this._buffered) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        this._buffered = [];
        this._bufferedBytes = 0;
        this._sendRaw(out.buffer);
    }

    _stopCapture() {
        this._capturing = false;
        try {
            this._source?.disconnect();
            this._node?.disconnect();
        } catch (_) {}
        if (this._node) this._node.port.onmessage = null;
        for (const track of this._micStream?.getTracks?.() || []) {
            try {
                track.stop();
            } catch (_) {}
        }
        this._source = null;
        this._node = null;
        this._micStream = null;
    }

    /**
     * The player let go: send the last audio and the chat request, then wait for the turn to end.
     * @param {{ chat: object, transcriptMarker: string }} stop
     * @param {{ onTranscript?: (text: string) => void, onReply?: (text: string) => void, onAudio?: (bytes: Uint8Array) => void }} handlers
     * @returns {Promise<object|null>} the Worker's done message, or null when cancelled
     */
    async release(stop, handlers = {}) {
        Object.assign(this._handlers, handlers);
        try {
            await this._opening;
        } catch (_) {
            return this._result;
        }
        if (this._settled) return this._result;
        if (this._node) {
            await new Promise((resolve) => {
                this._flushWaiter = resolve;
                this._node.port.postMessage("flush");
                setTimeout(resolve, 200);
            });
            this._flushWaiter = null;
        }
        this._stopCapture();
        this._sendFrames();
        this._sendRaw(JSON.stringify({ type: "stop", ...stop }));
        return this._result;
    }

    cancel() {
        if (this._settled) return;
        this._settled = true;
        this._stopCapture();
        try {
            this._ws?.close(1000, "cancelled");
        } catch (_) {}
        this._resolve(null);
    }

    _call(name, ...args) {
        try {
            this._handlers[name]?.(...args);
        } catch (err) {
            console.error(`Telnyx stream ${name} handler failed:`, err);
        }
    }

    _onMessage(event) {
        if (this._settled) return;
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (_) {
            return;
        }
        if (message.type === "partial") this._call("onPartial", String(message.text || ""));
        else if (message.type === "transcript") this._call("onTranscript", String(message.text || ""));
        else if (message.type === "reply") {
            this._reply = String(message.text || "");
            this._call("onReply", this._reply);
        } else if (message.type === "audio" && message.audio) {
            this._call("onAudio", TelnyxStreamTurn._base64ToBytes(message.audio));
        } else if (message.type === "done") {
            this._settled = true;
            this._stopCapture();
            this._resolve(message);
        } else if (message.type === "error") {
            const err = new Error(TelnyxVoice._withKeyHint(message.message || "Telnyx stream failed."));
            err.reply = message.reply || this._reply;
            err.failedModels = Array.isArray(message.failedModels) ? message.failedModels : [];
            err.failedStt = Array.isArray(message.failedStt) ? message.failedStt : [];
            err.failedVoices = Array.isArray(message.failedVoices) ? message.failedVoices : [];
            err.status = Number(message.status) || 0;
            err.session = message.session || null;
            err.chargeCents = Number(message.chargeCents) || 0;
            this._fail(err);
        }
    }

    _fail(error) {
        if (this._settled) return;
        this._settled = true;
        if (!error.reply && this._reply) error.reply = this._reply;
        error.logged = true;
        console.error("Telnyx stream turn failed:", error);
        this._stopCapture();
        try {
            this._ws?.close();
        } catch (_) {}
        try {
            this._options.onError?.(error);
        } catch (_) {}
        this._reject(error);
    }

    static _base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    /** Box-filter downsampler from the device rate to 16 kHz 16-bit PCM, carrying leftovers between batches. */
    static _createResampler(fromRate, toRate) {
        const step = fromRate / toRate;
        let carry = new Float32Array(0);
        let position = 0;
        return {
            push(samples) {
                const input = new Float32Array(carry.length + samples.length);
                input.set(carry);
                input.set(samples, carry.length);
                const out = [];
                while (position + step <= input.length) {
                    const start = Math.floor(position);
                    const end = Math.max(start + 1, Math.floor(position + step));
                    let sum = 0;
                    for (let i = start; i < end; i++) sum += input[i];
                    out.push(sum / (end - start));
                    position += step;
                }
                const consumed = Math.min(input.length, Math.floor(position));
                carry = input.slice(consumed);
                position -= consumed;
                const pcm = new Int16Array(out.length);
                for (let i = 0; i < out.length; i++) {
                    const s = Math.max(-1, Math.min(1, out[i]));
                    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                return pcm;
            }
        };
    }
}

window.TelnyxVoice = TelnyxVoice;
window.TelnyxStreamTurn = TelnyxStreamTurn;
window.telnyxModels = (key) => TelnyxVoice.dumpModels(key);
window.telnyxSttModels = (key) => TelnyxVoice.dumpSttModels(key);
