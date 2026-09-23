'use strict';

/**
 * Import from a SNAPSHOT COPY of OpenVibe.Live's live.db (opened read-only; never the live file).
 *
 *   1. identities   every Live user id that holds a balance or appears in a money row is resolved to a
 *                   Network subject (resolve-batch). Unmapped users are never dropped: their accounts
 *                   are opened under 'hold:live:<id>' and listed in import_holds; a later run moves a
 *                   hold to the subject once the Network knows it.
 *   2. receipts     payment_orders → payment_intents (legacy_order_id) plus, for paid/credited orders, an
 *                   immutable provider_events receipt (effect 'imported'). Live's PowerChat
 *                   "direct[:renew]" / "site[:fee=N][:renew]" provider_ref values are route markers, not
 *                   references: they become route/fee/auto_renew. Real duplicate references keep the
 *                   first order's ref; the others are reported.
 *   3. history      every Live `transactions` row becomes a historical journal transaction (type
 *                   import, status imported, test=1 before site_settings.stats_vibes_reset_at).
 *   4. opening      per user, an import transaction makes the IMPORTED part of user_credit =
 *                   users.openvibe_bucks_balance and of creator_payable = users.openvibe_bucks_cashout_balance;
 *                   the difference against the replayed history is booked against import_adjustment and
 *                   listed. Billing-native movements (a legacy checkout settled here, everything after the
 *                   cutover) are never adjusted away by a later run.
 *   Orders Live credited are imported as intents settled-in-Live (no settled_txn); a later run follows
 *   an order Live credited or failed since, and settlement refuses a delivery for such an intent.
 *   5. subscriptions  → Billing subscriptions + an entitlement for the current paid period.
 *
 * Idempotent: every write is keyed (import:live:txn:<id>, legacy ids, target-state keys), so a
 * re-run over the same snapshot changes nothing, and a later snapshot (the final import at
 * cutover) only adds what changed. --dry-run does everything inside a transaction that is rolled
 * back, and stores only the report.
 */
const { post, balance, iso, prefixedId } = require('../ledger');
const { A, entry } = require('../ops/common');

const ROUTE_MARKER = /^(direct|site)(:|$)/;

const liveTs = (s) => {
    if (!s) return null;
    const str = String(s);
    const t = Date.parse(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function tableExists(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); }
function columns(db, table) { return tableExists(db, table) ? db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name) : []; }

class DryRun extends Error {}

