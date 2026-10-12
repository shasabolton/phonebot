/**
 * The tested Telnyx chat model shortlists (D1 table telnyx_chat_models), which the page tries in
 * order: "text" for ordinary turns, "photo" for turns that send a camera image. A model can be on
 * both (one row per model per list). scripts/updateTelnyxChatModels.mjs fills them; after that they
 * maintain themselves during play. After each Telnyx turn through the Worker (streamed, or relayed
 * for a hosted player; when the reply is done, so nobody waits):
 *   1. the turn's outcome is recorded: a model that answered is marked as working, a shortlisted
 *      model that failed is marked for a recheck;
 *   2. at most one test request is made, on the Worker's own key, across both lists, in this order
 *      of priority (the turn's own list first at each step):
 *      - a shortlist slot is free: test the next reserve, which joins if it passes, in its place by
 *        performance (models that answer straight away first, then the quickest); with no reserves
 *        left, new candidates are added from Telnyx's model list instead;
 *      - a shortlisted model failed a live turn: recheck it;
 *      - a shortlisted model hasn't worked for a month: recheck it.
 * A model that is retired or needs another provider's key is rejected from both lists at once; one
 * that reasons (on the photo list: reasons and is slow), replies badly or can't see the photo is
 * rejected from that list. Timeouts and server errors are strikes, at most one a day so an outage
 * rejects nothing; two strikes reject it.
 */

import { KINDS, SHORTLIST_SIZE, TEST_TURNS_BY_KIND, fetchChatModelList, rankChatCandidates, testChatTurn } from "./telnyxChatCheck.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 30 * DAY_MS;
const RETRY_REJECTED_MS = 180 * DAY_MS;
const TEST_LOCK_MS = 60 * 1000;
const MAX_STRIKES = 2;
const REFILL_INTERVAL_MS = 60 * 60 * 1000;

/** Per Worker instance: when Telnyx's model list was last searched for new candidates. */
let lastRefillAt = 0;

const byRank = (a, b) => a.rank - b.rank || a.id.localeCompare(b.id);
/** Answers straight away before reasons first, then quicker; untimed models keep their order at the back. */
const byPerformance = (a, b) =>
    (a.reasons ? 1 : 0) - (b.reasons ? 1 : 0) || (a.reply_ms ?? Infinity) - (b.reply_ms ?? Infinity) || byRank(a, b);
/** A single test turn is noisy, so the stored time moves halfway towards each new one. */
const smoothedMs = (previous, ms) => (Number.isFinite(previous) ? Math.round((previous + ms) / 2) : ms);

/** @returns {Promise<{ text: string[], photo: string[] }>} shortlisted model ids per list, best first */
export async function chatShortlists(env) {
    const { results } = await env.DB.prepare(
        "SELECT id, kind FROM telnyx_chat_models WHERE status = 'shortlist' ORDER BY rank, id"
    ).all();
    const lists = { text: [], photo: [] };
    for (const r of results) lists[r.kind]?.push(r.id);
    return lists;
}

/** GET /api/telnyx/chat-models: `{ models, photoModels }`, plus every row with `?report=1`. */
export async function chatModelsResponse(env, url) {
    if (url.searchParams.get("report") !== "1") {
        const lists = await chatShortlists(env);
        return { models: lists.text, photoModels: lists.photo };
    }
    const { results } = await env.DB.prepare(
        `SELECT * FROM telnyx_chat_models
         ORDER BY kind DESC, CASE status WHEN 'shortlist' THEN 0 WHEN 'reserve' THEN 1 ELSE 2 END, rank, id`
    ).all();
    const when = (ms) => (ms ? new Date(ms).toISOString() : null);
    const shortlisted = (kind) => results.filter((r) => r.kind === kind && r.status === "shortlist").map((r) => r.id);
    return {
        models: shortlisted("text"),
        photoModels: shortlisted("photo"),
        rows: results.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            rank: r.rank,
            strikes: r.strikes,
            replyMs: r.reply_ms,
            reasons: !!r.reasons,
            lastOk: when(r.last_ok_at),
            lastFailed: when(r.last_failed_at),
            note: r.note,
            updated: when(r.updated_at)
        }))
    };
}

/**
 * After a Telnyx turn through the Worker: record it, then run the one background test if one is due.
 * @param {{ kind?: "text"|"photo", ok?: string, failed?: { id: string, message: string }[], test?: boolean }} outcome
 */
export async function afterTelnyxTurn(env, outcome) {
    if (!env.DB) return;
    const kind = outcome?.kind === "photo" ? "photo" : "text";
    try {
        await recordOutcome(env, kind, outcome || {});
        if (env.TELNYX_API_KEY && outcome?.test !== false) await maintain(env, kind);
    } catch (error) {
        log({ action: "error", reason: error?.message || String(error) });
    }
}

