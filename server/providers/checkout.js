'use strict';

/**
 * The checkout adapters (plan §AB.16): Coinbase Commerce, Square, Paddle and Lemon Squeezy.
 *
 * A notice from one of these providers is verified with the provider's own signature scheme and
 * recorded in provider_events, and nothing else happens: the checkout adapters (a person paying at
 * checkout) come later, so an event here moves no money and settles no receipt. interpret() says so
 * in words, and the row in the owner's Setup tab says it too.
 *
 * The keys come from the config vault (namespace billing.payments, server/config-store.js): they are
 * write-only and sealed, read at use time, and never logged.
 */
const { provider } = require('../payments');

/**
 * One checkout adapter. It is disabled until its webhook secret is set (then the endpoint answers
 * 404 billing.provider_disabled, like every other provider), it verifies the notice with the
 * provider's scheme, and it records the notice without settling anything.
 */
function createCheckoutAdapter(id, cfg = {}, { fetchImpl = globalThis.fetch } = {}) {
    const def = provider(id);
    // cfg is the provider's settings, read from the vault at use time (config-store.js paymentsSettings),
    // so a key the owner just pasted works without a restart.
    const settings = cfg;
    // Each provider names its own signing key (PayPal a webhook id, Square a signature key), so the
    // endpoint is enabled exactly when that provider's own readiness rule says so.
    const enabled = () => !!(def && cfg && (typeof def.webhookReady === 'function' ? def.webhookReady(cfg) : !!cfg[def.webhookKey]));

    async function verify(req) {
        if (!enabled()) return { ok: false, reason: 'disabled' };
        const out = await def.verify(req, settings, { fetchImpl });
        return out && out.ok ? { ok: true } : { ok: false, reason: (out && out.reason) || 'the signature did not match' };
    }

    function parse(req) {
        const parsed = def.parse(req);
        return { eventId: parsed.eventId, type: parsed.type, payload: parsed.payload };
    }

    async function interpret(ctx, payload, row) {
        // No money moves here: the checkout adapter for this provider comes later, and until it does
        // the notice is only recorded.
        return { effect: 'none', reason: `${def.title} checkout adapter comes later: the notice is recorded, nothing is charged` };
    }

    return { name: id, title: def.title, get enabled() { return enabled(); }, verify, parse, interpret };
}

module.exports = { createCheckoutAdapter };
