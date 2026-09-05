// Render PERF-REPORT.html from report-data.json. Rerun after every data update:
//   node perf/render.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(fs.readFileSync(path.join(here, 'report-data.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const x100 = (v) => (typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : esc(v));

function metric(before, after, unit, dir = 'lower') {
  if (before == null || after == null) return '—';
  const ratio = before / after;
  const better = dir === 'lower' ? after < before : after > before;
  const pct = before ? Math.round(((before - after) / before) * 100) : 0;
  const txt = better
    ? `<b class="good">${x100(after)}${unit}</b> <span class="dim">(${pct}% ${dir === 'lower' ? 'less' : 'more'}, ${x100(ratio)}×)</span>`
    : `<b class="warn">${x100(after)}${unit}</b> <span class="dim">(+${-pct}%)</span>`;
  return txt;
}

function waveCard(w) {
  const statusBadge = {
    merged: '<span class="badge good">merged</span>',
    'in-progress': '<span class="badge live">in progress</span>',
    planned: '<span class="badge">planned</span>',
    rejected: '<span class="badge bad">measured, rejected</span>',
    estimated: '<span class="badge est">expected (analytical)</span>',
  }[w.status] ?? '';
  const rows = (w.metrics ?? [])
    .map(
      (m) =>
        `<tr><td>${esc(m.name)}</td><td class="num">${x100(m.before)}${esc(m.unit ?? '')}</td><td class="num">${metric(m.before, m.after, m.unit ?? '', m.direction ?? 'lower')}</td></tr>`,
    )
    .join('');
  const tradeoffs = (w.tradeoffs ?? []).map((t) => `<li>${esc(t)}</li>`).join('');
  return `
  <div class="card" id="${esc(w.id)}">
    <div class="card-head">
      <span class="wave-id">${esc(w.id)}</span>
      <h3>${esc(w.name)}</h3>
      ${statusBadge}
      <span class="dim area">${esc(w.area)}</span>
    </div>
    <p class="change">${esc(w.change)}</p>
    ${rows ? `<table><tr><th>metric</th><th>before</th><th>after</th></tr>${rows}</table>` : ''}
    ${tradeoffs ? `<p class="dim">Tradeoffs / risks:</p><ul class="tradeoffs">${tradeoffs}</ul>` : ''}
    ${w.verified ? `<p class="verify">✓ ${esc(w.verified)}</p>` : ''}
    ${w.files ? `<p class="dim files">${w.files.map(esc).join(' · ')}</p>` : ''}
  </div>`;
}

const baselineRows = Object.entries(D.baseline?.sections ?? {})
  .map(([k, v]) => {
    const cells = Object.entries(v)
      .map(([kk, vv]) => `<td class="num">${x100(vv)}</td>`)
      .join('');
    return `<tr><td>${esc(k)}</td>${cells}</tr>`;
  })
  .join('');

const tldr = D.tldr ?? [];
const logRows = (D.log ?? [])
  .slice()
  .reverse()
  .map((l) => `<tr><td class="dim">${esc(l.t)}</td><td>${esc(l.entry)}</td></tr>`)
  .join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${D.campaign.refreshSeconds}">
<title>libby-archiver — perf trial ${esc(D.campaign.trialId)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, 'SF Pro Text', Helvetica, sans-serif; margin: 0; background: #101418; color: #dde4ea; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 20px 80px; }
  header { border-bottom: 1px solid #2a3440; padding-bottom: 14px; margin-bottom: 22px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 34px 0 10px; color: #9fb3c8; text-transform: uppercase; letter-spacing: .08em; }
  .sub { color: #8fa1b3; }
  .meta { color: #66788a; font-size: 13px; }
  .refresh-note { display: inline-block; margin-top: 8px; font-size: 12.5px; color: #59c98b; border: 1px solid #2c4a3b; border-radius: 6px; padding: 2px 10px; }
  .tldr { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0; }
  .stat { background: #171e26; border: 1px solid #2a3440; border-radius: 10px; padding: 12px 16px; min-width: 150px; }
  .stat b { display: block; font-size: 21px; color: #59c98b; }
  .stat span { color: #8fa1b3; font-size: 12.5px; }
  .card { background: #171e26; border: 1px solid #2a3440; border-radius: 10px; padding: 14px 18px; margin: 12px 0; }
  .card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .card h3 { font-size: 15.5px; margin: 0; }
  .wave-id { font-family: ui-monospace, monospace; font-size: 12px; color: #6f8497; }
  .area { margin-left: auto; font-size: 12px; }
  .change { margin: 8px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin: 10px 0; }
  th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid #232d38; }
  th { color: #8fa1b3; font-weight: 600; font-size: 12px; }
  .num { font-family: ui-monospace, monospace; }
  .good { color: #59c98b; }
  .warn { color: #e8b45a; }
  .bad { color: #e86a6a; }
  .dim { color: #8296a8; }
  .badge { font-size: 11px; border: 1px solid #3a4652; color: #9fb3c8; border-radius: 20px; padding: 1px 9px; vertical-align: middle; }
  .badge.good { border-color: #2c4a3b; color: #59c98b; }
  .badge.live { border-color: #4a3f2c; color: #e8b45a; }
  .badge.bad { border-color: #4a2c2c; color: #e86a6a; }
  .badge.est { border-color: #2c3f4a; color: #6ab8e8; }
  ul.tradeoffs { margin: 4px 0 8px; padding-left: 20px; }
  ul.tradeoffs li { margin: 2px 0; }
  .verify { color: #59c98b; font-size: 13px; margin: 6px 0 0; }
  .files { font-family: ui-monospace, monospace; font-size: 11.5px; margin: 8px 0 0; }
  footer { margin-top: 40px; border-top: 1px solid #2a3440; padding-top: 12px; color: #66788a; font-size: 12.5px; }
  code { background: #1d2630; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
</style>
</head>
<body>
<main>
<header>
  <h1>libby-archiver — performance trial <code>${esc(D.campaign.trialId)}</code></h1>
  <div class="sub">Continuous optimization campaign: speed, CPU, RAM, storage — library + CLI. Started ${esc(D.campaign.started)}.</div>
  <div class="meta">base commit ${esc(D.campaign.baseCommit)} · node ${esc(D.environment.node)} · ${esc(D.environment.cpu)}</div>
  <span class="refresh-note">⟳ this page refreshes itself every ${D.campaign.refreshSeconds / 60} min</span>
  <div class="tldr">
    ${tldr.map((s) => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}
  </div>
</header>

<h2>TL;DR</h2>
${(D.summary ?? []).map((p) => `<p>${p}</p>`).join('')}

<h2>Waves</h2>
${(D.waves ?? []).map(waveCard).join('')}

<h2>Baseline measurements (code at ${esc(D.campaign.baseCommit)})</h2>
<p class="dim">From <code>perf/results-baseline.json</code> — Apple M4, numbers are medians. A same-code rerun agrees within noise.</p>
<table>${baselineRows}</table>

<h2>How to adopt</h2>
${(D.adoption ?? []).map((p) => `<p>${p}</p>`).join('')}

<h2>Campaign log</h2>
<table>${logRows}</table>

<footer>Auto-generated by <code>perf/render.mjs</code> from <code>perf/report-data.json</code> · trial branches <code>${esc(D.campaign.trialId)}*</code> · report last rendered ${esc(D.rendered)}</footer>
</main>
</body>
</html>`;

const out = path.resolve(here, '..', 'PERF-REPORT.html');
fs.writeFileSync(out, html);
console.log('rendered', out);