async function recordOutcome(env, kind, { ok, failed = [] }) {
    const now = Date.now();
    const statements = [];
    if (ok) {
        // At most one write a day for a model that keeps working.
        statements.push(
            env.DB.prepare(
                `UPDATE telnyx_chat_models SET last_ok_at = ?, last_failed_at = NULL, updated_at = ?
                 WHERE id = ? AND kind = ? AND (last_ok_at IS NULL OR last_ok_at < ? OR last_failed_at IS NOT NULL)`
            ).bind(now, now, ok, kind, now - DAY_MS)
        );
    }
    for (const f of failed) {
        statements.push(
            env.DB.prepare(
                `UPDATE telnyx_chat_models SET last_failed_at = ?, note = ?, updated_at = ?
                 WHERE id = ? AND kind = ? AND status = 'shortlist'`
            ).bind(now, `live turn failed: ${String(f.message || "").slice(0, 300)}`, now, f.id, kind)
        );
    }
    if (statements.length) await env.DB.batch(statements);
}

async function maintain(env, turnKind) {
    const now = Date.now();
    const { results: rows } = await env.DB.prepare("SELECT * FROM telnyx_chat_models").all();
    // Not set up yet: run scripts/updateTelnyxChatModels.mjs.
    if (!rows.length) return;
    const kinds = [turnKind, ...KINDS.filter((k) => k !== turnKind)];
    const lists = new Map(
        kinds.map((kind) => {
            const ofKind = rows.filter((r) => r.kind === kind);
            return [kind, { rows: ofKind, shortlist: ofKind.filter((r) => r.status === "shortlist").sort(byRank) }];
        })
    );
    for (const kind of kinds) {
        const { rows: ofKind, shortlist } = lists.get(kind);
        if (shortlist.length < SHORTLIST_SIZE && (await fillSlot(env, kind, ofKind, shortlist, rows, now))) return;
    }
    const shortlisted = kinds.flatMap((kind) => lists.get(kind).shortlist);
    const suspect = shortlisted.find((r) => r.last_failed_at);
    const stale = shortlisted
        .filter((r) => !r.last_ok_at || r.last_ok_at < now - STALE_MS)
        .sort((a, b) => (a.last_ok_at || 0) - (b.last_ok_at || 0))[0];
    const due = suspect || stale;
    if (!due || !(await claim(env, due, now))) return;
    const result = await testChatTurn(env.TELNYX_API_KEY, due.id, randomTurn(due.kind));
    log({ model: due.id, list: due.kind, test: suspect ? "recheck after a live failure" : "monthly recheck", ...summary(result) });
    if (result.kind === "pass") await markWorking(env, due, result, now, "passed a recheck");
    else await markFailed(env, due, result, now);
}

/**
 * Tests the next reserve for a free slot on one list.
 * @returns {Promise<boolean>} false when there was nothing to do, so other work may run instead
 */
async function fillSlot(env, kind, rows, shortlist, allRows, now) {
    const reserves = rows.filter((r) => r.status === "reserve" && !(r.testing_until > now)).sort(byRank);
    const next = reserves[0];
    if (!next) return refillReserves(env, allRows, now);
    if (!(await claim(env, next, now))) return true;
    const result = await testChatTurn(env.TELNYX_API_KEY, next.id, randomTurn(kind));
    log({ model: next.id, list: kind, test: `candidate for shortlist slot ${shortlist.length + 1}`, ...summary(result) });
    if (result.kind === "pass") {
        const joined = { ...next, reasons: result.reasons ? 1 : 0, reply_ms: smoothedMs(next.reply_ms, result.ms) };
        const ordered = [...shortlist, joined].sort(byPerformance);
        const place = ordered.indexOf(joined) + 1;
        const statements = [
            env.DB.prepare(
                `UPDATE telnyx_chat_models
                 SET status = 'shortlist', rank = ?, reply_ms = ?, reasons = ?, strikes = 0, strike_at = NULL, last_ok_at = ?,
                     last_failed_at = NULL, testing_until = NULL, note = ?, updated_at = ?
                 WHERE id = ? AND kind = ?`
            ).bind(place, joined.reply_ms, joined.reasons, now, `joined the shortlist ${new Date(now).toISOString().slice(0, 10)}`, now, next.id, kind)
        ];
        ordered.forEach((r, i) => {
            if (r !== joined && r.rank !== i + 1) {
                statements.push(env.DB.prepare("UPDATE telnyx_chat_models SET rank = ? WHERE id = ? AND kind = ?").bind(i + 1, r.id, kind));
            }
        });
        await env.DB.batch(statements);
        log({ model: next.id, list: kind, action: `joined the shortlist at ${place} of ${ordered.length}`, ms: joined.reply_ms, reasons: !!joined.reasons });
        return true;
    }
    if (result.kind === "transient") {
        // To the back of the queue, so a slow candidate doesn't hold up the others.
        const back = Math.max(0, ...reserves.map((r) => r.rank)) + 1;
        await env.DB.prepare("UPDATE telnyx_chat_models SET rank = ? WHERE id = ? AND kind = ?").bind(back, next.id, kind).run();
    }
    await markFailed(env, next, result, now);
    return true;
}

/**
 * A list has no reserves left: add models from Telnyx's list that haven't been tried for it (or
 * were rejected long ago), and reject models Telnyx no longer lists. Testing starts after the next turn.
 */
