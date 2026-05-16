// Tipos de detección compartidos: fuente única en @xcg/shared (movidos en 3b).
// DetectionEvent NO se mueve: es la vista filtrada del JSONL que el reader del
// Desktop construye para el dashboard (runtime-shape del Desktop, no contrato
// cross-package — el proxy emite Envelope con detection opcional, no esto).
import type { DetectionBlock } from '@xcg/shared';

export type {
  Severity,
  Category,
  DetectionFinding,
  DetectionBlock,
} from '@xcg/shared';

export interface DetectionEvent {
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: 'mcp.request';
  method: string;
  detection: DetectionBlock;
}
