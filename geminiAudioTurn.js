/**
 * Gemini native REST helpers: audio-in → JSON transcripts, plus TTS speech generation.
 * Browser-only, no bundler. One short generateContent call per step — no Live session.
 */
class GeminiAudioTurn {
    static DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
    static DEFAULT_MODEL = "gemini-3.6-flash";
    static DEFAULT_SPEECH_MODEL = "gemini-3.1-flash-tts-preview";
    static STORAGE_VOICE = "phonebot.agent.geminiTtsVoice";
    static DEFAULT_VOICE = "Kore";
    static PCM_SAMPLE_RATE = 24000;

    static VOICES = [
        { id: "Zephyr", label: "Zephyr — bright" },
        { id: "Puck", label: "Puck — upbeat" },
        { id: "Charon", label: "Charon — informative" },
        { id: "Kore", label: "Kore — firm" },
        { id: "Fenrir", label: "Fenrir — excitable" },
        { id: "Leda", label: "Leda — youthful" },
        { id: "Orus", label: "Orus — firm" },
        { id: "Aoede", label: "Aoede — breezy" },
        { id: "Callirrhoe", label: "Callirrhoe — easy-going" },
        { id: "Autonoe", label: "Autonoe — bright" },
        { id: "Enceladus", label: "Enceladus — breathy" },
        { id: "Iapetus", label: "Iapetus — clear" },
        { id: "Umbriel", label: "Umbriel — easy-going" },
        { id: "Algieba", label: "Algieba — smooth" },
        { id: "Despina", label: "Despina — smooth" },
        { id: "Erinome", label: "Erinome — clear" },
        { id: "Algenib", label: "Algenib — gravelly" },
        { id: "Rasalgethi", label: "Rasalgethi — informative" },
        { id: "Laomedeia", label: "Laomedeia — upbeat" },
        { id: "Achernar", label: "Achernar — soft" },
        { id: "Alnilam", label: "Alnilam — firm" },
        { id: "Schedar", label: "Schedar — even" },
        { id: "Gacrux", label: "Gacrux — mature" },
        { id: "Pulcherrima", label: "Pulcherrima — forward" },
        { id: "Achird", label: "Achird — friendly" },
        { id: "Zubenelgenubi", label: "Zubenelgenubi — casual" },
        { id: "Vindemiatrix", label: "Vindemiatrix — gentle" },
        { id: "Sadachbia", label: "Sadachbia — lively" },
        { id: "Sadaltager", label: "Sadaltager — knowledgeable" },
        { id: "Sulafat", label: "Sulafat — warm" }
    ];

    static isGeminiAgent(agent) {
        if (!agent || typeof agent !== "object") return false;
        if (String(agent.provider || "").trim().toLowerCase() === "gemini") return true;
        const mode = String(agent.voiceMode || "").trim().toLowerCase();
        if (mode === "geminiaudioturn") return true;
        return String(agent.baseUrl || "").toLowerCase().includes("generativelanguage.googleapis.com");
    }

    static isAudioTurnAgent(agent) {
        if (!GeminiAudioTurn.isGeminiAgent(agent)) return false;
        const mode = String(agent.voiceMode || "geminiAudioTurn").trim().toLowerCase();
        return mode === "geminiaudioturn" || mode === "audio" || mode === "audio-turn";
    }

    static loadSavedVoice() {
        try {
            const v = localStorage.getItem(GeminiAudioTurn.STORAGE_VOICE);
            if (v && GeminiAudioTurn.isKnownVoice(v)) return v;
        } catch (_) {}
        return GeminiAudioTurn.DEFAULT_VOICE;
    }

    static saveVoice(voiceId) {
        const id = GeminiAudioTurn.isKnownVoice(voiceId) ? voiceId : GeminiAudioTurn.DEFAULT_VOICE;
        try {
            localStorage.setItem(GeminiAudioTurn.STORAGE_VOICE, id);
        } catch (_) {}
        return id;
    }

    static isKnownVoice(voiceId) {
        return GeminiAudioTurn.VOICES.some((v) => v.id === voiceId);
    }

    static resolveBaseUrl(agent, fallback) {
        const fromAgent = String(agent?.baseUrl || "").trim().replace(/\/$/, "");
        if (fromAgent) return fromAgent;
        const fromFallback = String(fallback || "").trim().replace(/\/$/, "");
        return fromFallback || GeminiAudioTurn.DEFAULT_BASE_URL;
    }

