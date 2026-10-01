// Reconnect asks for the scope the first connect asked for: the catalog's,
// matched by the connector's URL exactly as written to the config.

import { describe, expect, it, vi } from 'vitest';

import type { ConnectResult } from '@xcg/shared/config';

import { CATALOG } from '../../src/renderer/components/AddConnectorModal.js';
import { catalogScopeForUrl, reconnectConnector } from '../../src/renderer/lib/reconnect.js';

const ok = { ok: true } as unknown as ConnectResult;

function fakeApi() {
  const configConnect = vi.fn<(name: string, url: string, scope?: string) => Promise<ConnectResult>>(async () => ok);
  return { configConnect };
}

const entry = (name: string) => {
  const e = CATALOG.find((c) => c.name === name);
  if (e === undefined || e.url === undefined || e.scope === undefined) {
    throw new Error(`catalog entry ${name} with a url and a scope expected`);
  }
  return e as typeof e & { url: string; scope: string };
};

describe('reconnectConnector', () => {
  it.each(['gmail', 'calendar', 'drive', 'github'])('a catalog connector (%s) reconnects with its catalog scope', async (name) => {
    const e = entry(name);
    const api = fakeApi();
    await reconnectConnector(api, e.name, e.url);
    expect(api.configConnect).toHaveBeenCalledWith(e.name, e.url, e.scope);
  });

  it('matches by URL, not by name: a catalog connector added under another name keeps its scope', async () => {
    const gmail = entry('gmail');
    const api = fakeApi();
    await reconnectConnector(api, 'work-mail', gmail.url);
    expect(api.configConnect).toHaveBeenCalledWith('work-mail', gmail.url, 'https://www.googleapis.com/auth/gmail.modify');
  });

  it('a connector outside the catalog reconnects without a scope, as before', async () => {
    const api = fakeApi();
    await reconnectConnector(api, 'internal', 'https://mcp.internal.example/mcp');
    expect(api.configConnect).toHaveBeenCalledWith('internal', 'https://mcp.internal.example/mcp');
    expect(api.configConnect.mock.calls[0]).toHaveLength(2);
  });

  it('a catalog connector without a scope (DCR) reconnects without one', async () => {
    const dcr = CATALOG.find((c) => c.scope === undefined && c.url !== undefined);
    if (dcr === undefined || dcr.url === undefined) throw new Error('a catalog entry without a scope expected');
    const api = fakeApi();
    await reconnectConnector(api, dcr.name, dcr.url);
    expect(api.configConnect.mock.calls[0]).toHaveLength(2);
  });

  it('the match is exact: the same URL spelled differently does not pick up a scope', () => {
    const github = entry('github');
    expect(github.url.endsWith('/')).toBe(true);
    expect(catalogScopeForUrl(github.url.slice(0, -1))).toBeUndefined();
    expect(catalogScopeForUrl(github.url.toUpperCase())).toBeUndefined();
    expect(catalogScopeForUrl(github.url)).toBe(github.scope);
  });

  it('returns what configConnect returns', async () => {
    const api = fakeApi();
    await expect(reconnectConnector(api, 'x', 'https://x.example')).resolves.toBe(ok);
  });
});
