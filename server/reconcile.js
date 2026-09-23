'use strict';

/**
 * Reconciliation. Re-derives everything the journal promises and reports what does not hold.
 *
 * Checks (any failure makes ok=false):
 *   journal.zero_sum        all entries sum to zero per currency
 *   journal.txn_balanced    every transaction's entries sum to zero per currency
 *   balances.cache          account_balances equals SUM(entries) for every account
 *   fx.mirror               in every transaction, the usd-cents fx entry equals minus the value of
 *                           the vibes-bits fx entry at the rate that transaction recorded
 *   events.settlement       every processed provider event with effect 'settled' has exactly one
 *                           transaction pointing at it, and every other event has none
 *   payouts.references      every paid cashout has a payout reference and a settling transaction
 *   payouts.pending         payouts_pending per creator equals their requested cashouts
 * Warnings (reported, do not fail): negative user balances, unprocessed/rejected events, events and
 * transactions flagged for review (chargebacks on donated credit, unattributed site tips), import
 * holds. Totals exclude test transactions (ADR-012 rule 9).
 */
const { iso, prefixedId } = require('./ledger');

function reconcile(ctx, { store = true } = {}) {
    const { db } = ctx;
    const started = ctx.now();
    const checks = [];
    const check = (id, ok, detail) => checks.push({ id, ok, ...(detail ? { detail } : {}) });

    const sums = db.prepare('SELECT a.currency, SUM(e.amount) AS total, COUNT(*) AS n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id GROUP BY a.currency').all();
    check('journal.zero_sum', sums.every((s) => s.total === 0), { per_currency: sums.map((s) => ({ currency: s.currency, sum: s.total, entries: s.n })) });

    const unbalanced = db.prepare(`SELECT e.txn_id, a.currency, SUM(e.amount) AS total FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        GROUP BY e.txn_id, a.currency HAVING SUM(e.amount) <> 0 LIMIT 100`).all();
    check('journal.txn_balanced', !unbalanced.length, unbalanced.length ? { offenders: unbalanced } : null);

    const cache = db.prepare(`SELECT a.id, a.kind, a.owner_subject AS owner, a.currency, COALESCE(b.balance, 0) AS cached,
            COALESCE((SELECT SUM(amount) FROM ledger_entries WHERE account_id = a.id), 0) AS derived
        FROM accounts a LEFT JOIN account_balances b ON b.account_id = a.id`).all();
    const mismatches = cache.filter((r) => r.cached !== r.derived);
    check('balances.cache', !mismatches.length, mismatches.length ? { mismatches } : { accounts: cache.length });

    const fxRows = db.prepare(`SELECT t.id, json_extract(t.metadata, '$.rates.bits_per_usd') AS rate,
            SUM(CASE WHEN a.currency = 'vibes-bits' THEN e.amount ELSE 0 END) AS bits,
            SUM(CASE WHEN a.currency = 'usd-cents' THEN e.amount ELSE 0 END) AS cents
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id JOIN transactions t ON t.id = e.txn_id
        WHERE a.kind = 'fx_conversion' GROUP BY t.id`).all();
    const fxBad = fxRows.filter((r) => {
        const rate = Number(r.rate) || 100;
        const value = Math.round((Math.abs(r.bits) * 100) / rate);
        return r.cents !== (r.bits >= 0 ? -value : value);
    });
    check('fx.mirror', !fxBad.length, fxBad.length ? { offenders: fxBad } : { transactions: fxRows.length });

    const evRows = db.prepare(`SELECT p.id, p.provider, p.provider_event_id, json_extract(p.result, '$.effect') AS effect,
            (SELECT COUNT(*) FROM transactions t WHERE t.source_event_id = p.id) AS txns
        FROM provider_events p WHERE p.processed_at IS NOT NULL`).all();
    const evBad = evRows.filter((r) => (r.effect === 'settled' ? r.txns !== 1 : r.txns !== 0));
    check('events.settlement', !evBad.length, evBad.length ? { offenders: evBad } : { processed_events: evRows.length });

    const paidBad = db.prepare("SELECT id, subject, payout_reference, settle_txn FROM cashouts WHERE status = 'paid' AND (payout_reference IS NULL OR TRIM(payout_reference) = '' OR settle_txn IS NULL)").all();
    check('payouts.references', !paidBad.length, paidBad.length ? { offenders: paidBad } : null);

    const pendingBad = db.prepare(`SELECT a.owner_subject AS subject, b.balance,
            COALESCE((SELECT SUM(amount_bits) FROM cashouts c WHERE c.subject = a.owner_subject AND c.status = 'requested'), 0) AS requested
        FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'payouts_pending'`).all().filter((r) => r.balance !== r.requested);
    check('payouts.pending', !pendingBad.length, pendingBad.length ? { offenders: pendingBad } : null);

    const warnings = {
        negative_balances: db.prepare(`SELECT a.kind, a.owner_subject AS owner, a.currency, b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id
            WHERE a.kind IN ('user_credit', 'creator_payable', 'payouts_pending') AND b.balance < 0`).all(),
        unprocessed_events: db.prepare('SELECT id, provider, provider_event_id, type, received_at, attempts, last_error FROM provider_events WHERE processed_at IS NULL ORDER BY id').all(),
        rejected_events: db.prepare("SELECT id, provider, provider_event_id, type, result FROM provider_events WHERE json_extract(result, '$.effect') = 'rejected'").all()
            .map((r) => ({ ...r, result: JSON.parse(r.result) })),
        events_for_review: db.prepare("SELECT id, provider, provider_event_id, type, result FROM provider_events WHERE json_extract(result, '$.review') = 1")
            .all().map((r) => ({ ...r, result: JSON.parse(r.result) })),
        transactions_for_review: db.prepare("SELECT id, type, reverses_txn, created_at, metadata FROM transactions WHERE json_extract(metadata, '$.review') = 'required' ORDER BY created_at")
            .all().map((r) => ({ ...r, metadata: JSON.parse(r.metadata) })),
        import_holds: db.prepare('SELECT live_user_id, owner, reason, credit_bits, payable_bits FROM import_holds WHERE resolved_subject IS NULL').all(),
    };

    const sumKind = (kind, currency, excludeTest = true) => db.prepare(`SELECT COALESCE(SUM(e.amount), 0) AS n FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id JOIN transactions t ON t.id = e.txn_id
        WHERE a.kind = ? AND a.currency = ? ${excludeTest ? 'AND t.test = 0' : ''}`).get(kind, currency).n;
    const totals = {
        excludes_test_transactions: true,
        platform_revenue_cents: sumKind('platform_revenue', 'usd-cents'),
        platform_revenue_bits: sumKind('platform_revenue', 'vibes-bits'),
        refunds_cents: sumKind('refunds', 'usd-cents'),
        chargeback_loss_cents: sumKind('chargeback_loss', 'usd-cents'),
        credit_outstanding_bits: sumKind('user_credit', 'vibes-bits', false),
        payable_outstanding_bits: sumKind('creator_payable', 'vibes-bits', false),
        payouts_pending_bits: sumKind('payouts_pending', 'vibes-bits', false),
        import_adjustment_bits: sumKind('import_adjustment', 'vibes-bits', false),
        transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
        test_transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE test = 1').get().n,
    };

    const finished = ctx.now();
    const report = { id: prefixedId('rec', finished), ok: checks.every((c) => c.ok), started_at: iso(started), finished_at: iso(finished), checks, warnings, totals };
    if (store) {
        db.prepare('INSERT INTO reconciliation_runs (id, started_at, finished_at, ok, report) VALUES (?, ?, ?, ?, ?)')
            .run(report.id, report.started_at, report.finished_at, report.ok ? 1 : 0, JSON.stringify(report));
    }
    return report;
}

module.exports = { reconcile };
