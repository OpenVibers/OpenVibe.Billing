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
assert.match(tls, /location \^~ \/api\/v1 \{ deny all; \}/);
console.log('nginx vhost: the policy is indexable, the rest noindex; /api/me/vibes public, /api/v1 loopback only');
