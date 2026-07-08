// Configuration + library discovery.
//
// Config lives in the user's config dir (~/.config/libby-archiver/config.json by
// default, honoring XDG_CONFIG_HOME) so the CLI works from anywhere. A local
// ./config.json in the working directory takes precedence when present, which is handy
// for development or per-project setups. The session cache sits next to the config.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { READ_HOST } from './sentry.mjs';

const APP = 'libby-archiver';

/** ~/.config/libby-archiver (or $XDG_CONFIG_HOME/libby-archiver, or %APPDATA%). */
export function configDir() {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === 'win32' && process.env.APPDATA) ||
    path.join(os.homedir(), '.config');
  return path.join(base, APP);
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

export function sessionPath() {
  return path.join(configDir(), 'session.json');
}

/** The local ./config.json, if the user keeps one in the working directory. */
function localConfigPath() {
  return path.join(process.cwd(), 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load persisted config. Local ./config.json (if any) overrides the user config file.
 * Returns {} if nothing is configured yet.
 */
export function loadConfig() {
  const user = readJson(configPath()) ?? {};
  const local = readJson(localConfigPath()) ?? {};
  return { ...user, ...local };
}

/** Persist config to the user config dir (chmod 600 — may hold a card number). */
export function saveConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Resolve a library's numeric websiteId and canonical name from its Libby key
 * (the "your-library" in libbyapp.com/library/your-library, or your library's share links).
 * Uses OverDrive's public Thunder catalog — no auth required.
 * @returns {Promise<{key:string,name:string,websiteId:string}>}
 */
export function resolveLibrary(key, { insecureTLS = false } = {}) {
  const clean = String(key).trim().toLowerCase();
  const agent = new https.Agent({ rejectUnauthorized: !insecureTLS });
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: 'thunder.api.overdrive.com',
          path: `/v2/libraries/${encodeURIComponent(clean)}`,
          agent,
          headers: { Accept: 'application/json' },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 404) {
              return reject(
                new Error(
                  `No library found for key "${clean}". Use the slug from your ` +
                    `libbyapp.com library URL (e.g. "your-library").`,
                ),
              );
            }
            let j;
            try {
              j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              return reject(new Error(`Unexpected response resolving "${clean}".`));
            }
            if (!j?.websiteId) {
              return reject(new Error(`Library "${clean}" has no websiteId in the catalog.`));
            }
            resolve({
              key: j.preferredKey || clean,
              name: j.name || clean,
              websiteId: String(j.websiteId),
            });
          });
        },
      )
      .on('error', reject);
  });
}

/**
 * Detect whether the OverDrive read edge on this network presents a mismatched
 * certificate (some edges serve *.odrsre.overdrive.com). If a strict TLS HEAD fails
 * with a cert-name error but an insecure one succeeds, callers should set insecureTLS.
 * @returns {Promise<boolean>} true if insecure TLS is required to reach the API.
 */
export function detectInsecureTLS() {
  const probe = (rejectUnauthorized) =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: READ_HOST,
          path: '/chip',
          method: 'HEAD',
          rejectUnauthorized,
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve({ ok: true });
        },
      );
      req.on('error', (e) => resolve({ ok: false, code: e.code }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, code: 'ETIMEDOUT' });
      });
      req.end();
    });

  return probe(true).then((strict) => {
    if (strict.ok) return false;
    if (strict.code && /ALTNAME|CERT|TLS/i.test(strict.code)) {
      return probe(false).then((insecure) => insecure.ok === true);
    }
    return false; // some other failure — don't silently weaken TLS
  });
}
