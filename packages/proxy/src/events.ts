// EventSink: única superficie por la que main.ts emite eventos.
// Compone Writers (hoy solo JsonlWriter; el SocketWriter de la Fase 4 se
// retiró el 17/07/2026 — el patrón de disco es el diseño final) sin que
// la firma de emit() cambie. Aplica truncamiento leaf-level a payloads de
// mcp.* events antes de pasar a los writers.

import { monotonicFactory, ulid } from 'ulid';

// `Direction` se define en @xcg/shared (contrato compartido del monorepo).
// Se re-exporta aquí porque events.ts es el módulo de tipos de evento del
// proxy: frame-processor.ts y latency.ts lo importan desde './events.js' en
// su calidad de tipo de evento, sin conocer la topología del monorepo.
// La fuente de verdad es @xcg/shared; este re-export es fachada explícita.
import type {
  Attention,
  ChangeReview,
  ConnectorChangeEntry,
  ConnectorFinding,
  ConnectorSection,
  Direction,
  ReviewedWith,
  SnapshotRef,
} from '@xcg/shared';
export type { Direction };

import type { Envelope, Writer } from './audit.js';
import { maskCredentials } from './detection/masking.js';
import type { CredentialMatch } from './detection/detectors/credential.js';
import type {
  DetectionBlock,
  DetectionEnrichment,
  EnrichmentSink,
} from './detection/types.js';
import type { ParseErrorReason, RpcId } from './parser.js';
import type { OAuthChange, OAuthFinding } from './oauth-authorized.js';
import type { NerDropReason } from './detection/ner/async-detector.js';

const MAX_LEAF_BYTES = 64 * 1024;

const nextId = monotonicFactory();

// Side channel for credential values the frame-processor wants masked out of
// THIS event's persisted line. A Symbol key is never emitted by JSON.stringify,
// so the secret list can never leak into the trail, and it survives object
// spread ({...event}); emit reads it off the ORIGINAL event before truncation
// (F1.3c-fix lesson: never trust a field to survive a downstream rebuild).
const MASK_SECRETS = Symbol('xcg.maskSecrets');

// The channel is type-agnostic (the Symbol is the contract, not the shape):
// the wrapper attaches to EventBody, the cchook-ingest classifier to Envelope.
/** Attach credential matches (value + pattern type) to an event for masking
 *  at emit time (no-op merge if some are already attached). */
export function attachMaskSecrets(event: object, secrets: readonly CredentialMatch[]): void {
  if (secrets.length === 0) return;
  const holder = event as { [MASK_SECRETS]?: CredentialMatch[] };
  holder[MASK_SECRETS] = [...(holder[MASK_SECRETS] ?? []), ...secrets];
}

// Exported so the desktop cchook-ingester (which serializes envelopes itself,
// outside EventSink) can read the same side channel and mask before writing.
export function readMaskSecrets(event: object): CredentialMatch[] | undefined {
  return (event as { [MASK_SECRETS]?: CredentialMatch[] })[MASK_SECRETS];
}

