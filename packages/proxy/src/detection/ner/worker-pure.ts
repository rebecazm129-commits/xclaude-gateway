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

// Forma empiricamente verificada de la salida del pipeline (probe /tmp):
// Array<{entity, score, index, word}> SIN start/end (la config q8 no los
// emite). 'entity' usa BIO scheme: B-{TYPE}/I-{TYPE} con TYPE in
// {PER,LOC,ORG,MISC}, o 'O' (outside). El cast es necesario porque
// transformers.js no expone tipos limpios para token-classification.
export type NerToken = {
  entity: string;
  score: number;
  index: number;
  word: string;
};

export function stripBio(label: string): string {
  return label.startsWith('B-') || label.startsWith('I-')
    ? label.slice(2)
    : label;
}

// Mapeo puro tokens NER -> findings (extraido para test unitario sin cargar
// el modelo). Filtro estricto `> threshold` (no `>=`): el umbral filtra ruido,
// un token en la frontera exacta NO es senal. Sin `location`: start/end no
// existen en la salida del modelo (verificado en probe).
export function mapTokensToFindings(
  tokens: NerToken[],
  threshold: number,
): DetectionFinding[] {
  return tokens
    .filter((t) => t.score > threshold)
    .map((t) => ({ type: stripBio(t.entity) }));
}
