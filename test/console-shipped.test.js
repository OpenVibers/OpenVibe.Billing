'use strict';
// The staff console shows what shipped on Billing as plain server-rendered HTML (it loads no
// scripts): escaped, linked to the network's update log, and absent until an entry has been read.
const assert = require('assert');
const views = require('../server/console/views');

const before = views.pages.message({ title: 'Hi', text: 'x' });
assert.ok(!before.includes('class="shipped"'), 'nothing until the changelog has been read');
views.setShipped({ subject: 'Cashout <script>alert(1)</script> fix', deployed_at: new Date(Date.now() - 5 * 60e3).toISOString() });
const page = views.pages.message({ title: 'Hi', text: 'x' });
assert.ok(page.includes('Billing shipped <time'), 'the line');
assert.ok(page.includes('5m ago'));
assert.ok(page.includes('Cashout &lt;script&gt;alert(1)&lt;/script&gt; fix') && !page.includes('<script>alert'), 'escaped');
assert.ok(page.includes('href="https://openvibe.network/updates?site=billing"'));
assert.ok(!/<script/i.test(page.replace('&lt;script&gt;', '')), 'still no scripts on the console');
views.setShipped({ subject: '', deployed_at: 'nope' });
assert.ok(views.pages.message({ title: 'Hi', text: 'x' }).includes('Cashout'), 'a bad entry never replaces a good one');
console.log('console shipped: all checks passed');
