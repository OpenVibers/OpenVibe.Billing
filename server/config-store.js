'use strict';

/**
 * Billing's owner settings (D11): the namespaces `billing.credits` and `billing.vibes`, read through
 * openvibe-shared/config.
 *
 * Every key keeps the environment variable that configured it before D11 as an `x-env` pin: while that
 * variable is set, its value is effective and read-only (the owner's value is refused with
 * 409 config.pinned_in_env). Nothing changes until the owner sets a value. `topup` and the two terms stay
 * without defaults: unset means `topupTerms()` reports `configured: false` and the person's route answers
 * 503 billing.topup_unconfigured. `hold_lease_seconds` is an owner setting with the old
 * BILLING_INFERENCE_LEASE_SECONDS as its pin; when neither is set the loader's 300 s default applies.
 *
 * `credits`, `topup` and the two top-up terms are danger keys (they open or move money). There are no secret-class
 * keys in this namespace, so the write-only `/secrets/:key` route refuses every key here with 422 config.not_secret.
 *
 * `billing.cards` (the owner-setup design of 2026-11-07) holds the card processor: the Stripe secret key, the
 * publishable key and the webhook signing secret (secret class: write-only, sealed with the service's KEK, never
 * shown again) and the live switch (x-danger). Its keys carry `x-owner-input` so the admin panel's Setup tab lists them
 * under Money. They have no x-env pin: the value entered in the panel wins when it is set, and STRIPE_SECRET_KEY,
 * STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET from the environment stay the fallback, read at use time
 * (stripeSettings below), so nothing changes until the owner enters a key.
 */
const config = require('openvibe-shared/config');
const { PROVIDERS: PAYMENT_PROVIDERS, detailsOf } = require('./payments');
const { MAX_RECEIPT_CENTS } = require('./ops/common');
const { iso, prefixedId } = require('./ledger');

const SERVICE = 'billing';
const NAMESPACE = 'billing.credits';
const GROUP = 'Balance';
const VIBES_NAMESPACE = 'billing.vibes';
const VIBES_GROUP = 'Vibes';
const CARDS_NAMESPACE = 'billing.cards';
const CARDS_GROUP = 'Card payments';
const PAYMENTS_NAMESPACE = 'billing.payments';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Balance',
    description: 'The Balance people pay for AI and apps with, and the terms on which they can top it up by card. Change these when you open Balance, start offering top-ups, or change the amounts and the fee.',
    type: 'object',
    additionalProperties: false,
    properties: {
        credits: {
            type: 'boolean', default: false,
            title: 'Open Balance', description: 'When on, people have a Balance: services can hold and spend it, and people see it on their account. Off (the default) answers that Balance is closed. Turning it off again stops new holds; nothing already spent is undone.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS', 'x-danger': true,
        },
        sandbox: {
            type: 'boolean', default: false,
            title: 'Free test Balance', description: 'When on, test accounts can be given made-up Balance to try paid features without paying. For development and integration tests only; off (the default) in production.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_SANDBOX',
        },
        topup: {
            type: 'boolean', default: false,
            title: 'Let people top up by card', description: 'When on, people can add to their Balance through the card processor, at the amounts and fee below. Off (the default) hides top-ups. Turning it off stops new top-ups; paid ones stay paid.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP', 'x-danger': true,
        },
        topup_amounts_cents: {
            type: 'array', items: { type: 'integer', minimum: 1, maximum: MAX_RECEIPT_CENTS }, minItems: 1, uniqueItems: true,
            title: 'Top-up amounts (cents)', description: 'The only amounts a person may pick when topping up, in US cents: [500, 1000, 2500] offers $5, $10 and $25. Unset, top-ups say they are not set up yet.',
            'x-example': '500, 1000, 2500',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP_AMOUNTS_CENTS', 'x-danger': true,
        },
        topup_fee_bps: {
            type: 'integer', minimum: 0, maximum: 10_000,
            title: 'Top-up fee', 'x-unit': 'bps', 'x-example': 300,
            description: 'The fee added on top of a top-up at checkout, in hundredths of a percent: 300 is 3%, so a $10 top-up costs $10.30. 0 is a real setting (no fee); unset, top-ups say they are not set up yet.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP_FEE_BPS', 'x-danger': true,
        },
        // Shared 4.122.0's x-unit accepts seconds.
        hold_lease_seconds: {
            type: 'integer', minimum: 1, maximum: 86_400, default: 300, 'x-unit': 'seconds',
            title: 'How long a hold lasts', description: 'Seconds a service may keep Balance on hold before spending it (default 300, five minutes). Longer lets slow AI requests finish; shorter gives unspent Balance back sooner.',
            'x-group': GROUP, 'x-env': 'BILLING_INFERENCE_LEASE_SECONDS',
        },
    },
};

