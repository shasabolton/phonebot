(() => {
    const PROVIDERS = ["telnyx", "telnyxstream", "workersai"];
    const LABELS = { telnyx: "Telnyx", telnyxstream: "Telnyx streaming", workersai: "Workers AI" };
    const MAX_HISTORY_MESSAGES = 12;
    const STORAGE_PREFIX = "voiceBench.";
    const SECRET_FIELDS = ["telnyxKey", "passcode"];
    const SETTING_FIELDS = [
        "systemPrompt", "maxTokens", "thinkingOff",
        "telnyxEnabled", "telnyxStt", "telnyxChat", "telnyxVoice",
        "telnyxstreamEnabled", "telnyxstreamStt", "telnyxstreamVoice",
        "workersaiEnabled", "workersaiStt", "workersaiChat", "workersaiTts", "workersaiVoice",
        "parallelCount",
        "designPrompt", "designText", "designProvider", "designGender", "designName"
    ];
    const INPUT_RATE = 16000;
    const STREAM_FRAME_BYTES = 3200;
    const WORKERS_AI_VOICES = {
        "@cf/deepgram/aura-1": ["angus", "asteria", "arcas", "orion", "orpheus", "athena", "luna", "zeus", "perseus", "helios", "hera", "stella"],
        "@cf/deepgram/aura-2-en": [
            "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena", "atlas", "aurora", "callista",
            "cora", "cordelia", "delia", "draco", "electra", "harmonia", "helena", "hera", "hermes", "hyperion",
            "iris", "janus", "juno", "jupiter", "luna", "mars", "minerva", "neptune", "odysseus", "ophelia",
            "orion", "orpheus", "pandora", "phoebe", "pluto", "saturn", "thalia", "theia", "vesta", "zeus"
        ],
        "@cf/myshell-ai/melotts": []
    };
    const METRICS = ["stt", "chatFirstToken", "chat", "ttsFirstByte", "tts", "firstAudio", "roundTrip"];

    const $ = (id) => document.getElementById(id);
    const talkButton = $("talk");
    const rerunButton = $("rerun");
    const parallelButton = $("parallel");
    const statusEl = $("status");

    const histories = { telnyx: [], telnyxstream: [], workersai: [] };
    const results = { telnyx: [], telnyxstream: [], workersai: [] };
    let turnNumber = 0;
    let parallelRuns = 0;
    /** The voice design being iterated on: { id, version, provider }. */
    let design = null;
    let lastRecording = null;
    let audioInfo = "";
    let micStream = null;
    let audioContext = null;
    let captureNode = null;
    let capturing = false;
    let starting = false;
    let captured = [];
    let resampler = null;
    let liveStream = null;
    let flushWaiter = null;
    let recordStartedAt = 0;
    let holding = false;
    let currentAudio = null;
    let currentPlayer = null;
    let inFlight = 0;

    function fieldValue(el) {
        return el.type === "checkbox" ? el.checked : el.value;
    }

    function setFieldValue(el, value) {
        if (el.type === "checkbox") el.checked = value === true || value === "true";
        else if (el.tagName === "SELECT") selectValue(el, value);
        else el.value = value;
    }

    /** Keeps a saved choice that came from a loaded list, which is gone after a page refresh. */
    function selectValue(select, value) {
        if (value && ![...select.options].some((o) => o.value === value)) select.append(option(value));
        select.value = value;
    }

    function loadSaved() {
        for (const id of SETTING_FIELDS) {
            const saved = localStorage.getItem(STORAGE_PREFIX + id);
            if (saved != null) setFieldValue($(id), saved);
        }
        const remember = localStorage.getItem(STORAGE_PREFIX + "remember") === "true";
        $("remember").checked = remember;
        if (remember) {
            for (const id of SECRET_FIELDS) $(id).value = localStorage.getItem(STORAGE_PREFIX + id) || "";
        }
    }

    function saveSettings() {
        for (const id of SETTING_FIELDS) localStorage.setItem(STORAGE_PREFIX + id, String(fieldValue($(id))));
        const remember = $("remember").checked;
        localStorage.setItem(STORAGE_PREFIX + "remember", String(remember));
        for (const id of SECRET_FIELDS) {
            if (remember) localStorage.setItem(STORAGE_PREFIX + id, $(id).value);
            else localStorage.removeItem(STORAGE_PREFIX + id);
        }
    }

    function option(value, label = value) {
        return Object.assign(document.createElement("option"), { value, textContent: label });
    }

    function refreshWorkersAiVoices() {
        const voices = WORKERS_AI_VOICES[$("workersaiTts").value] || [];
        const select = $("workersaiVoice");
        const wanted = select.value || localStorage.getItem(STORAGE_PREFIX + "workersaiVoice");
        select.replaceChildren(...(voices.length ? voices.map((v) => option(v)) : [option("", "(only one voice)")]));
        select.disabled = voices.length === 0;
        if (voices.length) select.value = voices.includes(wanted) ? wanted : voices[0];
    }

    function withKeyHint(message) {
        if (!/\b10009\b|malformed|Authentication failed/i.test(message)) return message;
        return `${message} Telnyx API keys start with "KEY". Tick "Show" next to the keys to check what is in the box.`;
    }

    function syncTelnyxPick() {
        const pick = $("telnyxVoicePick");
        const current = $("telnyxVoice").value;
        if ([...pick.options].some((o) => o.value === current)) pick.value = current;
    }

    /** Fills a voice list from the account; the streaming list drops Ultra voices, which Telnyx only serves over REST. */
    async function loadTelnyxVoices(target = "telnyx") {
        const streaming = target === "telnyxstream";
        const button = $(streaming ? "loadTelnyxstreamVoices" : "loadTelnyxVoices");
        const providerSelect = $(streaming ? "telnyxstreamVoiceProvider" : "telnyxVoiceProvider");
        const provider = providerSelect.value;
        const key = $("telnyxKey").value.trim();
        if (!key) {
            setStatus("Enter your Telnyx API key first.", true);
            return;
        }
        button.disabled = true;
        setStatus("Loading Telnyx voices…");
        try {
            const response = await fetch(`/api/telnyx-voices?provider=${encodeURIComponent(provider)}`, {
                headers: { "X-Telnyx-Key": key }
            });
            const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
            const all = payload.voices || [];
            const voices = streaming ? all.filter((v) => !/\.Ultra\./i.test(v.id)) : all;
            const pick = $(streaming ? "telnyxstreamVoice" : "telnyxVoicePick");
            const wanted = pick.value;
            pick.querySelector("optgroup[data-loaded]")?.remove();
            const group = document.createElement("optgroup");
            group.label = `${providerSelect.selectedOptions[0].textContent} on your account (${voices.length})`;
            group.dataset.loaded = "true";
            for (const v of voices) {
                const details = [v.language, v.gender].filter(Boolean).join(", ");
                group.append(option(v.id, details ? `${v.name} (${details})` : v.name));
            }
            pick.append(group);
            if (streaming) {
                for (const stale of pick.querySelectorAll(":scope > option")) {
                    if (stale.value === wanted && group.querySelector(`option[value="${CSS.escape(wanted)}"]`)) stale.remove();
                }
                pick.value = wanted;
            } else {
                syncTelnyxPick();
            }
            const skipped = all.length - voices.length;
            setStatus(
                voices.length
                    ? `Loaded ${voices.length} voices${skipped ? ` (left out ${skipped} Ultra voices, which cannot stream)` : ""}. Pick one from the ${streaming ? "Streaming voice" : "Voice"} list.`
                    : all.length
                      ? "Every voice in that list is Ultra, which cannot stream. Try another voice provider."
                      : `Telnyx returned no voices this page could read. Telnyx sent: ${payload.sample || "(empty)"}`
            );
        } catch (error) {
            setStatus(`Could not load voices: ${withKeyHint(error.message)}`, true);
        } finally {
            button.disabled = false;
        }
    }

    async function postTelnyxJson(path, body) {
        const key = $("telnyxKey").value.trim();
        if (!key) throw new Error("Enter your Telnyx API key first.");
        const response = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Telnyx-Key": key },
            body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
    }

    async function generateDesignSample() {
        const button = $("designGenerate");
        const provider = $("designProvider").value;
        const continuing = design && design.provider === provider;
        button.disabled = true;
        $("designInfo").textContent = "Telnyx is generating the sample voice (this can take several seconds)…";
        try {
            saveSettings();
            const result = await postTelnyxJson("/api/voice-design", {
                prompt: $("designPrompt").value,
                text: $("designText").value,
                provider,
                voiceDesignId: continuing ? design.id : null
            });
            design = { id: result.id, version: result.version, provider: result.provider };
            const sample = $("designSample");
            if (sample.src) URL.revokeObjectURL(sample.src);
            sample.src = URL.createObjectURL(new Blob([base64ToBytes(result.sampleBase64)], { type: result.sampleType }));
            sample.hidden = false;
            sample.play().catch(() => {});
            $("designSave").disabled = false;
            $("designInfo").textContent =
                `Version ${result.version} of this design (not saved yet). Change the description and generate again to try ` +
                `another version, or save this one.`;
        } catch (error) {
            $("designInfo").textContent = `Could not generate the voice: ${withKeyHint(error.message)}`;
        } finally {
            button.disabled = false;
        }
    }

    async function saveDesignedVoice() {
        if (!design) return;
        const button = $("designSave");
        button.disabled = true;
        $("designInfo").textContent = `Saving version ${design.version} as a voice on your Telnyx account…`;
        try {
            const result = await postTelnyxJson("/api/voice-clone", {
                voiceDesignId: design.id,
                version: design.version,
                provider: design.provider,
                gender: $("designGender").value,
                name: $("designName").value
            });
            $("telnyxVoice").value = result.voiceId;
            syncTelnyxPick();
            const streamVoice = $("telnyxstreamVoice");
            if (![...streamVoice.options].some((o) => o.value === result.voiceId)) {
                streamVoice.append(option(result.voiceId, `${result.name} (your design)`));
            }
            streamVoice.value = result.voiceId;
            saveSettings();
            $("designInfo").textContent =
                `Saved as "${result.name}" (${result.voiceId}). It is now the Telnyx voice and the streaming voice, ready for the next turn.`;
        } catch (error) {
            button.disabled = false;
            $("designInfo").textContent = `Could not save the voice: ${withKeyHint(error.message)}`;
        }
    }

    function startNewDesign() {
        design = null;
        $("designSave").disabled = true;
        $("designSample").hidden = true;
        $("designInfo").textContent = "Starting fresh: the next sample creates a new design.";
    }

    function providerHeaders(provider) {
        return provider === "telnyx"
            ? { "X-Telnyx-Key": $("telnyxKey").value.trim() }
            : { "X-Bench-Passcode": $("passcode").value };
    }

    async function loadChatModels(provider) {
        const button = $(provider === "telnyx" ? "loadTelnyxModels" : "loadWorkersaiModels");
        const headers = providerHeaders(provider);
        if (!Object.values(headers)[0]) {
            setStatus(provider === "telnyx" ? "Enter your Telnyx API key first." : "Enter the Workers AI passcode first.", true);
            return;
        }
        button.disabled = true;
        setStatus(`Loading ${LABELS[provider]} chat models…`);
        try {
            const response = await fetch(`/api/${provider}-models`, { headers });
            const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
            const select = $(`${provider}Chat`);
            const current = select.value;
            select.querySelector("optgroup[data-loaded]")?.remove();
            const presets = new Set([...select.querySelectorAll("optgroup option")].map((o) => o.value));
            for (const o of [...select.options]) if (!presets.has(o.value)) o.remove();
            const models = (payload.models || []).filter((m) => !presets.has(m.id));
            const group = document.createElement("optgroup");
            group.label = `All on your account (${models.length} more)`;
            group.dataset.loaded = "true";
            for (const m of models) group.append(option(m.id, m.note ? `${m.id} (${m.note})` : m.id));
            select.append(group);
            selectValue(select, current);
            setStatus(`Loaded ${models.length} more ${LABELS[provider]} chat models. Pick one from the Chat model list.`);
        } catch (error) {
            setStatus(`Could not load chat models: ${withKeyHint(error.message)}`, true);
        } finally {
            button.disabled = false;
        }
    }

    function setStatus(text, isError = false) {
        statusEl.textContent = text;
        statusEl.className = isError ? "error" : "";
    }

    /** One audio context captures the microphone (via the worklet) and plays streamed replies. */
    async function ensureAudio() {
        if (!micStream) {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
            });
        }
        if (!audioContext) {
            audioContext = new AudioContext();
            await audioContext.audioWorklet.addModule("pcm-capture.js");
            captureNode = new AudioWorkletNode(audioContext, "pcm-capture");
            audioContext.createMediaStreamSource(micStream).connect(captureNode);
            captureNode.connect(audioContext.destination);
            captureNode.port.onmessage = (event) => onCaptured(event.data);
        }
        if (audioContext.state !== "running") await audioContext.resume();
    }

    function onCaptured(data) {
        const flushed = data instanceof Float32Array ? null : data.flushed;
        if ((capturing || flushed) && resampler) {
            const pcm = resampler.push(flushed || data);
            if (pcm.length) {
                captured.push(pcm);
                liveStream?.sendAudio(pcm);
            }
        }
        if (flushed && flushWaiter) flushWaiter();
    }

    async function startRecording() {
        if (capturing || starting) return;
        starting = true;
        try {
            await ensureAudio();
        } catch (error) {
            setStatus(`Microphone unavailable: ${error.message}`, true);
            return;
        } finally {
            starting = false;
        }
        // The first microphone prompt can outlast a short press.
        if (!holding) {
            setStatus("Microphone ready. Hold the button while you speak.");
            return;
        }
        captured = [];
        resampler = createResampler(audioContext.sampleRate, INPUT_RATE);
        liveStream = $("telnyxstreamEnabled").checked ? openStreamSession() : null;
        capturing = true;
        recordStartedAt = performance.now();
        talkButton.classList.add("recording");
        talkButton.textContent = "Listening… let go to send";
        setStatus("Recording…");
    }

    async function stopRecording() {
        if (!capturing) return;
        capturing = false;
        talkButton.classList.remove("recording");
        talkButton.textContent = "Hold to talk";
        await new Promise((resolve) => {
            flushWaiter = resolve;
            captureNode.port.postMessage("flush");
            setTimeout(resolve, 200);
        });
        flushWaiter = null;
        const live = liveStream;
        liveStream = null;
        if (performance.now() - recordStartedAt < 400) {
            live?.cancel();
            setStatus("Too short. Hold the button while you speak.", true);
            return;
        }
        const pcm = concatInt16(captured);
        lastRecording = { pcm, wav: encodeWav(pcm, INPUT_RATE) };
        rerunButton.disabled = false;
        parallelButton.disabled = false;
        runTurn(lastRecording, live);
    }

    /** Box-filter downsampler from the device rate to 16 kHz 16-bit PCM, carrying leftovers between batches. */
    function createResampler(fromRate, toRate) {
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

    function concatInt16(chunks) {
        const out = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    function encodeWav(samples, rate) {
        const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
        const writeText = (offset, text) => {
            for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
        };
        writeText(0, "RIFF");
        view.setUint32(4, 36 + samples.length * 2, true);
        writeText(8, "WAVE");
        writeText(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeText(36, "data");
        view.setUint32(40, samples.length * 2, true);
        for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
        return new Blob([view], { type: "audio/wav" });
    }

    function heardProvider() {
        return document.querySelector('input[name="hear"]:checked')?.value || "telnyx";
    }

    /** Telnyx streaming shares the Telnyx chat model; Ultra voices cannot stream, so it has its own voice list. */
    function providerSettings(provider) {
        const streamVoice = $("telnyxstreamVoice").value;
        const settings = {
            systemPrompt: $("systemPrompt").value,
            maxTokens: $("maxTokens").value,
            thinkingOff: String($("thinkingOff").checked),
            sttModel: $(`${provider}Stt`).value,
            chatModel: $(provider === "workersai" ? "workersaiChat" : "telnyxChat").value,
            voice: provider !== "telnyxstream" ? $(`${provider}Voice`).value : streamVoice === "same" ? $("telnyxVoice").value : streamVoice
        };
        if (provider === "workersai") settings.ttsModel = $("workersaiTts").value;
        return settings;
    }

    /**
     * Upload providers get the WAV at release. The streaming provider already heard the audio live; on a re-run
     * it is fed the recording at speaking speed first, and the uploads start the moment that stream ends.
     */
    async function runTurn(recording, live = null) {
        saveSettings();
        const enabled = PROVIDERS.filter((p) => $(`${p}Enabled`).checked);
        const streaming = enabled.includes("telnyxstream");
        if (!streaming) live?.cancel();
        if (!enabled.length) {
            setStatus("Tick at least one provider.", true);
            return;
        }
        turnNumber += 1;
        const turn = turnNumber;
        const heard = heardProvider();
        let peak = 0;
        for (const sample of recording.pcm) peak = Math.max(peak, Math.abs(sample));
        audioInfo = `${(recording.pcm.length / INPUT_RATE).toFixed(1)} s of audio, loudest ${Math.round((peak / 32768) * 100)}%`;
        const speakingMs = Math.round((recording.pcm.length / INPUT_RATE) * 1000);
        let stream = streaming ? live : null;
        if (streaming && !stream) {
            setStatus(`Turn ${turn}: streaming the recording to Telnyx at speaking speed…`);
            stream = openStreamSession();
            await stream.pace(recording.pcm);
        }
        setStatus(`Turn ${turn} (${audioInfo}): waiting for ${enabled.map((p) => LABELS[p]).join(", ")}…`);
        stream?.finish(turn, heard === "telnyxstream", speakingMs);
        const uploads = enabled.filter((p) => p !== "telnyxstream");
        // Alternate who is sent first so neither always gets the head start.
        const order = turn % 2 === 1 ? uploads : [...uploads].reverse();
        for (const provider of order) sendToProvider(provider, recording.wav, turn, provider === heard, speakingMs);
    }

    /**
     * Several independent streamed conversations at the same moment, each fed the last recording at speaking speed.
     * They start fresh (no history), play nothing, and stay out of the summary and the main conversation.
     */
    async function runParallelStreams() {
        if (!lastRecording) return;
        if (!$("telnyxKey").value.trim()) {
            setStatus("Enter your Telnyx API key first.", true);
            return;
        }
        saveSettings();
        const count = Math.min(10, Math.max(2, Number($("parallelCount").value) || 5));
        parallelRuns += 1;
        const run = parallelRuns;
        const speakingMs = Math.round((lastRecording.pcm.length / INPUT_RATE) * 1000);
        const settledRows = [];
        parallelButton.disabled = true;

        const report = () => {
            const ok = settledRows.filter((row) => row.ok);
            const starts = ok.map((row) => row.firstAudio).filter((v) => v != null);
            const failed = settledRows.length - ok.length;
            const done = settledRows.length === count;
            const spread = starts.length
                ? ` Reply starts: fastest ${ms(Math.min(...starts))} ms, median ${ms(median(starts))} ms, slowest ${ms(Math.max(...starts))} ms.`
                : "";
            setStatus(
                `${count} streams at once (run P${run}): ${done ? "" : `${settledRows.length} of ${count} finished, `}${ok.length} succeeded, ${failed} failed.${spread}`,
                failed > 0
            );
            if (done) parallelButton.disabled = false;
        };

        setStatus(`Opening ${count} Telnyx streams at once and feeding each the last recording at speaking speed…`);
        const sessions = Array.from({ length: count }, () =>
            openStreamSession({ history: [], standalone: true, onSettled: (row) => { settledRows.push(row); report(); } })
        );
        await Promise.all(sessions.map((session) => session.pace(lastRecording.pcm)));
        sessions.forEach((session, i) => session.finish(`P${run}.${i + 1}`, false, speakingMs));
    }

    /**
     * Options for the parallel test: `history` replaces the streaming conversation, `standalone` keeps the result out of
     * the summary and conversation, and `onSettled` hears each finished row.
     */
    function openStreamSession(options = {}) {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${scheme}://${location.host}/api/telnyx-stream`);
        const openedAt = performance.now();
        const outbox = [];
        const audioOut = [];
        let buffered = [];
        let bufferedBytes = 0;
        let turn = null;
        let playWhenReady = false;
        let speakingMs = null;
        let stopAt = 0;
        let firstAudioAt = null;
        let earlyError = null;
        let settled = false;
        let player = null;
        let format = null;
        let leftover = null;

        const sendRaw = (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
            else if (ws.readyState === WebSocket.CONNECTING) outbox.push(data);
        };

        ws.addEventListener("open", () => {
            const settings = { ...providerSettings("telnyxstream"), history: JSON.stringify(options.history ?? histories.telnyxstream) };
            ws.send(JSON.stringify({ type: "start", key: $("telnyxKey").value.trim(), settings }));
            for (const data of outbox.splice(0)) ws.send(data);
        });
        ws.addEventListener("message", (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            if (message.type === "partial" && turn == null && !options.standalone) setStatus(`Recording… Telnyx streaming hears: ${message.text}`);
            else if (message.type === "audio") onAudio(base64ToBytes(message.audio));
            else if (message.type === "done") onDone(message);
            else if (message.type === "error") fail(message.message);
        });
        ws.addEventListener("close", () => fail("The streaming connection closed before the reply finished."));

        function flushAudio() {
            if (!bufferedBytes) return;
            sendRaw(concatInt16(buffered).buffer);
            buffered = [];
            bufferedBytes = 0;
        }

        function sendAudio(pcm) {
            buffered.push(pcm);
            bufferedBytes += pcm.byteLength;
            if (bufferedBytes >= STREAM_FRAME_BYTES) flushAudio();
        }

        function settle(row) {
            if (settled) return;
            settled = true;
            inFlight -= 1;
            completeRow(row);
            options.onSettled?.(row);
        }

        function fail(message) {
            if (settled) return;
            if (turn == null) {
                if (!earlyError && !options.standalone) setStatus(`Telnyx streaming: ${withKeyHint(message)}`, true);
                earlyError = earlyError || message;
                return;
            }
            settle({ turn, provider: "telnyxstream", ok: false, heard: playWhenReady, error: withKeyHint(message) });
        }

        function onAudio(bytes) {
            if (!format) {
                format = looksLikeMp3(bytes) ? "mp3" : "pcm";
                if (format === "pcm") bytes = stripWavHeader(bytes);
            }
            if (firstAudioAt == null) firstAudioAt = performance.now();
            if (format === "mp3") {
                audioOut.push(bytes);
                if (playWhenReady && player !== false) {
                    player = player || startMp3Player() || false;
                    if (player) player.push(bytes);
                }
                return;
            }
            if (leftover) {
                const joined = new Uint8Array(leftover.length + bytes.length);
                joined.set(leftover);
                joined.set(bytes, leftover.length);
                bytes = joined;
                leftover = null;
            }
            if (bytes.length % 2) {
                leftover = bytes.slice(bytes.length - 1);
                bytes = bytes.subarray(0, bytes.length - 1);
            }
            if (!bytes.length) return;
            const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
            audioOut.push(pcm);
            if (playWhenReady) {
                player = player || startPlayer();
                player.push(pcm);
            }
        }

        function onDone(message) {
            if (settled || turn == null) return;
            const rate = message.audioRate || 24000;
            const audioBlob = format === "mp3" ? new Blob(audioOut, { type: "audio/mpeg" }) : encodeWav(concatInt16(audioOut), rate);
            const audioUrl = URL.createObjectURL(audioBlob);
            if (format === "mp3" && player) player.end();
            else if (format === "mp3" && playWhenReady) play(audioUrl);
            // The Worker's marks count from when it accepted this socket, which is within a few ms of openedAt.
            const shift = openedAt - stopAt;
            const marks = { open: shift };
            for (const [name, at] of Object.entries(message.marks || {})) marks[name] = at + shift;
            const row = {
                turn,
                provider: "telnyxstream",
                ok: true,
                heard: playWhenReady,
                transcript: message.transcript,
                reply: message.reply,
                reasoningChars: message.reasoningChars,
                speechRetries: message.speechRetries,
                audioUrl,
                speakingMs,
                marks,
                ...message.timings,
                firstAudio: firstAudioAt == null ? null : Math.round(firstAudioAt - stopAt),
                roundTrip: Math.round(performance.now() - stopAt)
            };
            if (!options.standalone) {
                results.telnyxstream.push(row);
                pushHistory("telnyxstream", message.transcript, message.reply);
            }
            settle(row);
        }

        return {
            sendAudio,
            async pace(pcm) {
                const step = INPUT_RATE / 10;
                for (let i = 0; i < pcm.length; i += step) {
                    sendAudio(pcm.subarray(i, i + step));
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            },
            finish(turnNumberForRow, play, spokeMs) {
                flushAudio();
                turn = turnNumberForRow;
                playWhenReady = play;
                speakingMs = spokeMs;
                stopAt = performance.now();
                inFlight += 1;
                if (earlyError) fail(earlyError);
                else sendRaw(JSON.stringify({ type: "stop" }));
            },
            cancel() {
                settled = true;
                ws.close();
            }
        };
    }

    function looksLikeMp3(bytes) {
        const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
        return id3 || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    }

    /** Streams MP3 pieces into one audio element; returns null where the browser cannot (it then plays at the end). */
    function startMp3Player() {
        if (!window.MediaSource || !MediaSource.isTypeSupported("audio/mpeg")) return null;
        stopPlayback();
        const media = new MediaSource();
        const audio = new Audio(URL.createObjectURL(media));
        const queue = [];
        let buffer = null;
        let ending = false;
        const pump = () => {
            if (!buffer || buffer.updating) return;
            if (queue.length) buffer.appendBuffer(queue.shift());
            else if (ending && media.readyState === "open") media.endOfStream();
        };
        media.addEventListener("sourceopen", () => {
            buffer = media.addSourceBuffer("audio/mpeg");
            buffer.addEventListener("updateend", pump);
            pump();
        }, { once: true });
        audio.play().catch((error) => setStatus(`Playback blocked: ${error.message}`, true));
        const player = {
            push(bytes) {
                queue.push(bytes);
                pump();
            },
            end() {
                ending = true;
                pump();
            },
            stop() {
                audio.pause();
            }
        };
        currentPlayer = player;
        return player;
    }

    function stripWavHeader(bytes) {
        if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return bytes;
        for (let i = 12; i + 8 <= bytes.length; i++) {
            if (bytes[i] === 100 && bytes[i + 1] === 97 && bytes[i + 2] === 116 && bytes[i + 3] === 97) return bytes.subarray(i + 8);
        }
        return bytes;
    }

    /** Schedules 24 kHz PCM pieces back to back so speech starts with the first piece. */
    function startPlayer(rate = 24000) {
        stopPlayback();
        const sources = [];
        let nextTime = 0;
        const player = {
            push(pcm) {
                const buffer = audioContext.createBuffer(1, pcm.length, rate);
                const channel = buffer.getChannelData(0);
                for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                nextTime = Math.max(nextTime, audioContext.currentTime + 0.05);
                source.start(nextTime);
                nextTime += buffer.duration;
                sources.push(source);
            },
            stop() {
                for (const source of sources) {
                    try {
                        source.stop();
                    } catch (_) {}
                }
            }
        };
        currentPlayer = player;
        return player;
    }

    function stopPlayback() {
        currentAudio?.pause();
        currentPlayer?.stop();
        currentAudio = null;
        currentPlayer = null;
    }

    function completeRow(row) {
        addTurnRow(row);
        renderSummary();
        if (!inFlight) setStatus(`Turn ${row.turn} done (${audioInfo}). Hold the button to speak again.`);
    }

    async function sendToProvider(provider, wav, turn, playWhenReady, speakingMs) {
        const form = new FormData();
        form.append("provider", provider);
        form.append("audio", wav, "speech.wav");
        form.append("history", JSON.stringify(histories[provider]));
        for (const [key, value] of Object.entries(providerSettings(provider))) form.append(key, value);
        const headers = providerHeaders(provider);

        inFlight += 1;
        const startedAt = performance.now();
        let row;
        try {
            const response = await fetch("/api/turn", { method: "POST", headers, body: form });
            const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            const roundTrip = Math.round(performance.now() - startedAt);
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

            const audioUrl = URL.createObjectURL(new Blob([base64ToBytes(payload.audioBase64)], { type: payload.audioType || "audio/mpeg" }));
            // Uploaded replies arrive in one piece, so speech can only start once the whole round trip is done.
            row = { turn, provider, ok: true, heard: playWhenReady, roundTrip, firstAudio: roundTrip, audioUrl, speakingMs, ...payload.timings, ...payload };
            delete row.audioBase64;
            results[provider].push(row);
            pushHistory(provider, payload.transcript, payload.reply);
            if (playWhenReady) play(audioUrl);
        } catch (error) {
            row = { turn, provider, ok: false, heard: playWhenReady, error: withKeyHint(error.message) };
        } finally {
            inFlight -= 1;
        }
        completeRow(row);
    }

    function pushHistory(provider, transcript, reply) {
        const history = histories[provider];
        history.push({ role: "user", content: transcript }, { role: "assistant", content: reply });
        if (history.length > MAX_HISTORY_MESSAGES) history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }

    function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function play(url) {
        stopPlayback();
        currentAudio = new Audio(url);
        currentAudio.play().catch((error) => setStatus(`Playback blocked: ${error.message}`, true));
    }

    function cell(text, className) {
        const td = document.createElement("td");
        if (className) td.className = className;
        td.textContent = text;
        return td;
    }

    function ms(value) {
        return value == null || Number.isNaN(value) ? "–" : String(Math.round(value));
    }

    function addTurnRow(row) {
        const tr = document.createElement("tr");
        tr.className = row.provider;
        tr.append(cell(String(row.turn)), cell(LABELS[row.provider] + (row.heard ? " (heard)" : ""), row.heard ? "heard" : ""));
        if (!row.ok) {
            const td = cell(row.error, "error");
            td.colSpan = METRICS.length + 2;
            tr.append(td);
        } else {
            for (const metric of METRICS) tr.append(cell(ms(row[metric]), "num"));
            const convo = document.createElement("td");
            convo.className = "convo";
            const heardLine = Object.assign(document.createElement("div"), { textContent: `You: ${row.transcript}` });
            heardLine.className = "muted";
            const replyLine = Object.assign(document.createElement("div"), { textContent: `Bot: ${row.reply}` });
            convo.append(heardLine, replyLine);
            if (row.speechRetries) {
                convo.append(Object.assign(document.createElement("div"), {
                    className: "error",
                    textContent: "(Telnyx speech failed once and was retried; speech time includes the retry)"
                }));
            }
            if (row.provider === "telnyxstream") {
                const lastFinal = row.sttLastFinal == null ? "" : `; last final transcript ${row.sttLastFinal} ms after letting go`;
                convo.append(Object.assign(document.createElement("div"), {
                    className: "muted",
                    textContent: `(connecting to Telnyx took ${row.connect} ms while you spoke${lastFinal})`
                }));
                if (row.sttFallback) {
                    convo.append(Object.assign(document.createElement("div"), {
                        className: "error",
                        textContent: "(the stream heard nothing, so the clip was sent to Telnyx's regular Whisper transcription; speech-to-text time includes both)"
                    }));
                }
            }
            if (row.reasoningChars) {
                convo.append(Object.assign(document.createElement("div"), {
                    className: "muted",
                    textContent: `(thought for ${row.reasoningChars} characters first)`
                }));
            }
            tr.append(convo);
            const actions = document.createElement("td");
            const replay = Object.assign(document.createElement("button"), { textContent: "Replay" });
            replay.addEventListener("click", () => play(row.audioUrl));
            actions.append(replay);
            tr.append(actions);

            const timelineRow = document.createElement("tr");
            timelineRow.className = `${row.provider} timeline-row`;
            const timelineCell = document.createElement("td");
            timelineCell.colSpan = METRICS.length + 4;
            timelineRow.append(timelineCell);
            renderTimeline(timelineCell, row, null);
            audioDurationMs(row.audioUrl).then((audioMs) => renderTimeline(timelineCell, row, audioMs));
            $("turns").prepend(timelineRow);
        }
        $("turns").prepend(tr);
    }

    const TIMELINE_LANES = [
        ["speak", "You speaking"],
        ["stt", "Speech-to-text"],
        ["chat", "Chat reply"],
        ["tts", "Voice"],
        ["audio", "Audio out"]
    ];
    const TIMELINE_BEFORE_MS = 6000;
    const TIMELINE_MIN_AFTER_MS = 9000;
    /** One scale for every turn, so bars compare by eye; turns that run long scroll sideways instead of shrinking. */
    const TIMELINE_PX_PER_SECOND = 64;

    function audioDurationMs(url) {
        return new Promise((resolve) => {
            const audio = new Audio();
            const done = (value) => {
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => done(null), 3000);
            audio.preload = "metadata";
            audio.addEventListener("loadedmetadata", () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null), { once: true });
            audio.addEventListener("error", () => done(null), { once: true });
            audio.src = url;
        });
    }

    /**
     * Bars in ms from letting go. `wait` splits a bar into a lighter waiting part (connecting, waiting for the first
     * word or first audio) and a solid working part. Upload providers report only durations, so their bars run back to back.
     */
    function timelineBars(row, audioMs) {
        const bars = { speak: { start: -(row.speakingMs ?? 0), end: 0 } };
        const m = row.marks;
        if (m) {
            bars.stt = { start: m.open, wait: m.connected, end: m.transcript };
            bars.chat = { start: m.transcript, wait: m.chatFirstToken, end: m.chatDone };
            bars.tts = { start: m.speechStart, wait: m.firstAudio, end: m.speechEnd };
        } else if (row.stt != null && row.chat != null && row.tts != null) {
            const chatAt = row.stt;
            const voiceAt = chatAt + row.chat;
            bars.stt = { start: 0, end: chatAt };
            bars.chat = { start: chatAt, wait: chatAt + (row.chatFirstToken ?? 0), end: voiceAt };
            bars.tts = { start: voiceAt, wait: voiceAt + (row.ttsFirstByte ?? 0), end: voiceAt + row.tts };
        }
        if (row.firstAudio != null) {
            bars.audio = { start: row.firstAudio, end: row.firstAudio + (audioMs ?? 300), unknownLength: audioMs == null };
        }
        return bars;
    }

    function renderTimeline(container, row, audioMs) {
        const bars = timelineBars(row, audioMs);
        const ends = Object.values(bars).map((bar) => bar.end).filter(Number.isFinite);
        const after = Math.max(TIMELINE_MIN_AFTER_MS, Math.ceil(Math.max(...ends) / 1000) * 1000);
        const span = TIMELINE_BEFORE_MS + after;
        const pos = (t) => ((Math.max(-TIMELINE_BEFORE_MS, Math.min(after, t)) + TIMELINE_BEFORE_MS) / span) * 100;
        const div = (className, text) => Object.assign(document.createElement("div"), { className, textContent: text || "" });
        const seconds = [];
        for (let t = -TIMELINE_BEFORE_MS; t <= after; t += 1000) seconds.push(t);

        const grid = div("timeline");
        grid.style.gridTemplateColumns = `110px ${(span / 1000) * TIMELINE_PX_PER_SECOND}px`;
        for (const [key, label] of TIMELINE_LANES) {
            const track = div("track");
            for (const t of seconds) {
                const line = div(t === 0 ? "zero" : "second");
                line.style.left = `${pos(t)}%`;
                track.append(line);
            }
            const bar = bars[key];
            if (bar && Number.isFinite(bar.start) && Number.isFinite(bar.end) && bar.end >= bar.start) {
                const solidFrom = Number.isFinite(bar.wait) ? Math.min(Math.max(bar.wait, bar.start), bar.end) : bar.start;
                if (solidFrom > bar.start) track.append(timelineSegment(key, label, bar.start, solidFrom, true, pos));
                const solid = timelineSegment(key, label, solidFrom, bar.end, false, pos);
                if (bar.unknownLength) {
                    solid.textContent = "▶";
                    solid.title = `${label}: starts ${Math.round(bar.start)} ms after letting go (length unknown)`;
                }
                track.append(solid);
            }
            grid.append(div("lane-label", label), track);
        }
        const axis = div("track axis");
        for (const t of seconds) {
            const tick = div(t === 0 ? "tick zero-label" : "tick", t === 0 ? "let go" : `${t / 1000}s`);
            tick.style.left = `${pos(t)}%`;
            axis.append(tick);
        }
        grid.append(div("lane-label"), axis);
        const scroller = div("timeline-scroll");
        scroller.append(grid);
        container.replaceChildren(scroller);
    }

    function timelineSegment(key, label, from, to, waiting, pos) {
        const segment = document.createElement("div");
        segment.className = `seg ${key}${waiting ? " wait" : ""}`;
        segment.style.left = `${pos(from)}%`;
        segment.style.width = `${Math.max(pos(to) - pos(from), 0.3)}%`;
        const length = to - from;
        if (length >= 450) segment.textContent = `${(length / 1000).toFixed(1)} s`;
        segment.title = `${label}${waiting ? " (waiting)" : ""}: ${Math.round(from)} to ${Math.round(to)} ms after letting go (${Math.round(length)} ms)`;
        return segment;
    }

    function median(values) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function renderSummary() {
        const rows = PROVIDERS.filter((p) => results[p].length).map((provider) => {
            const list = results[provider];
            const tr = document.createElement("tr");
            tr.className = provider;
            tr.append(cell(LABELS[provider]), cell(String(list.length), "num"));
            for (const metric of METRICS) {
                tr.append(cell(ms(median(list.map((r) => r[metric]).filter((v) => v != null))), "num"));
            }
            tr.append(cell(ms(Math.max(...list.map((r) => r.roundTrip))), "num"));
            return tr;
        });
        $("summary").replaceChildren(...rows);
    }

    function resetConversations() {
        for (const provider of PROVIDERS) histories[provider] = [];
        setStatus("Conversations cleared. Timing log kept.");
    }

    talkButton.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        talkButton.setPointerCapture(event.pointerId);
        holding = true;
        startRecording();
    });
    const release = () => {
        holding = false;
        stopRecording();
    };
    talkButton.addEventListener("pointerup", release);
    talkButton.addEventListener("pointercancel", release);
    talkButton.addEventListener("contextmenu", (event) => event.preventDefault());
    rerunButton.addEventListener("click", () => {
        if (!lastRecording) return;
        audioContext?.resume();
        runTurn(lastRecording);
    });
    parallelButton.addEventListener("click", () => runParallelStreams());
    $("designGenerate").addEventListener("click", generateDesignSample);
    $("designSave").addEventListener("click", saveDesignedVoice);
    $("designNew").addEventListener("click", startNewDesign);
    $("reset").addEventListener("click", resetConversations);
    $("workersaiTts").addEventListener("change", () => {
        refreshWorkersAiVoices();
        saveSettings();
    });
    $("telnyxVoicePick").addEventListener("change", () => {
        $("telnyxVoice").value = $("telnyxVoicePick").value;
        saveSettings();
    });
    $("telnyxVoice").addEventListener("input", syncTelnyxPick);
    $("loadTelnyxVoices").addEventListener("click", () => loadTelnyxVoices("telnyx"));
    $("loadTelnyxstreamVoices").addEventListener("click", () => loadTelnyxVoices("telnyxstream"));
    $("loadTelnyxModels").addEventListener("click", () => loadChatModels("telnyx"));
    $("loadWorkersaiModels").addEventListener("click", () => loadChatModels("workersai"));
    $("showSecrets").addEventListener("change", () => {
        for (const id of SECRET_FIELDS) $(id).type = $("showSecrets").checked ? "text" : "password";
    });
    $("remember").addEventListener("change", saveSettings);
    for (const id of [...SETTING_FIELDS, ...SECRET_FIELDS]) $(id).addEventListener("change", saveSettings);

    loadSaved();
    refreshWorkersAiVoices();
    syncTelnyxPick();
})();
