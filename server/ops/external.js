'use strict';

/**
 * EXTERNAL receipts (ADR-012): a tip paid on a streamer's OWN provider account (PowerChat route
 * `direct`). The money never touches OpenVibe, so there is no journal entry and no liability — but
 * the tip still has to be celebrated where the streamer is live. Until the cutover OpenVibe.Live did
 * that from its own PowerChat webhook; once the webhook points here, Billing announces it:
 *
 *   billing.receipt.external   subject { type: 'provider_receipt', id: '<provider>:<payment id>' }
 *   payload {
 *     classification: 'EXTERNAL', provider, receipt_ref, provider_event_id (the provider's id of the
 *     payment, stable across redeliveries), delivery_id (the webhook delivery that carried it),
 *     streamer: SubjectRef, receiving_account: { provider, id, username },
 *     amount_cents, currency: 'usd-cents', value_bits (at Billing's value rate — what Live counted
 *     toward goals), donor_name (null when anonymous), anonymous, message, app_ref, app_purpose,
 *     occurred_at, test, rates
 *   }
 *
 * OpenVibe.Tips consumes it (the chat line through Live's /internal/tips/deliveries, the overlay
 * alert, goal progress). Written to the outbox in the same SQLite transaction that marks the
 * provider event processed.
 *
 * Announced at most once per payment: external_receipts is keyed by receipt_ref, so a redelivery
 * under a new delivery id is 'duplicate_receipt'. Announced only when
 *   - BILLING_AUTHORITY=billing. While Live is the authority it receives the webhook and announces
 *     the tip itself; a delivery that reaches Billing then (a test, a manual resend) is recorded
 *     'not_announced' so nothing is celebrated twice;
 *   - the receiving account belongs to a known creator (provider_accounts). Otherwise the receipt is
 *     recorded for review; map the account and reprocess the event to announce it.
 */
const { iso } = require('../ledger');
const { enqueue } = require('../outbox');
const { MAX_RECEIPT_CENTS, fail, userSubject } = require('./common');

const EVENT_TYPE = 'billing.receipt.external';

/** The creator a provider account belongs to, by account id, then by (lower-case) username. */
function accountSubject(db, provider, { id, username } = {}) {
    if (id != null && id !== '') {
        const r = db.prepare('SELECT subject FROM provider_accounts WHERE provider = ? AND account_id = ?').get(provider, String(id));
        if (r) return r.subject;
    }
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    const r = db.prepare('SELECT subject FROM provider_accounts WHERE provider = ? AND username = ?').get(provider, name);
    return r ? r.subject : null;
}

const USERNAME_RE = /^[a-z0-9_.-]{1,64}$/;

/** Add or correct a mapping (operator or importer). Returns the stored row. */
function mapAccount(ctx, { provider, username, accountId, subject, source, liveUserId }) {
    const { db } = ctx;
    const name = String(username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) fail(422, 'billing.invalid_input', 'username must be the provider account name (letters, digits, _ . -)');
    const owner = userSubject(subject, 'subject');
    const at = iso(ctx.now());
    db.prepare(`INSERT INTO provider_accounts (provider, username, account_id, subject, source, live_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider, username) DO UPDATE SET account_id = COALESCE(excluded.account_id, account_id), subject = excluded.subject,
            source = excluded.source, live_user_id = COALESCE(excluded.live_user_id, live_user_id), updated_at = excluded.updated_at`)
        .run(provider, name, accountId != null && accountId !== '' ? String(accountId).slice(0, 100) : null, owner, source, liveUserId || null, at, at);
    return db.prepare('SELECT * FROM provider_accounts WHERE provider = ? AND username = ?').get(provider, name);
}

/**
 * Inside the provider-event transaction. input: { provider, receiptRef, providerEventId, deliveryId,
 * sourceEventId, account: { id, username }, streamer?, amountCents, donorName, anonymous, message,
 * appRef, appPurpose, occurredAt, test }. Returns the provider event result.
 */
function record(ctx, input) {
    const { db, config, rates } = ctx;
    const cents = Number(input.amountCents);
    if (cents === 0) return { effect: 'none', reason: 'EXTERNAL: a zero-amount tip on the streamer\'s own PowerChat — nothing to record' };
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_RECEIPT_CENTS) {
        return { effect: 'none', review: true, reason: `EXTERNAL tip with an amount outside 1..${MAX_RECEIPT_CENTS} cents (${String(input.amountCents).slice(0, 40)}) — not recorded, held for review` };
    }
    const prev = db.prepare('SELECT * FROM external_receipts WHERE receipt_ref = ?').get(input.receiptRef);
    if (prev && prev.status === 'announced') {
        return { effect: 'duplicate_receipt', external: true, announced: false, reason: `payment ${input.receiptRef} was already announced (provider event ${prev.provider_event})` };
    }
    const username = String((input.account && input.account.username) || '').trim().toLowerCase() || null;
    // The creator: named by the caller (a direct-subscription intent already verified the account),
    // else whoever the receiving account is mapped to.
    const streamer = input.streamer || accountSubject(db, input.provider, input.account || {});
    let reason = null;
    let review = false;
    if (config.authority !== 'billing') {
        reason = 'EXTERNAL: a tip on the streamer\'s own PowerChat — recorded, not announced: Live is the money authority (BILLING_AUTHORITY=live) and announces it from its own webhook';
    } else if (!streamer) {
        review = true;
        reason = `EXTERNAL: a tip on PowerChat account "${username || 'unknown'}", which no OpenVibe creator has connected — recorded, not announced; map the account (POST /api/v1/admin/provider-accounts) and reprocess`;
    }

    const at = iso(ctx.now());
    let env = null;
    if (!reason) {
        const anonymous = !!input.anonymous;
        env = enqueue(ctx, {
            event_type: EVENT_TYPE,
            subject: { type: 'provider_receipt', id: input.receiptRef },
            payload: {
                classification: 'EXTERNAL',
                provider: input.provider,
                receipt_ref: input.receiptRef,
                provider_event_id: input.providerEventId,
                delivery_id: input.deliveryId,
                streamer: { type: 'user', id: streamer },
                receiving_account: { provider: input.provider, id: input.account && input.account.id != null ? String(input.account.id) : null, username },
                amount_cents: cents,
                currency: 'usd-cents',
                value_bits: rates.bitsForValueCents(cents),
                donor_name: anonymous ? null : (input.donorName ? String(input.donorName).slice(0, 80) : null),
                anonymous,
                message: input.message ? String(input.message).slice(0, 500) : null,
                app_ref: input.appRef || null,
                app_purpose: input.appPurpose || null,
                occurred_at: input.occurredAt || null,
                test: !!input.test,
                rates: rates.snapshot(),
            },
        });
    }
    const status = env ? 'announced' : 'not_announced';
    if (prev) {
        db.prepare('UPDATE external_receipts SET status = ?, reason = ?, event_id = ?, streamer_subject = ?, updated_at = ? WHERE receipt_ref = ?')
            .run(status, reason, env ? env.event_id : null, streamer, at, input.receiptRef);
    } else {
        db.prepare(`INSERT INTO external_receipts (receipt_ref, provider, provider_event, receiving_account, streamer_subject, amount_cents, test, status, reason, event_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(input.receiptRef, input.provider, input.sourceEventId, username, streamer, cents, input.test ? 1 : 0, status, reason, env ? env.event_id : null, at, at);
    }
    if (env) return { effect: 'external', announced: true, event_id: env.event_id, streamer };
    return { effect: 'external', announced: false, reason, review: review || undefined };
}

module.exports = { record, mapAccount, accountSubject, EVENT_TYPE, USERNAME_RE };
