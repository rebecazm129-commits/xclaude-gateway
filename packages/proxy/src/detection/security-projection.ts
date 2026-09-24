// The SECURITY PROJECTION: which fields of a section actually bear on risk.
//
// Two hashes are kept per section and they answer different questions.
// `wire_hash` covers the whole canonical snapshot and answers "did anything
// change?". `security_hash` covers this projection and answers "did anything
// change that I should say something about?". The projection is an
// OPTIMISATION, never a gate: the diff runs whenever the wire hash moves, so a
// field nobody thought was interesting is still examined — it just does not
// raise a notification on its own.
//
// Versioned separately (SECURITY_PROJECTION_VERSION) because changing it
// invalidates only `security_hash`, and because the stored snapshot lets that
// hash be recomputed from what was already observed. A change to OUR rules
// must never be reported as a change to THEIR manifest.

import type { SectionName } from './manifest-v2.js';

/** Tool annotations that state INTENT. The rest of `annotations` is cosmetic
 *  (title, hints a vendor tweaks freely) and measured at +4 firings over four
 *  months of production traffic, so it stays out of the projection and in the
 *  wire hash. */
const INTENT_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint'] as const;

/** Fields kept per section. Anything not listed still rides in `wire_hash`.
 *
 *  `securitySchemes` is deliberately ABSENT: SEP-1488 is a draft, and a field
 *  whose meaning may still change does not belong in what decides severity.
 *  `icons`, `execution`, `title` and `_meta` are absent for the same practical
 *  reason — over the 4-month corpus they contributed zero signal and non-zero
 *  churn. */
const KEEP: Record<SectionName, readonly string[]> = {
  discovery: ['instructions', 'capabilities'],
  tools: ['name', 'description', 'inputSchema', 'outputSchema'],
  resources: ['uri', 'name', 'title', 'description', 'mimeType', 'annotations'],
  resource_templates: ['uriTemplate', 'name', 'title', 'description', 'mimeType', 'annotations'],
  prompts: ['name', 'title', 'description', 'arguments'],
};

function projectItem(section: SectionName, item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
  const o = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEEP[section]) {
    if (k in o) out[k] = o[k];
  }
  // Tools keep only the intent hints out of annotations; resources keep the
  // whole block, because a resource's annotations are its audience and
  // priority, not cosmetics.
  if (section === 'tools') {
    const ann = o['annotations'];
    if (ann !== null && typeof ann === 'object' && !Array.isArray(ann)) {
      const a = ann as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const h of INTENT_HINTS) if (h in a) kept[h] = a[h];
      if (Object.keys(kept).length > 0) out['annotations'] = kept;
    }
  }
  return out;
}

/**
 * Projects a section snapshot down to its security-relevant fields.
 * `snapshot` is whatever was stored: a collection for tools/resources/prompts,
 * a single object for discovery.
 */
export function projectForSecurity(section: SectionName, snapshot: unknown): unknown {
  if (Array.isArray(snapshot)) return snapshot.map((i) => projectItem(section, i));
  if (snapshot !== null && typeof snapshot === 'object') {
    const o = snapshot as Record<string, unknown>;
    if (Array.isArray(o['items'])) {
      return { items: (o['items'] as unknown[]).map((i) => projectItem(section, i)) };
    }
    return projectItem(section, snapshot);
  }
  return snapshot;
}
