"""
Generate Simon Says Pose Match clips via Microsoft Edge neural TTS (free).
Uses a firm male voice as an Austin substitute — no Groq key required.

Usage:
  python scripts/generateSimonSaysAudio.py
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import edge_tts

OUT_DIR = Path(__file__).resolve().parent.parent / "simonSays" / "audio"
# Firm, clear US male — closer to a commanding Simon than default SAPI.
VOICE = "en-US-ChristopherNeural"
RATE = "+8%"
PITCH = "-5Hz"

CLIPS = [
    (
        "opening.mp3",
        "Hello, Let's play a game of Simon Says! First to three wins.",
    ),
    ("simon-says.mp3", "Simon Says"),
    ("put-your.mp3", "Put your"),
    ("on-your.mp3", "on your"),
    ("left-hand.mp3", "left hand"),
    ("right-hand.mp3", "right hand"),
    ("nose.mp3", "nose"),
    ("left-ear.mp3", "left ear"),
    ("right-ear.mp3", "right ear"),
    ("left-shoulder.mp3", "left shoulder"),
    ("right-shoulder.mp3", "right shoulder"),
    ("left-elbow.mp3", "left elbow"),
    ("right-elbow.mp3", "right elbow"),
    ("left-hip.mp3", "left hip"),
    ("right-hip.mp3", "right hip"),
    ("left-foot.mp3", "left foot"),
    ("right-foot.mp3", "right foot"),
    ("wrong-pose-0.mp3", "Wrong pose. Try again."),
    ("wrong-pose-1.mp3", "That doesn't look right. Try again."),
    ("wrong-pose-2.mp3", "Not quite. Give it another go."),
    ("wrong-pose-3.mp3", "Hmm, that's not it. Try once more."),
    ("wrong-pose-4.mp3", "Almost? Nope. Try again."),
    (
        "gotcha-0.mp3",
        "Hey, Simon did not say to do it. Got you. That's a point for me",
    ),
    ("gotcha-1.mp3", "Gotcha — Simon never said that. Point for me."),
    ("gotcha-2.mp3", "Nice try, but Simon didn't say. That's mine."),
    ("gotcha-3.mp3", "Ah ah ah — no Simon says. I score."),
    ("gotcha-4.mp3", "You moved and Simon didn't say. Point to Simon."),
    ("point-to-you.mp3", "A point to you."),
    ("score-simon.mp3", "Simon"),
    ("score-you.mp3", "you"),
    ("num-0.mp3", "zero"),
    ("num-1.mp3", "one"),
    ("num-2.mp3", "two"),
    ("num-3.mp3", "three"),
    ("num-4.mp3", "four"),
    ("num-5.mp3", "five"),
    ("you-win.mp3", "You win!"),
    ("simon-wins.mp3", "Simon wins. Better luck next time."),
]


async def synthesize(path: Path, text: str) -> None:
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
    await communicate.save(str(path))


async def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Drop leftover Groq WAVs so we don't mix voices.
    for old in OUT_DIR.glob("*.wav"):
        old.unlink()
        print(f"Removed {old.name}")

    manifest = []
    for filename, text in CLIPS:
        out = OUT_DIR / filename
        print(f"Generating {filename}…", end=" ", flush=True)
        await synthesize(out, text)
        size = out.stat().st_size
        print(f"{size} bytes")
        manifest.append({"file": filename, "text": text})
        await asyncio.sleep(0.15)

    (OUT_DIR / "files.json").write_text(
        json.dumps(
            {"voice": VOICE, "rate": RATE, "pitch": PITCH, "files": manifest},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Done. Wrote {len(CLIPS)} clips to {OUT_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
