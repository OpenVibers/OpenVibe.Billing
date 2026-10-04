'use strict';
/**
 * Billing's capability declarations are the estate's: every `docs/capabilities-proposal/<id>.json` is
 * the capability of that id in the pinned openvibe-contracts, it is listed by that package's billing
 * service manifest, and each `implementedBy` is a real route in `server/api/v1.js`.
 *
 * This is the check a Network grant needs. A default grant naming a capability that exists nowhere in
 * the estate is inert — `auth.needs()` never matches it and a producer's posts 401 — so a capability
 * declared here but not released in the pinned contracts must fail before anyone grants it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const proposalDir = path.join(root, 'docs', 'capabilities-proposal');
const contractsDir = path.join(root, 'node_modules', 'openvibe-contracts');

const proposals = fs.readdirSync(proposalDir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(proposalDir, f), 'utf8')));
const service = JSON.parse(fs.readFileSync(path.join(contractsDir, 'manifests', 'services', 'billing.json'), 'utf8'));
const routes = fs.readFileSync(path.join(root, 'server', 'api', 'v1.js'), 'utf8');

assert.ok(proposals.length > 0, 'docs/capabilities-proposal has no capability declarations');

for (const p of proposals) {
    const file = path.join(contractsDir, 'manifests', 'capabilities', `${p.id}.json`);
    assert.ok(fs.existsSync(file), `${p.id} is declared in the repo but absent from openvibe-contracts: a grant naming it would be inert`);
    const released = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Every field the repo declares must match the released manifest; the release may carry more
    // (the schemas Contracts adds on promotion), never different values.
    for (const [k, v] of Object.entries(p)) assert.deepStrictEqual(released[k], v, `${p.id}: ${k} has drifted from the released manifest`);
    assert.strictEqual(p.owner, 'billing', `${p.id}: owner must be billing`);
    assert.strictEqual(p.status, 'active', `${p.id}: status must be active`);
    assert.ok(service.capabilities.includes(p.id), `${p.id} is not listed by openvibe-contracts' billing service manifest`);
    for (const impl of p.implementedBy) {
        // 'POST /api/v1/usage' or 'GET|POST /api/v1/admin/freeze'.
        const [methods, url] = impl.split(' ');
        const route = url.replace(/^\/api\/v1/, '');
        for (const m of methods.split('|')) {
            assert.ok(routes.includes(`r.${m.toLowerCase()}('${route}'`), `${p.id}: ${impl} is not a route in server/api/v1.js`);
        }
    }
}

for (const id of service.capabilities) {
    assert.ok(proposals.some((p) => p.id === id), `${id} is released for billing but has no declaration in docs/capabilities-proposal`);
}

console.log(`capabilities: ${proposals.length} declared, all released in ${'openvibe-contracts'} and routed`);
