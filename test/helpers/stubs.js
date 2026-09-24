'use strict';
/**
 * Stand-ins for the services Billing talks to, each on a random port with a real RS256 key pair.
 *
 *   startNetwork()  JWKS, client-credentials token endpoint (scope → cap), resolve-batch
 *                   (insists on a service token for openvibe.network holding identity.subject.resolve),
 *                   and SSO: authorize() issues a PKCE-bound code, /oauth/token redeems it, /oauth/revoke
 *   startStripe()   /checkout/sessions and /subscriptions/:id, recording calls; `fail` makes it 500
 *   startEvents()   POST /api/v1/events recording batches and the bearer tokens it saw
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function readBody(req) {
    return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const legacy = {};          // live user id → subject id
    const resolveCalls = [];
    const grants = [];
    let issuer = 'http://network.test';
    const state = { down: false };

    function signService({ sub = 'svc:live', aud = ['openvibe.billing'], cap = [], expSec = 300, iss } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: iss || issuer, sub, actor_type: 'service', aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex') }, privatePem);
    }
    // SSO: authorize() stands in for the account chooser + /oauth/confirm — it issues a code bound
    // to the PKCE challenge and redirect URI; /oauth/token (authorization_code) checks both and
    // returns a user access token shaped like Network's issueTokenPair().
    const codes = new Map();
    const revoked = [];
    function authorize({ subject_id, role = 'user', is_owner = false, username = 'someone', challenge, redirect_uri, nowMs = Date.now() }) {
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { subject_id, role, is_owner, username, challenge, redirect_uri, nowMs });
        return code;
    }
    function userToken(u) {
        const now = Math.floor(u.nowMs / 1000);
        return serviceAuth.signServiceToken({
            sub: 42, id: 42, subject_id: u.subject_id, username: u.username, display_name: u.username, role: u.role, ...(u.is_owner ? { is_owner: true } : {}),
            iss: issuer, aud: ['openvibe.live', 'openvibe.tools', 'openvibe.games', 'openvibe.media', 'openvibe.network'], iat: now, exp: now + 86400,
        }, privatePem);
    }
    function addUser(liveId) {
        const subject = ids.newId('user');
        if (liveId != null) legacy[String(liveId)] = subject;
        return subject;
    }

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/.well-known/jwks') return send(res, 200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(raw));
            grants.push(body);
            if (body.client_secret !== 'shh') return send(res, 401, { error: 'invalid_client' });
            if (body.grant_type === 'authorization_code') {
                const c = codes.get(body.code);
                if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
                codes.delete(body.code);
                if (c.redirect_uri !== body.redirect_uri) return send(res, 400, { error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
                const digest = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
                if (!c.challenge || digest !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                return send(res, 200, { access_token: userToken(c), refresh_token: `rt_${crypto.randomBytes(8).toString('hex')}`, token_type: 'Bearer', expires_in: 86400, user: { id: 42, role: c.role } });
            }
            const cap = String(body.scope || '').split(/\s+/).filter(Boolean);
            return send(res, 200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience], cap }), token_type: 'Bearer', expires_in: 300 });
        }
        if (req.url === '/oauth/revoke' && req.method === 'POST') { revoked.push(JSON.parse(raw || '{}').token); return send(res, 200, { revoked: true }); }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const auth = String(req.headers.authorization || '');
            const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok) return send(res, 401, { code: v.code });
            if (!(v.claims.cap || []).includes('identity.subject.resolve')) return send(res, 403, { code: 'capability.denied' });
            if (state.down) return send(res, 503, { error: 'down' });
            const body = JSON.parse(raw || '{}');
            resolveCalls.push(body);
            const results = {};
            for (const id of body.ids || []) {
                const s = body.system === 'live' ? legacy[String(id)] : null;
                results[String(id)] = s ? { subject: { type: 'user', id: s }, username: `u${id}` } : null;
            }
            return send(res, 200, { results });
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    return { url, publicPem, signService, addUser, authorize, revoked, legacy, resolveCalls, grants, state, close: () => new Promise((r) => server.close(r)) };
}

async function startStripe() {
    const calls = [];
    const state = { fail: false };
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        calls.push({ method: req.method, url: req.url, body: Object.fromEntries(new URLSearchParams(raw)), auth: req.headers.authorization });
        if (state.fail) return send(res, 500, { error: { message: 'stripe is down' } });
        if (req.url === '/checkout/sessions') return send(res, 200, { id: `cs_test_${calls.length}`, url: `https://checkout.stripe.test/cs_${calls.length}` });
        const m = req.url.match(/^\/subscriptions\/([^/]+)$/);
        if (m) return send(res, 200, { id: decodeURIComponent(m[1]), cancel_at_period_end: true });
        send(res, 404, { error: { message: 'no route' } });
    });
    const url = await listen(server);
    return { url, calls, state, close: () => new Promise((r) => server.close(r)) };
}

async function startEvents() {
    const batches = [];
    const tokens = [];
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            tokens.push(req.headers.authorization);
            const body = JSON.parse(raw);
            batches.push(body);
            return send(res, 201, { results: (body.events || []).map((e, i) => ({ event_id: e.event_id, seq: i + 1, duplicate: false })) });
        }
        send(res, 404, {});
    });
    const url = await listen(server);
    return { url, batches, tokens, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startNetwork, startStripe, startEvents };
