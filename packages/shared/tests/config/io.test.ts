// writeAtomic backup semantics (F-C). The config-path behavior (create .bak +
// first-write-wins across installs) is exercised end-to-end by the install
// tests (proxy tests/config/cli.test.ts); this file pins the option contract
// itself: default backs up, backup:false never touches .bak.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeAtomic } from '../../src/config/io.js';

describe('writeAtomic — backup option', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-io-'));
    path = join(dir, 'target.json');
    writeFileSync(path, '{"v":"original"}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('default: creates .bak with the pre-write content, first-write-wins', () => {
    expect(writeAtomic(path, { v: 'first' }).ok).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{"v":"original"}\n');
    // Second write does not overwrite the existing .bak.
    expect(writeAtomic(path, { v: 'second' }).ok).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{"v":"original"}\n');
  });

  it('backup: false — never creates a .bak', () => {
    expect(writeAtomic(path, { v: 'first' }, { backup: false }).ok).toBe(true);
    expect(writeAtomic(path, { v: 'second' }, { backup: false }).ok).toBe(true);
    expect(existsSync(`${path}.bak`)).toBe(false);
    // The write itself still happened atomically.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 'second' });
  });

  it('backup: false — leaves a pre-existing .bak untouched', () => {
    writeFileSync(`${path}.bak`, '{"v":"old-backup"}\n');
    expect(writeAtomic(path, { v: 'next' }, { backup: false }).ok).toBe(true);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{"v":"old-backup"}\n');
  });
});

describe('writeAtomic — trailingNewline option (F2.1c)', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-io-'));
    path = join(dir, 'target.json');
    writeFileSync(path, '{"v":"original"}\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('default: keeps the historical trailing newline', () => {
    expect(writeAtomic(path, { v: 1 }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{\n  "v": 1\n}\n');
  });

  it('trailingNewline: false — bytes end on the closing brace (CC .mcp.json shape)', () => {
    expect(writeAtomic(path, { v: 1 }, { backup: false, trailingNewline: false }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{\n  "v": 1\n}');
  });
});

describe('writeAtomic — orphan tmp cleanup on failure (hallazgo 1)', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xcg-io-'));
    path = join(dir, 'target.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rename failure: the usual error is returned AND no tmp is left behind', () => {
    // Force the rename to fail without mocks: the target is a DIRECTORY, so
    // statSync succeeds (mode of the dir), the tmp gets written, and
    // renameSync(file → dir) throws. backup:false skips the copyFileSync
    // that would otherwise fail first. In real life this failure lands as
    // "rename threw after the tmp was written" — same code path.
    mkdirSync(path);
    const res = writeAtomic(path, { v: 1 }, { backup: false });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('io');
    // The orphan is gone: no <basename>.tmp.<pid> survives in the dir.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});
