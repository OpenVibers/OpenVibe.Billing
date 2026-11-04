'use strict';

/**
 * Credits top-up (D9): a person pays USD through the existing checkout provider and the paid webhook credits their
 * (subject, project_id) usd_credit account, at nano-USD precision (1 cent = 10,000,000 nano-USD). The fee the owner
 * configured is charged on top and booked to platform_revenue.
 *
 * Everything is behind BILLING_CREDITS_TOPUP (off). The owner sets every allowed amount
 * (BILLING_CREDITS_TOPUP_AMOUNTS_CENTS) and the fee (BILLING_CREDITS_TOPUP_FEE_BPS); there is no default amount and
 * no default fee. With either unset or invalid the person's route answers 503 billing.topup_unconfigured, and a paid
 * event that arrives while the feature is off/unconfigured is recorded for review and moves no money.
 *
 * Journal on a paid top-up (nano-usd, all balanced):
 *   provider_clearing:<provider>  -(what was paid)
 *   usd_credit:<subject>:<project> +amount
 *   platform_revenue               +fee (and any overpayment)
 *
 * The receipt reference is unique in the journal and the intent is marked settled in the same transaction, so a
 * provider redelivery (same event id or a new one for the same payment) credits exactly once. Refunds and
 * chargebacks go through ops/reversals.js.
 */
const { post, getTxn, money, prefixedId, iso } = require('../ledger');
const { enqueue } = require('../outbox');
const { MAX_RECEIPT_CENTS, entry, fail, positiveInt, userSubject, isFrozen } = require('./common');
const { A_INF, NANO_PER_CENT } = require('./credits');
const intents = require('./intents');
const { summary } = require('./purchases');

const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACTOR = { type: 'service', id: 'billing' };

function settings(config) {
    return (config.credits && config.credits.topup) || { enabled: false, configured: false, amountsCents: [], feeBps: null, problem: 'BILLING_CREDITS_TOPUP is not set' };
}

/** The fee in whole cents the person pays on top of the top-up: ceil(amount × bps / 10000). 0 bps is 0. */
function feeCents(amountCents, feeBps) {
    return Number((BigInt(amountCents) * BigInt(feeBps) + 9999n) / 10000n);
}

function assertStartable(config) {
    if (!config.credits || !config.credits.enabled) fail(404, 'billing.not_enabled', 'Credits are not open yet');
    const t = settings(config);
    if (!t.enabled) fail(404, 'billing.topup_disabled', 'Credits top-up is not open');
    if (!t.configured) fail(503, 'billing.topup_unconfigured', `the Credits top-up is not configured: ${t.problem}`);
    return t;
}

/**
 * Start a top-up: validate the person's choice against the owner's configuration, create a credits_topup intent and
 * open the provider's existing checkout. The amount is never taken from the client and priced elsewhere.
 */
async function startTopup(ctx, adapters, input) {
    const { config } = ctx;
    const t = assertStartable(config);
    // The freeze stops money writes; opening a checkout that would take money is one, as on /api/v1/intents.
    if (await isFrozen(ctx.db)) fail(503, 'billing.frozen', 'the economy is frozen: top-ups are refused');
    const subject = userSubject(input.subject, 'subject');
    const projectId = String(input.project_id || '');
    if (!PROJECT_RE.test(projectId)) fail(422, 'billing.invalid_input', 'project_id is a project id');
    const amountCents = positiveInt(input.amount_cents, 'amount_cents', MAX_RECEIPT_CENTS);
    if (!t.amountsCents.includes(amountCents)) fail(422, 'billing.amount_not_allowed', 'this top-up amount is not offered');
    const provider = String(input.provider || '').toLowerCase();
    const adapter = adapters[provider];
    if (!adapter) fail(422, 'billing.invalid_input', `unknown provider ${input.provider}`);
    if (!adapter.enabled) fail(409, 'billing.provider_disabled', `${adapter.name} is not enabled on Billing`);
    if (!adapter.createCheckout) fail(422, 'billing.invalid_input', `${adapter.name} cannot start a checkout`);

    const fee = feeCents(amountCents, t.feeBps);
    if (amountCents + fee > MAX_RECEIPT_CENTS) fail(422, 'billing.invalid_amount', 'the top-up plus its fee is above the maximum');
    const intent = await intents.createCreditsTopup(ctx, { provider, subject, projectId, amountCents, feeCents: fee, feeBps: t.feeBps });
    let checkoutUrl = null;
    try {
        const out = await adapter.createCheckout(ctx, intent, {
            name: 'OpenVibe Credits',
            successUrl: `${config.baseUrl}/checkout/success`, cancelUrl: `${config.baseUrl}/checkout/cancel`,
            ipnUrl: `${config.baseUrl}/webhooks/${adapter.name}`,
        });
        if (out.providerRef) await intents.setProviderRef(ctx, intent.id, out.providerRef);
        checkoutUrl = out.url || null;
    } catch (e) {
        await intents.setStatus(ctx, intent.id, 'failed');
        fail(502, 'billing.provider_error', `${adapter.name}: ${e.message}`);
    }
    return { intent: intents.present(await intents.find(ctx.db, intent.id)), checkout_url: checkoutUrl };
}

/**
 * The plan a provider adapter returns for a paid top-up intent. When the feature is off or unconfigured the event is
 * recorded for review and moves nothing (money received but not credited is visible to an operator, never silent).
 */
