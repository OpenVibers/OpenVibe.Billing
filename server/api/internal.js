'use strict';

/**
 * Internal inference subledger API (AI Exchange D2). Service-token authenticated (audience openvibe.billing),
 * mounted under /internal/inference only when BILLING_INFERENCE_SUBLEDGER=1. This is the authority surface
 * OpenVibe.AI calls to reserve, extend, settle and release inference credit.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { BillingError } = require('../ledger');
const { isFrozen } = require('../ops/common');
const { actorOf } = require('./auth');
const inference = require('../ops/inference');

const CAP = {
    inference: 'billing.inference.hold',
    sandbox: 'billing.inference.sandbox.grant',
};

function internalRouter({ ctx, auth }) {
    const r = express.Router();
    const notFrozen = async (req, res, next) => (await isFrozen(ctx.db)
        ? http.sendProblem(res, 503, 'billing.frozen', { detail: 'the economy is frozen', ctx: req.ov })
        : next());

    r.post('/holds', auth.needs(CAP.inference), notFrozen, wrap(async (req, res) => {
        const out = await inference.createHold(ctx, { ...req.body, actor: actorOf(req) });
        res.status(out.replay ? 200 : 201).json(out.hold);
    }));

    r.post('/holds/:id/extend', auth.needs(CAP.inference), notFrozen, wrap(async (req, res) => {
        const out = await inference.extendHold(ctx, { hold_id: req.params.id, add_nano_usd: req.body.add_nano_usd, actor: actorOf(req) });
        res.json(out.hold);
    }));

    r.post('/holds/:id/settle', auth.needs(CAP.inference), notFrozen, wrap(async (req, res) => {
        const out = await inference.settleHold(ctx, { hold_id: req.params.id, ...req.body, actor: actorOf(req) });
        res.status(out.replay ? 200 : 201).json(out.settlement);
    }));

    r.post('/holds/:id/release', auth.needs(CAP.inference), notFrozen, wrap(async (req, res) => {
        const out = await inference.releaseHold(ctx, { hold_id: req.params.id, actor: actorOf(req) });
        res.json(out);
    }));

    r.post('/sandbox/grants', auth.needs(CAP.sandbox), notFrozen, wrap(async (req, res) => {
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
