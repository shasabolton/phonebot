/**
 * Generate Menu Mode WAV clips via Groq Orpheus (Austin).
 *
 * Usage:
 *   set GROQ_API_KEY=gsk_...
 *   node scripts/generateMenuModeAudio.mjs
 *
 * Flags:
 *   --force      overwrite existing WAVs
 *   --delay MS   pause between requests (default 7000)
 *   --only a,b   regenerate only these filenames (comma-separated)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "games", "menuMode", "audio");
const API_URL = "https://api.groq.com/openai/v1/audio/speech";
const MODEL = "canopylabs/orpheus-v1-english";
const VOICE = "austin";

/** @type {{ file: string, text: string }[]} */
export const CLIPS = [
    {
        file: "intro.wav",
        text:
            "Hello there. I am your friendly talking head on the wall. I like to play word games, talk philosophy, and you should know, I am also a pretty good fortune teller. Please choose a game from the menu."
    },
    {
        file: "nudge-0.wav",
        text:
            "Wanna play Simon says, 20 questions, discuss the nature of reality, just pick a game from the menu."
    },
    {
        file: "nudge-1.wav",
        text: "Hey, did I mention, I can see the future. Just say the word and all will be revealed"
    },
    {
        file: "nudge-2a.wav",
        text: "Ok maybe you wanna hear a joke. Wana hear a joke. Ha? No."
    },
    {
        file: "nudge-2b.wav",
        text: "You don't like fun and frivality. Come on, just pick something from the menu"
    },
    {
        file: "nudge-3.wav",
        text: "Okay lets see who can hold their breath the longest. Ready. 1, 2, 3, go"
    },
    {
        file: "nudge-4.wav",
        text: "Oh I could do this all day. You are looking at a breath holding champion."
    },
    {
        file: "nudge-5.wav",
        text: "Is anybody out there. Who will play with me"
    }
];

function parseArgs(argv) {
    const out = { force: false, delayMs: 7000, only: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") out.force = true;
        else if (a === "--delay") out.delayMs = Math.max(0, Number(argv[++i]) || 0);
        else if (a === "--only") {
            out.only = new Set(
                String(argv[++i] || "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
            );
        }
    }
    return out;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function synthesize(apiKey, text, attempt = 1) {
    const res = await fetch(API_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: MODEL,
            voice: VOICE,
            input: text,
            response_format: "wav"
        })
    });
    if (res.status === 429 && attempt <= 10) {
        const errText = await res.text().catch(() => "");
        const match = /try again in ([0-9.]+)s/i.exec(errText);
        const waitSec = match ? Number(match[1]) : Math.min(2 ** attempt, 30);
        const waitMs = Math.ceil((Number.isFinite(waitSec) ? waitSec : 6) * 1000) + 750;
        process.stdout.write(`rate-limited, wait ${waitMs}ms… `);
        await sleep(waitMs);
        return synthesize(apiKey, text, attempt + 1);
    }
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 44) throw new Error("TTS returned empty audio.");
    return buf;
}

function writeManifest() {
    const files = CLIPS.filter((c) => {
        const p = path.join(OUT_DIR, c.file);
        return fs.existsSync(p) && fs.statSync(p).size >= 44;
    }).map((c) => ({ file: c.file, text: c.text }));
    fs.writeFileSync(
        path.join(OUT_DIR, "files.json"),
        JSON.stringify({ voice: VOICE, model: MODEL, files }, null, 2) + "\n"
    );
    return files.length;
}

async function main() {
    const apiKey = String(process.env.GROQ_API_KEY || "").trim();
    if (!apiKey) {
        console.error("Set GROQ_API_KEY before running this script.");
        process.exit(1);
    }

    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const clips = args.only
        ? CLIPS.filter((c) => args.only.has(c.file))
        : CLIPS.slice();
    if (!clips.length) {
        console.error("No clips matched --only filter.");
        process.exit(1);
    }

    console.log(`Generating ${clips.length} clips → ${OUT_DIR}, delay ${args.delayMs}ms`);

    for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const outPath = path.join(OUT_DIR, clip.file);
        if (!args.force && fs.existsSync(outPath) && fs.statSync(outPath).size >= 44) {
            console.log(`[${i}] Skipping ${clip.file} (already exists)`);
            continue;
        }
        process.stdout.write(`[${i}] Generating ${clip.file}… `);
        const wav = await synthesize(apiKey, clip.text);
        fs.writeFileSync(outPath, wav);
        console.log(`${wav.byteLength} bytes`);
        if (i < clips.length - 1) await sleep(args.delayMs);
    }

    const have = writeManifest();
    console.log(`Done. Manifest has ${have}/${CLIPS.length} clips.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
