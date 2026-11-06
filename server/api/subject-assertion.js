'use strict';

/**
 * Subject assertions on the money routes (ADR-003, the 2026-11-06 amendment; plan H1).
 *
 * ADR-003 says a first-party service vouches for its own signed-in person: it names them in the
 * request and the receiver believes it. On a money route that is too much to believe, because a
 * compromised service could then read anyone's transactions or tip in their name.
 *
 * A subject assertion is the person's own answer to the same question: a Network-signed,
 * 60-second JWT that names the person (`sub`), the service it was minted for (`act`) and the
 * service it is for (`aud`). The caller sends it in `X-OV-Subject-Assertion`; Billing checks the
 * signature against Network's JWKS and that the person it names is the person the route acts for.
 *
 * The switch is `BILLING_REQUIRE_SUBJECT_ASSERTION`:
 *
 *   off (today)  a money route that names a person still works without an assertion (the old,
 *                vouched way). An assertion that comes is checked: one that names another person
 *                is refused, and one that does not verify is counted and ignored.
 *   on           a money route that names a person must carry an assertion, and it must verify.
 *                The old way is then refused (403 `subject.assertion_required`).
 *
 * The flag turns on once every caller sends assertions (the callers' PRs are part of this change).
 */
const { createSubjectAssertionVerifier } = require('openvibe-sdk/auth');
const { fail } = require('../ops/common');

/** The header a money call carries the assertion in. */
const HEADER = 'x-ov-subject-assertion';

function createSubjectAssertion({ config, log = console }) {
    const audience = config.audience || 'openvibe.billing';
    const base = String((config.network && (config.network.internalUrl || config.network.url)) || '').replace(/\/+$/, '');
    const jwksUrl = `${base}/api/.well-known/jwks`;
    const verifier = createSubjectAssertionVerifier({ jwks: jwksUrl, audience, log });
    // What the routes did while the flag was off (and what a dashboard would show).
    const counters = { asserted: 0, unasserted: 0, invalid: 0, refused: 0 };

    /** True when the old way is refused and an assertion is required. */
    const required = () => Boolean(config.subjectAssertion && config.subjectAssertion.required);

    /** The assertion on this request, verified. */
    async function verify(req) {
        const raw = String((req.headers && req.headers[HEADER]) || '').trim();
        if (!raw) return { present: false, ok: false, code: null, reason: null };
        const r = await verifier.verify(raw, { act: req.principal && req.principal.sub ? req.principal.sub : undefined });
        if (!r.ok) return { present: true, ok: false, code: r.code, reason: r.reason };
        return { present: true, ok: true, claims: r.claims };
    }

    /**
     * A money route that names a person: the assertion must name the same person.
     *
     * `subject` is the person the route acts for (the payer, the subscriber, the reader). Pass
     * null when the route names nobody: there is nothing to check then.
     */
    async function person(req, subject) {
        if (!subject) return null;
        const v = await verify(req);
        if (!v.present) {
            counters.unasserted += 1;
            if (required()) fail(403, 'subject.assertion_required', "this call must carry the person's own subject assertion (X-OV-Subject-Assertion)");
            return null;
        }
        if (!v.ok) {
            counters.invalid += 1;
            if (required()) fail(403, v.code, v.reason);
            // While the flag is off a stale or broken assertion does not stop the money: the old
            // way continues, and the count says how many calls still run without one.
            (log && log.warn) ? log.warn(`[Assertions] a subject assertion was refused (${v.code}); the call continues while BILLING_REQUIRE_SUBJECT_ASSERTION is off`) : null;
            return null;
        }
        counters.asserted += 1;
        if (v.claims.sub !== subject) {
            counters.refused += 1;
            fail(403, 'subject.assertion_mismatch', `the assertion names ${v.claims.sub}, not ${subject}`);
        }
        return v.claims;
    }

    return { person, verify, counters, required, jwksUrl, audience };
}

module.exports = { createSubjectAssertion, HEADER };
