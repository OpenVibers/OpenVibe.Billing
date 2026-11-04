'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 signing keys: openvibe-sdk/auth createNetworkKeys (OV_NETWORK_PUBLIC_KEY pinned,
 *             else the JWKS, retried every 30 s until it loads, refreshed every 15 minutes, a rotation followed on
 *             an unknown kid) — verifies service tokens and the console's sign-in
 *   identity  Live user ids → canonical subjects, and subject ids → their public names, via
 *             POST /internal/identity/resolve-batch with a client-credentials token
 *             (audience openvibe.network, capability identity.subject.resolve)
 *   projects  the projects a person administers (GET /internal/projects?subject=usr_…, capability
 *             network.project.member.read) and one membership (GET /internal/projects/:id/members/:subject),
 *             with Billing's own service token
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

    /** Subject ids → Map(subject id → { username, display_name } | null), for public names only. */
    async function profiles(subjectIds) {
        const out = new Map();
        const list = [...new Set(subjectIds.map(String))];
        for (let i = 0; i < list.length; i += BATCH) {
            const chunk = list.slice(i, i + BATCH);
            const results = await post({ subject_ids: chunk });
            for (const k of chunk) {
                const p = results[k];
                out.set(k, p && p.subject && p.subject.type === 'user'
                    ? { username: typeof p.username === 'string' ? p.username : null, display_name: typeof p.display_name === 'string' ? p.display_name : null }
                    : null);
            }
        }
        return out;
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
    return { resolveLiveUsers, profiles };
}

/**
 * Network's project-membership reads, with Billing's service token. A person's own token never authorises them:
 * Network states the role, and Billing only lists or moves money for admin/owner memberships of unarchived projects.
 */
const PROJECT_ADMINS = new Set(['admin', 'owner']);
function createProjects(config, { fetchImpl = globalThis.fetch } = {}) {
    const base = config.network.internalUrl;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'network.project.member.read',
        fetchImpl,
    });

    async function get(path, { retried = false } = {}) {
        const res = await fetchImpl(`${base}${path}`, {
            method: 'GET',
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && !retried) { tokens.invalidate(); return await get(path, { retried: true }); }
        const data = await res.json().catch(() => null);
        if (res.status === 404) return { status: 404, data: null };
        if (!res.ok || data == null) throw new Error(`network project read ${res.status}: ${(data && (data.detail || data.error)) || 'bad response'}`);
        return { status: res.status, data };
    }

    /** The person's memberships, filtered to the projects they administer (admin or owner, not archived). */
    async function administered(subject) {
        const out = await get(`/internal/projects?subject=${encodeURIComponent(subject)}`);
        if (!Array.isArray(out.data.projects)) throw new Error('network project list: bad response');
        return out.data.projects.filter((membership) => !membership.archived && PROJECT_ADMINS.has(membership.role));
    }

    /** One membership; null when the person is not a member (Network answers 404 for a non-member and an unknown project alike). */
    async function member(projectId, subject) {
        const out = await get(`/internal/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(subject)}`);
        return out.status === 404 ? null : out.data;
    }

    return { administered, member };
}

module.exports = { createKeyProvider, createIdentity, createProjects };
