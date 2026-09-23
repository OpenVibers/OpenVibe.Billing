'use strict';

/**
 * OpenVibe.Billing configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/billing.env in production). loadConfig(env) is pure so tests build their own.
 *
 * Money rates are configuration, never constants in the code paths (ADR-012): every transaction
 * records the rates it was computed with in its metadata, so a later change of rates never
 * rewrites history.
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');

// Live's purchase price tiers (server/monetization/vibes.js BUCKS_PRICE_TIERS): USD per bit,
// bigger buys are cheaper. The spread over the value rate is platform revenue.
const DEFAULT_PRICE_TIERS = [
    { min: 25000, usd_per_bit: 0.0110 },
    { min: 10000, usd_per_bit: 0.0115 },
    { min: 5000, usd_per_bit: 0.0120 },
    { min: 2500, usd_per_bit: 0.0124 },
    { min: 1000, usd_per_bit: 0.0130 },
    { min: 500, usd_per_bit: 0.0140 },
    { min: 0, usd_per_bit: 0.0150 },
];

function parseTiers(raw) {
    if (!raw) return DEFAULT_PRICE_TIERS;
    const tiers = JSON.parse(raw);
    if (!Array.isArray(tiers) || !tiers.length) throw new Error('BILLING_PRICE_TIERS must be a non-empty JSON array');
    for (const t of tiers) {
        if (!Number.isInteger(t.min) || t.min < 0 || !(t.usd_per_bit > 0)) throw new Error('BILLING_PRICE_TIERS entries are { min: int >= 0, usd_per_bit: > 0 }');
    }
    return [...tiers].sort((a, b) => b.min - a.min);
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4600);
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    return {
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl: trim(env.BASE_URL || (isProduction ? 'https://billing.openvibe.network' : `http://localhost:${port}`)),
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,
        dbPath: env.BILLING_DB_PATH || './data/billing.db',

        // Identity: service tokens are RS256 JWTs signed by OpenVibe.Network.
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        },
        audience: env.BILLING_AUDIENCE || 'openvibe.billing',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'billing',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
        },

        // Money rates (Live's current values are the defaults).
        rates: {
            bitsPerUsd: int(env.BILLING_BITS_PER_USD, 100),               // value rate (Live bucks_per_usd)
            priceTiers: parseTiers(env.BILLING_PRICE_TIERS),                // purchase price tiers
            minPurchaseBits: int(env.BILLING_MIN_PURCHASE_BITS, 100),
            maxBits: int(env.BILLING_MAX_BITS, 10_000_000),
            subPriceCents: int(env.BILLING_SUB_PRICE_CENTS, 499),
            subSharePct: num(env.BILLING_SUB_SHARE_PCT, 70),                // streamer share of a sub
            siteRouteFeePct: num(env.BILLING_SITE_ROUTE_FEE_PCT, 10),       // PowerChat site-route fee
            subPeriodDays: int(env.BILLING_SUB_PERIOD_DAYS, 31),
            minCashoutBits: int(env.BILLING_MIN_CASHOUT_BITS, 500),
            escrowDays: num(env.BILLING_ESCROW_DAYS, 14),
            stripeGraceDays: num(env.BILLING_STRIPE_GRACE_DAYS, 3),
        },

        // Provider adapters: each is enabled only when its secrets are set.
        providers: {
            powerchat: {
                webhookSecret: env.POWERCHAT_WEBHOOK_SECRET || '',
                siteUsername: String(env.POWERCHAT_SITE_USERNAME || '').trim().toLowerCase(),
                allowTest: bool(env.POWERCHAT_ALLOW_TEST_FULFILLMENT),
                maxSkewMs: int(env.POWERCHAT_MAX_SKEW_MS, 15 * 60 * 1000),
            },
            stripe: {
                secretKey: env.STRIPE_SECRET_KEY || '',
                webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
                apiBase: trim(env.STRIPE_API_BASE || 'https://api.stripe.com/v1'),
                toleranceSec: int(env.STRIPE_TOLERANCE_SEC, 300),
            },
            paypal: {
                clientId: env.PAYPAL_CLIENT_ID || '',
                clientSecret: env.PAYPAL_CLIENT_SECRET || '',
                webhookId: env.PAYPAL_WEBHOOK_ID || '',
                apiBase: trim(env.PAYPAL_API_BASE || (env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')),
            },
            ccbill: {
                webhookSecret: env.CCBILL_WEBHOOK_SECRET || '',
                clientAccount: env.CCBILL_CLIENT_ACCOUNT || '',
                subAccount: env.CCBILL_SUBACCOUNT || '',
                flexformId: env.CCBILL_FLEXFORM_ID || '',
                salt: env.CCBILL_SALT || '',
            },
            nowpayments: {
                apiKey: env.NOWPAYMENTS_API_KEY || '',
                ipnSecret: env.NOWPAYMENTS_IPN_SECRET || '',
                apiBase: trim(env.NOWPAYMENTS_API_BASE || 'https://api.nowpayments.io/v1'),
            },
        },

        // Durable events: the outbox relay runs only when EVENTS_URL is set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
        },
        jobs: {
            enabled: env.BILLING_JOBS !== 'off',
            sweepIntervalMs: int(env.BILLING_SWEEP_INTERVAL_MS, 60 * 60 * 1000),
            webhookRetryMs: int(env.BILLING_WEBHOOK_RETRY_MS, 60 * 1000),
        },
    };
}

module.exports = { loadConfig, DEFAULT_PRICE_TIERS };
