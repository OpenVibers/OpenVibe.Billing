'use strict';
/**
 * Rating (migrations/0004_rating.sql, ops/rating.js; plan T5 step 6): a stored reading is priced by its rate card,
 * the promo allowance covers what it can, the rest is one `usage` transaction user_credit → platform_revenue under
 * `usage:<reading key>`, inside hard budgets. Nothing is charged without a card; a reading refused for want of a card,
 * funds or budget is left unrated (never partly charged) and is rated once what stopped it changes.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');
const rating = require('../server/ops/rating');
const { load } = require('../scripts/load-rate-cards');

const ADMIN = ['billing.ledger.admin'];
const REC = ['billing.usage.record'];
const CARD = {
    id: 'rc_test_cdn_egress', provider: 'test-cdn', metric: 'gib-delivered', unit_size: 1, unit_price_usd: 0.1, free_allowance: 0,
    reset_period: 'month', effective_from: '2026-01-01', source: 'https://example.com/pricing', verified_at: '2026-09-28',
};
let n = 0;

(async () => {
    console.log('usage rating');
    const t = await boot();
    const reading = (subject, over = {}) => {
        n++;
        return {
            id: `use-${n}`, idempotency_key: `media:delivery:${n}`, service: 'media', subject: subject === null ? undefined : `user:${subject.id}`,
            resource: 'gib-delivered', provider: 'test-cdn', operation: 'deliver', quantity: 3, unit: 'GiB',
            at: new Date(t.ctx.now()).toISOString(), source: 'media.egress', ...over,
        };
    };
    const store = async (body) => {
        const r = await t.call('POST', '/api/v1/usage', { body, cap: REC, key: null, sub: 'svc:media' });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.record;
    };
    const row = (key) => t.db.prepare('SELECT * FROM usage_records WHERE idempotency_key = ?').get(key);
    const usageTxns = async (key) => (await t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'usage'" + (key ? ' AND idempotency_key = ?' : '')).get(...(key ? [`usage:${key}`] : []))).n;
    const credit = async (s) => (await t.balances(s.id)).credit;
    const promoBits = async (s) => (await t.balances(s.id)).promo_bits;
    const grant = async (s, bits) => { const r = await t.call('POST', '/api/v1/admin/promo/grant', { body: { subject: s, bits, service: 'media' }, cap: ADMIN }); assert.strictEqual(r.status, 201, r.text); };
    const sweep = () => rating.sweep(t.ctx);

    await check('0004 widened transactions_type_check (the name 0001 got) by usage, and the sweep is off by default', async () => {
        const c = await t.db.prepare("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'transactions'::regclass AND conname = 'transactions_type_check'").get();
        for (const k of ['purchase', 'import', 'usage']) assert.ok(c.def.includes(`'${k}'`), `${k} in ${c.def}`);
        assert.strictEqual(t.config.jobs.ratingIntervalMs, 0);
        assert.strictEqual(require('../server/config').loadConfig({}).jobs.ratingIntervalMs, 0);
    });

    await check('chargeFor is exact and rounds up once (3 × $0.10 × 100 = 30, not 31; 1 op at $0.004 = 1 bit)', async () => {
        assert.strictEqual(rating.chargeFor(CARD, 3, { bitsPerUsd: 100 }), 30);
        assert.strictEqual(rating.chargeFor({ ...CARD, unit_price_usd: 0.004 }, 1, { bitsPerUsd: 100 }), 1);
        assert.strictEqual(rating.chargeFor({ ...CARD, unit_size: 1000000, unit_price_usd: 0.4 }, 2500000, { bitsPerUsd: 100 }), 100);
        assert.strictEqual(rating.chargeFor({ ...CARD, unit_size: 1000000, unit_price_usd: 0.4 }, 1, { bitsPerUsd: 100 }), 1);
        assert.strictEqual(rating.chargeFor(CARD, 0, { bitsPerUsd: 100 }), 0);
        assert.strictEqual(rating.chargeFor({ ...CARD, unit_price_usd: 1e-7 }, 1, { bitsPerUsd: 100 }), 1);
    });

    await check('card match: provider + metric = resource, region and dates; the unit must fit the metric', async () => {
        const at = '2026-10-04T10:00:00Z';
        const cards = [CARD, { ...CARD, id: 'eu', region: 'eu' }, { ...CARD, id: 'old', effective_from: '2025-01-01', effective_until: '2026-01-01' }];
        assert.strictEqual(rating.pickCard(cards, { provider: 'test-cdn', resource: 'gib-delivered', region: 'eu', at }).id, 'eu');
        assert.strictEqual(rating.pickCard(cards, { provider: 'test-cdn', resource: 'gib-delivered', region: 'us', at }).id, CARD.id);
        assert.strictEqual(rating.pickCard(cards, { provider: 'test-cdn', resource: 'gib-delivered', at: '2025-06-01T00:00:00Z' }).id, 'old');
        assert.strictEqual(rating.pickCard(cards, { provider: 'test-cdn', resource: 'gib-delivered', at: '2024-06-01T00:00:00Z' }), null);
        assert.strictEqual(rating.pickCard(cards, { provider: 'other', resource: 'gib-delivered', at }), null);
        assert.ok(rating.unitFits(CARD, 'GiB'));
        assert.ok(rating.unitFits({ metric: 'request' }, 'requests'));
        assert.ok(!rating.unitFits(CARD, 'MiB'));
        assert.ok(!rating.unitFits(CARD, ''));
    });

    const alice = t.user(1);
    const bob = t.user(2);
    const carol = t.user(3);
    let early;
    await check('no rate card: nothing is charged, the reading is left unrated with rating_error and not retried by itself', async () => {
        await fund(t, alice.id, 1000);
        early = await store(reading(alice));
        const out = await sweep();
        assert.strictEqual(out.rated, 0);
        const r = await row(early.idempotency_key);
        assert.strictEqual(r.rating_error, 'billing.no_rate_card');
        assert.strictEqual(r.rated_at, null);
        assert.strictEqual(r.rating_due_at, null);
        assert.strictEqual(await usageTxns(), 0);
        assert.strictEqual(await credit(alice), 1000);
        const g = await t.call('GET', `/api/v1/usage?subject=user:${alice.id}`, { cap: ADMIN });
        assert.strictEqual(g.json.records[0].vibes_charged, undefined, 'absent vibes_charged = not rated yet');
        assert.strictEqual(g.json.records[0].rating_error, 'billing.no_rate_card');
    });

    await check('the loader refuses an invalid card whole (platform.rate-card@1) and loads nothing', async () => {
        await assert.rejects(load({ cards: JSON.stringify([CARD, { ...CARD, id: 'bad', unit_price_usd: -1 }]) }, { db: t.db }), (e) => e.code === 'billing.invalid_rate_card');
        await assert.rejects(load({ cards: JSON.stringify([{ ...CARD, unit_size: 0 }]) }, { db: t.db }), (e) => e.code === 'billing.invalid_rate_card');
        await assert.rejects(load({ cards: '' }, { db: t.db }), /OV_RATE_CARDS is empty/);
        assert.strictEqual((await t.db.prepare('SELECT COUNT(*) AS n FROM rate_cards').get()).n, 0);
        const dry = await load({ cards: JSON.stringify([CARD]), dryRun: true }, { db: t.db });
        assert.strictEqual(dry.loaded, 0);
        assert.strictEqual((await t.db.prepare('SELECT COUNT(*) AS n FROM rate_cards').get()).n, 0);
    });

    await check('a card loaded later makes the waiting reading due again; the next pass charges it: one usage txn user_credit → platform_revenue', async () => {
        const out = await load({ cards: JSON.stringify([CARD]) }, { db: t.db });
        assert.deepStrictEqual(out, { loaded: 1, rearmed: 1 });
        assert.strictEqual((await row(early.idempotency_key)).rating_error, null);
        const s = await sweep();
        assert.strictEqual(s.rated, 1);
        const r = await row(early.idempotency_key);
        assert.ok(r.rated_at);
        assert.strictEqual(Number(r.vibes_charged), 30);
        assert.strictEqual(Number(r.promo_bits), 0);
        assert.strictEqual(Number(r.free_allowance_used), 0);
        assert.strictEqual(await credit(alice), 970);
        const txn = await t.db.prepare('SELECT * FROM transactions WHERE id = ?').get(r.txn_id);
        assert.strictEqual(txn.type, 'usage');
        assert.strictEqual(txn.idempotency_key, `usage:${early.idempotency_key}`);
        const entries = (await require('../server/ledger').entriesOf(t.db, r.txn_id)).map((e) => [e.kind, e.owner, e.currency, e.amount]);
        assert.deepStrictEqual(entries, [['platform_revenue', null, 'vibes-bits', 30], ['user_credit', alice.id, 'vibes-bits', -30]]);
        const g = await t.call('GET', `/api/v1/usage?subject=user:${alice.id}`, { cap: ADMIN });
        assert.strictEqual(g.json.records[0].vibes_charged, 30);
        assert.strictEqual(g.json.records[0].txn_id, r.txn_id);
    });

    await check('re-rating is idempotent: the same reading again is a replay, nothing moves', async () => {
        const r = await row(early.idempotency_key);
        const again = await rating.rate(t.ctx, r.id);
        assert.strictEqual(again.replay, true);
        assert.strictEqual(again.vibes_charged, 30);
        assert.strictEqual(await usageTxns(), 1);
        assert.strictEqual(await credit(alice), 970);
        assert.strictEqual((await sweep()).rated, 0);
    });

    await check('promo allowance covering the whole charge: 0 charged, free_allowance_used = quantity, txn_id = the promo draw, no credit debit', async () => {
        await grant(bob, 100);
        await fund(t, bob.id, 50);
        const rec = await store(reading(bob, { quantity: 2 }));
        await sweep();
        const r = await row(rec.idempotency_key);
        assert.strictEqual(Number(r.vibes_charged), 0);
        assert.strictEqual(Number(r.promo_bits), 20);
        assert.strictEqual(Number(r.free_allowance_used), 2);
        assert.ok(r.txn_id);
        const txn = await t.db.prepare('SELECT * FROM transactions WHERE id = ?').get(r.txn_id);
        assert.strictEqual(txn.type, 'adjustment');
        assert.strictEqual(JSON.parse(txn.metadata).promo, 'consume');
        assert.strictEqual(await usageTxns(rec.idempotency_key), 0);
        assert.strictEqual(await credit(bob), 50);
        assert.strictEqual(await promoBits(bob), 80);
    });

    await check('partial cover: the allowance first, the rest from Vibes (ceil once); promo never reaches creator money', async () => {
        const rec = await store(reading(bob, { quantity: 10.5 }));   // 105 bits gross; 80 promo left
        await sweep();
        const r = await row(rec.idempotency_key);
        assert.strictEqual(Number(r.promo_bits), 80);
        assert.strictEqual(Number(r.vibes_charged), 25);
        assert.ok(Math.abs(Number(r.free_allowance_used) - (10.5 * 80) / 105) < 1e-9);
        assert.strictEqual(await credit(bob), 25);
        assert.strictEqual(await promoBits(bob), 0);
        const kinds = (await require('../server/ledger').entriesOf(t.db, r.txn_id)).map((e) => e.kind).sort();
        assert.deepStrictEqual(kinds, ['platform_revenue', 'user_credit']);
        assert.strictEqual((await t.balances(bob.id)).payable, 0);
        await t.assertReconciled('after promo + usage');
    });

    await check('insufficient Vibes: billing.insufficient_funds, left unrated, promo draw rolled back; rated after a top-up and the retry delay', async () => {
        await grant(carol, 10);
        const rec = await store(reading(carol, { quantity: 5 }));    // 50 gross, 10 promo, 40 from Vibes; carol has none
        const out = await sweep();
        assert.strictEqual(out.skipped, 1);
        let r = await row(rec.idempotency_key);
        assert.strictEqual(r.rating_error, 'billing.insufficient_funds');
        assert.strictEqual(r.rated_at, null);
        assert.ok(new Date(r.rating_due_at).getTime() > t.ctx.now(), 'retried later, not at once');
        assert.strictEqual(await promoBits(carol), 10, 'the promo draw rolled back with the refusal');
        assert.strictEqual((await t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?").get(`promo:consume:usage:${rec.idempotency_key}`)).n, 0);
        await fund(t, carol.id, 100);
        assert.strictEqual((await sweep()).rated, 0, 'not before the retry delay');
        t.clock.offset += t.config.rating.retryMs + 1000;
        assert.strictEqual((await sweep()).rated, 1);
        r = await row(rec.idempotency_key);
        assert.strictEqual(Number(r.vibes_charged), 40);
        assert.strictEqual(Number(r.promo_bits), 10);
        assert.strictEqual(await credit(carol), 60);
    });

    await check('a reading with no person to charge (no subject, an app) is left unrated with rating_error, no txn', async () => {
        const a = await store(reading(null));
        const b = await store(reading(null, { subject: 'app:jobs' }));
        await sweep();
        for (const rec of [a, b]) {
            const r = await row(rec.idempotency_key);
            assert.strictEqual(r.rating_error, 'billing.no_subject');
            assert.strictEqual(r.rating_due_at, null);
            assert.strictEqual(await usageTxns(rec.idempotency_key), 0);
        }
    });

    await check('a unit that does not fit the card is left unrated (billing.unit_mismatch), not retried by itself', async () => {
        const rec = await store(reading(alice, { unit: 'MiB' }));
        await sweep();
        assert.strictEqual((await row(rec.idempotency_key)).rating_error, 'billing.unit_mismatch');
        assert.strictEqual(await credit(alice), 970);
    });

    await check('a charge past the exact integer range is refused (billing.amount_overflow), left for review, not retried by itself', async () => {
        const rec = await store(reading(alice, { quantity: 1e20 }));
        const out = await sweep();
        assert.strictEqual(out.failed, 0);
        const r = await row(rec.idempotency_key);
        assert.strictEqual(r.rating_error, 'billing.amount_overflow');
        assert.strictEqual(r.rating_due_at, null);
        assert.strictEqual(await credit(alice), 970);
    });

    await check('two sweeps at once (and POST /admin/rate beside them) charge each reading once and draw the allowance once', async () => {
        const dave = t.user(4);
        await fund(t, dave.id, 1000);
        await grant(dave, 15);
        const recs = [];
        for (let i = 0; i < 4; i++) recs.push(await store(reading(dave, { quantity: 1 })));   // 10 bits each
        const [a, b, c] = await Promise.all([sweep(), sweep(), t.call('POST', '/api/v1/admin/rate', { body: {}, cap: ADMIN })]);
        assert.strictEqual(c.status, 200, c.text);
        assert.strictEqual(a.rated + b.rated + c.json.rated, 4);
        for (const rec of recs) assert.strictEqual(await usageTxns(rec.idempotency_key) <= 1, true);
        const rows = await Promise.all(recs.map((rec) => row(rec.idempotency_key)));
        const charged = rows.reduce((s, r) => s + Number(r.vibes_charged), 0);
        const drawn = rows.reduce((s, r) => s + Number(r.promo_bits), 0);
        assert.strictEqual(drawn, 15);
        assert.strictEqual(charged, 25);
        assert.strictEqual(await credit(dave), 975);
        assert.strictEqual(await promoBits(dave), 0);
        await t.assertReconciled('after concurrent sweeps');
    });

    await check('a hard budget refuses a charge whole (billing.budget_exceeded), counts spent_bits with the post, and opens again next window', async () => {
        const erin = t.user(5);
        await fund(t, erin.id, 1000);
        const set = await t.call('POST', '/api/v1/admin/budgets', { body: { subject: erin, service: 'media', period: 'day', budget_bits: 50 }, cap: ADMIN });
        assert.strictEqual(set.status, 201, set.text);
        assert.strictEqual(set.json.budget.budget_bits, 50);
        const first = await store(reading(erin, { quantity: 3 }));    // 30
        const second = await store(reading(erin, { quantity: 3 }));   // 30 more: over 50
        await sweep();
        assert.strictEqual(Number((await row(first.idempotency_key)).vibes_charged), 30);
        const r2 = await row(second.idempotency_key);
        assert.strictEqual(r2.rating_error, 'billing.budget_exceeded');
        assert.strictEqual(r2.vibes_charged, null);
        assert.strictEqual(await credit(erin), 970);
        let b = (await t.call('GET', `/api/v1/admin/budgets?subject=${erin.id}`, { cap: ADMIN })).json.budgets;
        assert.strictEqual(b[0].spent_bits, 30);
        const budget0 = await t.call('POST', '/api/v1/admin/budgets', { body: { subject: erin, service: '*', period: 'month', budget_bits: 0 }, cap: ADMIN });
        assert.strictEqual(budget0.status, 201);
        t.clock.offset += 86_400_000 + t.config.rating.retryMs;
        await sweep();
        assert.strictEqual((await row(second.idempotency_key)).rating_error, 'billing.budget_exceeded', 'the all-services budget of 0 stops it');
        await t.call('POST', '/api/v1/admin/budgets', { body: { subject: erin, service: '*', period: 'month', budget_bits: 1000 }, cap: ADMIN });
        t.clock.offset += t.config.rating.retryMs + 1000;
        await sweep();
        assert.strictEqual(Number((await row(second.idempotency_key)).vibes_charged), 30, 'the next day window has room');
        assert.strictEqual(await credit(erin), 940);
        b = (await t.call('GET', `/api/v1/admin/budgets?subject=${erin.id}`, { cap: ADMIN })).json.budgets;
        assert.deepStrictEqual(b.filter((x) => x.service === 'media').map((x) => x.spent_bits), [30, 30]);
        assert.strictEqual(b.find((x) => x.service === '*').spent_bits, 30);
    });

    await check('POST /admin/rate needs billing.ledger.admin and is refused while frozen; the sweep rates nothing while frozen', async () => {
        assert.strictEqual((await t.call('POST', '/api/v1/admin/rate', { body: {}, cap: REC })).status, 403);
        const frank = t.user(6);
        await fund(t, frank.id, 100);
        const rec = await store(reading(frank));
        await t.call('POST', '/api/v1/admin/freeze', { body: { on: true, reason: 'test' }, cap: ADMIN });
        assert.strictEqual((await t.call('POST', '/api/v1/admin/rate', { body: {}, cap: ADMIN })).status, 503);
        assert.strictEqual((await sweep()).frozen, true);
        assert.strictEqual((await row(rec.idempotency_key)).rated_at, null);
        await t.call('POST', '/api/v1/admin/freeze', { body: { on: false }, cap: ADMIN });
        const r = await t.call('POST', '/api/v1/admin/rate', { body: {}, cap: ADMIN });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.rated, 1);
        assert.strictEqual(await credit(frank), 70);
        await t.assertReconciled('end');
    });

    await t.close();
    done();
})();
