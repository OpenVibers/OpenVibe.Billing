'use strict';
/**
 * Stand-ins for the services Billing talks to, each on a random port with a real RS256 key pair.
 *
 *   startNetwork()  JWKS, client-credentials token endpoint (scope → cap), resolve-batch
 *                   (insists on a service token for openvibe.network holding identity.subject.resolve),
 *                   project memberships (/internal/projects?subject= and /internal/projects/:id/members/:subject,
 *                   network.project.member.read), and SSO: authorize() issues a PKCE-bound code, /oauth/token redeems it
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
    const memberships = [];      // { project_id, subject, role, archived, name }
    const publicNames = new Map(); // subject id -> username (the public name only)
    const projects = [];         // { id, name, owner, archived_at }
    const apps = [];             // { id, project_id, name, environment, icon }
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
    function addUser(liveId, username = null) {
        const subject = ids.newId('user');
        if (liveId != null) legacy[String(liveId)] = subject;
        if (username) publicNames.set(subject, username);
        return subject;
    }
    /** Record a project membership; the D12 reads return it. */
    function addMembership(projectId, subject, role = 'owner', archived = false, name = null) {
        const existing = memberships.find((m) => m.project_id === projectId && m.subject === subject);
        if (existing) Object.assign(existing, { role, archived, name });
        else memberships.push({ project_id: projectId, subject, role, archived, name });
        return memberships[memberships.length - 1];
    }
    /** A developer project as GET /internal/projects/:id answers it (name, owner, archived_at). */
    function addProject({ id, name = 'A project', owner = null, archived_at = null }) {
        const existing = projects.find((p) => p.id === id);
        const row = { id, name, owner, archived_at };
        if (existing) Object.assign(existing, row); else projects.push(row);
        return row;
    }
    /** A dev_apps row as the project view carries it. */
    function addApp({ id, projectId, name = 'An app', environment = 'production', icon = null }) {
        const existing = apps.find((a) => a.id === id);
        const row = { id, project_id: projectId, name, environment, icon };
        if (existing) Object.assign(existing, row); else apps.push(row);
        return row;
    }
    /** A Network app token: sub app:app_<ULID>, project_id, env and approved grants. */
    function signApp({ appId, projectId, env = 'production', cap = [], onBehalfOf = null, expSec = 300 }) {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            iss: issuer, sub: `app:${appId}`, actor_type: 'app', aud: ['openvibe.billing'], cap,
            ns: [projectId, `app.${projectId}.*`], project_id: projectId, env,
            ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}),
            iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex'),
        };
        return serviceAuth.signServiceToken(claims, privatePem);
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
        if (req.url.startsWith('/internal/projects') && req.method === 'GET') {
            const auth = String(req.headers.authorization || '');
            const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok) return send(res, 401, { code: v.code });
            const caps = v.claims.cap || [];
            if (!caps.includes('network.project.member.read') && !caps.includes('network.project.read')) return send(res, 403, { code: 'capability.denied' });
            const u = new URL(req.url, issuer);
            if (u.pathname === '/internal/projects') {
                if (!caps.includes('network.project.member.read')) return send(res, 403, { code: 'capability.denied' });
                const subject = u.searchParams.get('subject');
                return send(res, 200, { projects: memberships.filter((m) => m.subject === subject).map((m) => ({ ...m })) });
            }
            const view = u.pathname.match(/^\/internal\/projects\/([^/]+)$/);
            if (view) {
                if (!(v.claims.cap || []).includes('network.project.read')) return send(res, 403, { code: 'capability.denied' });
                const project = projects.find((p) => p.id === decodeURIComponent(view[1]));
                if (!project) return send(res, 404, { code: 'project.not_found' });
                return send(res, 200, {
                    project: { id: project.id, name: project.name, owner: project.owner ? { type: 'user', id: project.owner } : null, archived_at: project.archived_at },
                    apps: apps.filter((a) => a.project_id === project.id).map((a) => ({ id: a.id, name: a.name, environment: a.environment, ...(a.icon ? { icon: a.icon } : {}) })),
                });
            }
            const m = u.pathname.match(/^\/internal\/projects\/([^/]+)\/members\/([^/]+)$/);
            if (!m) return send(res, 404, { error: 'not found' });
            if (!caps.includes('network.project.member.read')) return send(res, 403, { code: 'capability.denied' });
            const found = memberships.find((x) => x.project_id === decodeURIComponent(m[1]) && x.subject === decodeURIComponent(m[2]));
            if (!found) return send(res, 404, { code: 'project.member_not_found' });
            return send(res, 200, { project_id: found.project_id, subject: found.subject, role: found.role, archived: found.archived, added_at: null });
        }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const auth = String(req.headers.authorization || '');
            const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok) return send(res, 401, { code: v.code });
            if (!(v.claims.cap || []).includes('identity.subject.resolve')) return send(res, 403, { code: 'capability.denied' });
            if (state.down) return send(res, 503, { error: 'down' });
            const body = JSON.parse(raw || '{}');
            resolveCalls.push(body);
            const results = {};
            if (Array.isArray(body.subject_ids)) {
                for (const id of body.subject_ids) {
                    results[String(id)] = publicNames.has(String(id))
                        ? { subject: { type: 'user', id: String(id) }, username: publicNames.get(String(id)), display_name: publicNames.get(String(id)) }
                        : null;
                }
            } else {
                for (const id of body.ids || []) {
                    const s = body.system === 'live' ? legacy[String(id)] : null;
                    results[String(id)] = s ? { subject: { type: 'user', id: s }, username: `u${id}` } : null;
                }
            }
            return send(res, 200, { results });
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    // A person's Network session token, as the browser holds it (the shared navbar sends it).
    const signUser = (u) => userToken({ role: 'user', username: 'someone', nowMs: Date.now(), ...u });
    return { url, publicPem, signService, signApp, signUser, addUser, addMembership, addProject, addApp, memberships, projects, apps, publicNames, authorize, revoked, legacy, resolveCalls, grants, state, close: () => new Promise((r) => server.close(r)) };
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
            batches.push(body.events ? body : { events: [body] });
            return send(res, 201, body.events
                ? { results: body.events.map((e, i) => ({ event_id: e.event_id, seq: i + 1, duplicate: false })) }
                : { event_id: body.event_id, seq: 1, duplicate: false });
        }
        send(res, 404, {});
    });
    const url = await listen(server);
    return { url, batches, tokens, close: () => new Promise((r) => server.close(r)) };
}

