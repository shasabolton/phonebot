/**
 * Is a Telnyx chat model fit for spoken game turns? Shared by the Worker (one background test after
 * a turn, see telnyxChatModels.js) and scripts/updateTelnyxChatModels.mjs (the full first test).
 * A model passes when it answers quickly with a short spoken reply and no reasoning: models that
 * think first are too slow for voice even when their thinking is hidden. There are two lists:
 * "text" for ordinary turns and "photo" for turns that send a camera image; few models take
 * images, so the photo list accepts one that reasons if its whole reply is still quick.
 */

export const TELNYX_BASE = "https://api.telnyx.com/v2";
export const SHORTLIST_SIZE = 4;
export const KINDS = Object.freeze(["text", "photo"]);

/** Qwen, Gemma and GLM templates read `enable_thinking`; Kimi reads `thinking`. Templates ignore the other. */
export const THINKING_OFF_KWARGS = Object.freeze({ enable_thinking: false, thinking: false });
/** Mistral tokenizers fail the whole request when given chat_template_kwargs. */
export const REJECTS_TEMPLATE_KWARGS = /mistral/i;

/** The same bar as TelnyxVoice.rankChatModels for "picked automatically". */
const CHAT_TASKS = ["text-generation", "text-to-text", "image-text-to-text"];
const NOT_CHAT_MODEL = /whisper|nova-|embed|rerank|guard|tts|-lora$/i;
const MIN_CHAT_CONTEXT = 8192;
const MIN_CHAT_PARAMETERS = 20e9;
const TURN_INPUT_TOKENS = 1500;
const TURN_OUTPUT_TOKENS = 150;

/** Matches the Telnyx agent in robots.js. */
const TEST_MAX_TOKENS = 400;
/** Matches TELNYX_PHOTO_MAX_TOKENS in agentInterface.js: room for a reasoner's thinking plus the reply. */
export const PHOTO_MAX_TOKENS = 1024;
const TEST_TEMPERATURE = 0.9;
const TEST_TIMEOUT_MS = 15000;
/** A little reasoning ("low") is tolerated; more delays the first spoken word too much. */
const MAX_REASONING_CHARS = 200;
/**
 * Photo turns are rarer and not streamed, so a model that reasons may still back up the photo list
 * if the whole reply is this quick; slower with reasoning counts as a strike, not a rejection.
 */
const PHOTO_REASONING_MAX_MS = 3000;
const MAX_REPLY_WORDS = 90;
/** Whole non-streamed reply; slower counts as a passing glitch, not a fault. */
const MAX_REPLY_MS = 8000;

const REASONING_TAG = String.raw`(?:[a-z][\w.-]*:)?(?:think|thinking|thought|thoughts|reason|reasoning|reflection|analysis|scratchpad)`;
const REASONING_BLOCK_RE = new RegExp(String.raw`<${REASONING_TAG}\b[^>]*>[\s\S]*?</${REASONING_TAG}\s*>`, "gi");
const REASONING_OPEN_RE = new RegExp(String.raw`<${REASONING_TAG}\b[^>]*>`, "i");
const REASONING_CLOSE_RE = new RegExp(String.raw`</${REASONING_TAG}\s*>`, "i");
const NARRATES_RE = /^\W*(the user|user (says|said|asks|wants|is)|the assistant|we need to|i need to|i should|let me think|okay,? so)\b/i;

const TEST_SYSTEM = {
    role: "system",
    content:
        "You are Lex, a friendly robot who plays word games with people through a speaker. Everything you write is " +
        "spoken aloud: use plain sentences with no emojis, markdown, lists or stage directions, and reply in at most 35 words."
};

/** Plain 256-pixel squares: a model that really looks says the colour; two colours rule out a lucky guess. */
const RED_SQUARE =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAElEQVR42u3TQQ0AAAgDsYmYf2WI4Y0GmlTBJZdp4a1IgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAADKACBgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAEwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADIABVMAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMANcCAjIPPbJ6p4sAAAAASUVORK5CYII=";
const BLUE_SQUARE =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAUlEQVR42u3TQQ0AAAjEsBOBCPzrQQxvNNCkCpYs1QNvRQIMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA2AAFTAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAADKACBgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAEwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAC4FpsgEGn7O+F1AAAAAElFTkSuQmCC";
const photoTurn = (name, question, url, expect) => ({
    name,
    expect,
    maxTokens: PHOTO_MAX_TOKENS,
    reasoningMaxMs: PHOTO_REASONING_MAX_MS,
    messages: [
        TEST_SYSTEM,
        {
            role: "user",
            content: [
                { type: "text", text: question },
                { type: "image_url", image_url: { url } }
            ]
        }
    ]
});

