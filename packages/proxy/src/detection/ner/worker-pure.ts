// Piezas puras del worker NER: protocolo IPC (tipos) y mapeo tokens->findings.
// Separadas de worker.ts para que tests y async-detector importen sin disparar
// el side effect del entry (void main(): carga del modelo + process.send, que
// bajo el pool de forks de vitest corrompe el canal IPC de tinypool).

import type {
  DetectionFinding,
  DetectorOutput,
  Direction,
  RpcId,
} from '../types.js';

// --- Protocolo IPC main<->worker (replicado en async-detector.ts del lado
// main para que ambos compilen contra la misma forma). Mensajes planos
// structured-clone-able: el transporte es child_process.fork (worker_threads
// crashea con onnxruntime-node, verificado empiricamente). ---
export type WorkerJobRequest = {
  kind: 'infer';
  jobId: string;
  paramsJson: string;
  rpcId: RpcId;
  session: string;
  direction: Direction;
};

export type WorkerJobResponse =
  | { kind: 'ready' }
  | {
      kind: 'result';
      jobId: string;
      rpcId: RpcId;
      session: string;
      direction: Direction;
      detection: DetectorOutput;
    }
  | { kind: 'skip'; jobId: string }
  | { kind: 'error'; jobId?: string; message: string };

// Forma empiricamente verificada de la salida del pipeline con
// aggregation_strategy:'simple' (spike 11/06, q8): Array<{entity_group, score,
// word}>. entity_group YA viene limpio (TYPE in {PER,LOC,ORG,MISC}, sin prefijo
// BIO; los tokens contiguos se fusionan en un span). q8 sigue SIN emitir
// start/end (ni index), por eso no hay `location`. El grouped tambien emite
// elementos sub-umbral (p.ej. score 0.27) que el filtro estricto descarta. El
// cast es necesario porque transformers.js no expone tipos limpios aqui.
export type NerGroup = {
  entity_group: string;
  score: number;
  word: string;
};

// Mapeo puro grupos NER -> findings (extraido para test unitario sin cargar
// el modelo). Filtro estricto `> threshold` (no `>=`): el umbral filtra ruido,
// un elemento en la frontera exacta NO es senal. Sin `location`: start/end no
// existen en la salida del modelo (verificado en spike).
export function mapGroupsToFindings(
  groups: NerGroup[],
  threshold: number,
): DetectionFinding[] {
  return groups
    .filter((g) => g.score > threshold)
    .map((g) => ({ type: g.entity_group }));
}