function plan(ctx, intent, { provider, receiptRef, paidCents, idempotencyKey, actor }) {
    const t = settings(ctx.config);
    if (!ctx.config.credits || !ctx.config.credits.enabled || !t.enabled) return { effect: 'none', reason: 'Credits top-up is off', review: true };
    if (!t.configured) return { effect: 'none', reason: `Credits top-up is not configured: ${t.problem}`, review: true };
    if (intent.provider !== provider) return { effect: 'none', reason: `top-up intent ${intent.id} belongs to ${intent.provider}, not ${provider}`, review: true };
    if (!(paidCents >= intent.amount_cents)) return { effect: 'none', reason: `underpaid top-up: ${paidCents} < ${intent.amount_cents} cents`, review: true };
    return { effect: 'credits_topup', args: { provider, receiptRef, paidCents, intentId: intent.id, idempotencyKey, actor } };
}

/**
 * Settle a paid top-up exactly once. Idempotent on the provider event key and on the receipt reference (a second
 * event for the same payment returns the first transaction). Credits exactly the intent's amount; the fee (and any
 * overpayment) is platform revenue. Marks the intent settled in the same transaction.
 */
async function settle(ctx, input) {
    const { db, config } = ctx;
    return await money(db, async () => {
        const receiptRef = input.receiptRef;
        if (!receiptRef) fail(422, 'billing.invalid_input', 'a provider receipt reference is required');
        if (!input.idempotencyKey) fail(422, 'billing.invalid_input', 'an idempotency key is required');
        const dup = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ? OR (receipt_ref IS NOT NULL AND receipt_ref = ?)').get(input.idempotencyKey, receiptRef);
        if (dup) return { txn: await getTxn(db, dup.id), replay: true, duplicateReceipt: true };

        if (!input.intentId) fail(422, 'billing.invalid_input', 'a top-up needs its intent');
        const intent = await intents.find(db, input.intentId);
        if (!intent) fail(404, 'billing.intent_not_found', `no payment intent ${input.intentId}`);
        if (intent.kind !== 'credits_topup') fail(422, 'billing.intent_mismatch', `intent ${intent.id} is a ${intent.kind}, not a credits_topup`);
        if (intent.provider !== input.provider) fail(422, 'billing.intent_mismatch', `intent ${intent.id} belongs to ${intent.provider}, not ${input.provider}`);
        if (intent.status === 'settled' && intent.settled_txn) return { txn: await getTxn(db, intent.settled_txn), replay: true };
        intents.refuseIfSettledInLive(intent);

        const t = settings(config);
        if (!config.credits || !config.credits.enabled || !t.enabled) fail(503, 'billing.topup_disabled', 'Credits top-up is off');
        if (!t.configured) fail(503, 'billing.topup_unconfigured', `the Credits top-up is not configured: ${t.problem}`);

        const paidCents = positiveInt(input.paidCents, 'amount_cents', MAX_RECEIPT_CENTS);
        if (paidCents < intent.amount_cents) fail(422, 'billing.underpaid', `the payment of ${paidCents} cents does not cover the top-up of ${intent.amount_cents} cents`);
        const amountCents = Number(intent.metadata.topup_amount_cents);
        const feeBps = Number(intent.metadata.topup_fee_bps);
        const projectId = String(intent.metadata.project_id || '');
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !PROJECT_RE.test(projectId)) fail(422, 'billing.intent_mismatch', `intent ${intent.id} is not a valid credits_topup`);

        const amountNano = BigInt(amountCents) * NANO_PER_CENT;
        const paidNano = BigInt(paidCents) * NANO_PER_CENT;
        const revenueNano = paidNano - amountNano;
        const { txn } = await post(ctx, {
            type: 'credit', idempotencyKey: input.idempotencyKey, actor: input.actor || ACTOR, toSubject: intent.subject,
            provider: input.provider, receiptRef, sourceEventId: input.sourceEventId,
            entries: [
                entry(A_INF.clearing(input.provider), -paidNano),
                entry(A_INF.credit(intent.subject, projectId), amountNano),
                entry(A_INF.revenue(), revenueNano),
            ],
            metadata: {
                credit: 'topup', project_id: projectId, intent_id: intent.id,
                amount_nano_usd: String(amountNano), fee_nano_usd: String(revenueNano), paid_nano_usd: String(paidNano),
                paid_cents: paidCents, topup_amount_cents: amountCents, fee_cents: paidCents - amountCents, fee_bps: feeBps,
            },
        });
        await intents.markSettled(ctx, intent.id, txn.id);
        await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        return { txn, replay: false };
    });
}

/** Record the spent part of a refunded top-up: a debt of the person, reported by reconciliation. */
async function recordDebt(ctx, { topupTxnId, transactionId, reversalRef, subject, projectId, provider, amountNano, reason }) {
    const nowIso = iso(ctx.now());
    await ctx.db.prepare(`INSERT INTO credit_topup_debts
        (id, topup_txn_id, transaction_id, reversal_ref, subject, project_id, provider, amount_nano_usd, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz)`)
        .run(prefixedId('cdt', ctx.now()), topupTxnId, transactionId, reversalRef, subject, projectId, provider, amountNano, String(reason || '').slice(0, 300), nowIso);
}

module.exports = { startTopup, plan, settle, recordDebt, feeCents, settings };
