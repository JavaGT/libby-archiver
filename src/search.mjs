// Search a library's catalog via OverDrive's public Thunder API (no auth needed).
//
// GET thunder.api.overdrive.com/v2/libraries/{library}/media?query=...  returns catalog
// entries with availability. We normalize the bits worth showing before a checkout:
// title id, title/author, format, and whether a copy is available right now.

import https from 'node:https';

const THUNDER = 'thunder.api.overdrive.com';

// Format ids Thunder understands, grouped for the --format filter.
const FORMAT_GROUPS = {
  audiobook: ['audiobook-overdrive', 'audiobook-overdrive-provisional'],
  ebook: ['ebook-overdrive', 'ebook-media-do', 'ebook-overdrive-provisional'],
  magazine: ['magazine-overdrive'],
};

/**
 * Search the catalog.
 * @param {string} library   library key (advantage key), e.g. "your-library"
 * @param {string} query     free-text search
 * @param {object} [opts]    { format: 'audiobook'|'ebook'|'magazine'|'all', perPage, page, availableOnly, insecureTLS }
 * @returns {Promise<{total:number, items:SearchResult[]}>}
 */
export async function searchCatalog(library, query, opts = {}) {
  const { format = 'all', perPage = 20, page = 1, availableOnly = false, insecureTLS = false } = opts;

  const params = new URLSearchParams({
    query,
    perPage: String(perPage),
    page: String(page),
    'x-client-id': 'dewey',
  });
  if (format !== 'all' && FORMAT_GROUPS[format]) {
    params.set('format', FORMAT_GROUPS[format].join(','));
  }
  if (availableOnly) params.set('showOnlyAvailable', 'true');

  const path = `/v2/libraries/${encodeURIComponent(library)}/media?${params}`;
  const res = await getJson(THUNDER, path, insecureTLS);
  if (res.status !== 200) {
    throw new Error(`search failed: HTTP ${res.status}`);
  }
  const items = (res.json?.items ?? []).map(normalizeResult);
  return { total: res.json?.totalItems ?? items.length, items };
}

/** @typedef {{id:string,title:string,subtitle?:string,author?:string,type:string,available:boolean,availableCopies?:number,ownedCopies?:number,holds:number,year?:string}} SearchResult */

function normalizeResult(m) {
  return {
    id: String(m.id ?? m.reserveId),
    title: m.title,
    subtitle: m.subtitle,
    author: m.firstCreatorName,
    type: m.type?.id ?? 'unknown',
    available: !!m.isAvailable,
    availableCopies: m.availableCopies,
    ownedCopies: m.ownedCopies,
    holds: m.holdsCount ?? 0,
    year: m.publishDateText || (m.publishDate ? String(m.publishDate).slice(0, 4) : undefined),
    raw: m,
  };
}

function getJson(host, path, insecureTLS) {
  const agent = new https.Agent({ rejectUnauthorized: !insecureTLS });
  return new Promise((resolve, reject) => {
    https
      .get({ host, path, agent, headers: { Accept: 'application/json' } }, (res) => {
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
      })
      .on('error', reject);
  });
}
