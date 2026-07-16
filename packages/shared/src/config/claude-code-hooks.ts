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
 *  the session timeline; parsing tolerates all of them (F1.2 cc.event). */
export const CCHOOK_EVENTS = ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd'] as const;
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
export function buildCchookHookEntry(): CchookHookEntry {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: 'bash',
        args: ['-c', 'exec "$HOME/Library/Application Support/xCLAUDE Gateway/bin/xcg-cchook"'],
        async: true,
      },
    ],
  };
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

/** Adds our entry to every CCHOOK_EVENTS array that doesn't already carry the
 *  marker. Idempotent; tolerant (non-object settings → treated as {}); never
 *  touches foreign hooks or any other settings field. */
export function mergeCchookHooks(settings: unknown): CchookHooksResult {
  const base: Record<string, unknown> = isPlainObject(settings) ? { ...settings } : {};
  const hooks: Record<string, unknown> = isPlainObject(base['hooks']) ? { ...base['hooks'] } : {};
  let changed = false;
  for (const event of CCHOOK_EVENTS) {
    const existing = hooks[event];
    const entries = Array.isArray(existing) ? existing : [];
    if (entries.some(entryHasMarker)) continue; // already registered (manual included)
    hooks[event] = [...entries, buildCchookHookEntry()];
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
