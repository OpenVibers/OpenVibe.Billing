'use strict';
const crypto = require('crypto');
const { fail, positiveInt } = require('./common');
const { idempotencyKey } = require('./balance');
const { topupTerms } = require('./credits');
const intents = require('./intents');

function offers(ctx, adapters) {
    const terms = topupTerms(ctx);
    return {
        // Each provider names the hosts its hosted checkout may use; the wallet follows a checkout_url only to one
        // of them (or to Billing itself) and refuses anything else.
        providers: Object.values(adapters).filter((a) => a.enabled && a.createCheckout).map((a) => ({ name: a.name, hosts: Array.isArray(a.checkoutHosts) ? a.checkoutHosts : [] })),
        vibes: { minimum: ctx.rates.minPurchaseBits, maximum: ctx.rates.maxBits, price_tiers: ctx.rates.priceTiers },
        topup: { enabled: !!(ctx.config.credits.enabled && terms.enabled && terms.configured),
            amounts_cents: terms.configured ? terms.amountsCents : [], fee_bps: terms.feeBps },
    };
}

async function checkout(ctx, adapters, subject, kind, input) {
    const key = idempotencyKey(input.idempotency_key);
    const provider = String(input.provider || '');
    const amount = positiveInt(kind === 'vibes' ? input.vibes : input.amount_cents, kind === 'vibes' ? 'vibes' : 'amount_cents');
    const hash = crypto.createHash('sha256').update(JSON.stringify({ kind, provider, amount })).digest('hex');
    const old = await ctx.db.prepare('SELECT * FROM wallet_checkouts WHERE subject = ? AND idempotency_key = ?').get(subject, key);
    if (old) {
        if (old.request_hash !== hash) fail(409, 'billing.key_reused', 'This key names a different checkout');
        if (old.response) return typeof old.response === 'string' ? JSON.parse(old.response) : old.response;
        fail(409, 'billing.checkout_pending', 'The original checkout is being confirmed. Do not start another payment.');
    }
    if (ctx.config.authority !== 'billing') fail(409, 'billing.not_authoritative', 'Billing is not the active ledger');
    await require('./wallet-freeze').assertWalletWritable(ctx);
    const adapter = adapters[provider];
    if (!adapter || !adapter.enabled || !adapter.createCheckout) fail(409, 'billing.provider_disabled', 'Choose an available checkout provider');
    const available = offers(ctx, adapters);
    if (kind === 'vibes' && (amount < available.vibes.minimum || amount > available.vibes.maximum)) fail(422, 'billing.invalid_amount', 'Choose an offered Vibes amount');
    if (kind === 'topup' && (!available.topup.enabled || !available.topup.amounts_cents.includes(amount))) fail(422, 'billing.amount_not_allowed', 'Choose an offered top-up');
    const claimed = await ctx.db.prepare(`INSERT INTO wallet_checkouts (subject, idempotency_key, request_hash, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING subject`).get(subject, key, hash, new Date(ctx.now()).toISOString());
    if (!claimed) fail(409, 'billing.checkout_pending', 'The original checkout is being confirmed');
    // Persist the claim before contacting a provider. An uncertain result is never retried as a second checkout.
    let result;
    if (kind === 'topup') {
        result = await require('./topups').startTopup(ctx, adapters, { subject, provider, amount_cents: amount });
    } else {
        const intent = await intents.create(ctx, { subject, provider, kind: 'purchase', bits: amount });
        const opened = await adapter.createCheckout(ctx, intent, { name: `${amount} Vibes`,
            successUrl: `${ctx.config.baseUrl}/checkout/success`, cancelUrl: `${ctx.config.baseUrl}/checkout/cancel`,
            ipnUrl: `${ctx.config.baseUrl}/webhooks/${adapter.name}` });
        if (opened.providerRef) await intents.setProviderRef(ctx, intent.id, opened.providerRef);
        result = { intent: intents.present(await intents.find(ctx.db, intent.id)), checkout_url: opened.url || null };
    }
    await ctx.db.prepare('UPDATE wallet_checkouts SET response = ? WHERE subject = ? AND idempotency_key = ?')
        .run(JSON.stringify(result), subject, key);
    return result;
}

async function completeReturn(ctx, adapters, token) {
    if (token == null) return; // Providers with webhook settlement need no browser capture.
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(token)) fail(422, 'billing.invalid_order', 'Invalid payment return');
    const intent = await intents.findByProviderRef(ctx.db, 'paypal', token);
    if (!intent) fail(404, 'billing.intent_not_found', 'Payment order not found');
    if (intent.settled_txn) return;
    await require('./wallet-freeze').assertWalletWritable(ctx);
    const adapter = adapters.paypal;
    if (!adapter || !adapter.enabled || !adapter.capture) fail(409, 'billing.provider_disabled', 'PayPal is unavailable');
    // The token only selects a server-owned intent. PayPal verifies the buyer's approval and the paid amount.
    const plan = await adapter.capture(ctx, intent);
    if (!['purchase', 'credits_topup'].includes(plan.effect)) fail(409, 'billing.payment_pending', 'Payment is not confirmed yet');
    await require('../ledger').money(ctx.db, () => require('../providers').applyPlan(ctx, plan, { id: null }));
}

module.exports = { offers, checkout, completeReturn };
