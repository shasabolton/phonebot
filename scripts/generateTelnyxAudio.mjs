/**
 * Telnyx versions of a character's game clips, played instead of the Groq clips while the Telnyx
 * agent is selected. Speaks the words of every message with a repo clip (a relative `audioUrl`) in
 * the character's `telnyxVoice`, saves them as `audio/telnyx/<clip>.mp3` in each game folder and
 * sets the message's `telnyxAudioUrl`. The Groq clips are left as they are.
 *
 * Usage (PowerShell — key stays in the terminal, not chat):
 *   $env:TELNYX_API_KEY = Read-Host "Paste Telnyx key"
 *   node scripts/generateTelnyxAudio.mjs lex
 *   Remove-Item Env:\TELNYX_API_KEY
 *
 * Flags:
 *   --force      overwrite existing clips
 *   --voice ID   use this Telnyx voice instead of the character's telnyxVoice
 *   --only a,b   only these games (folder names, e.g. menuMode,introduction)
 *   --delay MS   pause between requests (default 500)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const API_URL = "https://api.telnyx.com/v2/text-to-speech/speech";
const OUT_SUBDIR = "audio/telnyx";

function parseArgs(argv) {
    const out = { character: "", force: false, voice: "", only: null, delayMs: 500 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") out.force = true;
        else if (a === "--voice") out.voice = String(argv[++i] || "").trim();
        else if (a === "--delay") out.delayMs = Math.max(0, Number(argv[++i]) || 0);
        else if (a === "--only") {
            out.only = new Set(
                String(argv[++i] || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
            );
        } else if (!a.startsWith("--")) out.character = a;
    }
    return out;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** A path with no scheme or leading slash, i.e. a clip inside the game folder. */
function isRelative(url) {
    const raw = String(url || "").trim();
    return !!raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("/");
}

/** The words a clip says: older audio messages keep them in `text`, newer ones in `speechText`. */
function spokenWords(message) {
    const legacy = message.kind === "audio" || message.kind === "text";
    return String((legacy ? message.text : message.speechText || message.text) || "").trim();
}

/** Retries rate limits and Telnyx's generic synthesis failure (90103). */
async function synthesize(apiKey, voice, text, attempt = 1) {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice })
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500 || /90103/.test(errText)) && attempt <= 5) {
            const waitMs = Math.min(2 ** attempt, 30) * 1000;
            process.stdout.write(`HTTP ${res.status}, retrying in ${waitMs}ms… `);
            await sleep(waitMs);
            return synthesize(apiKey, voice, text, attempt + 1);
        }
        throw new Error(`Telnyx speech HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }
    if (/json/i.test(res.headers.get("content-type") || "")) {
        throw new Error(`Telnyx speech returned JSON instead of audio: ${(await res.text()).slice(0, 400)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 44) throw new Error("Telnyx speech returned empty audio.");
    return buf;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.character) {
        console.error("Name the character folder, e.g. node scripts/generateTelnyxAudio.mjs lex");
        process.exit(1);
    }
    const apiKey = String(process.env.TELNYX_API_KEY || "").trim();
    if (!apiKey) {
        console.error("Set TELNYX_API_KEY before running this script.");
        console.error('PowerShell: $env:TELNYX_API_KEY = Read-Host "Paste Telnyx key"');
        process.exit(1);
    }

    const characterDir = path.join(ROOT, "characters", args.character);
    const profile = readJson(path.join(characterDir, `${args.character}.json`));
    const voice = args.voice || String(profile.telnyxVoice || "").trim();
    if (!voice) {
        console.error(`${args.character}.json has no telnyxVoice; add one or pass --voice.`);
        process.exit(1);
    }

    const games = (Array.isArray(profile.games) ? profile.games : [])
        .map((g) => String((typeof g === "string" ? g.replace(/^game:/, "") : g?.id) || ""))
        .filter((id) => id && (!args.only || args.only.has(id)));
    console.log(`Voice ${voice}, ${games.length} game(s) of ${args.character}.`);

    let made = 0;
    let first = true;
    for (const id of games) {
        const gameDir = path.join(characterDir, "games", id);
        const gameFile = path.join(gameDir, `${id}.json`);
        if (!fs.existsSync(gameFile)) continue;
        const game = readJson(gameFile);
        const clips = (Array.isArray(game.messages) ? game.messages : []).filter(
            (m) => isRelative(m?.audioUrl) && spokenWords(m)
        );
        if (!clips.length) continue;

        const outDir = path.join(gameDir, ...OUT_SUBDIR.split("/"));
        fs.mkdirSync(outDir, { recursive: true });
        const manifest = [];
        for (const message of clips) {
            const stem = path.basename(message.audioUrl).replace(/\.[a-z0-9]{2,5}$/i, "");
            const file = `${stem}.mp3`;
            const outPath = path.join(outDir, file);
            const text = spokenWords(message);
            if (args.force || !fs.existsSync(outPath) || fs.statSync(outPath).size < 44) {
                if (!first) await sleep(args.delayMs);
                first = false;
                process.stdout.write(`${id}/${OUT_SUBDIR}/${file}… `);
                const mp3 = await synthesize(apiKey, voice, text);
                fs.writeFileSync(outPath, mp3);
                console.log(`${mp3.byteLength} bytes`);
                made += 1;
            } else {
                console.log(`${id}/${OUT_SUBDIR}/${file} already exists, skipped`);
            }
            message.telnyxAudioUrl = `${OUT_SUBDIR}/${file}`;
            manifest.push({ file, text });
        }
        writeJson(gameFile, game);
        writeJson(path.join(outDir, "files.json"), { voice, files: manifest });
    }
    console.log(`Done. ${made} clip(s) generated.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
