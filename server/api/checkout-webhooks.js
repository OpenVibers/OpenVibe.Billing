'use strict';

/**
 * The checkout providers' webhooks: POST /checkout/webhooks/<provider> (plan §AB.16).
 *
 *   404 billing.provider_disabled   the provider has no webhook secret set (nothing is stored)
 *   401 webhook.unverified           the signature did not match (nothing is stored)
 *   200 { received, recorded }        the notice was verified and recorded; no money moved
 *
 * The notice is stored in provider_events before anything else happens, with the provider's own id
 * and event id, so a redelivery is stored once (UNIQUE(provider, provider_event_id)). Nothing is
 * settled: the checkout adapters come later, and until they do an event here moves no money and
 * settles no receipt.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const providers = require('../providers');
const { iso } = require('../ledger');

function checkoutWebhooksRouter({ ctx, adapters }) {
    const r = express.Router();
    // The raw body is kept for the signature check: the providers sign the bytes they sent.
    const raw = express.raw({ type: () => true, limit: '1mb' });

    r.post('/:provider', raw, async (req, res) => {
        const adapter = adapters[req.params.provider];
        if (!adapter) return http.sendProblem(res, 404, 'billing.unknown_provider', { ctx: req.ov });
        if (!adapter.enabled) return http.sendProblem(res, 404, 'billing.provider_disabled', { detail: `${adapter.title} is not enabled on Billing`, ctx: req.ov });
        req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        try {
            const v = await adapter.verify(req);
            if (!v.ok) {
                (ctx.log || console).warn(`[Billing] ${adapter.title} webhook rejected: ${v.reason}`);
                return http.sendProblem(res, 401, 'webhook.unverified', { detail: v.reason, ctx: req.ov });
            }
            let parsed;
            try { parsed = adapter.parse(req); } catch { return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'unparseable payload', ctx: req.ov }); }
            if (!parsed.eventId) return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'no event id', ctx: req.ov });
            const { row, duplicate } = await providers.store(ctx, adapter.name, parsed);
            // The notice is recorded and nothing else: no receipt, no transaction, no money.
            const result = await adapter.interpret(ctx, parsed.payload, row);
            await ctx.db.prepare('UPDATE provider_events SET processed_at = ?, result = ? WHERE id = ?')
                .run(iso(ctx.now()), JSON.stringify(result), row.id);
            return res.status(200).json({ received: true, recorded: true, duplicate, event: row.id, result });
        } catch (e) {
            (ctx.log || console).error(`[Billing] ${adapter.title} webhook error:`, e);
            return http.sendProblem(res, 500, 'billing.internal', { detail: 'webhook error', ctx: req.ov });
        }
    });
    return r;
}

module.exports = { checkoutWebhooksRouter };
