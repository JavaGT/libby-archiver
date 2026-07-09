# libby-archiver

[![npm](https://img.shields.io/npm/v/libby-archiver.svg)](https://www.npmjs.com/package/libby-archiver)
[![node](https://img.shields.io/node/v/libby-archiver.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/libby-archiver.svg)](LICENSE)

A Node.js library and CLI for archiving Libby/OverDrive audiobooks you have on loan. It
downloads the MP3 spine parts as OverDrive serves them (no re-encoding) and writes the
metadata alongside: cover art, chapters, narrators, ISBNs, and a checksum manifest.

It runs headless — no browser, no Selenium — and has no dependencies beyond Node itself.

You need to have the audiobook checked out already. This doesn't borrow titles, get around
lending limits, or strip DRM; it saves a copy of something you can already play in the app.

## Quickstart

```bash
npm install -g libby-archiver

libby init            # one-time setup (library + card)
libby list            # show your current audiobook loans
libby archive --all   # download them
```

`libby init` looks up your library from its Libby key, checks your card works, and writes
`~/.config/libby-archiver/config.json`.

Or without a global install:

```bash
npx libby-archiver init
npx libby-archiver archive --all
```

## Output

Each audiobook gets its own folder:

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

## Commands

```
libby init                     setup — run this first
libby list                     list your current audiobook loans
libby archive --all            archive every audiobook loan
libby archive --title <id>     archive one title (id comes from `libby list`)
libby auth                     check authentication only
libby where                    print config + session file paths
libby help                     usage
```

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
import { authenticate, sync, audiobookLoans, archiveAudiobook } from 'libby-archiver';

const cfg = { library: 'your-library', websiteId: '123', cardNumber: '…', pin: '' };
const { client, identity } = await authenticate(cfg);
const { loans } = await sync(client, identity);

for (const loan of audiobookLoans(loans)) {
  await archiveAudiobook({ client, identity, cfg }, loan, './archive');
}
```

The lower-level pieces are exported as well: `openLoan`, `fetchOpenbook`, `decodeOpenbook`,
`extractSpine`, `downloadPart`, `fetchThunderMedia`, `resolveLibrary`, and the `SentryClient` /
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
4. **Download.** Fetch each part with the listen-session cookie. The listen host redirects to a
   signed CDN URL; the bytes are written unchanged.
5. **Metadata.** Audio structure comes from the decoded openbook, catalog data from Thunder, the
   cover at its largest size, plus a SHA-256 manifest.

## Caveats

- **Rate limiting.** OverDrive throttles hard access with `403 {"result":"whoa"}`. The tool
  stops the moment it sees this. Don't loop it; give it room between runs.
- **Client version.** `open` wants a current client version, baked into the chip at mint time
  (`CLIENT_VERSION` in [`src/sentry.mjs`](src/sentry.mjs)). If you start seeing
  `client_upgrade_required`, set it to the `version: '…'` value on <https://libbyapp.com/>.
- **TLS.** On some networks the OverDrive read edge serves a cert for a different name. `init`
  detects that and turns on `insecureTLS` for that one host.
- **Obfuscation drift.** The `window.eData` decode is tied to bifocal's current scramble. If
  OverDrive changes it, `descramble()` in `src/openbook.mjs` is the function to fix.

## Credits

Built on the reverse-engineering in
[PsychedelicPalimpsest/LibbyRip](https://github.com/PsychedelicPalimpsest/LibbyRip), the
Tampermonkey userscript that worked out Libby's internals and the `window.eData`/openbook
mechanics. This is a separate Node reimplementation rather than a port, but the groundwork is
theirs. [odmpy](https://github.com/ping/odmpy) was a useful reference for the headless flow.

## Legal

Use it on audiobooks you've borrowed with your own library card, for your own offline
listening. It doesn't bypass lending limits or DRM. Don't redistribute what you download, and
follow your library's terms and your local copyright law.

## License

MIT © JavaGT
