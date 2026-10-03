'use strict';
// The README's "Depends on" versions the shared libraries by the same release tag package.json pins: the
// latest bump (openvibe-shared v1.28.0 -> v2.5.0) left the prose behind, so a bump no longer touches the
// pin and the lockfile only. Each pinned tag URL names the version the README must print.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

let checked = 0;
for (const spec of Object.values(pkg.dependencies || {})) {
    const m = /codeload\.github\.com\/OpenVibers\/(OpenVibe\.[A-Za-z]+)\/tar\.gz\/refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(String(spec));
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/^openvibe\./, 'openvibe-'); // OpenVibe.Shared -> openvibe-shared
    assert.ok(readme.includes('`' + name + '` v' + m[2]), `the README pins ${name} at v${m[2]}`);
    checked++;
}
assert.ok(checked >= 3, 'the three shared libraries are pinned by tag');
console.log('dependency pins: the README matches every pinned library');
