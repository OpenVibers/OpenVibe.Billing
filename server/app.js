'use strict';

/**
 * OpenVibe.Billing — the isolated money ledger (ADR-012). Express app factory; server/index.js
 * listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready          liveness / readiness
 *   GET  /metrics                         Prometheus text (direct loopback callers only; server/metrics.js)
 *   /api/v1/*                             operations API (service tokens, see api/v1.js)
 *   /api/me/vibes                         a signed-in person's own Vibes (user token; CORS for OpenVibe's own sites, api/me.js)
 *   /webhooks/<provider>                  provider receipts (see api/webhooks.js)
 *   /, /auth/*, /cashouts, …               staff console (Network SSO, server-rendered; see console/index.js)
 *
 * createApp({ config, db, env, keys, identity, adapters, now, fetchImpl, log, limitsNow }) — everything injectable
 * (env: the raw environment, default process.env; limitsNow: the per-person limiter's clock, tests; default the wall clock).
 */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createRates } = require('./rates');
const { createKeyProvider, createIdentity, createProjects, createApps } = require('./network');
const { createAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { internalRouter } = require('./api/internal');
const { createBillingConfig, createVibesConfig, applyValues, applyVibesValues } = require('./config-store');
const { internalConfigRouter } = require('./internal-config');
const { createVibesWebhooks } = require('./ops/vibes-webhooks');
const { createActorLimits } = require('./api/actor-limits');
const { webhooksRouter } = require('./api/webhooks');
const { consoleRouter } = require('./console');
const providers = require('./providers');
const { isFrozen } = require('./ops/common');
const { createMetrics } = require('./metrics');
const { createServiceOutbox } = require('openvibe-sdk/events');
const contracts = require('openvibe-contracts');
const { eventsProduced } = require('../docs/service-manifest-proposal.json');

const VERSION = require('../package.json').version;

async function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || await openDb(config, { log: opts.log || console });
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const identity = opts.identity || createIdentity(config, { fetchImpl });
    const outbox = createServiceOutbox({
        db, source: 'billing', eventsUrl: config.events.url, networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        log, table: 'service_outbox', eventTypes: eventsProduced,
        validate: (env) => contracts.validate('events.event-envelope@1', env),
        ...(opts.fetchImpl ? { fetch: fetchImpl } : {}),
    });
    // ctx.env is the raw environment the owner-settings store reads its x-env pins from; the service reads the
    // settings themselves through ctx.configStore (D11). Tests pass their own env through here.
    const ctx = { db, config, env: opts.env || process.env, rates: createRates(config.rates), now: opts.now || (() => Date.now()), network: identity, log, outbox };
    // D11 owner settings: `billing.credits` is the source of the Balance switches, the top-up terms and the
    // hold lease; `billing.vibes` holds the Vibes Pay limits and the Get Vibes with Balance switch. The env pins
    // keep today's variables winning while they are set; a change applies live.
    ctx.configStore = await createBillingConfig({ db, env: ctx.env, log, onActivate: (values) => applyValues(config, values) });
    applyValues(config, ctx.configStore.get());
    ctx.vibesConfigStore = await createVibesConfig({ db, env: ctx.env, log, onActivate: (values) => applyVibesValues(config, values) });
    applyVibesValues(config, ctx.vibesConfigStore.get());
    // Network's project-membership reads (D12): the projects a person administers and one role check.
    ctx.projects = opts.projects || createProjects(config, { fetchImpl });
    // Network's app registry (D12 Vibes Pay): the app name/icon on the pay sheet. Best effort; Network's own
    // pay sheet fills the name from dev_apps when this read is not permitted.
    ctx.apps = opts.apps || createApps(config, { fetchImpl, log });
    // Per-app Vibes Pay webhook settings (D12): a D11 namespace each, sealed with the service KEK when present.
    ctx.vibesWebhooks = createVibesWebhooks({ db, config, env: ctx.env, log });
    const adapters = opts.adapters || providers.createAdapters(config, { fetchImpl, network: identity });
    const auth = createAuth({ config, keys });

    const app = express();
    app.disable('x-powered-by');
    // nginx matches `location ^~ /api/v1 { deny all; }` case-sensitively; Express would otherwise
    // route /API/v1/… to the same API, walking past the public-host deny.
    app.set('case sensitive routing', true);
    app.set('trust proxy', config.trustProxy);
    // HTTP golden signals by route template, process metrics, release_info and Billing's gauges;
    // GET /metrics before any other route (loopback only — relayed requests get 404). After the
    // routing settings above: the first app.use() fixes the router's case sensitivity.
    const metrics = createMetrics({ db, config, now: ctx.now, outbox });
    const release = createRelease({ service: 'billing', root: path.join(__dirname, '..') });
    instrument(app, { service: 'billing', release: release.release, registry: metrics.registry });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()
    // GET /release.json (ADR-016, D43) and POST /release-metrics: what this deployment is, for tabs and deploy checks.
    release.mount(app, { registry: metrics.registry });
    app.use(http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

    app.get('/api/health', async (req, res) => res.json({
        ok: true, service: 'billing', version: VERSION, frozen: await isFrozen(db), authority: config.authority,
        providers: Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.enabled])),
        events_relay: (await outbox.status()).enabled,
    }));
    // Readiness in the openvibe-shared/ready shape (status, named checks, release): 503 when the ledger
    // database or the Network key fails; the money freeze and the authority show without failing it.
    // Valkey (ADR-035): the per-person limit counters, kept across restarts; opts.valkey for tests (null: none, counted
    // in the process).
    const valkey = opts.valkey !== undefined ? opts.valkey
        : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix }) : null);
    app.locals.valkey = valkey;
    const readiness = require('openvibe-shared/ready').createReadiness({
        service: 'billing', release: release.release,
        checks: [
            { name: 'db', required: true, check: async () => (await db.prepare('SELECT 1 AS ok FROM settings WHERE id = 1').get()).ok === 1 || 'settings row missing' },
            { name: 'network_jwks', required: true, check: () => keys.loaded() || 'Network public key not loaded' },
            { name: 'money_writes', required: false, check: async () => (await isFrozen(db) ? 'frozen' : true) },
            { name: 'events_outbox', required: false, check: async () => await outbox.status() },
            { name: 'valkey', required: false, check: async () => (valkey ? await valkey.ready() : { skipped: 'VALKEY_URL not set: per-person limits count in this process only' }) },
        ],
    });
    app.get('/api/ready', readiness.handler);

    // Owner settings (D11): Network's service token, capability billing.config.manage. Before every public route.
    app.use(internalConfigRouter({ ctx, auth }));
    app.use('/webhooks', webhooksRouter({ ctx, adapters }));
    // Account export and deletion (ADR-033, server/account-data.js): OpenVibe.Events delivers network.account.* to
    // 127.0.0.1:4600 directly (the consumer refuses anything that came through a proxy; nginx 404s /internal/ too), and
    // the parts and confirmations go to Network with Billing's own token. A test injects a stand-in through opts.accountSend.
    const accountData = require('./account-data').create({ db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? require('openvibe-sdk/account-data').createNetworkSender({ networkInternalUrl: config.network.internalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, ...(opts.fetchImpl ? { fetch: fetchImpl } : {}) })
        : null);
    app.post('/internal/events', accountData.consumer({ secrets: config.events.webhookSecrets, send: accountSend }));
    app.locals.accountData = accountData;
    app.locals.accountSend = accountSend;
    // Inference subledger (AI Exchange D2): mounted always, each handler refuses with 503 billing.not_enabled
    // while the `credits` setting is off, so the owner can open it live from Network's AI tab.
    app.use('/internal/credits', express.json({ limit: '64kb' }), internalRouter({ ctx, auth }));
    // Per-person limits on the money-creating routes (api/actor-limits.js); the webhooks above never are.
    const limits = createActorLimits({ config, db, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, valkey });
    // Subject assertions on the money routes (ADR-003, the 2026-11-06 amendment; plan H1).
    // The registry carries the counters: the number of per-person calls that still come without an
    // assertion is what the flag plan waits for.
    const subjectAssertion = require('./api/subject-assertion').createSubjectAssertion({ config, log, registry: metrics.registry });
    app.use('/api/v1', express.json({ limit: '64kb' }), v1Router({ ctx, auth, adapters, limits, subjectAssertion }));
    // A signed-in person's own Vibes, for the shared navbar on every OpenVibe site (api/me.js; user tokens, CORS for owned sites).
    app.use('/api/me', require('./api/me').meRouter({ ctx, config, keys, limits, adapters }));

    // The billing policy is public and indexable; the staff console and the API are not.
    app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nAllow: /policy\nDisallow: /\n'));
    app.use(require('./policy').policyRouter({ config }));
    app.use(consoleRouter({ ctx, adapters, keys, fetchImpl }));
    app.use((req, res) => http.sendProblem(res, 404, 'not_found', { ctx: req.ov }));
    // Malformed JSON and other body-parser errors.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        log.error('[Billing] unhandled error:', err);
        return http.sendProblem(res, 500, 'billing.internal', { ctx: req.ov });
    });

    app.locals.ctx = ctx;
    app.locals.adapters = adapters;
    app.locals.keys = keys;
    app.locals.metrics = metrics.registry;
    return app;
}

module.exports = { createApp, VERSION };
