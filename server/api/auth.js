'use strict';

/**
 * Service-token authentication (ADR-003). Every /api/v1 call carries a client-credentials JWT
 * from OpenVibe.Network for audience 'openvibe.billing'; the capability is checked here against
 * the token's `cap` claim.
 *
 * The billing.* capabilities are proposed (docs/capabilities-proposal/) and not yet in an
 * openvibe-contracts release, so contracts' capabilities.check() would answer capability.unknown.
 * Until they ship, the grant is matched locally with contracts' own grants(): an exact id, or a
 * trailing ".*" family grant ("billing.*", "billing.cashout.*").
 */
const { serviceAuth, capabilities, http, validate } = require('openvibe-contracts');

function createAuth({ config, keys }) {
    function authenticate(req, res) {
        if (req.principal) return true;
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) { http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx: req.ov }); return false; }
        const publicKey = keys.get();
        if (!publicKey) { http.sendProblem(res, 503, 'auth.unavailable', { detail: 'the Network key is not loaded yet', ctx: req.ov }); return false; }
        const r = serviceAuth.verifyServiceToken(header.slice(7).trim(), { publicKey, issuer: config.network.issuer, audience: config.audience });
        if (!r.ok) { http.sendProblem(res, 401, r.code, { detail: r.reason, ctx: req.ov }); return false; }
        req.principal = { sub: r.claims.sub, cap: r.claims.cap || [], jti: r.claims.jti };
        return true;
    }

    /** needs('billing.x.y') or needs(['a', 'b']) — any one of the listed capabilities. */
    function needs(caps) {
        const list = Array.isArray(caps) ? caps : [caps];
        return function billingCapability(req, res, next) {
            if (!authenticate(req, res)) return;
            if (!list.some((c) => capabilities.grants(req.principal.cap, c))) {
                return http.sendProblem(res, 403, 'capability.denied', { detail: `${list.join(' or ')} not granted`, ctx: req.ov });
            }
            return next();
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
