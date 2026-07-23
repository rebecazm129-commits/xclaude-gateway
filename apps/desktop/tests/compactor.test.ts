import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isCandidateFile,
  dayFileUlid,
  dayStartOf,
  planCompaction,
  extractIds,
  filterExistingIds,
  ensureTrailingNewline,
  runCompactionCycle,
  type CandidateEntry,
} from '../src/main/compactor.js';
import { decodeUlidTime } from '../src/main/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_784_419_200_000; // 2026-07-19T00:00:00Z, fijo.

// A well-formed, NON-terminal audit line (an mcp.request). Reused wherever a
// test needs content that parses cleanly but is not a terminal marker, so the
// terminal/silence logic is exercised in isolation from parse tolerance.
const NON_TERMINAL_LINE =
  '{"v":1,"id":"01AAA","ts":"2026-07-19T00:00:00.000Z","type":"mcp.request","method":"tools/list"}';

const NOW_2026 = 1_784_419_200_000; // 2026-07-19T00:00:00Z
const HOUR_MS = 60 * 60 * 1000;

// Construye un ULID de sesión válido con timestamp determinista y
// tail no-cero (para no colisionar con day-files). Espejo del encoder
// en compactor.ts pero con tail garantizado no reservado.
function sessionUlidAt(ms: number, tailChar: string = 'A'): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = ms;
  const chars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[t % 32]!;
    t = Math.floor(t / 32);
  }
  return chars.join('') + tailChar.repeat(16);
}

