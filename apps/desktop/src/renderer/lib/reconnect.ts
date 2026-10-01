// Reconnect re-runs the interactive login for a connector already in the
// config. It must ask for the SAME scope the first connect asked for: without
// one, a server that answers 401 (GitHub) or defers its challenge (Google)
// lets the SDK request every scope its protected resource metadata
// advertises. The scope is not stored anywhere, so it comes from where the
// first connect took it — the catalog — matched by the connector's URL exactly
// as it was written to the config (the --url argument, verbatim). No match
// (a connector added outside the catalog) reconnects without a scope, as before.

import type { ConnectResult } from '@xcg/shared/config';

import { CATALOG } from '../components/AddConnectorModal.js';
import type { XcgApi } from './xcgApi.js';

/** The catalog scope for this exact URL, or undefined when none applies. */
export function catalogScopeForUrl(url: string): string | undefined {
  return CATALOG.find((entry) => entry.url === url)?.scope;
}

export function reconnectConnector(
  api: Pick<XcgApi, 'configConnect'>,
  name: string,
  url: string,
): Promise<ConnectResult> {
  const scope = catalogScopeForUrl(url);
  return scope === undefined ? api.configConnect(name, url) : api.configConnect(name, url, scope);
}
