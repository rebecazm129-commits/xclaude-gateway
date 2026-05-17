// PoC Fase 7 - Paso 3: benchmark de inferencia, memoria, correlación latencia/longitud.
import { pipeline } from '@huggingface/transformers';
import { readFile } from 'node:fs/promises';

const MODEL_ID = 'Xenova/bert-base-NER';
const options = { dtype: 'q8' };
const WARMUP = 5;
const ITERATIONS_PER_PAYLOAD = 5;

// Path del JSONL del dogfooding (filesystem session)
const JSONL_PATH = process.env.JSONL_PATH;
if (!JSONL_PATH) {
  console.error('ERROR: setea JSONL_PATH al jsonl real del dogfooding');
  process.exit(1);
}

// Leer el JSONL y extraer textos representativos de mcp.request / mcp.response
const raw = await readFile(JSONL_PATH, 'utf-8');
const lines = raw.split('\n').filter(Boolean);
const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Extraer strings de payload: method names + arguments + responses
const payloads = [];
for (const ev of events) {
  // Mide BYTE-IDENTICO a lo que AsyncDetector recibe: paramsJson =
  // JSON.stringify(envelope.payload), donde envelope.payload === frame.params
  // === ev.params del JSONL (cadena de equivalencias verificada en engine.ts
  // buildDetectorInput + frame-processor.ts:33). Solo mcp.request: el
  // AsyncDetector solo se invoca en case 'request'. Filtra params {} (txt
  // length 2): no aporta senal al NER e inflaria el p95 con casos triviales.
  if (ev.type === 'mcp.request' && ev.params !== undefined) {
    const txt = JSON.stringify(ev.params);
    if (txt && txt.length > 2) payloads.push(txt);
  }
}

// Si tenemos menos de 40 payloads, repetir hasta llegar a ~200 muestras para p95 fiable
const TARGET = 200;
const samples = [];
while (samples.length < TARGET && payloads.length > 0) {
  for (const p of payloads) {
    if (samples.length >= TARGET) break;
    samples.push(p);
  }
}

console.log('[bench] Modelo:', MODEL_ID, '| dtype:', options.dtype);
console.log('[bench] JSONL:', JSONL_PATH);
console.log('[bench] Payloads únicos extraídos:', payloads.length);
console.log('[bench] Total muestras a ejecutar:', samples.length);

const rssBefore = process.memoryUsage().rss / (1024 * 1024);
console.log(`[bench] RSS antes de cargar modelo: ${rssBefore.toFixed(1)} MB`);

const tLoadStart = performance.now();
const ner = await pipeline('token-classification', MODEL_ID, options);
const tLoadEnd = performance.now();
const loadMs = tLoadEnd - tLoadStart;

const rssAfter = process.memoryUsage().rss / (1024 * 1024);
console.log(`[bench] Warm cold start del proceso: ${loadMs.toFixed(2)} ms`);
console.log(`[bench] RSS después de cargar modelo: ${rssAfter.toFixed(1)} MB (delta +${(rssAfter - rssBefore).toFixed(1)} MB)`);

// Warm-up
console.log(`[bench] Warm-up (${WARMUP} inferencias descartadas)...`);
for (let i = 0; i < WARMUP; i++) {
  await ner(samples[i % samples.length]);
}

// Benchmark: medir cada inferencia con su longitud
console.log('[bench] Benchmark...');
const results = [];
for (let i = 0; i < samples.length; i++) {
  const text = samples[i];
  const t0 = performance.now();
  await ner(text);
  const t1 = performance.now();
  results.push({ ms: t1 - t0, lenChars: text.length });
}

// Estadísticas globales
const sorted = [...results].sort((a, b) => a.ms - b.ms);
const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].ms;
const mean = results.reduce((s, x) => s + x.ms, 0) / results.length;

console.log('');
console.log('[bench] === Latencia de inferencia (ms) ===');
console.log(`[bench] muestras: ${results.length}`);
console.log(`[bench] min : ${sorted[0].ms.toFixed(2)}`);
console.log(`[bench] mean: ${mean.toFixed(2)}`);
console.log(`[bench] p50 : ${p(0.50).toFixed(2)}`);
console.log(`[bench] p95 : ${p(0.95).toFixed(2)}`);
console.log(`[bench] p99 : ${p(0.99).toFixed(2)}`);
console.log(`[bench] max : ${sorted[sorted.length - 1].ms.toFixed(2)}`);

// Correlación latencia/longitud: agrupar por quintiles de longitud
const byLen = [...results].sort((a, b) => a.lenChars - b.lenChars);
const q = Math.floor(byLen.length / 5);
const buckets = [
  byLen.slice(0, q),
  byLen.slice(q, q * 2),
  byLen.slice(q * 2, q * 3),
  byLen.slice(q * 3, q * 4),
  byLen.slice(q * 4),
];
console.log('');
console.log('[bench] === Latencia por quintil de longitud ===');
buckets.forEach((b, i) => {
  if (b.length === 0) return;
  const ms = b.map(x => x.ms).sort((a, c) => a - c);
  const avg = ms.reduce((s, x) => s + x, 0) / ms.length;
  const p95b = ms[Math.min(ms.length - 1, Math.floor(0.95 * ms.length))];
  const lens = b.map(x => x.lenChars);
  const minLen = Math.min(...lens);
  const maxLen = Math.max(...lens);
  console.log(`[bench] Q${i + 1} (chars ${minLen}-${maxLen}): mean=${avg.toFixed(2)}ms, p95=${p95b.toFixed(2)}ms, n=${b.length}`);
});

console.log('');
console.log('[bench] === Hard cap del Gateway: overheadUs p95 < 50 ms ===');
console.log('[bench] (Nota: este p95 es de inferencia bruta del detector NER, que consumirá parte del overheadUs total del wrapper)');
console.log(`[bench] Resultado: p95 ${p(0.95) < 50 ? 'CUMPLE' : 'NO CUMPLE'} el hard cap (${p(0.95).toFixed(2)} ms vs 50 ms)`);
