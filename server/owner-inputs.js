'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): the Test button behind the Setup tab's card-processor rows.
 *
 *   POST /internal/config/:namespace/test/:key   (billing.config.manage, mounted in internal-config.js)
 *     → 200 { ok, message, state, source, namespace, key, tested_at }   (409 config.not_set when nothing is set)
 *       openvibe-shared 4.125.0's test-hook shape ({ ok, message }, 409 config.not_set) with more beside it: state is
 *       connected (Stripe accepted it) or not_working (refused, or it cannot be used); source says where the value
 *       came from (vault: entered in the admin panel; env: the server's settings file, which the code falls back to
 *       and so is tested too).
 *
 * Every test is one read-only Stripe call (the account, or the list of webhook endpoints). Nothing is charged or
 * created. The value is never in the answer, a log line or an error: Stripe's own message is scrubbed of it and cut
 * to one short line.
 */
const TIMEOUT_MS = 10_000;

/** One line, at most 200 characters, with every given secret replaced. */
function oneLine(text, secrets = []) {
    let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    for (const v of secrets) {
        if (typeof v !== 'string' || v.length < 4) continue;
        s = s.split(v).join('[hidden]');
        if (v.length >= 12) s = s.split(v.slice(0, 12)).join('[hidden]');
    }
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

async function stripeGet(cfg, path, key, fetchImpl) {
    let res;
    try {
        res = await fetchImpl(`${cfg.apiBase}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        return { status: 0, json: null, error: err && err.name === 'TimeoutError' ? 'Stripe did not answer within 10 seconds.' : 'Stripe could not be reached.' };
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json, error: null };
}

function refusal(r) {
    if (r.error) return r.error;
    const says = r.json && r.json.error && typeof r.json.error.message === 'string' ? r.json.error.message : '';
    if (r.status === 401) return `Stripe refused the key (401)${says ? `: ${says}` : '.'}`;
    if (r.status === 403) return `Stripe accepted the key but it may not read this (403)${says ? `: ${says}` : '.'} A restricted key needs read access to the account.`;
    if (r.status === 429) return 'Stripe is limiting requests right now (429); try again in a minute.';
    return `Stripe answered ${r.status}${says ? `: ${says}` : '.'}`;
}

/** The secret key: Stripe's account for it (GET /account), read-only. */
async function testStripeKey(cfg, key, { fetchImpl }) {
    const live = /^(sk|rk)_live_/.test(key);
    const r = await stripeGet(cfg, '/account', key, fetchImpl);
    if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: refusal(r) };
    const a = r.json || {};
    const name = (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || (a.business_profile && a.business_profile.name) || '';
    const charges = a.charges_enabled === false ? ' Stripe has not enabled charges on this account yet: finish its activation.' : '';
    const head = `Stripe accepted the key: account ${a.id || '(unnamed)'}${name ? ` (${name})` : ''}, ${live ? 'live mode, real cards are charged' : 'test mode, no real card is charged'}.`;
    if (cfg.live === true && !live) return { ok: false, message: `${head} But the live switch is on and this is a test key, so card payments stay off.` };
    if (cfg.live === false && live) return { ok: false, message: `${head} But the live switch is off and this is a live key, so card payments stay off.` };
    return { ok: a.charges_enabled !== false, message: `${head}${charges}` };
}

/**
 * The webhook signing secret: Stripe never reveals a secret to compare with, so the test checks its form and that
 * Stripe has an enabled endpoint sending to Billing (GET /webhook_endpoints with the secret key, read-only).
 */
async function testStripeWebhook(cfg, value, { fetchImpl }) {
    if (!/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(value)) return { ok: false, message: 'That does not look like a Stripe signing secret: it starts with whsec_.' };
    const key = cfg.secretKey;
    if (!key) return { ok: false, message: 'The secret has the right form, but the Stripe secret key is not set, so Stripe cannot be asked for its webhook endpoints.' };
    const r = await stripeGet(cfg, '/webhook_endpoints?limit=100', key, fetchImpl);
    if (!(r.status >= 200 && r.status < 300)) return { ok: false, message: oneLine(refusal(r), [key]) };
    const list = (r.json && Array.isArray(r.json.data)) ? r.json.data : [];
    const ours = list.find((e) => e && e.status !== 'disabled' && /\/webhooks\/stripe\/?$/.test(String(e.url || '')));
    if (!ours) return { ok: false, message: 'Stripe has no enabled webhook endpoint sending to Billing (/webhooks/stripe): add one, then copy its signing secret here.' };
    return { ok: true, message: `Stripe sends payment notices to ${String(ours.url).replace(/[?#].*$/, '')}, and the secret has the right form. A test payment proves it matches.` };
}

/**
 * The route handler (the capability guard runs before it). `resolve(namespace, key)` answers { value, source, env }
 * or null when there is no test; `run(namespace, key, value)` answers { ok, message }.
 */
function testRoute({ resolve, run, log = console, now = () => Date.now() }) {
    return async function configTest(req, res) {
        const namespace = String(req.params.namespace || '');
        const key = String(req.params.key || '');
        const found = await Promise.resolve(resolve(namespace, key)).catch(() => null);
        if (!found) return res.status(404).json({ type: 'about:blank', status: 404, code: 'config.test_not_found', detail: `${namespace} has no test for ${key}` });
        const base = { namespace, key, source: found.source || null, tested_at: new Date(now()).toISOString() };
        // As openvibe-shared 4.125.0's hook: nothing to test is 409 config.not_set (neither entered nor in the settings file).
        if (!found.value) return res.status(409).type('application/problem+json').json({ type: 'about:blank', status: 409, code: 'config.not_set', detail: `${key} is not set, so there is nothing to test` });
        let out;
        try { out = await run(namespace, key, found.value); } catch (err) { out = { ok: false, message: `The test could not run: ${(err && err.message) || 'unknown error'}` }; }
        const ok = Boolean(out && out.ok);
        const from = found.source === 'env' && found.env ? ` (the value from the server's settings file, ${found.env})` : '';
        const message = oneLine(`${(out && out.message) || (ok ? 'It works.' : 'It did not work.')}${from}`, [found.value]);
        (log.info || log.log).call(log, `[config] test ${namespace} ${key}: ${ok ? 'connected' : 'not working'}`);
        return res.json({ ...base, ok, state: ok ? 'connected' : 'not_working', message });
    };
}

module.exports = { oneLine, testStripeKey, testStripeWebhook, testRoute };
