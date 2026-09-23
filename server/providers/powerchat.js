'use strict';

/**
 * PowerChat adapter — the one rail that carries money in production today.
 * Ported from OpenVibe.Live server/integrations/powerchat-webhook.js + powerchat-checkout.js.
 *
 * Verification (unchanged from Live): HMAC-SHA256 over "<timestamp>.<raw body>" in
 * X-PowerChat-Signature ("sha256=<hex>"), X-PowerChat-Timestamp (unix ms) within ±15 minutes,
 * timing-safe compare. The delivery id (X-PowerChat-Delivery-Id) is the provider event id, so an
 * at-least-once redelivery is stored once; the donation's own eventId is the receipt reference,
 * so even a redelivery under a new delivery id settles once.
 *
 * donation.completed, by the checkout ref we minted into app_ref (appExternalRef):
 *   pcorder:<intent>            Vibes purchase on the site account → CREDIT for the buyer
 *   pcsub:<intent>              subscription: route 'site' → MONEY (share to the creator, fee +
 *                               rest platform revenue); route 'direct' → EXTERNAL (entitlement
 *                               only, the streamer holds the money). Underpaid: site → a plain
 *                               site-routed tip to the streamer; direct → EXTERNAL tip, no effect.
 *   pcdon:<streamer>:<donor>    site-routed tip for a creator → MONEY into their payable
 *                               (legacy links carry Live user ids; they are resolved to subjects)
 *   (pcorder, site pcsub and pcdon count only when the tip was paid to POWERCHAT_SITE_USERNAME:
 *    the ref is buyer-editable in the fallback tip link; from any other account they are held)
 *   anything else               a tip on a streamer's own PowerChat → EXTERNAL, no Billing effect
 *                               (recorded as an interaction by OpenVibe.Tips).
 * Test deliveries (isTest, or source manual_test) move no money and are ignored unless
 * POWERCHAT_ALLOW_TEST_FULFILLMENT is on, in which case they settle flagged test. App-sourced
 * echoes of our own forwarded tips (source developer_app) are ignored.
 *
 * Refund/dispute events: PowerChat's documented webhook set (as used by Live) has none today.
 * donation.refunded → refund and donation.disputed | donation.chargeback → chargeback are
 * handled against the original donation's eventId (data.originalEventId | donationEventId |
 * donationId) so they work the day PowerChat sends them; the names are an assumption to confirm.
 */
const crypto = require('crypto');
const intents = require('../ops/intents');

const REFUND_TYPES = { 'donation.refunded': 'refund', 'donation.disputed': 'chargeback', 'donation.chargeback': 'chargeback', 'donation.charged_back': 'chargeback' };

