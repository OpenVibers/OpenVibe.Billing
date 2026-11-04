'use strict';

/**
 * Billing's owner settings (D11): the namespace `billing.credits`, read through openvibe-shared/config.
 *
 * Every key keeps the environment variable that configured it before D11 as an `x-env` pin: while that
 * variable is set, its value is effective and read-only (the owner's value is refused with
 * 409 config.pinned_in_env). Nothing changes until the owner sets a value. `topup` and the two terms stay
 * without defaults: unset means `topupTerms()` reports `configured: false` and the person's route answers
 * 503 billing.topup_unconfigured. `hold_lease_seconds` is an owner setting with the old
 * BILLING_INFERENCE_LEASE_SECONDS as its pin; when neither is set the loader's 300 s default applies.
 *
 * `credits`, `topup` and the two top-up terms are danger keys (they open or move money). There are no secret-class
 * keys in this namespace: Billing's provider credentials stay in the service's environment, so the
 * write-only `/secrets/:key` route refuses every key here with 422 config.not_secret.
 */
const config = require('openvibe-shared/config');
const { MAX_RECEIPT_CENTS } = require('./ops/common');
const { iso, prefixedId } = require('./ledger');

const SERVICE = 'billing';
const NAMESPACE = 'billing.credits';
const GROUP = 'Credits';

const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Billing Credits',
    description: 'Credits ledger and the owner terms of the checkout top-up.',
    type: 'object',
    additionalProperties: false,
    properties: {
        credits: {
            type: 'boolean', default: false,
            title: 'Credits ledger', description: 'Open the Credits ledger: the internal hold/settle API and the person\'s Credits routes.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS', 'x-danger': true,
        },
        sandbox: {
            type: 'boolean', default: false,
            title: 'Sandbox credit grants', description: 'Allow synthetic sandbox credit grants, for development and integration tests only.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_SANDBOX',
        },
        topup: {
            type: 'boolean', default: false,
            title: 'Credits top-up', description: 'Offer checkout top-ups of Credits through the payment providers.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP', 'x-danger': true,
        },
        topup_amounts_cents: {
            type: 'array', items: { type: 'integer', minimum: 1, maximum: MAX_RECEIPT_CENTS }, minItems: 1, uniqueItems: true,
            title: 'Top-up amounts (cents)', description: 'The only amounts a person may top up, in whole USD cents.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP_AMOUNTS_CENTS', 'x-danger': true,
        },
        topup_fee_bps: {
            type: 'integer', minimum: 0, maximum: 10_000,
            title: 'Top-up fee (bps)', description: 'Fee in basis points charged on top of the top-up at checkout; 0 is a real, configured fee.',
            'x-group': GROUP, 'x-env': 'BILLING_CREDITS_TOPUP_FEE_BPS', 'x-danger': true,
        },
        // The unit is seconds; Shared 4.110.0's x-unit only accepts nano_usd, ms and bps, so it is in the title
        // rather than an x-unit that would make createConfigStore throw.
        hold_lease_seconds: {
            type: 'integer', minimum: 1, maximum: 86_400, default: 300,
            title: 'Hold lease (seconds)', description: 'How long a Credits hold lasts before it expires.',
            'x-group': GROUP, 'x-env': 'BILLING_INFERENCE_LEASE_SECONDS',
        },
    },
};

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

/** Apply the store's effective values to the config object the rest of the service already reads (live). */
function applyValues(config, values) {
    const credits = config.credits || (config.credits = {});
    credits.enabled = values.credits === true;
    credits.sandbox = values.sandbox === true;
    const lease = Number(values.hold_lease_seconds);
    credits.leaseSeconds = Number.isFinite(lease) ? Math.max(1, Math.min(86_400, Math.trunc(lease))) : 300;
}

/** One append-only staff_audit row per activation: service, namespace, keys, actor, revision; never a value. */
async function auditChange(db, { keys, actor, revision }, log) {
    try {
        const at = iso(Date.now());
        await db.prepare(`INSERT INTO staff_audit (id, at, actor_subject, action, target_type, target_id, reason, outcome, detail)
            VALUES (?, ?, ?, 'config.change', 'config_namespace', ?, 'configuration activated', 'done', ?)`)
            .run(prefixedId('sa', Date.now()), at, actor && actor.type === 'user' ? actor.id : null, NAMESPACE,
                JSON.stringify({ service: SERVICE, namespace: NAMESPACE, keys: [...(keys || [])], revision }));
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
        onChange: async (change) => await auditChange(db, change, log),
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

module.exports = {
    SERVICE, NAMESPACE, SCHEMA, parseAmounts, storeEnv, valuesFromEnv, applyValues, createBillingConfig, auditChange,
};
