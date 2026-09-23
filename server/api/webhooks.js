'use strict';

/**
 * Provider webhooks: POST /webhooks/<provider> (CCBill also sends GET).
 *
 *   404 billing.provider_disabled  the adapter has no secrets configured (nothing is stored)
 *   401 webhook.unverified         signature/secret check failed (nothing is stored)
 *   200 { received, duplicate }    a redelivery of a stored event (processed if still pending)
 *   200 { received, processed, result }
 *   202 { received, queued }       stored while the economy is frozen; processed after unfreeze
 *
 * The raw body is kept for signature checks; the verified payload is stored in provider_events
 * before any processing.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const providers = require('../providers');
const { isFrozen } = require('../ops/common');

function webhooksRouter({ ctx, adapters }) {
    const r = express.Router();
    const raw = express.raw({ type: () => true, limit: '1mb' });

    r.all('/:provider', raw, async (req, res) => {
        const adapter = adapters[req.params.provider];
        if (!adapter) return http.sendProblem(res, 404, 'billing.unknown_provider', { ctx: req.ov });
        if (!adapter.enabled) return http.sendProblem(res, 404, 'billing.provider_disabled', { detail: `${adapter.name} is not enabled on Billing`, ctx: req.ov });
        if (req.method !== 'POST' && adapter.name !== 'ccbill') return http.sendProblem(res, 405, 'webhook.method', { ctx: req.ov });
        req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        try {
            const v = await adapter.verify(req);
            if (!v.ok) {
                (ctx.log || console).warn(`[Billing] ${adapter.name} webhook rejected: ${v.reason}`);
                return http.sendProblem(res, 401, 'webhook.unverified', { detail: v.reason, ctx: req.ov });
            }
            let parsed;
            try { parsed = adapter.parse(req); } catch { return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'unparseable payload', ctx: req.ov }); }
            if (!parsed.eventId) return http.sendProblem(res, 400, 'webhook.malformed', { detail: 'no event id', ctx: req.ov });
            const { row, duplicate } = providers.store(ctx, adapter.name, parsed);
            if (isFrozen(ctx.db)) return res.status(202).json({ received: true, queued: true, event: row.id, duplicate });
            const after = row.processed_at ? row : await providers.process(ctx, adapters, row);
            return res.status(200).json({ received: true, duplicate, event: after.id, processed: !!after.processed_at, result: after.result || null });
        } catch (e) {
            (ctx.log || console).error(`[Billing] ${adapter.name} webhook error:`, e);
            return http.sendProblem(res, 500, 'billing.internal', { detail: 'webhook error', ctx: req.ov });
        }
    });
    return r;
}

module.exports = { webhooksRouter };
