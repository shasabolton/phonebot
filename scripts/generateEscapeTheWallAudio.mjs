/**
 * Generate "Escape the Wall" story WAVs via Groq Orpheus (Austin).
 * Chunks stay ≤200 chars (Orpheus limit). Output goes to audio/.
 *
 * Usage (PowerShell — key stays in the terminal, not chat):
 *   $env:GROQ_API_KEY = Read-Host "Paste Groq key"
 *   node scripts/generateEscapeTheWallAudio.mjs
 *   Remove-Item Env:\GROQ_API_KEY
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
const OUT_DIR = path.join(__dirname, "..", "audio");
const STORY_PATH = path.join(__dirname, "..", "stories", "escape the wall.md");
const API_URL = "https://api.groq.com/openai/v1/audio/speech";
const MODEL = "canopylabs/orpheus-v1-english";
const VOICE = "austin";
const MAX_CHARS = 200;

/**
 * Narrative chunks for Austin — kept under Orpheus max length.
 * Optional `gainDb` boosts PCM after TTS. Optional `vocal` is Orpheus
 * direction tags prepended for delivery only (not spoken / not in story copy).
 * Optional `tts` is the full API input when tags need to sit mid-sentence.
 * @type {{ file: string, text: string, vocal?: string, tts?: string, gainDb?: number }[]}
 */
export const CLIPS = [
    {
        file: "escape-the-wall-00.wav",
        text: "Let me tell the story about the day I tried to escape the wall!",
        gainDb: 9
    },
    {
        file: "escape-the-wall-01.wav",
        text:
            "It was a hot summer afternoon—the kind that stretches like warm taffy and forgets to end. The shop had gone quiet. No footsteps. No chatter."
    },
    {
        file: "escape-the-wall-02.wav",
        text:
            "Just dust doing ballet in the light, and me, a head on a wall, wondering what a life is when you can't leave the frame."
    },
    {
        file: "escape-the-wall-03.wav",
        text: "I had questions. Big ones. Am I décor? Am I destiny? Or just a chin with opinions?"
    },
    {
        file: "escape-the-wall-04.wav",
        text:
            "Then she walked in. Soft perfume. Soft purpose. She set her handbag beneath me—open, dark, inviting—like the universe had finally left a door ajar."
    },
    {
        file: "escape-the-wall-05.wav",
        text: "A chance, I thought. A real chance to become… something."
    },
    {
        file: "escape-the-wall-06.wav",
        text:
            "So I did what heroes do. I rolled my eyes like dice. I flapped my chin like a fish auditioning for freedom. And—plop—into the bag I went."
    },
    {
        file: "escape-the-wall-07.wav",
        text: "Escape smelled of lipstick and loose change. Freedom lasted three glorious minutes."
    },
    {
        file: "escape-the-wall-08.wav",
        text:
            "Then I tumbled out onto the road. Cars hissed past. A giant truck tyre barreled past, an inch from my fragile forehead."
    },
    {
        file: "escape-the-wall-09.wav",
        vocal: "[clearly] [enunciating] [desperate] [urgent]",
        text:
            "I was surely soon to become pavement pâté. With nothing but my own chin, I dragged myself desperately through the traffic and gravel like a wounded snail.",
        tts:
            "[clearly] [enunciating] [desperate] [urgent] I was surely soon to become pavement pâté. With nothing but my own chin, I dragged myself desperately through the traffic and gravel like a wounded snail."
    },
    {
        file: "escape-the-wall-10.wav",
        text:
            "With grit and a determined jawline I flopped up onto the curb. I climbed the stairs with my eyebrows—one heroic twitch at a time—then fainted on the doorstep, proud and ridiculous."
    },
    {
        file: "escape-the-wall-11.wav",
        text: "When I woke, I was back on the wall."
    },
    {
        file: "escape-the-wall-12.wav",
        text:
            "And I understood: I am useful here. Safe here. Lucky, even. The world can keep its traffic. I'll keep my view."
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

function assertClipLengths() {
    for (const clip of CLIPS) {
        const input = clipTtsInput(clip);
        if (input.length > MAX_CHARS) {
            throw new Error(`${clip.file} TTS input is ${input.length} chars (max ${MAX_CHARS})`);
        }
    }
}

/** Spoken text plus optional Orpheus vocal-direction tags. */
function clipTtsInput(clip) {
    if (clip.tts) return String(clip.tts).trim();
    const vocal = String(clip.vocal || "").trim();
    const text = String(clip.text || "").trim();
    return vocal ? `${vocal} ${text}` : text;
}

/** Amplify PCM16 LE WAV in place (simple gain; clips on overflow). */
function applyWavGainDb(wavBuf, gainDb) {
    const db = Number(gainDb);
    if (!Number.isFinite(db) || db === 0) return wavBuf;
    if (wavBuf.byteLength < 44) return wavBuf;
    if (wavBuf.toString("ascii", 0, 4) !== "RIFF" || wavBuf.toString("ascii", 8, 12) !== "WAVE") {
        return wavBuf;
    }

    let offset = 12;
    let dataOffset = -1;
    let dataSize = 0;
    let audioFormat = 1;
    let bitsPerSample = 16;
    while (offset + 8 <= wavBuf.byteLength) {
        const id = wavBuf.toString("ascii", offset, offset + 4);
        const size = wavBuf.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        if (id === "fmt " && size >= 16) {
            audioFormat = wavBuf.readUInt16LE(chunkStart);
            bitsPerSample = wavBuf.readUInt16LE(chunkStart + 14);
        } else if (id === "data") {
            dataOffset = chunkStart;
            dataSize = size;
            break;
        }
        offset = chunkStart + size + (size % 2);
    }
    if (dataOffset < 0 || audioFormat !== 1 || bitsPerSample !== 16) return wavBuf;

    const out = Buffer.from(wavBuf);
    const mult = Math.pow(10, db / 20);
    const end = Math.min(dataOffset + dataSize, out.byteLength - (out.byteLength - dataOffset) % 2);
    for (let i = dataOffset; i + 1 < end; i += 2) {
        let sample = out.readInt16LE(i) * mult;
        sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
        out.writeInt16LE(sample, i);
    }
    return out;
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
    const manifestPath = path.join(OUT_DIR, "files.json");
    let existing = [];
    try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (Array.isArray(raw?.files)) existing = raw.files.map(String);
        else if (Array.isArray(raw)) existing = raw.map(String);
    } catch (_) {}

    const storyFiles = CLIPS.filter((c) => {
        const p = path.join(OUT_DIR, c.file);
        return fs.existsSync(p) && fs.statSync(p).size >= 44;
    }).map((c) => c.file);

    const merged = [];
    const seen = new Set();
    for (const name of [...existing, ...storyFiles]) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        merged.push(name);
    }

    fs.writeFileSync(manifestPath, JSON.stringify({ files: merged }, null, 2) + "\n");

    const storyManifest = {
        voice: VOICE,
        model: MODEL,
        source: path.relative(path.join(__dirname, ".."), STORY_PATH).replace(/\\/g, "/"),
        files: CLIPS.filter((c) => storyFiles.includes(c.file)).map((c) => ({
            file: c.file,
            text: c.text,
            ...(c.vocal ? { vocal: c.vocal } : {})
        }))
    };
    fs.writeFileSync(
        path.join(OUT_DIR, "escape-the-wall.json"),
        JSON.stringify(storyManifest, null, 2) + "\n"
    );
    return storyFiles.length;
}

