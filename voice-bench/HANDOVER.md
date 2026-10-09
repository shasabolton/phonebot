# Telnyx voice handover

Notes for an agent adding Telnyx to the phonebot app. The owner will ask for one feature at a time, so this is
background and decisions, not a plan. Read it before touching the app, and check anything marked *unverified*.

`voice-bench/` is a separate local test bench (`npm run dev` in this folder, page on `http://localhost:8787`).
It compares Groq-replacement voice loops: Telnyx (upload), Telnyx (streaming) and Workers AI. It is never deployed
and never changes the app. Its code is the working reference for every Telnyx call described here.

## Owner decisions

- **Keep Groq.** Telnyx is added as another choice in the app's **Agent** dropdown; Groq stays as it is and remains
  the fallback.
- **Streaming is for game turns** (spoken conversation turns in games). Scripts typed in the message editor do not
  need streaming; plain (REST) Telnyx speech is fine there.
- **Players may use their own Telnyx key**, entered in the same "API key (this provider)" box as other keys. If the
  browser cannot talk to Telnyx directly, the key is forwarded to the Worker, which makes the Telnyx calls with it.
  With the box empty, hosted credit is used, as with Groq.
- **Pricing is not settled.** The owner's Telnyx account showed about **US$0.14** used after all bench testing
  (hundreds of turns, several 5-way parallel runs and some Voice Design samples). Charging players around **$1 for
  that much use** would be good value for them and safely inside the margin. Nobody has yet worked out which
  Telnyx line items make up the 14 cents (chat tokens, speech-to-text minutes, speech characters, voice design), so
  find that out before building the meter. See [Pricing](#pricing-and-charging).

## What the bench measured

Times are from letting go of the talk button to the first reply audio ("Reply starts").

| Setup | Reply starts | Notes |
| --- | --- | --- |
| Telnyx upload (Whisper → chat → REST voice) | ~3.3 s | Speech-to-text ~1.2 s, chat ~0.95 s, voice first byte ~1.1 s |
| Telnyx streaming, one-sentence replies | ~2.8–3.1 s | Voice cannot start until the sentence ends |
| Telnyx streaming, reply opens with a short sentence ("Okay.") | **~2.1–2.6 s** | Best result |
| 5 streamed conversations at once | 2.1–2.6 s for 4 of 5 | One took 5.3 s (slow Telnyx voice, no error) |
| Workers AI (for comparison) | ~3.4–3.9 s | Dropped: dearer per turn at scale |

Where the streamed time goes: transcript ready 0.3–0.5 s after release; chat's first words ~0.8 s later; voice's
first audio ~1.0 s after it receives a complete sentence.

Findings that should shape the app:

- **Streaming speech-to-text is the clear win** (~1 s saved over uploading the clip).
- **Streaming speech only helps when the first sentence is short.** Telnyx starts speaking at a full stop, `?` or
  `!`, not mid-sentence. The owner will handle this in prompts ("start with a short acknowledgement").
- **Voice choice matters little.** First-audio delay after a complete sentence: MiniMax ~1.0 s, Azure ~1.0 s,
  xAI ~1.1 s, AWS Polly ~1.25 s, Soniox ~1.5 s, Kokoro 1.0–1.45 s. Most of it is Telnyx overhead.
- **Occasional slow or failed voice responses**: first audio sometimes 3–5 s late; `timeout` or `Internal Server
  Error` from the streaming voice happened a few times, twice while another voice request was running on the same
  trial account. Plan for a retry and a fallback (Groq or the browser voice).
- **Concurrency**: 5 simultaneous streamed conversations worked on the trial account. Larger numbers are untested.

## Telnyx API as used by the bench

All under `https://api.telnyx.com/v2`, header `Authorization: Bearer <key>`.

| Purpose | Call | Bench code |
| --- | --- | --- |
| Chat (OpenAI-compatible, streamed) | `POST /ai/openai/chat/completions` | `runTelnyxTurn`, `TelnyxStreamSession.runChat` |
| Chat model list | `GET /ai/models` (`data[].id`) | `handleTelnyxModels` |
| Speech-to-text, file | `POST /ai/audio/transcriptions` (multipart `file`, `model=openai/whisper-large-v3-turbo`) | `runTelnyxTurn`, `transcribeRecording` |
| Speech-to-text, streaming | WebSocket `/speech-to-text/transcription?transcription_engine=Deepgram&model=nova-3&input_format=linear16&sample_rate=16000&interim_results=true` | `TelnyxStreamSession.start` |
| Speech, REST | `POST /text-to-speech/speech` `{text, voice}` → MP3 | `fetchTelnyxSpeech` |
| Speech, streaming | WebSocket `/text-to-speech/speech?voice=…&audio_format=mp3&inactivity_timeout=60` | `TelnyxStreamSession.attachSpeech` |
| Voice list | `GET /text-to-speech/voices?provider=telnyx\|minimax\|aws\|azure\|xai\|soniox` | `handleTelnyxVoices` |
| Voice Design | `POST /voice_designs`, `GET /voice_designs/{id}/sample?version=N`, `POST /voice_clones` | `handleVoiceDesign`, `handleVoiceClone` |

Streaming speech-to-text protocol: send binary 16 kHz mono 16-bit PCM frames (the bench sends ≥3200 bytes each).
On release send `{"type":"Finalize"}` (Deepgram only) then `{"type":"CloseStream"}`; Telnyx flushes and closes.
Replies: `{transcript, is_final, speech_final, confidence}`; errors: `{errors:[{code, detail}]}`.

Streaming speech protocol: send `{"text":" "}` first, then text pieces as the chat writes them, adding
`"flush": true` on a piece that ends a sentence, then `{"text":""}` to finish (Telnyx flushes and closes).
Replies: `{audio:<base64 MP3>, text, isFinal}`; a final frame has `audio:null`; errors: `{error}`.

Voice IDs look like `Telnyx.KokoroTTS.af_heart`, `Telnyx.Ultra.Clara`, `Minimax.<model>.<id>`, or a designed
voice `Telnyx.Qwen3TTS.<clone id>`.

## Gotchas already paid for

- **Ultra voices are REST only**: the streaming voice WebSocket refuses them (403). Kokoro, MiniMax, Azure, Polly,
  xAI, Soniox and designed Qwen3TTS voices stream.
- **Ask for MP3** from the streaming voice. Requesting `linear16` still produced data the page played as static.
- **Workers WebSockets deliver binary as `Blob`** unless `server.binaryType = "arraybuffer"`; the bench also
  converts any `Blob`. Without this Telnyx received 0 bytes.
- **Process page messages in order** (a promise chain) so the release message cannot overtake the last audio.
- **Open both Telnyx sockets when the player starts talking**: connecting takes ~1.1–1.3 s and is hidden while
  they speak. One-word answers shorter than that still pay the remainder. A real call could keep them open.
- **Short answers** ("yes", "no") came back empty from Deepgram until the Worker appended 0.3 s of silence before
  `Finalize`. The bench also falls back to file transcription (Whisper) if the stream hears nothing.
- **Start the chat as soon as a final transcript arrives after release**, rather than waiting for the
  speech-to-text socket to close (saves ~0.3 s).
- **Retry the voice once** if it errors or closes before any audio, resending everything said so far.
- **Browser playback of streamed MP3** uses MediaSource (`audio/mpeg`) so it plays as pieces arrive
  (`startMp3Player` in `bench.js`), with a play-at-end fallback.
- **Microphone capture** for streaming uses an AudioWorklet (`public/pcm-capture.js`) and a box-filter resampler
  to 16 kHz (`createResampler` in `bench.js`).
- **Chat models**: some Telnyx models return empty or cut-off replies when reasoning is on; the bench sends
  `chat_template_kwargs: {enable_thinking: false}` except for Mistral models, which reject it.

## The app today (integration points)

Check these yourself; the summary is from a quick read.

- **Agent dropdown**: `agents` arrays in each robot's `agentInterface` config in `robots.js` (currently one Groq
  agent with `baseUrl`, `model`, `transcriptionModel`, `speechModel`). `agentInterface.js` renders the dropdown
  (`robotAgentSelect`) and treats `provider: "gemini"` agents specially, so a Telnyx agent will need its own
  provider handling for chat, transcription and speech.
