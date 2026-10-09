/**
 * Voice benchmark: one recorded clip -> speech-to-text -> chat -> text-to-speech on either
 * Telnyx (caller's API key) or Workers AI (passcode-gated), with per-stage timings.
 * The page in ../public is served by the same Worker.
 */

const TELNYX_BASE = "https://api.telnyx.com/v2";
const MAX_AUDIO_BYTES = 10_000_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_TOKENS_CAP = 400;

const DEFAULTS = {
    telnyx: {
        sttModel: "openai/whisper-large-v3-turbo",
        chatModel: "google/gemma-4-26B-A4B-it",
        voice: "Telnyx.Ultra.Clara"
    },
    workersai: {
        sttModel: "@cf/openai/whisper-large-v3-turbo",
        chatModel: "@cf/google/gemma-4-26b-a4b-it",
        ttsModel: "@cf/deepgram/aura-1",
        voice: "angus"
    }
};

const WORKERS_AI_TTS_MODELS = ["@cf/deepgram/aura-1", "@cf/deepgram/aura-2-en", "@cf/myshell-ai/melotts"];

/** Each speech-to-text model wants the audio in a different shape. */
const WORKERS_AI_STT = {
    "@cf/openai/whisper-large-v3-turbo": { model: "@cf/openai/whisper-large-v3-turbo", input: "base64" },
    "@cf/openai/whisper-large-v3-turbo#fast": {
        model: "@cf/openai/whisper-large-v3-turbo",
        input: "base64",
        options: { beam_size: 1 }
    },
    "@cf/deepgram/nova-3": {
        model: "@cf/deepgram/nova-3",
        input: "stream",
        options: { smart_format: true, punctuate: true, language: "en" }
    },
    "@cf/openai/whisper": { model: "@cf/openai/whisper", input: "bytes" },
    "@cf/openai/whisper-tiny-en": { model: "@cf/openai/whisper-tiny-en", input: "bytes" }
};

const TELNYX_VOICE_PROVIDERS = ["telnyx", "minimax", "aws", "azure", "xai", "soniox"];

/** Model lists include speech, embedding, guard, LoRA-base and decision models that cannot hold a conversation. */
const NOT_CHAT_MODEL = /whisper|nova-|embed|rerank|guard|tts|aura|melotts|bge-|-lora$|\/clef/i;

/** Mistral tokenizers fail the whole request when given chat_template_kwargs. */
const REJECTS_TEMPLATE_KWARGS = /mistral/i;

/** Streaming engines that flush and close on CloseStream, so the transcript is ready right after release. */
const TELNYX_STREAM_STT = {
    "deepgram-nova-3": { engine: "Deepgram", model: "nova-3", finalize: true },
    "deepgram-flux": { engine: "Deepgram", model: "flux", finalize: true },
    "deepgram-nova-2": { engine: "Deepgram", model: "nova-2", finalize: true },
    speechmatics: { engine: "Speechmatics", model: "speechmatics/standard" },
    soniox: { engine: "Soniox", model: "soniox/stt-rt-v4" }
};
const STREAM_INPUT_RATE = 16000;
const STREAM_OUTPUT_RATE = 24000;
const STREAM_STT_CLOSE_TIMEOUT_MS = 4000;
const STREAM_TTS_CLOSE_TIMEOUT_MS = 20000;
const STREAM_CHAT_TIMEOUT_MS = 20000;
const SENTENCE_END = /[.!?…]["')\]]*\s*$/;
/** Trailing silence lets the streaming recogniser commit a final word that was cut off by letting go. */
const STREAM_TAIL_SILENCE_BYTES = STREAM_INPUT_RATE * 2 * 0.3;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        let handler = null;
        if (url.pathname === "/api/turn" && request.method === "POST") handler = () => handleTurn(request, env);
        if (url.pathname === "/api/telnyx-voices" && request.method === "GET") handler = () => handleTelnyxVoices(request, url);
        if (url.pathname === "/api/telnyx-models" && request.method === "GET") handler = () => handleTelnyxModels(request);
        if (url.pathname === "/api/workersai-models" && request.method === "GET") handler = () => handleWorkersAiModels(request, env);
        if (url.pathname === "/api/telnyx-stream" && request.method === "GET") handler = () => handleTelnyxStream(request);
        if (url.pathname === "/api/voice-design" && request.method === "POST") handler = () => handleVoiceDesign(request);
        if (url.pathname === "/api/voice-clone" && request.method === "POST") handler = () => handleVoiceClone(request);
        if (!handler) return new Response("Not found", { status: 404 });
        try {
            return await handler();
        } catch (error) {
            const status = Number(error?.status) || 500;
            console.error(JSON.stringify({ event: "request_error", path: url.pathname, status, message: error?.message }));
            return Response.json({ error: error?.message || "Internal error" }, { status });
        }
    }
};

