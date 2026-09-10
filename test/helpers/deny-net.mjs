// Preload for the network-denial pins in test/cli-lazy.test.mjs (#10/#11):
// pass to the child as `node --import <this file> bin/libby.mjs ...`. It only
// registers the resolve hook; see deny-net-loader.mjs for what is denied.
import { register } from 'node:module';

register('./deny-net-loader.mjs', import.meta.url);
