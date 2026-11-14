'use strict';

/**
 * The checkout providers (plan §AB.16 and §AB.18): PayPal, Coinbase Commerce, Square, Paddle and
 * Lemon Squeezy — the payment providers beyond Stripe.
 *
 * One provider is one row in the owner's Setup tab: its keys, the test/live switch and the webhook
 * signing secret are fields of the same row, and the guide shows them together under the provider's
 * name. The keys live in the config vault (namespace billing.payments, server/config-store.js); they
 * are write-only and sealed, and they are never written to a log line, an audit row or an error.
 *
 * Nothing here moves money. The checkout adapters (a person paying at checkout) are a later step:
 * this step gives the owner the keys, proves each one works with one cheap authenticated read, and
 * accepts the provider's webhooks so the notices are recorded. A webhook that arrives is verified
 * with the provider's own signature scheme and stored in provider_events; it settles nothing.
 *
 *   verify()   the provider's signature check (HMAC-SHA256 over the raw body for four of them,
 *              PayPal's own verification API for PayPal)
 *   parse()    the event's id and type
 *   test()     one cheap authenticated read (the account, the domains, the products): never a
 *              charge, never a send, never a mutation
 */
const crypto = require('crypto');

const TIMEOUT_MS = 10_000;
const MAX_AGE_SEC = 300;
const BILLING_BASE = 'https://billing.openvibe.network';

/** The provider's own words for a refusal, in one line, without the key. */
function hmacHex(secret, body) { return crypto.createHmac('sha256', secret).update(body).digest('hex'); }
function hmacB64(secret, body) { return crypto.createHmac('sha256', secret).update(body).digest('base64'); }
function sameBytes(a, b) {
    const x = Buffer.from(String(a == null ? '' : a));
    const y = Buffer.from(String(b == null ? '' : b));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** One GET (or POST) with a timeout; never throws, so a test never breaks on a network error. */
async function call(fetchImpl, url, { method = 'GET', headers = {}, body = null } = {}) {
    let res;
    try {
        res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'the provider did not answer within 10 seconds' : 'the provider could not be reached' };
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json, error: null };
}

/** A provider's own error words, without the key and in one line. */
function refusal(status, json, { who, unreadable = 'the provider may not read this' } = {}) {
    const says = json && typeof json === 'object'
        ? (json.message || json.error || json.errors?.[0]?.message || json.detail || '')
        : '';
    const tail = typeof says === 'string' && says.trim() ? ': ' + String(says).split(/\s+/).join(' ').slice(0, 120) : '.';
    if (status === 401) return `${who} refused the key (401)${tail}`;
    if (status === 403) return `${who} accepted the key but ${unreadable} (403)${tail}`;
    if (status === 429) return `${who} is limiting requests right now (429); try again in a minute.`;
    if (!status) return `${who} could not be reached.`;
    return `${who} answered ${status}${tail}`;
}

/** The list of things a read returned, however the provider spells it. */
function countOf(json, keys) {
    for (const k of keys) {
        const v = json && json[k];
        if (Array.isArray(v)) return v.length;
        if (v && typeof v === 'object' && Array.isArray(v.data)) return v.data.length;
    }
    if (Array.isArray(json)) return json.length;
    return null;
}

/** The names a provider read returned, for the one line the owner reads. */
function namesOf(json, keys) {
    for (const k of keys) {
        const v = json && json[k];
        const list = Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : null);
        if (list) return list.slice(0, 3).map((item) => String(item && (item.name || item.domain || item.id || item.title) || '').trim()).filter(Boolean);
    }
    return [];
}

