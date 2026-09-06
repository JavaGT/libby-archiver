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

**Live captures (2026-09-06/07):** the Thunder catalog (§6–§8) was verified against
real Auckland Libraries responses (3 full media records + 68 search items, an
availability batch, stargazer characteristics), then **field-by-field audited** —
every key in the captures is accounted for below. The loan-level payloads
(§2–§5) were live-verified on 2026-09-07 the same way: one magazine loan captured
end-to-end (sync, loan, passport, player page, openbook + siblings, thunder),
with the `probeEData` drift canary passing **all four stages** on the real player
page. Card linking from this machine's datacenter IP triggers OverDrive's
`captcha_required`; the collector works after linking once in a real browser
(`perf/collect-payloads.mjs` reuses the cached session — see §1). Raw captures:
`sample-data/` (gitignored; contains account data).

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
| error `captcha_required` (HTTP 401, upstream `CaptchaRequired` from service `OPAS`) | — | **`/auth/link` demands a reCAPTCHA when the request comes from an IP OverDrive's risk engine distrusts** (observed 2026-09-07 from a NZ datacenter ASN; residential connections link without one). The web client routes the same gate through `sentry.libbyapp.com/auth/captcha` (reCAPTCHA v2). Linking once in a real browser and copying the cached session (`~/.config/libby-archiver/session.json`) bridges the CLI past it — the session is per (library, card) and reused while the JWT is unexpired. | very high (observed) |

## 2. `/chip/sync` account payload (ephemeral — not persisted)

Top-level shape (live-verified 2026-09-07): `{ loans, cards, holds, result,
stashes, summary }`. Only `loans[]` is consumed; **the account payload itself is
discarded** (see §9 limitations).

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `loans` | array of loan records (§3) | Everything checked out on the card. | very high |
| `cards` | array of card records | Card/library context. Live record keys (20): `accounts, advantageKey, allowReadingHistorySince, authorizeDate, canPlaceHolds, canRecommendTitles, cardId, cardName, contentMask, counts, createDate, ilsName, isSessionUser, isVisitingCard, lendingPeriods, library, limits, publicLibraryMaturity, puid, username`. | very high (keys) |
| `holds` | array of hold records (56 keys each) | Titles on hold. Notable beyond §6 availability keys: `autoCheckoutFlag`, `autoRenewFlag`, `holdListPosition`, `placedDate`, `suspensionEnd`, `suspensionFlag`, `redeliveriesAutomatedCount`, `redeliveriesRequestedCount`, `otherFormats`. | very high (keys) |
| `result` | `"synchronized"` | Sync outcome string. | very high |
| `stashes` | object (empty in capture) | Saved-search/UI stash container. | medium (semantics) |
| `summary` | `{ [cardId]: { cards, loans, holds } }` — values like `"done"` | Per-card sync status rollup. | very high (shape), medium (value set) |

## 3. Loan record → `loan.json` (secret, 0600)

One entry of `loans[]`. **Stored raw and complete** — live-verified 2026-09-07
with a full key enumeration (49 keys on a magazine loan, grouped below); anything
undocumented still survives in the sidecar.

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `id` | string | Title/reserve id — the id used by every command. | very high |
| `cardId` / `websiteId` / `privateAccountId` | string | Card, library site, and hidden account ids the loan belongs to. | very high (keys) |
| `title` / `subtitle` / `sortTitle` / `series` / `edition` | string | Display text (mirrors §6 fields). | very high |
| `firstCreatorName` / `firstCreatorId` | string | Primary author. | very high |
| `type` | `{ id: "audiobook" \| "ebook" \| "magazine" \| … }` | Routes to the right archiver; unknown ids stay unknown. | very high |
| `overDriveFormat` / `readiverseFormat` / `formats` / `otherFormats` / `bundledContent` / `bundledContentTitleIds` | format objects/arrays | Format discriminators and bundle membership (`overDriveFormat.id` e.g. `magazine-overdrive`). | very high (keys) |
| `expires` / `expireDate` / `checkoutDate` / `checkoutId` / `loanStamp` / `renewableOn` | dates/string | Checkout lifecycle (`checkoutId` printed by `borrow`; `renewableOn` gates renewal). | very high (keys) |
| `covers` | cover variants `{ href, … }` | Cover images (largest wins for download). | very high |
| `availabilityType`, `availableCopies`, `ownedCopies`, `luckyDayAvailableCopies`, `luckyDayOwnedCopies`, `holdsCount`, `holdsRatio`, `estimatedWaitDays`, `estimatedReleaseDate` | number/string | §6 availability snapshot, inlined. | very high (keys) |
| `isHoldable`, `isAdvantageFiltered`, `isAssigned`, `isBundledChild`, `isFormatLockedIn`, `isLuckyDayCheckout`, `isOwned`, `isReturnable` | bool | Entitlement/eligibility flags. | very high (keys); low–medium (individual semantics from names) |
| `publishDate` / `publishDateText` | string/number | Publication date (mirrors §6). | very high (keys) |
| `publisherAccount` / `ratings` / `constraints` / `sample` / `languages` / `subjects` | §6-shaped | Catalog mirrors inside the loan record. | very high (keys) |
| `pages` / `frequency` / `parentMagazineTitleId` / `reservedContentBundleCodeId` | number/string | Magazine-specific: page count, issue frequency, parent title linkage. | very high (keys); medium (semantics) |
| `reserveId` | string | Alternative id echoed by Thunder. | very high (keys) |

