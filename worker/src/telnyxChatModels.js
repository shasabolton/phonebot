/**
 * The tested Telnyx chat model shortlist (D1 table telnyx_chat_models), which the page tries in
 * order. scripts/updateTelnyxChatModels.mjs fills it; after that it maintains itself during play.
 * After each streamed Telnyx turn (when the reply is done, so nobody waits):
 *   1. the turn's outcome is recorded: a model that answered is marked as working, a shortlisted
 *      model that failed is marked for a recheck;
 *   2. at most one test request is made, on the Worker's own key, in this order of priority:
 *      - a shortlist slot is free: test the next reserve, which takes the slot if it passes
 *        (with no reserves left, new candidates are added from Telnyx's model list instead);
 *      - a shortlisted model failed a live turn: recheck it;
 *      - a shortlisted model hasn't worked for a month: recheck it.
 * A model that is retired, needs another provider's key, reasons or replies badly is rejected at
 * once. Timeouts and server errors are strikes, at most one a day so an outage rejects nothing;
 * two strikes reject it.
 */

import { SHORTLIST_SIZE, TEST_TURNS, fetchChatModelList, rankChatCandidates, testChatTurn } from "./telnyxChatCheck.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 30 * DAY_MS;
const RETRY_REJECTED_MS = 180 * DAY_MS;
const TEST_LOCK_MS = 60 * 1000;
const MAX_STRIKES = 2;
const REFILL_INTERVAL_MS = 60 * 60 * 1000;

/** Per Worker instance: when Telnyx's model list was last searched for new candidates. */
let lastRefillAt = 0;

/** @returns {Promise<string[]>} shortlisted model ids, best first */
export async function chatShortlist(env) {
    const { results } = await env.DB.prepare(
        "SELECT id FROM telnyx_chat_models WHERE status = 'shortlist' ORDER BY rank, id"
    ).all();
    return results.map((r) => r.id);
}

/** GET /api/telnyx/chat-models: `{ models }`, plus every row with `?report=1`. */
export async function chatModelsResponse(env, url) {
    if (url.searchParams.get("report") !== "1") return { models: await chatShortlist(env) };
    const { results } = await env.DB.prepare(
        `SELECT * FROM telnyx_chat_models
         ORDER BY CASE status WHEN 'shortlist' THEN 0 WHEN 'reserve' THEN 1 ELSE 2 END, rank, id`
    ).all();
    const when = (ms) => (ms ? new Date(ms).toISOString() : null);
    return {
        models: results.filter((r) => r.status === "shortlist").map((r) => r.id),
        rows: results.map((r) => ({
            id: r.id,
            status: r.status,
            rank: r.rank,
            strikes: r.strikes,
            lastOk: when(r.last_ok_at),
            lastFailed: when(r.last_failed_at),
            note: r.note,
            updated: when(r.updated_at)
        }))
    };
}

/**
 * After a streamed turn: record it, then run the one background test if one is due.
 * @param {{ ok: string, failed: { id: string, message: string }[] }} outcome
 */
export async function afterTelnyxTurn(env, outcome) {
    if (!env.DB) return;
    try {
        await recordOutcome(env, outcome);
        if (env.TELNYX_API_KEY) await maintain(env);
    } catch (error) {
        log({ action: "error", reason: error?.message || String(error) });
    }
}

async function recordOutcome(env, { ok, failed = [] }) {
    const now = Date.now();
    const statements = [];
    if (ok) {
        // At most one write a day for a model that keeps working.
        statements.push(
            env.DB.prepare(
                `UPDATE telnyx_chat_models SET last_ok_at = ?, last_failed_at = NULL, updated_at = ?
                 WHERE id = ? AND (last_ok_at IS NULL OR last_ok_at < ? OR last_failed_at IS NOT NULL)`
            ).bind(now, now, ok, now - DAY_MS)
        );
    }
    for (const f of failed) {
        statements.push(
            env.DB.prepare(
                "UPDATE telnyx_chat_models SET last_failed_at = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'shortlist'"
            ).bind(now, `live turn failed: ${String(f.message || "").slice(0, 300)}`, now, f.id)
        );
    }
    if (statements.length) await env.DB.batch(statements);
}

async function maintain(env) {
    const now = Date.now();
    const { results: rows } = await env.DB.prepare("SELECT * FROM telnyx_chat_models").all();
    // Not set up yet: run scripts/updateTelnyxChatModels.mjs.
    if (!rows.length) return;
    const byRank = (a, b) => a.rank - b.rank || a.id.localeCompare(b.id);
    const shortlist = rows.filter((r) => r.status === "shortlist").sort(byRank);
    if (shortlist.length < SHORTLIST_SIZE && (await fillSlot(env, rows, shortlist, now))) return;
    const suspect = shortlist.find((r) => r.last_failed_at);
    const stale = shortlist
        .filter((r) => !r.last_ok_at || r.last_ok_at < now - STALE_MS)
        .sort((a, b) => (a.last_ok_at || 0) - (b.last_ok_at || 0))[0];
    const due = suspect || stale;
    if (!due || !(await claim(env, due.id, now))) return;
    const result = await testChatTurn(env.TELNYX_API_KEY, due.id, randomTurn());
    log({ model: due.id, test: suspect ? "recheck after a live failure" : "monthly recheck", ...summary(result) });
    if (result.kind === "pass") await markWorking(env, due.id, now, "passed a recheck");
    else await markFailed(env, due, result, now);
}

/**
 * Tests the next reserve for a free shortlist slot.
 * @returns {Promise<boolean>} false when there was nothing to do, so a recheck may run instead
 */
