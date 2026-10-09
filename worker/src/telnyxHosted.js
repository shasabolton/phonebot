/**
 * Hosted Telnyx: the Worker's own key (secret TELNYX_API_KEY) on the player's AI credit.
 *
 * Prices, in US dollars before the arcade markup:
 *   chat            live from GET /ai/openai/models (`pricing.input` / `pricing.output` per 1M tokens);
 *                   models without a price need another provider's key and are refused
 *   speech-to-text  TELNYX_STT_USD_PER_MINUTE in wrangler.jsonc, by provider
 *   voice           TELNYX_TTS_USD_PER_MILLION_CHARS in wrangler.jsonc, by voice id prefix
 * Telnyx publishes no machine-readable speech prices, so those two tables copy
 * https://telnyx.com/pricing/speech-to-text and https://telnyx.com/pricing/text-to-speech.
 *
 * The REST proxy mirrors https://api.telnyx.com/v2 at /api/telnyx/v2/<path>?session=<play session>.
 */

const TELNYX_BASE = "https://api.telnyx.com/v2";
const CHAT_RATES_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS_CAP = 1024;
const MAX_SPEECH_CHARS = 4000;
const MAX_AUDIO_FILE_BYTES = 25_000_000;
/** Compressed recordings have no cheap duration; this bitrate (32 kbit/s) errs towards charging more. */
const COMPRESSED_BYTES_PER_SECOND = 4000;

/** Lists the page needs to pick models and voices; free, but still only for an active play session. */
const FREE_GETS = new Set(["/ai/openai/models", "/ai/models", "/speech-to-text/providers", "/text-to-speech/voices"]);

let chatRatesCache = { at: 0, rates: null, pending: null };

export class TelnyxPricing {
    constructor(env) {
        this.env = env;
        this.sttTable = lowerKeys(env.TELNYX_STT_USD_PER_MINUTE);
        this.ttsTable = lowerKeys(env.TELNYX_TTS_USD_PER_MILLION_CHARS);
    }

    /** @returns {Promise<Map<string, { input: number, output: number }>>} USD per 1M tokens, priced models only */
    async chatRates() {
        if (chatRatesCache.rates && Date.now() - chatRatesCache.at < CHAT_RATES_TTL_MS) return chatRatesCache.rates;
        chatRatesCache.pending ||= this.fetchChatRates().finally(() => {
            chatRatesCache.pending = null;
        });
        return chatRatesCache.pending;
    }

    async fetchChatRates() {
        const response = await fetch(`${TELNYX_BASE}/ai/openai/models`, {
            headers: { Authorization: `Bearer ${this.env.TELNYX_API_KEY}` }
        });
        if (!response.ok) throw httpError(503, `Telnyx model prices could not be loaded (${response.status}).`);
        const payload = await response.json();
        const rates = new Map();
        for (const m of Array.isArray(payload?.data) ? payload.data : []) {
            const input = Number(m?.pricing?.input ?? m?.pricing?.prompt);
            const output = Number(m?.pricing?.output ?? m?.pricing?.completion);
            if (!m?.id || !(Number.isFinite(input) && Number.isFinite(output)) || input + output <= 0) continue;
            rates.set(String(m.id), { input, output });
        }
        if (!rates.size) throw httpError(503, "Telnyx listed no priced chat models.");
        chatRatesCache = { at: Date.now(), rates, pending: null };
        return rates;
    }

    chatUsd(rate, usage) {
        const input = Math.max(0, Number(usage?.prompt_tokens) || 0);
        const output = Math.max(0, Number(usage?.completion_tokens) || 0);
        return (input * rate.input + output * rate.output) / 1_000_000;
    }

    /** @param {string} provider e.g. "deepgram"; file transcription is "telnyx" */
    sttUsd(provider, seconds) {
        return (lookup(this.sttTable, provider) * Math.max(0, seconds)) / 60;
    }

    /** @param {string} voice e.g. "Telnyx.KokoroTTS.am_adam" */
    ttsUsd(voice, chars) {
        return (lookup(this.ttsTable, voice) * Math.max(0, chars)) / 1_000_000;
    }
}

/**
 * Longest key that is the whole id or a prefix ending at a separator ("telnyx.natural" matches
 * "Telnyx.Natural.abbie" but not "Telnyx.NaturalHD.astra"); otherwise `default`.
 */
function lookup(table, id) {
    const key = String(id || "").toLowerCase();
    let best = "";
    for (const candidate of Object.keys(table)) {
        if (candidate === "default" || candidate.length <= best.length) continue;
        if (key === candidate || (key.startsWith(candidate) && /[./|_-]/.test(key[candidate.length]))) best = candidate;
    }
    const rate = Number(table[best || "default"]);
    if (!Number.isFinite(rate) || rate < 0) throw httpError(503, `No Telnyx price is configured for ${id || "this model"}.`);
    return rate;
}

function lowerKeys(table) {
    let parsed = table;
    if (typeof table === "string") {
        try {
            parsed = JSON.parse(table);
        } catch (_) {
            parsed = null;
        }
    }
    const out = {};
    for (const [key, value] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) out[key.toLowerCase()] = value;
    return out;
}

