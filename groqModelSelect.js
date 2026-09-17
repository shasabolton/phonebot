/**
 * Select Groq chat / vision / STT / TTS models from GET /openai/v1/models.
 * Browser: window.GroqModelSelect (classic or module load).
 * Worker: import { … } from "../../groqModelSelect.js"
 */

const DENY_NAME_RE = /compound|safeguard|prompt-guard|\bguard\b/i;
const MIN_CHAT_CONTEXT = 8192;

function asList(models) {
    if (Array.isArray(models)) return models;
    if (models && Array.isArray(models.data)) return models.data;
    return [];
}

function modalities(model, key) {
    const list = model?.[key];
    return Array.isArray(list) ? list.map((m) => String(m).toLowerCase()) : [];
}

function hasModality(model, key, value) {
    return modalities(model, key).includes(String(value).toLowerCase());
}

function isActive(model) {
    return model && model.active !== false;
}

function isDeniedName(model) {
    const id = String(model?.id || "");
    const name = String(model?.name || "");
    return DENY_NAME_RE.test(`${id} ${name}`);
}

function contextTokens(model) {
    const n = Number(model?.context_window ?? model?.context_length);
    return Number.isFinite(n) ? n : 0;
}

function hasChatPricing(model) {
    const p = model?.pricing;
    if (!p || typeof p !== "object") return false;
    const prompt = Number(p.prompt);
    const completion = Number(p.completion);
    return (Number.isFinite(prompt) && prompt > 0) || (Number.isFinite(completion) && completion > 0);
}

/** Lower is cheaper. Weights output higher (talking-head replies). */
function chatPriceScore(model) {
    const p = model?.pricing || {};
    const prompt = Number(p.prompt) || 0;
    const completion = Number(p.completion) || 0;
    if (prompt <= 0 && completion <= 0) return Number.POSITIVE_INFINITY;
    return prompt + 3 * completion;
}

function isOpenAiChat(model) {
    const owner = String(model?.owned_by || "").toLowerCase();
    const id = String(model?.id || "").toLowerCase();
    return owner === "openai" || id.startsWith("openai/");
}

function pickCheapest(candidates) {
    if (!candidates.length) return null;
    return [...candidates].sort((a, b) => {
        const d = chatPriceScore(a) - chatPriceScore(b);
        if (d !== 0) return d;
        return String(a.id).localeCompare(String(b.id));
    })[0];
}

function filterTextChat(models) {
    return asList(models).filter(
        (m) =>
            isActive(m) &&
            hasModality(m, "input_modalities", "text") &&
            hasModality(m, "output_modalities", "text") &&
            !hasModality(m, "input_modalities", "image") &&
            !hasModality(m, "input_modalities", "audio") &&
            !hasModality(m, "output_modalities", "speech") &&
            !hasModality(m, "output_modalities", "transcription") &&
            !isDeniedName(m) &&
            hasChatPricing(m) &&
            contextTokens(m) >= MIN_CHAT_CONTEXT
    );
}

function filterVisionChat(models) {
    return asList(models).filter(
        (m) =>
            isActive(m) &&
            hasModality(m, "input_modalities", "text") &&
            hasModality(m, "input_modalities", "image") &&
            hasModality(m, "output_modalities", "text") &&
            !isDeniedName(m) &&
            hasChatPricing(m) &&
            contextTokens(m) >= MIN_CHAT_CONTEXT
    );
}

function filterStt(models) {
    return asList(models).filter(
        (m) =>
            isActive(m) &&
            hasModality(m, "input_modalities", "audio") &&
            hasModality(m, "output_modalities", "transcription")
    );
}

function filterTts(models) {
    return asList(models).filter(
        (m) =>
            isActive(m) &&
            hasModality(m, "input_modalities", "text") &&
            hasModality(m, "output_modalities", "speech") &&
            !isDeniedName(m)
    );
}

function pickStt(models) {
    const list = filterStt(models);
    if (!list.length) return null;
    const prefer = ["whisper-large-v3", "whisper-large-v3-turbo"];
    for (const id of prefer) {
        const hit = list.find((m) => m.id === id);
        if (hit) return hit;
    }
    return list[0];
}

function pickTts(models) {
    const list = filterTts(models);
    if (!list.length) return null;
    const english = list.find((m) => String(m.id).includes("orpheus-v1-english"));
    if (english) return english;
    const withPrice = list.filter((m) => m.pricing && Number(m.pricing.prompt) > 0);
    return pickCheapest(withPrice) || list[0];
}