function createPowerchat(cfg, { network } = {}) {
    const enabled = !!cfg.webhookSecret;

    function verify(req) {
        const secret = cfg.webhookSecret;
        if (!secret) return { ok: false, reason: 'webhook secret not configured' };
        const sig = String(req.headers['x-powerchat-signature'] || '');
        const ts = String(req.headers['x-powerchat-timestamp'] || '');
        if (!sig || !ts) return { ok: false, reason: 'missing signature/timestamp headers' };
        const t = Number(ts);
        if (!Number.isFinite(t) || Math.abs(Date.now() - t) > cfg.maxSkewMs) return { ok: false, reason: 'timestamp outside allowed window' };
        const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(ts + '.').update(req.rawBody).digest('hex'));
        const given = Buffer.from(sig);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'signature mismatch' };
        return { ok: true };
    }

    function parse(req) {
        const body = JSON.parse(req.rawBody.toString('utf8'));
        const data = body.data || {};
        const type = String(req.headers['x-powerchat-event-type'] || body.type || 'unknown');
        const eventId = req.headers['x-powerchat-delivery-id'] || body.id || (data.eventId ? `${type}:${data.eventId}` : null);
        return { eventId: eventId ? String(eventId) : null, type, payload: body };
    }

    async function resolveUser(ref) {
        if (!ref || ref === '0') return null;
        if (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return ref;
        if (/^\d+$/.test(ref) && network) {
            const map = await network.resolveLiveUsers([ref]);
            return map.get(String(ref)) || null;
        }
        return null;
    }

    async function interpret(ctx, envelope, row) {
        const type = envelope.type || row.type;
        const data = envelope.data || {};
        const actor = { principal: 'provider:powerchat', provider_event: row.provider_event_id };
        const key = `pe:powerchat:${row.provider_event_id}`;
        if (data.source === 'developer_app') return { effect: 'none', reason: 'echo of our own forwarded event (source developer_app)' };
        const isTest = !!data.isTest || data.source === 'manual_test';
        if (isTest && !cfg.allowTest) return { effect: 'none', reason: 'test delivery — no money moved (POWERCHAT_ALLOW_TEST_FULFILLMENT is off)' };
        const cents = Math.max(0, Math.round(Number(data.amountUsdCents != null ? data.amountUsdCents : data.amountCents) || 0));

        if (REFUND_TYPES[type]) {
            const orig = data.originalEventId || data.donationEventId || data.donationId;
            if (!orig) return { effect: 'none', reason: `${type} without a reference to the original donation` };
            return {
                effect: 'reverse',
                args: {
                    kind: REFUND_TYPES[type], provider: 'powerchat', originalReceiptRef: `powerchat:${orig}`,
                    reversalRef: `powerchat:${type}:${data.eventId || row.provider_event_id}`,
                    cents: data.refundedUsdCents != null ? Number(data.refundedUsdCents) : (cents || undefined),
                    idempotencyKey: key, actor, reason: type,
                },
            };
        }
        if (type !== 'donation.completed') return { effect: 'none', reason: `${type} carries no money` };

        const paymentId = data.eventId || data.donationId || row.provider_event_id;
        const receiptRef = `powerchat:${paymentId}`;
        const ref = String(data.appExternalRef || '');
        const meta = { powerchat_event: paymentId, donor_name: data.donorName ? String(data.donorName).slice(0, 80) : null, app_ref: ref || null };
        const host = String((envelope.streamer && envelope.streamer.username) || '').toLowerCase();
        // Money only reaches OpenVibe when it was paid to the SITE account. app_ref rides in the
        // buyer-editable fallback tip link (?app_ref=…), so a creator could put `pcorder:` / `pcdon:` /
        // a site `pcsub:` ref on a tip to their OWN PowerChat (money they keep) and have Billing mint
        // credit or cash-out-able payable for it. Site-routed refs from any other account are held.
        const onSite = !!cfg.siteUsername && host === cfg.siteUsername;
        const offSite = (what) => ({
            effect: 'none', review: true,
            reason: cfg.siteUsername
                ? `${what} ${ref} was paid to PowerChat account "${host || 'unknown'}", not the site account — nothing credited, held for review`
                : `${what} ${ref}: POWERCHAT_SITE_USERNAME is not set, so the receiving account cannot be verified — nothing credited, held for review`,
        });
        let m;
        if ((m = ref.match(/^pcorder:(.+)$/))) {
            if (!onSite) return offSite('purchase checkout');
            const intent = intents.find(ctx.db, m[1]);
            if (!intent || intent.kind !== 'purchase') return { effect: 'none', reason: `purchase checkout ${ref} has no purchase intent` };
            if (cents < 1) return { effect: 'none', reason: 'zero-amount purchase' };
            return { effect: 'purchase', args: { provider: 'powerchat', receiptRef, intentId: intent.id, paidCents: cents, test: isTest, idempotencyKey: key, actor, metadata: meta } };
        }
        if ((m = ref.match(/^pcsub:(.+)$/))) {
            const intent = intents.find(ctx.db, m[1]);
            if (!intent || intent.kind !== 'subscription' || !intent.streamer_subject) return { effect: 'none', reason: `subscription checkout ${ref} has no subscription intent` };
            const route = intent.route === 'direct' ? 'direct' : 'site';
            if (route === 'site' && !onSite) return offSite('site-routed subscription checkout');
            if (cents + 1 < intent.amount_cents && intents.settledInLive(intent)) {
                return { effect: 'none', reason: `underpaid delivery for ${ref}, which Live already credited before the cutover — review`, review: true };
            }
            if (cents + 1 < intent.amount_cents) {
                if (route === 'direct') return { effect: 'none', reason: 'underpaid direct subscription: an EXTERNAL tip to the streamer' };
                return { effect: 'tip', args: { provider: 'powerchat', receiptRef, paidCents: cents, from: intent.subject, to: intent.streamer_subject, test: isTest, idempotencyKey: key, actor, metadata: { ...meta, underpaid_subscription_intent: intent.id } } };
            }
            return {
                effect: 'subscription',
                args: {
                    subscriber: intent.subject, streamer: intent.streamer_subject, source: 'receipt', intentId: intent.id, autoRenew: intent.auto_renew,
                    receipt: { provider: 'powerchat', receiptRef, paidCents: cents, feeCents: intent.fee_cents, route, test: isTest },
                    idempotencyKey: key, actor,
                },
            };
        }
        if ((m = ref.match(/^pcdon:([^:]+):([^:]*)$/))) {
            if (!onSite) return offSite('site-routed tip');
            const to = await resolveUser(m[1]);
            if (!to) return { effect: 'none', reason: `site-routed tip for unknown streamer ${m[1]} — held for review`, hold: true };
            const from = await resolveUser(m[2]);
            if (cents < 1) return { effect: 'none', reason: 'zero-amount tip' };
            return { effect: 'tip', args: { provider: 'powerchat', receiptRef, paidCents: cents, from, to, test: isTest, idempotencyKey: key, actor, metadata: meta } };
        }
        if (onSite) {
            // Money on the SITE account without one of our refs: Live ignored these. They are
            // recorded here and listed by reconciliation instead of vanishing.
            return { effect: 'none', reason: 'unattributed tip to the site PowerChat account — review', review: true };
        }
        return { effect: 'none', reason: 'EXTERNAL: a tip on the streamer\'s own PowerChat — no Billing liability' };
    }

    return { name: 'powerchat', enabled, verify, parse, interpret };
}

module.exports = { createPowerchat };
