// Stress harness for the .mcp.json write engine — F2.1c part 2, the closing
// gate of F2.1. SYNTHETIC foreign writer (the real-Claude-Code variant is
// F2.5/dogfood). Gated behind XCG_STRESS so the fast suite stays fast and
// deterministic: run it with `npm run test:stress`.
//
// Contract under test (fixed, see writer.ts header): the invariant is "no
// UNDETECTED loss outside the residual window" — never an absolute "zero
// loss". 'converged' means no conflict DETECTED; at most 2 writes per
// updateMcpJson.
//
// Shape: a child PROCESS (real fs interleaving, not same-thread) does full
// RMW cycles on the file — read, add a monotonically-numbered mutation under
// its own 'foreign-probe' server entry, write back mixing in-place writes
// and tmp/rename — at random 5-50 ms intervals, journaling every event with
// timestamps to a JSONL sidecar. In parallel the parent runs ~200
// updateMcpJson calls alternating wrap/unwrap, instrumented ONLY through the
// injected transform (public API) plus post-update reads; writer.ts is not
// touched.
//
// ACCOUNTING (re-audit condition 2): an exhaustive PARTITION — every
// foreign id in the journal lands in exactly ONE bucket, buckets are
// mutually exclusive, and their sizes sum to the journal's write count
// (asserted). First-match order:
//   survivedFinal              — the id sitting in the file at the end.
//   supersededByForeign        — a later foreign RMW read it back (prevId
//                                chain): the child overwrote its own
//                                mutation. The majority fate; NOT a loss.
//   lostDuringGaveUp           — vanished unseen during an update that
//                                reported gave-up: lost WITH an explicit
//                                detection report, not silently.
//   lostInResidualWindow       — vanished unseen during one of our
//                                converged writes, its write landing within
//                                [last transform return − clock margin,
//                                update end]: the contract's allowed
//                                residual window. Metric, with deltas.
//   lostUndetectedOutsideWindow— vanished unseen during one of our
//                                converged writes, its write landing BEFORE
//                                our final freshness stat (margin applied):
//                                THE invariant violation. Asserted zero.
//   unclassifiable             — everything else (no update window matches,
//                                the matched update wrote nothing, ordering
//                                anomalies, bad post-reads). Reported,
//                                never silently dropped.
//
// Robustness per the F2.1c part 2 re-audit:
// (A) parseability is asserted at CALM points only (foreign writer stopped);
//     mid-storm invalid reads are re-read after a few ms — if they parse,
//     they were the in-place writer's transient half-file (correct behavior
//     of the ENVIRONMENT, counted as metric); engine 'read' errors during
//     the storm are metrics and the loop continues.
// (B) unconditional teardown: the child is killed and awaited in
//     afterEach/finally even when assertions throw (no orphans, no hung
//     vitest); the journal is read ONLY after the child's exit is confirmed.
// (C) anti-livelock: assert that all iterations complete within the test
//     timeout and that a final calm update converges; converged/gave-up
//     rates are reported metrics with NO asserted threshold.
// (3) metrics are emitted BEFORE any assertion, so a red run always carries
//     its full metrics block.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyPlan } from '../../src/config-cc/apply.js';
import { classifyEntries } from '../../src/config-cc/classify.js';
import { readSettingsLocal } from '../../src/config-cc/parser.js';
import { computePlan } from '../../src/config-cc/plan.js';
import { resolveScopeFiles } from '../../src/config-cc/scopes.js';
import type { CcMcpTransform, CcWriteResult } from '../../src/config-cc/writer.js';
import { updateMcpJson } from '../../src/config-cc/writer.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/config-cc/', import.meta.url));
const XCG_PATH = '/x/xcg-proxy';
const ITERATIONS = 200;
// ms-clock slop for the loss classifier: boundary cases fall toward the
// residual-window metric, never toward a false invariant failure (tolerance
// by count, not by exact timing).
const CLOCK_MARGIN_MS = 5;