const PAYPAL = {
    id: 'paypal',
    title: 'PayPal',
    group: 'PayPal',
    // The key the provider signs its notices with (its local name in cfg): the endpoint is enabled once it is set.
    webhookKey: 'webhook_id',
    // PayPal signs nothing locally: the notice is checked against PayPal's own verification API,
    // so the endpoint is ready once the app credentials and the webhook id are set.
    webhookReady: (cfg) => !!(cfg.client_id && cfg.client_secret && cfg.webhook_id),
    requiredFor: 'PayPal payments',
    unlocks: 'Takes PayPal at checkout once switched on. Until the checkout adapter lands, no checkout uses it.',
    getItAt: 'https://developer.paypal.com/dashboard/applications/',
    getItHow: 'Open your app (Live or Sandbox), then App Credentials, and copy the Client ID and the Secret. The webhook id is under your app\'s Webhooks.',
    keys: [
        { name: 'paypal.client_id', title: 'PayPal client id', secret: true, test: false,
            description: 'The id of the PayPal app Billing asks for a token with. It is write-only and sealed like the rest of the app\'s credentials, so the id and its secret are replaced together and neither is ever read back.' },
        { name: 'paypal.client_secret', title: 'PayPal client secret', secret: true, test: true,
            description: 'The secret half of the PayPal app. It is write-only and sealed; PayPal refuses a call without it, and it never comes back after you paste it.' },
        { name: 'paypal.webhook_id', title: 'PayPal webhook id', secret: true, test: false,
            description: 'The id of the PayPal webhook Billing checks notices against. PayPal signs a notice with this webhook and its app credentials, so it is kept sealed like a secret.' },
        { name: 'paypal.live', title: 'Take real PayPal payments', secret: false, test: false, live: true,
            description: 'On: PayPal is asked in live mode and real money can move. Off (the default): only the sandbox is used, so nothing real can be charged.' },
    ],
    async token(cfg, fetchImpl) {
        const auth = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64');
        const r = await call(fetchImpl, `${cfg.base}/v1/oauth2/token`, {
            method: 'POST',
            headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
        });
        if (!(r.status >= 200 && r.status < 300) || !r.json || !r.json.access_token) return { error: refusal(r.status, r.json, { who: 'PayPal' }) };
        return { token: r.json.access_token };
    },
    async test(cfg, { fetchImpl }) {
        if (!cfg.client_id) return { ok: false, message: 'PayPal needs its client id too: paste that first.' };
        const t = await this.token(cfg, fetchImpl);
        if (t.error) return { ok: false, message: t.error };
        const r = await call(fetchImpl, `${cfg.base}/v1/notifications/webhooks`, { headers: { authorization: `Bearer ${t.token}` } });
        if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r.status, r.json, { who: 'PayPal' }) };
        const n = countOf(r.json, ['webhooks', 'data']);
        const ids = namesOf(r.json, ['webhooks', 'data']);
        return { ok: true, message: `PayPal accepted the key: ${n == null ? 'the webhooks list is empty' : `${n} webhook(s) on the app`}${ids.length ? ` (${ids.join(', ')})` : ''}. ${cfg.live ? 'Live mode: real payments are possible.' : 'Sandbox mode: no real payment can be made.'}` };
    },
    async verify(req, cfg, { fetchImpl }) {
        if (!cfg.client_id || !cfg.client_secret || !cfg.webhook_id) return { ok: false, reason: 'PayPal is not configured yet' };
        const t = await this.token(cfg, fetchImpl);
        if (t.error) return { ok: false, reason: 'PayPal could not be asked to check the notice' };
        const h = req.headers || {};
        let event;
        try { event = JSON.parse(req.rawBody.toString('utf8')); } catch { return { ok: false, reason: 'unreadable payload' }; }
        const r = await call(fetchImpl, `${cfg.base}/v1/notifications/verify-webhook-signature`, {
            method: 'POST',
            headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
                transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'],
                webhook_id: cfg.webhook_id, webhook_event: event,
            }),
        });
        if (!(r.status >= 200 && r.status < 300) || !r.json || r.json.verification_status !== 'SUCCESS') return { ok: false, reason: 'PayPal did not confirm the notice' };
        return { ok: true };
    },
    parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.id ? String(event.id) : null, type: String(event.event_type || 'unknown'), payload: event };
    },
};