- **Keys**: one "API key (this provider)" box, saved per agent name (`_persistKeyForAgent`). Today a player's own
  key calls the provider straight from the browser; a blank box uses hosted credit through the Worker.
- **Hosted Worker routes** (`worker/src/index.js`): `/api/ai/chat`, `/api/ai/transcribe`, `/api/ai/speech` and
  `/api/ai/voice-turn` (one request for transcribe → chat → speech on game turns), each behind
  `assertAllowedOrigin` and play-session checks, debiting credit. See "Arcade billing" in the root `readme.md`.
- **Billing** (`playBilling.js`, D1 sessions): prices come from Groq's live model list at session start, converted
  to AUD, marked up by `ARCADE_AI_MARKUP` (default 2), minimum one cent per hosted call, A$10 credit cap.
- **Speech output**: provider TTS → `audioPlayer.js` → `audioMouthFilter.js` (drives the mouth servo) with
  `voiceFx.js` effects, falling back to the browser voice. Streamed Telnyx audio must feed the same path.
- **Speech input**: `speechToText.js`, `microphone.js`; game turns record up to 20 s.
- **Typed scripts**: `games/custom/customMessages.js` speaks message-editor text (no streaming needed).

## Keys and security

- Hosted Telnyx calls use a Worker secret (`npx wrangler secret put TELNYX_API_KEY`, and `worker/.dev.vars`
  locally). Never commit keys or log them.