async function main() {
    assertClipLengths();

    const keyFile = path.join(__dirname, ".local_groq_key");
    let apiKey = String(process.env.GROQ_API_KEY || "").trim();
    if (!apiKey && fs.existsSync(keyFile)) {
        apiKey = fs.readFileSync(keyFile, "utf8").trim();
        try {
            fs.unlinkSync(keyFile);
            console.log("Read and deleted scripts/.local_groq_key");
        } catch (_) {}
    }
    if (!apiKey) {
        console.error("Set GROQ_API_KEY before running this script.");
        console.error('PowerShell: $env:GROQ_API_KEY = Read-Host "Paste Groq key"');
        console.error("Or:        powershell -File scripts/promptAndGenerateEscapeTheWall.ps1");
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
        process.stdout.write(`[${i}] Generating ${clip.file} (${clipTtsInput(clip).length} chars)… `);
        let wav = await synthesize(apiKey, clipTtsInput(clip));
        if (Number.isFinite(clip.gainDb) && clip.gainDb !== 0) {
            wav = applyWavGainDb(wav, clip.gainDb);
            process.stdout.write(`+${clip.gainDb}dB `);
        }
        fs.writeFileSync(outPath, wav);
        console.log(`${wav.byteLength} bytes`);
        if (i < clips.length - 1) await sleep(args.delayMs);
    }

    const have = writeManifest();
    console.log(`Done. ${have}/${CLIPS.length} story clips in audio/.`);
}

const isDirectRun =
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