    static generateContentUrl(baseUrl, model) {
        const base = String(baseUrl || GeminiAudioTurn.DEFAULT_BASE_URL).replace(/\/$/, "");
        const id = encodeURIComponent(String(model || GeminiAudioTurn.DEFAULT_MODEL).trim());
        return `${base}/models/${id}:generateContent`;
    }

    static arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const chunk = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    static base64ToUint8Array(b64) {
        const clean = String(b64 || "").replace(/\s+/g, "");
        const bin = atob(clean);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    static pcmToWavBlob(pcmBuffer, sampleRate = GeminiAudioTurn.PCM_SAMPLE_RATE, numChannels = 1) {
        const bytes = pcmBuffer instanceof Uint8Array ? pcmBuffer : new Uint8Array(pcmBuffer);
        const blockAlign = numChannels * 2;
        const byteRate = sampleRate * blockAlign;
        const dataSize = bytes.byteLength;
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const writeStr = (offset, s) => {
            for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
        };
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        writeStr(36, "data");
        view.setUint32(40, dataSize, true);
        return new Blob([header, bytes], { type: "audio/wav" });
    }

    static looksLikeWav(bytes) {
        return (
            bytes &&
            bytes.length >= 12 &&
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46 &&
            bytes[8] === 0x57 &&
            bytes[9] === 0x41 &&
            bytes[10] === 0x56 &&
            bytes[11] === 0x45
        );
    }

    static sampleRateFromMime(mimeType) {
        const m = String(mimeType || "").match(/rate\s*=\s*(\d+)/i);
        const n = m ? Number(m[1]) : NaN;
        return Number.isFinite(n) && n > 0 ? n : GeminiAudioTurn.PCM_SAMPLE_RATE;
    }

    static audioBlobFromInlineData(inlineData) {
        if (!inlineData || typeof inlineData !== "object") return null;
        const b64 = inlineData.data || inlineData.Data;
        if (!b64) return null;
        const bytes = GeminiAudioTurn.base64ToUint8Array(b64);
        if (!bytes.length) return null;
        const mime = String(inlineData.mimeType || inlineData.mime_type || "audio/pcm").toLowerCase();
        if (mime.includes("wav") || GeminiAudioTurn.looksLikeWav(bytes)) {
            return new Blob([bytes], { type: "audio/wav" });
        }
        if (mime.includes("mpeg") || mime.includes("mp3")) {
            return new Blob([bytes], { type: "audio/mpeg" });
        }
        if (mime.includes("ogg")) {
            return new Blob([bytes], { type: "audio/ogg" });
        }
        const rate = GeminiAudioTurn.sampleRateFromMime(mime);
        return GeminiAudioTurn.pcmToWavBlob(bytes, rate, 1);
    }

    static async blobToWavBlob(blob) {
        if (!blob) throw new Error("No audio blob to convert.");
        const type = String(blob.type || "").toLowerCase();
        if (type.includes("wav")) return blob;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (typeof Ctx !== "function") {
            throw new Error("AudioContext unavailable — cannot convert mic audio for Gemini.");
        }
        const ctx = new Ctx();
        try {
            const raw = await blob.arrayBuffer();
            const decoded = await ctx.decodeAudioData(raw.slice(0));
            const sampleRate = decoded.sampleRate || 16000;
            const frames = decoded.length;
            const channels = decoded.numberOfChannels || 1;
            const pcm = new Int16Array(frames);
            for (let i = 0; i < frames; i++) {
                let sum = 0;
                for (let c = 0; c < channels; c++) sum += decoded.getChannelData(c)[i] || 0;
                const x = Math.max(-1, Math.min(1, sum / channels));
                pcm[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
            }
            return GeminiAudioTurn.pcmToWavBlob(pcm.buffer, sampleRate, 1);
        } catch (err) {
            throw new Error(
                `Could not convert mic audio to WAV for Gemini (${err?.message || err}). Try Chrome/Edge.`
            );
        } finally {
            try {
                await ctx.close();
            } catch (_) {}
        }
    }

    static extractCandidateText(json) {
        const parts = json?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return "";
        return parts
            .map((p) => (p && typeof p.text === "string" ? p.text : ""))
            .join("")
            .trim();
    }

    static extractInlineAudioPart(json) {
        const parts = json?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return null;
        for (const p of parts) {
            const inline = p?.inlineData || p?.inline_data;
            if (inline?.data) return inline;
        }
        return null;
    }

    static parseTranscriptsJson(text) {
        const raw = String(text || "").trim();
        if (!raw) return { userTranscript: "", assistantTranscript: "" };
        let obj = null;
        try {
            obj = JSON.parse(raw);
        } catch (_) {
            const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            const candidate = fence ? fence[1] : raw;
            const start = candidate.indexOf("{");
            const end = candidate.lastIndexOf("}");
            if (start >= 0 && end > start) {
                try {
                    obj = JSON.parse(candidate.slice(start, end + 1));
                } catch (_) {
                    obj = null;
                }
            }
        }
        if (!obj || typeof obj !== "object") {
            return { userTranscript: "", assistantTranscript: raw };
        }
        const userTranscript = String(
            obj.userTranscript ?? obj.user_transcript ?? obj.transcript ?? ""
        ).trim();
        const assistantTranscript = String(
            obj.assistantTranscript ?? obj.assistant_transcript ?? obj.reply ?? obj.message ?? ""
        ).trim();
        return { userTranscript, assistantTranscript };
    }

    static formatHttpError(status, rawText) {
        const raw = String(rawText || "").trim();
        let detail = raw.slice(0, 500);
        try {
            const j = JSON.parse(raw);
            const msg = j?.error?.message || j?.message;
            if (msg) detail = String(msg).slice(0, 500);
        } catch (_) {}
        if (status === 429) return `Gemini HTTP 429 (quota / rate limit): ${detail}`;
        if (status === 400 || status === 401 || status === 403) {
            return `Gemini HTTP ${status}: ${detail}`;
        }
        return `Gemini HTTP ${status}: ${detail}`;
    }

    static async generateContent({
        baseUrl,
        apiKey,
        model,
        contents,
        systemInstruction,
        generationConfig,
        timeoutMs = 90000
    }) {
        const key = String(apiKey || "").trim();
        if (!key) throw new Error("Enter a Gemini API key (AI Studio, starts with AIza…).");
        const url = GeminiAudioTurn.generateContentUrl(baseUrl, model);
        const body = { contents: Array.isArray(contents) ? contents : [] };
        if (systemInstruction) {
            body.systemInstruction =
                typeof systemInstruction === "string"
                    ? { parts: [{ text: systemInstruction }] }
                    : systemInstruction;
        }
        if (generationConfig && typeof generationConfig === "object") {
            body.generationConfig = generationConfig;
        }
        const attempt = async (payload) => {
            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timeoutId =
                controller &&
                setTimeout(() => {
                    try {
                        controller.abort();
                    } catch (_) {}
                }, timeoutMs);
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": key
                    },
                    body: JSON.stringify(payload),
                    signal: controller?.signal
                });
                const rawText = await res.text();
                return { res, rawText };
            } catch (err) {
                if (err?.name === "AbortError") {
                    throw new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s.`);
                }
                const msg = String(err?.message || err || "");
                if (/failed to fetch|networkerror|cors/i.test(msg)) {
                    throw new Error(
                        "Gemini request blocked (network/CORS). Check the AI Studio key and that generativelanguage.googleapis.com is reachable from this page."
                    );
                }
                throw err;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }
        };

        let { res, rawText } = await attempt(body);
        if (
            !res.ok &&
            body.generationConfig &&
            body.generationConfig.thinkingConfig &&
            /thinking/i.test(rawText)
        ) {
            const retryBody = {
                ...body,
                generationConfig: { ...body.generationConfig }
            };
            delete retryBody.generationConfig.thinkingConfig;
            ({ res, rawText } = await attempt(retryBody));
        }
        if (!res.ok) {
            throw new Error(GeminiAudioTurn.formatHttpError(res.status, rawText));
        }
        let json;
        try {
            json = JSON.parse(rawText);
        } catch (_) {
            throw new Error("Gemini response was not JSON.");
        }
        const blockReason = json?.promptFeedback?.blockReason || json?.promptFeedback?.block_reason;
        if (blockReason) {
            throw new Error(`Gemini blocked the prompt (${blockReason}).`);
        }
        const finish = String(json?.candidates?.[0]?.finishReason || json?.candidates?.[0]?.finish_reason || "");
        if (finish && /safety|block|recitation|prohibited/i.test(finish) && !GeminiAudioTurn.extractCandidateText(json)) {
            throw new Error(`Gemini finished with ${finish}.`);
        }
        return { json, rawText, text: GeminiAudioTurn.extractCandidateText(json) };
    }

    static historyToGeminiContents(textHistory) {
        const contents = [];
        for (const m of Array.isArray(textHistory) ? textHistory : []) {
            if (!m) continue;
            const role = m.role === "assistant" || m.role === "model" ? "model" : "user";
            if (m.role === "system") continue;
            const text = String(m.content ?? m.text ?? "").trim();
            if (!text) continue;
            contents.push({ role, parts: [{ text }] });
        }
        return contents;
    }

    static buildTurnInstruction({ typedUserText, hasAudio, stateJson, systemOrIntro, maxReplyChars }) {
        const lines = [
            "This is a single Gemini turn. Do not assume any prior audio exists on the server.",
            "Memory is the text chat history only, plus this request.",
            "Reply in character as the robot using the history and (if present) this mic clip.",
            "Keep the spoken reply short and speakable. No markdown, no bullet lists, no stage directions.",
            `assistantTranscript must be the exact words to speak (under ${maxReplyChars} characters).`
        ];
        if (hasAudio) {
            lines.push("Transcribe only this attached clip as userTranscript.");
            lines.push("If the clip has no speech, set userTranscript to an empty string.");
        } else {
            lines.push("There is no new mic clip. userTranscript must be exactly the typed user text below.");
        }
        const intro = String(systemOrIntro || "").trim();
        if (intro) {
            lines.push("", "System / game prompt:", intro);
        }
        const state = String(stateJson || "").trim();
        if (state) {
            lines.push("", "Current robot state (json):", state);
        }
        const typed = String(typedUserText || "").trim();
        if (typed && !hasAudio) {
            lines.push("", "Typed user text:", typed);
        } else if (typed && hasAudio) {
            lines.push("", "Optional typed hint (clip is authoritative):", typed);
        }
        lines.push(
            "",
            'Return JSON only: {"userTranscript":"...","assistantTranscript":"..."}'
        );
        return lines.join("\n");
    }

    /**
     * Audio (optional) + text history → transcripts, then Gemini TTS for the assistant line.
     * @returns {Promise<{ userTranscript: string, assistantTranscript: string, audioBlob: Blob|null }>}
     */
    static async sendAudioTurn({
        apiKey,
        baseUrl,
        model,
        speechModel,
        audioBlob,
        typedUserText,
        textHistory,
        systemOrIntro,
        stateJson,
        voice,
        temperature,
        maxTokens
    }) {
        const chatModel = String(model || GeminiAudioTurn.DEFAULT_MODEL).trim();
        const ttsModel = String(speechModel || GeminiAudioTurn.DEFAULT_SPEECH_MODEL).trim();
        const voiceName = GeminiAudioTurn.isKnownVoice(voice) ? voice : GeminiAudioTurn.DEFAULT_VOICE;
        const maxReplyChars = Number.isFinite(maxTokens) ? Math.max(40, Math.round(maxTokens) * 4) : 400;
        const hasAudio = !!(audioBlob && audioBlob.size >= 32);
        const typed = String(typedUserText || "").trim();
        if (!hasAudio && !typed) {
            throw new Error("Gemini audio turn needs a mic clip or typed text.");
        }

        const contents = GeminiAudioTurn.historyToGeminiContents(textHistory);
        const turnParts = [
            {
                text: GeminiAudioTurn.buildTurnInstruction({
                    typedUserText: typed,
                    hasAudio,
                    stateJson,
                    systemOrIntro,
                    maxReplyChars
                })
            }
        ];
        if (hasAudio) {
            const wav = await GeminiAudioTurn.blobToWavBlob(audioBlob);
            const b64 = GeminiAudioTurn.arrayBufferToBase64(await wav.arrayBuffer());
            turnParts.push({ inlineData: { mimeType: "audio/wav", data: b64 } });
        }
        contents.push({ role: "user", parts: turnParts });

        const result = await GeminiAudioTurn.generateContent({
            baseUrl,
            apiKey,
            model: chatModel,
            contents,
            generationConfig: {
                temperature: Number.isFinite(temperature) ? temperature : 0.3,
                maxOutputTokens: Math.max(256, Number.isFinite(maxTokens) ? Math.round(maxTokens) * 4 : 1024),
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        userTranscript: { type: "STRING" },
                        assistantTranscript: { type: "STRING" }
                    },
                    required: ["userTranscript", "assistantTranscript"]
                },
                thinkingConfig: { thinkingLevel: "minimal" }
            }
        });

        let { userTranscript, assistantTranscript } = GeminiAudioTurn.parseTranscriptsJson(result.text);
        if (!hasAudio && typed) userTranscript = typed;
        userTranscript = String(userTranscript || "").trim();
        assistantTranscript = String(assistantTranscript || "").trim();

        let outBlob = GeminiAudioTurn.audioBlobFromInlineData(GeminiAudioTurn.extractInlineAudioPart(result.json));
        if (!outBlob && assistantTranscript) {
            outBlob = await GeminiAudioTurn.synthesizeSpeech({
                apiKey,
                baseUrl,
                speechModel: ttsModel,
                text: assistantTranscript,
                voice: voiceName
            });
        }
        return { userTranscript, assistantTranscript, audioBlob: outBlob };
    }

    static async transcribeOnly({ apiKey, baseUrl, model, audioBlob }) {
        if (!audioBlob || audioBlob.size < 32) {
            throw new Error("No audio captured for transcription.");
        }
        const wav = await GeminiAudioTurn.blobToWavBlob(audioBlob);
        const b64 = GeminiAudioTurn.arrayBufferToBase64(await wav.arrayBuffer());
        const result = await GeminiAudioTurn.generateContent({
            baseUrl,
            apiKey,
            model: String(model || GeminiAudioTurn.DEFAULT_MODEL).trim(),
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: "Transcribe this audio clip. Return only the spoken words, no quotes or commentary. If there is no speech, return an empty string."
                        },
                        { inlineData: { mimeType: "audio/wav", data: b64 } }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 256,
                thinkingConfig: { thinkingLevel: "minimal" }
            }
        });
        return String(result.text || "").trim();
    }

    static async synthesizeSpeech({ apiKey, baseUrl, speechModel, text, voice }) {
        const input = String(text || "").trim();
        if (!input) throw new Error("Nothing to speak.");
        const voiceName = GeminiAudioTurn.isKnownVoice(voice) ? voice : GeminiAudioTurn.DEFAULT_VOICE;
        const result = await GeminiAudioTurn.generateContent({
            baseUrl,
            apiKey,
            model: String(speechModel || GeminiAudioTurn.DEFAULT_SPEECH_MODEL).trim(),
            contents: [{ role: "user", parts: [{ text: input }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName }
                    }
                }
            }
        });
        const blob = GeminiAudioTurn.audioBlobFromInlineData(GeminiAudioTurn.extractInlineAudioPart(result.json));
        if (!blob || blob.size < 44) {
            throw new Error("Gemini TTS returned empty audio.");
        }
        return blob;
    }

    static openaiContentToParts(content) {
        if (typeof content === "string") return [{ text: content }];
        if (!Array.isArray(content)) return [{ text: String(content ?? "") }];
        const parts = [];
        for (const part of content) {
            if (!part) continue;
            if (typeof part === "string") {
                if (part) parts.push({ text: part });
                continue;
            }
            if (part.type === "text" || part.text != null) {
                const t = String(part.text || "");
                if (t) parts.push({ text: t });
                continue;
            }
            const url = String(part.image_url?.url || part.url || "");
            const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
            if (m) {
                parts.push({ inlineData: { mimeType: m[1], data: m[2].replace(/\s+/g, "") } });
            }
        }
        return parts.length ? parts : [{ text: "" }];
    }

    static chatMessagesToContents(messages) {
        const contents = [];
        for (const m of Array.isArray(messages) ? messages : []) {
            if (!m || m.role === "system") continue;
            const role = m.role === "assistant" || m.role === "model" ? "model" : "user";
            contents.push({ role, parts: GeminiAudioTurn.openaiContentToParts(m.content) });
        }
        return contents;
    }
}

window.GeminiAudioTurn = GeminiAudioTurn;
