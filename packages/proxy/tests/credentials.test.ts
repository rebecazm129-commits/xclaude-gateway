import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/keychain.js', () => ({ keychainDelete: vi.fn(), keychainGet: vi.fn() }));

import { keychainDelete, keychainGet } from '../src/keychain.js';
import { deleteStoredCredentials, hasStoredCredentials } from '../src/credentials.js';

const mockDelete = vi.mocked(keychainDelete);
const mockGet = vi.mocked(keychainGet);

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
});
