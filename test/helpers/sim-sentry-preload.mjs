// Preload for the #17 sync-reuse pins in test/sync-reuse.test.mjs: pass to the
// child as `node --import <this file> bin/libby.mjs ...`. It only registers the
// resolve hook; see sim-sentry-loader.mjs / sim-sentry-stub.mjs for the sim.
import { register } from 'node:module';

register('./sim-sentry-loader.mjs', import.meta.url);