async function importLive(ctx, { live, resolveLiveUsers, dryRun = false, log = console }) {
    const { db, rates } = ctx;
    const started = ctx.now();
    const runId = prefixedId('imp', started);
    const report = {
        run_id: runId, dry_run: !!dryRun, started_at: iso(started), source: 'openvibe-live snapshot',
        counts: {}, holds: [], duplicate_provider_refs: [], route_markers: 0, adjustments: [], unreplayable: [],
        anomalies: [], subscriptions: { imported: 0, updated: 0, skipped: [] }, new_transactions: 0,
    };

    // ── Read the snapshot ────────────────────────────────────
    const userCols = columns(live, 'users');
    const hasCashout = userCols.includes('openvibe_bucks_cashout_balance');
    const users = live.prepare(`SELECT id, username, COALESCE(openvibe_bucks_balance, 0) AS credit${hasCashout ? ', COALESCE(openvibe_bucks_cashout_balance, 0) AS payable' : ', 0 AS payable'} FROM users`).all();
    const txns = tableExists(live, 'transactions') ? live.prepare('SELECT * FROM transactions ORDER BY id').all() : [];
    const orders = tableExists(live, 'payment_orders') ? live.prepare('SELECT * FROM payment_orders ORDER BY id').all() : [];
    // A direct subscription settles only on the streamer's own PowerChat account (providers/powerchat.js).
    const pcAccount = new Map(tableExists(live, 'powerchat_connections')
        ? live.prepare('SELECT user_id, powerchat_username FROM powerchat_connections WHERE powerchat_username IS NOT NULL').all().map(r => [r.user_id, String(r.powerchat_username).toLowerCase()])
        : []);
    const subCols = columns(live, 'subscriptions');
    const subs = subCols.length ? live.prepare('SELECT * FROM subscriptions ORDER BY id').all() : [];
    let resetAt = null;
    if (tableExists(live, 'site_settings')) {
        const r = live.prepare("SELECT value FROM site_settings WHERE key = 'stats_vibes_reset_at'").get();
        if (r && r.value && !Number.isNaN(Date.parse(r.value))) resetAt = new Date(r.value).toISOString();
    }
    report.test_before = resetAt;
    report.counts.live = { users: users.length, transactions: txns.length, payment_orders: orders.length, subscriptions: subs.length };

    // ── 1. identities ────────────────────────────────────────
    const ids = new Set();
    for (const u of users) if (Math.round(u.credit) !== 0 || Math.round(u.payable) !== 0) ids.add(String(u.id));
    for (const t of txns) { if (t.from_user_id) ids.add(String(t.from_user_id)); if (t.to_user_id) ids.add(String(t.to_user_id)); }
    for (const o of orders) { ids.add(String(o.user_id)); if (o.streamer_id) ids.add(String(o.streamer_id)); }
    for (const s of subs) { ids.add(String(s.subscriber_id)); ids.add(String(s.streamer_id)); }
    // Holds from earlier runs are re-resolved too, so a newly mapped user is released.
    for (const h of db.prepare('SELECT live_user_id FROM import_holds WHERE resolved_subject IS NULL').all()) ids.add(String(h.live_user_id));
    const map = ids.size ? await resolveLiveUsers([...ids]) : new Map();
    const subjectOf = (liveId) => (liveId == null ? null : map.get(String(liveId)) || null);
    const owner = (liveId) => (liveId == null ? null : subjectOf(liveId) || `hold:live:${liveId}`);
    const username = new Map(users.map((u) => [String(u.id), u.username]));
    report.counts.identities = { resolved: [...ids].filter((i) => subjectOf(i)).length, unmapped: [...ids].filter((i) => !subjectOf(i)).length };

    const before = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const ms = ctx.now();
    const at = iso(ms);
    const snap = rates.snapshot();

    const run = () => {
        const importTxn = (spec) => post(ctx, { type: 'import', status: 'imported', actor: { principal: 'svc:billing', job: 'import-live', run: runId }, ...spec });

        // ── 2. payment_orders → intents + receipts ───────────
        const refSeen = new Map(db.prepare('SELECT provider, provider_ref, legacy_order_id FROM payment_intents WHERE provider_ref IS NOT NULL').all()
            .map((r) => [`${r.provider}|${r.provider_ref}`, r.legacy_order_id]));
        let intentsNew = 0; let receiptsNew = 0; let intentsUpdated = 0;
        for (const o of orders) {
            const existing = db.prepare('SELECT id, status, settled_txn FROM payment_intents WHERE legacy_order_id = ?').get(o.id);
            if (existing && !existing.settled_txn) {
                // Live moved the order on since an earlier run (credited or failed after the shadow
                // import): follow it, so a later delivery of a Live-credited order is recognised as
                // settled-in-Live (intents.settledInLive) instead of settling a second time. An intent
                // Billing settled itself (settled_txn) is never rewound.
                const want = o.status === 'credited' ? 'settled' : (o.status === 'failed' && ['created', 'expired'].includes(existing.status) ? 'failed' : null);
                if (want && existing.status !== want && existing.status !== 'settled') {
                    db.prepare('UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ?').run(want, at, existing.id);
                    intentsUpdated++;
                }
            }
            const legacy = { status: o.status, provider_ref: o.provider_ref, bucks: o.bucks, amount_cents: o.amount_cents, user_id: o.user_id, streamer_id: o.streamer_id };
            if (!existing) {
                let ref = o.provider_ref || null;
                let route = null; let fee = 0; let renew = 0;
                const meta = { legacy_live_order: legacy, rates: snap };
                if (o.provider === 'powerchat' && ref && ROUTE_MARKER.test(ref)) {
                    route = ref.split(':')[0];
                    fee = Number((ref.match(/:fee=(\d+)/) || [])[1] || 0);
                    renew = /:renew$/.test(ref) ? 1 : 0;
                    if (route === 'direct' && pcAccount.has(o.streamer_id)) meta.receiving_account = pcAccount.get(o.streamer_id);
                    ref = null;
                    report.route_markers++;
                }
                if (ref) {
                    const k = `${o.provider}|${ref}`;
                    if (refSeen.has(k)) {
                        report.duplicate_provider_refs.push({ provider: o.provider, provider_ref: ref, order: o.id, kept_on_order: refSeen.get(k) });
                        meta.duplicate_of_order = refSeen.get(k);
                        ref = null;
                    } else refSeen.set(k, o.id);
                }
                const created = liveTs(o.created_at) || at;
                const stale = Date.parse(created) < ms - 3 * 86_400_000;
                const status = o.status === 'credited' ? 'settled' : o.status === 'failed' ? 'failed' : (o.status === 'pending' && stale ? 'expired' : 'created');
                if (o.status === 'paid') report.anomalies.push({ kind: 'order_paid_not_credited', order: o.id, provider: o.provider, amount_cents: o.amount_cents });
                db.prepare(`INSERT INTO payment_intents (id, provider, provider_ref, kind, subject, streamer_subject, amount_cents, fee_cents, bits, route, auto_renew,
                        status, legacy_order_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(prefixedId('pi', Date.parse(created)), o.provider, ref, o.kind === 'subscription' ? 'subscription' : 'purchase', owner(o.user_id),
                        o.streamer_id ? owner(o.streamer_id) : null, o.amount_cents || 0, fee, o.bucks || 0, route, renew, status, o.id, JSON.stringify(meta), created, at);
                intentsNew++;
            }
            if (o.status === 'credited' || o.status === 'paid') {
                const payload = JSON.stringify(o);
                const r = db.prepare(`INSERT OR IGNORE INTO provider_events (provider, provider_event_id, type, payload_hash, payload, received_at, processed_at, result, attempts)
                    VALUES (?, ?, 'live.payment_order', ?, ?, ?, ?, ?, 0)`).run(o.provider, `live-order:${o.id}`,
                    require('crypto').createHash('sha256').update(payload).digest('hex'), payload, liveTs(o.updated_at || o.created_at) || at, at,
                    JSON.stringify({ effect: 'imported', live_order: o.id, live_status: o.status }));
                receiptsNew += r.changes;
            }
        }
        report.counts.intents_new = intentsNew;
        report.counts.intents_updated = intentsUpdated;
        report.counts.receipts_new = receiptsNew;

        // ── 3. history ───────────────────────────────────────
        const openCashout = (t, liveTxn, status) => {
            if (db.prepare('SELECT 1 FROM cashouts WHERE legacy_live_txn = ?').get(liveTxn.id)) return;
            const created = liveTs(liveTxn.created_at) || at;
            const subject = owner(liveTxn.from_user_id);
            db.prepare(`INSERT INTO cashouts (id, subject, amount_bits, value_cents, status, payout_method, escrow_until, request_txn, settle_txn,
                    payout_provider, payout_reference, reason, legacy_live_txn, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(prefixedId('co', Date.parse(created)), subject, liveTxn.amount, rates.valueCents(liveTxn.amount), status,
                    JSON.stringify({ type: 'paypal', legacy_message: liveTxn.message || null }),
                    iso(Date.parse(created) + rates.escrowDays * 86_400_000), t.id, status === 'requested' ? null : t.id,
                    status === 'paid' ? 'paypal' : null, status === 'paid' ? `live-import:unrecorded:${liveTxn.id}` : null,
                    status === 'denied' ? 'denied on Live' : null, liveTxn.id, created, at);
            if (status === 'paid') report.anomalies.push({ kind: 'paid_cashout_without_provider_reference', live_txn: liveTxn.id, amount_bits: liveTxn.amount });
        };
        let historyNew = 0;
        for (const t of txns) {
            const a = Math.round(Number(t.amount) || 0);
            const from = owner(t.from_user_id);
            const to = owner(t.to_user_id);
            const created = liveTs(t.created_at) || at;
            const test = !!(resetAt && created < resetAt);
            const money = (bits) => [entry(A.fxBits(), -bits), entry(A.fxCents(), rates.valueCents(bits)), entry(A.clearing('live-legacy'), -rates.valueCents(bits))];
            let entries = [];
            let note = null;
            const moved = t.status === 'completed' || (t.type === 'cashout' && t.status === 'escrow');
            if (a <= 0) note = 'non-positive amount';
            else if (!moved && !(t.type === 'cashout' && t.status === 'refunded')) note = `status ${t.status}: no balance moved`;
            else if (t.type === 'purchase' && to) entries = [...money(a), entry(A.credit(to), a)];
            else if (t.type === 'donation' && to) entries = from ? [entry(A.credit(from), -a), entry(A.payable(to), a)] : [...money(a), entry(A.payable(to), a)];
            else if (t.type === 'cashout' && from) {
                if (t.status === 'escrow') entries = [entry(A.payable(from), -a), entry(A.pending(from), a)];
                else if (t.status === 'completed') entries = [entry(A.payable(from), -a), entry(A.fxBits(), a), entry(A.fxCents(), -rates.valueCents(a)), entry(A.clearing('paypal_payouts'), rates.valueCents(a))];
                else entries = []; // refunded (denied): requested and returned — nets to nothing
            } else if (t.type === 'refund' && from && to) entries = [entry(A.payable(from), -a), entry(A.credit(to), a)];
            else if (t.type === 'bonus' && to) entries = [entry(A.revenue('vibes-bits'), -a), entry(A.credit(to), a)];
            else if (t.type === 'recycle' && from) entries = [entry(A.payable(from), -a), entry(A.credit(from), a)];
            else note = `unreplayable ${t.type} (from ${t.from_user_id || '-'}, to ${t.to_user_id || '-'})`;
            if (note) report.unreplayable.push({ live_txn: t.id, type: t.type, status: t.status, amount: t.amount, reason: note });
            const r = importTxn({
                idempotencyKey: `import:live:txn:${t.id}`, entries, test, createdAt: created,
                fromSubject: t.from_user_id ? subjectOf(t.from_user_id) : null, toSubject: t.to_user_id ? subjectOf(t.to_user_id) : null,
                metadata: { live: { id: t.id, type: t.type, status: t.status, amount: t.amount, from_user_id: t.from_user_id, to_user_id: t.to_user_id, stream_id: t.stream_id, message: t.message }, note, rates: snap },
            });
            if (!r.replay) {
                historyNew++;
                if (t.type === 'cashout' && from && a > 0) openCashout(r.txn, t, t.status === 'escrow' ? 'requested' : t.status === 'completed' ? 'paid' : t.status === 'refunded' ? 'denied' : null);
            }
        }
        report.counts.history_new = historyNew;

        // ── 4. opening balances ──────────────────────────────
        const upsertHold = db.prepare(`INSERT INTO import_holds (live_user_id, owner, reason, credit_bits, payable_bits, first_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (live_user_id) DO UPDATE SET credit_bits = excluded.credit_bits, payable_bits = excluded.payable_bits, updated_at = excluded.updated_at`);
        const byId = new Map(users.map((u) => [String(u.id), u]));
        // What the imports themselves put in an account (history, earlier opening balances, released
        // holds) — the part the Live column describes. Anything Billing did natively (a legacy checkout
        // that settled here, and everything after the cutover) is not Live's to overwrite, so a later
        // run (a hold release, a late snapshot) never books an adjustment against it.
        const importedStmt = db.prepare(`SELECT COALESCE(SUM(e.amount), 0) AS n FROM ledger_entries e
            JOIN accounts a ON a.id = e.account_id JOIN transactions t ON t.id = e.txn_id
            WHERE a.kind = ? AND a.owner_subject IS ? AND a.currency = ? AND t.type = 'import'`);
        const imported = (acct) => importedStmt.get(acct.kind, acct.owner, acct.currency).n;
        const openingIds = new Set([...ids].filter((i) => byId.has(i)));
        for (const i of openingIds) {
            const u = byId.get(i);
            const subject = subjectOf(i);
            const own = owner(i);
            const hold = `hold:live:${i}`;
            // A user the Network now knows: move what an earlier run parked on the hold.
            if (subject) {
                for (const [acct, name] of [[A.credit, 'user_credit'], [A.payable, 'creator_payable'], [A.pending, 'payouts_pending']]) {
                    const held = balance(db, acct(hold));
                    if (held !== 0) {
                        importTxn({ idempotencyKey: `import:release-hold:${runId}:${i}:${name}`, entries: [entry(acct(hold), -held), entry(acct(subject), held)], metadata: { release_hold: i, account: name, amount: held, rates: snap } });
                    }
                }
                db.prepare('UPDATE cashouts SET subject = ? WHERE subject = ?').run(subject, hold);
                db.prepare('UPDATE import_holds SET resolved_subject = ?, updated_at = ? WHERE live_user_id = ? AND resolved_subject IS NULL').run(subject, at, Number(i));
            }
            for (const [acct, name, raw] of [[A.credit, 'user_credit', u.credit], [A.payable, 'creator_payable', u.payable]]) {
                const target = Math.round(Number(raw) || 0);
                if (target !== Number(raw)) report.anomalies.push({ kind: 'fractional_balance', live_user_id: u.id, account: name, value: raw, imported_as: target });
                const current = imported(acct(own));
                const d = target - current;
                if (d !== 0) {
                    importTxn({
                        idempotencyKey: `import:opening:${runId}:${own}:${name}`,
                        entries: [entry(acct(own), d), entry(A.importAdj('vibes-bits'), -d)],
                        fromSubject: null, toSubject: subject,
                        metadata: { opening_balance: { live_user_id: u.id, account: name, replayed_history: current, live_column: target, adjustment: d }, rates: snap },
                    });
                    report.adjustments.push({ live_user_id: u.id, username: u.username, subject, account: name, replayed_history: current, live_column: target, adjustment: d });
                }
            }
            if (!subject) {
                upsertHold.run(Number(i), hold, 'no Network subject for this Live user (resolve-batch returned null)', Math.round(u.credit), Math.round(u.payable), at, at);
                report.holds.push({ live_user_id: u.id, username: u.username, credit_bits: Math.round(u.credit), payable_bits: Math.round(u.payable) });
            }
        }
        // Unmapped ids that only appear in money rows (no users row left) are held too.
        for (const i of ids) {
            if (!subjectOf(i) && !byId.has(i)) {
                upsertHold.run(Number(i), `hold:live:${i}`, 'no Live users row and no Network subject', 0, 0, at, at);
                report.holds.push({ live_user_id: Number(i), username: null, credit_bits: 0, payable_bits: 0, note: 'no users row' });
            }
        }

        // ── 5. subscriptions → entitlements ──────────────────
        for (const s of subs) {
            const subscriber = subjectOf(s.subscriber_id);
            const streamer = subjectOf(s.streamer_id);
            if (!subscriber || !streamer) { report.subscriptions.skipped.push({ live_sub: s.id, reason: 'unmapped subscriber or streamer (held)' }); continue; }
            const end = liveTs(s.current_period_end || s.expires_at);
            const liveStatus = String(s.status || (s.is_active ? 'active' : 'expired'));
            const status = liveStatus === 'active' && end && Date.parse(end) > ms ? 'active' : (liveStatus === 'canceled' ? 'canceled' : (liveStatus === 'active' && !end ? 'active' : 'expired'));
            const provider = s.provider === 'bucks' ? 'credit' : (s.provider || 'legacy');
            const existing = db.prepare('SELECT * FROM subscriptions WHERE legacy_live_id = ?').get(s.id);
            let subId;
            if (existing) {
                subId = existing.id;
                const changed = existing.status !== status || existing.current_period_end !== end || !!existing.auto_renew !== !!s.auto_renew || !!existing.cancel_at_period_end !== !!s.cancel_at_period_end;
                if (changed) {
                    db.prepare('UPDATE subscriptions SET status = ?, current_period_end = ?, auto_renew = ?, cancel_at_period_end = ?, updated_at = ? WHERE id = ?')
                        .run(status, end, s.auto_renew ? 1 : 0, s.cancel_at_period_end ? 1 : 0, at, subId);
                    report.subscriptions.updated++;
                }
            } else {
                if (db.prepare('SELECT 1 FROM subscriptions WHERE subscriber = ? AND streamer = ?').get(subscriber, streamer)) {
                    report.subscriptions.skipped.push({ live_sub: s.id, reason: 'a Billing subscription for this pair already exists' });
                    continue;
                }
                subId = prefixedId('sub', Date.parse(liveTs(s.created_at || s.started_at) || at));
                db.prepare(`INSERT INTO subscriptions (id, subscriber, streamer, tier, provider, provider_ref, route, status, auto_renew, cancel_at_period_end,
                        price_cents, current_period_end, legacy_live_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(subId, subscriber, streamer, s.tier || 1, provider, s.provider_ref || null, status, s.auto_renew ? 1 : 0, s.cancel_at_period_end ? 1 : 0,
                        s.price_cents || 0, end, s.id, liveTs(s.created_at || s.started_at) || at, at);
                report.subscriptions.imported++;
            }
            // Entitlement for the paid period Live shows, extended when a later snapshot extends it.
            if (status !== 'expired' && end && Date.parse(end) > ms) {
                const covered = db.prepare("SELECT MAX(ends_at) AS e FROM entitlements WHERE subscription_id = ? AND revoked_at IS NULL").get(subId).e;
                if (!covered || covered < end) {
                    const start = covered && covered > at ? covered : (liveTs(s.started_at || s.created_at) || at);
                    db.prepare(`INSERT INTO entitlements (id, subject, kind, scope, subscription_id, starts_at, ends_at, source_txn, created_at)
                        VALUES (?, ?, 'channel_subscription', ?, ?, ?, ?, NULL, ?)`).run(prefixedId('ent', ms), subscriber, streamer, subId, start < end ? start : at, end, at);
                }
            }
        }

        report.new_transactions = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n - before;
        if (dryRun) throw new DryRun();
    };

    try { db.transaction(run)(); }
    catch (e) { if (!(e instanceof DryRun)) throw e; }

    report.finished_at = iso(ctx.now());
    report.usernames_held = report.holds.map((h) => h.username || username.get(String(h.live_user_id)) || null);
    db.prepare('INSERT INTO import_runs (id, source, dry_run, started_at, finished_at, report) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, 'live', dryRun ? 1 : 0, report.started_at, report.finished_at, JSON.stringify(report));
    log.log && log.log(`[Billing] import ${runId}${dryRun ? ' (dry run, rolled back)' : ''}: ${report.new_transactions} new transactions, ${report.adjustments.length} opening adjustments, ${report.holds.length} holds, ${report.duplicate_provider_refs.length} duplicate refs`);
    return report;
}

module.exports = { importLive, liveTs };