async function handleTelnyxVoices(request, url) {
    const apiKey = String(request.headers.get("X-Telnyx-Key") || "").trim();
    if (!apiKey) throw httpError(401, "Enter your Telnyx API key.");
    const provider = String(url.searchParams.get("provider") || "telnyx");
    if (!TELNYX_VOICE_PROVIDERS.includes(provider)) throw httpError(400, "Unknown voice provider.");
    const response = await fetch(`${TELNYX_BASE}/text-to-speech/voices?provider=${provider}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) throw await upstreamError("Telnyx voice list", response);
    const payload = await response.json();
    const voices = voiceEntries(payload)
        .map((v) => {
            const id = typeof v === "string" ? v : v?.voice_id || v?.voice || v?.id || v?.name;
            if (!id) return null;
            return {
                id: String(id),
                name: String(v?.name || id),
                language: String(v?.language || v?.language_code || ""),
                gender: String(v?.gender || "")
            };
        })
        .filter(Boolean);
    if (!voices.length) {
        const sample = JSON.stringify(payload).slice(0, 600);
        console.log(JSON.stringify({ event: "telnyx_voices_unrecognised", provider, sample }));
        return Response.json({ voices, sample });
    }
    return Response.json({ voices });
}

function telnyxKeyAuth(request) {
    const apiKey = String(request.headers.get("X-Telnyx-Key") || "").trim();
    if (!apiKey) throw httpError(401, "Enter your Telnyx API key.");
    return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Voice Design step 1: a typed description becomes a draft voice and a spoken sample. Passing the current design's id
 * adds a new version to it instead of starting another design.
 */
async function handleVoiceDesign(request) {
    const auth = telnyxKeyAuth(request);
    const body = await request.json().catch(() => ({}));
    const prompt = String(body.prompt || "").trim().slice(0, 2000);
    const text = String(body.text || "").trim().slice(0, 500);
    if (!prompt) throw httpError(400, "Type a description of the voice.");
    if (!text) throw httpError(400, "Type a sample sentence for the voice to read.");
    const provider = body.provider === "minimax" ? "minimax" : "telnyx";
    const design = { prompt, text, language: "English", provider };
    if (body.voiceDesignId) design.voice_design_id = String(body.voiceDesignId);
    else design.name = `bench ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const created = await fetch(`${TELNYX_BASE}/voice_designs`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(design)
    });
    if (!created.ok) throw await upstreamError("Telnyx voice design", created);
    const data = (await created.json())?.data || {};
    const sample = await fetch(`${TELNYX_BASE}/voice_designs/${encodeURIComponent(data.id)}/sample?version=${data.version}`, { headers: auth });
    if (!sample.ok) throw await upstreamError("Telnyx voice design sample", sample);
    return Response.json({
        id: data.id,
        version: data.version,
        provider,
        sampleBase64: bytesToBase64(new Uint8Array(await sample.arrayBuffer())),
        sampleType: sample.headers.get("Content-Type") || "audio/wav"
    });
}

/** Voice Design step 2: saves one version as a voice clone, whose ID works for both plain and streaming speech. */
async function handleVoiceClone(request) {
    const auth = telnyxKeyAuth(request);
    const body = await request.json().catch(() => ({}));
    if (!body.voiceDesignId) throw httpError(400, "Generate a sample first.");
    const provider = body.provider === "minimax" ? "minimax" : "telnyx";
    const clone = {
        name: String(body.name || "").trim().slice(0, 255) || `bench voice ${new Date().toISOString().slice(0, 16)}`,
        voice_design_id: String(body.voiceDesignId),
        language: "en",
        gender: ["male", "female", "neutral"].includes(body.gender) ? body.gender : "neutral",
        provider
    };
    if (body.version) clone.version = Number(body.version);
    const response = await fetch(`${TELNYX_BASE}/voice_clones`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(clone)
    });
    if (!response.ok) throw await upstreamError("Telnyx voice clone", response);
    const data = (await response.json())?.data || {};
    const model = data.model_id || data.provider_supported_models?.[0] || (provider === "minimax" ? "speech-2.8-turbo" : "Qwen3TTS");
    const voiceId = `${provider === "minimax" ? "Minimax" : "Telnyx"}.${model}.${data.provider_voice_id || data.id}`;
    return Response.json({ voiceId, name: data.name || clone.name, status: data.status || "" });
}

