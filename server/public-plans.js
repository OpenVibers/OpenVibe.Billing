'use strict';
/** Public offers are derived from the same rate functions checkout uses; never a second price list. */
function publicPlans(rates, now = Date.now()) {
 const as_of = new Date(now).toISOString();
 return { as_of, date_kind: 'observed', plans: [
  ...[100,500,1000,2500,5000,10000,25000].filter(v=>v>=rates.minPurchaseBits && v<=rates.maxBits).map(vibes=>({
   id:`vibes-${vibes}`, name:`${vibes.toLocaleString('en-US')} Vibes`, kind:'package', vibes,
   price_cents:rates.priceCents(vibes), currency:'USD', as_of, url:'https://billing.openvibe.network/policy',
  })),
  {id:'channel-membership-default',name:'Default channel membership',kind:'membership',price_cents:rates.subPriceCents,period_days:rates.subPeriodDays,currency:'USD',as_of,url:'https://openvibe.vip',note:'Default tier only. Creators may set their own prices; this is not a network-wide subscription.'},
 ]};
}
module.exports={publicPlans};
