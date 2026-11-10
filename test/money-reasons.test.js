'use strict';

const assert = require('assert');
const money = require('../server/money/reasons');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const quest = money.describe('quest:publish-a-video', { site: 'quest', resolve: { quest: (id) => ({ name: 'Publish a video', url: `https://openvibe.quest/quests/${id}` }) } });
ok(quest.text === 'for the quest Publish a video', 'a quest key is a sentence');
ok(quest.subject.url === 'https://openvibe.quest/quests/publish-a-video', 'with the quest as a link');
ok(quest.site === 'OpenVibe.Quest', 'and its site in words');

const refund = money.describe('Refund: A film', { site: 'live' });
ok(refund.text === 'for a refund of A film' && refund.subject.name === 'A film', 'a media refund names the stream');

const tip = money.describe('donation', { site: 'billing', subject: { name: '@bob', url: 'https://openvibe.live/@bob' } });
ok(tip.text === 'for a tip to @bob', 'a tip names its creator');
ok(tip.subject.url === 'https://openvibe.live/@bob', 'and links to them');

const unknown = money.describe('nobody:declared-this', { site: 'fun' });
ok(!unknown.known && unknown.text === 'for something on OpenVibe.Fun', 'an undeclared key never shows itself');
ok(money.describeRow({ reason: 'quest:go-live', app_id: 'quest' }).text === 'for the quest Go live', 'a raw row is described');

console.log(`openvibe-billing money reasons: ${n} checks passed`);
