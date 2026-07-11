// libby-archiver — public library API.
//
// Import the pieces you need to script your own flows, or use the `libby` CLI.
//
//   import { authenticate, sync, audiobookLoans, archiveAudiobook } from 'libby-archiver';
//
//   const cfg = { library: 'your-library', websiteId: '123', cardNumber: '...', pin: '' };
//   const { client, identity } = await authenticate(cfg);
//   const { loans } = await sync(client, identity);
//   for (const loan of audiobookLoans(loans)) {
//     await archiveAudiobook({ client, identity, cfg }, loan, './archive');
//   }

// Auth + low-level client
export { authenticate } from './auth.mjs';
export {
  SentryClient,
  SentryError,
  decodeJwt,
  CLIENT_VERSION,
  READ_HOST,
  GATEWAY_HOST,
} from './sentry.mjs';

// Account / loans
export { sync, audiobookLoans } from './loans.mjs';

// Catalog search + discovery + checkout (borrow / return / hold)
export { searchCatalog } from './search.mjs';
export { getAvailability, getTitle, getCharacteristics } from './discover.mjs';
export { getLoanPeriods, borrowTitle, returnTitle, placeHold, cancelHold } from './checkout.mjs';

// Open + openbook decode + spine
export {
  buildCodex,
  openLoan,
  fetchOpenbook,
  decodeOpenbook,
  extractSpine,
} from './openbook.mjs';

// Download + supplementary metadata
export { downloadPart } from './download.mjs';
export { fetchThunderMedia, maxResCoverUrl, downloadCover } from './metadata.mjs';

// High-level orchestrator (one loan -> self-contained folder)
export { archiveAudiobook } from './archive.mjs';

// Config + library discovery
export {
  loadConfig,
  saveConfig,
  configDir,
  configPath,
  sessionPath,
  resolveLibrary,
  detectInsecureTLS,
} from './config.mjs';
