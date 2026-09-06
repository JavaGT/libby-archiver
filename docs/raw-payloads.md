# Raw payload reference — every property we receive from OverDrive

This documents each wire payload libby-archiver receives, every property we have
identified in it, and **how confident we are that the identification is correct**.
It exists so the archive sidecars can be trusted for long-term archival, and so a
future maintainer knows which fields are load-bearing vs. incidental.

## Confidence legend

| Rating | Meaning |
|---|---|
| **very high** | Independently observed by **two** implementations: our production code (exercised by real archiving) *and* LibbyRip's live-page code (`perf/libbyrip-userscript.reference.js`), and/or byte-verified by deterministic tests. |
| **high** | Read by our production code on the real path and exercised by real archiving against the live service (load-bearing — a wrong guess would break archiving), or read by LibbyRip. Single source, but proven. |
| **medium** | Read by exactly one implementation in a code path **not** exercised end-to-end by tests (e.g. catalog-display-only fields), or a shape variant inferred from defensive handling code. |
| **low** | Inferred from naming conventions or third-party API knowledge; not directly evidenced in either codebase. Listed so the uncertainty is explicit. |

Evidence sources: our production code paths (`src/`), LibbyRip's userscript
(vendored at `perf/libbyrip-userscript.reference.js`, MIT, © PsychedelicPalimpsest),
deterministic e2e/sim fixtures, and community knowledge of the Thunder catalog API
(`x-client-id: dewey`). Test fixtures mirror our assumptions and are **not**
independent evidence.

**Live captures (2026-09-06):** the Thunder catalog is public, so §6–§8 (media
records, availability, search, characteristics) were verified against real
Auckland Libraries responses — 3 full media records, ~68 search-item records
(21-key→51-key superset), an availability batch, and stargazer characteristics.
Raw captures: `sample-data/thunder-catalog/` (gitignored). The loan-level payloads
(§2–§4) still need a captcha-passed card link to sample live.

Persistence rule: every payload below is stored **verbatim and complete** in a
sidecar (`passport.json`, `openbook.json`, `loan.json`, `thunder.json`) — so any
property this document misses still survives in the raw record. The confidence
ratings are about *identification*, not about whether the data is kept.

---

## 1. Auth identity — `POST /chip` family (ephemeral, never persisted)

Bearer identity JWT from the chip flow. We never persist it (session cache holds
it for the machine only).

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `identity` (JWT) | string; claims include a `chip` object | The session credential. Two claims are load-bearing: | very high |
| `chip.cards` | array \| null | Must be **non-null** for `open` to succeed (`missing_chip` otherwise). Linking a card does not update an existing token — a re-mint is required. | very high (empirical, see `src/auth.mjs` header, discovered 2026-07-08) |
| `chip.prbn` | `"v"` \| `"i"` | Must be `"v"`; `auth/link` alone yields `"i"` which `open` rejects — hence the clone dance. | high (empirical, same source) |
| error `result` | string, e.g. `missing_chip`, `whoa`, `client_upgrade_required` | OverDrive's failure reason, surfaced verbatim in errors. | very high |

## 2. `/chip/sync` account payload (ephemeral — not persisted)

Top-level shape: `{ loans: [...], cards: [...], … }`. Only `loans[]` is consumed;
**the account payload itself is discarded** (see §10 limitations).

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `loans` | array of loan records (§3) | Everything checked out on the card. | very high |
| `cards` | array | Card/library context for the account. Not read today. | medium (existence read-verified by `sync()` returning it; contents unenumerated) |
| *other siblings* | unknown | The sync response may carry more (settings, holds…). Untouched. | low |

## 3. Loan record → `loan.json` (secret, 0600)

One entry of `loans[]`. **Stored raw and complete** — the table lists properties
we have identified; anything undocumented still survives in the sidecar.

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `id` | string | Title/reserve id — the id used by every command. | very high |
| `cardId` | string | Card the loan is on. | very high |
| `title` / `subtitle` | string | Display title / subtitle. | very high |
| `firstCreatorName` | string | Primary author. | very high |
| `type` | `{ id: "audiobook" \| "ebook" \| "magazine" \| … }` | Routes to the right archiver; unknown ids stay unknown. | very high |
| `expires` | ISO date string | Loan expiry. | very high |
| `covers.cover510Wide / cover300Wide / cover150Wide` | `{ href }` | Cover variants; largest wins for download. | high |
| `overDriveFormat.id` | string | Format discriminator. | medium |
| `checkoutId` | string | Printed by `borrow`; identifies the checkout. | high |
| *undocumented fields* | — | Survive verbatim in `loan.json`. | n/a |

