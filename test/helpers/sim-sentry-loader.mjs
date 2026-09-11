// Resolve hook for the #17 sync-reuse pins: serves the simulated sentry
// surface (sim-sentry-stub.mjs) in place of the real src/sentry.mjs, so a
// spawned CLI exercises the real authenticate/sync code against a counting
// fake instead of OverDrive. Registered via sim-sentry-preload.mjs.
import { fileURLToPath, pathToFileURL } from 'node:url';

const STUB_URL = pathToFileURL(
  fileURLToPath(new URL('./sim-sentry-stub.mjs', import.meta.url)),
).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (/(?:\/|\\)src(?:\/|\\)sentry\.mjs$/.test(resolved.url)) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return resolved;
}
