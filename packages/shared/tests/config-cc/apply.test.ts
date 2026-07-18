// applyPlan — pure application over the real spike 3 fixtures. The byte
// identity claims are literal: fixtures serialize back byte-for-byte via
// JSON.stringify(·, null, 2) (Claude Code's own format, no trailing newline
// in .mcp.json), so round-trip tests compare against the fixture FILE.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPlan } from '../../src/config-cc/apply.js';
import { classifyEntries } from '../../src/config-cc/classify.js';
import { readMcpJson, readSettingsLocal } from '../../src/config-cc/parser.js';
import { computePlan } from '../../src/config-cc/plan.js';
import type { CcPlan } from '../../src/config-cc/plan.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));
const XCG_PATH = '/x/xcg-proxy';

describe('applyPlan × spike 3 fixtures (F2.1b)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // read → classify → plan over whatever is installed at the project paths.
  function pipeline(intent: 'wrap' | 'unwrap'): { raw: unknown; plan: CcPlan } {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    const mcp = readMcpJson(files.entriesPath);
    if (!mcp.ok) throw new Error('unreachable');
    if (files.gatingPath === undefined) throw new Error('unreachable');
    const gating = readSettingsLocal(files.gatingPath);
    if (!gating.ok) throw new Error('unreachable');
    return { raw: mcp.raw, plan: computePlan(classifyEntries(mcp.servers, gating), intent) };
  }

  function installApproveAll(): void {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), files.entriesPath);
    if (files.gatingPath === undefined) throw new Error('unreachable');
    mkdirSync(dirname(files.gatingPath), { recursive: true });
    copyFileSync(join(FIXTURE_DIR, 'settings.local.json.paso6'), files.gatingPath);
  }

  function serversOf(applied: unknown): Record<string, Record<string, unknown>> {
    return (applied as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
  }

  it('sanity: the paso4 fixture round-trips JSON.parse → stringify byte-identical', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), 'utf8');
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
  });

  it('wrap approve-all: toy-stdio wrapped with the exact contract, key order preserved', () => {
    installApproveAll();
    const { raw, plan } = pipeline('wrap');
    const wrapped = serversOf(applyPlan(raw, plan, XCG_PATH))['toy-stdio'];
    if (wrapped === undefined) throw new Error('unreachable');
    expect(wrapped).toEqual({
      type: 'stdio',
      command: XCG_PATH,
      args: ['stdio', '--wrap', 'node', '--name', 'toy-stdio', '--', '/Users/user/spikes/xcg-spike3/toy-server.js'],
      env: {},
    });
    // wrapEntry spreads the original first: CC's key order survives the wrap.
    expect(Object.keys(wrapped)).toEqual(['type', 'command', 'args', 'env']);
  });

  it('wrap approve-all: the unsupported toy-http passes through BY REFERENCE', () => {
    installApproveAll();
    const { raw, plan } = pipeline('wrap');
    const applied = serversOf(applyPlan(raw, plan, XCG_PATH));
    const original = (raw as { mcpServers: Record<string, unknown> }).mcpServers['toy-http'];
    expect(applied['toy-http']).toBe(original);
  });

  it('preserves foreign top-level keys and their position, and does not mutate raw', () => {
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    writeFileSync(files.entriesPath, JSON.stringify({
      foreign: { a: 1 },
      mcpServers: {
        srv: { type: 'stdio', command: 'node', args: ['s.js'], env: {}, custom: 'kept' },
      },
      trailing: true,
    }, null, 2));
    if (files.gatingPath === undefined) throw new Error('unreachable');
    mkdirSync(dirname(files.gatingPath), { recursive: true });
    writeFileSync(files.gatingPath, JSON.stringify({ enabledMcpjsonServers: ['srv'] }));
    const { raw, plan } = pipeline('wrap');
    const before = JSON.stringify(raw, null, 2);
    const applied = applyPlan(raw, plan, XCG_PATH) as Record<string, unknown>;
    expect(JSON.stringify(raw, null, 2)).toBe(before); // input untouched
    expect(Object.keys(applied)).toEqual(['foreign', 'mcpServers', 'trailing']);
    expect(applied.foreign).toBe((raw as Record<string, unknown>).foreign);
    const srv = serversOf(applied)['srv'];
    if (srv === undefined) throw new Error('unreachable');
    expect(srv.custom).toBe('kept'); // unknown entry field flows through
  });

  it('round-trip wrap → unwrap is byte-identical to the original fixture FILE', () => {
    installApproveAll();
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    const originalText = readFileSync(files.entriesPath, 'utf8');
    // Wrap, persist the wrapped state, then re-run the pipeline for unwrap
    // exactly as F2.1c will: plan always computed against what is on disk.
    const wrapRun = pipeline('wrap');
    const wrapped = applyPlan(wrapRun.raw, wrapRun.plan, XCG_PATH);
    writeFileSync(files.entriesPath, JSON.stringify(wrapped, null, 2));
    const unwrapRun = pipeline('unwrap');
    const restored = applyPlan(unwrapRun.raw, unwrapRun.plan, XCG_PATH);
    expect(JSON.stringify(restored, null, 2)).toBe(originalText);
  });

  it('idempotent: applying the same wrap plan twice ≡ once', () => {
    installApproveAll();
    const { raw, plan } = pipeline('wrap');
    const once = applyPlan(raw, plan, XCG_PATH);
    const twice = applyPlan(once, plan, XCG_PATH);
    expect(JSON.stringify(twice, null, 2)).toBe(JSON.stringify(once, null, 2));
  });

  it('idempotent: applying the same unwrap plan twice ≡ once', () => {
    installApproveAll();
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    const wrapRun = pipeline('wrap');
    writeFileSync(files.entriesPath, JSON.stringify(applyPlan(wrapRun.raw, wrapRun.plan, XCG_PATH), null, 2));
    const { raw, plan } = pipeline('unwrap');
    const once = applyPlan(raw, plan, XCG_PATH);
    const twice = applyPlan(once, plan, XCG_PATH);
    expect(JSON.stringify(twice, null, 2)).toBe(JSON.stringify(once, null, 2));
  });

  it('defends against a rogue hand-built plan: unwrap action on a non-wrapped entry is a no-op', () => {
    installApproveAll();
    const { raw } = pipeline('wrap');
    const pristine = (raw as { mcpServers: Record<string, unknown> }).mcpServers['toy-stdio'];
    const rogue: CcPlan = {
      intent: 'unwrap',
      actions: [{ action: 'unwrap', name: 'toy-stdio', entry: { raw: pristine } }],
    };
    const applied = serversOf(applyPlan(raw, rogue, XCG_PATH));
    // The apply-level gate: the entry is untouched, NOT corrupted to
    // command '' / args [] (see plan.test.ts's negative test).
    expect(applied['toy-stdio']).toBe(pristine);
  });

  it('shape guards: non-object raw and non-object mcpServers return the input untouched', () => {
    const plan: CcPlan = { intent: 'wrap', actions: [] };
    expect(applyPlan(undefined, plan, XCG_PATH)).toBeUndefined();
    expect(applyPlan('nope', plan, XCG_PATH)).toBe('nope');
    const odd = { mcpServers: 42 };
    expect(applyPlan(odd, plan, XCG_PATH)).toBe(odd);
  });
});