const VIBES_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Vibes',
    description: 'Vibes are the coins people spend inside apps. These settings decide whether apps may charge Vibes, how much, and whether people can buy Vibes with their Balance.',
    type: 'object',
    additionalProperties: false,
    properties: {
        vibes_pay: {
            type: 'boolean', default: false,
            title: 'Let apps charge Vibes', description: 'When on, apps can ask a person to pay Vibes on the pay sheet, and real Vibes are spent. Off (the default) refuses every app charge. Turning it off again stops new charges at once.',
            'x-group': VIBES_GROUP, 'x-env': 'BILLING_VIBES_PAY', 'x-danger': true,
        },
        max_charge_vibes: {
            type: 'integer', minimum: 0, maximum: 10_000_000, default: 0,
            title: 'Largest single charge (Vibes)', 'x-example': 500,
            description: 'The most Vibes one app charge may ask for (default 0, which refuses every charge). Higher allows bigger purchases in apps; lower limits what one mistake can cost.',
            'x-group': VIBES_GROUP, 'x-env': 'BILLING_VIBES_MAX_CHARGE',
        },
        daily_app_spend_vibes_per_person: {
            type: 'integer', minimum: 0, maximum: 10_000_000, default: 0,
            title: 'Most a person may spend in apps a day (Vibes)', 'x-example': 2000,
            description: 'The most Vibes one person may spend in all apps together in one UTC day (default 0, which refuses all app spending). Lower protects people from spending too much.',
            'x-group': VIBES_GROUP, 'x-env': 'BILLING_VIBES_DAILY_APP_SPEND',
        },
        from_balance: {
            type: 'boolean', default: false,
            title: 'Let people buy Vibes with Balance', description: 'When on, a person can turn Balance into Vibes at the same rate as a Vibes pack. Off (the default) offers Vibes packs only. Turning it off stops new purchases; Vibes already bought stay.',
            'x-group': VIBES_GROUP, 'x-env': 'BILLING_VIBES_FROM_BALANCE', 'x-danger': true,
        },
    },
};

/**
 * The card processor (Stripe). The three keys are secret class: write-only through /secrets/:key, sealed with the
 * KEK, shown only as the last four characters. No x-env pin: the panel's value wins and the environment is the
 * fallback, read at use time by stripeSettings().
 */