export type EventBody =
  | {
      type: 'proxy.started';
      pid: number;
      wrap: string;
      /** Redacted by LaunchRedactor before emit (launch-redaction.ts). */
      wrappedArgs: readonly string[];
    }
  | {
      // The http wrapper's startup line — the stdio one is proxy.started,
      // whose wrap/wrappedArgs an http wrapper does not have. `url` is
      // canonical and redacted (LaunchRedactor.canonicalUrl).
      type: 'proxy.http_started';
      pid: number;
      url: string;
    }
  | {
      type: 'proxy.child_spawned';
      childPid: number;
    }
  | {
      type: 'proxy.error';
      kind:
        | 'spawn_failed'
        | 'parse_error'
        | 'unexpected'
        | 'http_connect_failed'
        | 'http_status_error'
        | 'oauth_failed';
      message: string;
      reason?: ParseErrorReason;
      // Solo kind=parse_error: nunca un byte de la línea, solo su tamaño.
      unparsed?: true;
      payload_omitted?: true;
      byte_length?: number;
      // Solo kind=oauth_failed: último proxy.token del provider y hace cuántos ms,
      // para distinguir el modo de fallo sin reconstruirlo a mano desde el JSONL:
      // 'invalidated' ≈ invalid_grant en el refresh (grant muerto/rotado);
      // 'refreshed' ≈ el server devolvió 401 con un token recién refrescado;
      // 'corrupt_blob' ≈ el fallo vino de un blob de Keychain ilegible;
      // 'refresh_coalesced'/'refresh_coalesced_stale'/'lock_timeout' ≈ el
      // single-flight actuó justo antes (los emite el interceptor vía
      // provider.noteEvent, así que cuentan aquí).
      // 'refresh_rejected' ≈ el token endpoint rechazó el refresh; ese evento
      // lleva el error OAuth real y suele ser el inmediatamente anterior a un
      // 'invalidated', así que es el que más informa en este triaje.
      // Ausentes si el provider no emitió ningún evento en la sesión.
      lastTokenEvent?:
        | 'refreshed'
        | 'race_recovered'
        | 'invalidated'
        | 'corrupt_blob'
        | 'refresh_coalesced'
        | 'refresh_coalesced_stale'
        | 'lock_timeout'
        | 'refresh_rejected'
        | 'metadata_issuer_mismatch';
      lastTokenEventAgoMs?: number;
    }
  | {
      type: 'proxy.child_exited';
      code: number | null;
      signal: NodeJS.Signals | null;
      runtimeMs: number;
      framesIn: number;
      framesOut: number;
      framesStderr: number;
      framesInIncomplete: number;
      framesOutIncomplete: number;
    }
  | {
      type: 'proxy.shutdown';
      reason: 'child_exited' | 'parent_closed_stdin' | 'signal_received' | 'remote_closed' | 'auth_failed';
      exitCode: number;
    }
  | {
      type: 'proxy.http_closed';
      runtimeMs: number;
      side: 'remote' | 'client';
      framesIn: number;
      framesOut: number;
    }
  // ('proxy.socket_dropped' retirado el 17/07/2026 con el SocketWriter — el
  // mirror por socket nunca tuvo listener en el producto. Las líneas
  // históricas del trail siguen siendo parseables: el reader del desktop
  // ignora tipos que no reconoce.)
  | {
      type: 'proxy.ner_dropped';
      reason: NerDropReason;
      jobId?: string;
      rpcId?: RpcId;
    }
  | {
      type: 'proxy.ner_worker_died';
      cause: 'exit' | 'error';
      pendingDropped: number;
    }
  | {
      // Ciclo de vida del token OAuth (solo runtime http). 'refreshed': el SDK
      // refrescó y persistió (rotated = el refresh_token cambió). 'race_recovered':
      // la recency-guard evitó borrar el token compartido ante un invalid_grant de
      // carrera; crossProcess=true cuando la carrera se detectó contra el Keychain
      // (otro proceso rotó el RT), ausente cuando fue un saveTokens propio reciente.
      // 'invalidated': borrado real del token (grant muerto); scope
      // distingue invalid_grant ('tokens') de invalid_client ('all').
      // 'corrupt_blob': el blob del Keychain no parsea (scope 'tokens'|'client');
      // se trata como credencial ausente y el flujo cae a reauth limpio.
      // 'refresh_coalesced': el single-flight cross-process (refresh-fetch.ts)
      // detectó bajo lock que otro proceso ya rotó el RT y respondió el refresh
      // desde el Keychain sin ir a red (la revocación por reuso que evitamos).
      // 'refresh_coalesced_stale': otro proceso rotó, pero su access token está
      // caducado (o sin edad conocida); el coalesce se elevó a refresh REAL
      // contra el token endpoint gastando el RT almacenado (incidente 27/08).
      // 'lock_timeout': no se pudo adquirir el lock en el plazo; el refresh
      // procedió SIN él (fail-open) — waitedMs = cuánto se esperó.
      // 'refresh_rejected': el token endpoint respondió non-2xx a un refresh.
      // Único punto donde sobrevive el motivo real del servidor: el SDK lo
      // convierte en invalidateCredentials y el cuerpo se pierde, de modo que
      // hasta ahora el trail solo registraba el 'invalidated' resultante sin
      // poder distinguir grant revocado de RT caducado. status siempre; los
      // campos OAuth solo si el cuerpo era JSON (RFC 6749 §5.2).
      // oauthErrorDescription es TEXTO LIBRE del servidor: el emisor le quita
      // el refresh token y lo trunca antes de que llegue aquí.
      type: 'proxy.token';
      event:
        | 'refreshed'
        | 'race_recovered'
        | 'invalidated'
        | 'corrupt_blob'
        | 'refresh_coalesced'
        | 'refresh_coalesced_stale'
        | 'lock_timeout'
        | 'refresh_rejected'
        | 'metadata_issuer_mismatch';
      rotated?: boolean;
      scope?: 'tokens' | 'all' | 'client';
      crossProcess?: boolean;
      waitedMs?: number;
      status?: number;
      oauthError?: string;
      oauthErrorDescription?: string;
    }
  | {
      // A completed OAuth login (an authorization code was exchanged), written
      // by the `xcg-proxy login` process. Whitelist and rules: oauth-authorized.ts.
      // Never a token, code, state, verifier, client_id, callback or metadata.
      type: 'proxy.oauth_authorized';
      authorization_server: string;
      authorization_server_source: 'protected_resource_metadata' | 'server_url_fallback';
      resource: string | null;
      requested_scopes: string[];
      effective_granted_scopes: string[];
      scope_source: 'token_response' | 'assumed_requested';
      first_login: boolean;
      /** When the login compared against happened; null on a first login. */
      previous_login_at: string | null;
      changes: OAuthChange[];
      findings: OAuthFinding[];
    }
  | {
      // Lifecycle of the per-connector OAuth reference (oauth/v1/). Not a
      // detection: 'initialized' (no file — a first login, or a deleted file:
      // the trail is not read to tell them apart), 'reseeded' (unreadable
      // file), 'kept_newer' (a newer build's file, left untouched and not
      // compared), 'write_failed' (the next login compares against the old one).
      type: 'proxy.oauth_reference';
      event: 'initialized' | 'reseeded' | 'kept_newer' | 'write_failed';
      reason: 'missing' | 'corrupt' | 'future_version' | 'io_error';
    }
  | {
      // Baseline lifecycle of the manifest auditor itself. These are NOT
      // detections: they say what the auditor started, stopped or had to
      // repair in its own state, and must never appear as a Detections row,
      // in the tray count, or in any flagged counter.
      //   'section_initialized'  - first observation of a (connector, section).
      //                            Nothing to compare against yet.
      //   'migrated'             - a v1 baseline was upgraded. coverageExpanded
      //                            lists fields now tracked that never were:
      //                            this is NOT a claim that they did not change.
      //   'projection_migrated'  - OUR security projection changed and the
      //                            hashes were recomputed from the stored
      //                            snapshot. No manifest change is implied.
      //   'reseeded'             - the baseline was (re)created. reason
      //                            'corrupt' is an INTEGRITY warning: the
      //                            auditor wrote that file itself.
      //   'snapshot_incomplete'  - a section could not be assembled (pagination
      //                            failed, cursor repeated, page cap). The
      //                            baseline is deliberately NOT advanced.
      type: 'app.manifest_baseline';
      event:
        | 'section_initialized'
        | 'migrated'
        | 'projection_migrated'
        | 'reseeded'
        | 'snapshot_incomplete';
      section?: string;
      reason?: 'absent' | 'corrupt' | 'version_mismatch' | 'future_version';
      coverageExpanded?: readonly string[];
      fromVersion?: number;
      toVersion?: number;
      pages?: number;
    }
  | {
      type: 'mcp.request';
      direction: Direction;
      rpcId: RpcId;
      method: string;
      params: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
      detection?: DetectionBlock;
    }
  | {
      type: 'mcp.response';
      direction: Direction;
      rpcId: RpcId;
      result?: unknown;
      error?: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
      latencyMs?: number;
    }
  | {
      type: 'mcp.notification';
      direction: Direction;
      method: string;
      params: unknown;
      truncated?: true;
      bytes: number;
      overheadUs: number;
    }
  | {
      type: 'mcp.stderr';
      text: string;
      bytes: number;
      truncated?: true;
      overheadUs: number;
    }
  | {
      // Resultado de un detector off-path (NER) entregado por el orquestador
      // via EnrichmentSink. Append-only: no reescribe el mcp.request original;
      // el reader del Desktop lo correlaciona con su request por la terna
      // (session, rpcId, direction). overheadUs es la latencia de inferencia.
      type: 'mcp.detection_enrichment';
      rpcId: RpcId;
      direction: Direction;
      detection: DetectionBlock;
      overheadUs: number;
    }
  | {
      // The facts model for connector surface changes. Replaces the
      // tool_manifest_changed enrichment: `changes` states what moved and
      // carries no severity at all, `findings` carries what a versioned
      // security rule made of it, and `attention` is a heuristic's opinion
      // that a human should look. A change with no findings is the normal
      // case — four months of production say it is 197 of 217 — and it is NOT
      // a detection, so it must never reach a counter.
      type: 'mcp.connector_change';
      section: ConnectorSection;
      snapshot: SnapshotRef | null;
      catalog?: { before: number; after: number };
      changes: ConnectorChangeEntry[];
      findings: ConnectorFinding[];
      attention: Attention;
      /** A catalog review: no changes, findings about the definition as it
       *  stands, and the rule versions the review ran with. */
      review?: ChangeReview;
      reviewed_with?: ReviewedWith;
      overheadUs: number;
    };

