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
let branches = 0;
for (const spec of Object.values(pkg.dependencies || {})) {
    // A release pin on GitHub (…/tar.gz/refs/tags/vX.Y.Z) or on our own forge (git.openvibe.codes …/archive/vX.Y.Z.tar.gz,
    // the pin bot's default since openvibe-shared 4.284.0).
    const t = /codeload\.github\.com\/OpenVibers\/(OpenVibe\.[A-Za-z]+)\/tar\.gz\/refs\/tags\/v(\d+\.\d+\.\d+)$|git\.openvibe\.codes\/api\/v1\/repos\/openvibers\/(openvibe\.[a-z]+)\/archive\/v(\d+\.\d+\.\d+)\.tar\.gz$/i.exec(String(spec));
    const m = t && [t[0], t[1] || t[3], t[2] || t[4]];
    if (!m) {
        // A branch pin (a library whose release is not cut yet): no version to print in the README.
        if (/codeload\.github\.com\/OpenVibers\/OpenVibe\.[A-Za-z]+\/tar\.gz\/refs\/heads\//.test(String(spec))) branches++;
        continue;
    }
    const name = m[1].toLowerCase().replace(/^openvibe\./, 'openvibe-'); // OpenVibe.Shared -> openvibe-shared
    assert.ok(readme.includes('`' + name + '` v' + m[2]), `the README pins ${name} at v${m[2]}`);
    checked++;
}
assert.ok(checked + branches >= 3, 'the three shared libraries are pinned (by tag, or by branch until the tag is cut)');
console.log('dependency pins: the README matches every pinned library');