const CARDS_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Card payments',
    description: 'The card processor that takes payments for Balance top-ups, purchases and subscriptions (Stripe). Change these when you connect your Stripe account, rotate a key, or are ready to take real payments.',
    type: 'object',
    additionalProperties: false,
    properties: {
        'stripe.secret_key': {
            type: 'string', minLength: 8, maxLength: 512, pattern: '^(sk|rk)_(test|live)_[A-Za-z0-9]+$',
            title: 'Stripe secret key', 'x-group': CARDS_GROUP, 'x-example': 'sk_live_…',
            description: 'The key Billing uses to open Stripe checkouts and cancel subscriptions. Without it (and the webhook signing secret) card payments stay off. A test key (sk_test_…) charges no real card.',
            'x-owner-input': {
                group: 'money',
                unlocks: 'Lets people pay by card: Balance top-ups, purchases and subscriptions open a Stripe checkout. Without it card payments stay off.',
                get_it_at: 'https://dashboard.stripe.com/apikeys',
                get_it_how: 'Copy the Secret key (sk_live_… for real payments, sk_test_… to try it), or create a restricted key that may write Checkout Sessions and Subscriptions.',
                test: true,
            },
            'x-required-for': 'Card payments',
        },
        'stripe.publishable_key': {
            type: 'string', minLength: 8, maxLength: 512, pattern: '^pk_(test|live)_[A-Za-z0-9]+$',
            title: 'Stripe publishable key', 'x-group': CARDS_GROUP, 'x-example': 'pk_live_…',
            description: 'The public key a page needs to show Stripe\'s card form inside OpenVibe. Billing\'s checkout sends people to Stripe\'s own page today, so nothing needs it yet; it is kept for an in-page form.',
            'x-owner-input': {
                group: 'money',
                unlocks: 'Lets a page show Stripe\'s card form inside OpenVibe instead of sending people to Stripe\'s checkout page. Optional: today\'s checkout works without it.',
                get_it_at: 'https://dashboard.stripe.com/apikeys',
                get_it_how: 'Copy the Publishable key from the same page as the secret key, in the same mode (pk_live_… with sk_live_…).',
                test: false,
            },
        },
        'stripe.webhook_secret': {
            type: 'string', minLength: 8, maxLength: 512, pattern: '^whsec_[A-Za-z0-9+/=_-]+$',
            title: 'Stripe webhook signing secret', 'x-group': CARDS_GROUP, 'x-example': 'whsec_…',
            description: 'The secret Stripe signs its payment notices with, so Billing only believes notices that really come from Stripe. Without it card payments stay off, because a paid checkout could never be confirmed.',
            'x-owner-input': {
                group: 'money',
                unlocks: 'Lets Billing confirm card payments: Stripe tells Billing when a checkout is paid, refunded or disputed. Without it card payments stay off.',
                get_it_at: 'https://dashboard.stripe.com/webhooks',
                get_it_how: 'Add an endpoint for https://billing.openvibe.network/webhooks/stripe with the checkout, invoice, charge and subscription events, then reveal its Signing secret (whsec_…).',
                test: true,
            },
            'x-required-for': 'Card payments',
        },
        'stripe.live': {
            type: 'boolean', title: 'Take real card payments', 'x-group': CARDS_GROUP, 'x-danger': true,
            description: 'On: only a live key (sk_live_…) is used and real cards are charged. Off: only a test key (sk_test_…) is used and no real card is charged. Not set (the default): the key decides, as before this switch. Turning it off stops real charges at once.',
            'x-owner-input': {
                group: 'money',
                unlocks: 'Decides whether card payments charge real cards. Turn it on once a test payment has gone through; turn it off to stop real charges at once.',
                get_it_at: 'https://dashboard.stripe.com/account/onboarding',
                get_it_how: 'Finish Stripe\'s account activation first (business details and a bank account), or Stripe refuses live payments.',
                test: false,
            },
        },
    },
};
const CARD_SECRET_KEYS = new Set(['stripe.secret_key', 'stripe.publishable_key', 'stripe.webhook_secret']);
const cardsClassify = (key) => (CARD_SECRET_KEYS.has(key) ? 'secret' : 'internal');

/**
 * The checkout providers beyond Stripe (plan §AB.16): PayPal, Coinbase Commerce, Square, Paddle and
 * Lemon Squeezy. One provider is one row of the owner's Setup tab: its keys, the test/live switch and
 * the webhook signing secret are fields of the same row, and every field of that row shares one
 * x-required-for, so the guide shows the provider once with its fields under it.
 *
 * The schema is built from the provider registry (server/payments.js), so a provider is described in
 * one place only. Secret-class fields (the credentials and the webhook secrets) are write-only and
 * sealed with the service's KEK; the live switch is danger-class, so turning it on needs a fresh
 * sign-in. No x-env pins: the vault is the only place these values live, and nothing reads them from
 * the environment.
 */

