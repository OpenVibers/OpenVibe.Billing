'use strict';

/**
 * The plain words for a ledger row. The list and the formatter live in openvibe-contracts
 * (`billing.money-reason@1`, `lib/money-reasons.js`); Billing re-exports them when the installed
 * package has them and otherwise answers from the same list copied at 0.392.0. One site never
 * builds the sentence itself: every read here returns `{ label, subject }` already made.
 */
let canonical = null;
try { canonical = require('openvibe-contracts').moneyReasons || null; } catch { /* an older contract package: the copy below answers */ }
const reasons = canonical || require('./reasons-list');

/** Log an undeclared key once per process: support can see it, a person never does. */
const unknown = new Set();
function describe(key, options) {
    const d = reasons.describe(key, options);
    if (!d.known && d.key && !unknown.has(d.key)) {
        unknown.add(d.key);
        console.warn(`[Money] undeclared reason key ${JSON.stringify(d.key.slice(0, 120))} — reads "${d.text}"`);
    }
    return d;
}

module.exports = { ...reasons, describe, describeRow: (row, options) => describe(row && (row.reason != null ? row.reason : row.reason_key), options) };
