// Bundle entry for xcg-cchook, mirroring cli-entry.ts: the module with the
// logic (cchook.ts) stays side-effect-free so tests import it directly; only
// this entry — the esbuild entrypoint for dist/xcg-cchook.cjs — triggers the
// run. runCchook never throws and always calls process.exit(0) itself; the
// failsafe covers what its try/catch cannot (stream callbacks, stray
// rejections) with the same outcome: exit 0, nothing on stdout or stderr.

import { installFailsafe, runCchook } from './cchook.js';

installFailsafe();
void runCchook();
