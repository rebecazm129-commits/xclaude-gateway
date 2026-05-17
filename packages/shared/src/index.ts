// Contrato compartido del monorepo (type-only, sin runtime).
// Direction es una propiedad fundamental de cualquier frame MCP, no un tipo
// de detección: vive aquí para que proxy y desktop compartan una sola fuente.
export type Direction = 'client_to_server' | 'server_to_client';

// `RpcId` es el id de correlación de un frame JSON-RPC 2.0 (spec: string,
// number o null para notificaciones). Vive aquí porque es una propiedad
// fundamental del frame MCP, igual que Direction: el proxy lo produce y el
// contrato off-path lo consume para la clave de correlación. NO se estrecha
// a string — estrechar rompe la correlación con number/null reales del JSONL.
export type RpcId = string | number | null;

// --- Contrato de detección compartido (movido desde proxy en 3b) ---
// Bitácora: 362242b46fa781cfa9b1dc5dc79d37ec. Estos tipos los consumen el
// proxy (motor de detección) y el desktop (reader del dashboard); fuente
// única aquí para que no se dupliquen ni se desincronicen.

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

export interface DetectionBlock {
  category: Category;
  severity: Severity;
  findings: DetectionFinding[];
}

// Resultado que un detector off-path entrega cuando termina. Se correlaciona
// con el evento original mediante la clave compuesta (session, rpcId,
// direction) — el mismo nombre de campo que usan el JSONL real y el
// DetectionEvent del Desktop, y la misma terna que el matching
// request/response de la Fase 5 del Hito 2 — porque rpcId se reutiliza por
// sesión y un server puede iniciar requests al client (sampling). NO es un
// return del detector: se entrega invocando el EnrichmentSink inyectado.
export interface DetectionEnrichment {
  rpcId: RpcId;
  session: string;
  direction: Direction;
  detection: DetectionBlock;
  // Latencia de inferencia NER en microsegundos (medida por el AsyncDetector,
  // mismo concepto que elapsedUs del productor sincrono). Se emite al JSONL
  // para instrumentar el p95 NER en produccion.
  overheadUs: number;
}

// El orquestador provee este sink. El detector off-path lo invoca al
// terminar la inferencia. El orquestador escribe el enrichment como una
// línea nueva en el JSONL (evento mcp.detection_enrichment), respetando el
// contrato append-only del Hito 2 (no se reescribe el evento original).
export type EnrichmentSink = (enrichment: DetectionEnrichment) => void;
