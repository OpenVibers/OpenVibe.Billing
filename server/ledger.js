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
 *   - account_balances changes only here, in the same transaction as the entries;
 *   - a transaction's idempotency_key is unique: posting the same key again returns the
 *     original transaction and moves nothing;
 *   - every amount and every resulting balance is a safe integer (|n| <= 2^53 - 1): past that JS
 *     arithmetic silently rounds (and the bigint columns would refuse it), so such a posting is refused whole.
 *
 * Callers run post() inside money() (a serializable transaction) together with their funds checks, so a check and
 * the movement it guards are one atomic unit.
 */
const { ids } = require('openvibe-contracts');
const { enqueue } = require('./outbox');

const NANO_USD = 'nano-usd';
const isBigCurrency = (currency) => currency === NANO_USD;
const PG_BIGINT_MAX = 9223372036854775807n;

/** Parse a bigint column value (returned as text via ::text) into the right JS type for its currency. */
function parseMoney(value, currency) {
    if (value == null) return isBigCurrency(currency) ? 0n : 0;
    if (isBigCurrency(currency)) return BigInt(String(value));
    return Number(value);
}

/** Zero value matching the currency's numeric type. */
function zeroFor(currency) { return isBigCurrency(currency) ? 0n : 0; }

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

async function accountId(db, { kind, owner = null, currency }, nowIso) {
    const row = await db.prepare('SELECT id FROM accounts WHERE kind = ? AND owner_subject IS NOT DISTINCT FROM ? AND currency = ?').get(kind, owner, currency);
    if (row) return row.id;
    const r = await db.prepare('INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES (?, ?, ?, ?) RETURNING id').run(kind, owner, currency, nowIso || new Date().toISOString());
    await db.prepare('INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?)').run(r.lastInsertRowid, nowIso || null);
    return Number(r.lastInsertRowid);
}

/** Cached balance of an account (0 when it does not exist yet). Returns BigInt for nano-usd, Number otherwise. */
async function balance(db, { kind, owner = null, currency }) {
    const row = await db.prepare(`SELECT b.balance::text AS balance FROM accounts a JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind = ? AND a.owner_subject IS NOT DISTINCT FROM ? AND a.currency = ?`).get(kind, owner, currency);
    return parseMoney(row ? row.balance : null, currency);
}

function parseTxn(row) {
    if (!row) return null;
    return { ...row, test: !!row.test, actor: JSON.parse(row.actor || '{}'), metadata: JSON.parse(row.metadata || '{}') };
}

async function entriesOf(db, txnId) {
    const rows = await db.prepare(`SELECT a.kind, a.owner_subject AS owner, a.currency, e.amount::text AS amount FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = ? ORDER BY a.currency, a.kind, a.owner_subject`).all(txnId);
    return rows.map((r) => ({ kind: r.kind, owner: r.owner, currency: r.currency, amount: parseMoney(r.amount, r.currency) }));
}

