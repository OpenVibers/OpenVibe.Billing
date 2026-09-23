'use strict';

/**
 * Provider adapters and the receipt pipeline.
 *
 *   receive()  verify → store the delivery in provider_events BEFORE doing anything with it
 *              (UNIQUE(provider, provider_event_id): a redelivery is stored once)
 *   process()  interpret the stored payload into a plan, then apply the plan and mark the event
 *              processed in ONE SQLite transaction. Plans settle through the same operations the
 *              API uses, keyed pe:<provider>:<event id>, and every settling transaction carries its
 *              provider receipt reference (unique) and source_event_id.
 * While the economy is frozen events are stored but not processed; processPending() runs them in
 * arrival order after the freeze lifts (and on a timer for events that failed transiently).
 *
 * Result effects: settled (exactly one transaction points at the event) | duplicate_receipt (the
 * payment was already settled by another event) | updated (state change, no money) | none (no
 * money effect: test, echo, EXTERNAL, not handled; `review` marks ones an operator should see) |
 * rejected (a 4xx business refusal, e.g. a refund for an unknown payment).
 */
const crypto = require('crypto');
const { iso, BillingError } = require('../ledger');
const { isFrozen } = require('../ops/common');
const purchases = require('../ops/purchases');
const transfers = require('../ops/transfers');
const subscriptions = require('../ops/subscriptions');
const reversals = require('../ops/reversals');
const { createPowerchat } = require('./powerchat');
const { createStripe } = require('./stripe');
const { createPaypal } = require('./paypal');
const { createCcbill } = require('./ccbill');
const { createNowpayments } = require('./nowpayments');

function createAdapters(config, deps = {}) {
    const p = config.providers;
    return {
        powerchat: createPowerchat(p.powerchat, deps),
        stripe: createStripe(p.stripe, deps),
        paypal: createPaypal(p.paypal, deps),
        ccbill: createCcbill(p.ccbill, deps),
        nowpayments: createNowpayments(p.nowpayments, deps),
    };
}

function parseRow(row) { return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null; }

/** Store a verified delivery. Returns { row, duplicate }. */
function store(ctx, provider, { eventId, type, payload }) {
    const text = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const r = ctx.db.prepare(`INSERT OR IGNORE INTO provider_events (provider, provider_event_id, type, payload_hash, payload, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(provider, eventId, type, hash, text, iso(ctx.now()));
    const row = parseRow(ctx.db.prepare('SELECT * FROM provider_events WHERE provider = ? AND provider_event_id = ?').get(provider, eventId));
    return { row, duplicate: r.changes === 0 };
}

function applyPlan(ctx, plan, row) {
    const withEvent = (args) => ({ ...args, sourceEventId: row.id });
    const settled = (r) => (r.replay ? { effect: 'duplicate_receipt', txn_id: r.txn && r.txn.id } : { effect: 'settled', txn_id: r.txn.id });
    switch (plan.effect) {
        case 'none': return { effect: 'none', reason: plan.reason, review: plan.review || plan.hold || undefined };
        case 'update': plan.apply(ctx); return { effect: 'updated', reason: plan.reason };
        case 'purchase': return settled(purchases.settle(ctx, withEvent(plan.args)));
        case 'subscription': return settled(subscriptions.pay(ctx, withEvent(plan.args)));
        case 'tip': return settled(transfers.fromReceipt(ctx, withEvent(plan.args)));
        case 'reverse': {
            const r = reversals.reverseReceipt(ctx, withEvent(plan.args));
            if (r.noop) return { effect: 'none', reason: r.noop };
            return { ...settled(r), review: r.review || undefined };
        }
        default: throw new Error(`unknown plan effect ${plan.effect}`);
    }
}

/** Process one stored event. Returns the updated row (processed or not). */
async function process(ctx, adapters, rowOrId) {
    const { db } = ctx;
    let row = typeof rowOrId === 'object' ? rowOrId : parseRow(db.prepare('SELECT * FROM provider_events WHERE id = ?').get(rowOrId));
    if (!row || row.processed_at) return row;
    if (isFrozen(db)) return row;
    const adapter = adapters[row.provider];
    try {
        if (!adapter) throw new Error(`no adapter for ${row.provider}`);
        const plan = await adapter.interpret(ctx, JSON.parse(row.payload), row);
        db.transaction(() => {
            const fresh = db.prepare('SELECT processed_at FROM provider_events WHERE id = ?').get(row.id);
            if (fresh.processed_at) return;
            let result;
            try {
                result = db.transaction(() => applyPlan(ctx, plan, row))();
            } catch (e) {
                if (!(e instanceof BillingError) || e.status >= 500) throw e;
                result = { effect: 'rejected', code: e.code, reason: e.detail || e.message };
            }
            db.prepare('UPDATE provider_events SET processed_at = ?, result = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?')
                .run(iso(ctx.now()), JSON.stringify(result), row.id);
        })();
    } catch (e) {
        db.prepare('UPDATE provider_events SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(e.message).slice(0, 500), row.id);
        (ctx.log || console).warn(`[Billing] ${row.provider} event ${row.provider_event_id} not processed: ${e.message}`);
    }
    row = parseRow(db.prepare('SELECT * FROM provider_events WHERE id = ?').get(row.id));
    return row;
}

/** Process every stored-but-unprocessed event in arrival order. */
async function processPending(ctx, adapters, { limit = 500 } = {}) {
    if (isFrozen(ctx.db)) return { processed: 0, frozen: true };
    const rows = ctx.db.prepare('SELECT * FROM provider_events WHERE processed_at IS NULL ORDER BY id LIMIT ?').all(limit).map(parseRow);
    let processed = 0;
    for (const r of rows) {
        const after = await process(ctx, adapters, r);
        if (after && after.processed_at) processed++;
        if (isFrozen(ctx.db)) break;
    }
    return { processed, pending: rows.length - processed };
}

/** Reprocess an event (operator): only an unprocessed or rejected one; settled events never re-apply. */
async function reprocess(ctx, adapters, id) {
    const row = parseRow(ctx.db.prepare('SELECT * FROM provider_events WHERE id = ?').get(id));
    if (!row) throw new BillingError(404, 'billing.event_not_found', `no provider event ${id}`);
    if (row.processed_at && row.result && row.result.effect !== 'rejected' && row.result.effect !== 'none') {
        throw new BillingError(409, 'billing.event_settled', `event ${id} already had effect ${row.result.effect}`);
    }
    if (row.processed_at) ctx.db.prepare('UPDATE provider_events SET processed_at = NULL WHERE id = ?').run(id);
    return process(ctx, adapters, id);
}

function present(row) {
    if (!row) return null;
    return {
        id: row.id, provider: row.provider, provider_event_id: row.provider_event_id, type: row.type, payload_hash: row.payload_hash,
        received_at: row.received_at, processed_at: row.processed_at, result: row.result, attempts: row.attempts, last_error: row.last_error,
    };
}

module.exports = { createAdapters, store, process, processPending, reprocess, applyPlan, present, parseRow };
