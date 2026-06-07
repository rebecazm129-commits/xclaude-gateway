import { defineConfig } from 'electron-vite';

import { builtinModules } from 'node:module';

// Build-time guard: el renderer es contexto navegador y no debe importar
// builtins de Node, ni transitivamente (p. ej. vía un barrel que reexporta
// código node-only). Vite externalizaría node:* en silencio -> crash en
// runtime (pantalla en blanco). Esto intercepta la resolución primero y lo
// convierte en error de build/transform apuntando al importer culpable.
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function rendererNoNodeBuiltins() {
  return {
    name: 'xcg:renderer-no-node-builtins',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (nodeBuiltins.has(source) || source.startsWith('node:')) {
        throw new Error(
          `[xcg guard] El renderer importa el builtin de Node "${source}"` +
            (importer ? ` desde ${importer}` : '') +
            `. El renderer es navegador: importa solo código browser-safe ` +
            `(usa un subpath renderer-safe, no un barrel con código node-only).`,
        );
      }
      return null;
    },
  };
}

export default defineConfig({
  // Milestone 4 Phase 3b: bundle @xcg/shared inline in the main process.
  // electron-vite externalizes all dependencies declared in package.json by
  // default (via its externalizeDepsPlugin, applied automatically). But
  // @xcg/shared exposes its source .ts directly via exports — and Electron
  // Node refuses to type-strip files under node_modules at runtime, failing
  // with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. The fix is to tell
  // electron-vite to EXCLUDE @xcg/shared from the auto-externalize list, so
  // it gets bundled inline in out/main/index.js. The correct API for the
  // main target is build.externalizeDeps (not ssr.noExternal, which only
  // applies to renderer SSR mode in Vite).
  main: {
    build: {
      externalizeDeps: { exclude: ['@xcg/shared'] },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    plugins: [rendererNoNodeBuiltins()],
  },
});
