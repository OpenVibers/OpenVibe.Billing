'use strict';

/**
 * The app side of Vibes Pay: the per-app webhook URL and secret, and the durable outbox that delivers the signed
 * billing.vibes.charge.paid@1 / billing.vibes.charge.refunded@1 bodies with backoff.
 *
 * Network's developer apps have no webhook settings of their own, so Billing keeps them in its D11 store: one
 * namespace `billing.app.<app_id>` per app, with `webhook_url` internal and `webhook_secret` secret-class. The
 * secret is sealed with the service's KEK whenever one is configured (OV_CONFIG_KEKS); summaries and logs only
 * ever carry its marker. The app sets both from its own token; no other app can read or change them.
 *
 * Delivery header (the SDK's verifyWebhook): X-OpenVibe-Signature-V2: t=<unix seconds>,v2=<hex HMAC-SHA256 of
 * "<t>.<raw body>">. X-OpenVibe-Delivery-Id is stable across retries. A 2xx is delivered; anything else is
 * retried on a 15 s → 30 s → … → 6 h schedule, eight attempts, then abandoned. Production deliveries go through the
 * egress guard (https, a public address, no redirects); tests and development may name a private address.
 */
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const https = require('https');
const { createConfigStore } = require('openvibe-shared/config');
const { assertPublicUrl, safeLookup, isInternalName, isPublicAddress } = require('openvibe-shared/egress');
const { iso, prefixedId, BillingError } = require('../ledger');
const { fail } = require('./common');

const SERVICE = 'billing';
const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000, 21_600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const DELIVER_TIMEOUT_MS = 10_000;
const CLAIM_MS = 120_000;

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Vibes Pay app webhook',
    description: 'Where OpenVibe.Billing posts this app\'s Vibes Pay events, and the secret that signs them.',
    type: 'object',
    additionalProperties: false,
    properties: {
        webhook_url: {
            type: 'string', maxLength: 2000,
            title: 'Webhook URL', description: 'The https endpoint this app\'s Vibes Pay events are posted to.',
        },
        webhook_secret: {
            type: 'string', minLength: 16, maxLength: 200,
            title: 'Webhook secret', description: 'The signing secret (write-only; the answer is a marker).',
        },
    },
};

/** Parse and validate a webhook URL; in production it must be https and name a public host. */
function safeUrl(value, config) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw || raw.length > 2000) fail(422, 'billing.invalid_webhook_url', 'webhook url is required (at most 2000 characters)');
    let u;
    try { u = new URL(raw); } catch { fail(422, 'billing.invalid_webhook_url', 'webhook url must be an http(s) URL'); }
    if (u.username || u.password || u.hash) fail(422, 'billing.invalid_webhook_url', 'webhook url carries no credentials or fragment');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && config.nodeEnv !== 'production')) {
        fail(422, 'billing.invalid_webhook_url', 'webhook url must be https');
    }
    if (config.isProduction) {
        if (isInternalName(u.hostname)) fail(422, 'billing.invalid_webhook_url', 'webhook url must name a public host');
        if (net.isIP(u.hostname) && !isPublicAddress(u.hostname)) fail(422, 'billing.invalid_webhook_url', 'webhook url must name a public address');
    }
    return u.toString();
}

function secretValue(v) {
    if (typeof v !== 'string' || v.length < 16 || v.length > 200) fail(422, 'billing.invalid_webhook_secret', 'webhook secret must be 16-200 characters');
    return v;
}

