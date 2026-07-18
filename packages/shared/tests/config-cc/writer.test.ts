// updateMcpJson — write engine over real fs in a temp dir, driven through
// the real F2.1b pipeline (classify → computePlan → applyPlan) as the
// injected transform. Foreign writers are simulated INSIDE the transform
// hook: it runs between the writer's first stat/read and its last-act
// re-stat, which is exactly the interleaving the freshness-check guards.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPlan } from '../../src/config-cc/apply.js';
import { classifyEntries } from '../../src/config-cc/classify.js';
import { readSettingsLocal } from '../../src/config-cc/parser.js';
import { computePlan } from '../../src/config-cc/plan.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';
import type { CcMcpTransform } from '../../src/config-cc/writer.js';
import { serializeMcpJson, statFreshness, updateMcpJson } from '../../src/config-cc/writer.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));
const XCG_PATH = '/x/xcg-proxy';

describe('updateMcpJson × spike 3 fixtures (F2.1c part 1)', () => {
  let projectDir: string;
  let mcpPath: string;
  let gatingPath: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-config-cc-test-'));
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    mcpPath = files.entriesPath;
    if (files.gatingPath === undefined) throw new Error('unreachable');
    gatingPath = files.gatingPath;
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function installApproveAll(): void {
    copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), mcpPath);
    mkdirSync(dirname(gatingPath), { recursive: true });
    copyFileSync(join(FIXTURE_DIR, 'settings.local.json.paso6'), gatingPath);
  }

  // The real F2.1b composition as the injected transform. Gating is re-read
  // per invocation, like the future CLI caller will do.
  function transformFor(intent: 'wrap' | 'unwrap'): CcMcpTransform {
    return (state) => {
      const gating = readSettingsLocal(gatingPath);
      if (!gating.ok) throw new Error('unreachable');
      return applyPlan(state.raw, computePlan(classifyEntries(state.servers, gating), intent, XCG_PATH), XCG_PATH);
    };
  }

  it('happy wrap: converged with 1 write, exact bytes, no trailing newline, no .bak', () => {
    installApproveAll();
    const r = updateMcpJson(mcpPath, transformFor('wrap'));
    expect(r).toEqual({ ok: true, outcome: 'converged', writes: 1 });
    const text = readFileSync(mcpPath, 'utf8');
    expect(text.endsWith('}')).toBe(true); // spike 3: CC writes no trailing newline
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(parsed.mcpServers['toy-stdio']?.command).toBe(XCG_PATH);
    expect(parsed.mcpServers['toy-http']).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(text).toBe(serializeMcpJson(parsed)); // bytes are exactly the fixed serialization
    expect(existsSync(`${mcpPath}.bak`)).toBe(false); // backup:false always for .mcp.json
  });

  it('happy unwrap: restores the original fixture BYTES on disk', () => {
    installApproveAll();
    const original = readFileSync(mcpPath, 'utf8');
    expect(updateMcpJson(mcpPath, transformFor('wrap')).ok).toBe(true);
    const r = updateMcpJson(mcpPath, transformFor('unwrap'));
    expect(r).toEqual({ ok: true, outcome: 'converged', writes: 1 });
    expect(readFileSync(mcpPath, 'utf8')).toBe(original);
  });

  it('noop: an already-satisfied transform converges with 0 writes and identical bytes', () => {
    installApproveAll();
    expect(updateMcpJson(mcpPath, transformFor('wrap')).ok).toBe(true);
    const before = readFileSync(mcpPath, 'utf8');
    const r = updateMcpJson(mcpPath, transformFor('wrap'));
    expect(r).toEqual({ ok: true, outcome: 'converged', writes: 0 });
    expect(readFileSync(mcpPath, 'utf8')).toBe(before);
  });

  // Foreign writer between our read and our write: the last-act re-stat must
  // catch it, and round 2 must re-apply the plan over the FOREIGN state so
  // both survive (convergence).
  it('freshness conflict: re-application preserves the foreign mutation AND applies the plan', () => {
    installApproveAll();
    let calls = 0;
    const transform: CcMcpTransform = (state) => {
      calls += 1;
      if (calls === 1) {
        // Foreign writer sneaks in a new server while we compute.
        const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, unknown> };
        parsed.mcpServers['foreign'] = { type: 'stdio', command: 'echo', args: [], env: {} };
        writeFileSync(mcpPath, serializeMcpJson(parsed));
      }
      return transformFor('wrap')(state);
    };
    const r = updateMcpJson(mcpPath, transform);
    expect(r).toEqual({ ok: true, outcome: 'converged', writes: 1 });
    expect(calls).toBe(2);
    const final = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(final.mcpServers['foreign']).toEqual({ type: 'stdio', command: 'echo', args: [], env: {} });
    expect(final.mcpServers['toy-stdio']?.command).toBe(XCG_PATH);
  });

  it('second conflict: gave-up with the observed state, no third attempt, our write count 0', () => {
    installApproveAll();
    let calls = 0;
    let lastForeign = '';
    const transform: CcMcpTransform = (state) => {
      calls += 1;
      // A foreign writer collides on EVERY round (distinct content each time
      // so the second round cannot accidentally match).
      const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, unknown> };
      parsed.mcpServers[`foreign-${calls}`] = { type: 'stdio', command: 'echo', args: [], env: {} };
      lastForeign = serializeMcpJson(parsed);
      writeFileSync(mcpPath, lastForeign);
      return transformFor('wrap')(state);
    };
    const r = updateMcpJson(mcpPath, transform);
    expect(r).toEqual({ ok: false, outcome: 'gave-up', writes: 0, observedText: lastForeign });
    expect(calls).toBe(2); // exactly two rounds, never a third
    expect(readFileSync(mcpPath, 'utf8')).toBe(lastForeign); // we never overwrote the foreigner
  });

  it('hardened token: same-size foreign write with mtime PINNED is detected — explicitly by the ctimeNs leg', () => {
    installApproveAll();
    // Pin a deterministic mtime so the foreign write below can reproduce it
    // exactly — mtime is userland-forgeable via utimes(2).
    const pinned = new Date('2026-07-18T10:00:00.000Z');
    utimesSync(mcpPath, pinned, pinned);
    let calls = 0;
    let legs: { mtimeSame: boolean; sizeSame: boolean; inoSame: boolean; ctimeSame: boolean } | null = null;
    const transform: CcMcpTransform = (state) => {
      calls += 1;
      if (calls === 1) {
        const before = statFreshness(mcpPath);
        // SAME-LENGTH mutation (url .../mcp → .../mcq): the size leg goes
        // blind. In-place write keeps the inode; re-pinning blinds mtime.
        const text = readFileSync(mcpPath, 'utf8');
        writeFileSync(mcpPath, text.replace('https://example.com/mcp', 'https://example.com/mcq'));
        utimesSync(mcpPath, pinned, pinned);
        const after = statFreshness(mcpPath);
        if (before === null || after === null) throw new Error('unreachable');
        legs = {
          mtimeSame: before.mtimeNs === after.mtimeNs,
          sizeSame: before.size === after.size,
          inoSame: before.ino === after.ino,
          ctimeSame: before.ctimeNs === after.ctimeNs,
        };
      }
      return transformFor('wrap')(state);
    };
    const r = updateMcpJson(mcpPath, transform);
    // Three legs are provably blind to this foreign write; ONLY ctimeNs can
    // have flagged it (ctime is not settable from userland — git index
    // precedent). An mtime+size token would have clobbered the mutation.
    expect(legs).toEqual({ mtimeSame: true, sizeSame: true, inoSame: true, ctimeSame: false });
    expect(r).toEqual({ ok: true, outcome: 'converged', writes: 1 });
    expect(calls).toBe(2);
    const final = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(final.mcpServers['toy-http']?.url).toBe('https://example.com/mcq'); // foreign mutation survived
    expect(final.mcpServers['toy-stdio']?.command).toBe(XCG_PATH); // and the plan applied
  });

  it('statFreshness: four bigint legs, and a rename-writer always moves the ino leg', () => {
    installApproveAll();
    const f = statFreshness(mcpPath);
    if (f === null) throw new Error('unreachable');
    expect(typeof f.mtimeNs).toBe('bigint');
    expect(typeof f.ctimeNs).toBe('bigint');
    expect(typeof f.ino).toBe('bigint');
    expect(typeof f.size).toBe('bigint');
    // Atomic rename-writers (writeAtomic, and Claude Code itself) replace
    // the inode: the ino leg detects them even if everything else matched.
    const tmp = join(projectDir, 'incoming.json');
    writeFileSync(tmp, readFileSync(mcpPath));
    renameSync(tmp, mcpPath);
    const g = statFreshness(mcpPath);
    if (g === null) throw new Error('unreachable');
    expect(g.ino).not.toBe(f.ino);
    expect(statFreshness(join(projectDir, 'nope.json'))).toBeNull();
  });

  it('absent .mcp.json: not-found error, nothing created', () => {
    const before = readdirSync(projectDir);
    const r = updateMcpJson(mcpPath, () => ({}));
    expect(r).toEqual({ ok: false, outcome: 'error', error: { kind: 'not-found' } });
    expect(readdirSync(projectDir)).toEqual(before);
  });

  it('corrupt JSON: read error, file untouched byte-for-byte', () => {
    writeFileSync(mcpPath, '{ not valid json');
    const r = updateMcpJson(mcpPath, () => ({}));
    expect(r.ok).toBe(false);
    if (r.ok || r.outcome !== 'error') throw new Error('unreachable');
    expect(r.error.kind).toBe('read');
    expect(readFileSync(mcpPath, 'utf8')).toBe('{ not valid json');
  });
});
