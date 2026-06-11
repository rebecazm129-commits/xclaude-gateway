import { join } from 'node:path';

import { env, pipeline } from '@huggingface/transformers';

import type { DetectionFinding, DetectorOutput } from '../types.js';
import {
  mapGroupsToFindings,
  type NerGroup,
  type WorkerJobRequest,
  type WorkerJobResponse,
} from './worker-pure.js';

// Modo offline (decision packaging / cuestion a): el modelo se sirve desde
// disco local, nunca por red. allowRemoteModels=false impide cualquier
// descarga (Principio 8: sin red en runtime). localModelPath resuelve via
// __dirname relativo: en repo -> packages/proxy/models/, en el .app firmado
// -> .app/Contents/Resources/proxy/models/ (misma estructura proxy/{dist,
// models}). Verificado que en directorio read-only no se intenta escribir
// cache, por lo que no se configura env.cacheDir.
env.allowRemoteModels = false;
env.localModelPath = join(__dirname, '..', 'models');

const MODEL_ID = 'Xenova/bert-base-NER';
// Decision de producto (bitacora): en auditoria el umbral filtra RUIDO, no
// incertidumbre. Un caso dudoso de PII es lo que el usuario quiere registrado,
// no descartado. 0.5 = frontera "mas probable que si a que no".
const SCORE_THRESHOLD = 0.5;

function send(msg: WorkerJobResponse): void {
  if (!process.send) {
    throw new Error('worker.ts must run as a forked child (process.send unavailable)');
  }
  process.send(msg);
}

async function main(): Promise<void> {
  let ner: (
    text: string,
    options: { aggregation_strategy: 'simple' },
  ) => Promise<unknown>;
  try {
    ner = (await pipeline('token-classification', MODEL_ID, {
      dtype: 'q8',
    })) as unknown as (
      text: string,
      options: { aggregation_strategy: 'simple' },
    ) => Promise<unknown>;
  } catch (err) {
    send({
      kind: 'error',
      message: `failed to load model: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  send({ kind: 'ready' });

  process.on('message', async (msg: WorkerJobRequest) => {
    if (msg.kind !== 'infer') return;
    let groups: NerGroup[];
    try {
      groups = (await ner(msg.paramsJson, {
        aggregation_strategy: 'simple',
      })) as NerGroup[];
    } catch (err) {
      send({
        kind: 'error',
        jobId: msg.jobId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Decision de producto (bitacora): categoria unica pii_detected (el NER no
    // tiene autoridad para sub-clasificar sensibilidad; el tipo de entidad va
    // en findings[].type). severity 'low' FIJA (coherencia entre detectores:
    // el NER detecta lo menos accionable; escalar por cantidad seria alert
    // fatigue y pre-cargaria el bloqueo de Hitos 7-9). location ausente
    // (start/end no existen en la salida del modelo).
    const findings: DetectionFinding[] = mapGroupsToFindings(
      groups,
      SCORE_THRESHOLD,
    );
    if (findings.length === 0) {
      send({ kind: 'skip', jobId: msg.jobId });
      return;
    }
    const detection: DetectorOutput = {
      category: 'pii_detected',
      severity: 'low',
      findings,
    };
    send({
      kind: 'result',
      jobId: msg.jobId,
      rpcId: msg.rpcId,
      session: msg.session,
      direction: msg.direction,
      detection,
    });
  });
}

void main();
