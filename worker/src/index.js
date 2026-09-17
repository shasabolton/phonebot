import { fetchAndSelectGroqModels, applyCrossModelChatDefaults } from "../../groqModelSelect.js";

const MODE_CATALOG = Object.freeze({
    simonSaysPoseMatch: {
        label: "Simon Says Basic",
        priceCents: 200,
        currency: "aud",
        aiBudgetCents: 0,
        continuePriceCents: 200
    },
    simonSaysAi: {
        label: "Simon Says Advanced",
        priceCents: 200,
        currency: "aud",
        aiBudgetCents: 50,
        continuePriceCents: 200
    },
    philosophy: {
        label: "Philosophy",
        priceCents: 200,
        currency: "aud",
        aiBudgetCents: 50,
        continuePriceCents: 200
    },
    twentyQuestions: {
        label: "20 Questions",
        priceCents: 200,
        currency: "aud",
        aiBudgetCents: 50,
        continuePriceCents: 200
    },
    fortuneTeller: {
        label: "Fortune Teller",
        priceCents: 200,
        currency: "aud",
        aiBudgetCents: 50,
        continuePriceCents: 200
    }
});

const UNUSED_TTL_MS = 30 * 60 * 1000;
const ACTIVE_TTL_MS = 2 * 60 * 60 * 1000;

export default {
    async fetch(request, env) {
        try {
            if (request.method === "OPTIONS") return corsResponse(request, env, null, 204);
            const url = new URL(request.url);
            const path = url.pathname.replace(/\/+$/, "") || "/";

            if (path === "/api/webhooks/stripe" && request.method === "POST") {
                return await handleStripeWebhook(request, env);
            }
            if (path === "/api/checkout" && request.method === "POST") {
                assertAllowedOrigin(request, env);
                return corsResponse(request, env, await createCheckout(request, env));
            }
            if (path === "/api/ai/chat" && request.method === "POST") {
                assertAllowedOrigin(request, env);
                return corsResponse(request, env, await proxyGroqChat(request, env));
            }
            if (path === "/api/ai/transcribe" && request.method === "POST") {
                assertAllowedOrigin(request, env);
                return corsResponse(request, env, await proxyGroqTranscribe(request, env));
            }
            if (path === "/api/ai/speech" && request.method === "POST") {
                assertAllowedOrigin(request, env);
                return corsResponse(request, env, await proxyGroqSpeech(request, env));
            }
            if (path === "/api/ai/voice-turn" && request.method === "POST") {
                assertAllowedOrigin(request, env);
                return corsResponse(request, env, await proxyGroqVoiceTurn(request, env));
            }

            const match = path.match(/^\/api\/session\/([0-9a-f-]+)(?:\/(start|complete))?$/i);
            if (match) {
                assertAllowedOrigin(request, env);
                const id = match[1];
                if (!match[2] && request.method === "GET") {
                    return corsResponse(request, env, await getSession(env, id));
                }
                if (match[2] === "start" && request.method === "POST") {
                    return corsResponse(request, env, await startSession(env, id));
                }
                if (match[2] === "complete" && request.method === "POST") {
                    return corsResponse(request, env, await completeSession(request, env, id));
                }
            }
            return corsResponse(request, env, json({ error: "Not found" }, 404));
        } catch (error) {
            console.error(JSON.stringify({ event: "request_error", message: error?.message }));
            const status = Number(error?.status) || 500;
            return corsResponse(
                request,
                env,
                json({ error: status === 500 ? "Internal server error" : error.message }, status)
            );
        }
    }
};

