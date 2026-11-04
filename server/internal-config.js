'use strict';

/**
 * The owner-settings surface (D11): openvibe-shared/config's adminRoutes mounted at /internal/config.
 *
 * Only Network's service token holds `billing.config.manage`; every route is guarded by it (server/api/auth.js).
 * The acting subject is the owner's usr_ id in X-OV-Subject, and only for a caller that holds the capability;
 * X-OV-Fresh: 1 is required for a write to an x-danger key, so a stale session can never turn Credits or the
 * top-up switch on. The store's onChange writes Billing's audit line (server/config-store.js).
 *
 * The paths are full paths (the router is mounted at the app root) so the capability declaration's
 * implementedBy list points at real routes.
 */
const express = require('express');
const { capabilities } = require('openvibe-contracts');
const { adminRoutes } = require('openvibe-shared/config');

const CAP = 'billing.config.manage';
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function internalConfigRouter({ ctx, auth }) {
    const r = express.Router();
    // The store is the only caller of the config routes, so its body parser needs to run only on these paths.
    r.use('/internal/config', express.json({ limit: '64kb' }));
    const routes = adminRoutes([ctx.configStore], {
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
    return r;
}

module.exports = { internalConfigRouter, CAP, USER_SUBJECT_RE };
