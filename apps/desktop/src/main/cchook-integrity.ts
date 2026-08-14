// Hook-integrity check — detects the out-of-band removal of the Claude Code
// capture hook from ~/.claude/settings.json. The 2s status poll already
// answers "is the hook registered NOW", but nothing remembered whether it WAS:
// an external rewrite (another program, or the agent editing its own settings)
// degraded to the "Install hook" state in silence. This module keeps that
// memory in claude-code/hook-state.json:
//   expected      — whether the hook SHOULD be registered per the last in-app
//                   action (Install/Uninstall handlers) or observed reality.
//   pendingNotice — set on the expected→unregistered edge; the renderer banner
//                   (CchookVanishedWarning) renders iff set. Cleared by the
//                   explicit Dismiss or by a reinstall (in-app or external).
//
// Split pure/IO like cchook-ingest: planIntegrity / applyExpected /
// applyDismiss are pure (state in, decision out); checkCchookIntegrity and the
// record/dismiss helpers own the fs. The edge is persisted (not renderer
// memory like App's inAppRemoves) because the observer is the main process'
// 15s tick and the notice must survive an app restart landing mid-window.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { cchookSpoolDir } from '@xcg/proxy/cchook-ingest';

import { isHookRegistered } from './claude-code-detect.js';
import { persistJson } from './cchook-ingester.js';
import { writeCchookRemoved } from './recovery-writer.js';

export const HOOK_STATE_FILENAME = 'hook-state.json';

/** Dir holding hook-state.json — the spool's parent (claude-code/), same
 *  resolution as the ingester's sessions.json / ingest-state.json. */
function defaultStateDir(): string {
  return dirname(cchookSpoolDir());
}

// Same private resolution as claude-code-detect.ts / cchook-install.ts —
// replicated rather than exported (precedent: both keep it private). Only
// recorded on the marker; this module never reads the settings file itself.
function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

// --- pure state model ---------------------------------------------------------

export interface CchookHookState {
  /** Whether the hook SHOULD be registered, per the last in-app action or
   *  observed reality. */
  expected: boolean;
  /** Set while an out-of-band removal is undismissed; stamped at detection. */
  pendingNotice: { ts: string } | null;
}

// Tolerant parse (parseHookPayload discipline): anything malformed → null,
// which the check treats as "no state yet" and reseeds from the CURRENT
// registration — fail-safe direction: a corrupt state file can only miss one
// notice, never invent one.
export function parseHookState(raw: unknown): CchookHookState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['expected'] !== 'boolean') return null;
  const pn = obj['pendingNotice'];
  if (pn === null || pn === undefined) return { expected: obj['expected'], pendingNotice: null };
  if (
    typeof pn === 'object' &&
    !Array.isArray(pn) &&
    typeof (pn as Record<string, unknown>)['ts'] === 'string'
  ) {
    return {
      expected: obj['expected'],
      pendingNotice: { ts: (pn as Record<string, unknown>)['ts'] as string },
    };
  }
  return null;
}

// One integrity decision. 'seed' and the two edges write state; 'none' leaves
// the file untouched, so the steady (common) path does zero writes per tick.
export type IntegrityPlan =
  | { kind: 'seed'; next: CchookHookState }
  | { kind: 'vanished'; next: CchookHookState }
  | { kind: 'restored'; next: CchookHookState }
  | { kind: 'none' };

export function planIntegrity(
  state: CchookHookState | null,
  registered: boolean,
  nowIso: string,
): IntegrityPlan {
  // No memory yet → adopt the current reality without a notice: seeding on a
  // machine where the hook never existed (or was already gone) must not warn
  // about a past this module never observed.
  if (state === null) {
    return { kind: 'seed', next: { expected: registered, pendingNotice: null } };
  }
  if (state.expected && !registered) {
    return { kind: 'vanished', next: { expected: false, pendingNotice: { ts: nowIso } } };
  }
  if (!state.expected && registered) {
    // Reinstalled — in-app or out-of-band, both restore the audited state, so
    // any pending notice is resolved.
    return { kind: 'restored', next: { expected: true, pendingNotice: null } };
  }
  return { kind: 'none' };
}

// In-app Install/Uninstall intents (the cchook:install / cchook:uninstall
// handlers). Install resolves a pending notice — the banner's Reinstall button
// lands here, and with expected already true the restored edge could no longer
// fire to clear it. Uninstall records the intent WITHOUT touching an existing
// notice: recording it is what tells the integrity check this removal was
// in-app, not out-of-band.
export function applyExpected(state: CchookHookState | null, expected: boolean): CchookHookState {
  if (expected) return { expected: true, pendingNotice: null };
  return { expected: false, pendingNotice: state?.pendingNotice ?? null };
}

// Explicit dismiss. null = nothing to write (no state, or no notice pending).
export function applyDismiss(state: CchookHookState | null): CchookHookState | null {
  if (state === null || state.pendingNotice === null) return null;
  return { expected: state.expected, pendingNotice: null };
}

// --- fs orchestration ---------------------------------------------------------

export interface CchookIntegrityDeps {
  /** Dir holding hook-state.json (default: claude-code/, the spool's parent). */
  stateDir?: string;
  /** Probe override for tests; default the real isHookRegistered. */
  registered?: () => boolean;
  /** Marker writer override for tests; default writeCchookRemoved. */
  writeMarker?: (settingsPath: string) => void;
  /** Path recorded on the marker; default ~/.claude/settings.json. */
  settingsPath?: string;
  /** Clock override for tests. */
  nowIso?: () => string;
}

function readHookState(statePath: string): CchookHookState | null {
  try {
    return parseHookState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return null;
  }
}

/** The persisted pendingNotice, for the cchook:status payload. */
export function readPendingNotice(stateDir: string = defaultStateDir()): { ts: string } | null {
  return readHookState(join(stateDir, HOOK_STATE_FILENAME))?.pendingNotice ?? null;
}

// One integrity pass: probe → plan → (marker) → persist. Marker BEFORE state
// on the vanished edge, mirroring the ingester's crash-safety choice (favors
// never-losing-a-record over never-duplicating): a crash between the two
// re-detects next tick and appends a second marker, instead of losing the only
// trace of the removal.
export function checkCchookIntegrity(deps: CchookIntegrityDeps = {}): void {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const statePath = join(stateDir, HOOK_STATE_FILENAME);
  const registered = (deps.registered ?? isHookRegistered)();
  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
  const plan = planIntegrity(readHookState(statePath), registered, nowIso());
  if (plan.kind === 'none') return;
  if (plan.kind === 'vanished') {
    (deps.writeMarker ?? writeCchookRemoved)(deps.settingsPath ?? defaultSettingsPath());
  }
  persistJson(statePath, plan.next);
}

/** In-app intent write for the Install (true, wrote/noop) and Uninstall
 *  (false, wrote) handlers. */
export function recordCchookExpected(
  expected: boolean,
  stateDir: string = defaultStateDir(),
): void {
  const statePath = join(stateDir, HOOK_STATE_FILENAME);
  persistJson(statePath, applyExpected(readHookState(statePath), expected));
}

/** cchook:dismiss-vanished — clears the pending notice, keeps `expected`. */
export function dismissCchookNotice(stateDir: string = defaultStateDir()): void {
  const statePath = join(stateDir, HOOK_STATE_FILENAME);
  const next = applyDismiss(readHookState(statePath));
  if (next !== null) persistJson(statePath, next);
}
