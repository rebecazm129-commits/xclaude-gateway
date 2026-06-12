// Tests for isAllowedNavigation — the renderer navigation allow-list. Pure
// predicate, no Electron/DOM; runs in the default node environment.

import { describe, expect, it } from 'vitest';

import { isAllowedNavigation } from '../../src/main/navigation-guard.js';

const DEV = 'http://localhost:5173/';

describe('isAllowedNavigation', () => {
  it('allows the local app bundle (file://)', () => {
    expect(isAllowedNavigation('file:///Applications/xCLAUDE Gateway.app/.../index.html', undefined)).toBe(true);
  });

  it('allows the dev server URL when running in dev', () => {
    expect(isAllowedNavigation('http://localhost:5173/index.html', DEV)).toBe(true);
  });

  it('denies the dev server URL in production (no dev URL set)', () => {
    expect(isAllowedNavigation('http://localhost:5173/index.html', undefined)).toBe(false);
  });

  it('denies an arbitrary external https site', () => {
    expect(isAllowedNavigation('https://evil.example/login', DEV)).toBe(false);
  });

  it('denies even our own site (external links open in the system browser, not the renderer)', () => {
    expect(isAllowedNavigation('https://xclaude.ai', undefined)).toBe(false);
  });

  it('denies about:blank and non-http schemes', () => {
    expect(isAllowedNavigation('about:blank', DEV)).toBe(false);
    expect(isAllowedNavigation('chrome://settings', DEV)).toBe(false);
  });

  it('treats an empty dev URL as not set', () => {
    expect(isAllowedNavigation('http://localhost:5173/', '')).toBe(false);
  });
});