async function handleTelnyxModels(request) {
    const apiKey = String(request.headers.get("X-Telnyx-Key") || "").trim();
    if (!apiKey) throw httpError(401, "Enter your Telnyx API key.");
    const response = await fetch(`${TELNYX_BASE}/ai/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw await upstreamError("Telnyx model list", response);
    const payload = await response.json();
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const models = list
        .map((m) => (typeof m === "string" ? m : m?.id || m?.name))
        .filter((id) => id && !NOT_CHAT_MODEL.test(id))
        .map((id) => ({ id: String(id), note: "" }))
        .sort((a, b) => a.id.localeCompare(b.id));
    return Response.json({ models });
}

async function handleWorkersAiModels(request, env) {
    await requirePasscode(request, env);
    const list = await labelled("Workers AI model list", () => env.AI.models({ task: "Text Generation", per_page: 200 }));
    const models = (Array.isArray(list) ? list : [])
        .map((m) => ({ id: String(m?.name || ""), note: String(m?.description || "").slice(0, 90) }))
        .filter((m) => m.id && !NOT_CHAT_MODEL.test(m.id))
        .sort((a, b) => a.id.localeCompare(b.id));
    return Response.json({ models });
}

/** Telnyx documents `{ voices: [...] }`; also accept `data` wrappers and per-provider groupings. */
function voiceEntries(payload) {
    const list = payload?.voices ?? payload?.data ?? payload;
    if (Array.isArray(list)) return list;
    if (list && typeof list === "object") {
        return Object.values(list).flatMap((value) => (Array.isArray(value) ? value : []));
    }
    return [];
}

async function handleTurn(request, env) {
    const form = await request.formData();
    const provider = String(form.get("provider") || "");
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size < 100) throw httpError(400, "Audio is required.");
    if (audio.size > MAX_AUDIO_BYTES) throw httpError(413, "Audio is too long.");

    const startedAt = Date.now();
    let result;
    if (provider === "telnyx") {
        const apiKey = String(request.headers.get("X-Telnyx-Key") || "").trim();
        if (!apiKey) throw httpError(401, "Enter your Telnyx API key.");
        result = await runTelnyxTurn(apiKey, audio, readSettings(form, DEFAULTS.telnyx));
    } else if (provider === "workersai") {
        await requirePasscode(request, env);
        result = await runWorkersAiTurn(env, audio, readSettings(form, DEFAULTS.workersai));
    } else {
        throw httpError(400, "Unknown provider.");
    }
    result.timings.workerTotal = Date.now() - startedAt;
    return Response.json(result);
}

function readSettings(form, defaults) {
    const text = (name, max = 200) => String(form.get(name) || "").trim().slice(0, max);
    let history = [];
    try {
        history = JSON.parse(String(form.get("history") || "[]"));
    } catch (_) {}
    const maxTokens = Math.round(Number(form.get("maxTokens")) || 120);
    return {
        systemPrompt: text("systemPrompt", 4000),
        history: (Array.isArray(history) ? history : [])
            .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
            .slice(-MAX_HISTORY_MESSAGES)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
        sttModel: text("sttModel") || defaults.sttModel,
        chatModel: text("chatModel") || defaults.chatModel,
        ttsModel: text("ttsModel") || defaults.ttsModel,
        voice: text("voice") || defaults.voice,
        maxTokens: Math.min(MAX_TOKENS_CAP, Math.max(16, maxTokens)),
        thinkingOff: form.get("thinkingOff") === "true"
    };
}

function chatMessages(settings, transcript) {
    const messages = [];
    if (settings.systemPrompt) messages.push({ role: "system", content: settings.systemPrompt });
    return [...messages, ...settings.history, { role: "user", content: transcript }];
}

function chatOptions(settings, transcript) {
    const body = {
        messages: chatMessages(settings, transcript),
        max_tokens: settings.maxTokens,
        temperature: 0.7,
        stream: true
    };
    if (settings.thinkingOff && !REJECTS_TEMPLATE_KWARGS.test(settings.chatModel)) {
        body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
}

async function runTelnyxTurn(apiKey, audio, settings) {
    const timings = {};
    const auth = { Authorization: `Bearer ${apiKey}` };

    let t = Date.now();
    const sttForm = new FormData();
    sttForm.append("file", audio, "speech.wav");
    sttForm.append("model", settings.sttModel);
    const sttResponse = await fetch(`${TELNYX_BASE}/ai/audio/transcriptions`, {
        method: "POST",
        headers: auth,
        body: sttForm
    });
    if (!sttResponse.ok) throw await upstreamError("Telnyx speech-to-text", sttResponse);
    const transcript = String((await sttResponse.json())?.text || "").trim();
    timings.stt = Date.now() - t;
    if (!transcript) throw httpError(422, "Telnyx heard no speech.");

    t = Date.now();
    const chatResponse = await fetch(`${TELNYX_BASE}/ai/openai/chat/completions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ model: settings.chatModel, ...chatOptions(settings, transcript) })
    });
    if (!chatResponse.ok) throw await upstreamError("Telnyx chat", chatResponse);
    const chat = await readChat(chatResponse.body, t);
    timings.chatFirstToken = chat.firstTokenMs;
    timings.chat = Date.now() - t;
    if (!chat.text) throw httpError(502, "Telnyx chat returned no text.");

    t = Date.now();
    const { response: ttsResponse, retries: speechRetries } = await fetchTelnyxSpeech(auth, chat.text, settings.voice);
    const speech = await readAudio(ttsResponse.body, t);
    timings.ttsFirstByte = speech.firstByteMs;
    timings.tts = Date.now() - t;

    return {
        transcript,
        reply: chat.text,
        reasoningChars: chat.reasoningChars,
        speechRetries,
        audioBase64: bytesToBase64(speech.bytes),
        audioType: ttsResponse.headers.get("Content-Type") || "audio/mpeg",
        timings
    };
}

