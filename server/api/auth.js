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

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const APP_SUB_RE = new RegExp(`^app:app_(${ULID})$`);
const PROJECT_RE = new RegExp(`^prj_(${ULID})$`);
const ENVS = ['sandbox', 'production'];

/** True for a Network app token: sub app:app_<ULID> and actor_type app. */
function isAppClaims(claims) {
    return Boolean(claims && claims.actor_type === 'app' && APP_SUB_RE.test(String(claims.sub)));
}

/** The app a verified token belongs to, or null for anything that is not a usable app token. */
function appPrincipal(claims) {
    const m = APP_SUB_RE.exec(String(claims && claims.sub));
    if (!m) return null;
    if (!PROJECT_RE.test(String(claims.project_id || ''))) return null;
    const env = claims.env === undefined ? 'production' : claims.env;
    if (!ENVS.includes(env)) return null;
    return {
        sub: claims.sub, appId: `app_${m[1]}`, projectId: claims.project_id, env,
        onBehalfOf: typeof claims.on_behalf_of === 'string' ? claims.on_behalf_of : null,
    };
}

function createAuth({ config, keys }) {
    /** The verified claims, or { error: { status, code, detail } } (the token was not verified). */
    async function verify(req, { acceptSandbox = false } = {}) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { error: { status: 401, code: 'token.missing', detail: 'a service token is required' } };
        const r = await verifyServiceToken(header.slice(7).trim(), { ...keys.verifyOptions, issuer: config.network.issuer, audience: config.audience, contracts, acceptSandbox });
        if (!r.ok) {
            if (r.code === 'token.unavailable') return { error: { status: 503, code: 'auth.unavailable', detail: 'the Network key is not loaded yet' } };
            return { error: { status: 401, code: r.code, detail: r.reason } };
        }
        return { claims: r.claims };
    }

    /** true when req.principal is set; otherwise the problem has been answered. */
    async function authenticate(req, res) {
        if (req.principal) return true;
        const out = await verify(req);
        if (out.error) { http.sendProblem(res, out.error.status, out.error.code, { detail: out.error.detail, ctx: req.ov }); return false; }
        req.principal = { sub: out.claims.sub, cap: out.claims.cap || [], jti: out.claims.jti };
        return true;
    }

    /**
     * The guard for the routes a developer app may use (D12 Vibes Pay; billing.vibes.charge / billing.vibes.read).
     * Only an app token is accepted: no capability on a service token can name the app whose Vibes are charged.
     * A sandbox app token is verified here; the routes decide whether the operation is sandbox-aware.
     */
    function appOnly(cap) {
        return async function appOnlyGuard(req, res, next) {
            const out = await verify(req, { acceptSandbox: true });
            if (out.error) return http.sendProblem(res, out.error.status, out.error.code, { detail: out.error.detail, ctx: req.ov });
            if (!isAppClaims(out.claims)) return http.sendProblem(res, 403, 'capability.denied', { detail: 'an app token is required', ctx: req.ov });
            const app = appPrincipal(out.claims);
            if (!app) return http.sendProblem(res, 401, 'token.invalid_claims', { detail: 'the app token names no project or a bad environment', ctx: req.ov });
            const decision = capabilities.check(out.claims, cap);
            if (!decision.allowed) return http.sendProblem(res, 403, decision.code, { detail: decision.reason, ctx: req.ov });
            req.principal = {
                kind: 'app', sub: out.claims.sub, appId: app.appId, projectId: app.projectId, env: app.env,
                onBehalfOf: app.onBehalfOf, cap: out.claims.cap || [], jti: out.claims.jti, claims: out.claims,
            };
            return next();
        };
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

    return { needs, authenticate, verify, appOnly };
}

/** Audit actor for a request: the calling principal, plus the person it acts for when given. */
function actorOf(req) {
    const actor = { principal: req.principal ? req.principal.sub : null, request_id: req.ov ? req.ov.requestId : null };
    const onBehalf = req.body && req.body.on_behalf_of;
    if (onBehalf && validate('identity.subject-ref@1', onBehalf).valid) actor.on_behalf_of = onBehalf;
    return actor;
}

module.exports = { createAuth, actorOf, isAppClaims, appPrincipal };
