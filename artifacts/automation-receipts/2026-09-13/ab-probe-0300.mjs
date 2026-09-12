// 0300-run 2026-09-13: #16 closure A/B — does `libby return <fake-id>` still pay a
// marginal /chip/sync round trip beyond `libby auth` on the current (#17-landed) tree?
// Methodology per perf/lanes/T6-W1 + T7-W1: spawnSync wall-clock medians, 9
// interleaved base-vs-after rounds (order swapped per round), one untimed warmup per
// side, real config via a COPY under an isolated XDG_CONFIG_HOME, session COPY via
// --session (cached path never rewrites it), per-side stdout/stderr byte-identical
// assertions, owner config/session shasum-verified untouched, temp dir removed after.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('../../..', import.meta.url).pathname);
const realDir = path.join(process.env.HOME, '.config', 'libby-archiver');
const ownerCfg = fs.readFileSync(path.join(realDir, 'config.json'));
const ownerSes = fs.readFileSync(path.join(realDir, 'session.json'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const before = { cfg: sha(ownerCfg), ses: sha(ownerSes), mtimeCfg: fs.statSync(path.join(realDir, 'config.json')).mtimeMs, mtimeSes: fs.statSync(path.join(realDir, 'session.json')).mtimeMs };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-0300-ab-'));
const cfgDir = path.join(tmp, 'libby-archiver');
fs.mkdirSync(cfgDir);
fs.copyFileSync(path.join(realDir, 'config.json'), path.join(cfgDir, 'config.json'));
const sessionCopy = path.join(cfgDir, 'session.copy.json');
fs.copyFileSync(path.join(realDir, 'session.json'), sessionCopy);

const env = { ...process.env, XDG_CONFIG_HOME: tmp };
const run = (args) => spawnSync(process.execPath, [path.join(repo, 'bin/libby.mjs'), ...args, '--session', sessionCopy], { env, encoding: 'utf8', cwd: tmp });

const scenarios = {
  auth: { args: ['auth'], wantCode: 0 },
  ret: { args: ['return', 'fakeid0300probe'], wantCode: 1 },
};
const rounds = 9;
const samples = { auth: [], ret: [] };
const outputs = { auth: [], ret: [] };

for (const s of Object.values(scenarios)) run(s.args); // untimed warmup, one per side

for (let i = 0; i < rounds; i++) {
  const order = i % 2 === 0 ? ['auth', 'ret'] : ['ret', 'auth'];
  for (const key of order) {
    const s = scenarios[key];
    const t0 = performance.now();
    const r = run(s.args);
    const ms = performance.now() - t0;
    if (r.status !== s.wantCode) { console.error(`UNEXPECTED exit ${r.status} (want ${s.wantCode}) for ${key}: ${r.stderr?.slice(0, 300)}`); process.exitCode = 1; }
    outputs[key].push(`${r.stdout}\u0000${r.stderr}`);
    samples[key].push(ms);
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];
const identical = (xs) => new Set(xs).size === 1;
const mAuth = med(samples.auth), mRet = med(samples.ret);
console.log(JSON.stringify({
  date: new Date().toISOString(),
  rounds, warmups: 'one untimed per side',
  auth: { median_ms: Math.round(mAuth * 10) / 10, all: samples.auth.map((x) => Math.round(x)), stdout_stderr_identical: identical(outputs.auth) },
  return_fake_id: { median_ms: Math.round(mRet * 10) / 10, all: samples.ret.map((x) => Math.round(x)), stdout_stderr_identical: identical(outputs.ret) },
  marginal_delta_ms: Math.round((mRet - mAuth) * 10) / 10,
}, null, 2));

const afterCfgM = fs.statSync(path.join(realDir, 'config.json')).mtimeMs;
const afterSesM = fs.statSync(path.join(realDir, 'session.json')).mtimeMs;
const after = { cfg: sha(fs.readFileSync(path.join(realDir, 'config.json'))), ses: sha(fs.readFileSync(path.join(realDir, 'session.json'))) };
const untouched = after.cfg === before.cfg && after.ses === before.ses && afterCfgM === before.mtimeCfg && afterSesM === before.mtimeSes;
console.log(`owner config/session sha256-prefix+mtime untouched: ${untouched}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (!identical(outputs.auth) || !identical(outputs.ret) || !untouched) process.exitCode = 1;