async function fillSlot(env, rows, shortlist, now) {
    const reserves = rows
        .filter((r) => r.status === "reserve" && !(r.testing_until > now))
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    const next = reserves[0];
    if (!next) return refillReserves(env, rows, now);
    if (!(await claim(env, next.id, now))) return true;
    const result = await testChatTurn(env.TELNYX_API_KEY, next.id, randomTurn());
    log({ model: next.id, test: `candidate for shortlist slot ${shortlist.length + 1}`, ...summary(result) });
    if (result.kind === "pass") {
        const rank = Math.max(0, ...shortlist.map((r) => r.rank)) + 1;
        await env.DB.prepare(
            `UPDATE telnyx_chat_models
             SET status = 'shortlist', rank = ?, strikes = 0, strike_at = NULL, last_ok_at = ?, last_failed_at = NULL,
                 testing_until = NULL, note = ?, updated_at = ?
             WHERE id = ?`
        )
            .bind(rank, now, `joined the shortlist ${new Date(now).toISOString().slice(0, 10)}`, now, next.id)
            .run();
        log({ model: next.id, action: "joined the shortlist" });
        return true;
    }
    if (result.kind === "transient") {
        // To the back of the queue, so a slow candidate doesn't hold up the others.
        const back = Math.max(0, ...reserves.map((r) => r.rank)) + 1;
        await env.DB.prepare("UPDATE telnyx_chat_models SET rank = ? WHERE id = ?").bind(back, next.id).run();
    }
    await markFailed(env, next, result, now);
    return true;
}

/**
 * No reserves left: add models from Telnyx's list that haven't been tried (or were rejected long
 * ago), and reject shortlisted ones Telnyx no longer lists. Testing starts after the next turn.
 */
async function refillReserves(env, rows, now) {
    if (now - lastRefillAt < REFILL_INTERVAL_MS) return false;
    lastRefillAt = now;
    const list = await fetchChatModelList(env.TELNYX_API_KEY);
    const listed = new Set(list.map((m) => String(m?.id || "")));
    const known = new Map(rows.map((r) => [r.id, r]));
    const statements = [];
    for (const r of rows) {
        if (r.status !== "rejected" && !listed.has(r.id)) {
            statements.push(rejectStatement(env, r.id, "Telnyx no longer lists it", now));
        }
    }
    let rank = Math.max(0, ...rows.filter((r) => r.status === "reserve").map((r) => r.rank));
    const added = [];
    for (const { id } of rankChatCandidates(list)) {
        const row = known.get(id);
        if (row && !(row.status === "rejected" && row.updated_at < now - RETRY_REJECTED_MS)) continue;
        rank += 1;
        added.push(id);
        statements.push(
            env.DB.prepare(
                `INSERT INTO telnyx_chat_models (id, status, rank, note, updated_at) VALUES (?, 'reserve', ?, 'added from the model list', ?)
                 ON CONFLICT(id) DO UPDATE SET status = 'reserve', rank = excluded.rank, strikes = 0, strike_at = NULL,
                     note = excluded.note, updated_at = excluded.updated_at`
            ).bind(id, rank, now)
        );
    }
    if (statements.length) await env.DB.batch(statements);
    log({
        action: "searched the model list",
        added: added.length ? added : "nothing new: the shortlist stays short until Telnyx adds a model or you rerun the script"
    });
    return true;
}

async function claim(env, id, now) {
    const result = await env.DB.prepare(
        "UPDATE telnyx_chat_models SET testing_until = ? WHERE id = ? AND (testing_until IS NULL OR testing_until < ?)"
    )
        .bind(now + TEST_LOCK_MS, id, now)
        .run();
    return result.meta?.changes === 1;
}

async function markWorking(env, id, now, note) {
    await env.DB.prepare(
        `UPDATE telnyx_chat_models
         SET last_ok_at = ?, last_failed_at = NULL, strikes = 0, strike_at = NULL, testing_until = NULL, note = ?, updated_at = ?
         WHERE id = ?`
    )
        .bind(now, note, now, id)
        .run();
}

async function markFailed(env, row, result, now) {
    if (result.kind === "account") {
        // The Worker's key or balance, not the model: change nothing.
        await env.DB.prepare("UPDATE telnyx_chat_models SET testing_until = NULL WHERE id = ?").bind(row.id).run();
        return;
    }
    if (result.kind === "transient") {
        const sameDay = row.strike_at && row.strike_at > now - DAY_MS;
        const strikes = sameDay ? row.strikes : row.strikes + 1;
        if (strikes < MAX_STRIKES) {
            await env.DB.prepare(
                `UPDATE telnyx_chat_models
                 SET strikes = ?, strike_at = ?, last_failed_at = NULL, testing_until = NULL, note = ?, updated_at = ?
                 WHERE id = ?`
            )
                .bind(strikes, sameDay ? row.strike_at : now, `strike ${strikes}: ${result.reason}`, now, row.id)
                .run();
            return;
        }
    }
    await rejectStatement(env, row.id, result.reason, now).run();
    log({ model: row.id, action: row.status === "shortlist" ? "removed from the shortlist" : "rejected", reason: result.reason });
}

function rejectStatement(env, id, reason, now) {
    return env.DB.prepare(
        `UPDATE telnyx_chat_models
         SET status = 'rejected', rank = 0, testing_until = NULL, note = ?, updated_at = ?
         WHERE id = ?`
    ).bind(String(reason || "failed").slice(0, 300), now, id);
}

function randomTurn() {
    return TEST_TURNS[Math.floor(Math.random() * TEST_TURNS.length)];
}

function summary(result) {
    return { result: result.kind, reason: result.reason || undefined, ms: result.ms, reasoningChars: result.reasoningChars };
}

function log(fields) {
    console.log(JSON.stringify({ event: "telnyx_chat_check", ...fields }));
}
