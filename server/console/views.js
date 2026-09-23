'use strict';

/**
 * Server-rendered pages of the staff console. No JavaScript, no external resources: one inline
 * stylesheet allowed by its hash in the Content-Security-Policy. Every interpolated value is
 * HTML-escaped by the `html` tag unless it is itself `html`.
 */
const crypto = require('crypto');

class Raw { constructor(s) { this.s = s; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    if (v == null || v === false) return '';
    return esc(v);
}
function html(strings, ...vals) {
    let out = strings[0];
    vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
    return new Raw(out);
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--muted:#5b6472;--card:#fff;--line:#dde1e7;--accent:#1f5fd6;--ok:#11703b;--bad:#b3261e;--warn:#8a5a00;--warnbg:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#101318;--fg:#e8ebf0;--muted:#9aa4b2;--card:#171b22;--line:#2a313c;--accent:#7aa7ff;--ok:#5fd394;--bad:#ff8a80;--warn:#ffcf66;--warnbg:#3a2e0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1180px;margin:0 auto;padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
.brand{font-weight:700;margin-right:8px}nav{display:flex;flex-wrap:wrap;gap:4px 14px}
nav a{color:var(--muted);text-decoration:none}nav a.on,nav a:hover{color:var(--fg)}
.who{margin-left:auto;color:var(--muted);font-size:13px;display:flex;gap:10px;align-items:center}
main{max-width:1180px;margin:0 auto;padding:18px 16px 48px}
h1{font-size:22px;margin:4px 0 14px}h2{font-size:17px;margin:22px 0 8px}
a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{color:var(--muted);font-size:13px}.card .v{font-size:20px;font-weight:650}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.muted{color:var(--muted)}
.banner{padding:10px 14px;border-radius:8px;margin:0 0 14px;border:1px solid var(--line)}
.banner.frozen,.banner.error{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}.banner.done{border-color:var(--ok);color:var(--ok)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}.tabs a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--fg)}.tabs a.on{background:var(--fg);color:var(--bg)}
form.inline{display:inline}form.stack{display:grid;gap:10px;max-width:520px}
label{display:grid;gap:4px;font-size:14px}label.check{display:flex;gap:8px;align-items:flex-start}
input[type=text],select,textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);width:100%}
textarea{min-height:70px}
button{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{border-color:var(--bad);color:var(--bad)}
button.link{border:0;background:none;padding:0;color:var(--accent);text-decoration:underline}
fieldset{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0}fieldset[disabled]{opacity:.6}
legend{padding:0 6px;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
`;
const CSS_HASH = `sha256-${crypto.createHash('sha256').update(CSS).digest('base64')}`;
const CSP = `default-src 'none'; style-src '${CSS_HASH}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

// ── Formatting ───────────────────────────────────────────────
const n = (v) => Number(v || 0).toLocaleString('en-US');
const bits = (v) => `${n(v)} bits`;
const usd = (c) => `${c < 0 ? '−' : ''}$${(Math.abs(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (s) => (s ? `${String(s).replace('T', ' ').slice(0, 16)} UTC` : '—');
function relative(s, nowMs) {
    if (!s) return '';
    const d = Date.parse(s) - nowMs;
    const abs = Math.abs(d);
    const days = Math.floor(abs / 86_400_000);
    const hours = Math.floor((abs % 86_400_000) / 3_600_000);
    const mins = Math.floor((abs % 3_600_000) / 60_000);
    const span = days ? `${days} d ${hours} h` : hours ? `${hours} h ${mins} min` : `${mins} min`;
    return d >= 0 ? `in ${span}` : `${span} ago`;
}
const okBad = (ok, yes = 'OK', no = 'FAILED') => (ok ? html`<span class="ok">${yes}</span>` : html`<span class="bad">${no}</span>`);

const NAV = [
    ['/', 'Dashboard', 'dashboard'], ['/cashouts', 'Cashouts', 'cashouts'], ['/receipts', 'Receipts to review', 'receipts'],
    ['/import-holds', 'Import holds', 'holds'], ['/reconciliation', 'Reconciliation', 'reconciliation'], ['/freeze', 'Freeze', 'freeze'], ['/audit', 'Audit log', 'audit'],
];

function layout({ title, section, staff, csrf, frozen, notice, error, body }) {
    return `<!doctype html>${render(html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${title} · Billing staff</title><style>${new Raw(CSS)}</style></head>
<body><header><div class="bar"><span class="brand">OpenVibe.Billing · staff</span>
${staff ? html`<nav>${NAV.map(([href, label, id]) => html`<a href="${href}" class="${id === section ? 'on' : ''}">${label}</a>`)}</nav>
<span class="who"><span>${staff.username ? `@${staff.username}` : ''} <code>${staff.subject}</code></span>
<form class="inline" method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="link" type="submit">Sign out</button></form></span>` : ''}
</div></header><main>
${frozen ? html`<div class="banner frozen"><strong>The economy is frozen.</strong> Writes are refused, reads are served, provider webhooks are stored and held. <a href="/freeze">Freeze controls</a></div>` : ''}
${notice ? html`<div class="banner done">${notice}</div>` : ''}
${error ? html`<div class="banner error"><strong>Refused:</strong> ${error}</div>` : ''}
${body}
</main></body></html>`)}`;
}

// ── Pages ────────────────────────────────────────────────────
function signIn({ next, message }) {
    const href = `/auth/login${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
    return layout({
        title: 'Sign in', body: html`<h1>Billing staff console</h1>
<div class="card"><p>${message || 'Sign in with your OpenVibe.Network account. Only network admins listed as Billing staff can use this console.'}</p>
<p><a href="${href}">Sign in with OpenVibe.Network</a></p></div>`,
    });
}

function message({ title, text, staff, csrf }) {
    return layout({ title, staff, csrf, body: html`<h1>${title}</h1><div class="card"><p>${text}</p><p><a href="/">Back</a></p></div>` });
}

function dashboard({ staff, csrf, freeze, last, totals, counts, rates }) {
    const v = (c) => usd(rates.valueCents(c));
    return layout({
        title: 'Dashboard', section: 'dashboard', staff, csrf, frozen: freeze.frozen, body: html`<h1>Dashboard</h1>
<div class="grid">
<div class="card"><div class="k">Economy</div><div class="v">${freeze.frozen ? html`<span class="bad">Frozen</span>` : html`<span class="ok">Open</span>`}</div>
<div class="muted">${freeze.frozen ? html`${freeze.reason || 'no reason given'} · since ${when(freeze.frozen_at)}` : 'writes accepted'}</div><a href="/freeze">Freeze controls</a></div>
<div class="card"><div class="k">Last reconciliation</div>${last ? html`<div class="v">${okBad(last.ok)}</div>
<div class="muted">${when(last.finished_at)}${last.ok ? '' : html` · failed: ${last.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`}</div><a href="/reconciliation/${last.id}">Report</a>`
        : html`<div class="v muted">never run</div>`}
<form method="post" action="/reconciliation"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit">Run reconciliation now</button></form></div>
<div class="card"><div class="k">Cashouts</div><div class="v">${n(counts.ready)} ready to pay</div><div class="muted">${n(counts.escrow)} in escrow</div><a href="/cashouts?tab=ready">Queue</a></div>
<div class="card"><div class="k">Needs review</div><div class="v">${n(counts.review_events + counts.review_transactions)}</div><div class="muted">${n(counts.review_events)} receipts · ${n(counts.review_transactions)} reversals · ${n(counts.import_holds)} import holds</div><a href="/receipts">Receipts</a></div>
</div>
<h2>Outstanding (test transactions excluded)</h2>
<div class="tablewrap"><table><thead><tr><th>Account kind</th><th>Balance</th><th>Value</th></tr></thead><tbody>
<tr><td>Spendable credit (user_credit)</td><td>${bits(totals.credit_bits)}</td><td>${v(totals.credit_bits)}</td></tr>
<tr><td>Creator payable (creator_payable)</td><td>${bits(totals.payable_bits)}</td><td>${v(totals.payable_bits)}</td></tr>
<tr><td>Payouts pending (payouts_pending)</td><td>${bits(totals.payouts_pending_bits)}</td><td>${v(totals.payouts_pending_bits)}</td></tr>
<tr><td>Platform revenue</td><td>—</td><td>${usd(totals.platform_revenue_cents)}</td></tr>
<tr><td>Chargeback loss</td><td>—</td><td>${usd(totals.chargeback_loss_cents)}</td></tr>
</tbody></table></div>
<p class="muted">${n(totals.test_transactions)} test transaction(s) are left out of these totals. Value at ${n(rates.bitsPerUsd)} bits per USD.</p>`,
    });
}

function cashouts({ staff, csrf, frozen, tab, tabs, rows, counts, nowMs, rates }) {
    return layout({
        title: 'Cashouts', section: 'cashouts', staff, csrf, frozen, body: html`<h1>Cashouts</h1>
<p class="muted">A cashout is requested by the creator (payable moves to payouts pending) and waits out a ${n(rates.escrowDays)}-day escrow. Approving it records the payout you made at the provider — its payout reference is required — and marks it paid; denying it returns the amount to the creator's payable.</p>
<div class="tabs">${Object.entries(tabs).map(([id, t]) => html`<a href="/cashouts?tab=${id}" class="${id === tab ? 'on' : ''}">${t.label}${counts[id] != null ? ` (${n(counts[id])})` : ''}</a>`)}</div>
${rows.length ? html`<div class="tablewrap"><table><thead><tr><th>Cashout</th><th>Creator</th><th>Amount</th><th>Method</th><th>Requested</th><th>Escrow until</th><th>Outcome</th></tr></thead><tbody>
${rows.map((c) => html`<tr><td><a class="mono" href="/cashouts/${c.id}">${c.id}</a></td><td><code>${c.subject}</code></td><td>${bits(c.amount_bits)}<br><span class="muted">${usd(c.value_cents)}</span></td>
<td>${c.payout_method.type || '—'}</td><td>${when(c.created_at)}</td><td>${when(c.escrow_until)}<br><span class="muted">${relative(c.escrow_until, nowMs)}</span></td>
<td>${c.status === 'paid' ? html`paid · <code>${c.payout_reference}</code>` : c.status === 'denied' ? html`denied${c.reason ? html` · ${c.reason}` : ''}` : 'pending'}</td></tr>`)}
</tbody></table></div>` : html`<div class="card muted">Nothing here.</div>`}`,
    });
}

function cashout({ staff, csrf, frozen, c, balances, nowMs, approveKey, denyKey, form = {}, error, notice, history }) {
    const inEscrow = c.status === 'requested' && nowMs < Date.parse(c.escrow_until);
    const pending = c.status === 'requested';
    return layout({
        title: `Cashout ${c.id}`, section: 'cashouts', staff, csrf, frozen, error, notice, body: html`<h1>Cashout <span class="mono">${c.id}</span></h1>
<div class="cols"><div class="card"><dl>
<dt>Status</dt><dd>${c.status === 'requested' ? (inEscrow ? 'pending — in escrow' : 'pending — ready to pay') : c.status}</dd>
<dt>Creator</dt><dd><code>${c.subject}</code></dd>
<dt>Amount</dt><dd>${bits(c.amount_bits)} (${usd(c.value_cents)})</dd>
<dt>Pay to</dt><dd>${c.payout_method.type || '—'} · <span class="mono">${c.payout_method.address || '—'}</span></dd>
<dt>Requested</dt><dd>${when(c.created_at)}</dd>
<dt>Escrow until</dt><dd>${when(c.escrow_until)} <span class="muted">(${relative(c.escrow_until, nowMs)})</span></dd>
<dt>Request txn</dt><dd><code>${c.request_txn}</code></dd>
${c.settle_txn ? html`<dt>Decision txn</dt><dd><code>${c.settle_txn}</code></dd>` : ''}
${c.payout_reference ? html`<dt>Payout</dt><dd>${c.payout_provider} · <code>${c.payout_reference}</code></dd>` : ''}
${c.reason ? html`<dt>Reason</dt><dd>${c.reason}</dd>` : ''}
${c.decided_by && c.decided_by.principal ? html`<dt>Decided by</dt><dd><code>${c.decided_by.principal}</code></dd>` : ''}
<dt>Creator now holds</dt><dd>${bits(balances.payable)} payable · ${bits(balances.pending)} pending payouts</dd>
</dl></div>
${pending ? html`<div>
<form class="stack" method="post" action="/cashouts/${c.id}/approve"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action_key" value="${approveKey}">
<fieldset ${inEscrow || frozen ? html`disabled` : ''}><legend>Approve — record the payout</legend>
${inEscrow ? html`<p class="muted">Escrow runs until ${when(c.escrow_until)}; Billing refuses approval before then.</p>` : ''}
<p class="muted">Pay ${usd(c.value_cents)} to the address above at the provider first, then enter the provider's payout reference.</p>
<label>Payout provider<select name="payout_provider">${['paypal', 'wise', 'bank', 'crypto', 'other'].map((p) => html`<option value="${p}" ${(form.payout_provider || 'paypal') === p ? html`selected` : ''}>${p}</option>`)}</select></label>
<label>Payout reference (required)<input type="text" name="payout_reference" maxlength="200" value="${form.payout_reference || ''}" autocomplete="off"></label>
<label class="check"><input type="checkbox" name="confirm" value="yes"> I sent ${usd(c.value_cents)} to this creator and the reference above is the provider's.</label>
<button class="primary" type="submit">Approve payout</button></fieldset></form>
<p></p>
<form class="stack" method="post" action="/cashouts/${c.id}/deny"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action_key" value="${denyKey}">
<fieldset ${frozen ? html`disabled` : ''}><legend>Deny — return to the creator's payable</legend>
<label>Reason (required, recorded)<textarea name="reason" maxlength="300">${form.reason || ''}</textarea></label>
<button class="danger" type="submit">Deny cashout</button></fieldset></form></div>` : ''}
</div>
${history.length ? html`<h2>Staff actions on this cashout</h2>${auditTable(history)}` : ''}`,
    });
}

function eventsTable(rows, { csrf, reprocess, frozen }) {
    if (!rows.length) return html`<div class="card muted">None.</div>`;
    return html`<div class="tablewrap"><table><thead><tr><th>#</th><th>Provider</th><th>Event</th><th>Type</th><th>Received</th><th>Result</th><th>Attempts</th>${reprocess ? html`<th></th>` : ''}</tr></thead><tbody>
${rows.map((e) => html`<tr><td>${e.id}</td><td>${e.provider}</td><td class="mono">${e.provider_event_id}</td><td>${e.type || '—'}</td><td>${when(e.received_at)}</td>
<td>${e.result ? html`${e.result.effect}${e.result.code ? html` · <code>${e.result.code}</code>` : ''}${e.result.reason ? html`<br><span class="muted">${e.result.reason}</span>` : ''}` : html`<span class="muted">not processed</span>${e.last_error ? html`<br><span class="muted">${e.last_error}</span>` : ''}`}</td>
<td>${e.attempts}</td>${reprocess ? html`<td>${!e.processed_at || (e.result && e.result.effect === 'rejected') ? html`<form class="inline" method="post" action="/receipts/${e.id}/reprocess"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" ${frozen ? html`disabled` : ''}>Reprocess</button></form>` : ''}</td>` : ''}</tr>`)}
</tbody></table></div>`;
}

function receipts({ staff, csrf, frozen, q, notice, error }) {
    return layout({
        title: 'Receipts to review', section: 'receipts', staff, csrf, frozen, notice, error, body: html`<h1>Provider receipts to review</h1>
<p class="muted">Receipts are shown by id and outcome only; provider payloads stay in the database. Resolve a money difference with an adjustment through the API (<code>POST /api/v1/admin/adjustments</code>, <code>relates_to</code> = the transaction).</p>
<h2>Flagged for review</h2><p class="muted">Unattributed tips to the site PowerChat account, underpaid deliveries, site-routed tips for an unknown streamer.</p>
${eventsTable(q.review, { csrf, reprocess: false, frozen })}
<h2>Rejected</h2><p class="muted">Refused receipts — including deliveries for orders Live already credited before the cutover (<code>billing.intent_settled_in_live</code>, never credited twice) and refunds for unknown payments. Reprocess only after fixing the cause.</p>
${eventsTable(q.rejected, { csrf, reprocess: true, frozen })}
<h2>Stored, not processed</h2><p class="muted">Held while frozen, or failing transiently; the service retries them every minute.</p>
${eventsTable(q.unprocessed, { csrf, reprocess: true, frozen })}
<h2>Reversals flagged for review</h2><p class="muted">Refunds and chargebacks on credit already given away: the recipient kept it, the loss was booked.</p>
${q.transactions.length ? html`<div class="tablewrap"><table><thead><tr><th>Transaction</th><th>Type</th><th>Reverses</th><th>Provider</th><th>Cents</th><th>Unrecovered</th><th>At</th></tr></thead><tbody>
${q.transactions.map((t) => html`<tr><td><code>${t.id}</code></td><td>${t.type}</td><td><code>${t.reverses_txn || '—'}</code></td><td>${t.provider || '—'}</td><td>${t.cents != null ? usd(t.cents) : '—'}</td>
<td>${t.unrecovered_bits ? bits(t.unrecovered_bits) : t.creator_payable_kept_bits ? `${bits(t.creator_payable_kept_bits)} kept by creator` : '—'}</td><td>${when(t.created_at)}</td></tr>`)}
</tbody></table></div>` : html`<div class="card muted">None.</div>`}`,
    });
}

function holds({ staff, csrf, frozen, rows }) {
    return layout({
        title: 'Import holds', section: 'holds', staff, csrf, frozen, body: html`<h1>Import holds</h1>
<p class="muted">Live users the importer could not map to a Network subject. Their balances sit on <code>hold:live:&lt;id&gt;</code> until a later import (after the Network maps them) releases them.</p>
${rows.length ? html`<div class="tablewrap"><table><thead><tr><th>Live user</th><th>Account owner</th><th>Reason</th><th>Credit</th><th>Payable</th><th>Resolved to</th><th>First seen</th></tr></thead><tbody>
${rows.map((h) => html`<tr><td>${h.live_user_id}</td><td><code>${h.owner}</code></td><td>${h.reason}</td><td>${bits(h.credit_bits)}</td><td>${bits(h.payable_bits)}</td><td>${h.resolved_subject ? html`<code>${h.resolved_subject}</code>` : html`<span class="bad">unresolved</span>`}</td><td>${when(h.first_seen_at)}</td></tr>`)}
</tbody></table></div>` : html`<div class="card muted">No import holds.</div>`}`,
    });
}

function reconciliation({ staff, csrf, frozen, runs, notice }) {
    return layout({
        title: 'Reconciliation', section: 'reconciliation', staff, csrf, frozen, notice, body: html`<h1>Reconciliation</h1>
<form method="post" action="/reconciliation"><input type="hidden" name="_csrf" value="${csrf}"><button class="primary" type="submit">Run reconciliation now</button></form>
<h2>History</h2>
${runs.length ? html`<div class="tablewrap"><table><thead><tr><th>Run</th><th>Finished</th><th>Result</th><th>Failed checks</th></tr></thead><tbody>
${runs.map((r) => html`<tr><td><a class="mono" href="/reconciliation/${r.id}">${r.id}</a></td><td>${when(r.finished_at)}</td><td>${okBad(r.ok)}</td><td>${r.failed.join(', ') || '—'}</td></tr>`)}
</tbody></table></div>` : html`<div class="card muted">No runs yet.</div>`}`,
    });
}

function reconciliationRun({ staff, csrf, frozen, run }) {
    const t = run.totals || {};
    return layout({
        title: `Reconciliation ${run.id}`, section: 'reconciliation', staff, csrf, frozen, body: html`<h1>Reconciliation <span class="mono">${run.id}</span> ${okBad(run.ok)}</h1>
<p class="muted">Started ${when(run.started_at)}, finished ${when(run.finished_at)}. The full report (with offending rows) is available to operators through <code>npm run reconcile</code> on the host.</p>
<div class="cols"><div><h2>Checks</h2><div class="tablewrap"><table><thead><tr><th>Check</th><th>Result</th><th>Offenders</th></tr></thead><tbody>
${run.checks.map((c) => html`<tr><td><code>${c.id}</code></td><td>${okBad(c.ok)}</td><td>${c.offenders || '—'}</td></tr>`)}
</tbody></table></div></div>
<div><h2>Warnings</h2><div class="tablewrap"><table><tbody>${Object.entries(run.warnings).map(([k, v]) => html`<tr><td>${k.replace(/_/g, ' ')}</td><td>${n(v)}</td></tr>`)}</tbody></table></div>
<h2>Totals (test excluded where marked)</h2><div class="tablewrap"><table><tbody>${Object.entries(t).map(([k, v]) => html`<tr><td>${k.replace(/_/g, ' ')}</td><td>${typeof v === 'number' ? n(v) : String(v)}</td></tr>`)}</tbody></table></div></div></div>`,
    });
}

function freeze({ staff, csrf, state, held, notice, error }) {
    return layout({
        title: 'Freeze', section: 'freeze', staff, csrf, frozen: state.frozen, notice, error, body: html`<h1>Economy freeze</h1>
<div class="card"><dl><dt>State</dt><dd>${state.frozen ? html`<span class="bad">Frozen</span>` : html`<span class="ok">Open</span>`}</dd>
${state.frozen ? html`<dt>Reason</dt><dd>${state.reason || '—'}</dd><dt>Since</dt><dd>${when(state.frozen_at)}</dd><dt>By</dt><dd><code>${(state.frozen_by && state.frozen_by.principal) || '—'}</code></dd>` : ''}
<dt>Held webhooks</dt><dd>${n(held)}</dd></dl></div>
<p class="muted">While frozen every money write (API and console) is refused with <code>billing.frozen</code>, reads are served, provider webhooks are stored and held, jobs pause. Unfreezing processes the held webhooks in arrival order.</p>
<form class="stack" method="post" action="/freeze"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="on" value="${state.frozen ? '0' : '1'}">
<label>Reason (required, recorded)<textarea name="reason" maxlength="300"></textarea></label>
<button class="${state.frozen ? 'primary' : 'danger'}" type="submit">${state.frozen ? 'Unfreeze the economy' : 'Freeze the economy'}</button></form>`,
    });
}

function auditTable(rows) {
    return html`<div class="tablewrap"><table><thead><tr><th>At</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th>Reason / detail</th><th>Request</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td>${when(r.at)}</td><td>${r.actor_username ? `@${r.actor_username} ` : ''}<code>${r.actor_subject || '—'}</code></td><td><code>${r.action}</code></td>
<td>${r.target_type ? html`${r.target_type} <code>${r.target_id}</code>` : '—'}</td><td>${r.outcome === 'done' ? html`<span class="ok">done</span>` : html`<span class="bad">refused</span>`}</td>
<td>${r.reason || ''}${Object.keys(r.detail || {}).length ? html`<br><span class="muted mono">${Object.entries(r.detail).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')}</span>` : ''}</td><td class="mono muted">${r.request_id || ''}</td></tr>`)}
</tbody></table></div>`;
}

function audit({ staff, csrf, frozen, rows }) {
    return layout({
        title: 'Audit log', section: 'audit', staff, csrf, frozen, body: html`<h1>Staff audit log</h1>
<p class="muted">Append-only: every staff action and every refused attempt, newest first (last 200). Done actions are also published as <code>billing.staff.action</code>.</p>
${rows.length ? auditTable(rows) : html`<div class="card muted">Empty.</div>`}`,
    });
}

module.exports = { CSP, html, esc, pages: { signIn, message, dashboard, cashouts, cashout, receipts, holds, reconciliation, reconciliationRun, freeze, audit } };