/** The D11 per-app webhook store, created on first use and cached: one process, one store instance per app. */
function createVibesWebhooks({ db, config, env = process.env, log = console }) {
    const stores = new Map();
    async function storeFor(appId) {
        const id = String(appId == null ? '' : appId);
        if (!APP_ID_RE.test(id)) throw new BillingError(500, 'billing.bad_app', 'a webhook store needs an app id');
        if (stores.has(id)) return stores.get(id);
        const store = await createConfigStore({
            db, service: SERVICE, namespace: `billing.app.${id.toLowerCase()}`, schema: SCHEMA, env,
            classify: (key) => (key === 'webhook_secret' ? 'secret' : 'internal'), log,
        });
        stores.set(id, store);
        return store;
    }

    async function get(appId) {
        const store = await storeFor(appId);
        const values = store.get();
        const marker = await store.secretMarker('webhook_secret');
        return {
            store,
            url: typeof values.webhook_url === 'string' ? values.webhook_url : null,
            secret: typeof values.webhook_secret === 'string' ? values.webhook_secret : null,
            marker,
            sealed: store.sealed,
        };
    }

    /** Set the URL and, when given or rotated, the secret. A generated secret is returned once. */
    async function configure(appId, { url, secret = null, rotate = false }) {
        const store = await storeFor(appId);
        const current = store.get();
        const actor = { type: 'app', id: appId };
        if (current.webhook_url !== url) {
            await store.apply({ webhook_url: url }, { merge: true, actor, reason: 'Vibes Pay webhook URL' });
        }
        const before = await store.secretMarker('webhook_secret');
        let generated = null;
        let value = secret;
        if (value == null && (rotate || !before)) {
            generated = crypto.randomBytes(32).toString('base64url');
            value = generated;
        }
        if (value != null) {
            await store.setSecret('webhook_secret', secretValue(value), { actor, reason: generated ? 'Vibes Pay webhook secret created' : 'Vibes Pay webhook secret set' });
        }
        const marker = await store.secretMarker('webhook_secret');
        return {
            app_id: appId, url, secret_set: Boolean(marker), secret_hint: marker ? marker.hint : null,
            sealed: store.sealed, updated_at: marker ? marker.set_at : null,
            ...(generated ? { secret: generated, shown_once: true } : {}),
        };
    }

    async function remove(appId) {
        const store = await storeFor(appId);
        const values = store.get();
        const actor = { type: 'app', id: appId };
        if (values.webhook_url != null) {
            await store.apply({}, { merge: true, unset: ['webhook_url'], actor, reason: 'Vibes Pay webhook URL removed' });
        }
        if (await store.secretMarker('webhook_secret')) {
            await store.deleteSecret('webhook_secret', { actor, reason: 'Vibes Pay webhook secret removed' });
        }
        return { app_id: appId, configured: false };
    }

    return { get, configure, remove, storeFor, safeUrl };
}

/** Queue one signed delivery in the same transaction as the charge state change. */
async function enqueueWebhook(ctx, charge, eventType, payload) {
    const nowIso = iso(ctx.now());
    await ctx.db.prepare(`INSERT INTO vibes_webhook_outbox
        (id, charge_id, app_id, event_type, payload, attempts, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?::timestamptz, ?::timestamptz)`).run(
        prefixedId('vwh', ctx.now()), charge.id, charge.app_id, eventType, JSON.stringify(payload), nowIso, nowIso);
}

