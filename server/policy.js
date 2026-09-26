'use strict';
/**
 * The public billing policy (roadmap WS-K task 10): what a viewer pays, what a creator receives, what
 * OpenVibe keeps, and how cashouts, holds and refunds work, at billing.openvibe.network/policy (and
 * /policy.json for machines). Every number comes from the configured rates (config.rates, ADR-012), so
 * the page cannot drift from what the ledger charges; the words around them are fixed here.
 *
 * While BILLING_AUTHORITY is 'live', openvibe.live's ledger applies these rules; Billing's rates are
 * configured to match it (docs/economic-inventory.md), and the page says which ledger is in charge.
 * Server-rendered, no scripts, no external requests: it is linked from the terms and the Codes docs.
 */
const express = require('express');

const TERMS_URL = 'https://openvibe.network/terms';
const CONTACT = 'Contact@OpenVibe.Network';
// The date the wording last changed. Rate changes show up on their own (the numbers are live).
const WORDING_DATE = '2026-09-26';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const pct = (n) => `${Math.round(n * 10) / 10}%`;
const num = (n) => Number(n).toLocaleString('en-US');

/** The policy as data, from the rates (a createRates() result or the plain config.rates). */
function policyData(rates, { authority = 'live' } = {}) {
    const perVibeValueCents = 100 / rates.bitsPerUsd; // what one Vibe is worth to a creator
    const tiers = [...rates.priceTiers].sort((a, b) => a.min - b.min).map((t, i, all) => {
        const next = all[i + 1];
        const priceCents = t.usd_per_bit * 100;
        return {
            from: Math.max(t.min, rates.minPurchaseBits || 0),
            to: next ? next.min - 1 : null,
            price_per_100_cents: Math.round(priceCents * 100),
            creator_value_per_100_cents: Math.round(perVibeValueCents * 100),
            openvibe_keeps_pct: Math.max(0, Math.round((1 - perVibeValueCents / priceCents) * 1000) / 10),
        };
    }).filter((t) => t.to == null || t.to >= t.from);
    const subCents = rates.subPriceCents;
    return {
        authority,
        wording_date: WORDING_DATE,
        currencies: {
            vibes: { bought_with_money: true, cash_value_per_100_cents: Math.round(perVibeValueCents * 100), withdrawable: 'only Vibes you received' },
            opencoins: { bought_with_money: false, withdrawable: false },
            channel_points: { bought_with_money: false, withdrawable: false },
        },
        purchase: { min_vibes: rates.minPurchaseBits, max_vibes: rates.maxBits, tiers },
        tips: { creator_receives_pct: 100 },
        subscription: {
            price_cents: subCents,
            period_days: rates.subPeriodDays,
            creator_share_pct: rates.subSharePct,
            creator_share_cents: Math.floor((subCents * rates.subSharePct) / 100),
            site_route_fee_pct: rates.siteRouteFeePct,
            site_route_fee_cents: Math.round((subCents * rates.siteRouteFeePct) / 100),
        },
        cashout: { min_vibes: rates.minCashoutBits, min_cents: Math.round(rates.minCashoutBits * perVibeValueCents), hold_days: rates.escrowDays },
    };
}

function renderPolicy(d) {
    const s = d.subscription, c = d.cashout, p = d.purchase;
    const tierRows = p.tiers.map((t) => `<tr><td>${num(t.from)}${t.to == null ? ' or more' : `–${num(t.to)}`}</td><td>${usd(t.price_per_100_cents)}</td><td>${usd(t.creator_value_per_100_cents)}</td><td>${pct(t.openvibe_keeps_pct)}</td></tr>`).join('');
    const ledger = d.authority === 'billing'
        ? 'OpenVibe Billing keeps the ledger these rules apply to.'
        : 'Today openvibe.live keeps the ledger; it applies these same rules, and OpenVibe Billing will take over the ledger without changing them.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Billing policy · OpenVibe</title>
<meta name="description" content="What you pay, what creators receive, what OpenVibe keeps, and how cashouts, holds and refunds work.">
<link rel="alternate" type="application/json" href="/policy.json">
<style>
:root{color-scheme:light dark;--bg:#f6f7fb;--fg:#141824;--muted:#555d70;--card:#fff;--line:#dde1ea;--accent:#3d63dd}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e16;--fg:#e8ebf3;--muted:#a3abbd;--card:#141925;--line:#262d3d;--accent:#7b9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.9rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.2rem;margin:34px 0 8px}
p,li{color:var(--muted)}strong{color:var(--fg)}a{color:var(--accent)}.lead{font-size:1.05rem}.meta{font-size:.85rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px;margin:12px 0}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--fg);font-weight:600}tr:last-child td{border-bottom:0}td:not(:first-child),th:not(:first-child){text-align:right}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:12px 0}dt{font-weight:600}dd{margin:0;color:var(--muted)}
@media (max-width:520px){dl{grid-template-columns:1fr}dd{margin-bottom:8px}}
</style></head><body><main>
<h1>How money works on OpenVibe</h1>
<p class="lead">What you pay, what creators receive, what OpenVibe keeps, and how cashouts and refunds work. The numbers on this page are read from the rates the ledger charges, so they are always the current ones.</p>
<p class="meta">${esc(ledger)} Wording last changed ${esc(d.wording_date)}. Machine-readable: <a href="/policy.json">/policy.json</a>.</p>