// Foreign writer, run via `node -e` in a SEPARATE process. Plain CJS on
// purpose. argv: target path, journal path, min/max interval ms. Journals
// one JSON line per event; appendFileSync so lines survive SIGTERM without
// stream-flush coordination. Mixes in-place and tmp/rename writes 50/50.
const FOREIGN_WRITER_SRC = `
const fs = require('node:fs');
const [target, journal, minStr, maxStr] = process.argv.slice(1);
const min = Number(minStr), max = Number(maxStr);
let stop = false;
process.on('SIGTERM', () => { stop = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (obj) => fs.appendFileSync(journal, JSON.stringify(obj) + '\\n');
(async () => {
  let id = 0;
  while (!stop) {
    await sleep(min + Math.random() * (max - min));
    if (stop) break;
    let parsed, prevId = null;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      const probe = parsed.mcpServers && parsed.mcpServers['foreign-probe'];
      prevId = probe && probe.env && probe.env.XCG_STRESS_ID ? Number(probe.env.XCG_STRESS_ID) : null;
    } catch (e) {
      log({ ev: 'read-fail', t: Date.now() });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) continue;
    id += 1;
    parsed.mcpServers['foreign-probe'] = {
      type: 'stdio', command: 'echo', args: [String(id)], env: { XCG_STRESS_ID: String(id) },
    };
    const text = JSON.stringify(parsed, null, 2);
    const mode = Math.random() < 0.5 ? 'inplace' : 'rename';
    const t0 = Date.now();
    try {
      if (mode === 'inplace') {
        fs.writeFileSync(target, text);
      } else {
        const tmp = target + '.foreign-tmp';
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, target);
      }
      log({ ev: 'write', id, prevId, mode, t0, t1: Date.now() });
    } catch (e) {
      log({ ev: 'write-fail', id, code: String((e && e.code) || e), t: Date.now() });
    }
  }
  process.exit(0);
})();
`;

// type alias (not interface) so the type-guard narrowing from
// Record<string, unknown> is assignable via the implicit index signature.
type ForeignWrite = {
  ev: 'write';
  id: number;
  prevId: number | null;
  mode: 'inplace' | 'rename';
  t0: number;
  t1: number;
};

