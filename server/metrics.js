'use strict';

/**
 * Prometheus metrics (roadmap Track O): the openvibe-shared registry that app.js instruments with the
 * HTTP golden signals, process metrics and release_info, plus Billing's own gauges, read from the
 * database at scrape time. GET /metrics answers direct loopback callers only (a request nginx relayed
 * carries X-Real-IP and gets 404). No gauge carries a subject, an amount per person or a provider
 * payload — only counts and platform totals.
 *
 *   billing_frozen                                   1 while the economy is frozen
 *   billing_authority{authority}                     1 for the configured BILLING_AUTHORITY (live | billing)
 *   billing_provider_events{provider,state}          stored receipts: pending | settled | external |
 *                                                    rejected | review | other
 *   billing_provider_event_oldest_pending_seconds    age of the oldest unprocessed receipt (0 when none)
 *   billing_external_receipts{status}                EXTERNAL receipts: announced | not_announced
 *   billing_outbox_pending                           events not yet relayed to OpenVibe.Events
 *   billing_outbox_failing                           unsent events whose last relay attempt failed
 *   billing_cashouts{status}                         requested | paid | denied
 *   billing_reconciliation_ok                        1 when the latest stored run passed, 0 when it failed
 *   billing_reconciliation_last_run_timestamp_seconds  when the latest stored run finished
 *   billing_reconciliation_failed_checks             failed checks in the latest stored run
 */
const { createRegistry } = require('openvibe-shared/metrics');
const { isFrozen } = require('./ops/common');
const { latest } = require('./reconcile');

function createMetrics({ db, config, now = () => Date.now() }) {
    const registry = createRegistry();
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;

    registry.gauge({ name: 'billing_frozen', help: 'Whether the economy is frozen (1) or open (0)', collect: () => (isFrozen(db) ? 1 : 0) });
    registry.gauge({
        name: 'billing_authority', help: 'The configured money authority (BILLING_AUTHORITY); the value is always 1', labelNames: ['authority'],
        collect: () => [{ labels: { authority: config.authority }, value: 1 }],
    });
    registry.gauge({
        name: 'billing_provider_events', help: 'Stored provider receipts by provider and processing state', labelNames: ['provider', 'state'],
        collect: () => db.prepare(`SELECT provider, CASE
                WHEN processed_at IS NULL THEN 'pending'
                WHEN json_extract(result, '$.effect') = 'rejected' THEN 'rejected'
                WHEN json_extract(result, '$.review') = 1 THEN 'review'
                WHEN json_extract(result, '$.effect') IN ('settled', 'external') THEN json_extract(result, '$.effect')
                ELSE 'other' END AS state, COUNT(*) AS n
            FROM provider_events GROUP BY 1, 2`).all().map((r) => ({ labels: { provider: r.provider, state: r.state }, value: r.n })),
    });
    registry.gauge({
        name: 'billing_provider_event_oldest_pending_seconds', help: 'Age of the oldest stored-but-unprocessed provider receipt (0 when none)',
        collect: () => {
            const r = db.prepare('SELECT MIN(received_at) AS at FROM provider_events WHERE processed_at IS NULL').get();
            return r && r.at ? Math.max(0, Math.round((now() - Date.parse(r.at)) / 1000)) : 0;
        },
    });
    registry.gauge({
        name: 'billing_external_receipts', help: 'EXTERNAL receipts (tips on a streamer\'s own provider account) by announcement status', labelNames: ['status'],
        collect: () => ['announced', 'not_announced'].map((status) => ({ labels: { status }, value: one('SELECT COUNT(*) AS n FROM external_receipts WHERE status = ?', status) })),
    });
    registry.gauge({ name: 'billing_outbox_pending', help: 'Outbox events not yet relayed to OpenVibe.Events', collect: () => one('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL') });
    registry.gauge({ name: 'billing_outbox_failing', help: 'Unsent outbox events whose last relay attempt failed', collect: () => one('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL AND last_error IS NOT NULL') });
    registry.gauge({
        name: 'billing_cashouts', help: 'Cashouts by status', labelNames: ['status'],
        collect: () => ['requested', 'paid', 'denied'].map((status) => ({ labels: { status }, value: one('SELECT COUNT(*) AS n FROM cashouts WHERE status = ?', status) })),
    });
    // The latest stored reconciliation (scheduled or on demand). No run yet: the gauges are left out.
    registry.gauge({ name: 'billing_reconciliation_ok', help: 'Whether the latest stored reconciliation passed (1) or failed (0)', collect: () => { const r = latest(db); return r ? (r.ok ? 1 : 0) : undefined; } });
    registry.gauge({ name: 'billing_reconciliation_last_run_timestamp_seconds', help: 'When the latest stored reconciliation finished (Unix seconds)', collect: () => { const r = latest(db); return r ? Math.round(Date.parse(r.finished_at) / 1000) : undefined; } });
    registry.gauge({ name: 'billing_reconciliation_failed_checks', help: 'Failed checks in the latest stored reconciliation', collect: () => { const r = latest(db); return r ? r.checks.filter((c) => !c.ok).length : undefined; } });

    return { registry };
}

module.exports = { createMetrics };
