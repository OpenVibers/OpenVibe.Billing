'use strict';

/**
 * staff_audit: one append-only row per staff action (and per refused one). A done action is also
 * announced as `billing.staff.action` (visibility internal) through the outbox, in the same SQLite
 * transaction as the row — and, for money actions, as the effect itself (callers wrap the ops call
 * and record() in one db.transaction).
 *
 * The row holds no secrets: actor subject, action, target, reason, a small whitelisted detail
 * (codes, payout reference, counts), the request id and a keyed hash of the client address.
 */
const { iso, prefixedId } = require('../ledger');
const { enqueue } = require('../outbox');

function record(ctx, { actor, action, target, reason, outcome = 'done', detail, requestId, ipHash, traceId }) {
    const ms = ctx.now();
    const id = prefixedId('sa', ms);
    const row = {
        id, at: iso(ms), actor_subject: actor && actor.subject ? actor.subject : null, actor_username: actor && actor.username ? actor.username : null,
        action, target_type: target ? target.type : null, target_id: target ? String(target.id) : null,
        reason: reason ? String(reason).slice(0, 500) : null, outcome, detail: JSON.stringify(detail || {}),
        request_id: requestId || null, ip_hash: ipHash || null,
    };
    ctx.db.prepare(`INSERT INTO staff_audit (id, at, actor_subject, actor_username, action, target_type, target_id, reason, outcome, detail, request_id, ip_hash)
        VALUES (@id, @at, @actor_subject, @actor_username, @action, @target_type, @target_id, @reason, @outcome, @detail, @request_id, @ip_hash)`).run(row);
    if (outcome === 'done' && row.actor_subject) {
        enqueue(ctx, {
            event_type: 'billing.staff.action',
            subject: { type: 'staff_action', id },
            actor: { type: 'user', id: row.actor_subject },
            traceId,
            payload: {
                audit_id: id, action, outcome,
                target: target ? { type: target.type, id: String(target.id) } : null,
                reason: row.reason, request_id: row.request_id, detail: detail || {},
            },
        });
    }
    return row;
}

function list(db, { limit = 200 } = {}) {
    return db.prepare('SELECT * FROM staff_audit ORDER BY seq DESC LIMIT ?').all(Math.min(500, limit))
        .map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
}

module.exports = { record, list };
