'use strict';

/**
 * The signed-in person's own Vibes, for every OpenVibe site (owner 2026-10-08: "make vibes cross site too like opencoins";
 * plan T5 step 2). The shared navbar shows them next to OpenCoins.
 *
 *   GET /api/me/vibes      Authorization: Bearer <the person's Network user JWT>
 *     → 200 { subject, currency: 'vibes-bits', credit, payable, bits_per_usd }
 *           credit: Vibes to spend; payable: Vibes received as a creator, to cash out
 *     → 409 billing.not_authoritative while OpenVibe.Live is still the ledger (BILLING_AUTHORITY unset): Billing's
 *           numbers are a shadow then, so the chip stays hidden rather than show them
 *     → 401 without a person's token (service, app, module and typed tokens are refused)
 *
 * CORS: OpenVibe's own sites only (exact https origins from the Contracts service manifests' domains, as Network does;
 * never a wildcard, so a tenant subdomain of a hosting product is never allowed), Authorization allowed, no cookies.
 * The answer is private and never cached.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { balance } = require('../ledger');
const { A } = require('../ops/common');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
let origins = null;
function firstPartyOrigins() {
    if (origins) return origins;
    const out = new Set();
    for (const m of (contracts.services && contracts.services.manifests) || []) {
        for (const d of m.domains || []) {
            const host = String(d || '').trim().toLowerCase();
            if (HOST_RE.test(host)) { out.add(`https://${host}`); out.add(`https://www.${host}`); }
        }
    }
    origins = out;
    return out;
}

function meRouter({ ctx, config, keys, limits }) {
    const r = express.Router();
    const problem = (res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail });

    r.use((req, res, next) => {
        const origin = req.get('origin');
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Origin' });
        if (origin && firstPartyOrigins().has(origin)) {
            res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        return next();
    });

    async function person(req, res, next) {
        const header = String(req.get('authorization') || '');
        if (!header.startsWith('Bearer ')) return problem(res, 401, 'token.missing', 'sign in to see your Vibes');
        try {
            const claims = await verifyUserToken(header.slice(7).trim(), { ...keys.verifyOptions, issuer: config.network.issuer, now: ctx.now() });
            const subject = claims.subject_id;
            if (typeof subject !== 'string' || !contracts.ids.isSubjectId('user', subject)) return problem(res, 401, 'token.invalid', 'this token names no person');
            req.person = { subject };
            return next();
        } catch (e) {
            if (e && e.code === 'token.unavailable') return problem(res, 503, 'auth.unavailable', 'the Network key is not loaded yet');
            return problem(res, 401, (e && e.code) || 'token.invalid', 'sign in again to see your Vibes');
        }
    }

    r.get('/vibes', person, limits.selfRead, async (req, res) => {
        if (config.authority !== 'billing') return problem(res, 409, 'billing.not_authoritative', 'OpenVibe.Live keeps Vibes balances until the switch to OpenVibe.Billing');
        const s = req.person.subject;
        res.json({
            subject: { type: 'user', id: s }, currency: 'vibes-bits',
            credit: await balance(ctx.db, A.credit(s)), payable: await balance(ctx.db, A.payable(s)), bits_per_usd: ctx.rates.bitsPerUsd,
        });
    });

    return r;
}

module.exports = { meRouter, firstPartyOrigins };
