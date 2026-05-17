// Detection types — contract surface for the detection engine.
// Pure types, no runtime. Consumed by engine.ts and the wrapper (Phase 1+).

import type {
  Direction,
  RpcId,
  Severity,
  Category,
  DetectionFinding,
  DetectionBlock,
} from '@xcg/shared';

export type {
  Direction,
  RpcId,
  Severity,
  Category,
  DetectionFinding,
  DetectionBlock,
  DetectionEnrichment,
  EnrichmentSink,
} from '@xcg/shared';

// DetectorOutput era la definición material; ahora DetectionBlock vive en
// @xcg/shared con esa forma y DetectorOutput es su alias (dirección invertida
// para que la dependencia apunte proxy -> shared, no al revés). Detector y
// los 4 detectores regex siguen usando DetectorOutput sin cambios.
export type DetectorOutput = DetectionBlock;

export interface McpRequestEnvelope {
  payload: unknown;
  mcp: string;
  method: string | null;
  direction: Direction;
  sessionId: string;
}

export interface DetectorInput {
  envelope: McpRequestEnvelope;
  paramsJson: string;
  toolName: string | undefined;
}

export type Detector = (input: DetectorInput) => DetectorOutput | null;

// --- Camino off-path del motor híbrido (Fase 7 Hito 3) ---
// Bitácora de diseño: 362242b46fa781cfa9b1dc5dc79d37ec.
// El contrato síncrono de arriba (Detector) queda intacto y es el que usan
// los detectores regex inline. Lo de abajo es la segunda forma, separada,
// para el detector NER que corre fuera del path crítico.

// Segunda forma de detector, separada del contrato síncrono Detector.
// No devuelve resultado: encola el input para inferencia asíncrona y,
// cuando termina, entrega el resultado por el EnrichmentSink que recibió
// al construirse. enqueue() no bloquea: si la cola interna está saturada
// aplica descarte best-effort (la política concreta vive en el detector,
// no en este tipo).
export interface AsyncDetector {
  enqueue(input: DetectorInput, rpcId: RpcId): void;
}
