'use strict';

/**
 * The owner-settings surface (D11): openvibe-shared/config's adminRoutes mounted at /internal/config.
 *
 * Only Network's service token holds `billing.config.manage`; every route is guarded by it (server/api/auth.js).
 * The acting subject is the owner's usr_ id in X-OV-Subject, and only for a caller that holds the capability;
 * X-OV-Fresh: 1 is required for a write to an x-danger key, so a stale session can never turn Balance or the
 * top-up switch on. The namespaces (`billing.credits`, `billing.vibes`, `billing.cards`) are served here; their
 * onChange writes Billing's audit line (server/config-store.js). POST /internal/config/:namespace/test/:key is the
 * Setup tab's Test button for the Stripe keys (server/owner-inputs.js).
 *
 * The paths are full paths (the router is mounted at the app root) so the capability declaration's
 * implementedBy list points at real routes.
 */
const express = require('express');
const { capabilities } = require('openvibe-contracts');
const { adminRoutes } = require('openvibe-shared/config');
const { testRoute, testStripeKey, testStripeWebhook } = require('./owner-inputs');
const payments = require('./payments');

const CAP = 'billing.config.manage';
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function internalConfigRouter({ ctx, auth }) {
    const r = express.Router();
    // The store is the only caller of the config routes, so its body parser needs to run only on these paths.
    r.use('/internal/config', express.json({ limit: '64kb' }));
    const routes = adminRoutes([ctx.configStore, ctx.vibesConfigStore, ...(ctx.cardsConfigStore ? [ctx.cardsConfigStore] : []), ...(ctx.paymentsConfigStore ? [ctx.paymentsConfigStore] : [])], {
        requireAdmin: auth.needs(CAP),
        basePath: '/internal/config',
        actor: (req) => {
            // Only a caller holding the capability may name an owner (the guard above already ran).
            if (!req.principal || !capabilities.grants(req.principal.cap, CAP)) return null;
            const id = String(req.headers['x-ov-subject'] || '');
            return USER_SUBJECT_RE.test(id) ? { type: 'user', id } : null;
        },
        requireFresh: (req) => req.headers['x-ov-fresh'] === '1',
        log: ctx.log,
    });
    r.get('/internal/config', routes.list);
    r.get('/internal/config/:namespace', routes.get);
    r.get('/internal/config/:namespace/history', routes.history);
    r.post('/internal/config/:namespace', routes.apply);
    r.post('/internal/config/:namespace/rollback', routes.rollback);
    r.put('/internal/config/:namespace/secrets/:key', routes.secretPut);
    r.delete('/internal/config/:namespace/secrets/:key', routes.secretDelete);
    // The Setup tab's Test button (owner-setup design): one read-only Stripe call with the stored key, one line back.
    r.post('/internal/config/:namespace/test/:key', auth.needs(CAP), testRoute({
        log: ctx.log,
        now: ctx.now,
        resolve: (namespace, key) => {
            if (namespace === 'billing.payments') {
                // A checkout provider's own key: the vault value, and where it came from.
                const provider = payments.PROVIDERS.find((p) => p.keys.some((k) => k.name === key && k.test));
                if (!provider) return null;
                const cfg = ctx.config.providers.checkout && ctx.config.providers.checkout[provider.id];
                if (!cfg || typeof cfg.source !== 'function') return null;
                return cfg.source(key.split('.').slice(1).join('.'));
            }
            const stripe = ctx.config.providers.stripe;
            if (namespace !== 'billing.cards' || !stripe || typeof stripe.source !== 'function') return null;
            if (key !== 'stripe.secret_key' && key !== 'stripe.webhook_secret') return null;
            return stripe.source(key);
        },
        run: (namespace, key, value) => {
            if (namespace === 'billing.payments') {
                const provider = payments.PROVIDERS.find((p) => p.keys.some((k) => k.name === key && k.test));
                const cfg = ctx.config.providers.checkout && ctx.config.providers.checkout[provider.id];
                // One cheap authenticated read of the provider's own API: it never charges and never sends.
                return provider.test(cfg, { fetchImpl: ctx.fetchImpl || globalThis.fetch });
            }
            return key === 'stripe.secret_key'
                ? testStripeKey(ctx.config.providers.stripe, value, { fetchImpl: ctx.fetchImpl || globalThis.fetch })
                : testStripeWebhook(ctx.config.providers.stripe, value, { fetchImpl: ctx.fetchImpl || globalThis.fetch });
        },
    }));
    return r;
}

module.exports = { internalConfigRouter, CAP, USER_SUBJECT_RE };