- The bench passes the key from the page inside the WebSocket `start` message; that is only acceptable because it
  runs locally. In the app, a player's own key may be forwarded the same way over HTTPS/WSS, but the hosted key
  must never reach the browser.
- New Worker routes (including any WebSocket route) need the same origin and play-session checks as the existing
  `/api/ai/*` routes.

## Pricing and charging

- Things that probably cost money: chat tokens (input and output), speech-to-text audio time (streaming is likely
  billed for connection or audio duration), speech characters, voice design samples. Confirm against Telnyx's
  pricing page and the account's usage report before deciding what to meter.
- The bench estimated roughly US$0.00075 per turn; the owner's 14 cents is consistent with that, but it is an
  estimate.
- To meter streamed turns: count seconds of audio sent to speech-to-text, characters sent to the voice, and chat
  usage (try `stream_options: {include_usage: true}` so the stream reports tokens; unverified on Telnyx). Report them when the
  turn ends and debit once, as `voice-turn` does today.
- A separate Telnyx markup setting (rather than reusing the Groq rate list) lets the owner tune the "$1 for 14
  cents" target. Telnyx has no live price list in its model API like Groq's, so rates will probably need to be
  configuration.
- A useful check: run a known number of turns, compare the Worker's metered cost with the Telnyx usage report.

## Unverified, check before relying on it

- Whether Telnyx's REST API allows direct browser calls (CORS). If not, a player's own key goes through the Worker.
- Browser WebSockets cannot set an `Authorization` header, so streaming with a player's own key almost certainly
  has to go through the Worker unless Telnyx accepts another auth method.
- Streaming through the **deployed** Worker: the bench only ran under `wrangler dev`. Check the Free plan CPU
  limit (10 ms per request) and connection behaviour on a long WebSocket session before depending on it.
- Concurrency above 5 conversations, and whether a paid Telnyx account removes the voice timeouts seen on trial.
- Exact Telnyx rates and how usage appears on the bill.

## Using the bench to re-check things

- Telnyx key goes in the page (not a file). Workers AI needs `BENCH_PASSCODE` in the git-ignored `.dev.vars`.
- Under each turn a timeline shows speaking, speech-to-text, chat, voice and audio out on one time scale.
- **Re-run last recording** replays the same clip, for fair comparisons between settings.
- **Stream last recording as N conversations at once** is the concurrency test.
- The Worker log (terminal running `npm run dev`) prints each streaming stage with a session ID and timing.
- The **Design a Telnyx voice** panel creates and saves Qwen3TTS or MiniMax voices from a typed description.