async function createCheckout(request, env) {
    const body = await readJson(request);
    const modeId = cleanMetadata(body.modeId, 64);
    const robotSlug = cleanMetadata(body.robot, 64);
    const ownerId = cleanMetadata(body.owner, 128);
    const machineId = cleanMetadata(body.machine, 128);
    const mode = MODE_CATALOG[modeId];
    if (!mode || mode.priceCents <= 0) throw httpError(400, "Mode is not a paid arcade mode.");
    if (!robotSlug) throw httpError(400, "robot is required.");

    const continuation = body.continueSessionId
        ? await selectSession(env, cleanMetadata(body.continueSessionId, 64))
        : null;
    if (
        continuation &&
        (continuation.mode_id !== modeId ||
            continuation.robot_slug !== robotSlug ||
            !["active", "paused_for_payment"].includes(continuation.status))
    ) {
        throw httpError(409, "Continuation session is not eligible.");
    }

    // Price is server-authoritative; ignore any client-supplied amount.
    const priceCents = continuation ? mode.continuePriceCents : mode.priceCents;
    const currency = mode.currency;
    const returnUrl = allowedReturnUrl(body.returnUrl, request, env);
    const playSessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + UNUSED_TTL_MS;

    await env.DB.prepare(
        `INSERT INTO play_sessions (
            id, status, mode_id, robot_slug, owner_id, machine_id, price_cents, currency,
            ai_budget_cents, ai_spent_cents, expires_at, created_at, continuation_of
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
        .bind(
            playSessionId,
            modeId,
            robotSlug,
            ownerId || null,
            machineId || null,
            priceCents,
            currency,
            mode.aiBudgetCents,
            expiresAt,
            now,
            continuation?.id || null
        )
        .run();

    const success = new URL(returnUrl);
    success.searchParams.set("play_session", playSessionId);
    success.searchParams.set("payment", "success");
    const cancel = new URL(returnUrl);
    cancel.searchParams.set("payment", "cancelled");
    const metadata = {
        playSessionId,
        modeId,
        robot: robotSlug,
        owner: ownerId,
        machine: machineId,
        priceCents: String(priceCents),
        currency,
        continueSessionId: continuation?.id || ""
    };
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", success.toString());
    params.set("cancel_url", cancel.toString());
    params.set("client_reference_id", playSessionId);
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", currency);
    params.set("line_items[0][price_data][unit_amount]", String(priceCents));
    params.set("line_items[0][price_data][product_data][name]", mode.label);
    for (const [key, value] of Object.entries(metadata)) {
        params.set(`metadata[${key}]`, value);
        params.set(`payment_intent_data[metadata][${key}]`, value);
    }

    let stripeSession;
    try {
        stripeSession = await stripeRequest(env, "/v1/checkout/sessions", params, {
            "Idempotency-Key": `phonebot-checkout-${playSessionId}`
        });
    } catch (error) {
        await env.DB.prepare("DELETE FROM play_sessions WHERE id = ? AND status = 'pending'")
            .bind(playSessionId)
            .run();
        throw error;
    }
    await env.DB.prepare(
        "UPDATE play_sessions SET stripe_checkout_session_id = ? WHERE id = ? AND status = 'pending'"
    )
        .bind(stripeSession.id, playSessionId)
        .run();
    return json({ url: stripeSession.url, playSessionId });
}

async function handleStripeWebhook(request, env) {
    const rawBody = await request.text();
    const signature = request.headers.get("Stripe-Signature") || "";
    if (!(await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
        return json({ error: "Invalid Stripe signature" }, 400);
    }
    const event = JSON.parse(rawBody);
    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
        return json({ received: true });
    }
    const checkout = event.data?.object;
    if (checkout?.payment_status !== "paid") return json({ received: true });
    const id = cleanMetadata(checkout.metadata?.playSessionId, 64);
    const session = await selectSession(env, id);
    if (!session) throw httpError(404, "Play session not found.");
    if (
        Number(checkout.amount_total) !== session.price_cents ||
        String(checkout.currency || "").toLowerCase() !== session.currency ||
        checkout.metadata?.modeId !== session.mode_id ||
        checkout.metadata?.robot !== session.robot_slug
    ) {
        console.error(JSON.stringify({ event: "checkout_mismatch", checkoutId: checkout.id, sessionId: id }));
        throw httpError(400, "Checkout does not match play session.");
    }

    const statements = [
        env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)")
            .bind(event.id, event.type, Date.now()),
        env.DB.prepare(
            `UPDATE play_sessions
             SET status = 'paid', stripe_checkout_session_id = ?, stripe_payment_intent_id = ?
             WHERE id = ? AND status = 'pending'`
        ).bind(checkout.id, checkout.payment_intent || null, id)
    ];
    if (session.continuation_of) {
        statements.push(
            env.DB.prepare(
                `UPDATE play_sessions SET status = 'consumed', consumed_at = ?
                 WHERE id = ? AND status IN ('active', 'paused_for_payment')`
            ).bind(Date.now(), session.continuation_of)
        );
    }
    await env.DB.batch(statements);
    return json({ received: true });
}

async function getSession(env, id) {
    await expireSessionIfNeeded(env, id);
    const session = await selectSession(env, id);
    if (!session) throw httpError(404, "Play session not found.");
    return json(publicSession(session));
}

async function startSession(env, id) {
    await expireSessionIfNeeded(env, id);
    const now = Date.now();
    const existing = await selectSession(env, id);
    if (!existing) throw httpError(404, "Play session not found.");

    let resolvedJson = existing.resolved_models_json || null;
    if (!resolvedJson && env.GROQ_API_KEY) {
        try {
            const selected = await fetchAndSelectGroqModels(env.GROQ_API_KEY, {
                audPerUsd: Number(env.GROQ_AUD_PER_USD) || 1.5
            });
            resolvedJson = JSON.stringify({
                chat: selected.chat,
                vision: selected.vision,
                stt: selected.stt,
                tts: selected.tts,
                rates: selected.rates,
                selectedAt: now
            });
        } catch (err) {
            console.error(JSON.stringify({ event: "groq_model_select_failed", message: err?.message }));
            resolvedJson = JSON.stringify(fallbackResolvedModels(env));
        }
    } else if (!resolvedJson) {
        resolvedJson = JSON.stringify(fallbackResolvedModels(env));
    }

    await env.DB.prepare(
        `UPDATE play_sessions
         SET status = 'active',
             started_at = COALESCE(started_at, ?),
             expires_at = ?,
             resolved_models_json = COALESCE(resolved_models_json, ?)
         WHERE id = ? AND status = 'paid'`
    )
        .bind(now, now + ACTIVE_TTL_MS, resolvedJson, id)
        .run();
    const session = await selectSession(env, id);
    if (!session) throw httpError(404, "Play session not found.");
    if (session.status !== "active") throw httpError(409, `Session is ${session.status}.`);
    return json(publicSession(session));
}

function fallbackResolvedModels(env) {
    const chat = csvList(env.GROQ_ALLOWED_MODELS, "openai/gpt-oss-20b")[0] || "openai/gpt-oss-20b";
    const stt = csvList(env.GROQ_ALLOWED_TRANSCRIBE_MODELS, "whisper-large-v3")[0] || "whisper-large-v3";
    const tts =
        csvList(env.GROQ_ALLOWED_SPEECH_MODELS, "canopylabs/orpheus-v1-english")[0] ||
        "canopylabs/orpheus-v1-english";
    let rates = {};
    try {
        rates = JSON.parse(env.GROQ_RATES_JSON || "{}");
    } catch (_) {}
    return {
        chat,
        vision: chat,
        stt,
        tts,
        rates,
        selectedAt: Date.now(),
        fallback: true
    };
}

function parseResolvedModels(session) {
    if (!session?.resolved_models_json) return null;
    try {
        const parsed = JSON.parse(session.resolved_models_json);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function sessionAllowsChatModel(session, model, env) {
    const resolved = parseResolvedModels(session);
    const id = String(model || "").trim();
    if (!id) return false;
    if (resolved) {
        return id === resolved.chat || id === resolved.vision;
    }
    return csvList(env.GROQ_ALLOWED_MODELS, "openai/gpt-oss-20b").includes(id);
}

function sessionAllowsSttModel(session, model, env) {
    const resolved = parseResolvedModels(session);
    const id = String(model || "").trim();
    if (!id) return false;
    if (resolved?.stt) return id === resolved.stt;
    return csvList(env.GROQ_ALLOWED_TRANSCRIBE_MODELS, "whisper-large-v3").includes(id);
}

function sessionAllowsTtsModel(session, model, env) {
    const resolved = parseResolvedModels(session);
    const id = String(model || "").trim();
    if (!id) return false;
    if (resolved?.tts) return id === resolved.tts;
    return csvList(env.GROQ_ALLOWED_SPEECH_MODELS, "canopylabs/orpheus-v1-english").includes(id);
}

async function completeSession(request, env, id) {
    const body = await readJson(request);
    const reason = cleanMetadata(body.reason, 64) || "game_finished";
    await env.DB.prepare(
        `UPDATE play_sessions SET status = 'consumed', consumed_at = ?, completion_reason = ?
         WHERE id = ? AND status IN ('paid', 'active', 'paused_for_payment')`
    )
        .bind(Date.now(), reason, id)
        .run();
    const session = await selectSession(env, id);
    if (!session) throw httpError(404, "Play session not found.");
    return json(publicSession(session));
}

async function proxyGroqChat(request, env) {
    const gate = await requireActiveAiSession(request, env);
    if (gate instanceof Response) return gate;
    const { id, session } = gate;

    const body = await readJson(request);
    if (!sessionAllowsChatModel(session, body.model, env)) {
        throw httpError(400, "Model is not allowed for hosted arcade use.");
    }
    body.max_tokens = Math.min(1024, Math.max(1, Number(body.max_tokens) || 256));
    body.stream = false;
    applyCrossModelChatDefaults(body);

    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
        return new Response(raw, {
            status: upstream.status,
            headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
        });
    }
    const payload = JSON.parse(raw);
    const charge = calculateChatCharge(payload.usage, body.model, env, session);
    await debitAiBudget(env, id, charge);
    return new Response(raw, {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "X-Phonebot-AI-Charge-Cents": String(charge)
        }
    });
}

async function proxyGroqTranscribe(request, env) {
    const gate = await requireActiveAiSession(request, env);
    if (gate instanceof Response) return gate;
    const { id, session } = gate;

    const form = await request.formData();
    const file = form.get("file");
    const model = String(form.get("model") || "whisper-large-v3").trim();
    if (!sessionAllowsSttModel(session, model, env)) {
        throw httpError(400, "Transcription model is not allowed.");
    }
    if (!(file instanceof Blob) || file.size < 32) throw httpError(400, "Audio file is required.");
    if (file.size > 25_000_000) throw httpError(413, "Audio file too large.");

    const upstreamForm = new FormData();
    upstreamForm.append("file", file, String(form.get("filename") || "speech.webm"));
    upstreamForm.append("model", model);

    const upstream = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`
        },
        body: upstreamForm
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
        return new Response(raw, {
            status: upstream.status,
            headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
        });
    }
    const charge = Math.max(1, Number(env.GROQ_TRANSCRIBE_CENTS) || 1);
    await debitAiBudget(env, id, charge);
    return new Response(raw, {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "X-Phonebot-AI-Charge-Cents": String(charge)
        }
    });
}