const PAYMENTS_SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Payment providers',
    description: 'The payment providers OpenVibe can take money with, beyond Stripe: PayPal, Coinbase Commerce, Square, Paddle and Lemon Squeezy. A provider with no keys is skipped; a test key or a test mode never touches real money.',
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(PAYMENT_PROVIDERS.flatMap((provider) => provider.keys.map((key) => {
        const details = detailsOf(provider, key);
        const prop = {
            type: key.live ? 'boolean' : 'string',
            title: key.title,
            description: key.description,
            'x-group': provider.group,
            'x-owner-input': {
                group: 'money',
                unlocks: details.unlocks,
                get_it_at: details.getItAt,
                get_it_how: details.getItHow,
                test: key.test === true,
            },
            'x-required-for': provider.requiredFor,
        };
        if (key.live) {
            prop.default = false;
            prop['x-danger'] = true;
        } else {
            prop.minLength = 4;
            prop.maxLength = 512;
        }
        return [key.name, prop];
    }))),
});

/** The secret-class fields of the payment providers: the credentials and the webhook secrets. */
const paymentSecretKeys = new Set(PAYMENT_PROVIDERS.flatMap((p) => p.keys.filter((k) => k.secret).map((k) => k.name)));
const paymentsClassify = (key) => (paymentSecretKeys.has(key) ? 'secret' : 'internal');

/**
 * The Stripe settings the adapter reads at use time: the panel's value when one is set, else the environment's
 * (`base`, the loader's STRIPE_* values). `live` false or true makes a key of the other mode unusable (the adapter
 * stays off and says why); unset keeps today's behaviour.
 */
function stripeSettings(store, base = {}) {
    const pick = (key, fallback) => {
        const v = store ? store.get(key) : undefined;
        return typeof v === 'string' && v ? { value: v, source: 'vault' } : { value: fallback || '', source: fallback ? 'env' : null };
    };
    const out = {
        apiBase: base.apiBase,
        toleranceSec: base.toleranceSec,
        get secretKey() { return pick('stripe.secret_key', base.secretKey).value; },
        get publishableKey() { return pick('stripe.publishable_key', base.publishableKey).value; },
        get webhookSecret() { return pick('stripe.webhook_secret', base.webhookSecret).value; },
        get live() { const v = store ? store.get('stripe.live') : undefined; return typeof v === 'boolean' ? v : null; },
        /** Where a value comes from (vault, env or null) and the env name it falls back to. */
        source(key) {
            const env = { 'stripe.secret_key': 'STRIPE_SECRET_KEY', 'stripe.publishable_key': 'STRIPE_PUBLISHABLE_KEY', 'stripe.webhook_secret': 'STRIPE_WEBHOOK_SECRET' }[key];
            const fallback = { 'stripe.secret_key': base.secretKey, 'stripe.publishable_key': base.publishableKey, 'stripe.webhook_secret': base.webhookSecret }[key];
            return { ...pick(key, fallback), env };
        },
        /** null when the key may be used, else the reason it may not (a key of the other mode than the live switch). */
        get modeProblem() {
            const live = out.live;
            const key = out.secretKey;
            if (live === null || !key) return null;
            const isLive = /^(sk|rk)_live_/.test(key);
            if (live && !isLive) return 'the live switch is on but the secret key is a test key';
            if (!live && isLive) return 'the live switch is off but the secret key is a live key';
            return null;
        },
    };
    return out;
}

const AMOUNT_RE = /^[0-9]+$/;

