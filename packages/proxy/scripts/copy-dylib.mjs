// copy:dylib — copia el shared library nativo de onnxruntime-node junto al
// worker bundleado. esbuild (--loader:.node=copy) emite el .node con hash en
// dist/; ese .node busca libonnxruntime.<v>.dylib via @rpath=@loader_path,
// es decir, en SU MISMO directorio. Por eso el .dylib debe acabar en dist/.
// La raiz del paquete se resuelve via realpathSync del symlink pnpm (mismo
// criterio que fetch-model.mjs): no hardcodea version ni depende de exports.
import { cpSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

let ortDir;
try {
  ortDir = realpathSync(
    join(here, '..', 'node_modules', 'onnxruntime-node'),
  );
} catch {
  console.error(
    '[copy:dylib] FALLO: no se resuelve onnxruntime-node. ' +
      'Ejecuta `pnpm install` primero.',
  );
  process.exit(1);
}

const dylibSrcDir = join(ortDir, 'bin', 'napi-v6', 'darwin', 'arm64');
let dylib;
try {
  dylib = readdirSync(dylibSrcDir).find(
    (f) => f.startsWith('libonnxruntime') && f.endsWith('.dylib'),
  );
} catch {
  dylib = undefined;
}
if (dylib === undefined) {
  console.error(
    `[copy:dylib] FALLO: no se encuentra libonnxruntime*.dylib en ${dylibSrcDir}.`,
  );
  process.exit(1);
}

if (!existsSync(distDir)) {
  console.error(
    `[copy:dylib] FALLO: ${distDir} no existe. Ejecuta build:worker primero.`,
  );
  process.exit(1);
}

const src = join(dylibSrcDir, dylib);
const dest = join(distDir, dylib);
cpSync(src, dest);
console.log(`[copy:dylib] OK: ${dylib} -> dist/`);
