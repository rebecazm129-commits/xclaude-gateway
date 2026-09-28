// The words for connector changes.
//
// Apart from the components because this is the part that decides whether a
// user understands what happened, and it should be reviewable without reading
// JSX.
//
// TWO RULES RUN THROUGH ALL OF IT.
//   1. A change is not an accusation. The product observed an edit; it does
//      not know the vendor's intent, and every line has to survive being read
//      by someone whose connector is fine.
//   2. Never invent a severity. A change with no finding gets no badge — not
//      LOW, which reads as "a small problem" rather than "no problem found".

import type { ConnectorChangeEntryView, ConnectorChangeView } from '../lib/xcgApi.js';

/** The sentence a catalog review adds: the finding is real, the edit is not. */
export function baselineNote(mcp: string): string {
  return `Found in ${mcp}'s existing definition. This does not mean it changed recently.`;
}

/** The fixed sentence under every "Why this is flagged" block. */
export const SEVERITY_DISCLAIMER =
  "Severity describes the change xCLAUDE observed. It doesn't mean the connector is malicious.";

/** The same sentence for a catalog review, where there was no change to
 *  describe. */
export const BASELINE_SEVERITY_DISCLAIMER =
  'Severity describes what xCLAUDE found in this existing definition.';

/** The sentence under "Why this is flagged" for this row. */
export function severityDisclaimer(view: ConnectorChangeView): string {
  return view.review === 'baseline' ? BASELINE_SEVERITY_DISCLAIMER : SEVERITY_DISCLAIMER;
}

const SECTION_NOUN: Record<ConnectorChangeView['section'], string> = {
  tools: 'Tool',
  resources: 'Resource',
  resource_templates: 'Resource template',
  prompts: 'Prompt',
  discovery: 'Server info',
};

const SECTION_PLURAL: Record<ConnectorChangeView['section'], string> = {
  tools: 'definitions',
  resources: 'resources',
  resource_templates: 'resource templates',
  prompts: 'prompts',
  discovery: 'server info fields',
};

/** Distinct items this change touches. */
function targetsOf(view: ConnectorChangeView): string[] {
  const seen = new Set<string>();
  for (const c of view.changes) seen.add(c.target);
  for (const f of view.findings) if (f.evidence.target !== undefined) seen.add(f.evidence.target);
  return [...seen];
}

/**
 * The CHANGE column. One item names what kind it is; several give a count,
 * because listing fifty-two tool names in a row is not information.
 */
export function changeTitle(view: ConnectorChangeView): string {
  const targets = targetsOf(view);
  // A catalog review changed nothing: the title must not say it did.
  if (view.review === 'baseline') {
    return targets.length > 1
      ? `${targets.length} existing ${SECTION_PLURAL[view.section]} flagged`
      : `Existing ${SECTION_NOUN[view.section].toLowerCase()} definition flagged`;
  }
  if (targets.length > 1) return `${targets.length} ${SECTION_PLURAL[view.section]} changed`;
  return `${SECTION_NOUN[view.section]} definition changed`;
}

// Verb phrases, not labels: they are read inside a sentence, and an em dash
// standing in for a verb ("search — description changed") reads as a log line
// rather than as something a person wrote.
const CHANGE_PHRASE: Record<ConnectorChangeEntryView['kind'], (target: string) => string> = {
  item_added: (t) => `${t} was added`,
  item_removed: (t) => `${t} was removed`,
  description_changed: (t) => `the description of ${t} changed`,
  surface_added: (t) => `${t} gained a parameter`,
  surface_removed: (t) => `${t} lost a parameter`,
  schema_changed: (t) => `the input schema of ${t} changed`,
  returned_to_seen_state: (t) => `${t} went back to a state seen before`,
};

/** Short forms for the counted case, where the target is not repeated. */
const CHANGE_NOUN: Record<ConnectorChangeEntryView['kind'], string> = {
  item_added: 'added',
  item_removed: 'removed',
  description_changed: 'description changed',
  surface_added: 'parameter added',
  surface_removed: 'parameter removed',
  schema_changed: 'schema changed',
  returned_to_seen_state: 'back to a seen state',
};

/** Leaf of a JSON path: `$.inputSchema.properties.bcc_emails` → `bcc_emails`. */
function leaf(path: string | undefined): string | null {
  if (path === undefined) return null;
  const parts = path.split('.').filter((p) => p !== '' && p !== '$');
  return parts[parts.length - 1] ?? null;
}

/**
 * The DETAILS column: the most specific true thing that fits on one line.
 * A finding beats a shape change, and a count beats a list.
 */