async function getTxn(db, id) {
    const t = parseTxn(await db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
    if (t) t.entries = await entriesOf(db, id);
    return t;
}

async function getTxnByKey(db, key) {
    const row = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(key);
    return row ? await getTxn(db, row.id) : null;
}

/**
 * Post one balanced transaction. Returns { txn, replay }.
 * Throws BillingError(500, 'ledger.unbalanced') when entries do not sum to zero per currency.
 */
async function post(ctx, spec) {
    const { db } = ctx;
    const run = async () => {
        if (!spec.idempotencyKey) throw new BillingError(500, 'ledger.no_key', 'every transaction needs an idempotency key');
        const existing = await getTxnByKey(db, spec.idempotencyKey);
        if (existing) return { txn: existing, replay: true };
        const ms = ctx.now();
        const nowIso = iso(ms);

        // Merge entries per account and check the per-currency balance.
        const merged = new Map();
        const sums = new Map();
        for (const e of spec.entries || []) {
            const isBig = typeof e.amount === 'bigint';
            if (isBigCurrency(e.currency)) {
                if (!isBig) throw new BillingError(500, 'ledger.bad_amount', `${e.currency} amounts must be BigInt`);
                if (e.amount > PG_BIGINT_MAX || e.amount < -PG_BIGINT_MAX) throw new BillingError(422, 'billing.amount_overflow', `amount ${e.amount} ${e.currency} does not fit in the ledger column`);
            } else {
                if (isBig) throw new BillingError(500, 'ledger.bad_amount', `${e.currency} amounts must be Number`);
                if (!Number.isInteger(e.amount)) throw new BillingError(500, 'ledger.bad_amount', `non-integer amount ${e.amount}`);
                if (!Number.isSafeInteger(e.amount)) throw new BillingError(422, 'billing.amount_overflow', `amount ${e.amount} is beyond the exact integer range`);
            }
            if (e.amount == 0) continue; // loose: 0n == 0
            const key = `${e.kind}|${e.owner == null ? '' : e.owner}|${e.currency}`;
            const m = merged.get(key) || { kind: e.kind, owner: e.owner == null ? null : e.owner, currency: e.currency, amount: zeroFor(e.currency) };
            m.amount += e.amount;
            merged.set(key, m);
            const curSum = sums.get(e.currency) ?? zeroFor(e.currency);
            sums.set(e.currency, curSum + e.amount);
        }
        for (const [currency, sum] of sums) {
            if (isBigCurrency(currency)) {
                if (typeof sum !== 'bigint') throw new BillingError(500, 'ledger.unbalanced', `entries in ${currency} are not all BigInt`, { entries: spec.entries });
                if (sum !== 0n) throw new BillingError(500, 'ledger.unbalanced', `entries sum to ${sum} ${currency}, not zero`, { entries: spec.entries });
            } else {
                if (!Number.isSafeInteger(sum)) throw new BillingError(422, 'billing.amount_overflow', `entries in ${currency} overflow the exact integer range`);
                if (sum !== 0) throw new BillingError(500, 'ledger.unbalanced', `entries sum to ${sum} ${currency}, not zero`, { entries: spec.entries });
            }
        }

        const id = newTxnId(ms);
        await db.prepare(`INSERT INTO transactions (id, type, status, idempotency_key, reverses_txn, test, actor, metadata,
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
            const isBig = isBigCurrency(m.currency);
            if (!isBig && !Number.isSafeInteger(m.amount)) throw new BillingError(422, 'billing.amount_overflow', `the ${m.kind} entry overflows the exact integer range`);
            if (m.amount == 0) continue;
            const have = await balance(db, m);
            const would = have + m.amount;
            if (isBig) {
                if (would > PG_BIGINT_MAX || would < -PG_BIGINT_MAX) throw new BillingError(422, 'billing.amount_overflow', `${m.kind}${m.owner ? `:${m.owner}` : ''} would leave the bigint range`);
            } else if (!Number.isSafeInteger(would)) {
                throw new BillingError(422, 'billing.amount_overflow', `${m.kind}${m.owner ? `:${m.owner}` : ''} would leave the exact integer range`);
            }
        }
        for (const m of merged.values()) {
            if (m.amount == 0) continue;
            const acct = await accountId(db, m, nowIso);
            await insEntry.run(id, acct, m.amount);
            await bump.run(m.amount, nowIso, acct);
        }
        // Ask 273: one subject-visible message per person whose Vibes moved, in the same transaction
        // as the movement, so an open page updates without a reload. Non-Vibes and non-person entries
        // (provider clearing, revenue, project accounts) announce nothing here.
        if (ctx.outbox) {
            const perUser = new Map();
            for (const m of merged.values()) {
                if (m.amount == 0 || m.currency !== 'vibes-bits') continue;
                if (m.kind !== 'user_credit' && m.kind !== 'creator_payable') continue;
                if (!ids.isSubjectId('user', m.owner)) continue;
                perUser.set(m.owner, (perUser.get(m.owner) || 0) + m.amount);
            }
            for (const [owner, delta] of perUser) {
                if (delta == 0) continue;
                await enqueue(ctx, {
                    event_type: 'billing.balance.changed',
                    subject: { type: 'user', id: owner },
                    visibility: 'subject',
                    payload: {
                        currency: 'vibes', delta,
                        credit: await balance(db, { kind: 'user_credit', owner, currency: 'vibes-bits' }),
                        payable: await balance(db, { kind: 'creator_payable', owner, currency: 'vibes-bits' }),
                        txn: id, type: spec.type,
                    },
                });
            }
        }
        return { txn: await getTxn(db, id), replay: false };
    };
    return db.inTransaction() ? await run() : await money(db, run);
}

/**
 * Money moves in a serializable transaction (openvibe-sdk/db retries it on a serialization failure or deadlock): the
 * funds checks and the entries they allow commit together or not at all, whatever runs beside them. A replayed
 * idempotency key finds the first transaction on the retry. fn is database work only (it may run more than once).
 */
async function money(db, fn) {
    return await db.tx(fn, { isolation: 'serializable' });
}

/** Throws billing.insufficient_funds unless the account holds at least `amount`. */
async function requireFunds(db, account, amount, what = 'balance') {
    const have = await balance(db, account);
    if (have < amount) {
        const extra = isBigCurrency(account.currency) ? { available: String(have), required: String(amount) } : { available: have, required: amount };
        throw new BillingError(409, 'billing.insufficient_funds', `insufficient ${what}: ${have} < ${amount} ${account.currency}`, extra);
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
        entries: (txn.entries || []).map((e) => ({ account: { kind: e.kind, owner: e.owner, currency: e.currency }, amount: isBigCurrency(e.currency) ? String(e.amount) : e.amount })),
    };
}

module.exports = { BillingError, money, post, balance, accountId, getTxn, getTxnByKey, entriesOf, requireFunds, present, iso, prefixedId, newTxnId };
