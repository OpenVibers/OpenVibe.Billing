'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 signing keys: openvibe-sdk/auth createNetworkKeys (OV_NETWORK_PUBLIC_KEY pinned,
 *             else the JWKS, retried every 30 s until it loads, refreshed every 15 minutes, a rotation followed on
 *             an unknown kid) — verifies service tokens and the console's sign-in
 *   identity  Live user ids → canonical subjects via POST /internal/identity/resolve-batch
 *             { system: 'live', type: 'user', ids } with a client-credentials token
 *             (audience openvibe.network, capability identity.subject.resolve)
 */
const { serviceAuth } = require('openvibe-contracts');
const { createNetworkKeys } = require('openvibe-sdk/auth');

const BATCH = 500;

/** keys.verifyOptions (spread into the openvibe-sdk/auth verifiers), keys.loaded(), keys.start(), keys.stop(), keys.refresh(). */
function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    return createNetworkKeys({ network: config.network.internalUrl, publicKey: config.network.publicKey || null, fetch: fetchImpl, log });
}

function createIdentity(config, { fetchImpl = globalThis.fetch } = {}) {
    const base = config.network.internalUrl;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve',
        fetchImpl,
    });

    async function post(body, retried = false) {
        const res = await fetchImpl(`${base}/internal/identity/resolve-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && !retried) { tokens.invalidate(); return await post(body, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data.results !== 'object') throw new Error(`resolve-batch ${res.status}: ${(data && (data.detail || data.error)) || 'bad response'}`);
        return data.results;
    }

    /** Live user ids → Map(String(id) → subject id | null). */
    async function resolveLiveUsers(liveIds) {
        const out = new Map();
        const list = [...new Set(liveIds.map(String))];
        for (let i = 0; i < list.length; i += BATCH) {
            const chunk = list.slice(i, i + BATCH);
            const results = await post({ system: 'live', type: 'user', ids: chunk });
            for (const k of chunk) {
                const p = results[k];
                out.set(k, p && p.subject && p.subject.type === 'user' ? p.subject.id : null);
            }
        }
        return out;
    }
    return { resolveLiveUsers };
}

module.exports = { createKeyProvider, createIdentity };
