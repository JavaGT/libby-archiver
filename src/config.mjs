// Configuration: pure path + read/write helpers.
//
// Config lives in the user's config dir (~/.config/libby-archiver/config.json by
// default, honoring XDG_CONFIG_HOME) so the CLI works from anywhere. A local
// ./config.json in the working directory takes precedence when present, which is handy
// for development or per-project setups. The session cache sits next to the config.
// Network-side library discovery lives in ./library.mjs (#5), so light commands can
// load config without paying for the https/sentry/http import graph.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './util.mjs';

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
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return file;
}
