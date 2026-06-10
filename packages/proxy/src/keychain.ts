import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE = 'com.xclaude.gateway';
const NOT_FOUND = 44; // errSecItemNotFound

// macOS Keychain generic-password store vía el CLI `security`. Cero deps nativas:
// el proxy sigue siendo un .cjs puro (sin .node que externalizar/notarizar). macOS-only.
// El valor se guarda en base64 (sin comillas/espacios -> parse-safe).

export async function keychainSet(account: string, value: string): Promise<void> {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  // The secret travels as a single argv element to `security` (execFile, no
  // shell). TRADE-OFF: for the lifetime of the `security` child (milliseconds)
  // the base64 value is visible in `ps` to local processes on this machine.
  // We previously fed it through `security -i` STDIN to keep it out of argv —
  // but `security -i` TRUNCATES long input lines, which silently corrupted large
  // tokens (Atlassian's JWT + refresh token exceeded the line buffer and got
  // stored truncated/undecodable). There is NO native non-interactive stdin/file
  // mode for `add-generic-password` to pass the password, so we accept the brief,
  // local ps exposure over silent corruption. -U updates the item if it exists.
  await execFileAsync('/usr/bin/security', [
    'add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', b64,
  ]);
}

export async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-s', SERVICE, '-a', account, '-w',
    ]);
    return Buffer.from(stdout.trim(), 'base64').toString('utf8');
  } catch (err) {
    if ((err as { code?: number }).code === NOT_FOUND) return null;
    throw err;
  }
}

export async function keychainDelete(account: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  } catch (err) {
    if ((err as { code?: number }).code === NOT_FOUND) return;
    throw err;
  }
}
