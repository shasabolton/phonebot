/**
 * Recover assistant text from Groq tool_use_failed / Harmony-as-tool errors.
 * Browser: window.GroqChatRecover
 * Worker: import { … } from "../../groqChatRecover.js"
 */

const SPEECH_KEYS = ["message", "content", "text", "reply", "response", "speech", "utterance"];

function parseMaybeJson(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    const s = String(value).trim();
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch (_) {
        // Occasionally the whole blob is a JSON string literal
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            try {
                return JSON.parse(JSON.parse(s));
            } catch (__) {
                return null;
            }
        }
        return null;
    }
}

function looksLikeToolUseFailed(errorObj) {
    const err = errorObj?.error && typeof errorObj.error === "object" ? errorObj.error : errorObj;
    if (!err || typeof err !== "object") return false;
    const code = String(err.code || "").toLowerCase();
    const msg = String(err.message || "").toLowerCase();
    if (code === "tool_use_failed") return true;
    if (msg.includes("tool choice is none") && msg.includes("called a tool")) return true;
    if (msg.includes("tool_use_failed")) return true;
    return Object.prototype.hasOwnProperty.call(err, "failed_generation");
}

function isHarmonyChannelName(name) {
    const n = String(name || "");
    return (
        n.includes("<|channel|>") ||
        n.includes("|channel|") ||
        /assistant.*final/i.test(n) ||
        /constrain/i.test(n)
    );
}

/**
 * Pull speakable / assistant text out of a tool-call-shaped or plain failed_generation.
 * @param {unknown} failedGeneration
 * @returns {string|null}
 */
function extractTextFromFailedGeneration(failedGeneration) {
    if (failedGeneration == null) return null;

    if (typeof failedGeneration === "string") {
        const trimmed = failedGeneration.trim();
        if (!trimmed) return null;
        const parsed = parseMaybeJson(trimmed);
        if (parsed && typeof parsed === "object") {
            return extractTextFromFailedGeneration(parsed);
        }
        // Plain prose (not a tool envelope)
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
        return null;
    }

    if (typeof failedGeneration !== "object" || Array.isArray(failedGeneration)) return null;

    // Tool-call shape: { name, arguments }
    if (
        Object.prototype.hasOwnProperty.call(failedGeneration, "arguments") ||
        Object.prototype.hasOwnProperty.call(failedGeneration, "name")
    ) {
        const harmony = isHarmonyChannelName(failedGeneration.name);
        const fromArgs = extractTextFromArguments(failedGeneration.arguments, {
            allowSoleString: harmony
        });
        if (fromArgs) return fromArgs;
        return null;
    }

    for (const key of SPEECH_KEYS) {
        if (typeof failedGeneration[key] === "string" && failedGeneration[key].trim()) {
            return failedGeneration[key].trim();
        }
    }

    return null;
}

/**
 * @param {unknown} args
 * @param {{ allowSoleString?: boolean }} [opts]
 * @returns {string|null}
 */
function extractTextFromArguments(args, opts = {}) {
    const allowSoleString = opts.allowSoleString === true;
    if (args == null) return null;

    if (typeof args === "string") {
        const trimmed = args.trim();
        if (!trimmed) return null;
        const parsed = parseMaybeJson(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return extractTextFromArguments(parsed, opts);
        }
        // Whole arguments value is the spoken reply (common Harmony leak)
        return trimmed;
    }

    if (typeof args !== "object" || Array.isArray(args)) return null;

    for (const key of SPEECH_KEYS) {
        if (typeof args[key] === "string" && args[key].trim()) {
            return args[key].trim();
        }
    }

    if (allowSoleString) {
        const stringValues = Object.values(args).filter((v) => typeof v === "string" && v.trim());
        if (stringValues.length === 1) return stringValues[0].trim();

        const objectValues = Object.values(args).filter(
            (v) => v && typeof v === "object" && !Array.isArray(v)
        );
        if (objectValues.length === 1 && stringValues.length === 0) {
            return extractTextFromArguments(objectValues[0], opts);
        }
    }

    return null;
}

/**
 * @param {string|object} rawOrJson - HTTP error body
 * @returns {string|null}
 */
function salvageGroqToolUseFailedText(rawOrJson) {
    let obj = rawOrJson;
    if (typeof rawOrJson === "string") {
        try {
            obj = JSON.parse(rawOrJson);
        } catch (_) {
            return null;
        }
    }
    if (!obj || typeof obj !== "object") return null;
    if (!looksLikeToolUseFailed(obj)) return null;

    const err = obj.error && typeof obj.error === "object" ? obj.error : obj;
    const failed = err.failed_generation;
    return extractTextFromFailedGeneration(failed);
}

/**
 * Build a minimal chat-completions-shaped payload from salvaged text.
 * @param {string} contentText
 * @param {string} [model]
 * @returns {object}
 */
function syntheticChatCompletion(contentText, model = "") {
    const content = String(contentText || "").trim();
    return {
        id: "phonebot-salvaged",
        object: "chat.completion",
        model: model || "unknown",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop"
            }
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
            total_tokens: Math.max(1, Math.ceil(content.length / 4))
        },
        phonebot_salvaged_from: "tool_use_failed"
    };
}

/**
 * If status is an error and body is salvageable, return { contentText, payload }.
 * @param {number} status
 * @param {string} rawText
 * @param {string} [model]
 * @returns {{ contentText: string, payload: object }|null}
 */
function trySalvageGroqChatError(status, rawText, model = "") {
    if (status < 400 || status >= 500) return null;
    const contentText = salvageGroqToolUseFailedText(rawText);
    if (!contentText) return null;
    return {
        contentText,
        payload: syntheticChatCompletion(contentText, model)
    };
}

const api = {
    salvageGroqToolUseFailedText,
    extractTextFromFailedGeneration,
    syntheticChatCompletion,
    trySalvageGroqChatError
};

if (typeof window !== "undefined") {
    window.GroqChatRecover = api;
}

export {
    salvageGroqToolUseFailedText,
    extractTextFromFailedGeneration,
    syntheticChatCompletion,
    trySalvageGroqChatError
};
export default api;
