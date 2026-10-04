'use strict';

/**
 * Rating (plan T5 step 6): a stored usage reading (ops/usage.js) becomes a charge. The reading's provider and resource
 * pick a rate card (the card's provider and metric); price × quantity is rounded up to whole vibes-bits once; the
 * subject's promo allowance (ops/promo.js) covers what it can first, and the rest is one `usage` transaction,
 * user_credit:<subject> → platform_revenue, idempotent by `usage:<reading idempotency_key>`.
 *
 * Every reading is rated in one serializable transaction that claims its row (FOR UPDATE SKIP LOCKED: a second sweep
 * passes it by), re-reads it, draws the promo allowance, checks the spendable balance and the hard budgets, posts, and
 * marks the row rated — all or nothing, so two sweeps (or a sweep and POST /admin/rate) never charge or draw twice.
 *
 * Never charged, left unrated with rating_error set: a reading with no user subject (permanently), with no rate card
 * or whose unit does not fit the card (until loadCards() loads a card that matches it), that the balance or a hard
 * budget refuses (the sweep tries it again after BILLING_RATING_RETRY_MS), or that is otherwise refused (e.g. a charge
 * past the exact integer range; left for review). Nothing is ever partly charged.
 *
 * A card's own free_allowance (the provider's free tier) is kept with the card and not applied per reading: a
 * person's free allowance is their promo allowance.
 */
const { validate } = require('openvibe-contracts');
const { post, requireFunds, iso, money, BillingError } = require('../ledger');
const { A, BITS, entry, fail, userSubject, positiveInt, isFrozen } = require('./common');
const promo = require('./promo');

const ACTOR = { type: 'service', id: 'billing' };
const ERR = {
    noSubject: 'billing.no_subject',
    noCard: 'billing.no_rate_card',
    unit: 'billing.unit_mismatch',
    funds: 'billing.insufficient_funds',
    budget: 'billing.budget_exceeded',
};
// Refusals that may pass later on their own (a top-up, the next budget window): the sweep retries them.
const RETRY = [ERR.funds, ERR.budget];
// Refusals that only a loaded rate card can lift: loadCards() makes matching readings due again.
const AWAIT_CARD = [ERR.noCard, ERR.unit];

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const ms = (v) => new Date(v).getTime();

/** A finite non-negative JS number as an exact fraction [numerator, denominator] of BigInts (its shortest decimal form). */
function frac(x) {
    const m = typeof x === 'number' && Number.isFinite(x) ? /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x)) : null;
    if (!m) fail(422, 'billing.invalid_amount', `${x} is not a non-negative number`);
    const digits = BigInt(m[1] + (m[2] || ''));
    const exp = Number(m[3] || 0) - (m[2] || '').length;
    return exp >= 0 ? [digits * 10n ** BigInt(exp), 1n] : [digits, 10n ** BigInt(-exp)];
}

/** Vibes-bits for `quantity` under `card`: quantity / unit_size × unit_price_usd × bitsPerUsd, exact, rounded up once. */
function chargeFor(card, quantity, { bitsPerUsd }) {
    const [qn, qd] = frac(quantity);
    const [pn, pd] = frac(card.unit_price_usd);
    const [un, ud] = frac(card.unit_size);
    const [bn, bd] = frac(bitsPerUsd);
    if (un === 0n) fail(422, 'billing.invalid_rate_card', `rate card ${card.id} has unit_size 0`);
    const num = qn * pn * bn * ud;
    const den = qd * pd * bd * un;
    const bits = (num + den - 1n) / den;
    if (bits > BigInt(Number.MAX_SAFE_INTEGER)) fail(422, 'billing.amount_overflow', `the charge for ${quantity} under ${card.id} is beyond the exact integer range`);
    return Number(bits);
}

/**
 * The card for a reading, or null: same provider, metric = the reading's resource, region fits (a card without a
 * region fits every region), and the reading's UTC day in [effective_from, effective_until). A region-specific card
 * wins over a general one, then the latest effective_from, then the id.
 */
function pickCard(cards, r) {
    const day = new Date(Date.parse(r.at)).toISOString().slice(0, 10);
    const fit = cards.filter((c) => c.provider === r.provider && c.metric === r.resource && (c.region == null || c.region === r.region)
        && c.effective_from <= day && (c.effective_until == null || day < c.effective_until));
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    fit.sort((a, b) => (b.region != null) - (a.region != null) || cmp(b.effective_from, a.effective_from) || cmp(a.id, b.id));
    return fit[0] || null;
}

const unitKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/s$/, '');

/**
 * Whether a reading's unit is the one its card prices: the card's metric names the unit, so the unit (case, spacing
 * and a plural s aside) is the metric itself or the metric's leading word ("GiB" fits gib-delivered, "requests" fits
 * request, "GB" fits gb-month). Anything else (MiB against gib-delivered) is not converted: the reading waits.
 */
