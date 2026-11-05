'use strict';

/**
 * The signed-in person's own wallet for every OpenVibe site: Vibes (T5) and Balance (D12). The shared navbar shows
 * Vibes next to OpenCoins; the wallet shows Balance, the projects the person administers, and the moves between them.
 *
 *   GET /api/me/vibes      Authorization: Bearer <the person's Network user JWT>
 *     → 200 { subject, currency: 'vibes-bits', credit, payable, bits_per_usd }
 *           credit: Vibes to spend; payable: Vibes received as a creator, to cash out
 *     → 409 billing.not_authoritative while OpenVibe.Live is still the ledger (BILLING_AUTHORITY unset): Billing's
 *           numbers are a shadow then, so the chip stays hidden rather than show them
 *     → 401 without a person's token (service, app, module and typed tokens are refused)
 *
 *   GET /api/me/balance    the person's Balance plus the Balance of every project they administer
 *   GET /api/me/credits    the same answer (the old wire path stays an alias)
 *   GET /api/me/activity   the person's own Balance and Vibes movements, newest first (before=<txn id>)
 *   POST /api/me/balance/transfers  { to_project_id, amount_nano_usd, idempotency_key }
 *   POST /api/me/vibes/from-balance { vibes, idempotency_key }
 *
 * CORS: OpenVibe's own sites only (exact https origins from the Contracts service manifests' domains, as Network does;
 * never a wildcard, so a tenant subdomain of a hosting product is never allowed), Authorization allowed, no cookies.
 * The answer is private and never cached.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { validate } = contracts;
const { verifyUserToken } = require('openvibe-sdk/auth');
const { balance } = require('../ledger');
const { A } = require('../ops/common');
const topups = require('../ops/topups');
const balances = require('../ops/balance');
const vibesPay = require('../ops/vibes');
const activity = require('../ops/activity');

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

function meRouter({ ctx, config, keys, limits, adapters }) {
    const r = express.Router();
    const problem = (res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail });

    r.use((req, res, next) => {
        const origin = req.get('origin');
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Origin' });
        if (origin && firstPartyOrigins().has(origin)) {
            res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600' });
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        return next();
    });

    async function person(req, res, next) {
        const header = String(req.get('authorization') || '');
        if (!header.startsWith('Bearer ')) return problem(res, 401, 'token.missing', 'sign in to see your wallet');
        try {
            const claims = await verifyUserToken(header.slice(7).trim(), { ...keys.verifyOptions, issuer: config.network.issuer, now: ctx.now() });
            const subject = claims.subject_id;
            if (typeof subject !== 'string' || !contracts.ids.isSubjectId('user', subject)) return problem(res, 401, 'token.invalid', 'this token names no person');
            req.person = { subject };
            return next();
        } catch (e) {
            if (e && e.code === 'token.unavailable') return problem(res, 503, 'auth.unavailable', 'the Network key is not loaded yet');
            return problem(res, 401, (e && e.code) || 'token.invalid', 'sign in again to see your wallet');
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

    // A signed-in person's Balance (D12): their own and every project they administer. Off with the ledger.
    const readBalance = async (req, res) => {
        if (!config.credits || !config.credits.enabled) return problem(res, 404, 'billing.not_enabled', 'Balance is not open yet');
        try {
            return res.json(await balances.readBalance(ctx, req.person.subject));
        } catch (e) {
            return failure(req, res, e, 'the project list is unavailable');
        }
    };
    r.get('/balance', person, limits.selfRead, readBalance);

    // The old wire path stays an alias of /api/me/balance. With ?project_id it answers that one project's statement,
    // as before, after Network confirms the person administers it.
    r.get('/credits', person, limits.selfRead, async (req, res) => {
        if (!config.credits || !config.credits.enabled) return problem(res, 404, 'billing.not_enabled', 'Balance is not open yet');
        if (req.query.project_id == null) return await readBalance(req, res);
        const projectId = String(req.query.project_id || '');
        if (!/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(projectId)) return problem(res, 422, 'billing.invalid_input', 'project_id is a project id');
        try {
            await balances.assertProjectAdmin(ctx, req.person.subject, projectId);
            return res.json(await require('../ops/credits').statement(ctx, req.person.subject, projectId));
        } catch (e) {
            return failure(req, res, e, 'the project is unavailable');
        }
    });

    // The person's own movements over Balance and Vibes (D12, Network's /wallet). Their token, their accounts only.
    r.get('/activity', person, limits.selfRead, async (req, res) => {
        try {
            return res.json(await activity.activity(ctx, req.person.subject, { limit: req.query.limit, before: req.query.before }));
        } catch (e) {
            return failure(req, res, e, 'the activity is unavailable');
        }
    });

    // Move money from the person's Balance to a project they administer (D12): atomic, idempotent, never below zero.
    r.post('/balance/transfers', express.json({ limit: '16kb' }), person, body('billing.balance-transfer-request@1'),
        limits.budget('billing.balance.transfer', (req) => req.person && req.person.subject), async (req, res) => {
            try {
                const body = req.body || {};
                const out = await balances.transfer(ctx, {
                    subject: req.person.subject, toProjectId: body.to_project_id,
                    amountNanoUsd: body.amount_nano_usd, idempotencyKey: body.idempotency_key,
                });
                return res.status(out.replay ? 200 : 201).json(out);
            } catch (e) {
                return failure(req, res, e, 'the transfer is unavailable');
            }
        });

    // Get Vibes with Balance (D12): the pack value rate, exact to the nano-USD, minted as a pack is. Behind
    // billing.vibes.from_balance (danger, off by default).
    r.post('/vibes/from-balance', express.json({ limit: '16kb' }), person, body('billing.vibes-purchase-from-balance-request@1'),
        limits.budget('billing.vibes.from_balance', (req) => req.person && req.person.subject), async (req, res) => {
            try {
                const body = req.body || {};
                const out = await balances.buyVibes(ctx, { subject: req.person.subject, vibes: body.vibes, idempotencyKey: body.idempotency_key });
                return res.status(out.replay ? 200 : 201).json(out);
            } catch (e) {
                return failure(req, res, e, 'the purchase is unavailable');
            }
        });

    // ── Vibes Pay (D12): the pay sheet's charge ───────────────
    // What the sheet shows: the app (name and icon from Network's registry, the id when it cannot be read), the item,
    // the price, the person's Vibes and whether they can pay now. Paying is atomic and once; a double pay is a replay
    // for the same person and 409 for anyone else. Cancelling a pending charge moves no money.
    r.get('/vibes/charges/:id', person, limits.selfRead, async (req, res) => {
        try {
            return res.json(await vibesPay.personCharge(ctx, req.person.subject, req.params.id));
        } catch (e) {
            return failure(req, res, e, 'the payment link is unavailable');
        }
    });

    r.post('/vibes/charges/:id/pay', express.json({ limit: '16kb' }), person,
        limits.budget('billing.vibes.pay', (req) => req.person && req.person.subject), async (req, res) => {
            try {
                const out = await vibesPay.payCharge(ctx, req.person.subject, req.params.id, req.body || {});
                return res.status(200).json({ charge: out.charge, vibes_credit: out.vibes_credit, replay: out.replay });
            } catch (e) {
                return failure(req, res, e, 'the payment could not be completed');
            }
        });

    r.post('/vibes/charges/:id/cancel', express.json({ limit: '16kb' }), person,
        limits.budget('billing.vibes.cancel', (req) => req.person && req.person.subject), async (req, res) => {
            try {
                const out = await vibesPay.cancelCharge(ctx, req.person.subject, req.params.id);
                return res.status(200).json({ charge: out.charge, replay: out.replay, ...(out.expired ? { expired: true } : {}) });
            } catch (e) {
                return failure(req, res, e, 'the payment could not be cancelled');
            }
        });

    // Start a Balance top-up (D9) with the person's own token: one of the owner's configured amounts, the owner's fee,
    // and the existing provider checkout. With the feature or its configuration off it refuses before any intent.
    r.post('/credits/topups', express.json({ limit: '16kb' }), person,
        limits.budget('billing.credits.topup.create', (req) => req.person && req.person.subject), async (req, res) => {
            if (!config.credits || !config.credits.enabled) return problem(res, 404, 'billing.not_enabled', 'Balance is not open yet');
            try {
                const out = await topups.startTopup(ctx, adapters, { ...(req.body || {}), subject: req.person.subject });
                return res.status(201).json(out);
            } catch (e) {
                if (e && e.status && e.code) {
                    return contracts.http.sendProblem(res, e.status, e.code, {
                        detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined,
                    });
                }
                (ctx.log || console).error('[Billing] /api/me/credits/topups error:', e);
                return problem(res, 500, 'billing.internal', 'internal error');
            }
        });

    return r;
}

/** A D12 request body must be the contract's, before any money moves. */
function body(schemaId) {
    return (req, res, next) => {
        const v = validate(schemaId, req.body == null ? {} : req.body);
        if (v.valid) return next();
        const detail = v.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ');
        return contracts.http.sendProblem(res, 422, 'billing.invalid_request', { detail: `not a ${schemaId}: ${detail}`, ctx: req.ov });
    };
}

/** A route's failures as problems: an expected BillingError keeps its code; anything else is a 502 upstream. */
function failure(req, res, e, detail) {
    if (e && e.status && e.code) {
        return contracts.http.sendProblem(res, e.status, e.code, {
            detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined,
        });
    }
    (req.app.locals && req.app.locals.ctx ? req.app.locals.ctx.log : console).error('[Billing] /api/me error:', e);
    return contracts.http.sendProblem(res, 502, 'billing.upstream_unavailable', { detail, ctx: req.ov });
}

module.exports = { meRouter, firstPartyOrigins };
