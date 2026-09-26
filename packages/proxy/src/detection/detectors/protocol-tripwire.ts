// Protocol tripwire — stateless checks on the SHAPE of a JSON-RPC request,
// not on its content. Three findings, one DetectorOutput:
//   - server_request (medium): a server→client request other than ping or
//     roots/list. sampling/createMessage and elicitation/create are in the
//     spec, but a connector asking the client to run a model or to prompt the
//     user is worth a look every time it happens. NOT deduplicated.
//   - unknown_method (low): a method outside the spec lists for its direction
//     (protocol-spec.ts). Once per process per method.
//   - unknown_protocol_version (low): a protocolVersion outside the known list,
//     read from initialize params.protocolVersion or from any request's
//     params._meta["io.modelcontextprotocol/protocolVersion"]. Once per
//     process per version.
// The detection's severity is the highest of its findings.
//
// DEDUPLICATION is in memory and per process on purpose: no file, no persisted
// state. Each wrapper is one connector's process, so "once per process" reads
// as "once per connector session" — a new session re-arms it, which is what a
// user looking at today's trail wants.
//
// THE FINDING CARRIES NO METHOD OR VERSION VALUE. DetectionFinding has no field
// meant for it — `rule` names which rule matched, `path` is a JSON path,
// `codepoint` and `count` are the hidden-character scan's — and the schema is
// not widened here. The request row already shows its method in the Tool
// column; the version stays in the persisted params.

import type { DetectionFinding, Detector, DetectorOutput, Severity } from '../types.js';
import {
  CLIENT_REQUEST_METHODS,
  PROTOCOL_VERSION_META_KEY,
  SERVER_REQUEST_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../protocol-spec.js';

const SERVER_REQUESTS_EXPECTED: ReadonlySet<string> = new Set(['ping', 'roots/list']);
const CLIENT_REQUESTS: ReadonlySet<string> = new Set(CLIENT_REQUEST_METHODS);
const SERVER_REQUESTS: ReadonlySet<string> = new Set(SERVER_REQUEST_METHODS);
const VERSIONS: ReadonlySet<string> = new Set(SUPPORTED_PROTOCOL_VERSIONS);

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Per-process memory of what already tripped. Keyed with the direction for
// methods: an unknown method from the server and the same name from the
// client are two different surprises.
const seenUnknownMethods = new Set<string>();
const seenUnknownVersions = new Set<string>();

/** Test seam: the per-process memory survives between vitest cases. */
export function resetProtocolTripwireForTests(): void {
  seenUnknownMethods.clear();
  seenUnknownVersions.clear();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every protocol version this request declares, with where it said so. */
function declaredVersions(method: string, payload: unknown): { value: unknown; location: string }[] {
  if (!isRecord(payload)) return [];
  const out: { value: unknown; location: string }[] = [];
  if (method === 'initialize' && 'protocolVersion' in payload) {
    out.push({ value: payload['protocolVersion'], location: 'params.protocolVersion' });
  }
  const meta = payload['_meta'];
  if (isRecord(meta) && PROTOCOL_VERSION_META_KEY in meta) {
    out.push({ value: meta[PROTOCOL_VERSION_META_KEY], location: 'params._meta' });
  }
  return out;
}

export const protocolTripwire: Detector = (input): DetectorOutput | null => {
  const { method, direction, payload } = input.envelope;
  if (method === null) return null;

  const findings: DetectionFinding[] = [];
  const tiers: Severity[] = [];

  if (direction === 'server_to_client' && !SERVER_REQUESTS_EXPECTED.has(method)) {
    findings.push({ type: 'server_request', location: 'method' });
    tiers.push('medium');
  }

  const known = direction === 'server_to_client' ? SERVER_REQUESTS : CLIENT_REQUESTS;
  const methodKey = `${direction}:${method}`;
  if (!known.has(method) && !seenUnknownMethods.has(methodKey)) {
    seenUnknownMethods.add(methodKey);
    findings.push({ type: 'unknown_method', location: 'method' });
    tiers.push('low');
  }

  for (const { value, location } of declaredVersions(method, payload)) {
    // A non-string version is as unknown as a wrong one; key it by its JSON so
    // it deduplicates like any other value.
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof value === 'string' && VERSIONS.has(value)) continue;
    if (seenUnknownVersions.has(key)) continue;
    seenUnknownVersions.add(key);
    findings.push({ type: 'unknown_protocol_version', location });
    tiers.push('low');
  }

  if (findings.length === 0) return null;
  const severity = tiers.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return { category: 'protocol_tripwire', severity, findings };
};
