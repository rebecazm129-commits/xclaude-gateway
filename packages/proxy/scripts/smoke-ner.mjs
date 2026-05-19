// Smoke minimo del NER (estrategia beta): pipeline() directo, sin fork.
// Objetivo: confirmar que onnxruntime-node carga, medir donde/cuanto pesa
// el modelo Xenova/bert-base-NER, y latencia cold + caliente.
import { pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/bert-base-NER';
const SAMPLE = 'My name is John Smith and I live in Madrid. Contact me at john.smith@example.com or call Acme Corp.';

function ms(ns) { return (Number(ns) / 1e6).toFixed(1); }

const t0 = process.hrtime.bigint();
const ner = await pipeline('token-classification', MODEL_ID, { dtype: 'q8' });
const tLoad = process.hrtime.bigint();
console.log(`[smoke] modelo cargado (cold). load=${ms(tLoad - t0)}ms`);

const c0 = process.hrtime.bigint();
const out1 = await ner(SAMPLE);
const c1 = process.hrtime.bigint();
console.log(`[smoke] inferencia 1 (cold infer). infer=${ms(c1 - c0)}ms entidades=${out1.length}`);

const w0 = process.hrtime.bigint();
const out2 = await ner(SAMPLE);
const w1 = process.hrtime.bigint();
console.log(`[smoke] inferencia 2 (caliente). infer=${ms(w1 - w0)}ms entidades=${out2.length}`);

console.log('[smoke] entidades detectadas:', JSON.stringify(out1.map(e => ({ w: e.word, ent: e.entity, s: Number(e.score?.toFixed?.(2) ?? e.score) }))));
console.log('[smoke] OK: onnxruntime-node cargo y el modelo infiere.');
