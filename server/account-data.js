'use strict';

/**
 * Account export and deletion → Billing (ADR-033; openvibe-sdk/account-data). Billing is the money ledger since the
 * cutover of 2026-10-17, so a person's money history is answered here (Live keeps none of it).
 *
 *   export   the person's accounts with their balances, every transaction they sent or received, their checkouts,
 *            cash-outs, subscriptions (as a member, and as a creator without the members' identities), entitlements,
 *            tips on their own PowerChat, usage readings, promo allowances, tier prices and connected payment accounts
 *   erase    money records stay (the ledger, receipts, checkouts, cash-outs, subscriptions, entitlements, usage and
 *            promo rows are records the law and the reconciliation need): counted as retained. What is only settings
 *            goes: tier prices, connected payment accounts (the attribution of a provider username to the person),
 *            staff sessions.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const ledger = 'money records: the ledger must still balance and reconcile, and payments are records the law requires us to keep';

const TABLES = [
    { table: 'transactions', subject: 'from_subject', file: 'transactions-sent.json', columns: ['id', 'type', 'status', 'from_subject', 'to_subject', 'provider', 'reverses_txn', 'test', 'metadata', 'created_at'], erase: { keep: ledger } },
    { table: 'transactions', subject: 'to_subject', file: 'transactions-received.json', columns: ['id', 'type', 'status', 'from_subject', 'to_subject', 'provider', 'reverses_txn', 'test', 'metadata', 'created_at'], erase: { keep: ledger }, kind: 'transactions_received' },
    { table: 'payment_intents', subject: 'subject', file: 'checkouts.json', columns: ['id', 'provider', 'kind', 'streamer_subject', 'amount_cents', 'fee_cents', 'bits', 'route', 'auto_renew', 'status', 'settled_txn', 'created_at', 'updated_at'], erase: { keep: ledger } },
    { table: 'cashouts', subject: 'subject', file: 'cashouts.json', columns: ['id', 'amount_bits', 'value_cents', 'status', 'payout_method', 'escrow_until', 'payout_provider', 'payout_reference', 'reason', 'created_at', 'updated_at'], erase: { keep: ledger } },
    { table: 'subscriptions', subject: 'subscriber', file: 'subscriptions.json', columns: ['id', 'streamer', 'tier', 'provider', 'status', 'auto_renew', 'cancel_at_period_end', 'price_cents', 'current_period_end', 'created_at', 'updated_at'], erase: { keep: ledger } },
    // As a creator: their subscriptions without who the members are (that is the members' data).
    { table: 'subscriptions', subject: 'streamer', file: 'subscriptions-to-you.json', columns: ['id', 'tier', 'status', 'price_cents', 'current_period_end', 'created_at'], erase: { keep: ledger }, kind: 'subscriptions_to_you' },
    { table: 'entitlements', subject: 'subject', file: 'entitlements.json', columns: ['id', 'kind', 'scope', 'subscription_id', 'starts_at', 'ends_at', 'revoked_at', 'created_at'], erase: { keep: ledger } },
    { table: 'external_receipts', subject: 'streamer_subject', file: 'tips-on-your-powerchat.json', columns: ['receipt_ref', 'provider', 'receiving_account', 'amount_cents', 'test', 'status', 'created_at'], erase: { keep: ledger } },
    { table: 'usage_records', subject: 'subject', file: 'usage.json', erase: { keep: ledger } },
    { table: 'promo_allowances', subject: 'subject', file: 'promo-allowances.json', erase: { keep: ledger } },
    { table: 'subscription_tiers', subject: 'streamer', file: 'tier-prices.json', columns: ['tier', 'price_cents', 'status', 'created_at', 'updated_at'] },
    { table: 'provider_accounts', subject: 'subject', file: 'payment-accounts.json', columns: ['provider', 'username', 'source', 'created_at', 'updated_at'] },
    { table: 'staff_sessions', subject: 'subject', file: null },
];

/** Accounts with their balances (a balance is the account's cached sum of ledger entries). */
async function balances(db, subject) {
    return await db.prepare(`SELECT a.kind, a.currency, COALESCE(b.balance, 0) AS balance, a.created_at FROM accounts a
        LEFT JOIN account_balances b ON b.account_id = a.id WHERE a.owner_subject = ? ORDER BY a.id`).all(subject);
}

function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'billing', tables: TABLES, log,
        note: 'OpenVibe.Billing keeps Vibes and payments. Money records are kept after an account is deleted, as the law and the books require; they no longer lead to a person once the account is gone.',
        extraExport: async (d, subject) => [{ name: 'balances.json', content: await balances(d, subject) }],
        // Accounts stay (the ledger points at them): counted as retained with the other money records.
        extraErase: async (t, subjects, counts) => {
            for (const subject of subjects) {
                counts.add(counts.retained, 'accounts', Number(await t.value('SELECT COUNT(*)::int FROM accounts WHERE owner_subject = $1', [subject])) || 0);
            }
        },
    });
}

module.exports = { create, TABLES, TOPICS, balances };