async function proxyGroqSpeech(request, env) {
    const gate = await requireActiveAiSession(request, env);
    if (gate instanceof Response) return gate;
    const { id, session } = gate;

    const body = await readJson(request);
    const model = String(body.model || "").trim();
    if (!sessionAllowsTtsModel(session, model, env)) {
        throw httpError(400, "Speech model is not allowed.");
    }
    const input = String(body.input || "").trim().slice(0, 200);
    if (!input) throw httpError(400, "Nothing to speak.");

    const upstream = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            voice: String(body.voice || "autumn").trim() || "autumn",
            input,
            response_format: "wav"
        })
    });
    if (!upstream.ok) {
        const errText = await upstream.text();
        return new Response(errText, {
            status: upstream.status,
            headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" }
        });
    }
    const charge = Math.max(1, Number(env.GROQ_SPEECH_CENTS) || 1);
    await debitAiBudget(env, id, charge);
    const audio = await upstream.arrayBuffer();
    return new Response(audio, {
        status: 200,
        headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "audio/wav",
            "X-Phonebot-AI-Charge-Cents": String(charge)
        }
    });
}

async function proxyGroqVoiceTurn(request, env) {
    const startedAt = Date.now();
    const gate = await requireActiveAiSession(request, env);
    if (gate instanceof Response) return gate;
    const { id, session } = gate;

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size < 32) throw httpError(400, "Audio file is required.");
    if (file.size > 25_000_000) throw httpError(413, "Audio file too large.");

    const transcribeModel = String(form.get("transcribeModel") || "whisper-large-v3").trim();
    if (!sessionAllowsSttModel(session, transcribeModel, env)) {
        throw httpError(400, "Transcription model is not allowed.");
    }

    let chatBody;
    try {
        chatBody = JSON.parse(String(form.get("chatBody") || ""));
    } catch (_) {
        throw httpError(400, "Invalid chatBody JSON.");
    }
    if (!chatBody || !Array.isArray(chatBody.messages)) {
        throw httpError(400, "chatBody.messages is required.");
    }
    if (!sessionAllowsChatModel(session, chatBody.model, env)) {
        throw httpError(400, "Model is not allowed for hosted arcade use.");
    }
    chatBody.max_tokens = Math.min(1024, Math.max(1, Number(chatBody.max_tokens) || 256));
    chatBody.stream = false;
    applyCrossModelChatDefaults(chatBody);

    const transcribeForm = new FormData();
    transcribeForm.append("file", file, String(form.get("filename") || "speech.webm"));
    transcribeForm.append("model", transcribeModel);
    const transcribeStartedAt = Date.now();
    const transcribeResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: transcribeForm
    });
    const transcribeRaw = await transcribeResponse.text();
    if (!transcribeResponse.ok) {
        return new Response(transcribeRaw, {
            status: transcribeResponse.status,
            headers: { "Content-Type": transcribeResponse.headers.get("Content-Type") || "application/json" }
        });
    }
    let transcript = "";
    try {
        transcript = String(JSON.parse(transcribeRaw)?.text || "").trim();
    } catch (_) {
        throw httpError(502, "Groq transcription response was invalid.");
    }
    if (!transcript) throw httpError(422, "No speech was detected.");
    const transcribeMs = Date.now() - transcribeStartedAt;

    const marker = String(form.get("transcriptMarker") || "__PHONEBOT_TRANSCRIPT__");
    const finalUserMessage = chatBody.messages[chatBody.messages.length - 1];
    const replacement = replaceTranscriptMarker(finalUserMessage?.content, marker, transcript);
    if (!replacement.replaced) throw httpError(400, "Transcript marker is missing from the final user message.");
    finalUserMessage.content = replacement.content;

    const chatStartedAt = Date.now();
    const chatResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(chatBody)
    });
    const chatRaw = await chatResponse.text();
    if (!chatResponse.ok) {
        return new Response(chatRaw, {
            status: chatResponse.status,
            headers: { "Content-Type": chatResponse.headers.get("Content-Type") || "application/json" }
        });
    }
    let chatPayload;
    try {
        chatPayload = JSON.parse(chatRaw);
    } catch (_) {
        throw httpError(502, "Groq chat response was invalid.");
    }
    const rawContent =
        chatPayload?.choices?.[0]?.message?.content ??
        chatPayload?.choices?.[0]?.text ??
        chatPayload?.message?.content ??
        "";
    const contentText = stripThinkingBlocks(rawContent) || JSON.stringify(chatPayload);
    const spokenText = extractSpokenText(contentText);
    const chatMs = Date.now() - chatStartedAt;

    let audioBase64 = "";
    let audioType = "";
    const audioChunks = [];
    let speechMs = 0;
    let speechCharge = 0;
    const synthesizeSpeech = String(form.get("synthesizeSpeech") || "true") !== "false";
    if (synthesizeSpeech && spokenText) {
        const speechModel = String(form.get("speechModel") || "").trim();
        if (!sessionAllowsTtsModel(session, speechModel, env)) {
            throw httpError(400, "Speech model is not allowed.");
        }
        const voice = String(form.get("voice") || "autumn").trim() || "autumn";
        const speechParts = splitGroqSpeechInput(spokenText);
        const speechStartedAt = Date.now();
        for (const part of speechParts) {
            const speechResponse = await fetch("https://api.groq.com/openai/v1/audio/speech", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: speechModel,
                    voice,
                    input: part,
                    response_format: "wav"
                })
            });
            if (!speechResponse.ok) {
                const errorText = await speechResponse.text();
                return new Response(errorText, {
                    status: speechResponse.status,
                    headers: { "Content-Type": speechResponse.headers.get("Content-Type") || "application/json" }
                });
            }
            const audio = await speechResponse.arrayBuffer();
            const type = speechResponse.headers.get("Content-Type") || "audio/wav";
            const base64 = arrayBufferToBase64(audio);
            audioChunks.push({ base64, type });
            speechCharge += Math.max(1, Number(env.GROQ_SPEECH_CENTS) || 1);
        }
        speechMs = Date.now() - speechStartedAt;
        if (audioChunks.length) {
            audioBase64 = audioChunks[0].base64;
            audioType = audioChunks[0].type;
        }
    }

    const transcribeCharge = Math.max(1, Number(env.GROQ_TRANSCRIBE_CENTS) || 1);
    const chatCharge = calculateChatCharge(chatPayload.usage, chatBody.model, env, session);
    const totalCharge = transcribeCharge + chatCharge + speechCharge;
    await debitAiBudget(env, id, totalCharge);

    return json({
        transcript,
        contentText,
        spokenText,
        chat: chatPayload,
        audioBase64,
        audioType,
        audioChunks,
        chargeCents: totalCharge,
        timingsMs: {
            transcribe: transcribeMs,
            chat: chatMs,
            speech: speechMs,
            total: Date.now() - startedAt
        }
    });
}

