'use strict';
// deploy/nginx/billing.openvibe.network.conf: everything is noindex except the public policy (/policy,
// /policy.json, /robots.txt), which robots.txt allows and the app calls indexable. The server-wide
// X-Robots-Tag used to cover it too (found by the browser check, OpenVibe.Host scripts/browser-check.js).
// An add_header inside a location replaces the server's, so that location repeats the security headers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'billing.openvibe.network.conf'), 'utf8');
const tls = conf.slice(conf.indexOf('listen 443'));
const serverLevel = tls.slice(0, tls.indexOf('location'));
assert.match(serverLevel, /add_header X-Robots-Tag "noindex, nofollow" always;/, 'the host is noindex by default');
const m = tls.match(/location ~ \^\/\(policy\|policy\\\.json\|robots\\\.txt\)\$ \{([^}]*)\}/);
assert.ok(m, 'a location for the public policy');
const block = m[1];
assert.ok(!/X-Robots-Tag/.test(block), 'the policy is indexable');
assert.match(block, /add_header X-Content-Type-Options nosniff always;/);
assert.match(block, /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
assert.match(block, /proxy_pass http:\/\/127\.0\.0\.1:4600;/);
assert.ok(tls.indexOf(m[0]) < tls.indexOf('location / {'), 'before the console catch-all');
// The public /api: health and a person's own Vibes (the navbar), both before the catch-all 404; the service API stays loopback.
const me = tls.match(/location = \/api\/me\/vibes \{([^}]*)\}/);
assert.ok(me && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(me[1]) && /limit_req /.test(me[1]), 'a rate-limited location for /api/me/vibes');
assert.ok(tls.indexOf(me[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const balance = tls.match(/location = \/api\/me\/balance \{([^}]*)\}/);
assert.ok(balance && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(balance[1]) && /limit_req /.test(balance[1]), 'a rate-limited location for /api/me/balance');
assert.ok(tls.indexOf(balance[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const transfers = tls.match(/location = \/api\/me\/balance\/transfers \{([^}]*)\}/);
assert.ok(transfers && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(transfers[1]) && /limit_req /.test(transfers[1]), 'a rate-limited location for POST /api/me/balance/transfers');
assert.ok(tls.indexOf(transfers[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const fromBalance = tls.match(/location = \/api\/me\/vibes\/from-balance \{([^}]*)\}/);
assert.ok(fromBalance && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(fromBalance[1]) && /limit_req /.test(fromBalance[1]), 'a rate-limited location for POST /api/me/vibes/from-balance');
assert.ok(tls.indexOf(fromBalance[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const activity = tls.match(/location = \/api\/me\/activity \{([^}]*)\}/);
assert.ok(activity && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(activity[1]) && /limit_req /.test(activity[1]), 'a rate-limited location for /api/me/activity');
assert.ok(tls.indexOf(activity[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const balanceChanges = tls.match(/location = \/api\/me\/balances\/changes \{([^}]*)\}/);
assert.ok(balanceChanges && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(balanceChanges[1]) && /limit_req /.test(balanceChanges[1]), 'a rate-limited location for /api/me/balances/changes');
assert.ok(tls.indexOf(balanceChanges[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const balanceRead = tls.match(/location = \/api\/me\/balances\/read \{([^}]*)\}/);
assert.ok(balanceRead && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(balanceRead[1]) && /limit_req /.test(balanceRead[1]), 'a rate-limited location for /api/me/balances/read');
assert.ok(tls.indexOf(balanceRead[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
// nginx reads an unquoted "{" in a location regex as the block's start ("unknown directive"): quote any regex with a brace.
for (const m of tls.matchAll(/^\s*location\s+~\*?\s+(\S+)\s+\{/gm)) {
    assert.ok(!/[{}]/.test(m[1]) || /^".*"$/.test(m[1]), `quote the location regex ${m[1]}: nginx -t fails on an unquoted brace`);
}
const charge = tls.match(/location ~ "\^\/api\/me\/vibes\/charges\/vch_\[0-9A-HJKMNP-TV-Z\]\{26\}\$" \{([^}]*)\}/);
assert.ok(charge && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(charge[1]) && /limit_req /.test(charge[1]), 'a rate-limited location for GET /api/me/vibes/charges/:id');
assert.ok(tls.indexOf(charge[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const chargeAct = tls.match(/location ~ "\^\/api\/me\/vibes\/charges\/vch_\[0-9A-HJKMNP-TV-Z\]\{26\}\/\(pay\|cancel\)\$" \{([^}]*)\}/);
assert.ok(chargeAct && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(chargeAct[1]) && /limit_req /.test(chargeAct[1]), 'a rate-limited location for POST pay/cancel');
assert.ok(tls.indexOf(chargeAct[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const credits = tls.match(/location = \/api\/me\/credits \{([^}]*)\}/);
assert.ok(credits && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(credits[1]) && /limit_req /.test(credits[1]), 'a rate-limited location for /api/me/credits');
assert.ok(tls.indexOf(credits[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
const topups = tls.match(/location = \/api\/me\/credits\/topups \{([^}]*)\}/);
assert.ok(topups && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(topups[1]) && /limit_req /.test(topups[1]), 'a rate-limited location for POST /api/me/credits/topups');
assert.ok(tls.indexOf(topups[0]) < tls.indexOf('location ^~ /api/ { return 404; }'), 'before the /api 404');
assert.match(tls, /location \^~ \/api\/v1 \{ deny all; \}/);
// Vibes Pay's app API is the one public /api/v1 prefix, rate limited in its own zone, before the deny.
const vibesApi = tls.match(/location \^~ \/api\/v1\/vibes\/ \{([^}]*)\}/);
assert.ok(vibesApi && /limit_req zone=ovbilling_apps/.test(vibesApi[1]) && /proxy_pass http:\/\/127\.0\.0\.1:4600;/.test(vibesApi[1]), 'a rate-limited public location for /api/v1/vibes/');
assert.ok(tls.indexOf(vibesApi[0]) < tls.indexOf('location ^~ /api/v1 { deny all; }'), 'before the /api/v1 deny');
console.log('nginx vhost: the policy is indexable, the rest noindex; /api/me/vibes, /api/me/balance, /api/me/balance/transfers, /api/me/vibes/from-balance, /api/me/activity, /api/me/credits, /api/me/credits/topups, /api/me/balances/changes and /api/me/balances/read public; /api/v1/vibes/ public to apps (app tokens); the rest of /api/v1 loopback only');
