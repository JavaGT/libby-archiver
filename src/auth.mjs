// Browser-free authentication for Libby/OverDrive.
//
// The tricky part is getting an identity token that `open` will accept. Two properties
// of the chip's identity JWT matter, discovered empirically (2026-07-08):
//
//   1. chip.cards must be NON-NULL  -> else `open` returns 403 missing_chip.
//      A fresh `POST /chip` yields cards:null. Linking a card server-side does NOT
//      update the token you already hold; you must RE-MINT the identity afterwards
//      (`POST /chip?...&v=<chipId>`), which bakes the linked cards into the new token.
//
//   2. chip.prbn should be "v"      -> direct `auth/link` yields prbn:"i"; the clone
//      path (this device consuming a sync code from a "primary") yields prbn:"v",
//      which is what the browser uses. We therefore bootstrap our own primary via
//      auth/link, mint a sync code from it, and clone it into a second chip.
//
// The whole thing needs only a library card number (many library cards have no PIN).
//
// A successful session (the final re-minted identity + cardId) is cached to disk so
// subsequent runs skip the bootstrap until the token expires.

import fs from 'node:fs';
import path from 'node:path';
import { SentryClient, decodeJwt, CLIENT_VERSION, READ_HOST } from './sentry.mjs';

const mintQuery = () => `c=d%3A${CLIENT_VERSION}&s=0`;

/**
 * @param {object} cfg
 * @param {string} cfg.library      OverDrive advantage key, e.g. "your-library"
 * @param {string} cfg.websiteId    numeric website id, e.g. "123"
 * @param {string} cfg.cardNumber   library card number (username)
 * @param {string} [cfg.pin]        card PIN/password ("" if none)
 * @param {string} [cfg.sessionFile] where to cache the session
 * @param {boolean} [cfg.insecureTLS]
 * @param {(msg:string)=>void} [cfg.log]
 */
export async function authenticate(cfg) {
  const log = cfg.log ?? (() => {});
  const client = new SentryClient({ host: READ_HOST, insecureTLS: cfg.insecureTLS });

  // 1. Reuse a cached session if its token is still valid.
  const cached = loadSession(cfg.sessionFile);
  if (cached && !isExpired(cached.identity)) {
    log('Reusing cached session.');
    const ok = await verify(client, cached.identity);
    if (ok) return { client, identity: cached.identity, cardId: cached.cardId };
    log('Cached session no longer valid; re-bootstrapping.');
  }

  // 2. Bootstrap a fresh, open-capable identity from the card number alone.
  log('Minting primary chip...');
  const chipA = await mintChip(client);
  await linkCard(client, chipA.identity, cfg);

  log('Generating sync code from primary...');
  const code = await mintSyncCode(client, chipA.identity);

  log('Cloning into a secondary chip...');
  const chipB = await mintChip(client);
  await cloneByCode(client, chipB.identity, code);

  log('Re-minting identity to embed linked cards...');
  const identity = await remint(client, chipB.identity, chipB.chip);

  const claims = decodeJwt(identity);
  const cards = claims?.chip?.cards ?? [];
  if (!cards.length) {
    throw new Error('Re-mint produced a token with no cards; cannot open loans.');
  }
  const cardId = cards[0][1]; // [puid, cardId, ?, isSessionUser, websiteId, library]
  log(`Authenticated. cardId=${cardId} prbn=${claims?.chip?.prbn} cards=${cards.length}`);

  saveSession(cfg.sessionFile, { identity, cardId, savedAt: Date.now() });
  return { client, identity, cardId };
}

async function mintChip(client) {
  const res = await client.requestOk('POST', `/chip?${mintQuery()}`);
  return { chip: res.json.chip, identity: res.json.identity };
}

async function linkCard(client, identity, cfg) {
  await client.requestOk('POST', `/auth/link/${cfg.websiteId}`, {
    bearer: identity,
    body: { ils: cfg.library, username: cfg.cardNumber, password: cfg.pin ?? '' },
  });
}

async function mintSyncCode(client, identity) {
  const res = await client.requestOk('GET', '/chip/clone/code?role=primary', {
    bearer: identity,
  });
  if (!res.json?.code) throw new Error('No sync code returned.');
  return res.json.code;
}

async function cloneByCode(client, identity, code) {
  await client.requestOk('POST', '/chip/clone/code', {
    bearer: identity,
    body: { code, role: 'secondary' },
  });
}

/** Re-mint the identity for an existing chip so the new token embeds its linked cards. */
async function remint(client, identity, chipId) {
  const res = await client.requestOk('POST', `/chip?${mintQuery()}&v=${chipId.slice(0, 8)}`, {
    bearer: identity,
  });
  return res.json.identity;
}

async function verify(client, identity) {
  try {
    const res = await client.request('GET', '/chip/sync', { bearer: identity });
    return res.status === 200 && res.json?.result === 'synchronized';
  } catch {
    return false;
  }
}

function isExpired(identity, skewSeconds = 300) {
  const claims = decodeJwt(identity);
  if (!claims?.exp) return true;
  return Date.now() / 1000 > claims.exp - skewSeconds;
}

function loadSession(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(file, data) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  fs.chmodSync(file, 0o600); // token is a credential
}