const COINBASE = {
    id: 'coinbase',
    title: 'Coinbase Commerce',
    group: 'Coinbase Commerce',
    webhookKey: 'webhook_secret',
    // The endpoint is ready once the key the provider signs its notices with is set.
    webhookReady: (cfg) => !!cfg.webhook_secret,
    requiredFor: 'Coinbase Commerce payments',
    unlocks: 'Takes Coinbase Commerce at checkout once switched on. Until the checkout adapter lands, no checkout uses it.',
    getItAt: 'https://commerce.coinbase.com/dashboard/settings/api-keys',
    getItHow: 'Open Settings, then API keys, and copy the API key. The shared secret for the webhooks is in Settings, then Notifications.',
    keys: [
        { name: 'coinbase.api_key', title: 'Coinbase Commerce API key', secret: true, test: true,
            description: 'The key Coinbase Commerce gives for reading the charges on your store. It is write-only and sealed; the read it proves is one list of charges, never a charge.' },
        { name: 'coinbase.webhook_secret', title: 'Coinbase Commerce webhook secret', secret: true, test: false,
            description: 'The shared secret Coinbase Commerce signs its notices with, so Billing can tell a real notice from a made-up one. It is write-only and sealed.' },
        { name: 'coinbase.live', title: 'Take real Coinbase Commerce payments', secret: false, test: false, live: true,
            description: 'On: the live store is used and real money can move. Off (the default): the store is only read, so nothing real can be charged.' },
    ],
    base: 'https://api.commerce.coinbase.com',
    async test(cfg, { fetchImpl }) {
        const r = await call(fetchImpl, `${this.base}/charges?limit=1`, { headers: { 'x-cc-api-key': cfg.api_key } });
        if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r.status, r.json, { who: 'Coinbase Commerce' }) };
        const n = countOf(r.json, ['data', 'charges']);
        return { ok: true, message: `Coinbase Commerce accepted the key: ${n == null ? 'the charge list is empty' : `${n} charge(s) on the store`}. Nothing was charged.` };
    },
    async verify(req, cfg) {
        if (!cfg.webhook_secret) return { ok: false, reason: 'the webhook secret is not set' };
        const header = String((req.headers || {})['x-cc-webhook-signature'] || '');
        if (!header) return { ok: false, reason: 'the notice carries no signature' };
        const expected = hmacHex(cfg.webhook_secret, req.rawBody);
        return sameBytes(expected, header) ? { ok: true } : { ok: false, reason: 'the signature does not match' };
    },
    parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.id ? String(event.id) : null, type: String((event.event && event.event.type) || 'unknown'), payload: event };
    },
};

const SQUARE = {
    id: 'square',
    title: 'Square',
    group: 'Square',
    webhookKey: 'signature_key',
    // The endpoint is ready once the key the provider signs its notices with is set.
    webhookReady: (cfg) => !!cfg.signature_key,
    requiredFor: 'Square payments',
    unlocks: 'Takes Square at checkout once switched on. Until the checkout adapter lands, no checkout uses it.',
    getItAt: 'https://developer.squareup.com/apps',
    getItHow: 'Open your application, then Credentials, and copy the Access token. The signature key is on the same page under Webhooks.',
    keys: [
        { name: 'square.access_token', title: 'Square access token', secret: true, test: true,
            description: 'The token Square gives for reading your locations and taking payments. It is write-only and sealed; the read it proves lists the locations, and it charges nothing.' },
        { name: 'square.signature_key', title: 'Square webhook signature key', secret: true, test: false,
            description: 'The key Square signs its notices with, so Billing only believes notices that really come from Square. It is write-only and sealed.' },
        { name: 'square.live', title: 'Take real Square payments', secret: false, test: false, live: true,
            description: 'On: the production Square is used and real money can move. Off (the default): the sandbox is used, so no real card is charged.' },
    ],
    bases: { live: 'https://connect.squareup.com', sandbox: 'https://connect.squareupsandbox.com' },
    async test(cfg, { fetchImpl }) {
        const r = await call(fetchImpl, `${cfg.base}/v2/locations`, { headers: { authorization: `Bearer ${cfg.access_token}` } });
        if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r.status, r.json, { who: 'Square' }) };
        const n = countOf(r.json, ['locations']);
        const names = namesOf(r.json, ['locations']);
        return { ok: true, message: `Square accepted the key: ${n == null ? 'no location is set up' : `${n} location(s)${names.length ? ` (${names.join(', ')})` : ''}`}. ${cfg.live ? 'Production mode: real payments are possible.' : 'Sandbox mode: no real card is charged.'}` };
    },
    async verify(req, cfg) {
        if (!cfg.signature_key) return { ok: false, reason: 'the signature key is not set' };
        const header = String((req.headers || {})['x-square-hmacsha256-signature'] || '');
        if (!header) return { ok: false, reason: 'the notice carries no signature' };
        const url = `${BILLING_BASE}/checkout/webhooks/square`;
        const expected = hmacB64(cfg.signature_key, url + req.rawBody.toString('utf8'));
        return sameBytes(expected, header) ? { ok: true } : { ok: false, reason: 'the signature does not match' };
    },
    parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.id ? String(event.id) : null, type: String(event.type || 'unknown'), payload: event };
    },
};

