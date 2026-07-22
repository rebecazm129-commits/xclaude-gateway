// Tipos de detección compartidos: fuente única en @xcg/shared (movidos en 3b).
// DetectionEvent y DetectionEnrichmentEvent NO se mueven: son las vistas
// filtradas del JSONL que el reader del Desktop construye para el dashboard
// (runtime-shape del Desktop, no contrato cross-package — el proxy emite
// DetectionEnrichment "puro" en @xcg/shared; el orquestador lo envuelve con
// campos de Envelope al escribir la línea mcp.detection_enrichment).
import type {
  Category,
  DetectionBlock,
  DetectionFinding,
  Direction,
  RpcId,
  Severity,
} from '@xcg/shared';

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

// Result of config:seed-client (BYO OAuth client → Keychain). ok:true iff every
// requested connector reads back seeded; `warnings` are advisory format checks
// that never blocked the write. Neither branch ever carries the client_secret.
export type SeedClientResult =
  | { ok: true; seeded: string[]; warnings: string[] }
  | { ok: false; error: string };

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
  // Campo crudo de la línea JSONL ('claude-code' en los eventos sintetizados
  // por F1.2; ausente en los de wrapper). El reader lo deja pasar tal cual;
  // detection-page lo normaliza con normalizeSource — nadie más lo interpreta.
  source?: string;
  // Provenance CC (F2.4). ccSession = UUID de la sesión de Claude Code;
  // cwd = directorio del proyecto (forward-only: solo lo emite el ingester
  // desde F2.4, los envelopes históricos y los de wrapper no lo llevan).
  ccSession?: string;
  cwd?: string;
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
  // Derivado por el reader (F2.4, summarizeArgs): resumen de una línea
  // (~100 chars) del argumento principal del tool call, para la columna Args
  // de la vista Claude Code. Sale del payload YA persistido/enmascarado.
  // A diferencia de argumentsJson (heavy, solo drawer), este es pequeño y
  // sobrevive en la caché slim.
  argsSummary?: string;
  // Derivado por el reader (delta final): resultado del tool call por
  // correlación con su mcp.response ((session, rpcId), misma pasada del
  // parse; la caché incremental backfillea cuando la response llega en un
  // chunk posterior). 'error' si la response trae error o isInterrupt.
  outcome?: 'ok' | 'error';
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
  // Mismo campo crudo que en DetectionEvent (los enrichments sintetizados de
  // F1.2 también lo llevan); normalizado solo en detection-page.
  source?: string;
  // Mismo ccSession condicional que DetectionEvent (los enrichments CC lo
  // llevan). cwd NO viaja en enrichments — solo en el par request/response.
  ccSession?: string;
}

// Unión que el reader devuelve y el dashboard consume. Discriminada por `type`.
// Solo sirve al Desktop (el proxy nunca la emite ni la lee) — por eso vive
// aquí y no en @xcg/shared.
export type EnrichableEvent = DetectionEvent | DetectionEnrichmentEvent;

// One day in ms. Single source for the 24h audit windows (tray counts + auth
// alerts); previously an inline literal in tray.ts.
export const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Claude Code auditing status (cchook:status) ----

// Snapshot the spool ingester accumulates in-process (getCchookStatus).
export interface CchookIngestStatus {
  /** Result + wall time of the most recent completed cycle; null before one runs. */
  lastCycle: {
    processed: number;
    skippedUnreadable: number;
    deletedStale: number;
    ts: string;
  } | null;
  /** Running sum of skippedUnreadable across all cycles this process. */
  unreadableTotal: number;
  /** Capture ts of the newest SessionStart hook seen (survives restarts via
   *  ingest-state.json); null if none ingested yet. */
  lastSessionStartTs: string | null;
}

// cchook:install / cchook:uninstall payload. Mirrors the config handlers'
// {ok|error} discipline with a readable message (the modal/inspector surface
// it verbatim in their error banners).
export type CchookInstallResult =
  | { ok: true; outcome: 'wrote' | 'noop'; settingsPath: string }
  | { ok: false; error: string };

// cchook:status payload — ingester snapshot + environment probes composed in
// the main process (claude-code-detect + spool readdir).
export interface CchookStatus extends CchookIngestStatus {
  /** ~/.claude exists or a `claude` binary resolves on PATH/fallbacks. */
  installed: boolean;
  /** ~/.claude/settings.json parses and carries the xcg-cchook marker. */
  hookRegistered: boolean;
  /** Spool files waiting for the next ingest cycle (dir absent → 0). */
  pendingSpool: number;
}

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

// ---- Detections pagination (detection:page / detection:detail) ----

// Time window for the Detections view. Single source of truth (TimeFilter
// re-exports it); crosses IPC inside DetectionFilter.
// 'custom' (F2.4 delta final): explicit {from,to} via DetectionFilter.customRange.
export type TimeRange = '1h' | '24h' | '7d' | 'all' | 'custom';

// Where an audit event came from: 'gateway' = a wrapper observed real MCP
// traffic; 'claude-code' = synthesized from a Claude Code hook capture (F1.2,
// source: 'claude-code' on the JSONL line).
export type SourceKind = 'gateway' | 'claude-code';

// SINGLE normalization point from the raw JSONL `source` field (absent on all
// wrapper lines) to a SourceKind. If a third source ever exists, widen HERE —
// do not scatter ifs across page/export/renderer.
export function normalizeSource(v: unknown): SourceKind {
  return v === 'claude-code' ? 'claude-code' : 'gateway';
}

