import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE = 'com.xclaude.gateway';
const NOT_FOUND = 44; // errSecItemNotFound

// macOS Keychain generic-password store vía el CLI `security`. Cero deps nativas:
// el proxy sigue siendo un .cjs puro (sin .node que externalizar/notarizar). macOS-only.
// El valor se guarda en base64 (sin comillas/espacios -> parse-safe para `security -i`).
// La escritura pasa el secreto por STDIN de `security` (nunca por argv -> no sale en `ps`).

export async function keychainSet(account: string, value: string): Promise<void> {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`security add-generic-password failed (exit ${code}): ${stderr.trim()}`));
    });
    // -U actualiza si ya existe; el secreto viaja por stdin, no por argv.
    child.stdin.write(`add-generic-password -U -s ${SERVICE} -a ${account} -w ${b64}\n`);
    child.stdin.end();
  });
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
