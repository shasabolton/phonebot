/**
 * One streamed hold-to-talk turn on the player's own Telnyx key. Browser WebSockets cannot send an
 * Authorization header, so the page hands the key to this Worker, which holds both Telnyx sockets.
 *
 *   page -> {type:"start", key, stt:{provider, model}, sttOptions:[{provider, model}], voice, voiceOptions:[id],
 *           speak} when the player starts talking (the *Options lists are the order to try; without
 *           them only `stt` and `voice` are used),
 *           binary 16 kHz mono 16-bit PCM frames while they talk,
 *           {type:"stop", chat:{models:[{id, thinkingOff}], messages, max_tokens, temperature}, transcriptMarker}
 *           on release (`chat.model` alone is still accepted)
 *   page <- {type:"ready"}, {type:"partial", text}, {type:"transcript", text}, {type:"reply", text},
 *           {type:"audio", audio:<base64 MP3>}, then
 *           {type:"done", model, failedModels, sttModel, failedStt, voice, failedVoices, ...}
 *           or {type:"error", message, failedModels, failedStt, failedVoices}
 *
 * The transcript replaces `transcriptMarker` in the last chat message, as in the hosted voice turn.
 * Speech-to-text models are tried in order: if one fails before the transcript is ready, the next one
 * is sent the whole recording. Chat models are tried in order: the next one is used if one fails
 * before any reply text is spoken.
 */