/**
 * Leaf-level truncation: walks recursively. String leaves whose UTF-8 byte
 * size exceeds maxBytes are replaced by a marker; everything else passes through.
 * Returns the (possibly new) value and whether any leaf was truncated.
 */
export function truncate(
  value: unknown,
  maxBytes: number = MAX_LEAF_BYTES,
): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value, 'utf8');
    if (byteLen > maxBytes) {
      return { value: `[truncated ${byteLen} bytes]`, truncated: true };
    }
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let anyTruncated = false;
    const out = value.map((item) => {
      const r = truncate(item, maxBytes);
      if (r.truncated) anyTruncated = true;
      return r.value;
    });
    return { value: out, truncated: anyTruncated };
  }
  if (typeof value === 'object' && value !== null) {
    let anyTruncated = false;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const r = truncate(val, maxBytes);
      if (r.truncated) anyTruncated = true;
      out[key] = r.value;
    }
    return { value: out, truncated: anyTruncated };
  }
  return { value, truncated: false };
}

function applyTruncation(event: EventBody): EventBody {
  if (event.type === 'mcp.request' || event.type === 'mcp.notification') {
    const r = truncate(event.params);
    if (r.truncated) {
      return { ...event, params: r.value, truncated: true };
    }
    return event;
  }
  if (event.type === 'mcp.stderr') {
    const r = truncate(event.text);
    if (r.truncated) {
      return { ...event, text: r.value as string, truncated: true };
    }
    return event;
  }
  if (event.type === 'mcp.response') {
    let anyTruncated = false;
    let result = event.result;
    let error = event.error;
    if (result !== undefined) {
      const r = truncate(result);
      if (r.truncated) {
        result = r.value;
        anyTruncated = true;
      }
    }
    if (error !== undefined) {
      const r = truncate(error);
      if (r.truncated) {
        error = r.value;
        anyTruncated = true;
      }
    }
    if (anyTruncated) {
      return { ...event, result, error, truncated: true };
    }
    return event;
  }
  return event;
}

