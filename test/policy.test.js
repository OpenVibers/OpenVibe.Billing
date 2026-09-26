'use strict';
// The public billing policy (WS-K task 10): every number on /policy comes from the configured rates,
// it is public and indexable while the console stays hidden, and it loads no scripts.
const assert = require('assert');
const { boot } = require('./helpers/app');
const { policyData } = require('../server/policy');

(async () => {
    // The data from the default rates (Live's values, docs/economic-inventory.md).
    const t = await boot();
    try {
        const d = policyData(t.config.rates, { authority: t.config.authority });
        assert.deepStrictEqual(d.purchase.tiers.map((x) => [x.from, x.to, x.price_per_100_cents]), [
            [100, 499, 150], [500, 999, 140], [1000, 2499, 130], [2500, 4999, 124], [5000, 9999, 120], [10000, 24999, 115], [25000, null, 110],
        ], 'tiers start at the minimum purchase and cover every amount once');
        assert.deepStrictEqual(d.purchase.tiers.map((x) => x.openvibe_keeps_pct), [33.3, 28.6, 23.1, 19.4, 16.7, 13, 9.1]);
        assert.ok(d.purchase.tiers.every((x) => x.creator_value_per_100_cents === 100), 'a creator gets $1.00 per 100 Vibes at every tier');
        assert.deepStrictEqual(d.subscription, { price_cents: 499, period_days: 31, creator_share_pct: 70, creator_share_cents: 349, site_route_fee_pct: 10, site_route_fee_cents: 50 });
        assert.deepStrictEqual(d.cashout, { min_vibes: 500, min_cents: 500, hold_days: 14 });
        assert.strictEqual(d.currencies.opencoins.withdrawable, false, 'OpenCoins are never withdrawable');
        assert.strictEqual(d.currencies.channel_points.withdrawable, false);

        // The page and its JSON, public and cacheable; no scripts, the numbers present.
        let r = await fetch(`${t.base}/policy`);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control'), /public/);
        const html = await r.text();
        assert.ok(!/<script/i.test(html), 'no scripts');
        for (const s of ['$1.50', '$1.10', '33.3%', '9.1%', '$4.99', '31 days', '70%', '$3.49', '500 Vibes ($5.00)', '14 days', 'Contact@OpenVibe.Network', 'openvibe.live keeps the ledger']) {
            assert.ok(html.includes(s), `the page says ${s}`);
        }
        assert.ok(html.includes('href="https://openvibe.network/terms"'), 'the terms link is the Network terms page');
        // One canonical URL on the configured origin, and an icon in the page (no /favicon.ico request to 404).
        assert.deepStrictEqual(html.match(/<link rel="canonical" href="[^"]*">/g), [`<link rel="canonical" href="${t.config.baseUrl}/policy">`]);
        assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,%3Csvg/);
        r = await fetch(`${t.base}/policy.json`);
        assert.deepStrictEqual(await r.json(), JSON.parse(JSON.stringify(d)));
        r = await fetch(`${t.base}/robots.txt`);
        assert.strictEqual(await r.text(), 'User-agent: *\nAllow: /policy\nDisallow: /\n');
    } finally { await t.close(); }

    // Configured rates change the page, not the code; Billing as the ledger says so.
    const t2 = await boot({ env: { BILLING_ESCROW_DAYS: '7', BILLING_MIN_CASHOUT_BITS: '1000', BILLING_SUB_SHARE_PCT: '80', BILLING_AUTHORITY: 'billing' } });
    try {
        const html = await (await fetch(`${t2.base}/policy`)).text();
        assert.ok(html.includes('7 days') && html.includes('1,000 Vibes ($10.00)') && html.includes('80%') && html.includes('OpenVibe Billing keeps the ledger'));
        assert.ok(!html.includes('14 days'));
    } finally { await t2.close(); }

    console.log('policy: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