function replaceTranscriptMarker(content, marker, transcript) {
    if (typeof content === "string") {
        return {
            content: content.includes(marker) ? content.replace(marker, transcript) : content,
            replaced: content.includes(marker)
        };
    }
    if (!Array.isArray(content)) return { content, replaced: false };
    let replaced = false;
    const next = content.map((part) => {
        if (!part || typeof part !== "object" || typeof part.text !== "string" || replaced) return part;
        if (!part.text.includes(marker)) return part;
        replaced = true;
        return { ...part, text: part.text.replace(marker, transcript) };
    });
    return { content: next, replaced };
}

function stripThinkingBlocks(text) {
    return String(text || "")
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
        .trim();
}

function extractSpokenText(contentText) {
    const content = String(contentText || "").trim();
    if (!content) return "";
    let payload = null;
    try {
        payload = JSON.parse(content);
    } catch (_) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                payload = JSON.parse(match[0]);
            } catch (_) {}
        }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return content;
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
    if (typeof payload.reply === "string" && payload.reply.trim()) return payload.reply.trim();
    if (typeof payload.text === "string" && payload.text.trim()) return payload.text.trim();
    if (Object.prototype.hasOwnProperty.call(payload, "actions")) return "";
    return content;
}

const GROQ_SPEECH_MAX_CHARS = 200;