const TEXT_TURNS = Object.freeze([
    {
        name: "game intro",
        messages: [
            TEST_SYSTEM,
            {
                role: "user",
                content:
                    "Tell the user how to play the game of 20 questions: they think of an object, person, place, or animal, " +
                    "and you will ask up to 20 yes-or-no questions to guess what it is. Then ask if they want to play."
            }
        ]
    },
    {
        name: "mid-game",
        messages: [
            TEST_SYSTEM,
            { role: "user", content: "Let's play 20 questions. I'm thinking of something." },
            { role: "assistant", content: "Great! Question one: is it alive?" },
            { role: "user", content: "Yes." }
        ]
    },
    {
        name: "small talk",
        messages: [TEST_SYSTEM, { role: "user", content: "Hi Lex! What's your favourite game?" }]
    }
]);

/** Game-like turns per list; the Worker's background check uses one at random, the script all of them. */
export const TEST_TURNS_BY_KIND = Object.freeze({
    text: TEXT_TURNS,
    photo: Object.freeze([
        photoTurn("photo red", "What colour is this picture? Answer in one short sentence.", RED_SQUARE, /\b(red|crimson|scarlet)\b/i),
        photoTurn("photo blue", "What colour is this picture? Answer in one short sentence.", BLUE_SQUARE, /\bblue\b/i)
    ])
});

/**
 * Reply text with model reasoning removed: <think>, <mm:think>, <reasoning> and similar blocks, a
 * closing tag whose opening was in the prompt, and an unclosed block cut off by the token limit.
 * While streaming (`final` false) an unfinished trailing tag is held back.
 */
export function stripReasoning(raw, final = true) {
    let text = String(raw || "").replace(REASONING_BLOCK_RE, "");
    const close = text.match(REASONING_CLOSE_RE);
    if (close) text = text.slice(close.index + close[0].length);
    const open = text.search(REASONING_OPEN_RE);
    if (open >= 0) text = text.slice(0, open);
    if (!final) text = text.replace(/<\/?[\w.:-]*$/, "");
    return text;
}

export function hasReasoningTags(raw) {
    return REASONING_OPEN_RE.test(raw) || REASONING_CLOSE_RE.test(raw);
}

/** "25.8B", "1.0T", "70600000000" -> parameters, or 0 when unknown. */
function parameterCount(raw) {
    const n = Number(raw?.parameters);
    if (n > 0) return n;
    const match = /^\s*([\d.]+)\s*([KMBT])?\s*$/i.exec(String(raw?.parameters_str || ""));
    if (!match) return 0;
    return Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[String(match[2] || "").toLowerCase()] || 1);
}

/**
 * Models from GET /ai/openai/models that may be tried for the shortlist, best first: priced chat
 * models Telnyx runs itself on the default tier with room for a game's prompt and big enough (or
 * recommended for assistants); listed before preview, then cheapest per game turn. For "photo",
 * only models Telnyx says take images.
 * @param {"text"|"photo"} [kind]
 * @returns {{ id: string, costPerTurn: number }[]}
 */