interface UpdateRecord {
  i: number;
  intent: 'wrap' | 'unwrap';
  tStart: number;
  rounds: Array<{ foreignId: number | null; tReturn: number }>;
  result: CcWriteResult;
  tEnd: number;
  postId: number | null;
  postParse: 'ok' | 'transient' | 'bad';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.env.XCG_STRESS !== '1')('updateMcpJson stress harness (F2.1c part 2)', () => {
  let projectDir: string;
  let mcpPath: string;
  let gatingPath: string;
  let journalPath: string;
  let child: ChildProcess | null = null;
  let childExit: Promise<void> | null = null;

  beforeEach(() => {
    projectDir = mkdtempSync(join(osTmpdir(), 'xcg-stress-'));
    const files = resolveScopeFiles({ scope: 'project', projectDir });
    mcpPath = files.entriesPath;
    if (files.gatingPath === undefined) throw new Error('unreachable');
    gatingPath = files.gatingPath;
    journalPath = join(projectDir, 'foreign-journal.jsonl');
    copyFileSync(join(FIXTURE_DIR, 'mcp.json.paso4'), mcpPath);
    mkdirSync(dirname(gatingPath), { recursive: true });
    copyFileSync(join(FIXTURE_DIR, 'settings.local.json.paso6'), gatingPath);
  });

  // Condition B: unconditional teardown — SIGTERM, bounded wait, SIGKILL
  // fallback, and only then is the child considered gone.
  async function stopChild(): Promise<void> {
    if (child === null || childExit === null) return;
    const c = child;
    const exited = childExit;
    child = null;
    childExit = null;
    c.kill('SIGTERM');
    const clean = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
    if (!clean) {
      c.kill('SIGKILL');
      await exited;
    }
  }

  afterEach(async () => {
    await stopChild();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function transformFor(intent: 'wrap' | 'unwrap'): CcMcpTransform {
    return (state) => {
      const gating = readSettingsLocal(gatingPath);
      if (!gating.ok) throw new Error('unreachable');
      return applyPlan(state.raw, computePlan(classifyEntries(state.servers, gating), intent, XCG_PATH), XCG_PATH);
    };
  }

  function readForeignId(): { parse: 'ok' | 'bad'; id: number | null } {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      const idStr = parsed.mcpServers?.['foreign-probe']?.env?.['XCG_STRESS_ID'];
      return { parse: 'ok', id: idStr !== undefined ? Number(idStr) : null };
    } catch {
      return { parse: 'bad', id: null };
    }
  }

  it('survives a foreign RMW storm: no undetected loss outside the residual window', async () => {
    child = spawn(process.execPath, ['-e', FOREIGN_WRITER_SRC, mcpPath, journalPath, '5', '50'], {
      stdio: 'ignore',
    });
    const c = child;
    childExit = new Promise<void>((resolve) => c.once('exit', () => resolve()));

    const records: UpdateRecord[] = [];
    let transientParses = 0;
    let badParsesDuringStorm = 0;

    try {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const intent: 'wrap' | 'unwrap' = i % 2 === 0 ? 'wrap' : 'unwrap';
        const rounds: UpdateRecord['rounds'] = [];
        const inner = transformFor(intent);
        const transform: CcMcpTransform = (state) => {
          const raw = state.raw as { mcpServers?: Record<string, { env?: Record<string, string> }> };
          const idStr = raw.mcpServers?.['foreign-probe']?.env?.['XCG_STRESS_ID'];
          const value = inner(state);
          rounds.push({ foreignId: idStr !== undefined ? Number(idStr) : null, tReturn: Date.now() });
          return value;
        };
        const tStart = Date.now();
        const result = updateMcpJson(mcpPath, transform);
        const tEnd = Date.now();

        // Post-update read with the condition-A transient protocol.
        let post = readForeignId();
        let postParse: UpdateRecord['postParse'] = post.parse === 'ok' ? 'ok' : 'bad';
        if (post.parse === 'bad') {
          await sleep(10);
          post = readForeignId();
          if (post.parse === 'ok') {
            postParse = 'transient';
            transientParses += 1;
          } else {
            badParsesDuringStorm += 1; // judged at calm, not here
          }
        }
        records.push({ i, intent, tStart, rounds, result, tEnd, postId: post.id, postParse });
        await sleep(Math.random() * 15);
      }
    } finally {
      await stopChild(); // condition B: also on assertion/exception paths
    }

    // ---- Journal: read ONLY after the child's exit is confirmed (B). ----
    const journalLines = readFileSync(journalPath, 'utf8').split('\n').filter((l) => l !== '');
    const events = journalLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const foreignWrites = events.filter((e): e is ForeignWrite => e.ev === 'write');
    const foreignReadFails = events.filter((e) => e.ev === 'read-fail').length;
    const foreignWriteFails = events.filter((e) => e.ev === 'write-fail').length;

    // ---- Calm-point OBSERVATIONS (asserted only after metrics, cond. 3). --
    const calm = readForeignId();
    const finalResult = updateMcpJson(mcpPath, transformFor('wrap'));
    const finalRead = readForeignId();
    let finalParsed: { mcpServers: Record<string, Record<string, unknown>> } | null = null;
    try {
      finalParsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    } catch {
      finalParsed = null;
    }

    // ---- Exhaustive partition of every foreign id (see header). ----
    const seenByForeign = new Set<number>();
    for (const w of foreignWrites) {
      if (w.prevId !== null) seenByForeign.add(w.prevId);
    }
    const buckets = {
      survivedFinal: [] as number[],
      supersededByForeign: [] as number[],
      lostDuringGaveUp: [] as number[],
      lostInResidualWindow: [] as number[],
      lostUndetectedOutsideWindow: [] as number[],
      unclassifiable: [] as number[],
    };
    const residualDeltasMs: number[] = [];
    const violationDetails: Array<Record<string, unknown>> = [];
    for (const w of foreignWrites) {
      if (w.id === finalRead.id) {
        buckets.survivedFinal.push(w.id);
        continue;
      }
      if (seenByForeign.has(w.id)) {
        buckets.supersededByForeign.push(w.id);
        continue;
      }
      // Vanished without the child ever reading it back: only our writes can
      // have clobbered it. Attribute it to the update whose lifetime
      // contains its write instant (condition 1: per-update lower bound; the
      // per-id loop makes double counting impossible).
      const u = records.find(
        (r) => w.t1 >= r.tStart - CLOCK_MARGIN_MS && w.t1 <= r.tEnd + CLOCK_MARGIN_MS,
      );
      if (u === undefined) {
        buckets.unclassifiable.push(w.id);
        continue;
      }
      if (!u.result.ok && u.result.outcome === 'gave-up') {
        buckets.lostDuringGaveUp.push(w.id);
        continue;
      }
      const lastRound = u.rounds[u.rounds.length - 1];
      const canClobber =
        u.result.ok &&
        u.result.outcome === 'converged' &&
        u.result.writes >= 1 &&
        lastRound !== undefined &&
        (lastRound.foreignId ?? -1) < w.id;
      if (!canClobber || lastRound === undefined) {
        buckets.unclassifiable.push(w.id);
        continue;
      }
      if (w.t1 < lastRound.tReturn - CLOCK_MARGIN_MS) {
        buckets.lostUndetectedOutsideWindow.push(w.id);
        violationDetails.push({
          update: u.i,
          intent: u.intent,
          foreignId: w.id,
          mode: w.mode,
          t1: w.t1,
          lastTransformReturn: lastRound.tReturn,
        });
      } else {
        buckets.lostInResidualWindow.push(w.id);
        residualDeltasMs.push(w.t1 - lastRound.tReturn);
      }
    }
    const partitionSum =
      buckets.survivedFinal.length +
      buckets.supersededByForeign.length +
      buckets.lostDuringGaveUp.length +
      buckets.lostInResidualWindow.length +
      buckets.lostUndetectedOutsideWindow.length +
      buckets.unclassifiable.length;

    // ---- Metrics FIRST (condition 3): a red run still reports in full. ----
    const converged = records.filter((r) => r.result.ok && r.result.outcome === 'converged');
    const gaveUp = records.filter((r) => !r.result.ok && r.result.outcome === 'gave-up');
    const errors = records.filter((r) => !r.result.ok && r.result.outcome === 'error');
    const writesDist: Record<string, number> = { '0': 0, '1': 0, '2': 0 };
    for (const r of records) {
      if (r.result.outcome !== 'error') {
        writesDist[String(r.result.writes)] = (writesDist[String(r.result.writes)] ?? 0) + 1;
      }
    }
    console.log('[stress metrics]', JSON.stringify({
      iterations: records.length,
      converged: converged.length,
      gaveUp: gaveUp.length,
      errorsDuringStorm: errors.length,
      writesDist,
      updatesWithReApplication: records.filter((r) => r.rounds.length === 2).length,
      transientHalfFileReads: transientParses,
      unresolvedBadParsesDuringStorm: badParsesDuringStorm,
      foreignWrites: foreignWrites.length,
      foreignReadFails,
      foreignWriteFails,
      partition: {
        survivedFinal: buckets.survivedFinal.length,
        supersededByForeign: buckets.supersededByForeign.length,
        lostDuringGaveUp: buckets.lostDuringGaveUp.length,
        lostInResidualWindow: buckets.lostInResidualWindow.length,
        lostUndetectedOutsideWindow: buckets.lostUndetectedOutsideWindow.length,
        unclassifiable: buckets.unclassifiable.length,
      },
      partitionSum,
      residualDeltasMs,
      violationDetails,
      unclassifiableIds: buckets.unclassifiable,
      calmParse: calm.parse,
      finalOutcome: finalResult.outcome,
      finalForeignId: finalRead.id,
    }, null, 2));

    // ---- Assertions (all observations already reported above). ----
    // Invariant 1 at calm (condition A).
    expect(calm.parse).toBe('ok');
    // Invariant 3: the final calm update converges onto the expected state.
    expect(finalResult.ok).toBe(true);
    if (!finalResult.ok) throw new Error('unreachable');
    expect(finalResult.outcome).toBe('converged');
    expect(finalParsed).not.toBeNull();
    if (finalParsed === null) throw new Error('unreachable');
    expect(finalParsed.mcpServers['toy-stdio']?.command).toBe(XCG_PATH);
    expect(finalParsed.mcpServers['toy-http']).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    // Invariant 4 / condition C: the loop completed within the timeout.
    expect(records.length).toBe(ITERATIONS);
    // Condition 2: the partition is exhaustive — every journaled id landed
    // in exactly one bucket.
    expect(partitionSum).toBe(foreignWrites.length);
    // Invariant 2: zero undetected losses outside the residual window.
    expect(violationDetails).toEqual([]);
    expect(buckets.lostUndetectedOutsideWindow).toEqual([]);
  }, 120_000);
});
