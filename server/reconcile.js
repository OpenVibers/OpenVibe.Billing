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
 * The ledger against the provider receipts it rests on:
 *   receipts.ledger         every transaction settled from a provider event names that provider and a
 *                           receipt reference, and moved exactly the receipt's cents through that
 *                           provider's clearing account (−paid for a settlement, +cents for a reversal)
 *   receipts.external       EXTERNAL receipts are never in the journal, and each announced one has
 *                           exactly one billing.receipt.external in the outbox
 *   receipts.stale          no provider receipt waits unprocessed longer than
 *                           BILLING_RECONCILE_STALE_RECEIPT_MIN while the economy is open (a provider,
 *                           Network or code failure is holding money the ledger does not show)
 * Warnings (reported, do not fail): negative user balances, unprocessed/rejected events, events and
 * transactions flagged for review (chargebacks on donated credit, unattributed site tips, EXTERNAL
 * tips on unmapped accounts), import holds. Totals exclude test transactions (ADR-012 rule 9).
 *
 * Runs on demand (API, console, scripts/reconcile.js, after an import) and on a schedule
 * (runScheduled, server/index.js); every run is stored in reconciliation_runs with its trigger.
 */
const { iso, prefixedId } = require('./ledger');
const { isFrozen } = require('./ops/common');

const SETTLING = ['purchase', 'donation', 'subscription'];
const REVERSING = ['refund', 'chargeback'];

function reconcile(ctx, { store = true, trigger = 'manual' } = {}) {
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

    const rcpt = db.prepare(`SELECT t.id, t.type, t.provider, t.receipt_ref, p.id AS event, p.provider AS event_provider,
            json_extract(t.metadata, '$.paid_cents') AS paid_cents, json_extract(t.metadata, '$.cents') AS reversed_cents,
            (SELECT COUNT(*) FROM ledger_entries e WHERE e.txn_id = t.id) AS entries,
            COALESCE((SELECT SUM(e.amount) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                WHERE e.txn_id = t.id AND a.kind = 'provider_clearing' AND a.owner_subject = p.provider), 0) AS clearing
        FROM transactions t JOIN provider_events p ON p.id = t.source_event_id`).all();
    const rcptBad = rcpt.filter((r) => {
        if (r.provider !== r.event_provider) return true;
        if (SETTLING.includes(r.type)) return !r.receipt_ref || (r.entries > 0 && r.clearing !== -Number(r.paid_cents));
        if (REVERSING.includes(r.type)) return r.entries > 0 && r.clearing !== Number(r.reversed_cents);
        return false;
    });
    check('receipts.ledger', !rcptBad.length, rcptBad.length ? { offenders: rcptBad } : { transactions: rcpt.length });

    const extBooked = db.prepare('SELECT x.receipt_ref, t.id AS txn_id FROM external_receipts x JOIN transactions t ON t.receipt_ref = x.receipt_ref').all();
    const extUnsent = db.prepare(`SELECT x.receipt_ref, x.event_id FROM external_receipts x
        WHERE x.status = 'announced' AND (x.event_id IS NULL OR NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = x.event_id))`).all();
    const extTwice = db.prepare(`SELECT json_extract(event, '$.subject.id') AS receipt_ref, COUNT(*) AS events FROM outbox
        WHERE json_extract(event, '$.event_type') = 'billing.receipt.external' GROUP BY 1 HAVING COUNT(*) > 1`).all();
    const extOffenders = [...extBooked.map((r) => ({ ...r, problem: 'booked in the journal' })), ...extUnsent.map((r) => ({ ...r, problem: 'announced without an outbox event' })),
        ...extTwice.map((r) => ({ ...r, problem: 'announced more than once' }))];
    check('receipts.external', !extOffenders.length, extOffenders.length ? { offenders: extOffenders }
        : { receipts: db.prepare('SELECT COUNT(*) AS n FROM external_receipts').get().n });

    const frozen = isFrozen(db);
    const staleMin = (ctx.config && ctx.config.reconcile && ctx.config.reconcile.staleReceiptMin) || 60;
    const stale = frozen ? [] : db.prepare('SELECT id, provider, provider_event_id, type, received_at, attempts, last_error FROM provider_events WHERE processed_at IS NULL AND received_at < ? ORDER BY id LIMIT 100')
        .all(iso(started - staleMin * 60_000));
    check('receipts.stale', !stale.length, stale.length ? { offenders: stale, older_than_min: staleMin } : { older_than_min: staleMin, ...(frozen ? { frozen: true } : {}) });

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
        external_receipts: db.prepare('SELECT COUNT(*) AS n FROM external_receipts WHERE test = 0').get().n,
        external_announced: db.prepare("SELECT COUNT(*) AS n FROM external_receipts WHERE test = 0 AND status = 'announced'").get().n,
        external_cents: db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM external_receipts WHERE test = 0').get().n,
        transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
        test_transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE test = 1').get().n,
    };

    const finished = ctx.now();
    const report = { id: prefixedId('rec', finished), ok: checks.every((c) => c.ok), trigger, started_at: iso(started), finished_at: iso(finished), checks, warnings, totals };
    if (store) {
        db.prepare('INSERT INTO reconciliation_runs (id, started_at, finished_at, ok, report) VALUES (?, ?, ?, ?, ?)')
            .run(report.id, report.started_at, report.finished_at, report.ok ? 1 : 0, JSON.stringify(report));
    }
    return report;
}

/**
 * The scheduled run (server/index.js, every BILLING_RECONCILE_INTERVAL_MS; it only reads the books, so
 * it also runs while the economy is frozen). Stored like any run; passing scheduled runs older than
 * keepDays are pruned so the table does not grow without bound — failed runs and on-demand runs stay.
 */
function runScheduled(ctx, { keepDays = 30 } = {}) {
    const report = reconcile(ctx, { trigger: 'scheduled' });
    if (keepDays > 0) {
        ctx.db.prepare("DELETE FROM reconciliation_runs WHERE ok = 1 AND json_extract(report, '$.trigger') = 'scheduled' AND finished_at < ?")
            .run(iso(ctx.now() - keepDays * 86_400_000));
    }
    const log = ctx.log || console;
    if (!report.ok) log.warn(`[Billing] scheduled reconciliation ${report.id} FAILED: ${report.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`);
    return report;
}

/** The most recent stored run (any trigger), parsed; null when none. */
function latest(db) {
    const row = db.prepare('SELECT report FROM reconciliation_runs ORDER BY finished_at DESC, id DESC LIMIT 1').get();
    return row ? JSON.parse(row.report) : null;
}

module.exports = { reconcile, runScheduled, latest };
