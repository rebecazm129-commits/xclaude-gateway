import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Vitest needs the React plugin so component .tsx files (authored with the
// automatic JSX runtime, no `import React`) transform correctly under test.
// Environment stays 'node' for the whole suite — the existing main/logic tests
// rely on it. Component tests opt into jsdom per-file with the pragma:
//   // @vitest-environment jsdom
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
});
