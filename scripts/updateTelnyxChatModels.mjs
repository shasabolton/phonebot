/**
 * Builds the tested Telnyx chat model shortlist from scratch: every chat model that passes the
 * automatic filters (priced, run by Telnyx, big enough) gets three game-like test turns, the fastest
 * four that pass become the shortlist and the other passes the reserves, in the Worker's D1 table
 * telnyx_chat_models. After that the Worker keeps the list current by itself during play (see
 * worker/src/telnyxChatModels.js); rerun this to start again, e.g. when the reserves run out.
 *
 * Usage (PowerShell, from the repo root). The key is read from worker/.dev.vars
 * (TELNYX_API_KEY=KEY...; git ignores that file) or from the environment:
 *   node scripts/updateTelnyxChatModels.mjs            test, then write to the deployed Worker's D1
 *   node scripts/updateTelnyxChatModels.mjs --dry-run  test and print the report only
 *   node scripts/updateTelnyxChatModels.mjs --local    write to the local D1 used by `wrangler dev`
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
    SHORTLIST_SIZE,
    TEST_TURNS,
    fetchChatModelList,
    rankChatCandidates,
    testChatTurn
} from "../worker/src/telnyxChatCheck.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");
const DATABASE = "phonebot-arcade";
const CONCURRENCY = 3;

function readKey() {
    const fromEnv = String(process.env.TELNYX_API_KEY || "").trim();
    if (fromEnv) return fromEnv;
    try {
        const vars = fs.readFileSync(path.join(WORKER_DIR, ".dev.vars"), "utf8");
        const match = /^\s*TELNYX_API_KEY\s*=\s*"?([^"\r\n]+)"?\s*$/m.exec(vars);
        if (match) return match[1].trim();
    } catch (_) {}
    return "";
}

/** All three turns; a timeout or server error gets one retry. Stops at the first turn that fails. */
async function testModel(apiKey, id) {
    const results = [];
    for (const turn of TEST_TURNS) {
        let result = await testChatTurn(apiKey, id, turn);
        if (result.kind === "transient") result = await testChatTurn(apiKey, id, turn);
        results.push({ turn: turn.name, ...result });
        if (result.kind !== "pass") break;
    }
    const failed = results.find((r) => r.kind !== "pass");
    const times = results.map((r) => r.ms).sort((a, b) => a - b);
    return {
        id,
        kind: failed ? failed.kind : "pass",
        reason: failed ? `${failed.turn}: ${failed.reason}` : "",
        medianMs: times[Math.floor(times.length / 2)] ?? null,
        sample: results.find((r) => r.reply)?.reply || ""
    };
}

async function mapLimited(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

const sql = (value) => (value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

function buildSql(shortlist, reserves, rejected, now) {
    const lines = ["DELETE FROM telnyx_chat_models;"];
    const row = (id, status, rank, lastOk, note) =>
        `INSERT INTO telnyx_chat_models (id, status, rank, last_ok_at, note, updated_at) VALUES (${[id, status, rank, lastOk, note, now].map(sql).join(", ")});`;
    shortlist.forEach((m, i) => lines.push(row(m.id, "shortlist", i + 1, now, `script: passed, median ${m.medianMs} ms`)));
    reserves.forEach((m, i) =>
        lines.push(row(m.id, "reserve", i + 1, m.kind === "pass" ? now : null, m.kind === "pass" ? `script: passed, median ${m.medianMs} ms` : `script: not confirmed (${m.reason})`))
    );
    rejected.forEach((m) => lines.push(row(m.id, "rejected", 0, null, `script: ${m.reason}`)));
    return lines.join("\n");
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const dryRun = args.has("--dry-run");
    const target = args.has("--local") ? "--local" : "--remote";
    const apiKey = readKey();
    if (!apiKey) {
        console.error("No Telnyx key. Add a line TELNYX_API_KEY=KEY... to worker/.dev.vars (git ignores it), or in PowerShell:");
        console.error('  $env:TELNYX_API_KEY = Read-Host "Paste Telnyx key"');
        process.exit(1);
    }

    const candidates = rankChatCandidates(await fetchChatModelList(apiKey));
    if (!candidates.length) throw new Error("Telnyx lists no chat models that pass the automatic filters.");
    console.log(`Testing ${candidates.length} candidates with ${TEST_TURNS.length} turns each...`);
    const cost = new Map(candidates.map((c) => [c.id, c.costPerTurn]));
    const results = await mapLimited(candidates, CONCURRENCY, async ({ id }) => {
        const r = await testModel(apiKey, id);
        console.log(`  ${r.kind.padEnd(9)} ${id}${r.reason ? `  (${r.reason})` : ""}`);
        return r;
    });
    const account = results.find((r) => r.kind === "account");
    if (account) throw new Error(`The key or Telnyx balance was refused, nothing was changed: ${account.reason}`);

    const passed = results
        .filter((r) => r.kind === "pass")
        .sort((a, b) => a.medianMs - b.medianMs || cost.get(a.id) - cost.get(b.id));
    const unconfirmed = results.filter((r) => r.kind === "transient");
    const rejected = results.filter((r) => r.kind === "unusable");
    const shortlist = passed.slice(0, SHORTLIST_SIZE);
    const reserves = [...passed.slice(SHORTLIST_SIZE), ...unconfirmed];

    console.log("");
    console.table(
        [...shortlist.map((m) => ["shortlist", m]), ...reserves.map((m) => ["reserve", m]), ...rejected.map((m) => ["rejected", m])].map(
            ([status, m]) => ({
                status,
                model: m.id,
                "median ms": m.medianMs,
                "US$ per 1,000 turns": Number((cost.get(m.id) * 1000).toFixed(2)),
                note: m.reason || m.sample.slice(0, 60)
            })
        )
    );
    if (!shortlist.length) throw new Error("No model passed, so the table was left as it was.");
    if (shortlist.length < SHORTLIST_SIZE) console.warn(`Only ${shortlist.length} models passed; the shortlist will be short.`);
    if (dryRun) {
        console.log("Dry run: nothing written.");
        return;
    }

    const file = path.join(os.tmpdir(), `telnyx_chat_models_${Date.now()}.sql`);
    fs.writeFileSync(file, buildSql(shortlist, reserves, rejected, Date.now()));
    console.log(`Writing to the ${target === "--remote" ? "deployed" : "local"} D1 database ${DATABASE}...`);
    const run = spawnSync(`npx wrangler d1 execute ${DATABASE} ${target} --yes --file "${file}"`, {
        cwd: WORKER_DIR,
        stdio: "inherit",
        shell: true
    });
    fs.rmSync(file, { force: true });
    if (run.status !== 0) throw new Error("wrangler d1 execute failed; the table may not have been updated.");
    console.log(`Done. Shortlist, tried in this order: ${shortlist.map((m) => m.id).join(", ")}`);
}

main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
});
