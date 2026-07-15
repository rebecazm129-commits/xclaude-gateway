// Bundle entry for xcg-cchook, mirroring cli-entry.ts: the module with the
// logic (cchook.ts) stays side-effect-free so tests import it directly; only
// this entry — the esbuild entrypoint for dist/xcg-cchook.cjs — triggers the
// run. runCchook never throws and always calls process.exit(0) itself.

import { runCchook } from './cchook.js';

void runCchook();