describe('isCandidateFile', () => {
  it('terminal: proxy.shutdown line → true (recent mtime)', () => {
    const content =
      `${NON_TERMINAL_LINE}\n` + '{"type":"proxy.shutdown","reason":"child_exited","exitCode":0}\n';
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('terminal: proxy.child_exited line → true', () => {
    const content = `${NON_TERMINAL_LINE}\n` + '{"type":"proxy.child_exited","code":0}\n';
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('terminal: cc.event with hookEventName SessionEnd → true', () => {
    const content = '{"type":"cc.event","hookEventName":"SessionEnd"}\n';
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('single terminal line only → true', () => {
    // Caso degenerado: fichero mínimo con SOLO la línea terminal.
    const content = '{"type":"proxy.shutdown","reason":"child_exited","exitCode":0}\n';
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('cc.event with non-SessionEnd hookEventName falls through to silence rule', () => {
    const content = '{"type":"cc.event","hookEventName":"SessionStart"}\n';
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(false);
  });

  it('silence fallback: no terminal, mtime 6 days → false', () => {
    const content = `${NON_TERMINAL_LINE}\n`;
    expect(isCandidateFile(content, NOW - 6 * DAY_MS, NOW)).toBe(false);
  });

  it('silence fallback: no terminal, mtime 8 days → true', () => {
    const content = `${NON_TERMINAL_LINE}\n`;
    expect(isCandidateFile(content, NOW - 8 * DAY_MS, NOW)).toBe(true);
  });

  it('malformed JSON line is tolerated, does not count as terminal', () => {
    // La línea válida DEBE parsearse OK sin ser terminal.
    // Si isCandidateFile devolviera true, no sabríamos si es por la línea
    // rota (bug) o por otra razón. La válida-pero-no-terminal aísla el caso.
    const content = `not-json{\n${NON_TERMINAL_LINE}\n`;
    expect(isCandidateFile(content, NOW - 60 * 60 * 1000, NOW)).toBe(false);
  });

  it('empty content: recent mtime → false, old mtime → true', () => {
    expect(isCandidateFile('', NOW - 60 * 60 * 1000, NOW)).toBe(false);
    expect(isCandidateFile('', NOW - 8 * DAY_MS, NOW)).toBe(true);
  });
});

describe('dayFileUlid', () => {
  it('round-trip: decodeUlidTime(dayFileUlid(x)) === x', () => {
    const cases = [0, 1_767_225_600_000, 1_784_419_200_000, 4_102_358_400_000];
    for (const x of cases) {
      expect(decodeUlidTime(dayFileUlid(x))).toBe(x);
    }
  });

  it('basename shape: 26 chars, valid Crockford, tail is 16 zeros', () => {
    const ulid = dayFileUlid(1_784_419_200_000);
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford (no I,L,O,U)
    expect(ulid.slice(10)).toBe('0'.repeat(16));
  });

  it('different day starts produce different basenames', () => {
    const x = 1_784_419_200_000;
    expect(dayFileUlid(x)).not.toBe(dayFileUlid(x + DAY_MS));
    expect(dayFileUlid(x)).not.toBe(dayFileUlid(x - DAY_MS));
  });

  it('reserved zero tail is the marker that distinguishes day files from real session ULIDs', () => {
    // Un ULID de sesión real tiene 80 bits aleatorios en el tail; la
    // probabilidad de que un ulid() genere exactamente 16 ceros es 2^-80,
    // astronómica. Este test es el ancla en código de esa propiedad de
    // diseño: si alguien reemplazara el encoder de dayFileUlid por algo
    // que produjera tails no reservados, la ambigüedad basename-de-día
    // vs basename-de-sesión reaparecería. Este test lo protege.
    const cases = [0, 1_767_225_600_000, 1_784_419_200_000, 4_102_358_400_000];
    for (const x of cases) {
      expect(dayFileUlid(x).slice(10)).toBe('0'.repeat(16));
    }
  });
});

describe('dayStartOf', () => {
  it('midnight of a given UTC day → same value', () => {
    const cases = [0, 1_767_225_600_000, 1_784_419_200_000];
    for (const x of cases) {
      expect(dayStartOf(x)).toBe(x);
    }
  });

  it('any moment within a UTC day → start of that day', () => {
    const x = 1_784_419_200_000; // 2026-07-19T00:00Z
    expect(dayStartOf(x + 1)).toBe(x);
    expect(dayStartOf(x + 3_600_000)).toBe(x); // 1am
    expect(dayStartOf(x + DAY_MS - 1)).toBe(x); // 23:59:59.999
    expect(dayStartOf(x + DAY_MS)).toBe(x + DAY_MS); // next day boundary
    expect(dayStartOf(x - 1)).toBe(x - DAY_MS); // previous day
  });
});

describe('planCompaction', () => {
  it('empty input → empty plan', () => {
    const plan = planCompaction([]);
    expect(plan.groups.size).toBe(0);
  });

  it('groups entries by their ulid day (UTC)', () => {
    const day = 1_784_419_200_000; // 2026-07-19T00:00Z
    const nextDay = day + DAY_MS;
    const entries: CandidateEntry[] = [
      { name: 'A', content: '', mtimeMs: 0, ulidTimeMs: day + 100, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: 'B', content: '', mtimeMs: 0, ulidTimeMs: day + 3_600_000, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: 'C', content: '', mtimeMs: 0, ulidTimeMs: nextDay + 500, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
    ];
    const plan = planCompaction(entries);
    expect(plan.groups.size).toBe(2);
    expect(plan.groups.get(day)?.map((e) => e.name)).toEqual(['A', 'B']);
    expect(plan.groups.get(nextDay)?.map((e) => e.name)).toEqual(['C']);
  });

  it('preserves input order within each group', () => {
    const day = 1_784_419_200_000;
    const entries: CandidateEntry[] = [
      { name: 'X', content: '', mtimeMs: 0, ulidTimeMs: day + 10, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: 'Y', content: '', mtimeMs: 0, ulidTimeMs: day + 20, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: 'Z', content: '', mtimeMs: 0, ulidTimeMs: day + 5, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } }, // earlier ULID
    ];
    const plan = planCompaction(entries);
    expect(plan.groups.get(day)?.map((e) => e.name)).toEqual(['X', 'Y', 'Z']);
    // Note: planCompaction does NOT sort; input order wins. The scan
    // decides insertion order (readdir order today).
  });

  it('day-boundary correctness: ulid at 23:59:59.999 vs 00:00:00.000', () => {
    const day = 1_784_419_200_000;
    const nextDay = day + DAY_MS;
    const entries: CandidateEntry[] = [
      { name: 'late', content: '', mtimeMs: 0, ulidTimeMs: day + DAY_MS - 1, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: 'early', content: '', mtimeMs: 0, ulidTimeMs: nextDay, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
    ];
    const plan = planCompaction(entries);
    expect(plan.groups.get(day)?.map((e) => e.name)).toEqual(['late']);
    expect(plan.groups.get(nextDay)?.map((e) => e.name)).toEqual(['early']);
  });

  it('a pre-sorted input yields groups whose entries remain in ULID order', () => {
    const day = 1_784_419_200_000;
    const entries: CandidateEntry[] = [
      { name: '01A_earliest', content: '', mtimeMs: 0, ulidTimeMs: day + 5, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: '01B_middle', content: '', mtimeMs: 0, ulidTimeMs: day + 10, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
      { name: '01C_latest', content: '', mtimeMs: 0, ulidTimeMs: day + 20, freshness: { mtimeNs: 0n, ctimeNs: 0n, ino: 0n, size: 0n } },
    ];
    const plan = planCompaction(entries);
    // Documenta la propiedad: planCompaction no ordena, y el scan sí →
    // el grupo queda en orden porque el scan garantiza la entrada ordenada.
    expect(plan.groups.get(day)?.map((e) => e.name)).toEqual([
      '01A_earliest', '01B_middle', '01C_latest',
    ]);
  });
});

describe('extractIds', () => {
  it('empty content → empty set', () => {
    expect(extractIds('').size).toBe(0);
  });

  it('single valid line with id → set of one', () => {
    const content = '{"v":1,"id":"01AAA","type":"proxy.shutdown"}\n';
    const ids = extractIds(content);
    expect(ids.size).toBe(1);
    expect(ids.has('01AAA')).toBe(true);
  });

  it('multiple lines with distinct ids → set contains all', () => {
    const content =
      '{"v":1,"id":"01AAA","type":"mcp.request"}\n' +
      '{"v":1,"id":"01BBB","type":"mcp.response"}\n' +
      '{"v":1,"id":"01CCC","type":"proxy.shutdown"}\n';
    const ids = extractIds(content);
    expect(ids.size).toBe(3);
    expect(ids.has('01AAA')).toBe(true);
    expect(ids.has('01BBB')).toBe(true);
    expect(ids.has('01CCC')).toBe(true);
  });

  it('malformed JSON line is skipped, valid ids around it are captured', () => {
    const content =
      '{"v":1,"id":"01AAA","type":"mcp.request"}\n' +
      'not-json{\n' +
      '{"v":1,"id":"01BBB","type":"proxy.shutdown"}\n';
    const ids = extractIds(content);
    expect(ids.size).toBe(2);
    expect(ids.has('01AAA')).toBe(true);
    expect(ids.has('01BBB')).toBe(true);
  });

  it('line without id field is skipped', () => {
    const content =
      '{"v":1,"type":"mcp.request"}\n' +
      '{"v":1,"id":"01AAA","type":"proxy.shutdown"}\n';
    const ids = extractIds(content);
    expect(ids.size).toBe(1);
    expect(ids.has('01AAA')).toBe(true);
  });

  it('non-string id is skipped (defensive against schema corruption)', () => {
    const content =
      '{"v":1,"id":123,"type":"mcp.request"}\n' +
      '{"v":1,"id":"01AAA","type":"proxy.shutdown"}\n';
    const ids = extractIds(content);
    expect(ids.size).toBe(1);
    expect(ids.has('01AAA')).toBe(true);
  });
});

describe('filterExistingIds', () => {
  it('empty existing set → returns content unchanged, skipped 0', () => {
    const content = '{"v":1,"id":"01AAA"}\n{"v":1,"id":"01BBB"}\n';
    const result = filterExistingIds(content, new Set());
    expect(result.filtered).toBe(content);
    expect(result.skipped).toBe(0);
  });

  it('id in existing set → line dropped, count incremented', () => {
    const content =
      '{"v":1,"id":"01AAA","type":"mcp.request"}\n' +
      '{"v":1,"id":"01BBB","type":"proxy.shutdown"}\n';
    const result = filterExistingIds(content, new Set(['01AAA']));
    expect(result.filtered).toBe('{"v":1,"id":"01BBB","type":"proxy.shutdown"}\n');
    expect(result.skipped).toBe(1);
  });

  it('all lines in existing set → filtered empty, skipped equals line count', () => {
    const content =
      '{"v":1,"id":"01AAA"}\n' +
      '{"v":1,"id":"01BBB"}\n';
    const result = filterExistingIds(content, new Set(['01AAA', '01BBB']));
    expect(result.filtered).toBe('');
    expect(result.skipped).toBe(2);
  });

  it('malformed line is KEPT (do not silently drop unparseable content)', () => {
    const content =
      '{"v":1,"id":"01AAA"}\n' +
      'not-json{\n' +
      '{"v":1,"id":"01BBB"}\n';
    const result = filterExistingIds(content, new Set(['01AAA']));
    expect(result.filtered).toBe('not-json{\n{"v":1,"id":"01BBB"}\n');
    expect(result.skipped).toBe(1);
  });

  it('line without id is KEPT (do not silently drop content without dedup key)', () => {
    const content =
      '{"v":1,"id":"01AAA"}\n' +
      '{"v":1,"type":"mcp.request"}\n' +
      '{"v":1,"id":"01BBB"}\n';
    const result = filterExistingIds(content, new Set(['01AAA']));
    expect(result.filtered).toBe(
      '{"v":1,"type":"mcp.request"}\n{"v":1,"id":"01BBB"}\n',
    );
    expect(result.skipped).toBe(1);
  });

  it('preserves order of surviving lines', () => {
    const content =
      '{"v":1,"id":"01AAA"}\n' +
      '{"v":1,"id":"01BBB"}\n' +
      '{"v":1,"id":"01CCC"}\n' +
      '{"v":1,"id":"01DDD"}\n';
    const result = filterExistingIds(content, new Set(['01BBB', '01CCC']));
    expect(result.filtered).toBe('{"v":1,"id":"01AAA"}\n{"v":1,"id":"01DDD"}\n');
    expect(result.skipped).toBe(2);
  });
});

describe('ensureTrailingNewline', () => {
  it('empty string → unchanged (no lone newline)', () => {
    expect(ensureTrailingNewline('')).toBe('');
  });

  it('already terminated → byte-identical', () => {
    expect(ensureTrailingNewline('{"id":"a"}\n')).toBe('{"id":"a"}\n');
  });

  it('partial tail without newline → terminated', () => {
    expect(ensureTrailingNewline('{"id":"a"}\n{"id":"b')).toBe('{"id":"a"}\n{"id":"b\n');
  });
});

describe('runCompactionCycle (integration, tmpdir)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-compactor-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // TODO paso 3d — freshness re-stat con concurrencia real:
  //   este paso 3b wired the counter but has no way to inject a
  //   mid-cycle append. Step 3d will hook the scan/append boundary to
  //   simulate a concurrent writer, and assert both the counter AND
  //   that the "fresh" source is NOT unlinked. Not tested here (would
  //   be a test that asserts a vacuous truth).

  it('empty directory → outcome all zeros, no files created', async () => {
    const out = await runCompactionCycle(dir, NOW_2026);
    expect(out.filesCompacted).toBe(0);
    expect(out.linesAppended).toBe(0);
    expect(out.dayFilesTouched).toEqual([]);
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('non-existent directory → outcome all zeros (ENOENT tolerated)', async () => {
    const ghost = join(dir, 'does-not-exist');
    const out = await runCompactionCycle(ghost, NOW_2026);
    expect(out.filesCompacted).toBe(0);
    expect(out.linesAppended).toBe(0);
    expect(out.dayFilesTouched).toEqual([]);
  });

  it('single terminated wrapper session → appended to day file, source unlinked', async () => {
    const sessionTs = NOW_2026 + 1 * HOUR_MS;
    const basename = sessionUlidAt(sessionTs) + '.jsonl';
    const content =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"mcp.request","method":"tools/list"}\n' +
      '{"v":1,"id":"01BBB","ts":"2026-07-19T01:00:01Z","type":"proxy.shutdown","reason":"child_exited","exitCode":0}\n';
    await writeFile(join(dir, basename), content, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 2 * HOUR_MS);

    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    const entries = await readdir(dir);
    expect(entries).toEqual([dayBasename]);

    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    expect(dayContent).toBe(content);

    expect(out.filesCompacted).toBe(1);
    expect(out.linesAppended).toBe(2);
    expect(out.filesSkippedFreshness).toBe(0);
    expect(out.dayFilesTouched).toEqual([dayBasename]);
  });

  it('non-candidate (no terminal, recent mtime) is left alone', async () => {
    const sessionTs = NOW_2026 + 1 * HOUR_MS;
    const basename = sessionUlidAt(sessionTs) + '.jsonl';
    const content =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"mcp.request","method":"tools/list"}\n';
    await writeFile(join(dir, basename), content, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 2 * HOUR_MS);

    const entries = await readdir(dir);
    expect(entries).toEqual([basename]);
    expect(out.linesAppended).toBe(0);
    expect(out.dayFilesTouched).toEqual([]);
  });

  it('two sessions on the same day → single day file with both contents concatenated in ULID order', async () => {
    const s1Ts = NOW_2026 + 1 * HOUR_MS;
    const s2Ts = NOW_2026 + 2 * HOUR_MS;
    const s1Base = sessionUlidAt(s1Ts, 'A') + '.jsonl';
    const s2Base = sessionUlidAt(s2Ts, 'B') + '.jsonl';
    const s1Content =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n';
    const s2Content =
      '{"v":1,"id":"01BBB","ts":"2026-07-19T02:00:00Z","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, s1Base), s1Content, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(dir, s2Base), s2Content, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 3 * HOUR_MS);

    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    expect(dayContent).toBe(s1Content + s2Content);
    expect(out.linesAppended).toBe(2);
    expect(out.filesCompacted).toBe(2);
    expect(out.dayFilesTouched).toEqual([dayBasename]);

    const entries = await readdir(dir);
    expect(entries).toEqual([dayBasename]);
  });

  it('sessions on two different days → two separate day files', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const day1 = NOW_2026;
    const day2 = NOW_2026 + DAY_MS;
    const s1Base = sessionUlidAt(day1 + HOUR_MS) + '.jsonl';
    const s2Base = sessionUlidAt(day2 + HOUR_MS) + '.jsonl';
    const s1Content =
      '{"v":1,"id":"01AAA","ts":"day1","type":"proxy.shutdown"}\n';
    const s2Content =
      '{"v":1,"id":"01BBB","ts":"day2","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, s1Base), s1Content, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(dir, s2Base), s2Content, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, day2 + 2 * HOUR_MS);

    const day1Basename = `${dayFileUlid(day1)}.jsonl`;
    const day2Basename = `${dayFileUlid(day2)}.jsonl`;
    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual([day1Basename, day2Basename].sort());
    expect([...out.dayFilesTouched].sort()).toEqual([day1Basename, day2Basename].sort());
    expect(out.linesAppended).toBe(2);
    expect(out.filesCompacted).toBe(2);
  });

  it('second cycle after compaction: source is gone, day file unchanged', async () => {
    const sessionTs = NOW_2026 + 1 * HOUR_MS;
    const basename = sessionUlidAt(sessionTs) + '.jsonl';
    const content =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, basename), content, { encoding: 'utf8', mode: 0o600 });

    const out1 = await runCompactionCycle(dir, NOW_2026 + 2 * HOUR_MS);
    const out2 = await runCompactionCycle(dir, NOW_2026 + 3 * HOUR_MS);

    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    expect(dayContent).toBe(content);

    expect(out1.linesAppended).toBe(1);
    expect(out1.filesCompacted).toBe(1);

    expect(out2.linesAppended).toBe(0);
    expect(out2.filesCompacted).toBe(0);
    expect(out2.dayFilesTouched).toEqual([]);

    const entries = await readdir(dir);
    expect(entries).toEqual([dayBasename]);
  });

  it('partial overlap: a source reappearing with new lines only gets the new lines appended', async () => {
    const sessionTs = NOW_2026 + 1 * HOUR_MS;
    const basename = sessionUlidAt(sessionTs) + '.jsonl';
    const content1 =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n';
    const content2 =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n' +
      '{"v":1,"id":"01BBB","ts":"2026-07-19T01:00:01Z","type":"proxy.shutdown"}\n';

    await writeFile(join(dir, basename), content1, { encoding: 'utf8', mode: 0o600 });
    await runCompactionCycle(dir, NOW_2026 + 2 * HOUR_MS);

    // Between cycles: source is unlinked. writeFile recreates it with
    // new content — a "reappearance" on disk from the compactor's
    // point of view (no memory of past unlinks; only the day file's
    // id set matters).
    await writeFile(join(dir, basename), content2, { encoding: 'utf8', mode: 0o600 });
    const out2 = await runCompactionCycle(dir, NOW_2026 + 3 * HOUR_MS);

    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    expect(dayContent).toBe(content2);
    expect(out2.linesAppended).toBe(1);
    expect(out2.linesSkippedDuplicate).toBe(1);
    expect(out2.filesCompacted).toBe(1);
  });
});

describe('runCompactionCycle — line-boundary guarantee (auditoría 22/07)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-compactor-nl-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fusion (a): candidate A ends in a partial line without newline → B\'s first line survives legible', async () => {
    // A: terminal marker + a kill-9'd partial line, NO trailing '\n'.
    const aTerminal =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}';
    const aPartial = '{"v":1,"id":"01CUT","ts":"2026-07-19T01:0';
    const aContent = `${aTerminal}\n${aPartial}`;
    const bContent =
      '{"v":1,"id":"01BBB","ts":"2026-07-19T02:00:00Z","type":"proxy.shutdown"}\n';
    const aBase = sessionUlidAt(NOW_2026 + 1 * HOUR_MS, 'A') + '.jsonl';
    const bBase = sessionUlidAt(NOW_2026 + 2 * HOUR_MS, 'B') + '.jsonl';
    await writeFile(join(dir, aBase), aContent, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(dir, bBase), bContent, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 3 * HOUR_MS);

    const dayContent = await readFile(join(dir, `${dayFileUlid(NOW_2026)}.jsonl`), 'utf8');
    // A's partial got terminated; B starts on its own line.
    expect(dayContent).toBe(`${aContent}\n${bContent}`);
    // B's first line is legible: the id set of the day file contains it.
    expect(extractIds(dayContent).has('01BBB')).toBe(true);
    // And the partial stayed malformed-but-isolated (its own line).
    expect(dayContent.split('\n')).toContain(aPartial);
    expect(out.filesCompacted).toBe(2);
  });

  it('fusion (b): pre-existing day file ends in a partial line → new lines survive legible, partial isolated', async () => {
    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    // A previous cycle died mid-append: valid line + partial tail, no '\n'.
    const dayPartialTail = '{"v":1,"id":"01TRU';
    const dayInitial =
      `{"v":1,"id":"01OLD","ts":"2026-07-19T00:30:00Z","type":"proxy.shutdown"}\n${dayPartialTail}`;
    await writeFile(join(dir, dayBasename), dayInitial, { encoding: 'utf8', mode: 0o600 });

    const cContent =
      '{"v":1,"id":"01NEW","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n';
    const cBase = sessionUlidAt(NOW_2026 + 1 * HOUR_MS, 'C') + '.jsonl';
    await writeFile(join(dir, cBase), cContent, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 2 * HOUR_MS);

    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    // The guard '\n' isolates the partial; the new content follows intact.
    expect(dayContent).toBe(`${dayInitial}\n${cContent}`);
    expect(extractIds(dayContent).has('01NEW')).toBe(true);
    expect(dayContent.split('\n')).toContain(dayPartialTail);
    // The guard byte is NOT counted as an appended line — only C's line.
    expect(out.linesAppended).toBe(1);
    expect(out.filesCompacted).toBe(1);
  });

  it('happy path: well-terminated content → byte-identical output (zero change)', async () => {
    const dayBasename = `${dayFileUlid(NOW_2026)}.jsonl`;
    const dayInitial =
      '{"v":1,"id":"01OLD","ts":"2026-07-19T00:30:00Z","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, dayBasename), dayInitial, { encoding: 'utf8', mode: 0o600 });

    const s1Content =
      '{"v":1,"id":"01AAA","ts":"2026-07-19T01:00:00Z","type":"proxy.shutdown"}\n';
    const s2Content =
      '{"v":1,"id":"01BBB","ts":"2026-07-19T02:00:00Z","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, sessionUlidAt(NOW_2026 + 1 * HOUR_MS, 'A') + '.jsonl'), s1Content, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(dir, sessionUlidAt(NOW_2026 + 2 * HOUR_MS, 'B') + '.jsonl'), s2Content, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, NOW_2026 + 3 * HOUR_MS);

    const dayContent = await readFile(join(dir, dayBasename), 'utf8');
    // Exact concatenation — no guard bytes, no extra terminators.
    expect(dayContent).toBe(dayInitial + s1Content + s2Content);
    expect(out.linesAppended).toBe(2);
    expect(out.filesCompacted).toBe(2);
  });
});

describe('runCompactionCycle — per-group containment (hallazgo B, 22/07)', () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-compactor-grp-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('an unreadable day file fails ITS group only — other days still compact in the same cycle', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const day1 = NOW_2026;
    const day2 = NOW_2026 + DAY_MS;
    // day1's day file exists but is unreadable → loadDayFileIds EACCES.
    const day1Basename = `${dayFileUlid(day1)}.jsonl`;
    await writeFile(join(dir, day1Basename), '', { encoding: 'utf8', mode: 0o000 });
    const s1Base = sessionUlidAt(day1 + HOUR_MS, 'A') + '.jsonl';
    const s2Base = sessionUlidAt(day2 + HOUR_MS, 'B') + '.jsonl';
    const s1 = '{"v":1,"id":"01AAA","ts":"d1","type":"proxy.shutdown"}\n';
    const s2 = '{"v":1,"id":"01BBB","ts":"d2","type":"proxy.shutdown"}\n';
    await writeFile(join(dir, s1Base), s1, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(dir, s2Base), s2, { encoding: 'utf8', mode: 0o600 });

    const out = await runCompactionCycle(dir, day2 + 2 * HOUR_MS);

    // day2's group compacted normally in the SAME cycle...
    const day2Basename = `${dayFileUlid(day2)}.jsonl`;
    expect(await readFile(join(dir, day2Basename), 'utf8')).toBe(s2);
    expect(out.filesCompacted).toBe(1);
    expect(out.dayFilesTouched).toEqual([day2Basename]);
    // ...day1's source survives for the next cycle, and the skip is logged
    // with the affected day file.
    expect(await readdir(dir)).toContain(s1Base);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes(day1Basename)),
    ).toBe(true);
  });
});