/** Rough token counts (4 characters per token) when Telnyx sends no usage. */
export function estimateTokens(messages, completionText) {
    const tokens = (text) => Math.ceil(String(text || "").length / 4);
    let prompt = 0;
    for (const m of messages || []) {
        if (typeof m?.content === "string") prompt += tokens(m.content);
        else if (Array.isArray(m?.content)) {
            for (const part of m.content) if (typeof part?.text === "string") prompt += tokens(part.text);
        }
    }
    return { prompt_tokens: prompt, completion_tokens: tokens(completionText), estimated: true };
}

/**
 * /api/telnyx/v2/<path> on the Worker's key. `billing` comes from index.js and holds the play
 * session's gate and debit.
 */
export async function proxyTelnyx(request, path, billing) {
    try {
        await billing.open();
    } catch (error) {
        if (error?.status === 402) return Response.json({ error: error.message, session: error.session }, { status: 402 });
        throw error;
    }
    const query = new URL(request.url).searchParams;
    query.delete("session");
    const search = query.toString();
    const auth = { Authorization: `Bearer ${billing.apiKey}` };

    if (request.method === "GET") {
        if (!FREE_GETS.has(path)) throw httpError(404, "That Telnyx request is not available on hosted credit.");
        return passThrough(await fetch(`${TELNYX_BASE}${path}${search ? `?${search}` : ""}`, { headers: auth }));
    }
    if (path === "/ai/openai/chat/completions") return proxyChat(request, billing, auth);
    if (path === "/text-to-speech/speech") return proxySpeech(request, billing, auth);
    if (path === "/ai/audio/transcriptions") return proxyTranscription(request, billing, auth);
    throw httpError(404, "That Telnyx request is not available on hosted credit.");
}

async function proxyChat(request, billing, auth) {
    const body = await readJson(request);
    const model = String(body.model || "").trim();
    const rate = (await billing.pricing.chatRates()).get(model);
    if (!rate) {
        return Response.json(
            { error: { message: `${model || "That model"} has no Telnyx price, so hosted credit can't pay for it.` } },
            { status: 400 }
        );
    }
    body.stream = false;
    delete body.stream_options;
    body.max_tokens = Math.min(MAX_TOKENS_CAP, Math.max(16, Math.round(Number(body.max_tokens) || 400)));
    const upstream = await fetch(`${TELNYX_BASE}/ai/openai/chat/completions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!upstream.ok) return passThrough(upstream);
    const payload = await upstream.json();
    const message = payload?.choices?.[0]?.message || {};
    const usage =
        payload?.usage?.prompt_tokens != null
            ? payload.usage
            : estimateTokens(body.messages, `${message.content || ""}${message.reasoning_content || message.reasoning || ""}`);
    const charge = billing.charge(billing.pricing.chatUsd(rate, usage));
    return Response.json(payload, { headers: { "X-Phonebot-AI-Charge-Cents": String(charge) } });
}

async function proxySpeech(request, billing, auth) {
    const body = await readJson(request);
    const text = String(body.text || "").trim();
    const voice = String(body.voice || "").trim();
    if (!text) throw httpError(400, "Nothing to speak.");
    if (text.length > MAX_SPEECH_CHARS) throw httpError(413, "Too much text for one speech request.");
    if (!voice) throw httpError(400, "Pick a Telnyx voice.");
    const usd = billing.pricing.ttsUsd(voice, text.length);
    const upstream = await fetch(`${TELNYX_BASE}/text-to-speech/speech`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, text, voice })
    });
    if (!upstream.ok) return passThrough(upstream);
    const charge = billing.charge(usd);
    return new Response(upstream.body, {
        headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "audio/mpeg",
            "X-Phonebot-AI-Charge-Cents": String(charge)
        }
    });
}

async function proxyTranscription(request, billing, auth) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size < 32) throw httpError(400, "Audio file is required.");
    if (file.size > MAX_AUDIO_FILE_BYTES) throw httpError(413, "Audio file too large.");
    const seconds = await audioSeconds(file);
    const upstream = await fetch(`${TELNYX_BASE}/ai/audio/transcriptions`, { method: "POST", headers: auth, body: form });
    if (!upstream.ok) return passThrough(upstream);
    const charge = billing.charge(billing.pricing.sttUsd("telnyx", seconds));
    return new Response(upstream.body, {
        headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "application/json",
            "X-Phonebot-AI-Charge-Cents": String(charge)
        }
    });
}

/** Exact for WAV; estimated from size for compressed recordings. */
async function audioSeconds(file) {
    const header = new DataView(await file.slice(0, 44).arrayBuffer());
    const text = (offset) => String.fromCharCode(...new Uint8Array(header.buffer, offset, 4));
    if (header.byteLength >= 44 && text(0) === "RIFF" && text(8) === "WAVE") {
        const byteRate = header.getUint32(28, true);
        if (byteRate > 0) return (file.size - 44) / byteRate;
    }
    return file.size / COMPRESSED_BYTES_PER_SECOND;
}

/** Status, type and body only: Telnyx's other headers are not passed to the page. */
function passThrough(upstream) {
    return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
    });
}

async function readJson(request) {
    const length = Number(request.headers.get("Content-Length")) || 0;
    if (length > 2_000_000) throw httpError(413, "Request too large.");
    try {
        return await request.json();
    } catch (_) {
        throw httpError(400, "Invalid JSON.");
    }
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
