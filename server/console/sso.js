'use strict';
const { staff: staffMap } = require('openvibe-contracts');

/**
 * OpenVibe.Network single sign-on for the staff console: OAuth 2 authorization code with PKCE
 * (S256), as OAuth client `billing`.
 *
 *   authorizeUrl()  https://openvibe.network/oauth/authorize?response_type=code&client_id=billing
 *                   &redirect_uri=<BASE_URL>/auth/callback&scope=profile&state=…&code_challenge=…
 *                   &code_challenge_method=S256
 *   exchange()      POST <OV_NETWORK_INTERNAL_URL>/oauth/token (client secret + code_verifier),
 *                   server to server; the access token is then verified offline with the Network's
 *                   RS256 key Billing already holds (issuer, audience, expiry)
 *
 * The Network's user access token carries `role` and `subject_id` (server/auth/oauth-routes.js
 * issueTokenPair), minted from the users row at the moment of the code exchange, so the role read
 * here is current as of sign-in; the console session is short and re-checks the staff list on
 * every request. Billing keeps none of the Network's tokens: the refresh token it is handed is
 * revoked straight away (best effort).
 */
const crypto = require('crypto');

const b64urlJson = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');           // 43 chars
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function authorizeUrl(config, { state, challenge }) {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.oauth.clientId,
        redirect_uri: config.console.redirectUri,
        scope: 'profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    return `${config.network.url}/oauth/authorize?${q.toString()}`;
}

/** Verify a Network user access token (RS256). Returns claims or throws with a short reason. */
function verifyUserToken(token, { publicKey, issuer, audience, now }) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) throw new Error('not a JWT');
    let header, claims;
    try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new Error('undecodable token'); }
    if (header.alg !== 'RS256') throw new Error(`alg ${header.alg} not accepted`);
    let good = false;
    try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
    if (!good) throw new Error('signature does not verify');
    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + 30 < t) throw new Error('token expired');
    if (typeof claims.iat === 'number' && claims.iat - 30 > t) throw new Error('token issued in the future');
    if (claims.iss !== issuer) throw new Error('wrong issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error(`token is not for ${audience}`);
    return claims;
}

async function exchange(ctx, { code, verifier, publicKey, fetchImpl = globalThis.fetch }) {
    const { config } = ctx;
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.console.redirectUri,
        client_id: config.oauth.clientId,
        client_secret: config.oauth.clientSecret,
        code_verifier: verifier,
    });
    const res = await fetchImpl(`${config.network.internalUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.access_token) {
        const err = new Error((data && (data.error_description || data.error)) || `token endpoint ${res.status}`);
        err.status = res.status;
        throw err;
    }
    // Billing never uses the Network session again: drop the refresh token now.
    if (data.refresh_token) {
        fetchImpl(`${config.network.internalUrl}/oauth/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: data.refresh_token }),
            signal: AbortSignal.timeout(3000),
        }).catch(() => {});
    }
    const claims = verifyUserToken(data.access_token, {
        publicKey, issuer: config.network.issuer, audience: config.console.ssoAudience, now: ctx.now(),
    });
    return {
        subject: typeof claims.subject_id === 'string' ? claims.subject_id : null,
        username: typeof claims.username === 'string' ? claims.username.slice(0, 64) : null,
        // The effective role ('owner' for role admin with is_owner) and whether the staff map lets
        // this token act on money (staff.money.cashouts; ADR-022).
        role: staffMap.effectiveRole(claims),
        money: staffMap.can(claims, 'staff.money.cashouts'),
    };
}

module.exports = { pkcePair, authorizeUrl, verifyUserToken, exchange };
