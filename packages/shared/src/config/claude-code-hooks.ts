// Claude Code hooks merge/remove for ~/.claude/settings.json (F1.3d). PURE:
// no fs — the desktop's cchook-install.ts owns reading/writing. The contract
// mirrors transform.ts's "preserve everything foreign" discipline: we only
// ever add or remove entries carrying OUR marker; every other hook, matcher
// or settings field flows through untouched.

/** Token identifying our hook entries: the registered command invokes the
 *  xcg-cchook launcher, so its JSON always contains this string. Must match
 *  CCHOOK_MARKER in the desktop's claude-code-detect.ts. */
export const CCHOOK_MARKER = 'xcg-cchook';

/** Hook events we register for. SessionEnd carries no tool traffic but closes
 *  the session timeline; parsing tolerates all of them (F1.2 cc.event).
 *  Elicitation / ElicitationResult: an MCP server asking the user for input,
 *  and what the user did — async like the rest, so the dialog never waits on
 *  the hook (checked on 2.1.283). */
export const CCHOOK_EVENTS = [
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Elicitation',
  'ElicitationResult',
] as const;
export type CchookEvent = (typeof CCHOOK_EVENTS)[number];

export interface CchookHookEntry {
  matcher: '*';
  hooks: Array<{ type: 'command'; command: 'bash'; args: string[]; async: true }>;
}

// The EXACT shape validated in the dogfood spike (F1.4 lesson): bash -c with
// the launcher path QUOTED inside the -c script — 'Application Support' has a
// space, and Claude Code splits an unquoted command string on it. exec avoids
// a lingering bash between capture start and exit. async: the hook must never
// add latency to the user's session (the capturer is exit-0/catch-all anyway).
//
// The elicitation events also pass their own name (--event <name>): the hook
// then strips what the user typed from an ElicitationResult without relying
// on recognizing the payload's text (fail-closed; see cchook-spool.ts).
export const CCHOOK_EVENT_ARG_EVENTS: readonly CchookEvent[] = ['Elicitation', 'ElicitationResult'];

/** The -c script of the hook this build writes, before any --event. */
export const CCHOOK_LAUNCH_SCRIPT = 'exec "$HOME/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"';

export function buildCchookHookEntry(event?: CchookEvent): CchookHookEntry {
  const eventArg = event !== undefined && CCHOOK_EVENT_ARG_EVENTS.includes(event) ? ` --event ${event}` : '';
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: 'bash',
        args: ['-c', `${CCHOOK_LAUNCH_SCRIPT}${eventArg}`],
        async: true,
      },
    ],
  };
}

// --- which events this Claude Code supports ------------------------------------
//
// Elicitation and ElicitationResult arrived in Claude Code 2.1.76 (public
// CHANGELOG: "Added new `Elicitation` and `ElicitationResult` hooks"). Older
// versions — or a version that cannot be determined — get every other event
// and not these two.
export const ELICITATION_EVENTS: readonly CchookEvent[] = ['Elicitation', 'ElicitationResult'];
export const ELICITATION_MIN_CLAUDE_CODE = '2.1.76';

/** a < b → negative, a > b → positive, equal → 0. Numeric dotted versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10));
  const pb = b.split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The events to register for a Claude Code version (null = unknown). */
export function cchookEventsFor(claudeCodeVersion: string | null): readonly CchookEvent[] {
  if (claudeCodeVersion !== null && compareVersions(claudeCodeVersion, ELICITATION_MIN_CLAUDE_CODE) >= 0) {
    return CCHOOK_EVENTS;
  }
  return CCHOOK_EVENTS.filter((e) => !ELICITATION_EVENTS.includes(e));
}

