// Install/Uninstall of the Claude Code capture hook in ~/.claude/settings.json
// (F1.3d). Owns the fs around the pure merge/remove from @xcg/shared/config.
// Non-negotiable: a settings.json that fails to parse is NEVER overwritten —
// the user gets a readable error and the disk stays untouched.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { mergeCchookHooks, removeCchookHooks, writeAtomic } from '@xcg/shared/config';

import type { CchookInstallResult } from '../shared/types.js';

function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

type ReadOutcome =
  | { ok: true; settings: unknown; existed: boolean }
  | { ok: false; error: string };

function readSettings(path: string): ReadOutcome {
  if (!existsSync(path)) return { ok: true, settings: {}, existed: false };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.trim() === '') return { ok: true, settings: {}, existed: true };
  try {
    return { ok: true, settings: JSON.parse(raw) as unknown, existed: true };
  } catch {
    return {
      ok: false,
      error: `${path} is not valid JSON — fix or remove it and retry. Nothing was written.`,
    };
  }
}

export function installCchook(settingsPath: string = defaultSettingsPath()): CchookInstallResult {
  const read = readSettings(settingsPath);
  if (!read.ok) return { ok: false, error: read.error };

  if (!read.existed) {
    // Seed so writeAtomic (which stats the target and captures a first-write-
    // wins .bak) has a file to work on — same pattern as the ingester's state.
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, '{}\n', { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `cannot create ${settingsPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const { settings, changed } = mergeCchookHooks(read.settings);
  if (!changed) return { ok: true, outcome: 'noop', settingsPath };

  // The .bak captures the pre-Install state (first-write-wins). On machines
  // with a prior MANUAL registration the .bak carries that manual state, not
  // a pristine one — accepted and documented: it is still the user's own
  // pre-Install reality, which is what a backup is for.
  const wr = writeAtomic(settingsPath, settings);
  if (!wr.ok) return { ok: false, error: `write failed (${wr.error.kind}): ${'detail' in wr.error ? wr.error.detail : ''}` };
  return { ok: true, outcome: 'wrote', settingsPath };
}

export function uninstallCchook(settingsPath: string = defaultSettingsPath()): CchookInstallResult {
  if (!existsSync(settingsPath)) return { ok: true, outcome: 'noop', settingsPath };
  const read = readSettings(settingsPath);
  if (!read.ok) return { ok: false, error: read.error };

  const { settings, changed } = removeCchookHooks(read.settings);
  if (!changed) return { ok: true, outcome: 'noop', settingsPath };

  const wr = writeAtomic(settingsPath, settings);
  if (!wr.ok) return { ok: false, error: `write failed (${wr.error.kind}): ${'detail' in wr.error ? wr.error.detail : ''}` };
  return { ok: true, outcome: 'wrote', settingsPath };
}
