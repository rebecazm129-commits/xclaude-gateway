import { describe, it, expect } from 'vitest';

import { isCandidateFile, dayFileUlid } from '../src/main/compactor.js';
import { decodeUlidTime } from '../src/main/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_784_419_200_000; // 2026-07-19T00:00:00Z, fijo.

// A well-formed, NON-terminal audit line (an mcp.request). Reused wherever a
// test needs content that parses cleanly but is not a terminal marker, so the
// terminal/silence logic is exercised in isolation from parse tolerance.
const NON_TERMINAL_LINE =
  '{"v":1,"id":"01AAA","ts":"2026-07-19T00:00:00.000Z","type":"mcp.request","method":"tools/list"}';

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
