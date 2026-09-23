'use strict';

/**
 * Read models for the staff console. Reads only — every change goes through server/ops/* (the same
 * functions the API uses). Provider payloads are never selected: receipts are shown by id,
 * provider, type, times, payload hash and a whitelisted part of their processing result.
 */
const { iso } = require('../ledger');

/** Outstanding balances per account kind, counting only non-test transactions (ADR-012 rule 9). */
function outstanding(db) {
    const sum = (kind, currency) => db.prepare(`SELECT COALESCE(SUM(e.amount), 0) AS n FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id JOIN transactions t ON t.id = e.txn_id
        WHERE a.kind = ? AND a.currency = ? AND t.test = 0`).get(kind, currency).n;
    return {
        credit_bits: sum('user_credit', 'vibes-bits'),
        payable_bits: sum('creator_payable', 'vibes-bits'),
        payouts_pending_bits: sum('payouts_pending', 'vibes-bits'),
        platform_revenue_cents: sum('platform_revenue', 'usd-cents'),
        chargeback_loss_cents: sum('chargeback_loss', 'usd-cents'),
        test_transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE test = 1').get().n,
    };
}

/** A stored reconciliation report reduced to what the console shows (no offender rows). */
function summarizeReport(report) {
    const count = (v) => (Array.isArray(v) ? v.length : 0);
    const offenders = (c) => {
        const d = c.detail || {};
        return count(d.offenders) + count(d.mismatches);
    };
    return {
        id: report.id, ok: !!report.ok, started_at: report.started_at, finished_at: report.finished_at,
        checks: (report.checks || []).map((c) => ({ id: c.id, ok: !!c.ok, offenders: offenders(c) })),
        warnings: Object.fromEntries(Object.entries(report.warnings || {}).map(([k, v]) => [k, count(v)])),
        totals: report.totals || {},
    };
}

function reconciliationRun(db, id) {
    const row = db.prepare('SELECT * FROM reconciliation_runs WHERE id = ?').get(id);
    return row ? summarizeReport(JSON.parse(row.report)) : null;
}
function lastReconciliation(db) {
    const row = db.prepare('SELECT * FROM reconciliation_runs ORDER BY finished_at DESC, id DESC LIMIT 1').get();
    return row ? summarizeReport(JSON.parse(row.report)) : null;
}
function reconciliationRuns(db, limit = 50) {
    return db.prepare('SELECT id, finished_at, ok, report FROM reconciliation_runs ORDER BY finished_at DESC, id DESC LIMIT ?').all(limit)
        .map((r) => {
            const s = summarizeReport(JSON.parse(r.report));
            return { id: r.id, finished_at: r.finished_at, ok: !!r.ok, failed: s.checks.filter((c) => !c.ok).map((c) => c.id) };
        });
}

/** The part of a provider event's processing result the console may show. */
function safeResult(result) {
    if (!result || typeof result !== 'object') return null;
    const out = {};
    for (const k of ['effect', 'code', 'reason', 'txn_id']) if (result[k] != null) out[k] = String(result[k]).slice(0, 300);
    if (result.review) out.review = true;
    return out;
}
const EVENT_COLUMNS = 'id, provider, provider_event_id, type, payload_hash, received_at, processed_at, result, attempts, last_error';
const eventRow = (r) => ({ ...r, result: safeResult(r.result ? JSON.parse(r.result) : null), last_error: r.last_error ? String(r.last_error).slice(0, 300) : null });

/**
 * Provider receipts needing a person: flagged for review (unattributed site tips, underpaid
 * deliveries, held site-routed tips), rejected (e.g. a delivery for an order Live already credited —
 * the double-credit refusal — or a refund for an unknown payment), stored but not processed, and
 * reversing transactions flagged review=required (chargebacks on credit already given away).
 */
function reviewQueue(db) {
    const review = db.prepare(`SELECT ${EVENT_COLUMNS} FROM provider_events WHERE json_extract(result, '$.review') = 1 ORDER BY id DESC LIMIT 200`).all().map(eventRow);
    const rejected = db.prepare(`SELECT ${EVENT_COLUMNS} FROM provider_events WHERE json_extract(result, '$.effect') = 'rejected' ORDER BY id DESC LIMIT 200`).all().map(eventRow);
    const unprocessed = db.prepare(`SELECT ${EVENT_COLUMNS} FROM provider_events WHERE processed_at IS NULL ORDER BY id LIMIT 200`).all().map(eventRow);
    const transactions = db.prepare(`SELECT id, type, reverses_txn, created_at, provider, receipt_ref, from_subject, to_subject,
            json_extract(metadata, '$.cents') AS cents, json_extract(metadata, '$.unrecovered_bits') AS unrecovered_bits,
            json_extract(metadata, '$.creator_payable_kept_bits') AS creator_payable_kept_bits
        FROM transactions WHERE json_extract(metadata, '$.review') = 'required' ORDER BY created_at DESC LIMIT 200`).all();
    return { review, rejected, unprocessed, transactions };
}

function importHolds(db) {
    return db.prepare(`SELECT live_user_id, owner, reason, credit_bits, payable_bits, resolved_subject, first_seen_at, updated_at
        FROM import_holds ORDER BY resolved_subject IS NOT NULL, live_user_id`).all();
}

const CASHOUT_TABS = {
    escrow: { label: 'In escrow', where: "status = 'requested' AND escrow_until > @now", order: 'escrow_until ASC' },
    ready: { label: 'Ready to pay', where: "status = 'requested' AND escrow_until <= @now", order: 'escrow_until ASC' },
    paid: { label: 'Paid', where: "status = 'paid'", order: 'updated_at DESC' },
    denied: { label: 'Denied', where: "status = 'denied'", order: 'updated_at DESC' },
};

function cashoutQueue(db, tab, nowMs) {
    const t = CASHOUT_TABS[tab] || CASHOUT_TABS.ready;
    return db.prepare(`SELECT id, subject, amount_bits, value_cents, status, payout_method, escrow_until, payout_provider, payout_reference, reason, created_at, updated_at
        FROM cashouts WHERE ${t.where} ORDER BY ${t.order} LIMIT 300`).all({ now: iso(nowMs) })
        .map((r) => ({ ...r, payout_method: JSON.parse(r.payout_method || '{}') }));
}

function counts(db, nowMs) {
    const now = iso(nowMs);
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    return {
        escrow: one("SELECT COUNT(*) AS n FROM cashouts WHERE status = 'requested' AND escrow_until > ?", now),
        ready: one("SELECT COUNT(*) AS n FROM cashouts WHERE status = 'requested' AND escrow_until <= ?", now),
        review_events: one("SELECT COUNT(*) AS n FROM provider_events WHERE json_extract(result, '$.review') = 1 OR json_extract(result, '$.effect') = 'rejected' OR processed_at IS NULL"),
        review_transactions: one("SELECT COUNT(*) AS n FROM transactions WHERE json_extract(metadata, '$.review') = 'required'"),
        import_holds: one('SELECT COUNT(*) AS n FROM import_holds WHERE resolved_subject IS NULL'),
    };
}

module.exports = { outstanding, summarizeReport, reconciliationRun, lastReconciliation, reconciliationRuns, reviewQueue, importHolds, cashoutQueue, counts, CASHOUT_TABS, safeResult };
