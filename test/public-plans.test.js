'use strict';
const assert=require('node:assert/strict');
const {publicPlans}=require('../server/public-plans');
const rates={minPurchaseBits:500,maxBits:5000,priceCents:n=>n*2,subPriceCents:499,subPeriodDays:30};
const out=publicPlans(rates,Date.UTC(2026,10,11));
assert.deepEqual(out.plans.filter(p=>p.kind==='package').map(p=>p.vibes),[500,1000,2500,5000]);
for(const p of out.plans){assert.equal(p.as_of,'2026-11-11T00:00:00.000Z');assert.equal(p.currency,'USD');if(p.kind==='package')assert.equal(p.price_cents,p.vibes*2);}
assert.equal(out.plans.at(-1).price_cents,499);
assert.equal(out.plans.at(-1).period_days,30);
console.log('public plans: checkout prices, limits, periods and provenance pass');