/** A top-up amount list from a JSON array, a JSON string, or today's comma-separated env value. */
function parseAmounts(raw) {
    const bad = [];
    let parts;
    if (Array.isArray(raw)) parts = raw;
    else {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) return { values: [], ok: false, empty: true, invalid: [] };
        if (text.startsWith('[')) {
            try { parts = JSON.parse(text); } catch { return { values: [], ok: false, invalid: [text] }; }
            if (!Array.isArray(parts)) return { values: [], ok: false, invalid: [text] };
        } else parts = text.split(',').map((s) => s.trim());
    }
    const values = [];
    for (const part of parts) {
        const s = String(part);
        const n = Number(s);
        if (!AMOUNT_RE.test(s) || !Number.isSafeInteger(n) || n <= 0 || n > MAX_RECEIPT_CENTS) { bad.push(s); continue; }
        values.push(n);
    }
    return { values: [...new Set(values)].sort((a, b) => a - b), ok: bad.length === 0, invalid: bad };
}

const PINNED = ['BILLING_CREDITS', 'BILLING_CREDITS_SANDBOX', 'BILLING_CREDITS_TOPUP', 'BILLING_CREDITS_TOPUP_AMOUNTS_CENTS',
    'BILLING_CREDITS_TOPUP_FEE_BPS', 'BILLING_INFERENCE_LEASE_SECONDS'];
const VIBES_PINNED = ['BILLING_VIBES_PAY', 'BILLING_VIBES_MAX_CHARGE', 'BILLING_VIBES_DAILY_APP_SPEND', 'BILLING_VIBES_FROM_BALANCE'];

/**
 * The environment as the store should read it. An empty variable means unset (as `loadConfig` already reads
 * it), a boolean keeps every form `loadConfig` accepted (`1`, `true`, `yes`, `on`), and a comma-separated
 * amount list becomes the JSON array its array pin needs.
 */
function storeEnv(env) {
    const out = { ...(env || {}) };
    for (const name of PINNED) if (out[name] != null && String(out[name]).trim() === '') delete out[name];
    for (const name of ['BILLING_CREDITS', 'BILLING_CREDITS_SANDBOX', 'BILLING_CREDITS_TOPUP']) {
        if (out[name] == null) continue;
        out[name] = ['1', 'true', 'yes', 'on'].includes(String(out[name]).toLowerCase()) ? '1' : '0';
    }
    const raw = out.BILLING_CREDITS_TOPUP_AMOUNTS_CENTS;
    if (raw != null) {
        const parsed = parseAmounts(raw);
        if (parsed.ok) out.BILLING_CREDITS_TOPUP_AMOUNTS_CENTS = JSON.stringify(parsed.values);
    }
    return out;
}

/** The values the namespace would have from the environment alone (the pre-D11 reader; unit tests and `topupTerms` fallback). */
function valuesFromEnv(env) {
    const on = (name) => ['1', 'true', 'yes', 'on'].includes(String(env && env[name] != null ? env[name] : '').toLowerCase());
    return {
        credits: on('BILLING_CREDITS'),
        sandbox: on('BILLING_CREDITS_SANDBOX'),
        topup: on('BILLING_CREDITS_TOPUP'),
        ...(env && env.BILLING_CREDITS_TOPUP_AMOUNTS_CENTS != null && String(env.BILLING_CREDITS_TOPUP_AMOUNTS_CENTS).trim() !== ''
            ? { topup_amounts_cents: env.BILLING_CREDITS_TOPUP_AMOUNTS_CENTS } : {}),
        ...(env && env.BILLING_CREDITS_TOPUP_FEE_BPS != null && String(env.BILLING_CREDITS_TOPUP_FEE_BPS).trim() !== ''
            ? { topup_fee_bps: Number(env.BILLING_CREDITS_TOPUP_FEE_BPS) } : {}),
        ...(env && env.BILLING_INFERENCE_LEASE_SECONDS != null && String(env.BILLING_INFERENCE_LEASE_SECONDS).trim() !== ''
            ? { hold_lease_seconds: Number(env.BILLING_INFERENCE_LEASE_SECONDS) } : {}),
    };
}