## 4. Passport — gateway `/open/<kind>/…` response → `passport.json` (secret, 0600)

Live shape (2026-09-07): four top-level keys.

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `urls.web` | URL — `https://dewey-<buid>.listen|.read.libbyapp.com/` | The per-loan listen/read host everything else is fetched from. | very high |
| `message` | query string | Signed handshake parameter that establishes the host session cookie. | very high |
| `expires` | date string | Fulfilment expiry for the open-loan grant. | very high (key), medium (semantics) |
| `bankscope` | object | Redemption/scope context echoed by the gateway. | medium (key observed, contents opaque) |

## 5. Openbook — decoded `window.eData` → `openbook.json`

The listen/read player page embeds `window.eData = [...]`; decode = join with `"`,
descramble with the reversed-`buid` key (`shift = (a+d) % 94`, wrap `>126 → %126+32`),
base64 → UTF-8 → JSON. The decoded root is `{ b, t, u }` (see siblings below);
**we keep `.b` as `openbook.json`** and archive `t`/`u` verbatim to
`openbook-extra.json`. Live-verified 2026-09-07 against a magazine loan: `.b`
carries **26 top-level keys**, all listed below.

### Top level

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title.main` / `title.subtitle` | string | Title / subtitle. | very high |
| `creator[]` | `{ name, role }` — role like `author`, `narrator`, `pbl` | Creators; roles drive author/narrator/publisher extraction. | very high |
| `description` | `{ full, short? }` — HTML (string variant also accepted) | Description (cleaned for metadata.json). `{full}` variant live-verified. | very high |
| `language` | string (`"en"`) or string[] | Language(s). | very high |
| `spine[]` | array of spine entries (below) — 129 entries ↔ 129 `-odread-cmpt-params` on the live capture | Ordered parts (audiobook) / pages (read). | very high |
| `nav` | `{ toc[], "sequence:fixed", "sequence:mixed" }` | TOC plus sequence declarations. | very high (toc); medium (sequence semantics) |
| `-odread-cmpt-params[]` | string[] | Signed per-spine-position query params required to download parts. | very high |
| `-odread-buid` | string | Book uid; used as the EPUB identifier. | very high |
| `cover.front` | `{ media-type, -odread-file-bytes, -odread-width, -odread-height, -odread-aspect-ratio, -odread-color: [r,g,b], -odread-file-last-modified }` | Embedded cover manifest (asset fetched from the host; pixels not inlined). | very high |
| `-odread-uilinks` | `{ HELPCOMPAT: url }` | UI help links. | very high (keys) |
| `i18n-page-progression-direction` | `"ltr"` \| `"rtl"` | Reading direction. | very high |
| `rendition-format` | `"ebook"` \| … | Rendition family (reflows vs fixed-layout). | high |
| `-odread-anchor`, `-odread-bank-scope`, `-odread-bank-verification-token`, `-odread-bonafides-{d,m,p,s}`, `-odread-cover-color`, `-odread-cover-ratio`, `-odread-crid`, `-odread-furbish-uri`, `-odread-msg-access`, `-odread-msg-expires`, `-odread-msg-sync` | opaque strings/numbers | Fulfilment/crypto context carried beside the content (bank verification, message access tokens, cover tint). Not interpreted — but they live **inside `.b`**, so they are stored in `openbook.json` verbatim. | medium (keys), low (semantics) |

### `spine[]` entry

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `path` | string (may carry a `#offset` fragment on toc paths) | Content path on the host. | very high |
| `-odread-original-path` | string | Original path; preferred for display/mapping. | very high |
| `-odread-spine-position` | number | Ordering key (matches `-odread-cmpt-params` index). | very high |
| `audio-duration` | number (seconds) | Part duration; summed into `durationSeconds` (audiobooks). | very high |
| `media-type` | string, e.g. `application/xhtml+xml`, `audio/mpeg` | Part media type. | very high |
| `-odread-file-bytes` | number | Exact byte size — verified against `Content-Length` on download. | very high |
| `linear` | bool | EPUB linear flag (live-verified on magazine spine). | very high (key) |
| `rendition-layout` | `"pre-paginated"` for magazines | Fixed-layout flag. | very high |
| `rendition-position` | `"right"` \| … | Page position in spreads. | medium (key; semantics from names) |
| `rendition-viewport` | `{ width, height }` | Page viewport for fixed-layout rendering. | very high |
| `audio-bitrate` | number | Bitrate (LibbyRip reads it; we do not). | medium |

