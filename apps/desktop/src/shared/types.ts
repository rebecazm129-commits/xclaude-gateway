// Tipos de detección compartidos: fuente única en @xcg/shared (movidos en 3b).
// DetectionEvent y DetectionEnrichmentEvent NO se mueven: son las vistas
// filtradas del JSONL que el reader del Desktop construye para el dashboard
// (runtime-shape del Desktop, no contrato cross-package — el proxy emite
// DetectionEnrichment "puro" en @xcg/shared; el orquestador lo envuelve con
// campos de Envelope al escribir la línea mcp.detection_enrichment).
import type { DetectionBlock, RpcId, Direction } from '@xcg/shared';

export type {
  Severity,
  Category,
  DetectionFinding,
  DetectionBlock,
} from '@xcg/shared';

// Latest tool-inventory size for a connector, derived read-only from the audit
// JSONL (the most recent tools/list response). ts is the response timestamp.
export interface ToolCount {
  count: number;
  ts: string;
}

// Variante 1: mcp.request con detection inline (detector síncrono regex que
// enriqueció el frame en el path crítico). Es lo que el reader ya leía.
export interface DetectionEvent {
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: 'mcp.request';
  method: string;
  // rpcId/direction viajan en la estructura para la clave de correlación
  // (session, rpcId, direction) del join NER. NO son datos de presentación:
  // DetectionRow no los pinta. Si el renderer los usara, reabriria la
  // Decision 1 del contrato (maquinaria de correlacion != presentacion).
  rpcId: RpcId;
  direction: Direction;
  detection: DetectionBlock;
  // Opcion (b) acumular: si un mcp.detection_enrichment correlaciona con
  // este request por la terna (session, rpcId, direction), su DetectionBlock
  // se adjunta aqui SIN reemplazar `detection` (la regex original se
  // preserva, fidelidad de auditoria). Ausente si no hubo join. Como se
  // muestran dos detecciones en una fila es decision de UI de Fase 7.
  enrichment?: DetectionBlock;
  // Derivado por el reader cuando method === 'tools/call' y params.name es
  // string: nombre del tool real invocado (echo, read_file, send_email...).
  // Es DATO de presentacion, no maquinaria — el reader extrae el campo y lo
  // expone aqui para que el renderer NO lea params crudo (mantiene la
  // separacion presentacion vs JSON-RPC machinery: Decision 1 del contrato).
  toolName?: string;
  // Derivado por el reader cuando params.arguments existe: JSON.stringify
  // pretty-printed (indent 2). Mismo principio que toolName: el renderer
  // recibe string ya serializado, no toca params crudo ni hace stringify
  // en cada render del drawer (D.3.b.3.a).
  argumentsJson?: string;
  // Microsegundos de overhead introducido por el proxy al procesar el
  // frame. Dato de presentacion para el bloque "Technical details" del
  // drawer (D.3.b.3.a). Opcional: JSONLs antiguos pueden no traerlo.
  overheadUs?: number;
}

// Variante 2: línea mcp.detection_enrichment que el orquestador escribe cuando
// un detector off-path (NER) entrega resultado vía EnrichmentSink. Combina los
// campos del Envelope (id/ts/session/mcp) con la clave de correlación
// (rpcId/direction) y el DetectionBlock del NER. NO tiene method propio: el
// enrichment se correlaciona con su mcp.request original por (session, rpcId,
// direction), no lleva método.
export interface DetectionEnrichmentEvent {
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: 'mcp.detection_enrichment';
  rpcId: RpcId;
  direction: Direction;
  detection: DetectionBlock;
}

// Unión que el reader devuelve y el dashboard consume. Discriminada por `type`.
// Solo sirve al Desktop (el proxy nunca la emite ni la lee) — por eso vive
// aquí y no en @xcg/shared.
export type EnrichableEvent = DetectionEvent | DetectionEnrichmentEvent;

// One day in ms. Single source for the 24h audit windows (tray counts + auth
// alerts); previously an inline literal in tray.ts.
export const DAY_MS = 24 * 60 * 60 * 1000;

// A connector whose most recent auth event is a (recent) oauth failure with no
// later live traffic — i.e. it needs an interactive re-login. Derived by the
// reader from proxy.error/oauth_failed lines; consumed by the desktop.
export interface ConnectorAuthAlert {
  mcp: string;
  lastFailureTs: string; // ts ISO del oauth_failed más reciente
  message: string; // message crudo de esa línea (para detalle)
}

// Payload of detection:list: the polled events (unchanged shape) plus the
// derived auth alerts, both produced in a single disk pass.
export interface DetectionListResult {
  events: EnrichableEvent[];
  authAlerts: ConnectorAuthAlert[];
  // Cached retention size/threshold, piggybacked for the Detections "log has
  // grown" banner. Optional + null until the main's first sweep populates the
  // cache — costs zero extra disk reads (in-memory value).
  retention?: RetentionBannerInfo | null;
}

// ---- Retention (audit-log lifecycle) ----

// Purge modes offered in Settings. 'never' (default) keeps everything.
export type PurgeMode = 'never' | '30d' | '90d' | '365d';

// Persisted in ~/Library/Application Support/xCLAUDE Gateway/settings.json
// under { v:1, retention: {...} }.
export interface RetentionConfig {
  purgeMode: PurgeMode;
  sizeWarnBytes: number;
}

// Cached in the main after each sweep + at startup. Never recomputed on the 2s poll.
export interface RetentionSizeSnapshot {
  totalBytes: number;
  fileCount: number;
  computedAtTs: string;
}

// The most recent app.retention_purged marker in app-events.jsonl, surfaced in
// Settings so every automatic purge is visible.
export interface RetentionPurgedMarker {
  ts: string;
  filesPurged: number;
  purgedFromTs: string;
  purgedUntilTs: string;
  purgeMode: string;
}

// retention:status payload — config + cached size + last purge (on-demand read
// when Settings opens, not on the poll path).
export interface RetentionStatus {
  config: RetentionConfig;
  size: RetentionSizeSnapshot | null;
  lastPurge: RetentionPurgedMarker | null;
}

// retention:set-mode payload.
export interface RetentionSetModeResult {
  ok: boolean;
  config: RetentionConfig;
  // Session files that WOULD be purged at the new mode (by ULID decodeTime;
  // nothing deleted). 0 for 'never'. Lets the UI record the impact before the
  // next daily sweep acts.
  purgableEstimate: number;
}

// Minimal size info piggybacked on detection:list for the Detections banner.
// Both fields come from the main's in-memory cache — zero extra disk cost.
export interface RetentionBannerInfo {
  totalBytes: number;
  sizeWarnBytes: number;
}
