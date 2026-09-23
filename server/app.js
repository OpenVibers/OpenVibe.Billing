'use strict';

/**
 * OpenVibe.Billing — the isolated money ledger (ADR-012). Express app factory; server/index.js
 * listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready          liveness / readiness
 *   GET  /metrics                         Prometheus text (direct loopback callers only; server/metrics.js)
 *   /api/v1/*                             operations API (service tokens, see api/v1.js)
 *   /webhooks/<provider>                  provider receipts (see api/webhooks.js)
 *   /, /auth/*, /cashouts, …               staff console (Network SSO, server-rendered; see console/index.js)
 *
 * createApp({ config, db, keys, identity, adapters, now, fetchImpl, log }) — everything injectable.
 */
const path = require('path');
const express = require('express');
const { http } = require('openvibe-contracts');
const { instrument } = require('openvibe-shared/metrics');
const { createRelease } = require('openvibe-shared/release');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createRates } = require('./rates');
const { createKeyProvider, createIdentity } = require('./network');
const { createAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { webhooksRouter } = require('./api/webhooks');
const { consoleRouter } = require('./console');
const providers = require('./providers');
const { isFrozen } = require('./ops/common');
const { createMetrics } = require('./metrics');

const VERSION = require('../package.json').version;

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config.dbPath);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const identity = opts.identity || createIdentity(config, { fetchImpl });
    const ctx = { db, config, rates: createRates(config.rates), now: opts.now || (() => Date.now()), network: identity, log };
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
    const metrics = createMetrics({ db, config, now: ctx.now });
    const release = createRelease({ service: 'billing', root: path.join(__dirname, '..') });
    instrument(app, { service: 'billing', release: release.release, registry: metrics.registry });
    app.use(http.middleware());
    app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

    app.get('/api/health', (req, res) => res.json({
        ok: true, service: 'billing', version: VERSION, frozen: isFrozen(db), authority: config.authority,
        providers: Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.enabled])),
        events_relay: !!config.events.url,
    }));
    app.get('/api/ready', (req, res) => {
        const problems = [];
        try { db.prepare('SELECT 1 FROM settings WHERE id = 1').get(); } catch (e) { problems.push(`database: ${e.message}`); }
        if (!keys.get()) problems.push('Network public key not loaded');
        if (problems.length) return http.sendProblem(res, 503, 'service.not_ready', { detail: problems.join('; '), ctx: req.ov });
        return res.json({ ready: true });
    });

    app.use('/webhooks', webhooksRouter({ ctx, adapters }));
    app.use('/api/v1', express.json({ limit: '64kb' }), v1Router({ ctx, auth, adapters }));

    app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
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