/** PayPal/CCBill/NOWPayments test API: token, signature verification, checkout/capture and an invoice. */
async function startProviderStub() {
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        calls.push({ method: req.method, url: req.url, raw });
        const json = (s, o) => send(res, s, o);
        if (req.url === '/v1/oauth2/token') return json(200, { access_token: 'pp-token' });
        if (req.url === '/v1/notifications/verify-webhook-signature') {
            const body = JSON.parse(raw);
            return json(200, { verification_status: body.transmission_sig === 'good' ? 'SUCCESS' : 'FAILURE' });
        }
        if (req.url === '/v2/checkout/orders') return json(201, { id: 'PPORDER1', links: [{ rel: 'approve', href: 'https://paypal.test/approve/PPORDER1' }] });
        const cap = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
        if (cap) {
            const custom = calls.find((c) => c.url === '/v2/checkout/orders');
            const intentId = JSON.parse(custom.raw).purchase_units[0].custom_id;
            return json(201, { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-9', custom_id: intentId, amount: { currency_code: 'USD', value: '13.00' } }] } }] });
        }
        if (req.url === '/invoice') return json(200, { id: 777, invoice_url: 'https://nowpayments.test/invoice/777' });
        json(404, {});
    });
    const url = await listen(server);
    return { url, calls, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startNetwork, startStripe, startEvents, startProviderStub };