/** Retries once on Telnyx's generic synthesis failure (90103 / 5xx); the retry counts toward the speech timing. */
async function fetchTelnyxSpeech(auth, text, voice) {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${TELNYX_BASE}/text-to-speech/speech`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({ text, voice })
        });
        if (response.ok) return { response, retries: attempt };
        lastError = `(${response.status}): ${(await response.text().catch(() => "")).slice(0, 400)}`;
        if (response.status < 500 && !lastError.includes("90103")) break;
    }
    console.error(JSON.stringify({ event: "telnyx_tts_failed", voice, text, error: lastError }));
    throw httpError(502, `Telnyx text-to-speech failed ${lastError} Reply text was: "${text}"`);
}

/**
 * One streamed turn over a WebSocket from the page:
 *   page -> {type:"start", key, settings}, binary 16 kHz PCM frames while talking, {type:"stop"} on release
 *   page <- {type:"ready"}, {type:"partial"}, {type:"transcript"}, {type:"audio"} (24 kHz PCM, base64), {type:"done"} or {type:"error"}
 */
function handleTelnyxStream(request) {
    if (request.headers.get("Upgrade") !== "websocket") throw httpError(426, "Expected a WebSocket upgrade.");
    const { 0: client, 1: server } = new WebSocketPair();
    server.binaryType = "arraybuffer";
    server.accept();
    new TelnyxStreamSession(server);
    return new Response(null, { status: 101, webSocket: client });
}

class TelnyxStreamSession {
    constructor(page) {
        this.page = page;
        this.pendingAudio = [];
        this.recorded = [];
        this.finals = [];
        this.interim = "";
        this.reply = "";
        this.timings = {};
        this.audioBytes = 0;
        this.sttFrames = 0;
        this.sttSample = "";
        this.createdAt = Date.now();
        this.id = crypto.randomUUID().slice(0, 4);
        this.marks = {};
        this.stage = "connecting";
        // Handled one at a time so "stop" can never overtake the last audio frames.
        this.inbox = Promise.resolve();
        page.addEventListener("message", (event) => {
            this.inbox = this.inbox.then(() => this.onPageMessage(event)).catch((error) => this.fail(error));
        });
        page.addEventListener("close", () => this.closeUpstream());
    }

    send(message) {
        try {
            this.page.send(JSON.stringify(message));
        } catch (_) {}
    }

    /** Milliseconds since the page opened this session, which the page lines up with its own clock for the timeline. */
    mark(name, at = Date.now()) {
        this.marks[name] ??= at - this.createdAt;
    }

    reached(stage) {
        this.stage = stage;
        console.log(JSON.stringify({ event: "telnyx_stream_stage", session: this.id, stage, ms: Date.now() - this.createdAt }));
    }

    fail(error) {
        if (this.finished) return;
        this.finished = true;
        console.error(JSON.stringify({ event: "telnyx_stream_error", session: this.id, message: error?.message }));
        this.send({ type: "error", message: error?.message || String(error) });
        this.closeUpstream();
        try {
            this.page.close(1011, "error");
        } catch (_) {}
    }

    closeUpstream() {
        clearTimeout(this.sttTimer);
        clearTimeout(this.ttsTimer);
        for (const socket of [this.stt, this.tts]) {
            try {
                socket?.close();
            } catch (_) {}
        }
    }

    async onPageMessage(event) {
        if (typeof event.data !== "string") {
            if (this.stopAt) return;
            const frame = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            this.audioBytes += frame.byteLength;
            if (this.audioBytes <= MAX_AUDIO_BYTES) this.recorded.push(frame);
            if (this.stt) this.stt.send(frame);
            else this.pendingAudio.push(frame);
            return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "start") await this.start(message);
        else if (message.type === "stop") this.stop();
    }

    async start(message) {
        if (this.started) return;
        this.started = true;
        const apiKey = String(message.key || "").trim();
        if (!apiKey) throw httpError(401, "Enter your Telnyx API key.");
        const raw = message.settings || {};
        this.settings = readSettings({ get: (name) => (raw[name] == null ? null : String(raw[name])) }, DEFAULTS.telnyx);
        this.stream = TELNYX_STREAM_STT[this.settings.sttModel];
        if (!this.stream) throw httpError(400, "Unknown Telnyx streaming speech-to-text engine.");
        this.apiKey = apiKey;

        const sttQuery = new URLSearchParams({
            transcription_engine: this.stream.engine,
            model: this.stream.model,
            input_format: "linear16",
            sample_rate: String(STREAM_INPUT_RATE),
            interim_results: "true"
        });
        const ttsQuery = new URLSearchParams({ voice: this.settings.voice, audio_format: "mp3", inactivity_timeout: "60" });
        this.ttsPath = `text-to-speech/speech?${ttsQuery}`;
        const t = Date.now();
        const [stt, tts] = await Promise.all([
            openTelnyxSocket("Telnyx streaming speech-to-text", `speech-to-text/transcription?${sttQuery}`, apiKey),
            openTelnyxSocket("Telnyx streaming text-to-speech", this.ttsPath, apiKey)
        ]);
        this.timings.connect = Date.now() - t;
        this.mark("connected");
        this.reached("connected");
        this.stt = stt;
        stt.addEventListener("message", (event) => this.onTranscriptFrame(event));
        stt.addEventListener("close", (event) => {
            this.sttClosed = true;
            this.sttClose = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
            this.reached(`speech-to-text closed (${this.sttClose})`);
            this.transcriptReady();
        });
        this.attachSpeech(tts);
        for (const frame of this.pendingAudio) stt.send(frame);
        this.pendingAudio = [];
        this.send({ type: "ready", connectMs: this.timings.connect });
        if (this.stopAt) this.flushTranscript();
    }

    /** Events from a replaced (retried) speech socket are ignored. */
    attachSpeech(socket) {
        this.tts = socket;
        socket.addEventListener("message", (event) => {
            if (socket === this.tts) this.onSpeechFrame(event);
        });
        socket.addEventListener("close", (event) => {
            if (socket !== this.tts) return;
            this.ttsClose = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
            this.speechClosed();
        });
        socket.send(JSON.stringify({ text: " " }));
    }

    speakPiece(piece) {
        this.spokenText = (this.spokenText || "") + piece;
        if (this.speechStartedAt == null) {
            this.speechStartedAt = Date.now();
            this.mark("speechStart", this.speechStartedAt);
            this.reached("first reply words sent to the voice");
        }
        const message = { text: piece };
        // Telnyx waits for more text after punctuation unless told to start speaking the sentence now.
        if (SENTENCE_END.test(piece)) message.flush = true;
        this.sendSpeech(message);
    }

    endSpeech() {
        this.chatDone = true;
        this.sendSpeech({ text: "" });
        this.ttsTimer = setTimeout(() => this.speechClosed(), STREAM_TTS_CLOSE_TIMEOUT_MS);
    }

    /** A socket that has just died is caught by its close event, which retries with everything said so far. */
    sendSpeech(message) {
        try {
            this.tts?.send(JSON.stringify(message));
        } catch (_) {}
    }

    /** One retry when the voice fails before any audio; the new socket gets everything said so far. */
    async retrySpeech(reason) {
        this.speechRetries = 1;
        this.reached(`voice failed (${reason}), retrying`);
        clearTimeout(this.ttsTimer);
        const old = this.tts;
        this.tts = null;
        try {
            old?.close();
        } catch (_) {}
        const socket = await openTelnyxSocket("Telnyx streaming text-to-speech (retry)", this.ttsPath, this.apiKey);
        if (this.finished) {
            socket.close();
            return;
        }
        this.attachSpeech(socket);
        if (this.spokenText) socket.send(JSON.stringify({ text: this.spokenText, flush: true }));
        if (this.chatDone) this.endSpeech();
    }

    canRetrySpeech() {
        return !this.audioSent && !this.speechRetries && !this.finished;
    }

    stop() {
        if (this.stopAt) return;
        this.stopAt = Date.now();
        this.reached("released");
        if (!this.stt) return;
        this.flushTranscript();
        // Endpointing already finalised everything said before a pause, so there is nothing left to wait for.
        if (this.finals.length && !this.interim && this.lastFinalEndedSpeech) this.transcriptReady("already final at release");
    }

    flushTranscript() {
        try {
            if (this.sttClosed) throw new Error("closed");
            this.stt.send(new ArrayBuffer(STREAM_TAIL_SILENCE_BYTES));
            if (this.stream.finalize) this.stt.send(JSON.stringify({ type: "Finalize" }));
            this.stt.send(JSON.stringify({ type: "CloseStream" }));
        } catch (_) {
            this.transcriptReady();
            return;
        }
        this.sttTimer = setTimeout(() => this.transcriptReady("4 s timeout"), STREAM_STT_CLOSE_TIMEOUT_MS);
    }

    onTranscriptFrame(event) {
        this.sttFrames += 1;
        const raw = typeof event.data === "string" ? event.data : `(binary ${event.data?.byteLength} bytes)`;
        if (this.sttFrames <= 3) console.log(JSON.stringify({ event: "telnyx_stt_frame", session: this.id, frame: raw.slice(0, 300) }));
        if (!this.sttSample) this.sttSample = raw.slice(0, 200);
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (data.errors) {
            this.fail(httpError(502, `Telnyx streaming speech-to-text error: ${data.errors[0]?.detail || JSON.stringify(data.errors)}`));
            return;
        }
        const text = String(data.transcript ?? data.channel?.alternatives?.[0]?.transcript ?? data.text ?? "").trim();
        if (!text) return;
        if (this.chatStarted) {
            this.reached(`late transcript ignored: ${text}`);
            return;
        }
        if (data.is_final ?? data.isFinal) {
            this.finals.push(text);
            this.interim = "";
            this.lastFinalEndedSpeech = data.speech_final === true;
            if (this.stopAt) {
                this.timings.sttLastFinal = Date.now() - this.stopAt;
                this.transcriptReady("final after release");
            }
        } else {
            this.interim = text;
        }
        this.send({ type: "partial", text: [...this.finals, this.interim].join(" ").trim() });
    }

    transcriptReady(reason = "speech-to-text closed") {
        if (this.chatStarted || this.finished || !this.stopAt) return;
        this.chatStarted = true;
        clearTimeout(this.sttTimer);
        const transcript = [...this.finals, this.interim].join(" ").trim();
        if (transcript) {
            this.beginReply(transcript, reason);
            return;
        }
        this.reached("stream heard nothing, trying file transcription");
        this.transcribeRecording()
            .then((text) => {
                if (this.finished) return;
                if (text) {
                    this.timings.sttFallback = true;
                    this.beginReply(text, "file transcription");
                    return;
                }
                const seconds = (this.audioBytes / (STREAM_INPUT_RATE * 2)).toFixed(1);
                const closed = this.sttClose ? `the connection closed with code ${this.sttClose}` : "it had not closed after 4 s";
                const sample = this.sttSample ? ` First message: ${this.sttSample}` : "";
                this.fail(httpError(422,
                    `Telnyx heard no speech in ${seconds} s of audio, streamed or as a file. The stream sent ${this.sttFrames} messages and ${closed}.${sample}`
                ));
            })
            .catch((error) => this.fail(error));
    }

    /** The same audio as one WAV file through Telnyx's regular (Whisper) transcription. */
    async transcribeRecording() {
        const form = new FormData();
        form.append("file", pcmToWav(this.recorded, STREAM_INPUT_RATE), "speech.wav");
        form.append("model", DEFAULTS.telnyx.sttModel);
        const response = await fetch(`${TELNYX_BASE}/ai/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}` },
            body: form
        });
        if (!response.ok) throw await upstreamError("Telnyx file speech-to-text (after the stream heard nothing)", response);
        return String((await response.json())?.text || "").trim();
    }

    beginReply(transcript, reason) {
        this.timings.stt = Date.now() - this.stopAt;
        this.mark("transcript");
        this.transcript = transcript;
        this.reached(`transcript ready (${reason})`);
        this.send({ type: "transcript", text: transcript });
        this.runChat().catch((error) => this.fail(error));
    }

    async runChat() {
        const t = Date.now();
        const abort = new AbortController();
        const watchdog = setTimeout(() => abort.abort(), STREAM_CHAT_TIMEOUT_MS);
        let chat;
        try {
            const response = await fetch(`${TELNYX_BASE}/ai/openai/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: this.settings.chatModel, ...chatOptions(this.settings, this.transcript) }),
                signal: abort.signal
            });
            this.reached(`chat responded (${response.status})`);
            if (!response.ok) throw await upstreamError("Telnyx chat", response);
            chat = await readChat(response.body, t, (piece) => this.speakPiece(piece));
        } catch (error) {
            if (!abort.signal.aborted) throw error;
            throw httpError(504, `Telnyx chat (${this.settings.chatModel}) did not finish within ${STREAM_CHAT_TIMEOUT_MS / 1000} s (last step reached: ${this.stage}).`);
        } finally {
            clearTimeout(watchdog);
        }
        this.reached("chat finished");
        this.mark("chatDone");
        if (chat.firstTokenMs != null) this.mark("chatFirstToken", t + chat.firstTokenMs);
        this.timings.chatFirstToken = chat.firstTokenMs;
        this.timings.chat = Date.now() - t;
        this.reasoningChars = chat.reasoningChars;
        if (!chat.text) throw httpError(502, "Telnyx chat returned no text.");
        this.reply = chat.text;
        this.endSpeech();
    }

    onSpeechFrame(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (_) {
            return;
        }
        if (data.error) {
            if (this.canRetrySpeech()) {
                this.retrySpeech(data.error).catch((error) => this.fail(error));
                return;
            }
            this.fail(httpError(502, `Telnyx streaming text-to-speech error: ${data.error}. Reply text was: "${this.reply || this.spokenText || ""}"`));
            return;
        }
        if (!data.audio) return;
        this.audioSent = true;
        this.mark("firstAudio");
        if (this.timings.ttsFirstByte == null && this.speechStartedAt != null) {
            this.timings.ttsFirstByte = Date.now() - this.speechStartedAt;
            this.reached("first reply audio");
        }
        this.send({ type: "audio", audio: data.audio });
    }

    speechClosed() {
        if (this.finished) return;
        if (this.canRetrySpeech()) {
            this.retrySpeech(`closed${this.ttsClose ? ` with code ${this.ttsClose}` : ""} before any audio`).catch((error) => this.fail(error));
            return;
        }
        if (!this.reply) {
            const closed = this.ttsClose ? ` with code ${this.ttsClose}` : "";
            this.fail(httpError(502, `Telnyx streaming text-to-speech closed${closed} before the reply was spoken (last step reached: ${this.stage}).`));
            return;
        }
        this.finished = true;
        clearTimeout(this.ttsTimer);
        if (this.speechStartedAt != null) this.timings.tts = Date.now() - this.speechStartedAt;
        this.mark("speechEnd");
        this.send({
            type: "done",
            transcript: this.transcript,
            reply: this.reply,
            reasoningChars: this.reasoningChars,
            speechRetries: this.speechRetries || 0,
            audioRate: STREAM_OUTPUT_RATE,
            timings: this.timings,
            marks: this.marks
        });
        this.closeUpstream();
        try {
            this.page.close(1000, "done");
        } catch (_) {}
    }
}

