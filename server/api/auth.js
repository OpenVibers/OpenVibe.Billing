'use strict';

/**
 * Service-token authentication (ADR-003). Every /api/v1 call carries a client-credentials JWT
 * from OpenVibe.Network for audience 'openvibe.billing', verified by openvibe-sdk/auth verifyServiceToken (the
 * pinned contracts rules, the key the token's kid names); the capability is checked here against the token's `cap`
 * claim.
 *
 * The billing.* capabilities ship in openvibe-contracts v0.8.0. The grant is matched with
 * contracts' own grants(): an exact id, or a trailing ".*" family grant ("billing.*",
 * "billing.cashout.*").
 */
const contracts = require('openvibe-contracts');
const { verifyServiceToken } = require('openvibe-sdk/auth');

const { capabilities, http, validate } = contracts;

function createAuth({ config, keys }) {
    /** true when req.principal is set; otherwise the problem has been answered. */
    async function authenticate(req, res) {
        if (req.principal) return true;
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) { http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx: req.ov }); return false; }
        const r = await verifyServiceToken(header.slice(7).trim(), { ...keys.verifyOptions, issuer: config.network.issuer, audience: config.audience, contracts });
        if (!r.ok && r.code === 'token.unavailable') { http.sendProblem(res, 503, 'auth.unavailable', { detail: 'the Network key is not loaded yet', ctx: req.ov }); return false; }
        if (!r.ok) { http.sendProblem(res, 401, r.code, { detail: r.reason, ctx: req.ov }); return false; }
        req.principal = { sub: r.claims.sub, cap: r.claims.cap || [], jti: r.claims.jti };
        return true;
    }

    /** needs('billing.x.y') or needs(['a', 'b']) — any one of the listed capabilities. */
    function needs(caps) {
        const list = Array.isArray(caps) ? caps : [caps];
        return function billingCapability(req, res, next) {
            authenticate(req, res).then((ok) => {
                if (!ok) return undefined;
                if (!list.some((c) => capabilities.grants(req.principal.cap, c))) {
                    return http.sendProblem(res, 403, 'capability.denied', { detail: `${list.join(' or ')} not granted`, ctx: req.ov });
                }
                return next();
            }, next);
        };
    }

    return { needs, authenticate };
}

/** Audit actor for a request: the calling principal, plus the person it acts for when given. */
function actorOf(req) {
    const actor = { principal: req.principal ? req.principal.sub : null, request_id: req.ov ? req.ov.requestId : null };
    const onBehalf = req.body && req.body.on_behalf_of;
    if (onBehalf && validate('identity.subject-ref@1', onBehalf).valid) actor.on_behalf_of = onBehalf;
    return actor;
}

module.exports = { createAuth, actorOf };
