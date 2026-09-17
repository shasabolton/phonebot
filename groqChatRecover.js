/**
 * Recover assistant text from Groq tool_use_failed / Harmony-as-tool errors.
 * Browser: window.GroqChatRecover
 * Worker: import { … } from "../../groqChatRecover.js"
 */

const SPEECH_KEYS = ["message", "content", "text", "reply", "response", "speech", "utterance", "final"];

function parseMaybeJson(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    const s = String(value).trim();
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch (_) {
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
    if (msg.includes("tool choice is none")) return true;
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

function longestStringValue(obj, depth = 0) {
    if (depth > 4 || obj == null) return "";
    if (typeof obj === "string") return obj.trim();
    if (typeof obj !== "object") return "";
    let best = "";
    const values = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of values) {
        const s = longestStringValue(v, depth + 1);
        if (s.length > best.length) best = s;
    }
    return best;
}

/**
 * When JSON.parse fails on failed_generation, pull the arguments string with a regex.
 * Groq/gpt-oss often emits invalid JSON: `"arguments": Ah, the reply…}` (no quotes around prose).
 * @param {string} raw
 * @returns {string|null}
 */
function extractArgumentsViaRegex(raw) {
    const s = String(raw || "");
    if (!s) return null;

    // "arguments": "....."  (JSON string)
    const stringArg = s.match(/"arguments"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (stringArg) {
        try {
            return JSON.parse(`"${stringArg[1]}"`);
        } catch (_) {
            return stringArg[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
    }

    // "arguments": { ... } — take longest quoted string inside the object blob
    const objStart = s.match(/"arguments"\s*:\s*\{/);
    if (objStart) {
        const fromBrace = s.slice(objStart.index + objStart[0].length - 1);
        const quotes = [...fromBrace.matchAll(/"((?:\\.|[^"\\]){8,})"/g)].map((m) => {
            try {
                return JSON.parse(`"${m[1]}"`);
            } catch (_) {
                return m[1];
            }
        });
        const speechy = quotes.filter((q) => /\s/.test(q) || q.length >= 24);
        if (speechy.length) {
            return speechy.sort((a, b) => b.length - a.length)[0];
        }
        if (quotes.length) return quotes.sort((a, b) => b.length - a.length)[0];
    }

    // "arguments": bare prose…}  (invalid JSON — common Harmony leak)
    const bare = s.match(/"arguments"\s*:\s*(?!"|\{)([\s\S]*?)\s*\}\s*$/);
    if (bare) {
        let text = bare[1].trim();
        // Strip a trailing `}` if the outer object closed mid-match oddly
        text = text.replace(/\}\s*$/, "").trim();
        if (text.length >= 2) return text;
    }

    return null;
}

/**
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
            const fromObj = extractTextFromFailedGeneration(parsed);
            if (fromObj) return fromObj;
        }
        const viaRegex = extractArgumentsViaRegex(trimmed);
        if (viaRegex && viaRegex.trim()) return viaRegex.trim();
        // Plain prose (not a tool envelope)
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
        return null;
    }

    if (typeof failedGeneration !== "object" || Array.isArray(failedGeneration)) return null;

    if (
        Object.prototype.hasOwnProperty.call(failedGeneration, "arguments") ||
        Object.prototype.hasOwnProperty.call(failedGeneration, "name")
    ) {
        // For tool_use_failed with no real tools, arguments usually ARE the reply.
        const fromArgs = extractTextFromArguments(failedGeneration.arguments, {
            allowSoleString: true,
            preferLongest: isHarmonyChannelName(failedGeneration.name)
        });
        if (fromArgs) return fromArgs;
        return null;
    }

    for (const key of SPEECH_KEYS) {
        if (typeof failedGeneration[key] === "string" && failedGeneration[key].trim()) {
            return failedGeneration[key].trim();
        }
    }

    const longest = longestStringValue(failedGeneration);
    return longest.length >= 8 ? longest : null;
}

/**
 * @param {unknown} args
 * @param {{ allowSoleString?: boolean, preferLongest?: boolean }} [opts]
 * @returns {string|null}
 */
function extractTextFromArguments(args, opts = {}) {
    const allowSoleString = opts.allowSoleString !== false;
    if (args == null) return null;

    if (typeof args === "string") {
        const trimmed = args.trim();
        if (!trimmed) return null;
        const parsed = parseMaybeJson(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return extractTextFromArguments(parsed, opts);
        }
        return trimmed;
    }

    if (typeof args !== "object") return null;

    if (Array.isArray(args)) {
        const parts = args
            .map((v) => (typeof v === "string" ? v.trim() : extractTextFromArguments(v, opts)))
            .filter(Boolean);
        return parts.length ? parts.join(" ") : null;
    }

    for (const key of SPEECH_KEYS) {
        if (typeof args[key] === "string" && args[key].trim()) {
            return args[key].trim();
        }
    }

    if (allowSoleString) {
        const stringValues = Object.values(args).filter((v) => typeof v === "string" && v.trim());
        if (stringValues.length === 1) return stringValues[0].trim();
        if (stringValues.length > 1) {
            // Prefer the longest speech-like string (skip short ids / enums)
            const speechy = stringValues.filter((s) => /\s/.test(s) || s.length >= 24);
            const pool = speechy.length ? speechy : stringValues;
            return pool.sort((a, b) => b.length - a.length)[0].trim();
        }

        const objectValues = Object.values(args).filter(
            (v) => v && typeof v === "object" && !Array.isArray(v)
        );
        if (objectValues.length === 1) {
            return extractTextFromArguments(objectValues[0], opts);
        }
    }

    if (opts.preferLongest) {
        const longest = longestStringValue(args);
        if (longest.length >= 8) return longest;
    }

    return null;
}

/**
 * @param {string|object} rawOrJson
 * @returns {string|null}
 */
function salvageGroqToolUseFailedText(rawOrJson) {
    let obj = rawOrJson;
    let rawString = "";
    if (typeof rawOrJson === "string") {
        rawString = rawOrJson;
        try {
            obj = JSON.parse(rawOrJson);
        } catch (_) {
            return extractArgumentsViaRegex(rawOrJson);
        }
    }
    if (!obj || typeof obj !== "object") return null;
    if (!looksLikeToolUseFailed(obj)) {
        // Still try if the raw body mentions failed_generation
        if (rawString && /failed_generation/i.test(rawString)) {
            return extractArgumentsViaRegex(rawString);
        }
        return null;
    }

    const err = obj.error && typeof obj.error === "object" ? obj.error : obj;
    const failed = err.failed_generation;
    const extracted = extractTextFromFailedGeneration(failed);
    if (extracted) return extracted;
    if (typeof failed === "string") return extractArgumentsViaRegex(failed);
    if (rawString) return extractArgumentsViaRegex(rawString);
    try {
        return extractArgumentsViaRegex(JSON.stringify(failed));
    } catch (_) {
        return null;
    }
}

/**
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
 * @param {number} status
 * @param {string} rawText
 * @param {string} [model]
 * @returns {{ contentText: string, payload: object }|null}
 */
function trySalvageGroqChatError(status, rawText, model = "") {
    if (status < 400) return null;
    // Allow 5xx only when body clearly has failed_generation (unusual but cheap)
    if (status >= 500 && !/failed_generation|tool_use_failed|tool choice is none/i.test(String(rawText || ""))) {
        return null;
    }
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