export class EventSink {
  constructor(
    private readonly mcp: string,
    private readonly writers: readonly Writer[] = [],
    private readonly session: string = ulid(),
    // HMAC key for credential masking. null = masking disabled (tests / the
    // no-key path); the wrapper always passes a real key (resolveAuditKey,
    // which never returns null). Masking runs ONLY on events the frame-
    // processor tagged with secrets, so a key with no tagged event is inert.
    private readonly hmacKey: Buffer | null = null,
  ) {}

  emit(event: EventBody): void {
    // Read the mask secrets from the ORIGINAL event, before applyTruncation —
    // immune to how truncation rebuilds the object (a fully-truncated leaf that
    // CONTAINED the secret drops it entirely: masking becomes a no-op and the
    // `truncated` flag is visible; truncation is all-or-nothing per leaf, so a
    // secret is never left half-present to slip past the replace).
    const secrets = readMaskSecrets(event);
    const finalEvent = applyTruncation(event);
    const envelope: Envelope = {
      v: 1,
      id: nextId(),
      ts: new Date().toISOString(),
      session: this.session,
      mcp: this.mcp,
      ...finalEvent,
    };
    // Single masking point covering BOTH writers (JSONL + socket mirror): mask
    // the serialized line, reparse, hand the masked object to every writer.
    // `bytes` is intentionally NOT recomputed — it measures the wire frame, and
    // the persisted content is no longer byte-identical to it once masked.
    let out: Envelope = envelope;
    if (secrets !== undefined && secrets.length > 0 && this.hmacKey !== null) {
      out = JSON.parse(maskCredentials(JSON.stringify(envelope), secrets, this.hmacKey)) as Envelope;
    }
    for (const writer of this.writers) {
      writer.write(out);
    }
  }

  close(): void {
    for (const writer of this.writers) {
      writer.close();
    }
  }
}

// Adapter entre el contrato off-path (EnrichmentSink, consumido por el
// AsyncDetector segun @xcg/shared) y el productor JSONL del proxy. Asume
// worker per-wrapper (Modelo A de la cuestion c del NER): enrichment.session
// se ignora porque siempre coincide con el session del EventSink que arranco
// el proxy. Si en el futuro se multiplexa un worker entre wrappers (Modelo C),
// este adapter tendria que verificar la igualdad o indexar por session.
export function createEnrichmentSink(sink: EventSink): EnrichmentSink {
  return (enrichment) => {
    sink.emit({
      type: 'mcp.detection_enrichment',
      rpcId: enrichment.rpcId,
      direction: enrichment.direction,
      detection: enrichment.detection,
      overheadUs: enrichment.overheadUs,
    });
  };
}
