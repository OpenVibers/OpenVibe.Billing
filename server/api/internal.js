'use strict';

/**
 * Internal credits ledger API (AI Exchange D2). Service-token authenticated (audience openvibe.billing),
 * mounted under /internal/credits always, each handler refusing while the `credits` owner setting is off.
 * This is the authority surface
 * OpenVibe.AI calls to reserve, extend, settle and release inference credit.
 */
const express = require('express');
const { http, validate } = require('openvibe-contracts');
const { BillingError } = require('../ledger');
const { isFrozen } = require('../ops/common');
const { actorOf } = require('./auth');
const inference = require('../ops/credits');

// One capability per operation, as openvibe-contracts v0.284.0 defines them (D9).
const CAP = {
    create: 'billing.credit.hold.create',
    extend: 'billing.credit.hold.extend',
    settle: 'billing.credit.hold.settle',
    release: 'billing.credit.hold.release',
    sandbox: 'billing.credit.sandbox.grant',
};

/**
 * The request body must be the contract's (openvibe-contracts v0.289.0, D9/D10/D12): a caller that sends another shape
 * gets 422 before anything is held or charged, and the ledger code only ever sees validated input. D12's request
 * schema makes project_id optional (a personal hold); an app subject still always names its project.
 */
function body(schemaId) {
    return (req, res, next) => {
        const v = validate(schemaId, req.body == null ? {} : req.body);
        if (v.valid) return next();
        const detail = v.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ');
        return http.sendProblem(res, 422, 'billing.invalid_request', { detail: `not a ${schemaId}: ${detail}`, ctx: req.ov });
    };
}

function internalRouter({ ctx, auth }) {
    const r = express.Router();
    const notFrozen = async (req, res, next) => (await isFrozen(ctx.db)
        ? http.sendProblem(res, 503, 'billing.frozen', { detail: 'the economy is frozen', ctx: req.ov })
        : next());

    r.post('/holds', auth.needs(CAP.create), body('billing.credit-hold-create-request@1'), notFrozen, wrap(async (req, res) => {
        const out = await inference.createHold(ctx, { ...req.body, actor: actorOf(req) });
        res.status(out.replay ? 200 : 201).json(out.hold);
    }));

    r.post('/holds/:id/extend', auth.needs(CAP.extend), body('billing.credit-hold-extend-request@1'), notFrozen, wrap(async (req, res) => {
        const out = await inference.extendHold(ctx, { hold_id: req.params.id, add_nano_usd: req.body.add_nano_usd, actor: actorOf(req) });
        res.json(out.hold);
    }));

    r.post('/holds/:id/settle', auth.needs(CAP.settle), body('billing.credit-hold-settle-request@1'), notFrozen, wrap(async (req, res) => {
        const out = await inference.settleHold(ctx, { hold_id: req.params.id, ...req.body, actor: actorOf(req) });
        res.status(out.replay ? 200 : 201).json(out.settlement);
    }));

    r.post('/holds/:id/release', auth.needs(CAP.release), notFrozen, wrap(async (req, res) => {
        const out = await inference.releaseHold(ctx, { hold_id: req.params.id, actor: actorOf(req) });
        res.json(out);
    }));

    r.post('/sandbox/grants', auth.needs(CAP.sandbox), body('billing.credit-sandbox-grant-request@1'), notFrozen, wrap(async (req, res) => {
        const out = await inference.sandboxGrant(ctx, { ...req.body, actor: actorOf(req) });
        res.status(201).json(out);
    }));

    return r;
}

function wrap(fn) {
    return async (req, res, next) => {
        try {
            const p = await fn(req, res, next);
            if (p && typeof p.catch === 'function') p.catch((e) => sendError(req, res, e));
        } catch (e) { sendError(req, res, e); }
    };
}

function sendError(req, res, e) {
    if (res.headersSent) return;
    if (e instanceof BillingError) {
        return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined });
    }
    console.error('[Billing] unexpected internal error:', e);
    return http.sendProblem(res, 500, 'billing.internal', { detail: 'internal error', ctx: req.ov });
}

module.exports = { internalRouter, CAP };
