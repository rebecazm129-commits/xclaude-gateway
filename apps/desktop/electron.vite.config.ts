import { defineConfig } from 'electron-vite';

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
  renderer: {},
});