### `nav.toc[]` entry

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title` | string | Chapter/page title. | very high |
| `path` | `"<file>#<offset>"` | TOC target; the **fragment is the chapter start time** (e.g. `0.00000-119.00000`), captured verbatim as `chapters[].offset`. | very high (existence); high (offset semantics — LibbyRip parses it identically) |
| `pageRange` | string (magazines) | Printable page label, e.g. `"Cover"`. | very high (key) |
| `featureImage` | asset path | TOC thumbnail asset. | very high (key) |

### Root siblings of `.b` → `openbook-extra.json`

Live-verified shape on a magazine loan: the decoded root is exactly
`{ b, t, u }`.

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `t` | `{ codex: { title: { titleId, slug }, loan: { psnKey, slug }, library: { key, name } }, "dewey-url", spec: "V31", thunder, theme }` | App context: which loan/library/player the page belongs to. (`psnKey` = `<cardId>-<titleId>`.) Audiobook pages instead expose the player context LibbyRip sees: `objects.spool.components[]` (`{ meta: { path, -odread-spine-position, audio-duration, -odread-file-bytes, media-type, audio-bitrate }, spinePosition }`) and `objects.reader._.context.spine._.components[]` (ebook pages, `block.behavior` filtering). | very high (magazine, live); medium (audiobook side, LibbyRip) |
| `u` | `"/?d=<base64url JSON>"` | Reader deep-link. Decoded: `{ outlet: "read", token, access, expires, theme, sync, pparam: "lib-<websiteId>", tdata: { codex… }, time, grants: ["read"], auth_url: "https://sentry.libbyapp.com/open/auth/<chipId>", buid, _c }`. | very high (shape), medium (per-field semantics) |

LibbyRip's note stands: Libby strips the MP3-URL crypto context *out of* the
book info before shipping it — only `-odread-cmpt-params` inside `.b` survives.

## 6. Thunder media record — `GET thunder…/media/{id}` → `thunder.json` (if 200)

Catalog-side metadata, independent of the loan. Fetch failure is tolerated
(`null`) and never fails an archive. **Live-verified 2026-09-06 against Auckland
Libraries and field-audited**: 71 records (3 media + 68 search items) carry
44–55 top-level keys each; the union — 56 keys, every one listed below — is the
complete observed shape.

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
| `publisher` / `publisherAccount` | `{ id, name }` | Publisher and its catalog account (e.g. Random House / Penguin Random House UK). Present in **all** 71 captured records. | very high |
| `series` | string (11/71 records) | Plain-text series name, e.g. `"The Midnight World"`. | very high |
| `detailedSeries` | `{ seriesId, seriesName, readingOrder, rank }` (11/71) | Structured series: numeric id, `readingOrder` is a **string** (`"1"`), `rank` a number. | very high (keys); medium (rank semantics) |
| `edition` | string (27/71) | Edition, e.g. `"4"`. | very high |
| `awards` | `[{ id, description, source }]` (6/71, search items only) | Award entries, e.g. `"Libby Award Finalist"` / source `"OverDrive"`. | very high (keys) |
| `starRating` / `starRatingCount` | number | Aggregate community rating. **Optional** — present in 40/71 records. | very high (keys) |
| `ratings` | `{ maturityLevel, naughtyScore }` | Internal content ratings. | medium (semantics inferred) |
| `reviewCounts` | `{ premium, publisherSupplier }` | Review counts by source. | medium (semantics inferred) |

### Classification

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `subjects[]` | `{ id, name }` | Subject tags → `metadata.json.subjects`. | very high |
| `levels[]` | `{ id, name, value, high?, low? }` (e.g. `{ id: "atos", name: "ATOS", value: "4.7" }`) | Reading/interest levels. | very high (keys); low (value/high/low scale) |
| `bisac[]` / `bisacCodes` | `{ code, description }` / string[] | BISAC subject codes. | very high (keys) |
| `classifications` | object (empty in captures) | Classification block; rarely populated. | low |

### Formats & media

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `formats[]` | array, one per offered format (183 observed) | Keys observed: `id`, `name`, `isbn` (142/183), `identifiers[]` (always), `fulfillmentType` (e.g. `bifocal`), `hasAudioSynchronizedText`, `isBundleParent`, `bundledContent` (always `[]` in captures), `onSaleDateUtc`, `rights` (always `[]` in captures), `sample` (87/183), `fileSize` bytes (98/183), `duration` **string** `"11:40:06"` (34/183, audiobooks), `partCount` (17/183), `accessibilityStatements` (41/183). | very high (keys); medium (`rights`, `bundledContent`, `accessibilityStatements` semantics) |
| `formats[].identifiers[]` | `{ type: "ISBN", value }` | Isbns → `metadata.json.isbns`. | very high |
| `formats[].accessibilityStatements` | `{ waysOfReading[], conformance[], navigation[] }` | Accessibility conformance metadata (e.g. `"ModifiableDisplay"`, `"MeetsStandards"`). | medium |
| `covers{}` | `cover150Wide` / `cover300Wide` / `cover510Wide` — present in **all** records | Each entry: `{ href, width, height, primaryColor: { hex, rgb: { red, green, blue } }, isPlaceholderImage }`. `cover510Wide.href` serves `ImageType-100` (the original asset). | very high |
| `sample` | `{ href }` | Excerpt link. | very high |
| `constraints` | `{ isDisneyEulaRequired }` | Licensing constraints. | medium |
| `contentAccessLevels` | number | Access-level bitmask. | low |

### Availability (inline — mirrors §7)

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `isAvailable`, `availableCopies`, `ownedCopies`, `luckyDayAvailableCopies`, `luckyDayOwnedCopies`, `holdsCount`, `holdsRatio`, `estimatedWaitDays`, `estimatedReleaseDate`, `availabilityType` | number/string | Live availability snapshot. | very high (keys), high (semantics) |
| `isHoldable`, `isFastlane`, `isOwned`, `isPreReleaseTitle`, `isRecommendableToLibrary`, `isRestricted`, `isAdvantageFiltered`, `isBundledChild`, `juvenileEligible`, `youngAdultEligible`, `visitorEligible` | bool | Entitlement/eligibility flags. | very high (keys); low–medium (individual semantics inferred from names) |

## 7. Availability record — `POST thunder…/media/availability` (ephemeral; `libby avail`)

Batch response: `{ items: [...] }` — live-verified 2026-09-06: the **union across
items is 23 keys** (individual items carry 17–23 depending on state) — the
availability subset of §6, plus `estimatedReleaseDate`, `luckyDayOwnedCopies`,
`isOwned`, `visitorEligible`, `juvenileEligible`, `youngAdultEligible`,
`contentAccessLevels`, and `formats[]` (full format objects as in §6). All keys
very high (existence); per-flag semantics as noted in §6.

## 7b. Catalog search response — `GET thunder…/media?query=…` (ephemeral; `libby search`)

Top level: `facets`, `items`, `links`, `queryKeys`, `sortOptions`, `totalItems`,
`totalItemsText` (all verified). **`items[]` are full media records of the §6
family** — 44–55 top-level keys each (sparse per title, e.g. `awards` appeared
only here, `starRating` in 40/71) — so `libby search` already receives everything
§6 documents.

## 7c. Stargazer characteristics — `GET stargazer…/{lib}/characteristics/title/{id}`

Live-verified shape:

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `title_id` | string | Echoes the requested id. | very high |
| `matches` | number | **Not** the tag count — a live body with `matches: 0` still returned a fully populated `characteristics` tree. Exact semantics unclear. | medium |
| `characteristics` | nested `{ category: { subkey: { emoji: word } } }` — e.g. `fiction → adults → { "🛸": "cosmic", … }` | Emoji-keyed tag tree; `getCharacteristics` flattens it to the word strings. Present and populated even when `matches` is 0. | very high (shape), high (semantics) |

## 8. Read-host page — `parent.__bif_cfc1(self, '<blob>')` → `pages/` + EPUB

Not JSON: the page body is a single call whose blob is base64 with base64
characters swapped 1↔4 per 4-char group. Deciphered body is XHTML/SVG markup
referencing `../assets/…` scans. | very high (two independent implementations decode it;
equivalence pinned by tests + drift canaries).

## 9. Never persisted (accepted limitations)

- **HTTP response metadata** per file (final redirected URL, `Content-Type`,
  `ETag`, `Last-Modified`): signed URLs expire with the loan, so archival value is
  low. Byte size *is* enforced per part (`-odread-file-bytes` / `Content-Length`).
- **`/chip/sync` account payload** (§2): only per-loan records survive as
  sidecars; the account-level `cards`/`holds`/`summary` sections are enumerated
  in §2 but not persisted by the archiver (use `perf/collect-payloads.mjs` for a
  verbatim `_sync.json`).
- ~~Openbook siblings of `.b`~~ — now captured verbatim to `openbook-extra.json`
  whenever the payload carries them (common case: file absent).

## 10. Drift

Every decode contract above is covered by named-stage canaries (`probeEData`,
`probeCfc1`, `libby probe saved-page.html`): if OverDrive changes a format, the
failure names the broken contract instead of producing garbage. See
README → *Obfuscation drift*.