async function openTelnyxSocket(label, path, apiKey) {
    const response = await fetch(`${TELNYX_BASE}/${path}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${apiKey}` }
    });
    const socket = response.webSocket;
    if (!socket) {
        const detail = (await response.text().catch(() => "")).slice(0, 400);
        const hint = response.status === 403 && /text-to-speech/.test(path) ? " Ultra voices cannot stream; pick a Kokoro or Qwen3 voice." : "";
        throw httpError(502, `${label} connection failed (${response.status}): ${detail}${hint}`);
    }
    socket.accept();
    return socket;
}

async function runWorkersAiTurn(env, audio, settings) {
    const timings = {};
    if (!WORKERS_AI_TTS_MODELS.includes(settings.ttsModel)) throw httpError(400, "Unknown Workers AI speech model.");

    const stt = WORKERS_AI_STT[settings.sttModel];
    if (!stt) throw httpError(400, "Unknown Workers AI speech-to-text model.");

    // Audio is converted before the timer so only the model call is measured.
    const bytes = new Uint8Array(await audio.arrayBuffer());
    let audioInput;
    if (stt.input === "base64") audioInput = bytesToBase64(bytes);
    else if (stt.input === "bytes") audioInput = Array.from(bytes);
    else audioInput = { body: new Response(bytes).body, contentType: "audio/wav" };

    let t = Date.now();
    const sttResult = await labelled("Workers AI speech-to-text", () =>
        env.AI.run(stt.model, { audio: audioInput, ...stt.options })
    );
    const transcript = String(
        sttResult?.text ?? sttResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
    ).trim();
    timings.stt = Date.now() - t;
    if (!transcript) throw httpError(422, "Workers AI heard no speech.");

    t = Date.now();
    const chatResult = await labelled("Workers AI chat", () =>
        env.AI.run(settings.chatModel, chatOptions(settings, transcript))
    );
    const chat = await readChat(chatResult, t);
    timings.chatFirstToken = chat.firstTokenMs;
    timings.chat = Date.now() - t;
    if (!chat.text) throw httpError(502, "Workers AI chat returned no text.");

    t = Date.now();
    const speech = await labelled("Workers AI text-to-speech", () => runWorkersAiSpeech(env, settings, chat.text, t));
    timings.ttsFirstByte = speech.firstByteMs;
    timings.tts = Date.now() - t;

    return {
        transcript,
        reply: chat.text,
        reasoningChars: chat.reasoningChars,
        audioBase64: bytesToBase64(speech.bytes),
        audioType: "audio/mpeg",
        timings
    };
}

