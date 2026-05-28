// Bundle entry for xcg-proxy. Thin wrapper around main.ts that triggers
// the side effect (process.exit) only when main returns a numeric exit
// code (parse error case). On the happy path, main returns null and the
// process stays alive in the event loop until runStdio's listeners drive
// the shutdown (child exit, SIGINT, SIGTERM) — at which point
// gracefulShutdown calls process.exit internally.

import { main } from './main.js';

const code = main(process.argv.slice(2));
if (code !== null) {
  process.exit(code);
}
