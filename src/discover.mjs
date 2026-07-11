// Discovery helpers on OverDrive's public Thunder catalog (no auth needed):
//
//   GET  thunder…/v2/libraries/{library}/media/{id}          full title detail
//   POST thunder…/v2/libraries/{library}/media/availability  real-time availability, batched
//   GET  stargazer-cache…/{library}/characteristics/title/{id}  themes/mood tags
//
// `searchCatalog` (search.mjs) already returns the availability baked into a search
// response, but that snapshot can be stale; `getAvailability` is the authoritative,
// on-demand check (copies, holds, and estimated wait). `getTitle` is the "inspect before
// you borrow" detail view.

import https from 'node:https';

const THUNDER = 'thunder.api.overdrive.com';
const STARGAZER = 'stargazer-cache.libbyapp.com';

/**
 * Real-time availability for one or more titles.
 * @param {string} library   library key
 * @param {string|string[]} ids
 * @returns {Promise<Availability[]>} one entry per id (order not guaranteed; match on `id`)
 */
export async function getAvailability(library, ids, { insecureTLS = false } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String);
  if (!list.length) return [];
  const path = `/v2/libraries/${encodeURIComponent(library)}/media/availability?x-client-id=dewey`;
  const res = await postJson(THUNDER, path, { ids: list }, insecureTLS);
  if (res.status !== 200) throw new Error(`availability failed: HTTP ${res.status}`);
  const items = res.json?.items ?? (Array.isArray(res.json) ? res.json : []);
  return items.map(normalizeAvailability);
}

/** @typedef {{id:string,available:boolean,availableCopies:number,ownedCopies:number,luckyDayAvailableCopies:number,holds:number,holdsRatio:number,estimatedWaitDays:number,isHoldable:boolean,isFastlane:boolean,availabilityType:string}} Availability */
function normalizeAvailability(a) {
  return {
    id: String(a.id ?? a.reserveId),
    available: !!a.isAvailable,
    availableCopies: a.availableCopies ?? 0,
    ownedCopies: a.ownedCopies ?? 0,
    luckyDayAvailableCopies: a.luckyDayAvailableCopies ?? 0,
    holds: a.holdsCount ?? 0,
    holdsRatio: a.holdsRatio ?? 0,
    estimatedWaitDays: a.estimatedWaitDays ?? 0,
    isHoldable: !!a.isHoldable,
    isFastlane: !!a.isFastlane,
    availabilityType: a.availabilityType,
    raw: a,
  };
}

/**
 * Full catalog detail for a single title, optionally enriched with characteristics.
 * @returns {Promise<TitleDetail>}
 */
export async function getTitle(library, id, { insecureTLS = false, characteristics = true } = {}) {
  const path = `/v2/libraries/${encodeURIComponent(library)}/media/${encodeURIComponent(id)}?x-client-id=dewey`;
  const res = await getJson(THUNDER, path, insecureTLS);
  if (res.status !== 200) throw new Error(`title lookup failed: HTTP ${res.status}`);
  const detail = normalizeTitle(res.json);
  if (characteristics) {
    try {
      detail.characteristics = await getCharacteristics(library, id, { insecureTLS });
    } catch {
      detail.characteristics = [];
    }
  }
  return detail;
}

/** Flatten the emoji-keyed characteristics tree into a list of descriptive tags. */
export async function getCharacteristics(library, id, { insecureTLS = false } = {}) {
  const path = `/${encodeURIComponent(library)}/characteristics/title/${encodeURIComponent(id)}`;
  const res = await getJson(STARGAZER, path, insecureTLS);
  if (res.status !== 200) return [];
  const tags = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') tags.add(v); // emoji -> word
      else walk(v);
    }
  };
  walk(res.json?.characteristics);
  return [...tags];
}

/** @typedef {{id:string,title:string,subtitle?:string,author?:string,creators:{name:string,role:string}[],type:string,publisher?:string,year?:string,edition?:string,languages:string[],description?:string,subjects:string[],formats:string[],isbns:string[],starRating?:number,starRatingCount?:number,sampleUrl?:string,availability:object,characteristics?:string[]}} TitleDetail */
function normalizeTitle(m) {
  const creators = (m.creators ?? []).map((c) => ({ name: c.name, role: c.role }));
  return {
    id: String(m.id ?? m.reserveId),
    title: m.title,
    subtitle: m.subtitle,
    author: m.firstCreatorName,
    creators,
    type: m.type?.id ?? 'unknown',
    publisher: m.publisher?.name ?? m.publisherAccount?.name,
    year: m.publishDateText || (m.publishDate ? String(m.publishDate).slice(0, 4) : undefined),
    edition: m.edition,
    languages: (m.languages ?? []).map((l) => l.name ?? l.id ?? l),
    description: cleanHtml(m.description),
    subjects: (m.subjects ?? []).map((s) => s.name),
    formats: [...new Set((m.formats ?? []).map((f) => f.id))],
    isbns: extractIsbns(m.formats),
    starRating: m.starRating,
    starRatingCount: m.starRatingCount,
    sampleUrl: (m.sample?.href ?? m.sample?.url) || undefined,
    availability: {
      available: !!m.isAvailable,
      availableCopies: m.availableCopies ?? 0,
      ownedCopies: m.ownedCopies ?? 0,
      holds: m.holdsCount ?? 0,
      estimatedWaitDays: m.estimatedWaitDays ?? 0,
      isHoldable: !!m.isHoldable,
    },
    raw: m,
  };
}

function extractIsbns(formats = []) {
  const out = [];
  for (const f of formats) for (const id of f.identifiers ?? []) {
    if (/ISBN/i.test(id.type ?? '')) out.push(id.value);
  }
  return [...new Set(out)];
}

function cleanHtml(desc) {
  const raw = typeof desc === 'string' ? desc : desc?.full ?? desc?.short;
  if (!raw) return undefined;
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// ---- tiny JSON HTTP helpers (self-contained, mirrors search.mjs) ----------------

function getJson(host, path, insecureTLS) {
  const agent = new https.Agent({ rejectUnauthorized: !insecureTLS });
  return new Promise((resolve, reject) => {
    https
      .get({ host, path, agent, headers: { Accept: 'application/json' } }, (res) => collect(res, resolve))
      .on('error', reject);
  });
}

function postJson(host, path, body, insecureTLS) {
  const data = JSON.stringify(body);
  const agent = new https.Agent({ rejectUnauthorized: !insecureTLS });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: 'POST',
        agent,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Origin: 'https://libbyapp.com',
        },
      },
      (res) => collect(res, resolve),
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function collect(res, resolve) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    resolve({ status: res.statusCode, json, text });
  });
}