async function runWorkersAiSpeech(env, settings, text, startedAt) {
    if (settings.ttsModel === "@cf/myshell-ai/melotts") {
        const out = await env.AI.run(settings.ttsModel, { prompt: text, lang: "en" });
        if (typeof out?.audio === "string") {
            return { bytes: base64ToBytes(out.audio), firstByteMs: Date.now() - startedAt };
        }
        return readAudio(out, startedAt);
    }
    const response = await env.AI.run(
        settings.ttsModel,
        { text, speaker: settings.voice, encoding: "mp3" },
        { returnRawResponse: true }
    );
    if (!response.ok) throw await upstreamError("Workers AI text-to-speech", response);
    return readAudio(response.body, startedAt);
}

/**
 * Reads an OpenAI-style SSE chat stream (or a non-streamed result object).
 * firstTokenMs is when the first visible reply text arrived, after any reasoning.
 */
async function readChat(source, startedAt, onPiece = null) {
    let text = "";
    let reasoningChars = 0;
    let firstTokenMs = null;
    const take = (json) => {
        const choice = json?.choices?.[0];
        const delta = choice?.delta || choice?.message || {};
        const piece = delta.content ?? json?.response ?? "";
        const reasoning = delta.reasoning_content || delta.reasoning || "";
        reasoningChars += reasoning.length;
        if (piece) {
            if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
            text += piece;
            onPiece?.(piece);
        }
    };

    if (!(source instanceof ReadableStream)) {
        take(source);
        return { text: text.trim(), reasoningChars, firstTokenMs };
    }

    const reader = source.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
                take(JSON.parse(data));
            } catch (_) {}
        }
    }
    return { text: text.trim(), reasoningChars, firstTokenMs };
}