export function rankChatCandidates(list, kind = "text") {
    const raws = (Array.isArray(list) ? list : []).filter((m) => m && typeof m === "object");
    const priceOf = (m) => ({
        input: Number(m.pricing?.input ?? m.pricing?.prompt),
        output: Number(m.pricing?.output ?? m.pricing?.completion)
    });
    const priced = (m) => priceOf(m).input > 0 && priceOf(m).output > 0;
    const ownedByTelnyx = (m) => String(m.owned_by || "").toLowerCase() === "telnyx";
    const taskOf = (m) => String(m.task || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    const takesImages = (m) => m.is_vision_supported === true || taskOf(m) === "image-text-to-text";
    // If Telnyx stops marking its own models (or which take images), don't throw every model away.
    const needHosted = raws.some((m) => ownedByTelnyx(m) && priced(m));
    const needImages = kind === "photo" && raws.some(takesImages);
    const candidates = [];
    for (const m of raws) {
        const id = String(m.id || "").trim();
        const task = taskOf(m);
        if (!id || (task ? !CHAT_TASKS.includes(task) : NOT_CHAT_MODEL.test(id))) continue;
        if (!priced(m) || (needHosted && !ownedByTelnyx(m))) continue;
        if (kind === "photo" && (needImages ? !takesImages(m) : m.is_vision_supported === false)) continue;
        const service = Array.isArray(m.service_tiers) ? m.service_tiers.map((s) => String(s).toLowerCase()) : null;
        if (service && !service.includes("default")) continue;
        const context = Number(m.context_length) || 0;
        if (context && context < MIN_CHAT_CONTEXT) continue;
        if (m.recommended_for_assistants !== true && !(parameterCount(m) >= MIN_CHAT_PARAMETERS)) continue;
        const { input, output } = priceOf(m);
        candidates.push({
            id,
            costPerTurn: (input * TURN_INPUT_TOKENS + output * TURN_OUTPUT_TOKENS) / 1e6,
            preview: String(m.tier || "").toLowerCase() === "unlisted"
        });
    }
    return candidates
        .sort((a, b) => Number(a.preview) - Number(b.preview) || a.costPerTurn - b.costPerTurn || a.id.localeCompare(b.id))
        .map(({ id, costPerTurn }) => ({ id, costPerTurn }));
}

/** @returns {Promise<object[]>} the raw model list */
export async function fetchChatModelList(apiKey, fetchImpl = fetch) {
    const response = await fetchImpl(`${TELNYX_BASE}/ai/openai/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Telnyx model list failed (${response.status}): ${errorDetail(raw)}`);
    const payload = JSON.parse(raw);
    return Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
}

function errorDetail(raw) {
    try {
        const parsed = JSON.parse(raw);
        const first = parsed?.errors?.[0];
        if (first) return `${first.code ? `${first.code} ` : ""}${first.detail || first.title || ""}`.trim();
        if (typeof parsed?.error?.message === "string") return parsed.error.message;
        if (typeof parsed?.error === "string") return parsed.error;
    } catch (_) {}
    return String(raw || "").slice(0, 200);
}

/**
 * "account": the key or balance is the problem, not the model (blame nothing);
 * "transient": rate limit, server error or timeout (may pass later);
 * "unusable": retired, needs another provider's key, or refuses this request shape.
 */
function classifyHttpFailure(status) {
    if (status === 401 || status === 402 || status === 403) return "account";
    if (status === 408 || status === 429 || status >= 500) return "transient";
    return "unusable";
}

/** Gone or not usable on this account at all, whatever the request: off both lists. */
const RETIRED_RE = /\b10015\b|not found|does not exist|no longer (available|supported)|deprecat|decommission|api key (is )?required|customer-provided api key/i;

/**
 * One non-streamed chat request shaped like a real game turn. `retired` marks a model that is gone
 * or needs another provider's key, as opposed to one that only fails this kind of turn.
 * @returns {Promise<{ kind: "pass"|"unusable"|"transient"|"account", reason: string, ms: number,
 *   retired?: boolean, reasoningChars?: number, reasons?: boolean, words?: number, reply?: string }>}
 */
export async function testChatTurn(apiKey, id, turn, fetchImpl = fetch) {
    const body = {
        model: id,
        messages: turn.messages,
        max_tokens: turn.maxTokens || TEST_MAX_TOKENS,
        temperature: TEST_TEMPERATURE,
        stream: false
    };
    if (!REJECTS_TEMPLATE_KWARGS.test(id)) body.chat_template_kwargs = { ...THINKING_OFF_KWARGS };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let response;
    let raw;
    try {
        response = await fetchImpl(`${TELNYX_BASE}/ai/openai/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        raw = await response.text();
    } catch (error) {
        const reason = controller.signal.aborted ? `no reply within ${TEST_TIMEOUT_MS / 1000} s` : `request failed: ${error?.message || error}`;
        return { kind: "transient", reason, ms: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
    const ms = Date.now() - started;
    if (!response.ok) {
        const kind = classifyHttpFailure(response.status);
        const reason = `HTTP ${response.status}: ${errorDetail(raw)}`;
        return { kind, reason, ms, retired: kind === "unusable" && (response.status === 404 || RETIRED_RE.test(reason)) };
    }
    let json;
    try {
        json = JSON.parse(raw);
    } catch (_) {
        return { kind: "transient", reason: "reply was not JSON", ms };
    }
    const choice = json?.choices?.[0] || {};
    const content = String(choice.message?.content ?? "");
    const reasoningChars = String(choice.message?.reasoning_content || choice.message?.reasoning || "").length;
    const reply = stripReasoning(content).trim();
    const words = reply ? reply.split(/\s+/).length : 0;
    const reasons = reasoningChars > MAX_REASONING_CHARS;
    const stats = { ms, reasoningChars, reasons, words, reply };
    const unusable = (reason) => ({ ...stats, kind: "unusable", reason });
    if (reasons && !turn.reasoningMaxMs) return unusable(`reasons before answering (${reasoningChars} characters) even with thinking off`);
    if (hasReasoningTags(content)) return unusable("puts its reasoning inside the reply text");
    if (!reply) return unusable(`returned no reply (finish_reason ${choice.finish_reason || "not sent"})`);
    if (choice.finish_reason === "length") return unusable(`ran out of tokens mid-reply`);
    if (NARRATES_RE.test(reply)) return unusable(`narrates instead of replying: "${reply.slice(0, 60)}"`);
    if (words > MAX_REPLY_WORDS) return unusable(`too long for a spoken reply (${words} words)`);
    if (turn.expect && !turn.expect.test(reply)) return unusable(`didn't describe the image: "${reply.slice(0, 60)}"`);
    if (reasons && ms > turn.reasoningMaxMs) {
        return { ...stats, kind: "transient", reason: `reasons before answering (${reasoningChars} characters) and took ${ms} ms` };
    }
    if (ms > MAX_REPLY_MS) return { ...stats, kind: "transient", reason: `slow reply (${ms} ms)` };
    return { ...stats, kind: "pass", reason: "" };
}
