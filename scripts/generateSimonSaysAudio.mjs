/**
 * Generate Simon Says Pose Match WAV clips via Groq Orpheus (Austin).
 *
 * Usage:
 *   set GROQ_API_KEY=gsk_...
 *   node scripts/generateSimonSaysAudio.mjs --offset 0 --limit 7
 *   node scripts/generateSimonSaysAudio.mjs --offset 7 --limit 7
 *   node scripts/generateSimonSaysAudio.mjs --offset 14 --limit 7
 *   node scripts/generateSimonSaysAudio.mjs --offset 21 --limit 6
 *
 * Flags:
 *   --offset N   start index (default 0)
 *   --limit N    max clips this run (default all remaining)
 *   --force      overwrite existing WAVs
 *   --delay MS   pause between requests (default 7000)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "simonSays", "audio");
const API_URL = "https://api.groq.com/openai/v1/audio/speech";
const MODEL = "canopylabs/orpheus-v1-english";
const VOICE = "austin";

/** @type {{ file: string, text: string }[]} */
export const CLIPS = [
    {
        file: "opening.wav",
        text: "Hello, Let's play a game of Simon Says! First to three wins."
    },
    { file: "simon-says.wav", text: "Simon Says" },
    { file: "put-your.wav", text: "Put your" },
    { file: "on-your.wav", text: "on your" },

    { file: "left-hand.wav", text: "left hand" },
    { file: "right-hand.wav", text: "right hand." },
    { file: "nose.wav", text: "nose" },
    { file: "left-ear.wav", text: "left ear!" },
    { file: "right-ear.wav", text: "right ear" },
    { file: "left-shoulder.wav", text: "left shoulder" },
    { file: "right-shoulder.wav", text: "right shoulder" },
    { file: "left-elbow.wav", text: "left elbow" },
    { file: "right-elbow.wav", text: "right elbow" },
    { file: "left-hip.wav", text: "left hip" },
    { file: "right-hip.wav", text: "right hip" },
    { file: "left-foot.wav", text: "left foot" },
    { file: "right-foot.wav", text: "Right foot!" },

    { file: "wrong-pose-0.wav", text: "Wrong pose. Try again." },
    { file: "wrong-pose-1.wav", text: "That doesn't look right. Try again." },
    { file: "wrong-pose-2.wav", text: "Not quite. Give it another go." },
    { file: "wrong-pose-3.wav", text: "Hmm, that's not it. Try once more." },
    { file: "wrong-pose-4.wav", text: "Almost? Nope. Try again." },

    {
        file: "gotcha-0.wav",
        text: "Hey, Simon did not say to do it. Got you. That's a point for me"
    },
    { file: "gotcha-1.wav", text: "Gotcha — Simon never said that. Point for me." },
    { file: "gotcha-2.wav", text: "Nice try, but Simon didn't say. That's mine." },
    { file: "gotcha-3.wav", text: "Ah ah ah — no Simon says. I score." },
    { file: "gotcha-4.wav", text: "You moved and Simon didn't say. Point to Simon." },

    { file: "point-to-you.wav", text: "A point to you." },
    { file: "score-simon.wav", text: "Simon" },
    { file: "score-you.wav", text: "you" },
    { file: "num-0.wav", text: "zero" },
    { file: "num-1.wav", text: "one" },
    { file: "num-2.wav", text: "two." },
    { file: "num-3.wav", text: "three" },
    { file: "num-4.wav", text: "four" },
    { file: "num-5.wav", text: "five" },
    { file: "you-win.wav", text: "You win!" },
    { file: "simon-wins.wav", text: "Simon wins. Better luck next time." },

    {
        file: "step-back.wav",
        text: "Please take a step back so I can see from your waist to your head."
    }
];

function parseArgs(argv) {
    const out = { offset: 0, limit: Infinity, force: false, delayMs: 7000 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") out.force = true;
        else if (a === "--offset") out.offset = Math.max(0, Number(argv[++i]) || 0);
        else if (a === "--limit") out.limit = Math.max(1, Number(argv[++i]) || 1);
        else if (a === "--delay") out.delayMs = Math.max(0, Number(argv[++i]) || 0);
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

    const slice = CLIPS.slice(args.offset, args.offset + args.limit);
    console.log(
        `Section: index ${args.offset}..${args.offset + slice.length - 1} ` +
            `(${slice.length} of ${CLIPS.length}), delay ${args.delayMs}ms, force=${args.force}`
    );

    for (let i = 0; i < slice.length; i++) {
        const clip = slice[i];
        const outPath = path.join(OUT_DIR, clip.file);
        if (!args.force && fs.existsSync(outPath) && fs.statSync(outPath).size >= 44) {
            console.log(`[${args.offset + i}] Skipping ${clip.file} (already exists)`);
            continue;
        }
        process.stdout.write(`[${args.offset + i}] Generating ${clip.file}… `);
        const wav = await synthesize(apiKey, clip.text);
        fs.writeFileSync(outPath, wav);
        console.log(`${wav.byteLength} bytes`);
        if (i < slice.length - 1) await sleep(args.delayMs);
    }

    const have = writeManifest();
    console.log(`Section done. Manifest has ${have}/${CLIPS.length} clips in ${OUT_DIR}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
