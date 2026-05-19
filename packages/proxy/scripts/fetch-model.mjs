// fetch:model — materializa el modelo NER en una ruta estable del repo,
// fuera de git, para que electron-builder lo empaquete en el .app.
//
// Origen: la cache de @huggingface/transformers (poblada al ejecutar el
// modelo una vez, p.ej. el smoke). La raiz del paquete se resuelve via
// realpathSync del symlink que pnpm crea en packages/proxy/node_modules/:
// no depende del exports map (require.resolve falla con
// ERR_PACKAGE_PATH_NOT_EXPORTED) ni hardcodea la version del store, y
// sigue resolviendo si transformers sube de version (.cache/ estable en v4).
//
// Copia SOLO la variante q8 (model_quantized.onnx). NUNCA el full
// (model.onnx, 411MB) que el worker no usa (dtype:'q8').
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_REL = 'Xenova/bert-base-NER';
const FILES = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'onnx/model_quantized.onnx',
];

const here = dirname(fileURLToPath(import.meta.url));
// Resolver la raiz real del paquete via el symlink que pnpm crea en
// packages/proxy/node_modules/. realpathSync lo sigue hasta el store sin
// depender del exports map del package.json (require.resolve falla con
// ERR_PACKAGE_PATH_NOT_EXPORTED) ni hardcodear la version del store.
let transformersDir;
try {
  transformersDir = realpathSync(
    join(here, '..', 'node_modules', '@huggingface', 'transformers'),
  );
} catch {
  console.error(
    '[fetch:model] FALLO: no se resuelve @huggingface/transformers. ' +
      'Ejecuta `pnpm install` en packages/proxy primero.',
  );
  process.exit(1);
}

const srcBase = join(transformersDir, '.cache', MODEL_REL);
if (!existsSync(srcBase)) {
  console.error(
    `[fetch:model] FALLO: cache del modelo no encontrada en ${srcBase}. ` +
      'El modelo no se ha descargado todavia. Ejecuta una vez ' +
      '`node scripts/smoke-ner.mjs` (requiere red) para poblar la cache, ' +
      'luego reintenta `pnpm fetch:model`.',
  );
  process.exit(1);
}

const destBase = join(here, '..', 'models', MODEL_REL);

let copied = 0;
for (const rel of FILES) {
  const src = join(srcBase, rel);
  const dest = join(destBase, rel);
  if (!existsSync(src)) {
    console.error(
      `[fetch:model] FALLO: falta ${rel} en la cache (${src}). ` +
        'Cache incompleta; re-ejecuta el smoke para repoblarla.',
    );
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  copied += 1;
  console.log(`[fetch:model] copiado ${rel}`);
}

console.log(
  `[fetch:model] OK: ${copied} ficheros en ${destBase} ` +
    '(solo q8, model.onnx full excluido).',
);