const TELNYX_BASE = "https://api.telnyx.com/v2";
const INPUT_RATE = 16000;
const MAX_AUDIO_BYTES = INPUT_RATE * 2 * 30;
const MAX_CONTROL_MESSAGE_CHARS = 400_000;
const MAX_TOKENS_CAP = 1024;
const STT_CLOSE_TIMEOUT_MS = 4000;
/** Engines without CloseStream never close on their own; wait this long for a final transcript. */
const STT_FINAL_TIMEOUT_MS = 2000;
const TTS_CLOSE_TIMEOUT_MS = 20000;
const CHAT_TIMEOUT_MS = 30000;
/** A chat model that sends nothing for this long is given up on and the next one tried. */
const CHAT_FIRST_DATA_MS = 10000;
const MAX_CHAT_MODELS = 4;
const MAX_STT_MODELS = 3;
const MAX_VOICES = 3;
const FILE_STT_MODEL = "openai/whisper-large-v3-turbo";
const SENTENCE_END = /[.!?…]["')\]]*\s*$/;
/** Trailing silence lets the streaming recogniser commit a final word that was cut off by letting go. */
const TAIL_SILENCE_BYTES = INPUT_RATE * 2 * 0.3;
/** Mistral tokenizers fail the whole request when given chat_template_kwargs. */
const REJECTS_TEMPLATE_KWARGS = /mistral/i;

/** `transcription_engine` names for the lowercase providers in GET /speech-to-text/providers. */
const STT_ENGINES = {
    deepgram: "Deepgram",
    telnyx: "Telnyx",
    google: "Google",
    azure: "Azure",
    xai: "xAI",
    assemblyai: "AssemblyAI",
    speechmatics: "Speechmatics",
    soniox: "Soniox",
    parakeet: "Parakeet",
    cohere: "Cohere",
    reson8: "Reson8"
};
/** Engines that flush and close on CloseStream; Finalize is Deepgram only. */
const CLOSE_STREAM_ENGINES = new Set(["Deepgram", "Speechmatics", "Soniox"]);
/** The providers list prefixes every model; the WebSocket wants these engines' models bare. */
const BARE_MODEL_ENGINES = new Set(["Deepgram", "Google"]);

export function handleTelnyxStream(request) {
    if (request.headers.get("Upgrade") !== "websocket") throw httpError(426, "Expected a WebSocket upgrade.");
    const { 0: client, 1: server } = new WebSocketPair();
    // Without this, binary frames arrive as Blob and Telnyx receives nothing.
    server.binaryType = "arraybuffer";
    server.accept();
    new TelnyxStreamSession(server);
    return new Response(null, { status: 101, webSocket: client });
}

function streamingStt(stt) {
    const raw = String(stt?.provider || "").trim();
    const provider = raw.toLowerCase();
    const engine = STT_ENGINES[provider] || raw;
    if (!engine) throw httpError(400, "Pick a streaming speech-to-text model.");
    const listed = String(stt?.model || "").trim();
    let model = listed;
    if (BARE_MODEL_ENGINES.has(engine) && model.toLowerCase().startsWith(`${provider}/`)) {
        model = model.slice(provider.length + 1);
    }
    return {
        engine,
        model,
        value: `${raw}|${listed}`,
        finalize: engine === "Deepgram",
        closeStream: CLOSE_STREAM_ENGINES.has(engine)
    };
}

/** Reply text safe to speak so far: drops <think> blocks and holds back a tag that may still be opening one. */
function visibleReply(raw, final) {
    let text = String(raw || "").replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
    const open = text.search(/<think\b/i);
    if (open >= 0) text = text.slice(0, open);
    if (!final) {
        const partial = text.match(/<[a-z]{0,5}$/i);
        if (partial && "<think".startsWith(partial[0].toLowerCase())) text = text.slice(0, partial.index);
    }
    return text;
}

class TelnyxStreamSession {
    constructor(page) {
        this.page = page;
        this.id = crypto.randomUUID().slice(0, 8);
        this.createdAt = Date.now();
        this.recorded = [];
        this.audioBytes = 0;
        this.sttFrames = 0;
        this.finals = [];
        this.interim = "";
        this.rawReply = "";
        this.spoken = "";
        this.reply = "";
        this.timings = {};
        // Handled one at a time so "stop" can never overtake the last audio frames.
        this.inbox = Promise.resolve();
        page.addEventListener("message", (event) => {
            this.inbox = this.inbox.then(() => this.onPageMessage(event)).catch((error) => this.fail(error));
        });
        page.addEventListener("close", () => {
            if (!this.finished) this.reached("page closed");
            this.finished = true;
            this.closeUpstream();
        });
    }

    send(message) {
        try {
            this.page.send(JSON.stringify(message));
        } catch (_) {}
    }

    reached(stage) {
        console.log(JSON.stringify({ event: "telnyx_stream_stage", session: this.id, stage, ms: Date.now() - this.createdAt }));
    }

    fail(error) {
        if (this.finished) return;
        this.finished = true;
        console.error(JSON.stringify({ event: "telnyx_stream_error", session: this.id, message: error?.message }));
        this.send({
            type: "error",
            message: error?.message || String(error),
            reply: this.reply || undefined,
            failedModels: this.failedModels?.length ? this.failedModels : undefined,
            failedStt: this.failedStt?.length ? this.failedStt : undefined,
            failedVoices: this.failedVoices?.length ? this.failedVoices : undefined
        });
        this.closeUpstream();
        try {
            this.page.close(1011, "error");
        } catch (_) {}
    }

    closeUpstream() {
        clearTimeout(this.sttTimer);
        clearTimeout(this.ttsTimer);
        try {
            this.chatAbort?.abort();
        } catch (_) {}
        for (const socket of [this.stt, this.tts]) {
            try {
                socket?.close();
            } catch (_) {}
        }
    }

    async onPageMessage(event) {
        if (this.finished) return;
        if (typeof event.data !== "string") {
            if (this.stopAt) return;
            const frame = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            this.audioBytes += frame.byteLength;
            if (this.audioBytes > MAX_AUDIO_BYTES) throw httpError(413, "Too much audio for one turn.");
            // Everything is kept: a newly connected speech-to-text model is sent the whole recording.
            this.recorded.push(frame);
            if (this.stt && !this.sttClosed) this.stt.send(frame);
            return;
        }
        if (event.data.length > MAX_CONTROL_MESSAGE_CHARS) throw httpError(413, "Message is too large.");
        const message = JSON.parse(event.data);
        if (message.type === "start") await this.start(message);
        else if (message.type === "stop") this.stop(message);
    }

    async start(message) {
        if (this.started) return;
        this.started = true;
        this.apiKey = String(message.key || "").trim();
        if (!this.apiKey) throw httpError(401, "Enter your Telnyx API key.");
        this.sttOptions = (Array.isArray(message.sttOptions) && message.sttOptions.length ? message.sttOptions : [message.stt])
            .filter((s) => String(s?.provider || "").trim())
            .slice(0, MAX_STT_MODELS)
            .map(streamingStt);
        if (!this.sttOptions.length) throw httpError(400, "Pick a streaming speech-to-text model.");
        this.sttAttempt = 0;
        this.failedStt = [];
        this.sttErrors = [];
        this.speak = message.speak !== false;
        this.voiceOptions = (Array.isArray(message.voiceOptions) && message.voiceOptions.length ? message.voiceOptions : [message.voice])
            .map((v) => String(v || "").trim())
            .filter(Boolean)
            .slice(0, MAX_VOICES);
        this.failedVoices = [];
        if (this.speak && !this.voiceOptions.length) throw httpError(400, "Pick a Telnyx voice.");

        const t = Date.now();
        const [stt, tts] = await Promise.allSettled([this.connectStt(), this.speak ? this.connectTts() : Promise.resolve(null)]);
        const failed = [stt, tts].find((result) => result.status === "rejected");
        if (failed || this.finished) {
            for (const result of [stt, tts]) {
                try {
                    result.value?.close();
                } catch (_) {}
            }
            if (failed) throw failed.reason;
            return;
        }
        this.timings.connect = Date.now() - t;
        this.reached(`connected (${this.stream.engine} ${this.stream.model || "default model"})`);

        this.attachStt(stt.value);
        if (tts.value) this.attachSpeech(tts.value);
        this.send({ type: "ready", connectMs: this.timings.connect });
        if (this.stopAt) this.flushTranscript();
    }

    /** Opens the first speech-to-text model that connects, from `sttAttempt` on. */
    async connectStt() {
        while (this.sttAttempt < this.sttOptions.length) {
            const stream = this.sttOptions[this.sttAttempt];
            const query = new URLSearchParams({
                transcription_engine: stream.engine,
                input_format: "linear16",
                sample_rate: String(INPUT_RATE),
                interim_results: "true"
            });
            if (stream.model) query.set("model", stream.model);
            try {
                const socket = await openTelnyxSocket("Telnyx streaming speech-to-text", `speech-to-text/transcription?${query}`, this.apiKey);
                this.stream = stream;
                return socket;
            } catch (error) {
                if (this.finished) throw error;
                this.noteSttFailure(stream, error);
                this.sttAttempt += 1;
            }
        }
        throw httpError(502, `No Telnyx streaming speech-to-text model worked. ${this.sttErrors.join(" | ")}`);
    }

    /** Opens the first voice that connects; speech retries reuse it. */
    async connectTts() {
        const errors = [];
        for (const voice of this.voiceOptions) {
            const path = `text-to-speech/speech?${new URLSearchParams({ voice, audio_format: "mp3", inactivity_timeout: "60" })}`;
            try {
                const socket = await openTelnyxSocket("Telnyx streaming voice", path, this.apiKey);
                this.voice = voice;
                this.ttsPath = path;
                return socket;
            } catch (error) {
                if (this.finished) throw error;
                this.failedVoices.push(voice);
                errors.push(`${voice}: ${error?.message || error}`);
                this.reached(`voice ${voice} failed (${error?.message || error})`);
            }
        }
        throw httpError(502, `No Telnyx voice worked. ${errors.join(" | ")}`);
    }

    noteSttFailure(stream, error) {
        this.failedStt.push(stream.value);
        this.sttErrors.push(`${stream.value}: ${error?.message || error}`);
        this.reached(`speech-to-text ${stream.value} failed (${error?.message || error})`);
    }

    /** Listens to a speech-to-text socket and sends it everything recorded so far. */
    attachStt(socket) {
        this.stt = socket;
        this.sttClosed = false;
        this.sttClose = "";
        socket.addEventListener("message", (event) => {
            if (this.stt === socket) this.onTranscriptFrame(event);
        });
        socket.addEventListener("close", (event) => {
            if (this.stt !== socket) return;
            this.sttClosed = true;
            this.sttClose = `${event.code}${event.reason ? ` ${event.reason}` : ""}`;
            // Closing with an error before hearing anything usually means the model was refused.
            if (!this.stopAt && !this.sttFrames && event.code !== 1000) {
                this.switchStt(httpError(502, `Telnyx streaming speech-to-text closed with code ${this.sttClose}.`));
                return;
            }
            this.transcriptReady("speech-to-text closed");
        });
        for (const frame of this.recorded) socket.send(frame);
    }

    /** The speech-to-text model failed mid-turn: replay the recording into the next one, if any. */
    switchStt(error) {
        if (this.finished || this.chatStarted) return;
        this.noteSttFailure(this.stream, error);
        this.sttAttempt += 1;
        if (this.sttAttempt >= this.sttOptions.length) {
            this.fail(httpError(502, `No Telnyx streaming speech-to-text model worked. ${this.sttErrors.join(" | ")}`));
            return;
        }
        const old = this.stt;
        this.stt = null;
        clearTimeout(this.sttTimer);
        this.finals = [];
        this.interim = "";
        this.lastFinalEndedSpeech = false;
        this.sttFrames = 0;
        this.sttSample = "";
        try {
            old?.close();
        } catch (_) {}
        this.connectStt()
            .then((socket) => {
                if (this.finished) {
                    socket.close();
                    return;
                }
                this.reached(`speech-to-text switched to ${this.stream.value}`);
                this.attachStt(socket);
                if (this.stopAt) this.flushTranscript();
            })
            .catch((e) => this.fail(e));
    }

    stop(message) {
        if (this.stopAt) return;
        this.stopAt = Date.now();
        const chat = message.chat || {};
        const models = (Array.isArray(chat.models) && chat.models.length ? chat.models : [chat.model])
            .map((m) => (m && typeof m === "object" ? m : { id: m }))
            .map((m) => ({
                id: String(m.id || "").trim(),
                thinkingOff: typeof m.thinkingOff === "boolean" ? m.thinkingOff : !REJECTS_TEMPLATE_KWARGS.test(String(m.id || ""))
            }))
            .filter((m) => m.id)
            .slice(0, MAX_CHAT_MODELS);
        if (!models.length) throw httpError(400, "Pick a Telnyx chat model.");
        if (!Array.isArray(chat.messages) || !chat.messages.length) throw httpError(400, "chat.messages is required.");
        this.chat = {
            models,
            messages: chat.messages
                .filter((m) => ["system", "user", "assistant"].includes(m?.role))
                .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
            maxTokens: Math.min(MAX_TOKENS_CAP, Math.max(16, Math.round(Number(chat.max_tokens) || 400))),
            temperature: Number.isFinite(Number(chat.temperature)) ? Number(chat.temperature) : 0.7
        };
        this.transcriptMarker = String(message.transcriptMarker || "");
        this.reached("released");
        if (!this.stt) return;
        this.flushTranscript();
        // Endpointing already finalised everything said before a pause, so there is nothing left to wait for.
        if (this.finals.length && !this.interim && this.lastFinalEndedSpeech) this.transcriptReady("already final at release");
    }

    flushTranscript() {
        try {
            if (this.sttClosed) throw new Error("closed");
            this.stt.send(new ArrayBuffer(TAIL_SILENCE_BYTES));
            if (this.stream.finalize) this.stt.send(JSON.stringify({ type: "Finalize" }));
            if (this.stream.closeStream) this.stt.send(JSON.stringify({ type: "CloseStream" }));
        } catch (_) {
            this.transcriptReady("speech-to-text already closed");
            return;
        }
        const wait = this.stream.closeStream ? STT_CLOSE_TIMEOUT_MS : STT_FINAL_TIMEOUT_MS;
        this.sttTimer = setTimeout(() => this.transcriptReady(`${wait / 1000} s timeout`), wait);
    }

    onTranscriptFrame(event) {
        this.sttFrames += 1;
        const raw = typeof event.data === "string" ? event.data : "";
        if (!this.sttSample && raw) this.sttSample = raw.slice(0, 200);
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            return;
        }
        const error = data.errors?.[0]?.detail || (data.errors && JSON.stringify(data.errors)) || (data.type === "error" && data.error);
        if (error) {
            this.switchStt(httpError(502, `Telnyx streaming speech-to-text error: ${error}`));
            return;
        }
        const text = String(data.transcript ?? data.channel?.alternatives?.[0]?.transcript ?? data.text ?? "").trim();
        if (!text || this.chatStarted) return;
        if (data.is_final ?? data.isFinal) {
            this.finals.push(text);
            this.interim = "";
            this.lastFinalEndedSpeech = data.speech_final === true;
            if (this.stopAt) this.transcriptReady("final after release");
        } else {
            this.interim = text;
        }
        this.send({ type: "partial", text: [...this.finals, this.interim].join(" ").trim() });
    }

    transcriptReady(reason) {
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
                const seconds = (this.audioBytes / (INPUT_RATE * 2)).toFixed(1);
                const closed = this.sttClose ? `the connection closed with code ${this.sttClose}` : "it had not closed in time";
                const sample = this.sttSample ? ` First message: ${this.sttSample}` : "";
                this.fail(httpError(422,
                    `Telnyx heard no speech in ${seconds} s of audio, streamed or as a file. The stream sent ${this.sttFrames} messages and ${closed}.${sample}`
                ));
            })
            .catch((error) => this.fail(error));
    }

    /** The same audio as one WAV file through Telnyx's regular (Whisper) transcription. */
    async transcribeRecording() {
        if (!this.recorded.length) return "";
        const form = new FormData();
        form.append("file", pcmToWav(this.recorded, INPUT_RATE), "speech.wav");
        form.append("model", FILE_STT_MODEL);
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
        this.transcript = transcript;
        this.reached(`transcript ready (${reason})`);
        this.send({ type: "transcript", text: transcript });
        this.runChat().catch((error) => this.fail(error));
    }

    chatBody(model) {
        const messages = this.chat.messages.map((m) => ({ ...m }));
        const last = messages[messages.length - 1];
        if (this.transcriptMarker && last?.role === "user" && last.content.includes(this.transcriptMarker)) {
            last.content = last.content.replace(this.transcriptMarker, () => this.transcript);
        } else {
            messages.push({ role: "user", content: this.transcript });
        }
        const body = {
            model: model.id,
            messages,
            max_tokens: this.chat.maxTokens,
            temperature: this.chat.temperature,
            stream: true
        };
        // Some Telnyx models return empty or cut-off replies with reasoning on.
        if (model.thinkingOff) body.chat_template_kwargs = { enable_thinking: false };
        return body;
    }

    /** Tries each chat model in turn until one replies; a reply that has started being spoken is never switched. */
    async runChat() {
        const t = Date.now();
        this.failedModels = [];
        const failures = [];
        for (const model of this.chat.models) {
            try {
                await this.streamChat(model, t);
                this.chatModel = model.id;
                break;
            } catch (error) {
                if (this.finished || this.spoken) throw error;
                this.failedModels.push(model.id);
                failures.push(`${model.id}: ${error?.message || error}`);
                this.rawReply = "";
                this.reached(`chat model ${model.id} failed (${error?.message || error})`);
            }
        }
        if (this.finished) return;
        if (!this.chatModel) {
            throw httpError(502, `No Telnyx chat model answered. ${failures.join(" | ")}`);
        }
        this.timings.chat = Date.now() - t;
        this.reached(`chat finished (${this.chatModel})`);
        this.send({ type: "reply", text: this.reply });
        if (!this.speak) {
            this.finish();
            return;
        }
        this.speakNew(true);
        this.endSpeech();
    }

    /** One chat request, streamed into the reply and the voice. Throws if the model fails, stalls or says nothing. */
    async streamChat(model, startedAt) {
        this.chatAbort = new AbortController();
        let stalled = false;
        const firstData = setTimeout(() => {
            stalled = true;
            this.chatAbort.abort();
        }, CHAT_FIRST_DATA_MS);
        const watchdog = setTimeout(() => this.chatAbort.abort(), CHAT_TIMEOUT_MS);
        try {
            const response = await fetch(`${TELNYX_BASE}/ai/openai/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify(this.chatBody(model)),
                signal: this.chatAbort.signal
            });
            if (!response.ok) throw await upstreamError(`Telnyx chat (${model.id})`, response);
            await readChatStream(
                response.body,
                (piece) => {
                    if (this.timings.chatFirstToken == null) this.timings.chatFirstToken = Date.now() - startedAt;
                    this.rawReply += piece;
                    this.speakNew(false);
                },
                () => clearTimeout(firstData)
            );
        } catch (error) {
            if (this.finished || !this.chatAbort.signal.aborted) throw error;
            throw httpError(
                504,
                stalled
                    ? `Telnyx chat (${model.id}) sent nothing within ${CHAT_FIRST_DATA_MS / 1000} s.`
                    : `Telnyx chat (${model.id}) did not finish within ${CHAT_TIMEOUT_MS / 1000} s.`
            );
        } finally {
            clearTimeout(firstData);
            clearTimeout(watchdog);
        }
        if (this.finished) return;
        this.reply = visibleReply(this.rawReply, true).trim();
        if (!this.reply) throw httpError(502, `Telnyx chat (${model.id}) returned no text.`);
    }

    /** Sends the voice whatever reply text it has not had yet, starting a sentence as soon as it ends. */
    speakNew(final) {
        if (!this.speak) return;
        const visible = visibleReply(this.rawReply, final);
        if (!visible.startsWith(this.spoken)) return;
        const piece = visible.slice(this.spoken.length);
        if (!piece) return;
        this.spoken = visible;
        if (this.speechStartedAt == null) this.speechStartedAt = Date.now();
        const message = { text: piece };
        // Telnyx waits for more text after punctuation unless told to start speaking the sentence now.
        if (SENTENCE_END.test(piece)) message.flush = true;
        this.sendSpeech(message);
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

    endSpeech() {
        this.chatDone = true;
        this.sendSpeech({ text: "" });
        clearTimeout(this.ttsTimer);
        this.ttsTimer = setTimeout(() => this.speechClosed(), TTS_CLOSE_TIMEOUT_MS);
    }

    /** A socket that has just died is caught by its close event, which retries with everything said so far. */
    sendSpeech(message) {
        try {
            this.tts?.send(JSON.stringify(message));
        } catch (_) {}
    }

    canRetrySpeech() {
        return !this.audioSent && !this.speechRetries && !this.finished;
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
        const socket = await openTelnyxSocket("Telnyx streaming voice (retry)", this.ttsPath, this.apiKey);
        if (this.finished) {
            socket.close();
            return;
        }
        this.attachSpeech(socket);
        if (this.spoken) socket.send(JSON.stringify({ text: this.spoken, flush: true }));
        if (this.chatDone) this.endSpeech();
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
            this.fail(httpError(502, `Telnyx streaming voice error: ${data.error}`));
            return;
        }
        if (!data.audio) return;
        if (!this.audioSent) {
            this.audioSent = true;
            if (this.speechStartedAt != null) this.timings.ttsFirstAudio = Date.now() - this.speechStartedAt;
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
        if (!this.chatDone) {
            const closed = this.ttsClose ? ` with code ${this.ttsClose}` : "";
            this.fail(httpError(502, `Telnyx streaming voice closed${closed} before the reply was spoken.`));
            return;
        }
        if (this.speechStartedAt != null) this.timings.tts = Date.now() - this.speechStartedAt;
        this.finish();
    }

    finish() {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.ttsTimer);
        this.timings.total = this.stopAt ? Date.now() - this.stopAt : null;
        this.reached("done");
        this.send({
            type: "done",
            transcript: this.transcript,
            reply: this.reply,
            model: this.chatModel,
            failedModels: this.failedModels || [],
            sttModel: this.stream?.value,
            failedStt: this.failedStt || [],
            voice: this.voice,
            failedVoices: this.failedVoices || [],
            speechRetries: this.speechRetries || 0,
            timings: this.timings
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
        const hint = response.status === 403 && /text-to-speech/.test(path) ? " Ultra voices cannot stream; pick another voice." : "";
        throw httpError(502, `${label} connection failed (${response.status}): ${detail}${hint}`);
    }
    socket.accept();
    return socket;
}

/**
 * Reads an OpenAI-style SSE chat stream, passing each piece of visible reply text (not reasoning) to
 * onPiece. onData is called for every event, reasoning included, to show the model is working.
 */
async function readChatStream(body, onPiece, onData = () => {}) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
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
            onData();
            let json;
            try {
                json = JSON.parse(data);
            } catch (_) {
                continue;
            }
            if (json?.error) throw httpError(502, `Telnyx chat error: ${json.error.message || JSON.stringify(json.error)}`);
            const piece = json?.choices?.[0]?.delta?.content;
            if (piece) onPiece(piece);
        }
    }
}

async function upstreamError(label, response) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    return httpError(502, `${label} failed (${response.status}): ${detail}`);
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

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
