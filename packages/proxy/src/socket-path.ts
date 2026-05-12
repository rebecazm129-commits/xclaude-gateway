// Resolución del path del Unix domain socket compartido entre wrapper y stub.
// macOS limita sun_path a 104 bytes; margen de 100 para evitar EADDRNOTAVAIL.
// Si el path principal excede ese margen, caemos a $TMPDIR/xcg.sock (típicamente
// /var/folders/... — corto y siempre disponible).

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_SUN_PATH = 100;

export function resolveSocketPath(): string {
  const primary = join(
    homedir(),
    'Library',
    'Application Support',
    'xCLAUDE Gateway',
    'xcg.sock',
  );
  if (primary.length <= MAX_SUN_PATH) return primary;
  return join(tmpdir(), 'xcg.sock');
}