function retryDelay(attempts) {
    return RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function shortError(e) {
    if (e && e.code === 'EGRESS_DENIED') return 'the webhook URL is not a public address';
    return 'the delivery failed';
}

function canReachPrivate(config) {
    return !config.isProduction && (config.nodeEnv === 'test' || (config.vibes && config.vibes.allowPrivateWebhooks === true));
}

async function deliverOne(ctx, row) {
    const db = ctx.db;
    const now = ctx.now();
    const nowIso = iso(now);
    const claim = await db.prepare(`UPDATE vibes_webhook_outbox SET next_attempt_at = ?::timestamptz
        WHERE id = ? AND delivered_at IS NULL AND abandoned_at IS NULL AND next_attempt_at <= ?::timestamptz
        RETURNING *`).get(iso(now + CLAIM_MS), row.id, nowIso);
    if (!claim) return { skipped: true };
    const settings = await ctx.vibesWebhooks.get(row.app_id);
    if (!settings.url || !settings.secret) {
        await db.prepare(`UPDATE vibes_webhook_outbox SET abandoned_at = ?::timestamptz, last_error = ?
            WHERE id = ?`).run(nowIso, 'no webhook configured for this app', row.id);
        return { abandoned: true };
    }
    try {
        if (!canReachPrivate(ctx.config)) await assertPublicUrl(settings.url, { protocols: ctx.config.isProduction ? ['https:'] : ['https:', 'http:'] });
    } catch (e) {
        await failAttempt(ctx, row, { error: shortError(e) });
        return { failed: true };
    }

    const ts = Math.floor(now / 1000);
    const signature = crypto.createHmac('sha256', settings.secret).update(`${ts}.`).update(row.payload).digest('hex');
    let response;
    try {
        response = await postWebhook(settings.url, row.payload, {
            'Content-Type': 'application/json', Accept: 'application/json',
            'User-Agent': 'OpenVibe.Billing Vibes Pay', 'X-OpenVibe-Delivery-Id': row.id,
            'X-OpenVibe-Delivery-Attempt': String(Number(row.attempts) + 1), 'X-OpenVibe-Event': row.event_type,
            'X-OpenVibe-Timestamp': String(ts), 'X-OpenVibe-Signature-V2': `t=${ts},v2=${signature}`,
        }, { pinAddress: !canReachPrivate(ctx.config) });
    } catch (e) {
        await failAttempt(ctx, row, { error: shortError(e) });
        return { failed: true };
    }
    if (response.status >= 200 && response.status < 300) {
        await db.prepare('UPDATE vibes_webhook_outbox SET delivered_at = ?::timestamptz, attempts = attempts + 1, last_status = ? WHERE id = ?')
            .run(iso(ctx.now()), response.status, row.id);
        return { delivered: true };
    }
    await failAttempt(ctx, row, { status: response.status, error: `HTTP ${response.status}` });
    return { failed: true };
}

/**
 * POST the raw body without following redirects. In production the socket uses the egress guard's safeLookup, so a
 * DNS answer that was public at assertPublicUrl time cannot rebind to a private address before the connection.
 */
function postWebhook(url, raw, headers, { pinAddress = true, timeoutMs = DELIVER_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch { reject(new Error('bad url')); return; }
        const mod = u.protocol === 'https:' ? https : http;
        const body = Buffer.from(String(raw), 'utf8');
        const req = mod.request({
            protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
            path: `${u.pathname}${u.search}`, method: 'POST',
            headers: { ...headers, 'Content-Length': body.length },
            ...(pinAddress ? { lookup: safeLookup } : {}),
        }, (res) => {
            res.resume();
            resolve({ status: res.statusCode });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

async function failAttempt(ctx, row, { status = null, error = null }) {
    const attempts = Number(row.attempts) + 1;
    const abandoned = attempts >= MAX_ATTEMPTS;
    await ctx.db.prepare(`UPDATE vibes_webhook_outbox SET attempts = ?, last_status = ?, last_error = ?,
        next_attempt_at = ?::timestamptz, abandoned_at = ?::timestamptz WHERE id = ?`).run(
        attempts, status, String(error || 'delivery failed').slice(0, 500),
        iso(ctx.now() + retryDelay(attempts)), abandoned ? iso(ctx.now()) : null, row.id);
}

/** Deliver every due webhook once: the job timer in server/index.js and the tests call this. */
async function deliverDue(ctx, { limit = 20 } = {}) {
    const rows = await ctx.db.prepare(`SELECT * FROM vibes_webhook_outbox
        WHERE delivered_at IS NULL AND abandoned_at IS NULL AND next_attempt_at <= ?::timestamptz
        ORDER BY next_attempt_at, id LIMIT ?`).all(iso(ctx.now()), Math.max(1, Math.min(100, limit)));
    const out = { delivered: 0, failed: 0, abandoned: 0, skipped: 0 };
    for (const row of rows) {
        const r = await deliverOne(ctx, row);
        if (r.delivered) out.delivered++;
        else if (r.abandoned) out.abandoned++;
        else if (r.failed) out.failed++;
        else out.skipped++;
    }
    return out;
}

module.exports = { createVibesWebhooks, enqueueWebhook, deliverDue, safeUrl, SCHEMA, RETRY_DELAYS_MS, MAX_ATTEMPTS };