function unitFits(card, unit) {
    const u = unitKey(unit);
    const m = unitKey(card.metric);
    return !!u && (u === m || m.startsWith(`${u}-`));
}

/** The chargeable person of a reading ('user:usr_…' or 'usr_…'), or null (no subject, an app or a guest). */
function subjectOf(s) {
    if (typeof s !== 'string') return null;
    const id = s.startsWith('user:') ? s.slice(5) : s;
    try { return userSubject({ type: 'user', id }); } catch { return null; }
}

/**
 * The hard budgets on `subject` for `service` and for every service ('*'): the newest row of each is the policy; its
 * window rolls over to the one open now (same budget, nothing spent) once it ends. Refuses billing.budget_exceeded
 * when `bits` would take any of them past budget_bits; otherwise adds `bits` to each. Inside the rating transaction.
 */
async function spendBudgets(ctx, subject, service, bits) {
    const { db } = ctx;
    const now = ctx.now();
    const nowIso = iso(now);
    const rows = [];
    for (const svc of service === '*' ? ['*'] : [service, '*']) {
        let row = await db.prepare('SELECT * FROM usage_budgets WHERE subject = ? AND service = ? ORDER BY updated_at DESC, window_start DESC LIMIT 1').get(subject, svc);
        if (!row) continue;
        if (ms(row.window_end) <= now) {
            const { start, end } = promo.windowOf(row.reset_period, now);
            row = await db.prepare(`INSERT INTO usage_budgets (subject, service, reset_period, budget_bits, spent_bits, window_start, window_end, updated_at)
                VALUES (?, ?, ?, ?, 0, ?::timestamptz, ?::timestamptz, ?::timestamptz)
                ON CONFLICT (subject, service, window_start) DO UPDATE SET updated_at = excluded.updated_at RETURNING *`)
                .get(subject, svc, row.reset_period, row.budget_bits, start, end, nowIso);
        }
        if (ms(row.window_start) > now) continue;
        const spent = Number(row.spent_bits);
        const budget = Number(row.budget_bits);
        if (spent + bits > budget) {
            fail(409, ERR.budget, `the ${svc === '*' ? 'all-services' : svc} budget of ${subject} has ${Math.max(0, budget - spent)} of ${budget} bits left this window; the charge is ${bits}`,
                { service: svc, budget_bits: budget, spent_bits: spent, required: bits, window_end: new Date(row.window_end).toISOString() });
        }
        rows.push(row);
    }
    for (const row of rows) {
        await db.prepare('UPDATE usage_budgets SET spent_bits = spent_bits + ?, updated_at = ?::timestamptz WHERE subject = ? AND service = ? AND window_start = ?::timestamptz')
            .run(bits, nowIso, row.subject, row.service, new Date(row.window_start).toISOString());
    }
}

/** Leave a reading unrated: why, and when the sweep may try it again (null: not by itself). Never touches a rated row. */
async function leave(ctx, id, why, retry) {
    const due = retry ? iso(ctx.now() + (ctx.config.rating.retryMs)) : null;
    await ctx.db.prepare('UPDATE usage_records SET rating_error = ?, rating_due_at = ?::timestamptz WHERE id = ? AND rated_at IS NULL').run(why, due, id);
}

function outcome(row) {
    if (row.rated_at) {
        return { id: String(row.id), rated: true, vibes_charged: Number(row.vibes_charged), promo_bits: Number(row.promo_bits),
            free_allowance_used: Number(row.free_allowance_used), txn_id: row.txn_id || null };
    }
    return { id: String(row.id), rated: false, rating_error: row.rating_error || null };
}

/**
 * Rate one usage_records row by id. Returns { rated: true, vibes_charged, promo_bits, free_allowance_used, txn_id,
 * replay? } | { rated: false, rating_error } | { busy: true } (another rating holds the row). A refusal by the balance
 * or a budget rolls the whole attempt back (promo draw included) and is then recorded on the row.
 */
