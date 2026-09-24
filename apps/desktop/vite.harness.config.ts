// Renderer harness — a plain Vite app, NOT electron-vite.
//
// The distinction is the whole safety argument: `electron-vite dev` spawns
// Electron and with it a main process that owns the filesystem, the Keychain
// and the login items. This config spawns a browser page and nothing else, so
// a component rendered here has no path to any of them, whatever it tries.
//
// It is never referenced by electron.vite.config.ts, so the harness is not part
// of any packaged build (asserted in tests/harness-not-packaged.test.ts).

import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same guard the product renderer uses: importing a Node builtin — directly or
// through a barrel — is a build error, not a silent externalization.
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function rendererNoNodeBuiltins() {
  return {
    name: 'xcg:harness-no-node-builtins',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (nodeBuiltins.has(source) || source.startsWith('node:')) {
        throw new Error(
          `[xcg harness] the renderer imports the Node builtin "${source}"` +
            (importer ? ` from ${importer}` : '') +
            '. The harness is a browser page: import browser-safe code only.',
        );
      }
      return null;
    },
  };
}

const root = resolve(__dirname, 'src/renderer/harness');

export default defineConfig({
  root,
  plugins: [react(), rendererNoNodeBuiltins()],
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    open: false,
    // Nothing outside the workspace may be served.
    fs: { strict: true, allow: [resolve(__dirname, '../..')] },
  },
});