function splitGroqSpeechInput(text, max = GROQ_SPEECH_MAX_CHARS) {
    const s = String(text || "").trim();
    if (!s) return [];
    if (s.length <= max) return [s];

    const chunks = [];
    let rest = s;
    const minBreak = Math.floor(max * 0.45);

    while (rest.length > 0) {
        if (rest.length <= max) {
            chunks.push(rest);
            break;
        }
        const window = rest.slice(0, max);
        let cut = max;

        for (let i = window.length - 1; i >= minBreak; i--) {
            const ch = window[i];
            if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
                cut = i + 1;
                break;
            }
        }
        if (cut === max) {
            const space = window.lastIndexOf(" ");
            if (space >= minBreak) cut = space;
        }

        const piece = rest.slice(0, cut).trim();
        if (!piece) break;
        chunks.push(piece);
        rest = rest.slice(cut).trim();
    }

    if (!chunks.length) {
        return [`${s.slice(0, max - 1)}…`];
    }
    return chunks;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function requireActiveAiSession(request, env) {
    if (!env.GROQ_API_KEY) throw httpError(503, "Hosted AI is not configured.");
    const id = cleanMetadata(request.headers.get("X-Play-Session"), 64);
    await expireSessionIfNeeded(env, id);
    const session = await selectSession(env, id);
    if (!session || session.status !== "active") {
        return json(
            { error: "A valid active play session is required.", session: session && publicSession(session) },
            402
        );
    }
    if (session.ai_budget_cents <= session.ai_spent_cents) {
        await pauseForPayment(env, id);
        const paused = await selectSession(env, id);
        return json({ error: "AI budget exhausted.", session: publicSession(paused) }, 402);
    }
    return { id, session };
}

