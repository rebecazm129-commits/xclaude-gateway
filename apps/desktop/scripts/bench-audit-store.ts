// Micro-benchmark: does N small files in wrappers/ degrade the AuditStore?
// F2.2 evidence — reproducible measurement behind the pre-opt-in gate
// condition (Claude Code churn must not degrade the reader).
//
// NOT part of the test suite and NOT registered in package.json: run it by
// hand when the reader changes or when re-deciding compaction post-beta.4.
//
// Usage (from the repo root):
//   packages/proxy/node_modules/.bin/esbuild --bundle \
//     apps/desktop/scripts/bench-audit-store.ts \
//     --platform=node --format=cjs --outfile=/tmp/bench-audit-store.cjs
//   node --expose-gc /tmp/bench-audit-store.cjs <N>       # e.g. 1500, 10000, 50000
//
// What it measures, per N (3 reps, median [min-max] printed):
//   - readdir+stat isolated       (pure syscall floor, ~18 µs/file)
//   - cold start: first get()     (sequential stat+open+read+parse per file)
//   - warm refresh: get() again   (readdir + stat×N + full re-assemble — this
//                                  is what every 2s-poll tick pays)
//   - warm getPage                (measured with minRefreshMs:0, so it
//                                  INCLUDES a refresh; production coalesces)
//   - retention sweep scan        ('30d' over fresh files: 2×readdir+2N×stat,
//                                  deletes nothing — asserted)
//   - process RSS after cold start
//
// Reference numbers on this machine, 2026-07-18 (N=1.500 / 10.000 / 50.000):
//   cold start    310ms / 1.089ms / 7.399ms
//   warm refresh   55ms /   221ms /   994ms
//   (all operations linear in N in the measured range; the risk is absolute
//   budget, not a cliff — see the F2.2 recon report.)
//
// This script imports PRODUCTION INTERNALS (audit-store.ts, retention.ts) on
// purpose: if a refactor breaks these imports, the loud break is the signal
// to RE-MEASURE, not to route the bench around the change.
//
// Synthetic file shape mimics the real trail (envelope shape only, NO real
// data): small files = proxy.started + one mcp.request/mcp.response pair
// (~1.3 KB, like the observed handshake-only churn files); a FIXED count of
// 30 large files (1-4 MB of request/response pairs) models the observed
// traffic outliers — outliers scale with real-usage sessions, not with the
// churn, so their count stays constant across N. Everything is generated in
// a tmpdir and deleted in a finally; production data is never touched.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuditStore } from '../src/main/audit-store.js';
import { runSweep } from '../src/main/retention.js';

const N = Number(process.argv[2] ?? '1500');
const REPS = 3;
const LARGE_FILES = 30;

// --- minimal monotonic ULID generator (Crockford, valid for decodeUlidTime) ---
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidSeq = 0;
function ulidAt(ms: number): string {
  let t = ms;
  const time: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  // 16 "random" chars from a counter — uniqueness matters, randomness doesn't.
  let s = ++ulidSeq;
  const rand: string[] = new Array(16);
  for (let i = 15; i >= 0; i--) {
    rand[i] = CROCKFORD[s % 32]!;
    s = Math.floor(s / 32);
  }
  return time.join('') + rand.join('');
}

function requestLine(session: string, ts: string, rpcId: number, pad: string): string {
  return JSON.stringify({
    v: 1, id: ulidAt(Date.parse(ts)), ts, session, mcp: 'bench-server',
    type: 'mcp.request', method: 'tools/call', toolName: 'bench_tool',
    rpcId, direction: 'client_to_server',
    argumentsJson: JSON.stringify({ q: pad }),
    detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
  });
}

function responseLine(session: string, ts: string, rpcId: number, pad: string): string {
  return JSON.stringify({
    v: 1, id: ulidAt(Date.parse(ts)), ts, session, mcp: 'bench-server',
    type: 'mcp.response', rpcId, direction: 'server_to_client',
    resultJson: JSON.stringify({ content: [{ type: 'text', text: pad }] }),
    detection: { category: 'tool_call_allowed', severity: 'low', findings: [] },
  });
}

function startedLine(session: string, ts: string): string {
  return JSON.stringify({
    v: 1, id: ulidAt(Date.parse(ts)), ts, session, mcp: 'bench-server',
    type: 'proxy.started', pid: 12345, wrap: '/usr/local/bin/npx',
    wrappedArgs: ['-y', '@bench/server-fake', '/Users/user/bench'],
  });
}