async function rate(ctx, id) {
    const { db } = ctx;
    try {
        return await money(db, async () => {
            const row = await db.prepare('SELECT * FROM usage_records WHERE id = ? FOR UPDATE SKIP LOCKED').get(id);
            if (!row) return { id: String(id), busy: true };
            if (row.rated_at) return { ...outcome(row), replay: true };
            if (await isFrozen(db)) fail(503, 'billing.frozen', 'the economy is frozen: nothing is rated');
            const r = json(row.reading);
            const subject = subjectOf(r.subject);
            if (!subject) { await leave(ctx, row.id, ERR.noSubject, false); return { id: String(row.id), rated: false, rating_error: ERR.noSubject }; }
            const cards = (await db.prepare('SELECT card FROM rate_cards WHERE provider = ? AND metric = ?').all(String(r.provider || ''), String(r.resource || ''))).map((c) => json(c.card));
            const card = pickCard(cards, r);
            const unfit = !card ? ERR.noCard : (!unitFits(card, r.unit) ? ERR.unit : null);
            if (unfit) { await leave(ctx, row.id, unfit, false); return { id: String(row.id), rated: false, rating_error: unfit }; }

            const key = `usage:${r.idempotency_key}`;
            const gross = chargeFor(card, r.quantity, ctx.rates);
            const drawn = gross > 0 ? await promo.consume(ctx, { subject, service: r.service, bits: gross, idempotencyKey: key, actor: ACTOR }) : { bits: 0, txn: null };
            const charge = gross - drawn.bits;
            let txn = null;
            if (charge > 0) {
                await requireFunds(db, A.credit(subject), charge, 'Vibes');
                await spendBudgets(ctx, subject, r.service, charge);
                ({ txn } = await post(ctx, {
                    type: 'usage', idempotencyKey: key, actor: ACTOR, fromSubject: subject,
                    entries: [entry(A.credit(subject), -charge), entry(A.revenue(BITS), charge)],
                    metadata: {
                        usage_record: String(row.id), reading: r.idempotency_key, service: r.service, operation: r.operation, resource: r.resource,
                        provider: r.provider, region: r.region || null, quantity: r.quantity, unit: r.unit, at: r.at,
                        rate_card: { id: card.id, unit_size: card.unit_size, unit_price_usd: card.unit_price_usd }, bits_per_usd: ctx.rates.bitsPerUsd,
                        gross_bits: gross, promo_bits: drawn.bits, vibes_charged: charge, promo_txn: drawn.txn ? drawn.txn.id : null,
                        route_epoch: r.route_epoch == null ? null : r.route_epoch, trace_id: r.trace_id || null,
                    },
                }));
            }
            // The part of quantity the allowance paid for, in the reading's own unit.
            const free = drawn.bits === 0 ? 0 : (drawn.bits === gross ? r.quantity : (r.quantity * drawn.bits) / gross);
            const txnId = txn ? txn.id : (drawn.txn ? drawn.txn.id : null);
            const done = await db.prepare(`UPDATE usage_records SET rated_at = ?::timestamptz, txn_id = ?, promo_bits = ?, free_allowance_used = ?, vibes_charged = ?,
                rating_error = NULL, rating_due_at = NULL WHERE id = ? AND rated_at IS NULL RETURNING *`).get(iso(ctx.now()), txnId, drawn.bits, free, charge, row.id);
            return outcome(done);
        });
    } catch (e) {
        // Any other refusal of this reading (e.g. a charge past the exact integer range) is recorded and not retried by itself.
        if (!(e instanceof BillingError) || e.status >= 500 || e.code === 'billing.frozen') throw e;
        await money(db, async () => leave(ctx, id, e.code, RETRY.includes(e.code)));
        return { id: String(id), rated: false, rating_error: e.code, detail: e.detail };
    }
}

/**
 * One pass: up to `batch` due readings, oldest first, each in its own transaction. Does nothing while the economy is
 * frozen. Returns { rated, skipped, busy, failed }.
 */
async function sweep(ctx, { batch } = {}) {
    const { db } = ctx;
    const out = { rated: 0, skipped: 0, busy: 0, failed: 0, frozen: false };
    if (await isFrozen(db)) return { ...out, frozen: true };
    const n = positiveInt(batch || ctx.config.jobs.ratingBatch, 'batch', 5000);
    const due = await db.prepare(`SELECT id FROM usage_records WHERE rating_due_at IS NOT NULL AND rating_due_at <= ?::timestamptz
        ORDER BY at, id LIMIT ?`).all(iso(ctx.now()), n);
    for (const { id } of due) {
        let res;
        try { res = await rate(ctx, id); } catch (e) {
            if (e instanceof BillingError && e.code === 'billing.frozen') return { ...out, frozen: true };
            out.failed++;
            (ctx.log || console).warn(`[Billing] rating reading ${id}: ${e.message}`);
            continue;
        }
        if (res.busy) out.busy++;
        else if (res.rated && !res.replay) out.rated++;
        else if (!res.rated) out.skipped++;
    }
    return out;
}

