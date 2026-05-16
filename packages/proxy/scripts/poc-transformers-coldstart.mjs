// PoC Fase 7 - Paso 3 Parte B: medir solo warm cold start del proceso, una vez.
// Se llamará 5 veces desde shell para obtener distribución.
import { pipeline } from '@huggingface/transformers';
const MODEL_ID = 'Xenova/bert-base-NER';
const options = { dtype: 'q8' };
const tStart = performance.now();
const ner = await pipeline('token-classification', MODEL_ID, options);
const tEnd = performance.now();
console.log(`${(tEnd - tStart).toFixed(2)}`);
