'use strict';

/**
 * Per-person rate limits on the money-creating routes of /api/v1 (roadmap WS-R task 4;
 * openvibe-sdk/limits).
 *
 * Every /api/v1 caller is a first-party service (Live, Tips, VIP) acting for many people, so a limit is
 * never counted per service: it is counted per PERSON, the one the request names in its body (the buyer,
 * the payer, the creator), whichever service sends it. A refund counts against the payer of the transfer
 * it gives back. A request that names no valid person counts against its principal (it is then refused
 * 422 by the route anyway). Each limit sits after the capability and freeze checks (a request refused
 * while frozen is not counted) and before the idempotency store and any ledger work: a refusal stores
 * nothing, so a retry with the same Idempotency-Key after Retry-After is a fresh attempt. Past a limit:
 * 429 problem+json `rate_limited` with Retry-After, one log line and billing_rate_limited_total{limit,window}.
 * Counters live in this process: a restart forgets them. BILLING_LIMITS=off counts nobody (a rollback
 * lever, no deploy needed).
 *
 * Never limited: the provider webhooks (/webhooks/*: a refused receipt would be money received and not
 * credited), capturing an approved order (the person already paid; bounded by the intents they started),
 * cashout approve and deny, subscription cancel, the freeze, every admin route, the staff console,
 * balance and entitlement reads (hot paths the services call for every page and chat message),
 * /api/health, /api/ready, /release.json and /metrics.
 */
const { createActorLimiter } = require('openvibe-sdk/limits');
const { ids } = require('openvibe-contracts');

/** Each budget per person: a minute, an hour. */
const BUDGETS = {
    // Starting a checkout (POST /intents) prices it and opens a provider checkout (Stripe, PayPal…).
    // Someone buying Vibes or subscribing starts one, and perhaps retries it once or twice; dozens are card
    // testing. Tips' supporters are also capped at 20 unpaid checkouts a day there.
    'billing.intent.create': { minute: 5, hour: 30 },
    // A tip, donation or paid interaction from a person's credit: one a second at most, above Tips' own
    // 20 a minute per supporter, so no real supporter meets it.
    'billing.transfer.create': { minute: 60, hour: 1200 },
    // Giving a transfer back to its payer. There cannot be more refunds than the payer's transfers (60 a
    // minute, above), Live's media queue holds 3 requests per person by default, and a refund Live sees
    // refused stays unrefunded, so the streamer's refund button asks again.
    'billing.transfer.refund': { minute: 20, hour: 200 },
    // A payout request moves a creator's payable into escrow for staff to pay out: a creator asks now and
    // then (a replayed Idempotency-Key counts too).
    'billing.cashout.request': { minute: 3, hour: 10 },
    // Recycling payable into spendable credit: a creator's button, a few at a time.
    'billing.recycle': { minute: 10, hour: 60 },
    // A subscription period paid from credit: a person subscribes to a few channels at a time.
    'billing.subscription.create': { minute: 10, hour: 60 },
};

/** The bare usr_… id from a SubjectRef or a bare id, else null. */
function personOf(v) {
    const id = v && typeof v === 'object' ? v.id : v;
    return typeof id === 'string' && ids.isSubjectId('user', id) && (!v || typeof v !== 'object' || v.type === 'user') ? id : null;
}

/**
 * createActorLimits({ config, db, now, registry, log }) → { budget(name, personFrom), history, refund }.
 * personFrom(req) names the person a request is counted against (or null: its principal).
 */
function createActorLimits({ config, db, now = () => Date.now(), registry = null, log = console }) {
    const refused = registry
        ? registry.counter({ name: 'billing_rate_limited_total', help: 'Requests refused 429 by a per-person limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const enabled = config.actorLimits.enabled;

    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        now,
        actor(req) {
            if (!enabled) return null;
            const person = req.limitPerson;
            if (person) return `user:${person}`;
            return req.principal && req.principal.sub ? req.principal.sub : null;
        },
        onLimited(e) {
            // The actor is a subject id or a principal, never a token or an amount.
            log.warn(`[Billing] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });

    /** The budget `name`, counted against personFrom(req). */
    function budget(name, personFrom) {
        const own = BUDGETS[name];
        if (!own) throw new Error(`limits: no budget named ${name}`);
        const limit = limiter(name, own);
        return function billingActorLimit(req, res, next) {
            try { req.limitPerson = personFrom(req); } catch { req.limitPerson = null; }
            return limit(req, res, next);
        };
    }

    /** A person's history (GET /transactions?subject=): BILLING_LIMITS_MINUTE / BILLING_LIMITS_HOUR, 120 and 3000. */
    const historyLimit = limiter('billing.history.read');
    function history(req, res, next) {
        req.limitPerson = personOf(req.query && req.query.subject);
        return historyLimit(req, res, next);
    }

    /** The payer of the transfer a refund gives back (one primary-key read), else null. */
    function payerOf(req) {
        const row = db.prepare('SELECT from_subject FROM transactions WHERE id = ?').get(String(req.params.id));
        return row ? personOf(row.from_subject) : null;
    }

    return { budget, history, payerOf };
}

module.exports = { createActorLimits, personOf, BUDGETS };