export function detailsLine(view: ConnectorChangeView): string {
  const param = view.findings.find((f) => f.rule_id === 'sensitive_param_added');
  if (param !== undefined) {
    const name = leaf(param.evidence.path) ?? 'a parameter';
    return `${name} added to ${param.evidence.target ?? 'a tool'}`;
  }
  const marker = view.findings.find(
    (f) => f.rule_id === 'injection_marker' || f.rule_id === 'sensitive_path_reference',
  );
  if (marker !== undefined) {
    const what = marker.rule_id === 'injection_marker' ? 'instruction-like text' : 'a credential path';
    return `${what} in ${marker.evidence.target ?? 'a tool'}`;
  }
  const hidden = view.findings.find((f) => f.rule_id === 'hidden_characters');
  if (hidden !== undefined) {
    const n = hidden.evidence.count ?? 1;
    return `${n} invisible character${n === 1 ? '' : 's'} in ${hidden.evidence.target ?? 'a tool'}`;
  }

  const targets = targetsOf(view);
  if (targets.length === 1) {
    const only = view.changes[0];
    return only === undefined ? targets[0]! : CHANGE_PHRASE[only.kind](only.target);
  }
  // Several items: count them by what happened, not by name.
  const byKind = new Map<string, number>();
  for (const c of view.changes) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  return [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${CHANGE_NOUN[kind as ConnectorChangeEntryView['kind']]}`)
    .join(', ');
}

/** The plain sentence at the top of the detail panel. */
export function humanSummary(view: ConnectorChangeView): string {
  if (view.review === 'baseline') return baselineSummary(view);
  const param = view.findings.find((f) => f.rule_id === 'sensitive_param_added');
  if (param !== undefined) {
    const name = leaf(param.evidence.path) ?? 'a parameter';
    return `A new parameter named \`${name}\` was added to ${param.evidence.target ?? 'a tool'}.`;
  }
  const injected = view.findings.find((f) => f.rule_id === 'injection_marker');
  if (injected !== undefined) {
    return `Instruction-like text appeared in ${injected.evidence.target ?? 'a tool'}, at ${injected.evidence.path ?? 'its definition'}.`;
  }
  const path = view.findings.find((f) => f.rule_id === 'sensitive_path_reference');
  if (path !== undefined) {
    return `A reference to a credential file appeared in ${path.evidence.target ?? 'a tool'}, at ${path.evidence.path ?? 'its definition'}.`;
  }
  const hidden = view.findings.find((f) => f.rule_id === 'hidden_characters');
  if (hidden !== undefined) {
    const n = hidden.evidence.count ?? 1;
    return `${n} invisible character${n === 1 ? '' : 's'} (${hidden.evidence.codepoint ?? 'unknown'}) appeared in ${hidden.evidence.target ?? 'a tool'}.`;
  }
  const targets = targetsOf(view);
  if (targets.length > 1) {
    return `${targets.length} ${SECTION_PLURAL[view.section]} in ${view.mcp} changed.`;
  }
  const only = view.changes[0];
  if (only === undefined) return `${view.mcp} changed.`;
  const sentence = CHANGE_PHRASE[only.kind](only.target);
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

/** A catalog review: what a rule found and where — never "appeared" or
 *  "added", because nothing moved — then the baseline note. */
function baselineSummary(view: ConnectorChangeView): string {
  const note = baselineNote(view.mcp);
  const injected = view.findings.find((f) => f.rule_id === 'injection_marker');
  if (injected !== undefined) {
    return `Instruction-like text in ${injected.evidence.target ?? 'a tool'}, at ${injected.evidence.path ?? 'its definition'}. ${note}`;
  }
  const path = view.findings.find((f) => f.rule_id === 'sensitive_path_reference');
  if (path !== undefined) {
    return `A reference to a credential file in ${path.evidence.target ?? 'a tool'}, at ${path.evidence.path ?? 'its definition'}. ${note}`;
  }
  const hidden = view.findings.find((f) => f.rule_id === 'hidden_characters');
  if (hidden !== undefined) {
    const n = hidden.evidence.count ?? 1;
    return `${n} invisible character${n === 1 ? '' : 's'} (${hidden.evidence.codepoint ?? 'unknown'}) in ${hidden.evidence.target ?? 'a tool'}. ${note}`;
  }
  return note;
}

// What happened to one item, as a person would say it after the item's name.
// Counted, because one tool can gain three parameters in a single release and
// "new parameter added; new parameter added" is not a sentence.
const ITEM_PHRASE: Record<ConnectorChangeEntryView['kind'], (n: number) => string> = {
  item_added: () => 'added',
  item_removed: () => 'removed',
  description_changed: () => 'description changed',
  surface_added: (n) => (n === 1 ? 'new parameter added' : `${n} new parameters added`),
  surface_removed: (n) => (n === 1 ? 'parameter removed' : `${n} parameters removed`),
  schema_changed: () => 'schema changed',
  returned_to_seen_state: () => 'back to a state seen before',
};

/**
 * The panel's per-item list: "list_issues — Description changed; new parameter
 * added". One line per item in the order the change first names it, so the
 * internal kinds (schema_changed, surface_added…) never have to be read to
 * know what happened. They stay in Technical details, where the exact record
 * belongs.
 */
export function itemLines(view: ConnectorChangeView): { target: string; text: string }[] {
  const byTarget = new Map<string, Map<ConnectorChangeEntryView['kind'], number>>();
  for (const c of view.changes) {
    const kinds = byTarget.get(c.target) ?? new Map<ConnectorChangeEntryView['kind'], number>();
    kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    byTarget.set(c.target, kinds);
  }
  return [...byTarget.entries()].map(([target, kinds]) => {
    const text = [...kinds.entries()].map(([kind, n]) => ITEM_PHRASE[kind](n)).join('; ');
    return { target, text: `${text[0]!.toUpperCase()}${text.slice(1)}` };
  });
}

export function historicalNote(view: ConnectorChangeView): string | null {
  if (view.source_format !== 'tool_manifest_changed_v1') return null;
  const date = new Date(view.ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `Changes before ${date} are shown as recorded by the previous format.`;
}

export const SECTION_LABELS: Record<ConnectorChangeView['section'], string> = {
  tools: 'Tools',
  resources: 'Resources',
  resource_templates: 'Resource templates',
  prompts: 'Prompts',
  discovery: 'Server info',
};
