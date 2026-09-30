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
  authorization: 'Authorization',
};

const SECTION_PLURAL: Record<ConnectorChangeView['section'], string> = {
  tools: 'definitions',
  resources: 'resources',
  resource_templates: 'resource templates',
  prompts: 'prompts',
  discovery: 'server info fields',
  authorization: 'authorization details',
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
  if (view.section === 'authorization') return AUTHORIZATION_TITLE[authorizationKind(view)];
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
  if (view.section === 'authorization') return authorizationDetails(view);
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
  if (view.section === 'authorization') return authorizationSummary(view);
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
  authorization: 'Authorization',
};

// --- authorization rows ------------------------------------------------------
//
// A sign-in compared with the previous one (proxy.oauth_authorized). The words
// below are a DRAFT pending review. Same two rules as the rest of this file:
// an observation, not an accusation; no severity where no rule matched.

type AuthorizationKind =
  | 'server_changed'
  | 'permissions_expanded'
  | 'reference_unreadable'
  | 'first_sign_in'
  | 'scopes_reduced'
  | 'resource_changed'
  | 'recorded';

/** What the row is about, strongest first: a rule beats a fact. */
export function authorizationKind(view: ConnectorChangeView): AuthorizationKind {
  const a = view.authorization;
  const rules = new Set(view.findings.map((f) => f.rule_id));
  if (rules.has('authorization_server_changed')) return 'server_changed';
  if (rules.has('scopes_expanded')) return 'permissions_expanded';
  if (a?.first_login === true) return a.reference_note === 'reseeded' ? 'reference_unreadable' : 'first_sign_in';
  if ((a?.scopes.removed.length ?? 0) > 0) return 'scopes_reduced';
  if (a?.resource.changed === true) return 'resource_changed';
  return 'recorded';
}

const AUTHORIZATION_TITLE: Record<AuthorizationKind, string> = {
  server_changed: 'Authorization server changed',
  permissions_expanded: 'Permissions expanded',
  reference_unreadable: 'Sign-in recorded (reference reset)',
  first_sign_in: 'First sign-in recorded',
  scopes_reduced: 'Scopes reduced',
  resource_changed: 'Resource changed',
  recorded: 'Sign-in recorded',
};

export const AUTHORIZATION_SERVER_CHANGED_TEXT =
  'This connector is now authorizing through a different server than on its previous login. ' +
  'Verify that the new authorization server belongs to the service you intended to connect.';
export const PERMISSIONS_EXPANDED_TEXT = "This connector was granted permissions it didn't have on its previous login.";
export const SCOPES_REDUCED_TEXT = 'This connector was granted fewer permissions than on its previous login.';
export const RESOURCE_CHANGED_TEXT = 'The resource this connector authorizes for changed since its previous login.';

export const REFERENCE_NOTE_TEXT: Record<NonNullable<NonNullable<ConnectorChangeView['authorization']>['reference_note']>, string> = {
  initialized: 'First sign-in recorded on this Mac. Later sign-ins are compared with this one.',
  reseeded: "The saved reference couldn't be read, so this sign-in wasn't compared. It is now the reference.",
  kept_newer:
    "A newer version of xCLAUDE Gateway saved this reference. It was left untouched and this sign-in wasn't compared.",
  write_failed:
    "This sign-in couldn't be saved as the reference. The next one will be compared with the previous sign-in.",
};

export const SCOPE_SOURCE_ASSUMED_TEXT = 'Granted scopes not returned by the server; showing the requested ones.';
export const SERVER_FALLBACK_TEXT =
  "Not listed in the server's protected resource metadata; the connector URL was used.";

/** The host of a URL, or the value itself when it is not one. */
export function hostOf(url: string | null): string {
  if (url === null) return 'none';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "a, b, c", or "none". */
export function scopeList(scopes: readonly string[] | null): string {
  return scopes === null || scopes.length === 0 ? 'none' : scopes.join(', ');
}

function authorizationDetails(view: ConnectorChangeView): string {
  const a = view.authorization;
  if (a === undefined) return '';
  switch (authorizationKind(view)) {
    case 'server_changed':
      return `${hostOf(a.authorization_server.before)} → ${hostOf(a.authorization_server.now)}`;
    case 'permissions_expanded':
      return `added: ${scopeList(a.scopes.added)}`;
    case 'scopes_reduced':
      return `removed: ${scopeList(a.scopes.removed)}`;
    case 'resource_changed':
      return `${hostOf(a.resource.before)} → ${hostOf(a.resource.now)}`;
    default:
      return hostOf(a.authorization_server.now);
  }
}

/** Every sentence that applies, strongest first: a login can change the
 *  server AND expand the scopes, and the summary must not hide the second. */
function authorizationSummary(view: ConnectorChangeView): string {
  const a = view.authorization;
  if (a === undefined) return `${view.mcp} signed in.`;
  const rules = new Set(view.findings.map((f) => f.rule_id));
  const parts: string[] = [];
  if (rules.has('authorization_server_changed')) parts.push(AUTHORIZATION_SERVER_CHANGED_TEXT);
  if (rules.has('scopes_expanded')) parts.push(`${PERMISSIONS_EXPANDED_TEXT} Added: ${scopeList(a.scopes.added)}.`);
  if (a.first_login) parts.push(REFERENCE_NOTE_TEXT[a.reference_note === 'reseeded' ? 'reseeded' : 'initialized']);
  if (!a.first_login && a.scopes.removed.length > 0) {
    parts.push(`${SCOPES_REDUCED_TEXT} Removed: ${scopeList(a.scopes.removed)}.`);
  }
  if (a.resource.changed) parts.push(RESOURCE_CHANGED_TEXT);
  if (a.reference_note === 'kept_newer' || a.reference_note === 'write_failed') {
    parts.push(REFERENCE_NOTE_TEXT[a.reference_note]);
  }
  return parts.length > 0 ? parts.join(' ') : `${view.mcp} signed in.`;
}
