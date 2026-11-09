'use strict';
const { isFrozen, fail } = require('./common');

// Live's owner switch predates the universal wallet. Preserve it alongside Billing's ledger freeze.
async function walletFrozen(ctx) {
    if (await isFrozen(ctx.db)) return true;
    try {
        const r = await ctx.fetchImpl(`${ctx.config.liveUrl}/api/payments/wallet-state`, {
            credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(3000),
        });
        const state = await r.json();
        if (!r.ok || typeof state.money_writes_frozen !== 'boolean') throw new Error('Unknown freeze state');
        return state.money_writes_frozen;
    } catch {
        // Reads still work, but no checkout or store payment may bypass an unavailable owner switch.
        return true;
    }
}
async function assertWalletWritable(ctx) {
    if (await walletFrozen(ctx)) fail(503, 'billing.frozen', 'Purchases and top-ups are paused');
}
module.exports = { walletFrozen, assertWalletWritable };
