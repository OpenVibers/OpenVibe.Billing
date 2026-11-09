'use strict';

const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { firstPartyOrigins } = require('./me');
const { wallet } = require('../ops/wallet');

function walletRouter({ ctx, config, keys, limits, adapters }) {
    const r = express.Router();
    const store = require('../ops/store').createStoreSpender(ctx);
    const checkout = require('../ops/wallet-checkout');
    r.use((req, res, next) => {
        const origin = req.get('origin');
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Origin' });
        if (origin && firstPartyOrigins().has(origin)) res.set({
            'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Traceparent, X-OpenVibe-Request-Id, Idempotency-Key',
            'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600',
        });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        return next();
    });
    r.use(async (req, res, next) => {
        const auth = String(req.get('authorization') || '');
        if (!auth.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing');
        try {
            const claims = await verifyUserToken(auth.slice(7).trim(), { ...keys.verifyOptions, issuer: config.network.issuer, now: ctx.now() });
            if (!ids.isSubjectId('user', claims.subject_id)) return http.sendProblem(res, 401, 'token.invalid');
            req.person = { subject: claims.subject_id, networkUserId: claims.id || claims.sub };
            return next();
        } catch (e) {
            return http.sendProblem(res, e.code === 'token.unavailable' ? 503 : 401, e.code || 'token.invalid');
        }
    });
    r.get('/wallet', limits.selfRead, async (req, res, next) => {
        try { return res.json({ ...(await wallet(ctx, req.person.subject, req.get('authorization'))), checkout: checkout.offers(ctx, adapters) }); }
        catch (e) {
            if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message });
            return next(e);
        }
    });
    r.post('/store/spend', express.json({ limit: '4kb' }), limits.budget('billing.intent.create', (req) => req.person.subject), async (req, res, next) => {
        try { return res.json(await store.spend(req.person.subject, req.person.networkUserId, req.get('authorization'), (req.body || {}).purchase_id)); }
        catch (e) {
            if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message });
            return next(e);
        }
    });
    for (const [path, kind] of [['/vibes/buy', 'vibes'], ['/wallet/topups', 'topup']]) {
        r.post(path, express.json({ limit: '4kb' }), limits.budget('billing.intent.create', (req) => req.person.subject), async (req, res, next) => {
            try { return res.json(await checkout.checkout(ctx, adapters, req.person.subject, kind, req.body || {})); }
            catch (e) {
                if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message });
                return next(e);
            }
        });
    }
    return r;
}

module.exports = { walletRouter };
