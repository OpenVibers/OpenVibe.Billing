'use strict';

/**
 * OpenVibe.Billing — process entry. `node server/index.js`
 * Listens on PORT (4600) behind nginx (billing.openvibe.network); see deploy/.
 *
 * Background jobs (BILLING_JOBS=off disables them): stored-but-unprocessed provider events are
 * retried every minute; the subscription renewal sweep runs hourly; the outbox relay publishes to
 * OpenVibe.Events when EVENTS_URL is set. Nothing runs while the economy is frozen except the relay.
 */
const { loadConfig } = require('./config');
const { createApp } = require('./app');
const providers = require('./providers');
const subscriptions = require('./ops/subscriptions');
const { createRelay } = require('./outbox');
const { isFrozen } = require('./ops/common');

const config = loadConfig();
const app = createApp({ config });
const { ctx, adapters, keys } = app.locals;
keys.start();

const timers = [];
const relay = createRelay({ db: ctx.db, config });
if (config.jobs.enabled) {
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[Billing] job:', e.message)); }, ms); t.unref(); timers.push(t); };
    every(config.jobs.webhookRetryMs, () => providers.processPending(ctx, adapters));
    every(config.jobs.sweepIntervalMs, () => {
        if (isFrozen(ctx.db)) return;
        const out = subscriptions.sweep(ctx);
        if (out.renewed.length || out.expired.length || out.canceled.length) console.log(`[Billing] subscription sweep: ${out.renewed.length} renewed, ${out.expired.length} expired, ${out.canceled.length} canceled`);
    });
    relay.start();
}

const server = app.listen(config.port, config.host, () => {
    const enabled = Object.values(adapters).filter((a) => a.enabled).map((a) => a.name);
    console.log(`[Billing] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[Billing] providers enabled: ${enabled.length ? enabled.join(', ') : 'none'}; economy ${isFrozen(ctx.db) ? 'FROZEN' : 'open'}; events relay ${config.events.url ? `→ ${config.events.url}` : 'off (outbox accumulates)'}`);
});
server.keepAliveTimeout = 65_000;

function shutdown(signal) {
    console.log(`[Billing] ${signal} — closing`);
    timers.forEach(clearInterval);
    relay.stop();
    keys.stop();
    server.close(() => { try { ctx.db.close(); } catch { /* */ } process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
