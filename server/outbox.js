'use strict';

/**
 * Transactional outbox (events.event-envelope@1). enqueue() is called inside the same SQLite
 * transaction as the money movement it announces, so an event exists exactly when its effect
 * does. The relay publishes unsent rows to OpenVibe.Events (POST /api/v1/events, service token
 * for audience openvibe.events with events.event.publish) and runs only when EVENTS_URL is set;
 * without it rows accumulate and can be relayed later. Events deduplicates on event_id, so a
 * relay retry after a lost response never publishes twice.
 */
const { ids, validate, serviceAuth } = require('openvibe-contracts');

const ACTOR = { type: 'service', id: 'billing' };

function enqueue(ctx, { event_type, subject, payload, priority = 'important', traceId }) {
    const ms = ctx.now();
    const env = {
        event_id: ids.newId('event', ms),
        event_type,
        version: 1,
        source: 'billing',
        actor: ACTOR,
        timestamp: new Date(ms).toISOString(),
        priority,
        visibility: 'internal',
        subject,
        payload: payload || {},
    };
    if (traceId && /^[0-9a-f]{32}$/.test(traceId)) env.trace_id = traceId;
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new Error(`outbox: invalid envelope for ${event_type}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    ctx.db.prepare('INSERT INTO outbox (event_id, event, created_at) VALUES (?, ?, ?)').run(env.event_id, JSON.stringify(env), env.timestamp);
    return env;
}

/** Relay loop. Returns { stop, flush }. */
function createRelay({ db, config, fetchImpl = globalThis.fetch, tokenClient, log = console }) {
    const tokens = tokenClient || serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: 'events.event.publish',
        fetchImpl,
    });
    let timer = null;
    let busy = false;

    async function flush() {
        if (busy) return { sent: 0, busy: true };
        busy = true;
        let sent = 0;
        try {
            for (;;) {
                const rows = db.prepare('SELECT seq, event_id, event FROM outbox WHERE sent_at IS NULL ORDER BY seq LIMIT 100').all();
                if (!rows.length) break;
                const body = { events: rows.map((r) => JSON.parse(r.event)) };
                let res;
                try {
                    res = await fetchImpl(`${config.events.url}/api/v1/events`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(10000),
                    });
                } catch (e) {
                    markFailed(rows, e.message);
                    break;
                }
                if (res.status === 401) tokens.invalidate();
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    markFailed(rows, `${res.status} ${text.slice(0, 300)}`);
                    break;
                }
                const at = new Date().toISOString();
                const mark = db.prepare('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ?');
                db.transaction(() => { for (const r of rows) mark.run(at, r.seq); })();
                sent += rows.length;
            }
        } finally {
            busy = false;
        }
        return { sent };
    }

    function markFailed(rows, message) {
        const mark = db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?');
        db.transaction(() => { for (const r of rows) mark.run(String(message).slice(0, 500), r.seq); })();
        log.warn(`[Billing] outbox relay: ${rows.length} event(s) not published: ${message}`);
    }

    function start() {
        if (timer || !config.events.url) return;
        timer = setInterval(() => { flush().catch((e) => log.warn('[Billing] outbox relay:', e.message)); }, config.events.intervalMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, flush };
}

module.exports = { enqueue, createRelay };