async function refillReserves(env, rows, now) {
    if (now - lastRefillAt < REFILL_INTERVAL_MS) return false;
    lastRefillAt = now;
    const list = await fetchChatModelList(env.TELNYX_API_KEY);
    const listed = new Set(list.map((m) => String(m?.id || "")));
    const statements = [];
    for (const r of rows) {
        if (r.status !== "rejected" && !listed.has(r.id)) {
            statements.push(rejectStatement(env, r, "Telnyx no longer lists it", now));
        }
    }
    const added = [];
    for (const kind of KINDS) {
        const ofKind = rows.filter((r) => r.kind === kind);
        const known = new Map(ofKind.map((r) => [r.id, r]));
        let rank = Math.max(0, ...ofKind.filter((r) => r.status === "reserve").map((r) => r.rank));
        for (const { id } of rankChatCandidates(list, kind)) {
            const row = known.get(id);
            if (row && !(row.status === "rejected" && row.updated_at < now - RETRY_REJECTED_MS)) continue;
            rank += 1;
            added.push(`${id} (${kind})`);
            statements.push(
                env.DB.prepare(
                    `INSERT INTO telnyx_chat_models (id, kind, status, rank, note, updated_at)
                     VALUES (?, ?, 'reserve', ?, 'added from the model list', ?)
                     ON CONFLICT(id, kind) DO UPDATE SET status = 'reserve', rank = excluded.rank, strikes = 0,
                         strike_at = NULL, note = excluded.note, updated_at = excluded.updated_at`
                ).bind(id, kind, rank, now)
            );
        }
    }
    if (statements.length) await env.DB.batch(statements);
    log({
        action: "searched the model list",
        added: added.length ? added : "nothing new: a short list stays short until Telnyx adds a model or you rerun the script"
    });
    return true;
}

async function claim(env, row, now) {
    const result = await env.DB.prepare(
        "UPDATE telnyx_chat_models SET testing_until = ? WHERE id = ? AND kind = ? AND (testing_until IS NULL OR testing_until < ?)"
    )
        .bind(now + TEST_LOCK_MS, row.id, row.kind, now)
        .run();
    return result.meta?.changes === 1;
}

/** Updates the stored performance too; the list is re-sorted when a model next joins. */
async function markWorking(env, row, result, now, note) {
    await env.DB.prepare(
        `UPDATE telnyx_chat_models
         SET last_ok_at = ?, last_failed_at = NULL, strikes = 0, strike_at = NULL, testing_until = NULL, reply_ms = ?, reasons = ?,
             note = ?, updated_at = ?
         WHERE id = ? AND kind = ?`
    )
        .bind(now, smoothedMs(row.reply_ms, result.ms), result.reasons ? 1 : 0, note, now, row.id, row.kind)
        .run();
}

async function markFailed(env, row, result, now) {
    if (result.kind === "account") {
        // The Worker's key or balance, not the model: change nothing.
        await env.DB.prepare("UPDATE telnyx_chat_models SET testing_until = NULL WHERE id = ? AND kind = ?")
            .bind(row.id, row.kind)
            .run();
        return;
    }
    if (result.kind === "transient") {
        const sameDay = row.strike_at && row.strike_at > now - DAY_MS;
        const strikes = sameDay ? row.strikes : row.strikes + 1;
        if (strikes < MAX_STRIKES) {
            await env.DB.prepare(
                `UPDATE telnyx_chat_models
                 SET strikes = ?, strike_at = ?, last_failed_at = NULL, testing_until = NULL, note = ?, updated_at = ?
                 WHERE id = ? AND kind = ?`
            )
                .bind(strikes, sameDay ? row.strike_at : now, `strike ${strikes}: ${result.reason}`, now, row.id, row.kind)
                .run();
            return;
        }
    }
    await rejectStatement(env, row, result.reason, now, { allLists: result.retired === true }).run();
    log({
        model: row.id,
        list: result.retired ? "all" : row.kind,
        action: row.status === "shortlist" ? "removed from the shortlist" : "rejected",
        reason: result.reason
    });
}

/** A model that is gone or needs another provider's key comes off every list. */
function rejectStatement(env, row, reason, now, { allLists = true } = {}) {
    return env.DB.prepare(
        `UPDATE telnyx_chat_models
         SET status = 'rejected', rank = 0, testing_until = NULL, note = ?, updated_at = ?
         WHERE id = ? AND (? OR kind = ?)`
    ).bind(String(reason || "failed").slice(0, 300), now, row.id, allLists ? 1 : 0, row.kind);
}

function randomTurn(kind) {
    const turns = TEST_TURNS_BY_KIND[kind] || TEST_TURNS_BY_KIND.text;
    return turns[Math.floor(Math.random() * turns.length)];
}

function summary(result) {
    return { result: result.kind, reason: result.reason || undefined, ms: result.ms, reasoningChars: result.reasoningChars };
}

function log(fields) {
    console.log(JSON.stringify({ event: "telnyx_chat_check", ...fields }));
}