/** The Vibes namespace's environment: empty means unset and a switch keeps every form loadConfig accepted. */
function vibesStoreEnv(env) {
    const out = { ...(env || {}) };
    for (const name of VIBES_PINNED) if (out[name] != null && String(out[name]).trim() === '') delete out[name];
    for (const name of ['BILLING_VIBES_PAY', 'BILLING_VIBES_FROM_BALANCE']) {
        if (out[name] == null) continue;
        out[name] = ['1', 'true', 'yes', 'on'].includes(String(out[name]).toLowerCase()) ? '1' : '0';
    }
    return out;
}

/** Apply the store's effective values to the config object the rest of the service already reads (live). */
function applyValues(config, values) {
    const credits = config.credits || (config.credits = {});
    credits.enabled = values.credits === true;
    credits.sandbox = values.sandbox === true;
    const lease = Number(values.hold_lease_seconds);
    credits.leaseSeconds = Number.isFinite(lease) ? Math.max(1, Math.min(86_400, Math.trunc(lease))) : 300;
}

function applyVibesValues(config, values) {
    const vibes = config.vibes || (config.vibes = {});
    vibes.pay = values.vibes_pay === true;
    vibes.fromBalance = values.from_balance === true;
    const max = Number(values.max_charge_vibes);
    const daily = Number(values.daily_app_spend_vibes_per_person);
    vibes.maxChargeVibes = Number.isSafeInteger(max) && max >= 0 ? max : 0;
    vibes.dailyAppSpendVibesPerPerson = Number.isSafeInteger(daily) && daily >= 0 ? daily : 0;
}

/** One append-only staff_audit row per activation: service, namespace, keys, actor, revision; never a value. */
async function auditChange(db, { namespace, service, keys, actor, revision }, log) {
    try {
        const at = iso(Date.now());
        await db.prepare(`INSERT INTO staff_audit (id, at, actor_subject, action, target_type, target_id, reason, outcome, detail)
            VALUES (?, ?, ?, 'config.change', 'config_namespace', ?, 'configuration activated', 'done', ?)`)
            .run(prefixedId('sa', Date.now()), at, actor && actor.type === 'user' ? actor.id : null, namespace,
                JSON.stringify({ service, namespace, keys: [...(keys || [])], revision }));
    } catch (err) {
        // The audit must never refuse a revision: log the failure without the values.
        (log || console).warn(`[config] audit line failed: ${err && err.message ? err.message.split('\n')[0] : 'unknown error'}`);
    }
}

/** Create the store, apply its values and (when a KEK is configured) reseal old plaintext rows once at boot. */
async function createBillingConfig({ db, env, log = console, schema = SCHEMA, onActivate = null }) {
    const store = await config.createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema,
        env: storeEnv(env),
        classify: () => 'internal',
        onActivate,
        onChange: async (change) => await auditChange(db, { ...change, namespace: NAMESPACE, service: SERVICE }, log),
        log,
    });
    if (store.sealed) {
        try {
            const report = await store.reseal();
            if (report.plaintext || report.resealed || report.errors.length) {
                log.info(`[config] ${NAMESPACE} reseal at boot: ${report.resealed} resealed, ${report.plaintext} plaintext, ${report.errors.length} error(s)`);
            }
        } catch (err) {
            log.warn(`[config] ${NAMESPACE} reseal at boot failed: ${err && err.message ? err.message.split('\n')[0] : 'unknown error'}`);
        }
    }
    return store;
}

/** The D11 `billing.vibes` namespace (Vibes Pay limits and Get Vibes with Balance). */
async function createVibesConfig({ db, env, log = console, schema = VIBES_SCHEMA, onActivate = null }) {
    return await config.createConfigStore({
        db, service: SERVICE, namespace: VIBES_NAMESPACE, schema,
        env: vibesStoreEnv(env),
        classify: () => 'internal',
        onActivate,
        onChange: async (change) => await auditChange(db, { ...change, namespace: VIBES_NAMESPACE, service: SERVICE }, log),
        log,
    });
}

