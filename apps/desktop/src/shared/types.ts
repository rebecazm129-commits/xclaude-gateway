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
