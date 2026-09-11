// Resolve hook that makes network denial deterministic for the CLI pins:
// any attempt to load the wire/auth chain crashes the child instead of
// reaching OverDrive, so a validation-order regression fails with zero network.
//
// Deny set (grep-verified 2026-09-11: nothing in src/ uses node:http/http2/
// net/tls/dns or fetch(); all network I/O crosses node:https, imported by
// src/http.mjs and src/sentry.mjs and DIRECTLY by src/library.mjs:8 and
// src/openbook.mjs:19):
//   src/http.mjs, src/sentry.mjs  — the wire layer every network module imports
//   src/auth.mjs                  — authenticate (the #10 bootstrap chain)
//   src/init.mjs                  — the setup wizard (the #11 wizard path)
//   node:https, node:http, node:http2, node:net, node:tls — builtins, catches
//     any direct importer (library.mjs / openbook.mjs today)
// Scope: this hook covers the ESM import graph only — require() or
// createRequire()-shaped network imports would NOT be intercepted (none exist
// in src/ — grep-verified). config.mjs/util.mjs stay loadable (fs-only) so
// buildConfig still runs and its missing-config defense is exercised.
import fs from 'node:fs';

const DENIED =
  /(?:^node:(?:https|http|http2|net|tls)$)|(?:\/src\/(?:http|sentry|auth|init)\.mjs$)/;

// Optional denial log (#13 pin): when DENY_NET_LOG is set, every denial is
// appended before throwing so a pin can prove WHICH wire modules a scenario
// reached (e.g. the borrow format lookup's http.mjs must appear even though
// auth is denied first-line). Off by default; the #10/#11 pins never set it.
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (DENIED.test(resolved.url)) {
    if (process.env.DENY_NET_LOG) {
      try {
        fs.appendFileSync(process.env.DENY_NET_LOG, `denied ${specifier}\n`);
      } catch {
        // A failed log write must not mask the denial itself.
      }
    }
    throw new Error(
      `network denied in test pin (test/helpers/deny-net-loader.mjs): ${specifier}`,
    );
  }
  return resolved;
}
