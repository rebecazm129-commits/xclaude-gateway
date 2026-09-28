// The Claude Code spool file, as xcg-cchook writes it (redaction v1).
//
// WHY THE HOOK REDACTS. A spool file lives on disk until the desktop app
// ingests it — seconds normally, hours while the app is closed (9.5 h at most
// in the real trail). Before this, it held the hook payload raw: tool_input
// and tool_response in full, secrets included. Now every known credential
// format is masked BEFORE the file is written, with exactly the trail's code:
// credentialMatches + maskCredentials, keyed by the same per-install salt
// (resolveAuditKey), so a secret masked here carries the same
// [credential:<type> fp:<hex>] the trail would have written.
//
// ON THE TEXT, NOT ON THE JSON. The payload is scanned and masked as text, the
// way the trail masks a serialized line. The credential charsets are never
// JSON-escaped (see maskCredentials), so a secret inside a JSON string is
// found and replaced exactly as it would be in the trail, and the result is
// still the same JSON.
//
// UNCONDITIONAL. No setting, variable or mode turns it off. If the salt
// cannot be read, the ephemeral key masks anyway. If ANY step fails, the
// original payload is never written: the file says only that a payload of N
// bytes was omitted.
//
// THE FILE. One JSON object: { redaction_version, masked, payload } where
// payload is the masked hook payload as a string and masked lists what was
// masked, as { type, fp } — never a value. The ingester needs that list: the
// payload it receives no longer contains the secret, so credential_detected
// can only be raised from the masks the hook itself applied.
//
// Dependencies: the trail's masking modules (node:crypto, node:fs, node:path)
// and nothing else — this runs inside the hook.

import { credentialMatches } from './detection/detectors/credential.js';
import { fingerprint, maskCredentials } from './detection/masking.js';

/** Bump when what the hook masks, or how, changes. */
export const REDACTION_VERSION = 1;

export interface SpoolMask {
  type: string;
  fp: string;
}

/** The spool file body for a payload: masked, with the list of masks. */
export function redactForSpool(payload: string, key: Buffer): string {
  const matches = credentialMatches(payload);
  const masked = maskCredentials(payload, matches, key);
  const seen = new Set<string>();
  const masks: SpoolMask[] = [];
  for (const m of matches) {
    const fp = fingerprint(key, m.value);
    const id = `${m.type}|${fp}`;
    if (seen.has(id)) continue;
    seen.add(id);
    masks.push({ type: m.type, fp });
  }
  return JSON.stringify({ redaction_version: REDACTION_VERSION, masked: masks, payload: masked });
}

/** What is written when redaction failed: that something was captured, and
 *  how big it was. Never the payload. */
export function omittedSpoolBody(bytes: number, now: Date = new Date()): string {
  return JSON.stringify({
    redaction_version: REDACTION_VERSION,
    omitted: true,
    reason: 'redaction_failed',
    ts: now.toISOString(),
    bytes,
  });
}
