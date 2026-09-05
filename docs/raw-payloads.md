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

## 6. Thunder catalog record — `GET thunder…/media/{id}` → `thunder.json` (if 200)

Catalog-side metadata, independent of the loan. Fetch failure is tolerated
(`null`) and never fails an archive.

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `id` / `reserveId` | string | Title id. | very high |
| `title` / `subtitle` | string | Catalog title. | very high |
| `firstCreatorName` | string | Primary author. | very high |
| `creators[]` | `{ name, role }` | Full creator list. | high |
| `type.id` | string | Format family. | high |
| `publisher.name` / `publisherAccount.name` | string | Publisher (either field). | high |
| `publishDateText` / `publishDate` | string | Publication date. | medium |
| `edition` | string | Edition. | medium |
| `languages[]` | `{ id, name }` | Languages. | medium |
| `description` | string (HTML) | Catalog description. | very high |
| `subjects[]` | `{ name }` | Subject tags → `metadata.json.subjects`. | high |
| `formats[]` + `formats[].identifiers[]` | `{ id }` / `{ type, value }` — type `ISBN` | Format list and ISBNs → `metadata.json.isbns`. | high |
| `covers{}` | `{ href, width }` per variant | Cover variants; widest wins. | high |
| `starRating` / `starRatingCount` | number | Aggregate rating. | medium |
| `sample.href` / `sample.url` | URL | Excerpt link. | medium |

## 7. Availability record — `POST thunder…/media/availability` (ephemeral; `libby avail`)

| Property | Shape | Meaning | Conf. |
|---|---|---|---|
| `id` / `reserveId` | string | Title id. | very high |
| `isAvailable` | bool | Available now. | very high |
| `availableCopies` / `ownedCopies` | number | Copy counts. | very high |
| `holdsCount` / `holdsRatio` | number | Queue depth. | very high / high |
| `estimatedWaitDays` | number | Wait estimate. | very high |
| `luckyDayAvailableCopies` | number | Lucky Day copies. | high |
| `isHoldable` | bool | Whether a hold can be placed. | very high |
| `isFastlane` | bool | Fastlane flag. | medium |
| `availabilityType` | string | Availability class. | medium |

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