const PADDLE = {
    id: 'paddle',
    title: 'Paddle',
    group: 'Paddle',
    webhookKey: 'webhook_secret',
    // The endpoint is ready once the key the provider signs its notices with is set.
    webhookReady: (cfg) => !!cfg.webhook_secret,
    requiredFor: 'Paddle payments',
    unlocks: 'Takes Paddle at checkout once switched on. Until the checkout adapter lands, no checkout uses it.',
    getItAt: 'https://dashboard.paddle.com/settings/api-keys',
    getItHow: 'Open Settings, then API keys, and copy the API key. The webhook secret is in Settings, then Webhooks, under Notifications.',
    keys: [
        { name: 'paddle.api_key', title: 'Paddle API key', secret: true, test: true,
            description: 'The key Paddle gives for reading your catalogue and prices. It is write-only and sealed; the read it proves lists the prices, and it changes nothing.' },
        { name: 'paddle.webhook_secret', title: 'Paddle webhook secret', secret: true, test: false,
            description: 'The secret Paddle signs its notices with, so Billing only believes notices that really come from Paddle. It is write-only and sealed.' },
        { name: 'paddle.live', title: 'Take real Paddle payments', secret: false, test: false, live: true,
            description: 'On: the live Paddle catalogue is used and real money can move. Off (the default): the sandbox is used, so nothing real can be charged.' },
    ],
    bases: { live: 'https://api.paddle.com', sandbox: 'https://sandbox-api.paddle.com' },
    async test(cfg, { fetchImpl }) {
        const r = await call(fetchImpl, `${cfg.base}/products?per_page=1`, { headers: { authorization: `Bearer ${cfg.api_key}` } });
        if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r.status, r.json, { who: 'Paddle' }) };
        const n = countOf(r.json, ['data', 'products']);
        return { ok: true, message: `Paddle accepted the key: ${n == null ? 'the catalogue is empty' : `${n} product(s) in the catalogue`}. Nothing was charged. ${cfg.live ? 'Live mode.' : 'Sandbox mode.'}` };
    },
    async verify(req, cfg) {
        if (!cfg.webhook_secret) return { ok: false, reason: 'the webhook secret is not set' };
        const header = String((req.headers || {})['paddle-signature'] || '');
        if (!header) return { ok: false, reason: 'the notice carries no signature' };
        const parts = Object.fromEntries(header.split(';').map((kv) => kv.split('=').map((s) => s.trim())));
        if (!parts.ts || !parts.h1) return { ok: false, reason: 'the signature header is malformed' };
        const age = Math.abs(Date.now() / 1000 - Number(parts.ts));
        if (!Number.isFinite(age) || age > MAX_AGE_SEC) return { ok: false, reason: 'the notice is too old' };
        const expected = hmacHex(cfg.webhook_secret, `${parts.ts}:${req.rawBody.toString('utf8')}`);
        return sameBytes(expected, parts.h1) ? { ok: true } : { ok: false, reason: 'the signature does not match' };
    },
    parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.event_id ? String(event.event_id) : null, type: String(event.event_type || 'unknown'), payload: event };
    },
};

