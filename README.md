# libby-archiver

[![npm](https://img.shields.io/npm/v/libby-archiver.svg)](https://www.npmjs.com/package/libby-archiver)
[![node](https://img.shields.io/node/v/libby-archiver.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/libby-archiver.svg)](LICENSE)

Browser-free **Node.js library + CLI** to archive the **Libby / OverDrive audiobooks you
have on loan**. It downloads the **raw MP3 spine parts exactly as OverDrive serves them**
(no re-encoding) alongside rich metadata sidecars — cover art, chapters, narrators, ISBNs,
and an integrity manifest.

No browser, no Selenium, no dependencies — just Node's standard library.

> Archives **your own active loans** for personal safekeeping. It does not borrow titles,
> bypass DRM, or defeat lending limits — you must already have the audiobook checked out.

## Quickstart

```bash
npm install -g libby-archiver

libby init            # one-time interactive setup (library + card)
libby list            # see your current audiobook loans
libby archive --all   # download them all
```

`libby init` auto-detects your library from its Libby key, verifies your card, and saves
everything to `~/.config/libby-archiver/config.json`. That's it — 30 seconds to your first
archive.

<details>
<summary>Prefer not to install globally?</summary>

```bash
npx libby-archiver init
npx libby-archiver archive --all
```
</details>

## What you get

For each audiobook, a self-contained folder:

```
<Author> - <Title>/
  Part 01.mp3 … Part NN.mp3   raw spine parts (bit-for-bit as served)
  cover.jpg                   highest-resolution cover art
  openbook.json               spine, nav/toc, chapter markers
  passport.json               fulfillment passport
  loan.json                   loan record
  thunder.json                OverDrive catalog metadata
  metadata.json               normalized summary (narrators, ISBNs, duration, subjects…)
  manifest.sha256             integrity hash of every file
  README.txt                  provenance note
```

## Commands

```bash
libby init                     interactive setup — run this first
libby list                     list your current audiobook loans
libby archive --all            archive every audiobook loan
libby archive --title <id>     archive a single title (id from `libby list`)
libby auth                     verify authentication only
libby where                    print config + session file locations
libby help                     usage
```

Any saved setting can be overridden per-run:

```
--card <n>  --pin <n>  --library <key>  --website <id>
--out <dir>  --session <file>  --insecure-tls
```

Environment variables also work: `LIBBY_CARD`, `LIBBY_PIN`, `LIBBY_LIBRARY`,
`LIBBY_WEBSITE`, `LIBBY_OUT`. Resolution order: **flags → env → local `./config.json` →
`~/.config/libby-archiver/config.json`**.

## Finding your library key

Your library key is the slug in your Libby URL — e.g. `your-library` in
`libbyapp.com/library/your-library`, or the value in your library's share links. `libby init`
resolves it to the full name and `websiteId` for you against OverDrive's public catalog, so
you only have to get the slug roughly right.

## Use as a library

```js
import { authenticate, sync, audiobookLoans, archiveAudiobook } from 'libby-archiver';

const cfg = { library: 'your-library', websiteId: '123', cardNumber: '…', pin: '' };
const { client, identity } = await authenticate(cfg);
const { loans } = await sync(client, identity);

for (const loan of audiobookLoans(loans)) {
  await archiveAudiobook({ client, identity, cfg }, loan, './archive');
}
```

Lower-level building blocks are exported too: `openLoan`, `fetchOpenbook`, `decodeOpenbook`,
`extractSpine`, `downloadPart`, `fetchThunderMedia`, `resolveLibrary`, plus the `SentryClient`
and `SentryError` primitives. See [`src/index.mjs`](src/index.mjs).

## How it works

1. **Auth (card number only).** Mints a chip, links the card, mints a sync code, clones it
   into a second chip, then **re-mints the identity** so the JWT embeds the linked card
   (without that last step `open` returns `missing_chip`). The session is cached and reused
   until it expires.
2. **Open.** Requests the fulfillment passport for a loan, yielding the per-loan listen host
   and a signed `message`.
3. **Openbook (decoded in pure Node).** The spine and signed `cmpt` params aren't served as a
   fetchable manifest — the player page embeds them as an obfuscated `window.eData` array that
   OverDrive's bifocal bundle decodes client-side and then deletes. This tool reproduces that
   decode natively (reverse-engineered from bifocal 9.1.0): it establishes the listen session
   via the signed `message`, fetches the player page, then descrambles `eData` keyed on the
   reversed `buid` and `JSON.parse`s the result. See [`src/openbook.mjs`](src/openbook.mjs).
4. **Download.** Fetches each part's MP3 with the listen-session cookie; it redirects to a
   signed CDN URL. Files are stored bit-for-bit.
5. **Metadata + integrity.** Audio structure from the decoded openbook, catalog metadata from
   Thunder, the max-res cover, and a SHA-256 manifest of everything.

## Caveats

- **Rate limiting.** OverDrive throttles aggressive access with `403 {"result":"whoa"}`. The
  tool stops immediately if it sees this — space out runs, don't loop it.
- **Client version.** `open` requires a current client version, baked into the chip at mint
  (`CLIENT_VERSION` in [`src/sentry.mjs`](src/sentry.mjs)). If you start getting
  `client_upgrade_required`, bump it to the `version: '…'` value on <https://libbyapp.com/>.
- **TLS quirk.** On some networks the OverDrive read edge serves a mismatched certificate;
  `libby init` detects this and sets `insecureTLS` automatically (only affects that one host).
- **Obfuscation drift.** The `window.eData` decode is tied to bifocal's current scramble. If a
  future OverDrive update changes it, `descramble()` in `src/openbook.mjs` is the one function
  to revisit.

## Credits & prior art

This project stands on the shoulders of
[**PsychedelicPalimpsest/LibbyRip**](https://github.com/PsychedelicPalimpsest/LibbyRip) — the
Tampermonkey userscript that first mapped out Libby's internals and the `window.eData` /
openbook mechanics. libby-archiver is an independent, from-scratch **pure-Node, browser-free
reimplementation** rather than a port, but the reverse-engineering groundwork traces back to
that project and its docs. Thanks also to the [`odmpy`](https://github.com/ping/odmpy) project
for prior art on the headless OverDrive flow.

## Legal & ethical use

This tool archives audiobooks **you have legitimately borrowed** through your own library card,
for personal safekeeping and offline listening. It does **not** borrow titles, bypass lending
limits, crack DRM, or grant access to anything you couldn't already play in the Libby app.
Don't redistribute what you download. Respect your library's terms and your local copyright
law — you are responsible for how you use it.

## Contributing

Issues and PRs welcome. The most likely thing to break is the `window.eData` decode if
OverDrive changes its obfuscation — see the **Obfuscation drift** caveat above for where to
look. Please don't file issues asking for help pirating; this is for archiving your own loans.

## License

MIT © JavaGT
