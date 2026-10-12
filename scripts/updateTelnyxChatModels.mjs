/**
 * Builds the tested Telnyx chat model shortlists from scratch, in the Worker's D1 table
 * telnyx_chat_models: "text" for ordinary turns and "photo" for turns that send a camera image.
 * Every model that passes the automatic filters (priced, run by Telnyx, big enough, and for photo
 * able to take images) gets the list's game-like test turns; of those that pass, the four that
 * answer straight away and quickest become the shortlist and the rest the reserves. After that the Worker keeps the lists current by
 * itself during play (see worker/src/telnyxChatModels.js); rerun this to start again, e.g. when
 * the reserves run out.
 *
 * Usage (PowerShell, from the repo root). The key is read from worker/.dev.vars
 * (TELNYX_API_KEY=KEY...; git ignores that file) or from the environment:
 *   node scripts/updateTelnyxChatModels.mjs              test, then write both lists to the deployed Worker's D1
 *   node scripts/updateTelnyxChatModels.mjs --only photo one list only (text or photo); the other is left as it is
 *   node scripts/updateTelnyxChatModels.mjs --dry-run    test and print the report only
 *   node scripts/updateTelnyxChatModels.mjs --local      write to the local D1 used by `wrangler dev`
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
    KINDS,
    SHORTLIST_SIZE,
    TEST_TURNS_BY_KIND,
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

/** Every turn of the list; a timeout or server error gets one retry. Stops at the first turn that fails. */
async function testModel(apiKey, id, kind) {
    const results = [];
    for (const turn of TEST_TURNS_BY_KIND[kind]) {
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
        reasons: results.some((r) => r.reasons),
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

/** @returns {Promise<{ kind: string, shortlist: object[], reserves: object[], rejected: object[] } | null>} */
async function buildList(apiKey, list, kind) {
    const candidates = rankChatCandidates(list, kind);
    if (!candidates.length) {
        console.warn(`${kind}: Telnyx lists no chat models that pass the automatic filters.`);
        return null;
    }
    const turns = TEST_TURNS_BY_KIND[kind].length;
    console.log(`\n${kind}: testing ${candidates.length} candidates with ${turns} turn${turns === 1 ? "" : "s"} each...`);
    const cost = new Map(candidates.map((c) => [c.id, c.costPerTurn]));
    const results = await mapLimited(candidates, CONCURRENCY, async ({ id }) => {
        const r = await testModel(apiKey, id, kind);
        console.log(`  ${r.kind.padEnd(9)} ${id}${r.reason ? `  (${r.reason})` : ""}`);
        return r;
    });
    const account = results.find((r) => r.kind === "account");
    if (account) throw new Error(`The key or Telnyx balance was refused, nothing was changed: ${account.reason}`);

    // Models that answer straight away first (only the photo list accepts reasoners), then fastest.
    const passed = results
        .filter((r) => r.kind === "pass")
        .sort((a, b) => Number(a.reasons) - Number(b.reasons) || a.medianMs - b.medianMs || cost.get(a.id) - cost.get(b.id));
    const unconfirmed = results.filter((r) => r.kind === "transient");
    const rejected = results.filter((r) => r.kind === "unusable");
    const shortlist = passed.slice(0, SHORTLIST_SIZE);
    const reserves = [...passed.slice(SHORTLIST_SIZE), ...unconfirmed];

    console.table(
        [...shortlist.map((m) => ["shortlist", m]), ...reserves.map((m) => ["reserve", m]), ...rejected.map((m) => ["rejected", m])].map(
            ([status, m]) => ({
                status,
                model: m.id,
                "median ms": m.medianMs,
                reasons: m.reasons ? "yes" : "",
                "US$ per 1,000 turns": Number((cost.get(m.id) * 1000).toFixed(2)),
                note: m.reason || m.sample.slice(0, 60)
            })
        )
    );
    if (!shortlist.length) {
        console.warn(`${kind}: no model passed, so this list is left as it was.`);
        return null;
    }
    if (shortlist.length < SHORTLIST_SIZE) console.warn(`${kind}: only ${shortlist.length} models passed; the shortlist will be short.`);
    return { kind, shortlist, reserves, rejected };
}

const sql = (value) => (value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

function buildSql({ kind, shortlist, reserves, rejected }, now) {
    const lines = [`DELETE FROM telnyx_chat_models WHERE kind = ${sql(kind)};`];
    const row = (m, status, rank, lastOk, note) =>
        `INSERT INTO telnyx_chat_models (id, kind, status, rank, reply_ms, reasons, last_ok_at, note, updated_at) VALUES (${[
            m.id,
            kind,
            status,
            rank,
            m.kind === "pass" ? m.medianMs : null,
            m.reasons ? 1 : 0,
            lastOk,
            note,
            now
        ]
            .map(sql)
            .join(", ")});`;
    shortlist.forEach((m, i) => lines.push(row(m, "shortlist", i + 1, now, `script: passed, median ${m.medianMs} ms`)));
    reserves.forEach((m, i) =>
        lines.push(row(m, "reserve", i + 1, m.kind === "pass" ? now : null, m.kind === "pass" ? `script: passed, median ${m.medianMs} ms` : `script: not confirmed (${m.reason})`))
    );
    rejected.forEach((m) => lines.push(row(m, "rejected", 0, null, `script: ${m.reason}`)));
    return lines.join("\n");
}

async function main() {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    const dryRun = args.has("--dry-run");
    const target = args.has("--local") ? "--local" : "--remote";
    const only = args.has("--only") ? argv[argv.indexOf("--only") + 1] : null;
    if (only && !KINDS.includes(only)) throw new Error(`--only takes ${KINDS.join(" or ")}.`);
    const apiKey = readKey();
    if (!apiKey) {
        console.error("No Telnyx key. Add a line TELNYX_API_KEY=KEY... to worker/.dev.vars (git ignores it), or in PowerShell:");
        console.error('  $env:TELNYX_API_KEY = Read-Host "Paste Telnyx key"');
        process.exit(1);
    }

    const list = await fetchChatModelList(apiKey);
    const built = [];
    for (const kind of only ? [only] : KINDS) {
        const result = await buildList(apiKey, list, kind);
        if (result) built.push(result);
    }
    if (!built.length) throw new Error("Nothing passed, so the table was left as it was.");
    if (dryRun) {
        console.log("\nDry run: nothing written.");
        return;
    }

    const now = Date.now();
    const file = path.join(os.tmpdir(), `telnyx_chat_models_${now}.sql`);
    fs.writeFileSync(file, built.map((b) => buildSql(b, now)).join("\n"));
    console.log(`\nWriting to the ${target === "--remote" ? "deployed" : "local"} D1 database ${DATABASE}...`);
    const run = spawnSync(`npx wrangler d1 execute ${DATABASE} ${target} --yes --file "${file}"`, {
        cwd: WORKER_DIR,
        stdio: "inherit",
        shell: true
    });
    fs.rmSync(file, { force: true });
    if (run.status !== 0) throw new Error("wrangler d1 execute failed; the table may not have been updated.");
    for (const b of built) console.log(`Done. ${b.kind} shortlist, tried in this order: ${b.shortlist.map((m) => m.id).join(", ")}`);
}

main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
});
