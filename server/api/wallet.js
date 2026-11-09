'use strict';

const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { firstPartyOrigins } = require('./me');
const { wallet } = require('../ops/wallet');

function walletRouter({ ctx, config, keys, limits }) {
    const r = express.Router();
    r.use((req, res, next) => {
        const origin = req.get('origin');
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Origin' });
        if (origin && firstPartyOrigins().has(origin)) res.set({
            'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
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
            req.person = { subject: claims.subject_id };
            return next();
        } catch (e) {
            return http.sendProblem(res, e.code === 'token.unavailable' ? 503 : 401, e.code || 'token.invalid');
        }
    });
    r.get('/wallet', limits.selfRead, async (req, res, next) => {
        try { return res.json(await wallet(ctx, req.person.subject, req.get('authorization'))); }
        catch (e) {
            if (e.status && e.code) return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message });
            return next(e);
        }
    });
    return r;
}

module.exports = { walletRouter };
