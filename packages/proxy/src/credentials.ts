// Best-effort teardown of a connector's stored OAuth credentials. A login stores
// three Keychain items per connector under SERVICE com.xclaude.gateway, account
// `${name}:${kind}` for kind in tokens|client|verifier (mirror of
// oauth-provider's acct()). Removing a connector should clear all three.

import { keychainDelete, keychainGet } from './keychain.js';

// Keep in sync with KeychainOAuthProvider.acct() in oauth-provider.ts.
const CREDENTIAL_KINDS = ['tokens', 'client', 'verifier'] as const;

export interface DeleteCredentialsResult {
  /** true iff every item was removed or already absent; false iff at least one
   *  delete failed for a real reason (permission, locked keychain, …). */
  readonly cleared: boolean;
}

// keychainDelete already swallows errSecItemNotFound, so an item that was never
// stored (a connector wrapped but never logged in) resolves cleanly and keeps
// cleared:true. Any OTHER error is caught per item and aggregated into
// cleared:false; all three are attempted regardless so one failure does not
// strand the rest.
export async function deleteStoredCredentials(name: string): Promise<DeleteCredentialsResult> {
  let cleared = true;
  for (const kind of CREDENTIAL_KINDS) {
    try {
      await keychainDelete(`${name}:${kind}`);
    } catch {
      cleared = false;
    }
  }
  return { cleared };
}

// True iff the connector has a *valid* stored token blob (the `${name}:tokens`
// Keychain item parses as JSON with a non-empty access_token). A present but
// corrupt/truncated blob counts as NOT logged in — re-auth overwrites it.
// Propagates real Keychain errors; absence is null → false.
export async function hasStoredCredentials(name: string): Promise<boolean> {
  const raw = await keychainGet(`${name}:tokens`);
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.access_token === 'string' && parsed.access_token.length > 0;
  } catch {
    return false;
  }
}

// True iff a BYO OAuth client has been seeded for this connector (the
// `${name}:client` Keychain item exists). Presence-only — unlike
// hasStoredCredentials, we don't parse it: seeding is the gate, not validity.
export async function hasStoredClient(name: string): Promise<boolean> {
  return (await keychainGet(`${name}:client`)) !== null;
}