/** The D11 `billing.cards` namespace: the card processor's keys (sealed) and the live switch. */
async function createCardsConfig({ db, env, log = console, schema = CARDS_SCHEMA }) {
    const store = await config.createConfigStore({
        db, service: SERVICE, namespace: CARDS_NAMESPACE, schema,
        env: env || {},
        classify: cardsClassify,
        onChange: async (change) => await auditChange(db, { ...change, namespace: CARDS_NAMESPACE, service: SERVICE }, log),
        log,
    });
    if (store.sealed) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${CARDS_NAMESPACE} reseal at boot failed: ${err && err.message ? err.message.split('\n')[0] : 'unknown error'}`); }
    }
    return store;
}

/**
 * The payment providers namespace (billing.payments): the keys of the five checkout providers, their
 * live switches and their webhook secrets, all sealed in the vault.
 */
async function createPaymentsConfig({ db, env, log = console, schema = PAYMENTS_SCHEMA }) {
    const store = await config.createConfigStore({
        db, service: SERVICE, namespace: PAYMENTS_NAMESPACE, schema,
        env: env || {},
        classify: paymentsClassify,
        onChange: async (change) => await auditChange(db, { ...change, namespace: PAYMENTS_NAMESPACE, service: SERVICE }, log),
        log,
    });
    if (store.sealed) {
        try { await store.reseal(); } catch (err) { log.warn(`[config] ${PAYMENTS_NAMESPACE} reseal at boot failed: ${err && err.message ? err.message.split('\n')[0] : 'unknown error'}`); }
    }
    return store;
}

/**
 * The providers' settings, read at use time from the vault (server/payments.js settingsOf): the
 * values the owner entered, the live switch, and where a value came from (the vault only: these
 * keys have no environment pin).
 */
function paymentsSettings(store) {
    const { settingsOf } = require('./payments');
    const out = { providers: {} };
    for (const provider of PAYMENT_PROVIDERS) {
        // The values are read at use time, so a key the owner just pasted works without a restart.
        const values = () => (store ? store.get() : {});
        const live = () => values()[provider.keys.find((k) => k.live).name] === true;
        const cfg = { get live() { return live(); } };
        for (const k of provider.keys) {
            if (k.live) continue;
            const local = k.name.split('.').slice(1).join('.');
            Object.defineProperty(cfg, local, { get: () => { const v = values()[k.name]; return v == null ? '' : v; }, enumerable: true });
        }
        // The provider's own base address, which follows the live switch.
        Object.defineProperty(cfg, 'base', {
            enumerable: true,
            get: () => settingsOf(provider.id, values(), live()).base,
        });
        // Where a value came from: these keys have no environment pin, so it is the vault or nothing.
        cfg.source = (key) => {
            const full = provider.keys.find((k) => k.name.split('.').slice(1).join('.') === key);
            const v = full ? values()[full.name] : undefined;
            const empty = v == null || v === '';
            return { value: empty ? '' : v, source: empty ? null : 'vault', env: null };
        };
        out.providers[provider.id] = cfg;
    }
    return out;
}

module.exports = {
    SERVICE, NAMESPACE, VIBES_NAMESPACE, CARDS_NAMESPACE, PAYMENTS_NAMESPACE,
    SCHEMA, VIBES_SCHEMA, CARDS_SCHEMA, PAYMENTS_SCHEMA, PAYMENT_PROVIDERS,
    parseAmounts, storeEnv, valuesFromEnv, applyValues,
    vibesStoreEnv, applyVibesValues, createBillingConfig, createVibesConfig, createCardsConfig, createPaymentsConfig,
    stripeSettings, paymentsSettings, auditChange,
};