const LEMON = {
    id: 'lemon_squeezy',
    title: 'Lemon Squeezy',
    group: 'Lemon Squeezy',
    webhookKey: 'webhook_secret',
    // The endpoint is ready once the key the provider signs its notices with is set.
    webhookReady: (cfg) => !!cfg.webhook_secret,
    requiredFor: 'Lemon Squeezy payments',
    unlocks: 'Takes Lemon Squeezy at checkout once switched on. Until the checkout adapter lands, no checkout uses it.',
    getItAt: 'https://www.lemonsqueezy.com/app/settings/api',
    getItHow: 'Open Settings, then API, and copy the API key. The signing secret is in Settings, then Webhooks.',
    keys: [
        { name: 'lemon_squeezy.api_key', title: 'Lemon Squeezy API key', secret: true, test: true,
            description: 'The key Lemon Squeezy gives for reading your store. It is write-only and sealed; the read it proves lists the stores, and it changes nothing.' },
        { name: 'lemon_squeezy.webhook_secret', title: 'Lemon Squeezy signing secret', secret: true, test: false,
            description: 'The secret Lemon Squeezy signs its notices with, so Billing only believes notices that really come from Lemon Squeezy. It is write-only and sealed.' },
        { name: 'lemon_squeezy.live', title: 'Take real Lemon Squeezy payments', secret: false, test: false, live: true,
            description: 'On: the live Lemon Squeezy store is used and real money can move. Off (the default): the store is only read, so nothing real can be charged.' },
    ],
    base: 'https://api.lemonsqueezy.com/v1',
    async test(cfg, { fetchImpl }) {
        const r = await call(fetchImpl, `${this.base}/stores`, { headers: { 'x-api-key': cfg.api_key } });
        if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r.status, r.json, { who: 'Lemon Squeezy' }) };
        const n = countOf(r.json, ['data']);
        const names = namesOf(r.json, ['data']);
        return { ok: true, message: `Lemon Squeezy accepted the key: ${n == null ? 'no store is set up' : `${n} store(s)${names.length ? ` (${names.join(', ')})` : ''}`}. Nothing was charged.` };
    },
    async verify(req, cfg) {
        if (!cfg.webhook_secret) return { ok: false, reason: 'the signing secret is not set' };
        const header = String((req.headers || {})['x-signature'] || '');
        if (!header) return { ok: false, reason: 'the notice carries no signature' };
        const expected = hmacHex(cfg.webhook_secret, req.rawBody);
        return sameBytes(expected, header) ? { ok: true } : { ok: false, reason: 'the signature does not match' };
    },
    parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        const meta = event.meta || {};
        return { eventId: (event.data && event.data.id) ? String(event.data.id) : null, type: String(meta.event_name || 'unknown'), payload: event };
    },
};

const PROVIDERS = [PAYPAL, COINBASE, SQUARE, PADDLE, LEMON];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** The provider's row in the Setup tab: one provider, its keys, its switch and its webhook secret. */
const provider = (id) => BY_ID.get(String(id || '')) || null;

