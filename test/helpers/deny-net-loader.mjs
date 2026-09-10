// Resolve hook that makes network denial deterministic for the CLI pins:
// any attempt to load the wire/auth chain crashes the child instead of
// reaching OverDrive, so a validation-order regression fails with zero network.
//
// Deny set (grep-verified 2026-09-11: every network I/O site in src/ imports
// node:https via src/http.mjs or src/sentry.mjs; nothing touches node:http,
// node:net/dns, or fetch()):
//   src/http.mjs, src/sentry.mjs  — the wire layer every network module imports
//   src/auth.mjs                  — authenticate (the #10 bootstrap chain)
//   src/init.mjs                  — the setup wizard (the #11 wizard path)
//   node:https, node:http         — builtins, catches any direct importer
// config.mjs/util.mjs stay loadable (fs-only) so buildConfig still runs and
// its missing-config defense is exercised.
const DENIED = /(?:^node:(?:https|http)$)|(?:\/src\/(?:http|sentry|auth|init)\.mjs$)/;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (DENIED.test(resolved.url)) {
    throw new Error(
      `network denied in test pin (test/helpers/deny-net-loader.mjs): ${specifier}`,
    );
  }
  return resolved;
}
