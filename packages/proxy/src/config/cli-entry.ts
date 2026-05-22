// Bundle entry for xcg-config. Thin wrapper around cli.ts that triggers
// the side effect (process.exit) only when this file is the actual
// process entry point — i.e. when esbuild bundles it as dist/xcg-config.cjs.
// Keeping the side effect here (not in cli.ts) means cli.ts can be safely
// imported by tests without triggering main().

import { main } from './cli.js';

process.exit(main(process.argv.slice(2)));
