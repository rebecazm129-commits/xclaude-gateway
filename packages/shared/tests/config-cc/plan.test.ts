// computePlan — the ONLY gate to transform's raw wrapEntry/unwrapEntry
// (decision B, F2.1b). Exercised through the full pipeline over the real
// spike 3 fixtures: scopes → parser → classify → computePlan.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { unwrapEntry } from '../../src/config/transform.js';
import { applyPlan } from '../../src/config-cc/apply.js';
import { classifyEntries } from '../../src/config-cc/classify.js';
import { readMcpJson, readSettingsLocal } from '../../src/config-cc/parser.js';
import { computePlan } from '../../src/config-cc/plan.js';
import type { CcPlan, CcPlanAction } from '../../src/config-cc/plan.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));
const XCG_PATH = '/x/xcg-proxy';

describe('computePlan × spike 3 fixtures (F2.1b)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Installs the paso4 .mcp.json (or literal content) plus an optional
  // settings fixture, runs the full read → classify → plan pipeline.
  function planFor(
    intent: 'wrap' | 'unwrap',
    opts: { mcpContent?: string; settingsFixture?: string } = {},
  ): CcPlan {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    if (opts.mcpContent !== undefined) {
      writeFileSync(files.entriesPath, opts.mcpContent);
    } else {
      copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), files.entriesPath);
    }
    if (opts.settingsFixture !== undefined && files.gatingPath !== undefined) {
      mkdirSync(dirname(files.gatingPath), { recursive: true });
      copyFileSync(join(FIXTURE_DIR, opts.settingsFixture), files.gatingPath);
    }
    const mcp = readMcpJson(files.entriesPath);
    if (!mcp.ok) throw new Error('unreachable');
    if (files.gatingPath === undefined) throw new Error('unreachable');
    const gating = readSettingsLocal(files.gatingPath);
    if (!gating.ok) throw new Error('unreachable');
    return computePlan(classifyEntries(mcp.servers, gating), intent);
  }

  function actionOf(plan: CcPlan, name: string): CcPlanAction {
    const a = plan.actions.find((x) => x.name === name);
    if (a === undefined) throw new Error(`no action for ${name}`);
    return a;
  }

  // Serializes paso4 with the enabled toy-stdio wrapped, for plans over the
  // already-wrapped state.
  function wrappedPaso4Content(): string {
    const plan = planFor('wrap', { settingsFixture: 'settings.local.json.paso6' });
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    const mcp = readMcpJson(files.entriesPath);
    if (!mcp.ok) throw new Error('unreachable');
    return JSON.stringify(applyPlan(mcp.raw, plan, XCG_PATH), null, 2);
  }

  it('wrap + approve-all (paso6): toy-stdio → wrap; toy-http → skip unsupported', () => {
    const plan = planFor('wrap', { settingsFixture: 'settings.local.json.paso6' });
    expect(plan.intent).toBe('wrap');
    expect(actionOf(plan, 'toy-stdio').action).toBe('wrap');
    // paso6 lists toy-http as enabled, but unsupported still wins.
    expect(actionOf(plan, 'toy-http')).toMatchObject({ action: 'skip', reason: 'unsupported' });
  });

  it('wrap + reject-all (pasoB): toy-stdio → skip disabled', () => {
    const plan = planFor('wrap', { settingsFixture: 'settings.local.json.pasoB-rechazo' });
    expect(actionOf(plan, 'toy-stdio')).toMatchObject({ action: 'skip', reason: 'disabled' });
  });

  it('wrap + no settings file: toy-stdio → skip pending', () => {
    const plan = planFor('wrap');
    expect(actionOf(plan, 'toy-stdio')).toMatchObject({ action: 'skip', reason: 'pending' });
  });

  it('wrap over an already-wrapped state: skip already-wrapped (desired state)', () => {
    const wrapped = wrappedPaso4Content();
    const plan = planFor('wrap', {
      mcpContent: wrapped,
      settingsFixture: 'settings.local.json.paso6',
    });
    expect(actionOf(plan, 'toy-stdio')).toMatchObject({ action: 'skip', reason: 'already-wrapped' });
  });

  it('unwrap over a wrapped state: toy-stdio → unwrap; toy-http → skip unsupported', () => {
    const wrapped = wrappedPaso4Content();
    const plan = planFor('unwrap', {
      mcpContent: wrapped,
      settingsFixture: 'settings.local.json.paso6',
    });
    expect(actionOf(plan, 'toy-stdio').action).toBe('unwrap');
    expect(actionOf(plan, 'toy-http')).toMatchObject({ action: 'skip', reason: 'unsupported' });
  });

  it('unwrap gating ignores approval status: a wrapped entry unwraps even when disabled', () => {
    const wrapped = wrappedPaso4Content();
    const plan = planFor('unwrap', {
      mcpContent: wrapped,
      settingsFixture: 'settings.local.json.pasoB-rechazo',
    });
    expect(actionOf(plan, 'toy-stdio').action).toBe('unwrap');
  });

  it('unwrap over the pristine fixture: skip not-wrapped (desired state)', () => {
    const plan = planFor('unwrap', { settingsFixture: 'settings.local.json.paso6' });
    expect(actionOf(plan, 'toy-stdio')).toMatchObject({ action: 'skip', reason: 'not-wrapped' });
  });

  it('NEGATIVE: a non-wrapped entry never reaches unwrapEntry — whose raw call WOULD corrupt it', () => {
    // Document the hazard computePlan's gate exists for: raw unwrapEntry on
    // the pristine (non-wrapped) toy-stdio entry silently destroys it. This
    // is the fixture of what must NEVER happen through the plan.
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), files.entriesPath);
    const mcp = readMcpJson(files.entriesPath);
    if (!mcp.ok) throw new Error('unreachable');
    const entry = mcp.servers['toy-stdio'];
    if (entry === undefined) throw new Error('unreachable');
    const pristine = entry.raw as Record<string, unknown>;
    const corrupted = unwrapEntry(pristine);
    expect(corrupted.command).toBe('');
    expect(corrupted.args).toEqual([]);
    // The gate: computePlan never emits 'unwrap' for it.
    const plan = planFor('unwrap', { settingsFixture: 'settings.local.json.paso6' });
    const action = actionOf(plan, 'toy-stdio');
    expect(action.action).not.toBe('unwrap');
    expect(action).toMatchObject({ action: 'skip', reason: 'not-wrapped' });
  });
});