export interface CchookEventsOption {
  /** Events to consider; default all of CCHOOK_EVENTS. */
  events?: readonly CchookEvent[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Marker check over the serialized entry: robust to hand-edited variants (a
// user's manual registration from the spike counts as ours and is adopted,
// not duplicated).
function entryHasMarker(entry: unknown): boolean {
  try {
    return JSON.stringify(entry).includes(CCHOOK_MARKER);
  } catch {
    return false;
  }
}

export interface CchookHooksResult {
  settings: Record<string, unknown>;
  changed: boolean;
}

/** Adds our entry to every CCHOOK_EVENTS array (or `opts.events`) that
 *  doesn't already carry the marker. Idempotent; tolerant (non-object settings
 *  → treated as {}); never touches foreign hooks or any other settings field. */
export function mergeCchookHooks(settings: unknown, opts: CchookEventsOption = {}): CchookHooksResult {
  const base: Record<string, unknown> = isPlainObject(settings) ? { ...settings } : {};
  const hooks: Record<string, unknown> = isPlainObject(base['hooks']) ? { ...base['hooks'] } : {};
  let changed = false;
  for (const event of opts.events ?? CCHOOK_EVENTS) {
    const existing = hooks[event];
    const entries = Array.isArray(existing) ? existing : [];
    if (entries.some(entryHasMarker)) continue; // already registered (manual included)
    hooks[event] = [...entries, buildCchookHookEntry(event)];
    changed = true;
  }
  if (changed) base['hooks'] = hooks;
  return { settings: base, changed };
}

/** Surgically removes every entry carrying the marker from ALL hook events
 *  (not only ours — a marker entry under a foreign event goes too), pruning
 *  arrays left empty and the hooks object itself if nothing remains. Entries
 *  without the marker are never touched. */
export function removeCchookHooks(settings: unknown): CchookHooksResult {
  const base: Record<string, unknown> = isPlainObject(settings) ? { ...settings } : {};
  if (!isPlainObject(base['hooks'])) return { settings: base, changed: false };
  const hooks: Record<string, unknown> = { ...base['hooks'] };
  let changed = false;
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((entry) => !entryHasMarker(entry));
    if (kept.length === value.length) continue;
    changed = true;
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }
  if (changed) {
    if (Object.keys(hooks).length === 0) {
      delete base['hooks'];
    } else {
      base['hooks'] = hooks;
    }
  }
  return { settings: base, changed };
}

// --- capability check and update (existing installs) ---------------------------
//
// An install made before a hook event existed carries the marker but not the
// event, and isHookRegistered (marker anywhere) still says "registered". The
// check below looks at CAPABILITY instead: for every CCHOOK_EVENTS event (or
// the subset this Claude Code supports), is one of OUR hook commands there, is
// it async, and does it pass --event where the hook needs it (and only
// there). A command of ours that does not run the standard launcher is a
// custom path: reported, never replaced.

export type CchookHookProblem =
  /** No hook command of ours under this event. */
  | 'missing'
  /** Ours, but not `async: true` — it would make Claude Code wait. */
  | 'not_async'
  /** Ours, but without the `--event <name>` this event needs. */
  | 'missing_event_arg'
  /** Ours, with an `--event` this event must not carry. */
  | 'unexpected_event_arg'
  /** Ours (marker), but not the standard launcher command — a hand-made
   *  registration. Left as it is: the update never replaces it. */
  | 'custom_path';

export interface CchookHookIssue {
  event: CchookEvent;
  problem: CchookHookProblem;
}

export type CchookHooksCheck =
  | { state: 'not_installed' }
  | { state: 'up_to_date' }
  | { state: 'outdated'; issues: CchookHookIssue[] };

// Our hook commands under one event: the items of each entry's `hooks` array
// that carry the marker. An entry that carries the marker but has no such
// array (a hand-written variant) counts as one item of ours, itself.
function markerItems(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  const out: unknown[] = [];
  for (const entry of entries) {
    if (!entryHasMarker(entry)) continue;
    const items = isPlainObject(entry) && Array.isArray(entry['hooks']) ? entry['hooks'].filter(entryHasMarker) : [];
    if (items.length > 0) out.push(...items);
    else out.push(entry);
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The standard launcher: `bash -c 'exec "…/bin/xcg-cchook"[ --event X]'`.
function isStandardLauncher(item: unknown): boolean {
  if (!isPlainObject(item) || item['command'] !== 'bash' || !Array.isArray(item['args'])) return false;
  const [flag, script] = item['args'] as unknown[];
  return (
    flag === '-c' &&
    typeof script === 'string' &&
    (script === CCHOOK_LAUNCH_SCRIPT || script.startsWith(`${CCHOOK_LAUNCH_SCRIPT} `))
  );
}

function itemProblems(item: unknown, event: CchookEvent): CchookHookProblem[] {
  if (!isStandardLauncher(item)) return ['custom_path'];
  const problems: CchookHookProblem[] = [];
  if (!isPlainObject(item) || item['async'] !== true) problems.push('not_async');
  let text = '';
  try {
    text = JSON.stringify(item);
  } catch {
    // unserializable: no argument to find
  }
  if (CCHOOK_EVENT_ARG_EVENTS.includes(event)) {
    if (!new RegExp(`--event\\s+${escapeRegExp(event)}(?![A-Za-z])`).test(text)) problems.push('missing_event_arg');
  } else if (/--event\b/.test(text)) {
    problems.push('unexpected_event_arg');
  }
  return problems;
}

/** Event by event (CCHOOK_EVENTS, or `opts.events`), whether our hook is
 *  there as this build writes it. */
export function checkCchookHooks(settings: unknown, opts: CchookEventsOption = {}): CchookHooksCheck {
  const hooks = isPlainObject(settings) && isPlainObject(settings['hooks']) ? settings['hooks'] : {};
  const issues: CchookHookIssue[] = [];
  let anyOurs = false;
  for (const event of opts.events ?? CCHOOK_EVENTS) {
    const items = markerItems(hooks[event]);
    if (items.length === 0) {
      issues.push({ event, problem: 'missing' });
      continue;
    }
    anyOurs = true;
    const seen = new Set<CchookHookProblem>();
    for (const item of items) for (const p of itemProblems(item, event)) seen.add(p);
    for (const problem of seen) issues.push({ event, problem });
  }
  if (!anyOurs) return { state: 'not_installed' };
  return issues.length === 0 ? { state: 'up_to_date' } : { state: 'outdated', issues };
}

/** Issues the update can fix (everything but a custom path). */
export function fixableCchookIssues(check: CchookHooksCheck): CchookHookIssue[] {
  return check.state === 'outdated' ? check.issues.filter((i) => i.problem !== 'custom_path') : [];
}

/**
 * Brings an existing install up to date: mergeCchookHooks adds the events
 * that are missing, then every standard-launcher command of OURS (marker)
 * under a considered event that is not as this build writes it (async,
 * --event) is replaced by the canonical one. A custom path is never replaced.
 * Anything without the marker — other entries, other commands inside the same
 * entry, other events, other settings — is never removed or modified.
 * Idempotent; the input is not mutated.
 */
export function updateCchookHooks(settings: unknown, opts: CchookEventsOption = {}): CchookHooksResult {
  const merged = mergeCchookHooks(settings, opts);
  const base = merged.settings;
  const hooks: Record<string, unknown> = isPlainObject(base['hooks']) ? { ...base['hooks'] } : {};
  let changed = merged.changed;
  for (const event of opts.events ?? CCHOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const canonical = buildCchookHookEntry(event);
    let eventChanged = false;
    const next = entries.map((entry) => {
      if (!entryHasMarker(entry)) return entry;
      const inner: unknown = isPlainObject(entry) ? entry['hooks'] : undefined;
      // Ours, hand-written without a hooks array: a custom path by
      // definition — left as it is.
      if (!isPlainObject(entry) || !Array.isArray(inner) || !inner.some(entryHasMarker)) return entry;
      let entryChanged = false;
      const items = inner.map((item: unknown) => {
        if (!entryHasMarker(item)) return item;
        const problems = itemProblems(item, event);
        if (problems.length === 0 || problems.includes('custom_path')) return item;
        entryChanged = true;
        return canonical.hooks[0];
      });
      if (!entryChanged) return entry;
      eventChanged = true;
      return { ...entry, hooks: items };
    });
    if (eventChanged) {
      hooks[event] = next;
      changed = true;
    }
  }
  if (changed) base['hooks'] = hooks;
  return { settings: base, changed };
}

// --- configuration snippet (settings managed externally) ------------------------
//
// When settings.json is a symlink (or otherwise not ours to write), xCLAUDE
// writes nothing and offers the user a snippet to paste into whatever manages
// the file: ONLY our entries, grouped by event — never the whole hooks block
// nor any other setting.

export interface CchookHooksSnippet {
  hooks: Partial<Record<CchookEvent, CchookHookEntry[]>>;
}

/** Install: our entry for every event this Claude Code supports. */
export function cchookInstallSnippet(events: readonly CchookEvent[] = CCHOOK_EVENTS): CchookHooksSnippet {
  const hooks: Partial<Record<CchookEvent, CchookHookEntry[]>> = {};
  for (const event of events) hooks[event] = [buildCchookHookEntry(event)];
  return { hooks };
}

/** Update: our entry only for the events that are missing or outdated (a
 *  custom path is not included — it is the user's to change). */
export function cchookUpdateSnippet(settings: unknown, events: readonly CchookEvent[] = CCHOOK_EVENTS): CchookHooksSnippet {
  const needed = new Set(fixableCchookIssues(checkCchookHooks(settings, { events })).map((i) => i.event));
  return cchookInstallSnippet(events.filter((e) => needed.has(e)));
}
