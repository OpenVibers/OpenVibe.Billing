'use strict';

/**
 * Idempotency-Key handling for every mutating call.
 *
 * The key is scoped to the calling principal. The first successful (2xx) response is stored with
 * a hash of the request; a replay with the same key and the same request returns that response
 * verbatim (header Idempotent-Replayed: true) and moves nothing. The same key with a different
 * request is refused (422 idempotency.key_reused). Refusals (4xx/5xx) are not stored, so a caller
 * may retry a refused operation with the same key once the cause is fixed.
 *
 * The key also becomes the journal transaction's idempotency_key (api:<principal>:<key>), whose
 * UNIQUE constraint is the second line of defence.
 */
const crypto = require('crypto');
const { http } = require('openvibe-contracts');

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

function idempotent(db, now) {
    return function idempotencyKey(req, res, next) {
        const key = req.get('Idempotency-Key');
        if (!key || !KEY_RE.test(key)) {
            return http.sendProblem(res, 400, 'idempotency.key_required', { detail: 'mutating calls need an Idempotency-Key header (8-200 of A-Z a-z 0-9 . _ : -)', ctx: req.ov });
        }
        const scoped = `${req.principal.sub}:${key}`;
        const hash = crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${stable(req.body || {})}`).digest('hex');
        const row = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(scoped);
        if (row) {
            if (row.request_hash !== hash) {
                return http.sendProblem(res, 422, 'idempotency.key_reused', { detail: 'this Idempotency-Key was used for a different request', ctx: req.ov });
            }
            res.setHeader('Idempotent-Replayed', 'true');
            return res.status(row.status).json(JSON.parse(row.response));
        }
        req.idempotencyKey = `api:${scoped}`;
        const json = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, request_hash, method, path, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .run(scoped, hash, req.method, `${req.baseUrl}${req.path}`, res.statusCode, JSON.stringify(body), new Date(now()).toISOString());
            }
            return json(body);
        };
        return next();
    };
}

module.exports = { idempotent, stable };