async function readAudio(source, startedAt) {
    if (source instanceof ArrayBuffer) {
        return { bytes: new Uint8Array(source), firstByteMs: Date.now() - startedAt };
    }
    if (ArrayBuffer.isView(source)) {
        return {
            bytes: new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
            firstByteMs: Date.now() - startedAt
        };
    }
    if (!(source instanceof ReadableStream)) throw httpError(502, "Speech response had no audio.");
    const reader = source.getReader();
    const chunks = [];
    let total = 0;
    let firstByteMs = null;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        if (firstByteMs == null) firstByteMs = Date.now() - startedAt;
        chunks.push(value);
        total += value.length;
    }
    if (!total) throw httpError(502, "Speech response had no audio.");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return { bytes, firstByteMs };
}

async function requirePasscode(request, env) {
    const expected = String(env.BENCH_PASSCODE || "");
    if (!expected) throw httpError(503, "Set BENCH_PASSCODE in voice-bench/.dev.vars to enable Workers AI.");
    const given = String(request.headers.get("X-Bench-Passcode") || "");
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(given)),
        crypto.subtle.digest("SHA-256", encoder.encode(expected))
    ]);
    if (!crypto.subtle.timingSafeEqual(a, b)) throw httpError(401, "Wrong Workers AI passcode.");
}

async function labelled(label, run) {
    try {
        return await run();
    } catch (error) {
        if (error?.status) throw error;
        throw httpError(502, `${label} failed: ${error?.message || error}`);
    }
}

async function upstreamError(label, response) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    return httpError(502, `${label} failed (${response.status}): ${detail}`);
}

function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

/** 16-bit mono PCM frames to a WAV file. */
function pcmToWav(frames, rate) {
    const dataBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    const header = new DataView(new ArrayBuffer(44));
    const writeText = (offset, text) => {
        for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, "RIFF");
    header.setUint32(4, 36 + dataBytes, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, rate, true);
    header.setUint32(28, rate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    writeText(36, "data");
    header.setUint32(40, dataBytes, true);
    return new Blob([header, ...frames], { type: "audio/wav" });
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
