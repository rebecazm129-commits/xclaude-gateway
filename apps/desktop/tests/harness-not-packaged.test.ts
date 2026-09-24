// The harness must never reach a shipped build.
//
// It installs a fake window.xcg and renders the app with fabricated data. In
// the product that would be indistinguishable from real audit output, so the
// separation is not a convention to remember — it is asserted here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appDir = join(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(join(appDir, rel), 'utf8');

describe('harness isolation', () => {
  it('electron-vite (the packaged build) never references the harness', () => {
    const config = read('electron.vite.config.ts');
    expect(config).not.toContain('harness');
  });

  it('the product renderer entry does not import harness code', () => {
    for (const file of ['src/renderer/main.tsx', 'src/renderer/App.tsx']) {
      expect(read(file), file).not.toContain('harness');
    }
  });

  it('the harness lives under its own root, so the product build cannot reach it', () => {
    // electron-vite builds src/renderer with src/renderer/index.html as the
    // entry; the harness has a separate html under src/renderer/harness/ that
    // nothing in that graph links to.
    expect(read('src/renderer/index.html')).not.toContain('harness');
    expect(read('vite.harness.config.ts')).toContain("root,");
  });

  it('the harness page forbids every network connection', () => {
    const html = read('src/renderer/harness/index.html');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('Content-Security-Policy');
  });

  it('the harness dev server binds to loopback only', () => {
    const config = read('vite.harness.config.ts');
    expect(config).toContain("host: '127.0.0.1'");
  });

  it('the harness keeps the Node-builtin guard the product renderer has', () => {
    expect(read('vite.harness.config.ts')).toContain('nodeBuiltins');
  });

  it('the harness script runs plain vite, never electron-vite', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['harness']).toBe('vite --config vite.harness.config.ts');
    expect(pkg.scripts['harness']).not.toContain('electron');
  });

  it('no harness module imports anything from the main process', () => {
    // Matched against IMPORT STATEMENTS, not against the file as a string. The
    // substring version failed the day a fixture used 'src/renderer/App.tsx'
    // as sample data — a path in a string is not a dependency, and a guard
    // that cannot tell the difference gets loosened by whoever it blocks next.
    const IMPORT_RE = /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const FORBIDDEN = [
      { test: (spec: string) => spec.includes('/main/'), why: 'the main process' },
      { test: (spec: string) => spec.startsWith('node:'), why: 'a Node builtin' },
      { test: (spec: string) => spec === 'electron' || spec.startsWith('electron/'), why: 'electron' },
    ];
    for (const file of [
      'src/renderer/harness/main.tsx',
      'src/renderer/harness/fake-api.ts',
      'src/renderer/harness/fake-page.ts',
      'src/renderer/harness/fixtures.ts',
    ]) {
      const src = read(file);
      const specs = [...src.matchAll(IMPORT_RE)].map((m) => m[1]!);
      // A file with no imports at all would pass vacuously; every harness
      // module has some, and asserting it keeps the regex honest.
      expect(specs.length, `${file}: no imports matched — the regex is wrong`).toBeGreaterThan(0);
      for (const spec of specs) {
        for (const rule of FORBIDDEN) {
          expect(rule.test(spec), `${file} imports ${rule.why}: ${spec}`).toBe(false);
        }
      }
    }
  });
});