// The full filter the renderer sends to the main. Applied server-side BEFORE the
// top-N cut so the page (and its counts) never lie.
export interface DetectionFilter {
  mcp: string | null;
  timeRange: TimeRange;
  categories: Category[];
  severities: Severity[];
  sources: SourceKind[];
  // Filtros CC (F2.4). OPCIONALES (no `| null` a secas) para que los
  // constructores existentes (renderer, export, tests) sigan compilando sin
  // tocarlos: ausente ≡ null ≡ [] ≡ sin filtrar. Multi-select desde commit 6
  // (mismo patrón que severities[]): pertenencia al array. tool matchea
  // toolName (solo mcp.request — activo excluye enrichments); ccSession
  // matchea el campo ccSession (requests Y enrichments CC); project matchea
  // basename(cwd) (solo requests con cwd — server-side desde commit 6).
  tool?: string[] | null;
  ccSession?: string[] | null;
  project?: string[] | null;
  // Búsqueda libre (delta final): case-insensitive contra toolName y
  // argsSummary (solo requests — un enrichment no tiene ninguno de los dos).
  text?: string | null;
  // Filtro por resultado del tool call (delta final): 'ok' | 'error'.
  // Requests sin response casada (outcome undefined) quedan FUERA de
  // cualquier filtro de status activo — no son ok ni error.
  status?: string[] | null;
  // Rango explícito cuando timeRange === 'custom'. Fechas YYYY-MM-DD
  // (input type=date); semántica inclusiva: [from 00:00, to 24:00).
  customRange?: { from: string; to: string } | null;
}

// Meta por sesión CC (delta final): el dropdown etiqueta TODAS las sesiones
// server-side — started = ts mínimo observado en la ventana; where = project
// (basename(cwd)) más reciente de la sesión, o el mcp del evento más nuevo.
export interface CcSessionFacet {
  id: string;
  started: string;
  where: string;
}

// Inventario estable de valores de facet (commit 6): calculado server-side
// sobre el filtro BASE (sources + timeRange), SIN aplicar tool/ccSession/
// project — el inventario de un facet no depende de sí mismo, así elegir
// Bash no hace desaparecer las demás tools del dropdown. ccSessions con meta
// y orden reciente-primero (started desc) desde el delta final.
export interface DetectionFacets {
  tools: string[];
  ccSessions: CcSessionFacet[];
  projects: string[];
}

// Compound cursor for stable pagination over a total (ts desc, id desc) order.
export interface DetectionCursor {
  ts: string;
  id: string;
}

// Slim row shipped in a page: everything the list + filters + breakdown need,
// WITHOUT the heavy fields (argumentsJson, raw params). Deliberately NOT
// EnrichableEvent — the heavy view is fetched lazily via detection:detail.
export interface DetectionRowSlim {
  id: string;
  ts: string;
  mcp: string;
  type: 'mcp.request' | 'mcp.detection_enrichment';
  category: Category;
  severity: Severity;
  source: SourceKind;
  // request-only presentation
  toolName?: string;
  method?: string;
  // CC provenance (F2.4): solo en filas claude-code. project = basename(cwd),
  // el nombre corto que la UI pinta; el cwd completo NO cruza en la fila (el
  // drawer lo puede reconstruir vía detection:detail si hiciera falta).
  // Forward-only: filas de envelopes históricos no llevan project.
  ccSession?: string;
  project?: string;
  // Resumen corto del argumento principal (F2.4, ver DetectionEvent). NO es
  // forward-only: se deriva del disco en cada parse, históricos incluidos.
  argsSummary?: string;
  // Resultado del tool call (delta final): correlación request↔response por
  // (session, rpcId) en el parse. undefined = sin response casada (huérfana
  // transitoria o histórica).
  outcome?: 'ok' | 'error';
}

// detection:page payload. Counts are server-computed so the renderer never needs
// the whole event set: severityCounts/categoryFilteredTotal feed SeverityBreakdown,
// total/totalMatching feed the "X of N" counter.
export interface DetectionPageResult {
  rows: DetectionRowSlim[];
  total: number; // whole event set (unfiltered)
  totalMatching: number; // after the full filter (mcp+time+category+severity)
  severityCounts: Record<Severity, number>; // over the category-filtered set (pre-severity)
  categoryFilteredTotal: number; // size of that category-filtered set
  nextCursor: DetectionCursor | null;
  // Stable facet inventories (commit 6) — see DetectionFacets.
  facets: DetectionFacets;
  authAlerts: ConnectorAuthAlert[];
  retention: RetentionBannerInfo | null;
}

// ---- Audit export (audit:export) ----

export type AuditExportFormat = 'jsonl' | 'csv';

// Discriminated result of an export: written path + event count, user-canceled,
// or a failure message.
export type AuditExportResult =
  | { ok: true; path: string; count: number }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

// detection:detail payload — the heavy view for the DetailDrawer, fetched on
// open by id. null when the event is gone (e.g. its session file was purged).
export interface DetectionDetail {
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: 'mcp.request' | 'mcp.detection_enrichment';
  rpcId: RpcId;
  direction: Direction;
  category: Category;
  severity: Severity;
  source: SourceKind;
  findings: DetectionFinding[];
  method?: string;
  toolName?: string;
  argumentsJson?: string;
  overheadUs?: number;
}