function generate(dir: string, n: number): { bytes: number; genMs: number } {
  const t0 = performance.now();
  let bytes = 0;
  const pad = 'x'.repeat(320); // sizes the small file to ~1.3 KB total
  const bigPad = 'y'.repeat(900);
  const baseMs = Date.now() - 24 * 3600 * 1000; // yesterday, so ULIDs are plausible
  for (let i = 0; i < n; i++) {
    const sessionUlid = ulidAt(baseMs + i);
    const ts = new Date(baseMs + i).toISOString();
    let content: string;
    if (i < LARGE_FILES) {
      // Large outlier: 1-4 MB of request/response pairs.
      const targetBytes = (1 + (i % 4)) * 1024 * 1024;
      const parts: string[] = [startedLine(sessionUlid, ts)];
      let sz = 0;
      let rpc = 0;
      while (sz < targetBytes) {
        const a = requestLine(sessionUlid, ts, rpc, bigPad);
        const b = responseLine(sessionUlid, ts, rpc, bigPad);
        parts.push(a, b);
        sz += a.length + b.length + 2;
        rpc++;
      }
      content = parts.join('\n') + '\n';
    } else {
      content = [
        startedLine(sessionUlid, ts),
        requestLine(sessionUlid, ts, 0, pad),
        responseLine(sessionUlid, ts, 0, pad),
      ].join('\n') + '\n';
    }
    writeFileSync(join(dir, `${sessionUlid}.jsonl`), content);
    bytes += content.length;
  }
  return { bytes, genMs: performance.now() - t0 };
}

async function readdirStatPass(dir: string): Promise<number> {
  const t0 = performance.now();
  const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  for (const name of names) await stat(join(dir, name));
  return performance.now() - t0;
}

function med(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}
function fmt(a: number[]): string {
  return `${med(a).toFixed(0)}ms [${Math.min(...a).toFixed(0)}-${Math.max(...a).toFixed(0)}]`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `xcg-bench-${N}-`));
  try {
    const g = generate(dir, N);
    console.log(`N=${N} generated: ${(g.bytes / 1e6).toFixed(1)} MB in ${(g.genMs / 1000).toFixed(1)}s`);

    const rdStat: number[] = [];
    const cold: number[] = [];
    const warmRefresh: number[] = [];
    const warmPage: number[] = [];
    const sweep: number[] = [];
    let heapMB = 0;
    let rssMB = 0;
    let eventsTotal = 0;

    for (let rep = 0; rep < REPS; rep++) {
      rdStat.push(await readdirStatPass(dir));

      global.gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      // minRefreshMs 0 → every get() takes the real refresh path.
      const store = createAuditStore(dir, { minRefreshMs: 0 });
      let t0 = performance.now();
      const full = await store.get();           // (a) cold: scan+parse+assemble
      cold.push(performance.now() - t0);
      eventsTotal = full.events.length;
      global.gc?.();
      heapMB = (process.memoryUsage().heapUsed - heap0) / 1e6;
      rssMB = process.memoryUsage().rss / 1e6;

      t0 = performance.now();
      await store.get();                        // warm refresh: readdir+stat×N+assemble
      warmRefresh.push(performance.now() - t0);

      t0 = performance.now();
      await store.getPage({                     // (b) page on top of warm refresh
        filter: { mcp: null, timeRange: 'all', categories: [], severities: [], sources: [] },
        limit: 50,
        cursor: null,
      });
      warmPage.push(performance.now() - t0);

      t0 = performance.now();
      // (c) sweep scan: '30d' with fresh files → stats everything, deletes nothing.
      const out = await runSweep(dir, { purgeMode: '30d', sizeWarnBytes: 524_288_000 }, Date.now(), () => {});
      sweep.push(performance.now() - t0);
      if (out.purgedFiles.length > 0) throw new Error('sweep deleted files — bench invalid');
    }

    console.log(`N=${N} files, cached events=${eventsTotal}`);
    console.log(`  readdir+stat aislado : ${fmt(rdStat)}`);
    console.log(`  cold start (get)     : ${fmt(cold)}`);
    console.log(`  warm refresh (get)   : ${fmt(warmRefresh)}`);
    console.log(`  warm page (getPage)  : ${fmt(warmPage)}`);
    console.log(`  retention sweep scan : ${fmt(sweep)}`);
    console.log(`  heap tras cold: ${heapMB.toFixed(0)} MB · rss: ${rssMB.toFixed(0)} MB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
