// PoC Fase 7 - Paso 2: descargar y cargar el modelo NER candidato.
// Mide tamaño del modelo en disco + tiempo de carga del pipeline.
// No ejecuta inferencias todavía.
import { pipeline, env } from '@huggingface/transformers';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MODEL_ID = 'Xenova/bert-base-NER';

// Forzar uso de cuantización INT8 si está disponible
const options = { dtype: 'q8' };

console.log('[poc] Modelo objetivo:', MODEL_ID);
console.log('[poc] dtype solicitado:', options.dtype);
console.log('[poc] cacheDir (env.cacheDir):', env.cacheDir ?? '(default de la librería)');

console.log('[poc] Iniciando descarga + carga del pipeline NER...');
const tStart = performance.now();
const nerPipeline = await pipeline('token-classification', MODEL_ID, options);
const tEnd = performance.now();
const loadMs = tEnd - tStart;

console.log(`[poc] Pipeline cargado en ${loadMs.toFixed(2)} ms (cold start completo: descarga + parseo + init)`);
console.log('[poc] Tipo del pipeline:', nerPipeline.task ?? '(sin task expuesto)');

// Medir tamaño del modelo en disco recorriendo el cache directory
async function dirSize(path) {
  let total = 0;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    }
  } catch (e) {
    // dir doesn't exist, return 0
  }
  return total;
}

// El cache de transformers.js en Node por defecto vive en ./.cache o en HF_HOME
// Vamos a chequear las rutas más comunes
const candidatePaths = [
  env.cacheDir,
  join(process.cwd(), '.cache'),
  join(process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache'),
  join(homedir(), '.cache', 'huggingface'),
].filter(Boolean);

for (const p of candidatePaths) {
  const size = await dirSize(p);
  if (size > 0) {
    console.log(`[poc] Tamaño en disco (${p}): ${(size / (1024 * 1024)).toFixed(2)} MB`);
  }
}