<h2>Three kinds of currency</h2>
<dl>
<dt>Vibes</dt><dd>Bought with money and sent to creators as tips. ${usd(d.currencies.vibes.cash_value_per_100_cents)} of creator value per 100 Vibes. Only Vibes you <strong>received</strong> can be cashed out; Vibes you bought are for sending.</dd>
<dt>OpenCoins</dt><dd>Earned across the network by watching, chatting and following. They cannot be bought, have no cash value and can never be withdrawn.</dd>
<dt>Channel points</dt><dd>Earned in one creator's channel and spent there. No cash value, never withdrawable.</dd>
</dl>

<h2>Buying Vibes</h2>
<p>Bigger purchases cost less per Vibe. A creator always receives the same value per Vibe; the difference between the price and that value is what OpenVibe keeps to run the platform and pay payment processing.</p>
<div class="card scroll"><table><thead><tr><th scope="col">Vibes in one purchase</th><th scope="col">You pay per 100</th><th scope="col">Creator receives per 100</th><th scope="col">OpenVibe keeps</th></tr></thead><tbody>${tierRows}</tbody></table></div>
<p>One purchase is ${num(p.min_vibes)} to ${num(p.max_vibes)} Vibes. The payment itself is handled by a payment processor under its own terms; OpenVibe never sees your card number.</p>

<h2>Tips</h2>
<p>When you send Vibes, the creator receives all of them: nothing is taken when a tip is sent. A tip paid through OpenVibe's PowerChat account for a creator without their own PowerChat is credited to the creator in full, one Vibe per cent.</p>

<h2>Subscriptions</h2>
<p>A subscription is <strong>${usd(s.price_cents)}</strong> for ${num(s.period_days)} days.</p>
<ul>
<li>Paid through the creator's own PowerChat: the creator is paid directly by PowerChat, and OpenVibe adds no fee.</li>
<li>Paid through OpenVibe's PowerChat account: a routing fee of ${pct(s.site_route_fee_pct)} (${usd(s.site_route_fee_cents)}) is added on top of the price, and the creator receives ${pct(s.creator_share_pct)} of the price (${usd(s.creator_share_cents)}) as Vibes they can cash out. The routing fee is not part of the split.</li>
</ul>

<h2>Cashing out</h2>
<ul>
<li>The minimum cashout is <strong>${num(c.min_vibes)} Vibes (${usd(c.min_cents)})</strong>, paid to PayPal.</li>
<li>A cashout is held for <strong>${num(c.hold_days)} days</strong> and reviewed before it is paid. The hold covers the window in which payments can still be reversed.</li>
<li>A cashout that is declined returns its Vibes to your cashout balance.</li>
<li>Payouts connected to fraud or chargebacks can be withheld, as the <a href="${TERMS_URL}">terms</a> say. Creators are responsible for their own taxes.</li>
</ul>

<h2>Refunds</h2>
<p>Tips, subscriptions and Vibes purchases are voluntary and final, except where the law requires a refund. If you think a charge is wrong, write to <a href="mailto:${CONTACT}">${CONTACT}</a> before disputing it with your bank, and we will look at it.</p>

<h2>When the rates change</h2>
<p>A change of rates is announced on the site before it takes effect, and this page shows the new numbers from the moment they apply. Every transaction records the rates it was made at, so a later change never alters a past purchase, tip or cashout.</p>
</main></body></html>`;
}

/** GET /policy (HTML) and GET /policy.json. */
function policyRouter({ config }) {
    const r = express.Router();
    const data = () => policyData(config.rates, { authority: config.authority });
    r.get('/policy', (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.type('html').send(renderPolicy(data()));
    });
    r.get('/policy.json', (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(data());
    });
    return r;
}

module.exports = { policyRouter, policyData, renderPolicy };