/** The provider's values as the webhook and the test read them. */
function settingsOf(id, values = {}, live = false) {
    const p = provider(id);
    if (!p) return null;
    const out = { live: live === true };
    for (const k of p.keys) {
        const name = k.name.split('.').slice(1).join('.');
        out[name] = values[k.name] == null ? '' : values[k.name];
    }
    if (p.bases) out.base = live === true ? p.bases.live : p.bases.sandbox;
    else if (p.base) out.base = p.base;
    else out.base = p.id === 'paypal' ? (live === true ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com') : undefined;
    return out;
}

/**
 * What each key of a provider is for, in the owner's words, and the exact page where it is made
 * (the provider's own pages; the webhook ones name the endpoint Billing expects).
 */
const KEY_DETAILS = {
    'paypal.client_id': {
        unlocks: 'Lets PayPal ask for a token, so a checkout with PayPal can start.',
        getItHow: 'Open your app (Live or Sandbox), then App Credentials, and copy the Client ID.',
    },
    'paypal.client_secret': {
        unlocks: 'Lets PayPal trust the request: without it PayPal refuses every call.',
        getItHow: 'On the same App Credentials page, copy the Secret.',
    },
    'paypal.webhook_id': {
        unlocks: 'Lets Billing believe only the notices PayPal really sent about a payment.',
        getItAt: 'https://developer.paypal.com/dashboard/webhooks/',
        getItHow: 'Open the Webhooks tab of your app, add a webhook for https://billing.openvibe.network/checkout/webhooks/paypal, and copy its id.',
    },
    'paypal.live': {
        unlocks: 'On: PayPal is asked in live mode, so real money can move. Off: only the sandbox is used.',
        getItAt: 'https://developer.paypal.com/dashboard/accounts/',
        getItHow: 'Open your account, then Business details, and finish the activation PayPal asks for; live payments need an activated account.',
    },
    'coinbase.api_key': {
        unlocks: 'Lets Billing read the charges on your Coinbase Commerce store.',
        getItHow: 'Open Settings, then API keys, and copy the key (it is shown once).',
    },
    'coinbase.webhook_secret': {
        unlocks: 'Lets Billing believe only the notices Coinbase Commerce really sent.',
        getItAt: 'https://commerce.coinbase.com/dashboard/settings/notifications',
        getItHow: 'In Settings, then Notifications, show the shared secret and copy it.',
    },
    'coinbase.live': {
        unlocks: 'On: your live store is used and real money can move. Off: only the sandbox is read.',
        getItAt: 'https://commerce.coinbase.com/dashboard/settings',
        getItHow: 'Open the store settings and finish the activation; live payments need a live store.',
    },
    'square.access_token': {
        unlocks: 'Lets Billing read your Square locations and take payments with them.',
        getItHow: 'Open your application, then Credentials, and copy the Access token.',
    },
    'square.signature_key': {
        unlocks: 'Lets Billing believe only the notices Square really sent.',
        getItHow: 'On the same page, under Webhooks, copy the Signature key.',
    },
    'square.live': {
        unlocks: 'On: the production Square is used and real money can move. Off: the sandbox is used.',
        getItHow: 'Open your application and finish its setup; live payments need a production application.',
    },
    'paddle.api_key': {
        unlocks: 'Lets Billing read your Paddle catalogue and its prices.',
        getItHow: 'Open Settings, then API keys, and copy the first key.',
    },
    'paddle.webhook_secret': {
        unlocks: 'Lets Billing believe only the notices Paddle really sent.',
        getItAt: 'https://dashboard.paddle.com/settings/webhooks',
        getItHow: 'In Settings, then Webhooks, open the secret key of the notification and copy it.',
    },
    'paddle.live': {
        unlocks: 'On: the live catalogue is used and real money can move. Off: the sandbox is used.',
        getItAt: 'https://dashboard.paddle.com/settings/products',
        getItHow: 'Open your Paddle account and finish the activation; live payments need a live account.',
    },
    'lemon_squeezy.api_key': {
        unlocks: 'Lets Billing read your Lemon Squeezy store.',
        getItHow: 'Open Settings, then API, and copy the key.',
    },
    'lemon_squeezy.webhook_secret': {
        unlocks: 'Lets Billing believe only the notices Lemon Squeezy really sent.',
        getItAt: 'https://www.lemonsqueezy.com/app/settings/webhooks',
        getItHow: 'In Settings, then Webhooks, copy the signing secret.',
    },
    'lemon_squeezy.live': {
        unlocks: 'On: your live store is used and real money can move. Off: only the sandbox is read.',
        getItAt: 'https://www.lemonsqueezy.com/app/settings',
        getItHow: 'Open the store settings and finish the activation; live payments need a live store.',
    },
};

/** The key's own words, falling back to the provider's. */
function detailsOf(p, key) {
    const d = KEY_DETAILS[key.name] || {};
    return {
        unlocks: d.unlocks || p.unlocks,
        getItAt: d.getItAt || p.getItAt,
        getItHow: d.getItHow || p.getItHow,
    };
}

module.exports = { PROVIDERS, provider, settingsOf, detailsOf, hmacHex, hmacB64, sameBytes, call, refusal, BILLING_BASE, MAX_AGE_SEC };