async function debitAiBudget(env, id, charge) {
    await env.DB.prepare(
        `UPDATE play_sessions
         SET ai_spent_cents = MIN(ai_budget_cents, ai_spent_cents + ?),
             status = CASE WHEN ai_spent_cents + ? >= ai_budget_cents THEN 'paused_for_payment' ELSE status END
         WHERE id = ? AND status = 'active'`
    )
        .bind(charge, charge, id)
        .run();
}

function csvList(value, fallback) {
    const list = String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return list.length ? list : String(fallback || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function calculateChatCharge(usage, model, env, session = null) {
    let rates = {};
    try {
        rates = JSON.parse(env.GROQ_RATES_JSON || "{}");
    } catch (_) {}
    const resolved = parseResolvedModels(session);
    if (resolved?.rates && typeof resolved.rates === "object") {
        rates = { ...rates, ...resolved.rates };
    }
    const rate = rates[model] || {};
    const input = Math.max(0, Number(usage?.prompt_tokens) || 0);
    const output = Math.max(0, Number(usage?.completion_tokens) || 0);
    const cents =
        (input * (Number(rate.inputCentsPerMillion) || 0) +
            output * (Number(rate.outputCentsPerMillion) || 0)) /
        1_000_000;
    return Math.max(1, Math.ceil(cents));
}

async function pauseForPayment(env, id) {
    await env.DB.prepare(
        "UPDATE play_sessions SET status = 'paused_for_payment' WHERE id = ? AND status = 'active'"
    )
        .bind(id)
        .run();
}

async function expireSessionIfNeeded(env, id) {
    if (!id) return;
    await env.DB.prepare(
        `UPDATE play_sessions SET status = 'expired'
         WHERE id = ? AND status IN ('pending', 'paid', 'active', 'paused_for_payment') AND expires_at <= ?`
    )
        .bind(id, Date.now())
        .run();
}

async function selectSession(env, id) {
    if (!id) return null;
    return env.DB.prepare("SELECT * FROM play_sessions WHERE id = ?").bind(id).first();
}

function publicSession(row) {
    const resolved = parseResolvedModels(row);
    return {
        id: row.id,
        status: row.status,
        modeId: row.mode_id,
        robotSlug: row.robot_slug,
        ownerId: row.owner_id || undefined,
        machineId: row.machine_id || undefined,
        priceCents: row.price_cents,
        currency: row.currency,
        aiBudgetCents: row.ai_budget_cents,
        aiSpentCents: row.ai_spent_cents,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        startedAt: row.started_at || undefined,
        groqModels: resolved
            ? {
                  chat: resolved.chat || null,
                  vision: resolved.vision || null,
                  stt: resolved.stt || null,
                  tts: resolved.tts || null
              }
            : undefined
    };
}

async function stripeRequest(env, path, body, extraHeaders = {}) {
    if (!env.STRIPE_SECRET_KEY) throw httpError(503, "Stripe is not configured.");
    const response = await fetch(`https://api.stripe.com${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
            ...extraHeaders
        },
        body
    });
    const payload = await response.json();
    if (!response.ok) {
        console.error(JSON.stringify({ event: "stripe_error", status: response.status, type: payload.error?.type }));
        throw httpError(502, payload.error?.message || "Stripe request failed.");
    }
    return payload;
}

async function verifyStripeSignature(payload, header, secret) {
    if (!payload || !header || !secret) return false;
    const parts = header.split(",").map((part) => part.split("=", 2));
    const timestamp = parts.find(([key]) => key === "t")?.[1];
    const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
    if (!timestamp || !signatures.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
    );
    const data = new TextEncoder().encode(`${timestamp}.${payload}`);
    for (const signature of signatures) {
        const bytes = hexToBytes(signature);
        if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, data))) return true;
    }
    return false;
}

function hexToBytes(value) {
    if (!/^[0-9a-f]{64}$/i.test(value)) return null;
    return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
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

function allowedReturnUrl(value, request, env) {
    const fallback = new URL(request.headers.get("Origin") || request.url);
    const url = new URL(String(value || fallback.toString()));
    const allowed = allowedOrigins(env);
    if (allowed.length && !allowed.includes(url.origin)) throw httpError(400, "Return URL is not allowed.");
    url.searchParams.delete("play_session");
    url.searchParams.delete("payment");
    return url.toString();
}

function assertAllowedOrigin(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = allowedOrigins(env);
    if (origin && allowed.length && !allowed.includes(origin)) throw httpError(403, "Origin is not allowed.");
}

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

function corsResponse(request, env, response, status) {
    const result = response || new Response(null, { status: status || 204 });
    const origin = request.headers.get("Origin");
    if (origin && (!allowedOrigins(env).length || allowedOrigins(env).includes(origin))) {
        result.headers.set("Access-Control-Allow-Origin", origin);
        result.headers.set("Vary", "Origin");
        result.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Play-Session");
        result.headers.set("Access-Control-Expose-Headers", "X-Phonebot-AI-Charge-Cents");
        result.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    return result;
}

function cleanMetadata(value, maxLength) {
    return String(value || "")
        .replace(/[^\w .:@/-]/g, "")
        .trim()
        .slice(0, maxLength);
}

function json(value, status = 200) {
    return Response.json(value, { status });
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
