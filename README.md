# libby-archiver

[![npm](https://img.shields.io/npm/v/libby-archiver.svg)](https://www.npmjs.com/package/libby-archiver)
[![node](https://img.shields.io/node/v/libby-archiver.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/libby-archiver.svg)](LICENSE)

A Node.js library and CLI for Libby/OverDrive. It searches the catalog, borrows and returns
titles, places holds, and archives what you have on loan:

- **Audiobooks** — the MP3 spine parts as OverDrive serves them (no re-encoding), with cover
  art, chapters, narrators, ISBNs, and a checksum manifest.
- **Ebooks & magazines** — assembled into an **EPUB** (fixed-layout for magazines) alongside
  the decoded pages and their plaintext image assets.

It runs headless — no browser, no Selenium — and has no dependencies beyond Node itself.

Everything happens through your own library card. It doesn't get around lending limits or
strip DRM; archiving saves a copy of something you can already read or play in the app.

## Quickstart

```bash
npm install -g libby-archiver

libby init                    # one-time setup (library + card)
libby search sci-fi thriller  # find something to borrow
libby borrow 10510729         # check it out (id from search)
libby archive --all           # archive every loan (audiobook, ebook, magazine)
```

`libby init` looks up your library from its Libby key, checks your card works, and writes
`~/.config/libby-archiver/config.json`.

Or without a global install:

```bash
npx libby-archiver init
npx libby-archiver archive --all
```

## Output

Each title gets its own self-contained folder. Audiobooks:

```
<Author> - <Title>/
  Part 01.mp3 … Part NN.mp3   spine parts, byte-for-byte as served
  cover.jpg                   cover art (largest available)
  openbook.json               spine, nav/toc, chapter markers
  passport.json               fulfillment passport
  loan.json                   loan record
  thunder.json                OverDrive catalog metadata
  metadata.json               normalized summary (narrators, ISBNs, duration, subjects)
  manifest.sha256             checksum of every file
  README.txt                  provenance note
```

Ebooks and magazines:

```
<Author> - <Title>/
  <Title>.epub                assembled EPUB (fixed-layout for magazines)
  pages/*.xhtml               decoded page bodies, exactly as decoded
  assets/*.jpg                plaintext page/image assets
  cover.jpg                   cover art (largest available)
  openbook.json               spine + nav/toc
  passport.json / loan.json / thunder.json
  metadata.json               normalized summary
  manifest.sha256             checksum of every file
  README.txt                  provenance note
```

## Commands

```
libby init                     setup — run this first
libby search <terms>           search your library's catalog
libby info <id>                full catalog detail for a title
libby avail <id...>            real-time availability (copies, holds, wait)
libby borrow <id>              check out a title (id from search)
libby return <id>              return a loan early
libby hold <id>                place a hold on an unavailable title
libby unhold <id>              cancel a hold
libby list                     list your current loans (audiobook, ebook, magazine)
libby archive --all            archive every loan
libby archive --title <id>     archive one title (id from `libby list`)
libby auth                     check authentication only
libby where                    print config + session file paths
libby help                     usage
```

`search`, `borrow`, `return`, and `hold` cover the full loan lifecycle without opening the
app. `search`, `info`, and `avail` need only your library key (no card); the rest use your
saved card. Title ids come from `libby search` and feed straight into `info`, `avail`,
`borrow`, `hold`, and `archive --title`.

`info` shows the full catalog record (description, formats, subjects, star rating, ISBNs, and
OverDrive's "theme" tags). `avail` does a live availability check — copies, holds, and
estimated wait — which is fresher than the snapshot baked into search results.

Search, borrow, list, and archive take a few extra flags:

```
--format <audiobook|ebook|magazine|all>   filter format (search/borrow/list/archive)
--available                               search: only titles available now
--lucky-day                               borrow: take a Lucky Day copy if offered
--period <days>                           borrow: lending period (default: preferred)
```

`archive --all` covers audiobooks, ebooks, and magazines; add `--format magazine` (etc.) to
narrow it. `archive --title <id>` archives that one title whatever its format.

Flags override saved config for a single run:

```
--card <n>  --pin <n>  --library <key>  --website <id>
--out <dir>  --session <file>  --insecure-tls
```

Environment variables work too (`LIBBY_CARD`, `LIBBY_PIN`, `LIBBY_LIBRARY`, `LIBBY_WEBSITE`,
`LIBBY_OUT`). Config is resolved in this order: flags, then env, then a local `./config.json`,
then `~/.config/libby-archiver/config.json`.

## Your library key

The key is the slug in your Libby URL — e.g. `your-library` in
`libbyapp.com/library/your-library`, or the value in your library's share links. `init`
resolves it to the full name and `websiteId`
against OverDrive's public catalog, so the slug is all you need to supply.

## Using it as a library

```js
import {
  searchCatalog, authenticate, borrowTitle, sync,
  audiobookLoans, readableLoans, archiveAudiobook, archiveReadable,
} from 'libby-archiver';

// Search is auth-free — just the library key.
const { items } = await searchCatalog('your-library', 'dune', { format: 'audiobook' });

const cfg = { library: 'your-library', websiteId: '123', cardNumber: '…', pin: '' };
const { client, identity, cardId } = await authenticate(cfg);

await borrowTitle(client, identity, cardId, items[0].id);

const { loans } = await sync(client, identity);
const ctx = { client, identity, cfg };
for (const loan of audiobookLoans(loans)) await archiveAudiobook(ctx, loan, './archive');
for (const loan of readableLoans(loans)) await archiveReadable(ctx, loan, './archive'); // ebooks + magazines -> EPUB
```

Discovery adds `getTitle`, `getAvailability`, and `getCharacteristics` (all auth-free).
Checkout also exports `returnTitle`, `placeHold`, `cancelHold`, and `getLoanPeriods`. The
lower-level pieces are exported too: `openLoan`, `fetchOpenbook`, `decodeOpenbook`,
`extractSpine`, `downloadPart`, `cfc1`, `decodePage`, `fetchPage`, `buildEpub`,
`fetchThunderMedia`, `resolveLibrary`, and the `SentryClient` /
`SentryError` primitives. See [`src/index.mjs`](src/index.mjs).

## How it works

1. **Auth.** From the card number alone: mint a chip, link the card, mint a sync code, clone it
   into a second chip, then re-mint the identity so the JWT carries the linked card. That
   re-mint matters — without it `open` returns `missing_chip`. The session is cached until it
   expires.
2. **Open.** Request the fulfillment passport for a loan. It returns the per-loan listen host
   and a signed `message`.
3. **Openbook.** The spine and the signed `cmpt` params aren't served as a fetchable file. The
   player page embeds them in an obfuscated `window.eData` array that OverDrive's bifocal bundle
   decodes in the browser and then deletes. This reproduces that decode in Node: establish the
   listen session with the signed `message`, fetch the player page, descramble `eData` using the
   reversed `buid` as the key, and `JSON.parse` the result. See
   [`src/openbook.mjs`](src/openbook.mjs).
4. **Download.**
   - *Audiobooks:* fetch each part with the listen-session cookie. The listen host redirects to a
     signed CDN URL; the bytes are written unchanged.
   - *Ebooks & magazines:* these open on the *read* host, and the openbook decode is identical.
     Each spine page's `<body>` is a single `parent.__bif_cfc1(self, '<blob>')` call — OverDrive's
     per-component content cipher. This reverses it in pure Node (swap chars 1↔4 of every 4-char
     group, then base64/UTF-8 decode), yielding the page's `<svg>`/XHTML. The referenced image
     assets are plaintext. See [`src/read.mjs`](src/read.mjs); pages + assets are packaged into an
     EPUB by [`src/epub.mjs`](src/epub.mjs).
5. **Metadata.** Structure comes from the decoded openbook, catalog data from Thunder, the cover
   at its largest size, plus a SHA-256 manifest.

## Caveats

- **Rate limiting.** OverDrive throttles hard access with `403 {"result":"whoa"}`. The tool
  stops the moment it sees this. Don't loop it; give it room between runs.
- **Client version.** `open` wants a current client version, baked into the chip at mint time
  (`CLIENT_VERSION` in [`src/sentry.mjs`](src/sentry.mjs)). If you start seeing
  `client_upgrade_required`, set it to the `version: '…'` value on <https://libbyapp.com/>.
- **TLS.** On some networks the OverDrive read edge serves a cert for a different name. `init`
  detects that and turns on `insecureTLS` for that one host.
- **Obfuscation drift.** The `window.eData` decode is tied to bifocal's current scramble, and
  the ebook/magazine page decode to its `__bif_cfc1` cipher. If OverDrive changes either,
  `descramble()` in `src/openbook.mjs` and `cfc1()` in `src/read.mjs` are the functions to fix.

## Credits

Built on the reverse-engineering in
[PsychedelicPalimpsest/LibbyRip](https://github.com/PsychedelicPalimpsest/LibbyRip), the
Tampermonkey userscript that worked out Libby's internals and the `window.eData`/openbook
mechanics. This is a separate Node reimplementation rather than a port, but the groundwork is
theirs. [odmpy](https://github.com/ping/odmpy) was a useful reference for the headless flow.

## Legal

Use it on titles you've borrowed with your own library card, for your own offline reading and
listening. It doesn't bypass lending limits or DRM. Don't redistribute what you download, and
follow your library's terms and your local copyright law.

## License

MIT © JavaGT