## 4. Passport — gateway `/open/<kind>/…` response → `passport.json` (secret, 0600)

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `urls.web` | URL — `https://dewey-<buid>.listen|.read.libbyapp.com/` | The per-loan listen/read host everything else is fetched from. | very high |
| `message` | query string | Signed handshake parameter that establishes the host session cookie. | very high |
| *everything else* | opaque JSON | Fulfilment details (expiry, ids). Never interpreted — stored raw. | low (schema undocumented by design) |

## 5. Openbook — decoded `window.eData` → `openbook.json`

The listen/read player page embeds `window.eData = [...]`; decode = join with `"`,
descramble with the reversed-`buid` key (`shift = (a+d) % 94`, wrap `>126 → %126+32`),
base64 → UTF-8 → JSON. **We keep only the payload's `.b` key** (see limitations, §10).

### Top level

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title.main` | string | Title. | very high |
| `title.subtitle` | string | Subtitle. | high |
| `creator[]` | `{ name, role }` — role like `author`, `narrator`, `pbl` | Creators; roles drive author/narrator/publisher extraction. | very high |
| `description` | string **or** `{ full, short }` | Description (HTML — cleaned for metadata.json). | very high (presence); medium ({full,short} variant) |
| `language` | string **or** string[] | Language(s). | high |
| `spine[]` | array of spine entries (below) | Ordered parts (audiobook) / pages (read). | very high |
| `nav.toc[]` | array of `{ title, path }` (below) | Chapter/page TOC. | very high |
| `-odread-cmpt-params[]` | string[] | Signed per-spine-position query params required to download parts. | high |
| `-odread-buid` | string | Book uid; used as the EPUB identifier. | medium |
| *siblings of `.b`* | unknown | LibbyRip's captures show the decode context also yields `objects.spool.components` (MP3 URL crypto), `objects.reader…components`, and a `root` XML document (cover reference). **Archived verbatim to `openbook-extra.json` whenever present**; shapes undocumented. | medium (their existence), low (exact shapes) |

### `spine[]` entry

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `path` | string (may carry a `#offset` fragment on toc paths) | Content path on the host. | very high |
| `-odread-original-path` | string | Original path; preferred for display/mapping. | high |
| `-odread-spine-position` | number | Ordering key (matches `-odread-cmpt-params` index). | high |
| `audio-duration` | number (seconds) | Part duration; summed into `durationSeconds`. | very high |
| `media-type` | string, e.g. `audio/mpeg` | Part media type. | very high |
| `-odread-file-bytes` | number | Exact byte size — verified against `Content-Length` on download. | high |
| `audio-bitrate` | number | Bitrate (LibbyRip reads it; we do not). | medium |
| `rendition-layout` | `"pre-paginated"` for magazines | Fixed-layout flag. | high |
| `rendition-viewport` | `{ width, height }` | Page viewport for fixed-layout rendering. | high |

