import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/keychain.js', () => ({ keychainDelete: vi.fn(), keychainGet: vi.fn(), keychainSet: vi.fn() }));

import { keychainDelete, keychainGet, keychainSet } from '../src/keychain.js';
import { deleteStoredCredentials, hasStoredCredentials, seedStoredClient } from '../src/credentials.js';

const mockDelete = vi.mocked(keychainDelete);
const mockGet = vi.mocked(keychainGet);
const mockSet = vi.mocked(keychainSet);

describe('deleteStoredCredentials', () => {
  beforeEach(() => {
    mockDelete.mockReset();
  });

  it('deletes the three items (tokens/client/verifier) → cleared:true', async () => {
    mockDelete.mockResolvedValue(undefined);
    const result = await deleteStoredCredentials('linear');
    expect(result).toEqual({ cleared: true });
    expect(mockDelete.mock.calls.map((c) => c[0])).toEqual([
      'linear:tokens', 'linear:client', 'linear:verifier',
    ]);
  });

  it('tolerates absent items (keychainDelete resolves for missing) → cleared:true', async () => {
    // keychainDelete swallows errSecItemNotFound internally → never-logged-in
    // connector resolves on every item.
    mockDelete.mockResolvedValue(undefined);
    const result = await deleteStoredCredentials('never-used');
    expect(result).toEqual({ cleared: true });
    expect(mockDelete).toHaveBeenCalledTimes(3);
  });

  it('a real delete failure on one item → cleared:false, still attempts all three', async () => {
    mockDelete
      .mockResolvedValueOnce(undefined)                     // tokens ok
      .mockRejectedValueOnce(new Error('keychain locked'))  // client fails
      .mockResolvedValueOnce(undefined);                    // verifier ok
    const result = await deleteStoredCredentials('linear');
    expect(result).toEqual({ cleared: false });
    expect(mockDelete).toHaveBeenCalledTimes(3);
  });
});

describe('hasStoredCredentials', () => {
  beforeEach(() => { mockGet.mockReset(); });

  it('true when the tokens item exists', async () => {
    mockGet.mockResolvedValue('{"access_token":"x"}');
    await expect(hasStoredCredentials('linear')).resolves.toBe(true);
    expect(mockGet).toHaveBeenCalledWith('linear:tokens');
  });

  it('false when the tokens item is absent (keychainGet → null)', async () => {
    mockGet.mockResolvedValue(null);
    await expect(hasStoredCredentials('linear')).resolves.toBe(false);
  });

  it('false for a corrupt blob (truncated JSON)', async () => {
    mockGet.mockResolvedValue('{"access_tok');
    await expect(hasStoredCredentials('atlassian')).resolves.toBe(false);
  });

  it('false for valid JSON without access_token', async () => {
    mockGet.mockResolvedValue('{"refresh_token":"r"}');
    await expect(hasStoredCredentials('atlassian')).resolves.toBe(false);
  });

  it('false for an empty access_token', async () => {
    mockGet.mockResolvedValue('{"access_token":""}');
    await expect(hasStoredCredentials('atlassian')).resolves.toBe(false);
  });

  it('true for a large valid blob (access_token ≥8KB)', async () => {
    const big = 'a'.repeat(8192);
    mockGet.mockResolvedValue(
      JSON.stringify({ access_token: big, token_type: 'Bearer', refresh_token: 'r', expires_in: 3600, scope: 's' }),
    );
    await expect(hasStoredCredentials('atlassian')).resolves.toBe(true);
  });
});

describe('seedStoredClient', () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockGet.mockReset();
  });

  it('writes {client_id, client_secret} to `${name}:client` and returns the re-read (true)', async () => {
    mockSet.mockResolvedValue(undefined);
    mockGet.mockResolvedValue('{"client_id":"cid"}');
    await expect(seedStoredClient('gmail', 'cid.apps.googleusercontent.com', 'GOCSPX-s3cr3t')).resolves.toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      'gmail:client',
      JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'GOCSPX-s3cr3t' }),
    );
    expect(mockGet).toHaveBeenCalledWith('gmail:client');
  });

  it('OMITS the client_secret key entirely when the secret is absent (public PKCE)', async () => {
    mockSet.mockResolvedValue(undefined);
    mockGet.mockResolvedValue('{"client_id":"1.2"}');
    await seedStoredClient('slack', '1111.2222');
    const written = JSON.parse(mockSet.mock.calls[0]?.[1] ?? '{}') as Record<string, unknown>;
    expect(written).toEqual({ client_id: '1111.2222' });
    expect('client_secret' in written).toBe(false);
  });

  it('returns false when the item does not read back after the write', async () => {
    mockSet.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(null);
    await expect(seedStoredClient('gmail', 'cid')).resolves.toBe(false);
  });

  it('a write failure rethrows SANITIZED: no argv/secret from execFile in the message', async () => {
    // execFile errors embed the full command line, including -w <base64(secret)>.
    const raw = new Error(
      'Command failed: /usr/bin/security add-generic-password -U -s com.xclaude.gateway -a gmail:client -w R09DU1BYLXMzY3IzdA==',
    ) as Error & { code?: number };
    raw.code = 51;
    mockSet.mockRejectedValue(raw);
    await expect(seedStoredClient('gmail', 'cid', 'GOCSPX-s3cr3t')).rejects.toThrow(
      'keychain write failed for "gmail:client" (code 51)',
    );
    await expect(seedStoredClient('gmail', 'cid', 'GOCSPX-s3cr3t')).rejects.not.toThrow(/R09DU1BY|GOCSPX|security add/);
  });
});
