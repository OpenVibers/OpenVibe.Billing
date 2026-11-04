'use strict';
// D12 public words: every page, doc and error says "Balance", never "Credits". The wire names stay as they are
// (`usd_credit`, `/internal/credits`, `billing.credit.*`), so this test reads text and string literals only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const docFiles = ['README.md', 'STATUS.json', 'docs/balance.md', 'docs/service-manifest-proposal.json', 'deploy/nginx/billing.openvibe.network.conf'];
const textFiles = ['server/policy.js', 'server/console/views.js', 'server/config-store.js', 'server/api/me.js', 'server/ops/credits.js', 'server/ops/topups.js', 'server/ops/balance.js', 'server/ops/activity.js', 'server/ops/intents.js', 'server/ops/reversals.js', 'server/api/internal.js'];

for (const f of docFiles) assert.ok(!/Credits/.test(read(f)), `${f} has no "Credits"`);
for (const f of textFiles) {
    const text = read(f);
    // A quoted public string: "Credits", 'Credits', `Credits…` (an identifier such as createCreditsTopup is not text).
    const quoted = text.match(/(["'`])(?:[^"'`\n]*?)Credits(?:[^"'`\n]*?)\1/);
    assert.ok(!quoted, `${f} has no quoted "Credits" (found ${quoted && quoted[0]})`);
}
for (const f of docFiles) assert.ok(!/earn(?:ed|s)?\s+vibes/i.test(read(f)), `${f} says Vibes are bought, never earned`);
assert.ok(/Balance/.test(read('docs/balance.md')), 'the Balance doc says Balance');
console.log('public words: Balance in every public text and string; no "Credits", no "earn Vibes"');