function pickChat(models) {
    const candidates = filterTextChat(models);
    const openAi = candidates.filter(isOpenAiChat);
    return pickCheapest(openAi) || pickCheapest(candidates);
}

function pickVision(models) {
    return pickCheapest(filterVisionChat(models));
}

/**
 * Convert Groq API per-token USD prices into Worker-style AUD cents per million tokens.
 * @param {object} model
 * @param {number} [audPerUsd]
 */
function ratesFromModel(model, audPerUsd = 1.5) {
    const p = model?.pricing || {};
    const fx = Number.isFinite(audPerUsd) && audPerUsd > 0 ? audPerUsd : 1.5;
    const prompt = Number(p.prompt) || 0;
    const completion = Number(p.completion) || 0;
    const cache = Number(p.input_cache_read) || 0;
    return {
        inputCentsPerMillion: prompt * 1_000_000 * 100 * fx,
        outputCentsPerMillion: completion * 1_000_000 * 100 * fx,
        cacheReadCentsPerMillion: cache * 1_000_000 * 100 * fx
    };
}

/**
 * Cross-model reasoning_effort for GPT-OSS and Qwen 3.8+.
 * Both accept low|medium|high. GPT-OSS rejects none/default.
 * @param {string} [value]
 * @returns {"low"|"medium"|"high"}
 */
function normalizeReasoningEffort(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "medium" || raw === "high") return raw;
    return "low";
}

/**
 * Ensure a chat-completions body uses a cross-model-safe reasoning_effort.
 * @param {object} body
 * @returns {object}
 */
function applyCrossModelChatDefaults(body) {
    if (!body || typeof body !== "object") return body;
    const effort = body.reasoning_effort ?? body.reasoningEffort;
    body.reasoning_effort = normalizeReasoningEffort(effort);
    delete body.reasoningEffort;
    return body;
}

/**
 * @param {object[]|{ data: object[] }} models
 * @param {{ audPerUsd?: number }} [options]
 * @returns {{
 *   chat: string|null,
 *   vision: string|null,
 *   stt: string|null,
 *   tts: string|null,
 *   rates: Record<string, { inputCentsPerMillion: number, outputCentsPerMillion: number }>,
 *   details: Record<string, object|null>
 * }}
 */
function selectGroqModels(models, options = {}) {
    const audPerUsd = Number(options.audPerUsd) || 1.5;
    const chatModel = pickChat(models);
    const visionModel = pickVision(models);
    const sttModel = pickStt(models);
    const ttsModel = pickTts(models);

    const rates = {};
    for (const m of [chatModel, visionModel]) {
        if (!m?.id) continue;
        rates[m.id] = ratesFromModel(m, audPerUsd);
    }

    return {
        chat: chatModel?.id || null,
        vision: visionModel?.id || null,
        stt: sttModel?.id || null,
        tts: ttsModel?.id || null,
        rates,
        details: {
            chat: chatModel || null,
            vision: visionModel || null,
            stt: sttModel || null,
            tts: ttsModel || null
        }
    };
}

/**
 * @param {string} apiKey
 * @param {{ audPerUsd?: number, fetchImpl?: typeof fetch }} [options]
 */
async function fetchAndSelectGroqModels(apiKey, options = {}) {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("Groq API key is required to list models.");
    const fetchImpl = options.fetchImpl || fetch;
    const res = await fetchImpl("https://api.groq.com/openai/v1/models", {
        method: "GET",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        }
    });
    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`Groq models HTTP ${res.status}: ${raw.slice(0, 300)}`);
    }
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (_) {
        throw new Error("Groq models response was not JSON.");
    }
    return selectGroqModels(payload, { audPerUsd: options.audPerUsd });
}

const api = {
    MIN_CHAT_CONTEXT,
    selectGroqModels,
    fetchAndSelectGroqModels,
    filterTextChat,
    filterVisionChat,
    filterStt,
    filterTts,
    chatPriceScore,
    ratesFromModel,
    normalizeReasoningEffort,
    applyCrossModelChatDefaults
};

if (typeof window !== "undefined") {
    window.GroqModelSelect = api;
}

export {
    MIN_CHAT_CONTEXT,
    selectGroqModels,
    fetchAndSelectGroqModels,
    filterTextChat,
    filterVisionChat,
    filterStt,
    filterTts,
    chatPriceScore,
    ratesFromModel,
    normalizeReasoningEffort,
    applyCrossModelChatDefaults
};
export default api;