### `nav.toc[]` entry

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title` | string | Chapter/page title. | very high |
| `path` | `"<file>#<offset>"` | TOC target; the **fragment is the chapter start time** (e.g. `0.00000-119.00000`), captured verbatim as `chapters[].offset`. | very high (existence); high (offset semantics — LibbyRip parses it identically) |

## 6. Thunder media record — `GET thunder…/media/{id}` → `thunder.json` (if 200)

Catalog-side metadata, independent of the loan. Fetch failure is tolerated
(`null`) and never fails an archive. **Live-verified 2026-09-06 against Auckland
Libraries: a full record carries 51 top-level keys** (grouped below). Search
items (`/media?query=…`) carry the identical 51-key shape.

### Identity & catalog text

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `id` / `reserveId` | string | Title id (same id every command uses). | very high |
| `title` / `subtitle` | string | Catalog title / subtitle. | very high |
| `sortTitle` | string | Sort-formatted title. | very high |
| `firstCreatorId` / `firstCreatorName` / `firstCreatorSortName` | string | Primary creator fields. | very high |
| `creators[]` | `{ id, intelligenceType, name, role, roleDiscipline, sortName }` | Full creator list; `role` drives author/narrator extraction. | very high (keys); medium (`intelligenceType`, `roleDiscipline` semantics) |
| `description` | string (HTML) | Catalog description. | very high |
| `type` | `{ id, name }` | Format family (`audiobook`, `ebook`, `magazine`). | very high |
| `languages[]` | `{ id, name }` | Languages. | very high |
| `publishDate` / `publishDateText` / `estimatedReleaseDate` | string/number | Publication / release dates. | very high (keys); medium (exact formats per field) |
| `imprint` | `{ id, name }` | Imprint. | very high (keys) |
| `starRating` / `starRatingCount` | number | Aggregate community rating. | very high (keys) |
| `ratings` | `{ maturityLevel, naughtyScore }` | Internal content ratings. | medium (semantics inferred) |
| `reviewCounts` | `{ premium, publisherSupplier }` | Review counts by source. | medium (semantics inferred) |

### Classification

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `subjects[]` | `{ id, name }` | Subject tags → `metadata.json.subjects`. | very high |
| `levels[]` | `{ id, name, value }` | Reading/interest levels. | very high (keys); low (value scale) |
| `bisac[]` / `bisacCodes` | `{ code, description }` / string[] | BISAC subject codes. | very high (keys) |
| `classifications` | object (empty in captures) | Classification block; rarely populated. | low |

### Formats & media

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `formats[]` | array, one per offered format | Keys observed: `id`, `name`, `isbn`, `identifiers[]`, `fulfillmentType`, `hasAudioSynchronizedText`, `isBundleParent`, `bundledContent`, `onSaleDateUtc`, `rights`, `sample`. | very high (keys); medium (`rights`, `bundledContent` semantics) |
| `formats[].identifiers[]` | `{ type: "ISBN", value }` | Isbns → `metadata.json.isbns`. | very high |
| `covers{}` | `cover150Wide` / `cover300Wide` / `cover510Wide`, each `{ href, … }` | Cover variants; widest wins. | very high |
| `sample` | `{ href }` | Excerpt link. | very high |
| `constraints` | `{ isDisneyEulaRequired }` | Licensing constraints. | medium |
| `contentAccessLevels` | number | Access-level bitmask. | low |

### Availability (inline — mirrors §7)

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `isAvailable`, `availableCopies`, `ownedCopies`, `luckyDayAvailableCopies`, `luckyDayOwnedCopies`, `holdsCount`, `holdsRatio`, `estimatedWaitDays`, `estimatedReleaseDate`, `availabilityType` | number/string | Live availability snapshot. | very high (keys), high (semantics) |
| `isHoldable`, `isFastlane`, `isOwned`, `isPreReleaseTitle`, `isRecommendableToLibrary`, `isRestricted`, `isAdvantageFiltered`, `isBundledChild`, `juvenileEligible`, `youngAdultEligible`, `visitorEligible` | bool | Entitlement/eligibility flags. | very high (keys); low–medium (individual semantics inferred from names) |

## 7. Availability record — `POST thunder…/media/availability` (ephemeral; `libby avail`)

Batch response: `{ items: [...] }` — live-verified 2026-09-06: each item carries
**23 keys** (the availability subset above, minus catalog text, plus
`estimatedReleaseDate`, `luckyDayOwnedCopies`, `isOwned`, `visitorEligible`,
`juvenileEligible`, `youngAdultEligible`, `contentAccessLevels`, `formats`). All
keys very high (existence); per-flag semantics as noted in §6.

## 7b. Catalog search response — `GET thunder…/media?query=…` (ephemeral; `libby search`)

Top level: `facets`, `items`, `links`, `queryKeys`, `sortOptions`, `totalItems`,
`totalItemsText`. **`items[]` are full 51-key media records** (identical to §6) —
so `libby search` already receives everything §6 documents.

## 7c. Stargazer characteristics — `GET stargazer…/{lib}/characteristics/title/{id}`

Live-verified shape:

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title_id` | string | Echoes the requested id. | very high |
| `matches` | number | How many characteristic entries matched. | very high |
| `characteristics` | nested `{ category: { subkey: { emoji: word } } }` — e.g. `fiction → adults → { "🛸": "cosmic", … }` | Emoji-keyed tag tree; `getCharacteristics` flattens it to the word strings. | very high (shape), high (semantics) |

## 8. Read-host page — `parent.__bif_cfc1(self, '<blob>')` → `pages/` + EPUB

Not JSON: the page body is a single call whose blob is base64 with base64
characters swapped 1↔4 per 4-char group. Deciphered body is XHTML/SVG markup
referencing `../assets/…` scans. | very high (two independent implementations decode it;
equivalence pinned by tests + drift canaries).

## 9. Never persisted (accepted limitations)

- **HTTP response metadata** per file (final redirected URL, `Content-Type`,
  `ETag`, `Last-Modified`): signed URLs expire with the loan, so archival value is
  low. Byte size *is* enforced per part (`-odread-file-bytes` / `Content-Length`).
- **`/chip/sync` account payload** (§2): only per-loan records survive.
- ~~Openbook siblings of `.b`~~ — now captured verbatim to `openbook-extra.json`
  whenever the payload carries them (common case: file absent).

## 10. Drift

Every decode contract above is covered by named-stage canaries (`probeEData`,
`probeCfc1`, `libby probe saved-page.html`): if OverDrive changes a format, the
failure names the broken contract instead of producing garbage. See
README → *Obfuscation drift*.
