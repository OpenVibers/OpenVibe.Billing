'use strict';
const { staff: staffMap } = require('openvibe-contracts');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { createSsoClient } = require('openvibe-sdk/sso');

/**
 * OpenVibe.Network single sign-on for the staff console: the OAuth half comes from
 * openvibe-sdk/sso (createSsoClient), as OAuth client `billing`. The console keeps its own short
 * staff session, CSRF token and staff list checks in session.js / index.js; this module owns only
 * the handshake:
 *
 *   start()       https://openvibe.network/oauth/authorize?response_type=code&client_id=billing
 *                 &redirect_uri=<BASE_URL>/auth/callback&scope=profile&state=…&code_challenge=…
 *                 &code_challenge_method=S256
 *   exchange()    the SDK's token grant (client secret + code_verifier), server to server; the access
 *                 token is then verified offline with the Network's keys Billing already holds
 *                 (openvibe-sdk/auth verifyUserToken: issuer, audience, expiry, never a service
 *                 principal or a typed token)
 *   checkClient() the SDK's health check: does the Network accept this client? (/auth/health)
 *
 * The Network's user access token carries `role` and `subject_id` (server/auth/oauth-routes.js
 * issueTokenPair), minted from the users row at the moment of the code exchange, so the role read
 * here is current as of sign-in; the console session is short and re-checks the staff list on
 * every request. Billing keeps none of the Network's tokens: the refresh token it is handed is
 * revoked straight away (best effort).
 */
function createConsoleSso({ ctx, keys, fetchImpl = globalThis.fetch }) {
    const { config } = ctx;
    const log = ctx.log || console;
    const client = createSsoClient({
        site: 'billing',
        siteName: 'OpenVibe.Billing',
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        networkUrl: config.network.url,
        networkInternalUrl: config.network.internalUrl,
        issuer: config.network.issuer,
        redirectUri: config.console.redirectUri,
        scope: 'profile',
        audience: config.console.ssoAudience,
        publicKey: config.network.publicKey || undefined,
        fetch: fetchImpl,
        log,
    });

    /** The authorize URL and the state/verifier the flow cookie must keep. → { url, state, verifier } */
    function start({ silent = false } = {}) {
        return client.authorizeUrl({ silent });
    }

    /** Redeem the code with the SDK, verify the person's token, revoke the refresh token Billing will not use. */
    async function exchange({ code, verifier }) {
        const data = await client.tokenGrant({
            grant_type: 'authorization_code',
            redirect_uri: config.console.redirectUri,
            code: String(code),
            code_verifier: verifier,
        });
        if (!data || !data.access_token) {
            throw Object.assign(new Error('the Network sent no access token'), { status: 502 });
        }
        // Billing never uses the Network session again: drop the refresh token now.
        if (data.refresh_token) {
            Promise.resolve(fetchImpl(`${config.network.internalUrl}/oauth/revoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: data.refresh_token }),
                signal: AbortSignal.timeout(3000),
            })).catch(() => {});
        }
        // openvibe-sdk/auth: RS256 with Network's keys, expiry and issuer, the console's audience; never a service principal
        // or a typed token.
        const claims = await verifyUserToken(data.access_token, {
            ...keys.verifyOptions, issuer: config.network.issuer, audience: config.console.ssoAudience, now: ctx.now(),
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

    /** 'ok' | 'invalid' | 'unknown': does the Network accept this site's OAuth client? */
    function checkClient() {
        return client.checkClient();
    }

    return { start, exchange, checkClient };
}

module.exports = { createConsoleSso };
