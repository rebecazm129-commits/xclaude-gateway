// Detection types — contract surface for the detection engine.
// Pure types, no runtime. Consumed by engine.ts and the wrapper (Phase 1+).

import type { Direction } from '../events.js';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type Category =
  | 'credential_detected'
  | 'prompt_injection'
  | 'email_send_warning'
  | 'data_export_warning'
  | 'tool_call_allowed'
  | 'pii_detected';

export interface DetectionFinding {
  type: string;
  location?: string;
}

export interface DetectorOutput {
  category: Category;
  severity: Severity;
  findings: DetectionFinding[];
}

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

export type DetectionBlock = DetectorOutput;

// --- Camino off-path del motor híbrido (Fase 7 Hito 3) ---
// Bitácora de diseño: 362242b46fa781cfa9b1dc5dc79d37ec.
// El contrato síncrono de arriba (Detector) queda intacto y es el que usan
// los detectores regex inline. Lo de abajo es la segunda forma, separada,
// para el detector NER que corre fuera del path crítico.

// Resultado que un detector off-path entrega cuando termina. Se correlaciona
// con el evento original mediante la clave compuesta (session, rpcId,
// direction) — el mismo nombre de campo que usan el JSONL real y el
// DetectionEvent del Desktop, y la misma terna que el matching
// request/response de la Fase 5 del Hito 2 — porque rpcId se reutiliza por
// sesión y un server puede iniciar requests al client (sampling). Los tres
// valores se obtienen del DetectorInput original: rpcId del frame, y
// session/direction de input.envelope (donde el campo de origen se llama
// envelope.sessionId). NO es un return del detector: se entrega invocando
// el EnrichmentSink inyectado.
export interface DetectionEnrichment {
  rpcId: string;
  session: string;
  direction: Direction;
  detection: DetectionBlock;
}

// El orquestador provee este sink. El detector off-path lo invoca al
// terminar la inferencia. El orquestador escribe el enrichment como una
// línea nueva en el JSONL canónico (evento mcp.detection_enrichment),
// respetando el contrato append-only del Hito 2 (no se reescribe el
// evento original).
export type EnrichmentSink = (enrichment: DetectionEnrichment) => void;

// Segunda forma de detector, separada del contrato síncrono Detector.
// No devuelve resultado: encola el input para inferencia asíncrona y,
// cuando termina, entrega el resultado por el EnrichmentSink que recibió
// al construirse. enqueue() no bloquea: si la cola interna está saturada
// aplica descarte best-effort (la política concreta vive en el detector,
// no en este tipo).
export interface AsyncDetector {
  enqueue(input: DetectorInput, rpcId: string): void;
}
