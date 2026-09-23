'use strict';

/**
 * The double-entry journal.
 *
 *   post(ctx, { type, idempotencyKey, entries: [{ kind, owner, currency, amount }], ... })
 *
 * Amounts are signed integers in minor units (bits or cents). Value moves FROM an account with a
 * negative entry TO an account with a positive entry, so an account's balance is SUM(entries):
 * a user_credit balance of 500 is 500 spendable bits; provider_clearing goes negative as money
 * arrives from a provider and positive as money leaves through it.
 *
 * Invariants (enforced here, verified again by reconcile.js):
 *   - every transaction's entries sum to zero per currency;
 *   - entries are never updated or deleted (db triggers); corrections are reversing transactions;
 *   - account_balances changes only here, in the same SQLite transaction as the entries;
 *   - a transaction's idempotency_key is unique: posting the same key again returns the
 *     original transaction and moves nothing;
 *   - every amount and every resulting balance is a safe integer (|n| <= 2^53 - 1): past that JS
 *     arithmetic silently rounds and SQLite would store a REAL, so such a posting is refused whole.
 *
 * Callers run post() inside db.transaction() together with their funds checks, so a check and
 * the movement it guards are one atomic unit.
 */
const { ids } = require('openvibe-contracts');

class BillingError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

const iso = (ms) => new Date(ms).toISOString();
const newTxnId = (ms) => `txn_${ids.ulid(ms)}`;
const prefixedId = (prefix, ms) => `${prefix}_${ids.ulid(ms)}`;

function accountId(db, { kind, owner = null, currency }, nowIso) {
    const row = db.prepare('SELECT id FROM accounts WHERE kind = ? AND owner_subject IS ? AND currency = ?').get(kind, owner, currency);
    if (row) return row.id;
    const r = db.prepare('INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES (?, ?, ?, ?)').run(kind, owner, currency, nowIso || new Date().toISOString());
    db.prepare('INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?)').run(r.lastInsertRowid, nowIso || null);
    return Number(r.lastInsertRowid);
}

/** Cached balance of an account (0 when it does not exist yet). */
function balance(db, { kind, owner = null, currency }) {
    const row = db.prepare(`SELECT b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind = ? AND a.owner_subject IS ? AND a.currency = ?`).get(kind, owner, currency);
    return row ? row.balance : 0;
}

function parseTxn(row) {
    if (!row) return null;
    return { ...row, test: !!row.test, actor: JSON.parse(row.actor || '{}'), metadata: JSON.parse(row.metadata || '{}') };
}

function entriesOf(db, txnId) {
    return db.prepare(`SELECT a.kind, a.owner_subject AS owner, a.currency, e.amount FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = ? ORDER BY a.currency, a.kind, a.owner_subject`).all(txnId);
}

function getTxn(db, id) {
    const t = parseTxn(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
    if (t) t.entries = entriesOf(db, id);
    return t;
}

function getTxnByKey(db, key) {
    const row = db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(key);
    return row ? getTxn(db, row.id) : null;
}

/**
 * Post one balanced transaction. Returns { txn, replay }.
 * Throws BillingError(500, 'ledger.unbalanced') when entries do not sum to zero per currency.
 */
function post(ctx, spec) {
    const { db } = ctx;
    const run = () => {
        if (!spec.idempotencyKey) throw new BillingError(500, 'ledger.no_key', 'every transaction needs an idempotency key');
        const existing = getTxnByKey(db, spec.idempotencyKey);
        if (existing) return { txn: existing, replay: true };
        const ms = ctx.now();
        const nowIso = iso(ms);

        // Merge entries per account and check the per-currency balance.
        const merged = new Map();
        const sums = new Map();
        for (const e of spec.entries || []) {
            if (!Number.isInteger(e.amount)) throw new BillingError(500, 'ledger.bad_amount', `non-integer amount ${e.amount}`);
            if (!Number.isSafeInteger(e.amount)) throw new BillingError(422, 'billing.amount_overflow', `amount ${e.amount} is beyond the exact integer range`);
            if (e.amount === 0) continue;
            const key = `${e.kind}|${e.owner == null ? '' : e.owner}|${e.currency}`;
            const m = merged.get(key) || { kind: e.kind, owner: e.owner == null ? null : e.owner, currency: e.currency, amount: 0 };
            m.amount += e.amount;
            merged.set(key, m);
            sums.set(e.currency, (sums.get(e.currency) || 0) + e.amount);
        }
        for (const [currency, sum] of sums) {
            if (!Number.isSafeInteger(sum)) throw new BillingError(422, 'billing.amount_overflow', `entries in ${currency} overflow the exact integer range`);
            if (sum !== 0) throw new BillingError(500, 'ledger.unbalanced', `entries sum to ${sum} ${currency}, not zero`, { entries: spec.entries });
        }

        const id = newTxnId(ms);
        db.prepare(`INSERT INTO transactions (id, type, status, idempotency_key, reverses_txn, test, actor, metadata,
                from_subject, to_subject, provider, receipt_ref, source_event_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, spec.type, spec.status || 'settled', spec.idempotencyKey, spec.reversesTxn || null, spec.test ? 1 : 0,
            JSON.stringify(spec.actor || {}), JSON.stringify(spec.metadata || {}),
            spec.fromSubject || null, spec.toSubject || null, spec.provider || null, spec.receiptRef || null,
            spec.sourceEventId || null, spec.createdAt || nowIso,
        );
        const insEntry = db.prepare('INSERT INTO ledger_entries (txn_id, account_id, amount) VALUES (?, ?, ?)');
        const bump = db.prepare('UPDATE account_balances SET balance = balance + ?, updated_at = ? WHERE account_id = ?');
        for (const m of merged.values()) {
            if (!Number.isSafeInteger(m.amount)) throw new BillingError(422, 'billing.amount_overflow', `the ${m.kind} entry overflows the exact integer range`);
            if (m.amount === 0) continue;
            if (!Number.isSafeInteger(balance(db, m) + m.amount)) {
                throw new BillingError(422, 'billing.amount_overflow', `${m.kind}${m.owner ? `:${m.owner}` : ''} would leave the exact integer range`);
            }
        }
        for (const m of merged.values()) {
            if (m.amount === 0) continue;
            const acct = accountId(db, m, nowIso);
            insEntry.run(id, acct, m.amount);
            bump.run(m.amount, nowIso, acct);
        }
        return { txn: getTxn(db, id), replay: false };
    };
    return db.inTransaction ? run() : db.transaction(run)();
}

/** Throws billing.insufficient_funds unless the account holds at least `amount`. */
function requireFunds(db, account, amount, what = 'balance') {
    const have = balance(db, account);
    if (have < amount) {
        throw new BillingError(409, 'billing.insufficient_funds', `insufficient ${what}: ${have} < ${amount} ${account.currency}`, { available: have, required: amount });
    }
    return have;
}

/** Public shape of a transaction. */
function present(txn) {
    if (!txn) return null;
    return {
        id: txn.id, type: txn.type, status: txn.status, test: !!txn.test,
        reverses_txn: txn.reverses_txn || null,
        from_subject: txn.from_subject || null, to_subject: txn.to_subject || null,
        provider: txn.provider || null, receipt_ref: txn.receipt_ref || null,
        actor: txn.actor, metadata: txn.metadata, created_at: txn.created_at,
        entries: (txn.entries || []).map((e) => ({ account: { kind: e.kind, owner: e.owner, currency: e.currency }, amount: e.amount })),
    };
}

module.exports = { BillingError, post, balance, accountId, getTxn, getTxnByKey, entriesOf, requireFunds, present, iso, prefixedId, newTxnId };