/** Cards from OV_RATE_CARDS: a JSON array of platform.rate-card@1, inline or in the file the value names. */
function parseCards(source, { readFile = (p) => require('fs').readFileSync(p, 'utf8') } = {}) {
    const raw = String(source || '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw.startsWith('[') ? raw : readFile(raw));
    if (!Array.isArray(parsed)) throw new Error('OV_RATE_CARDS must be a JSON array of platform.rate-card@1');
    return parsed;
}

/**
 * Load reviewed rate cards (scripts/load-rate-cards.js; never from a request): every card must be a valid
 * platform.rate-card@1 with unit_size > 0 and ids unique, or nothing is loaded. A card is upserted by id (the charge
 * records the price it used). Readings left waiting for a card (no card, or a unit that did not fit) whose provider
 * and resource match a loaded card become due again. Returns { loaded, rearmed }.
 */
async function loadCards(ctx, cards, { dryRun = false } = {}) {
    const { db } = ctx;
    const errors = [];
    const seen = new Set();
    cards.forEach((c, i) => {
        const v = validate('platform.rate-card@1', c);
        if (!v.valid) { errors.push(`card ${i} (${c && c.id}): ${v.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`); return; }
        if (!(c.unit_size > 0)) errors.push(`card ${c.id}: unit_size must be more than 0`);
        if (c.effective_until && c.effective_until <= c.effective_from) errors.push(`card ${c.id}: effective_until must be after effective_from`);
        if (seen.has(c.id)) errors.push(`card ${c.id}: id appears twice`);
        seen.add(c.id);
    });
    if (errors.length) fail(422, 'billing.invalid_rate_card', `rate cards refused, nothing loaded: ${errors.join(' | ')}`, errors);
    if (dryRun) return { loaded: 0, rearmed: 0, valid: cards.length };
    return await db.tx(async () => {
        const now = iso(ctx.now());
        let rearmed = 0;
        for (const c of cards) {
            await db.prepare(`INSERT INTO rate_cards (id, provider, metric, region, unit_size, unit_price_usd, free_allowance, reset_period,
                    effective_from, effective_until, source, verified_at, card, loaded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?, ?::date, ?::jsonb, ?::timestamptz)
                ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, metric = excluded.metric, region = excluded.region,
                    unit_size = excluded.unit_size, unit_price_usd = excluded.unit_price_usd, free_allowance = excluded.free_allowance,
                    reset_period = excluded.reset_period, effective_from = excluded.effective_from, effective_until = excluded.effective_until,
                    source = excluded.source, verified_at = excluded.verified_at, card = excluded.card, loaded_at = excluded.loaded_at`)
                .run(c.id, c.provider, c.metric, c.region || null, c.unit_size, c.unit_price_usd, c.free_allowance, c.reset_period,
                    c.effective_from, c.effective_until || null, c.source, c.verified_at, JSON.stringify(c), now);
            const r = await db.prepare(`UPDATE usage_records SET rating_error = NULL, rating_due_at = ?::timestamptz
                WHERE rated_at IS NULL AND rating_error IN (?, ?) AND reading->>'provider' = ? AND reading->>'resource' = ?`)
                .run(now, ...AWAIT_CARD, c.provider, c.metric);
            rearmed += r.changes;
        }
        return { loaded: cards.length, rearmed };
    });
}

/**
 * Set the hard budget of `subject` for `service` ('*' = every service) in the window of `period` open now: the window's
 * row keeps what it has spent and takes the new budget_bits (0 stops every further charge). Returns the row.
 */
async function setBudget(ctx, input) {
    const { db } = ctx;
    const subject = userSubject(input.subject);
    const service = input.service == null || input.service === '' ? '*' : String(input.service).trim().slice(0, 100);
    const period = input.period == null ? 'month' : input.period;
    if (!promo.PERIODS.includes(period)) fail(422, 'billing.invalid_input', `period must be one of ${promo.PERIODS.join(', ')}`);
    const bits = Number(input.budget_bits);
    if (!Number.isSafeInteger(bits) || bits < 0) fail(422, 'billing.invalid_amount', 'budget_bits must be a non-negative integer');
    const now = iso(ctx.now());
    const { start, end } = promo.windowOf(period, ctx.now());
    const row = await money(db, async () => await db.prepare(`INSERT INTO usage_budgets (subject, service, reset_period, budget_bits, spent_bits, window_start, window_end, updated_at)
        VALUES (?, ?, ?, ?, 0, ?::timestamptz, ?::timestamptz, ?::timestamptz)
        ON CONFLICT (subject, service, window_start) DO UPDATE SET reset_period = excluded.reset_period, budget_bits = excluded.budget_bits,
            window_end = excluded.window_end, updated_at = excluded.updated_at RETURNING *`).get(subject, service, period, bits, start, end, now));
    return presentBudget(row);
}

function presentBudget(r) {
    return {
        subject: { type: 'user', id: r.subject }, service: r.service, reset_period: r.reset_period, budget_bits: Number(r.budget_bits),
        spent_bits: Number(r.spent_bits), window_start: new Date(r.window_start).toISOString(), window_end: new Date(r.window_end).toISOString(),
    };
}

module.exports = { rate, sweep, chargeFor, pickCard, unitFits, subjectOf, parseCards, loadCards, setBudget, presentBudget, ERR };
