import { pipeline, env } from '@huggingface/transformers';
env.allowRemoteModels = false;
env.localModelPath = new URL('../models', import.meta.url).pathname;
const SAMPLE = 'My name is John Smith and I live in Madrid. Contact me at john.smith@example.com or call Acme Corp.';
function ms(ns){return (Number(ns)/1e6).toFixed(1);}
try {
  const t0 = process.hrtime.bigint();
  const ner = await pipeline('token-classification', 'Xenova/bert-base-NER', { dtype: 'q8' });
  const t1 = process.hrtime.bigint();
  const out = await ner(SAMPLE);
  const t2 = process.hrtime.bigint();
  console.log(`[offline] OK load=${ms(t1-t0)}ms infer=${ms(t2-t1)}ms entidades=${out.length}`);
  console.log('[offline] sin red, modelo local cargado y NER infiere.');
} catch (e) {
  console.log(`[offline] FALLO: ${e.message}`);
  process.exit(1);
}
