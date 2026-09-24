// The v1 baseline algorithm, pinned to LITERAL bytes.
//
// Why this file exists separately from manifest.test.ts: v2 keeps writing the
// v1 file, in the v1 path, with the v1 algorithm, for a compatibility window
// of at least two published versions. An installation still on v1 reads that
// file and must find exactly what it expects. So v1 stops being an
// implementation detail and becomes a WIRE FORMAT with an outside consumer.
//
// Every value below is a literal, computed once on 24/09/2026 and typed in.
// Nothing here recomputes anything from the implementation — a test that
// derives its expectation from the code under test cannot detect a change in
// that code. If a refactor moves one of these bytes, this file fails, and the
// question to answer is "does an older install still read our file?", not
// "what is the new hash?".
//
// Do NOT update these values to make the suite pass. Updating them is a
// deliberate act that ends the compatibility window.

import { describe, expect, it } from 'vitest';

import { buildManifest, canonicalize, toolShape, type ToolDef } from '../src/detection/manifest.js';

/** Frozen input. Covers: a described tool with two properties and one
 *  required entry, an empty description, a numeric type, and a tool with no
 *  inputSchema at all (null). */
const FROZEN: ToolDef[] = [
  {
    name: 'send',
    description: 'Send a message to the channel.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' }, to: { type: 'string' } },
      required: ['body'],
    },
  },
  {
    name: 'archive',
    description: '',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
  },
  { name: 'ping', inputSchema: null },
];

const EXPECTED_HASH = 'b5187d9bb43e579c29b2370972c19d9b608d524de9a9da7d94e5bd4460e6d506';

const EXPECTED_SIGS = {
  archive: {
    d: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    s: 'b6c0037281f4c59ba68fdbac89b5c00bef9cf99da22bf2476d10311f1d3ea480',
    sh: { p: ['id'], r: [] },
  },
  ping: {
    d: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    s: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    sh: { p: [], r: [] },
  },
  send: {
    d: 'c650b9a0796edbd3a4fe9901392b47575dfe25e2d19494b2e25fc0e30486508d',
    s: '8b0b14d89011a65dc39737f7984555b24b5dfad590efa2146359a75c663b0e48',
    sh: { p: ['body', 'to'], r: ['body'] },
  },
} as const;

describe('manifest v1 — frozen wire format', () => {
  it('the global hash is byte-for-byte what v1 installs expect', () => {
    expect(buildManifest(FROZEN).hash).toBe(EXPECTED_HASH);
  });

  it('every per-tool signature is byte-for-byte frozen', () => {
    const tools = buildManifest(FROZEN).tools;
    expect(Object.keys(tools).sort()).toEqual(['archive', 'ping', 'send']);
    for (const [name, sig] of Object.entries(EXPECTED_SIGS)) {
      expect(tools[name]?.d, `${name}.d`).toBe(sig.d);
      expect(tools[name]?.s, `${name}.s`).toBe(sig.s);
      expect(tools[name]?.sh, `${name}.sh`).toEqual(sig.sh);
    }
  });

  it('an absent description hashes as the empty string, not as undefined', () => {
    // e3b0c442… is sha256(''). `ping` has no description at all and `archive`
    // has an empty one: v1 collapses both, and an install reading our file
    // depends on that.
    expect(buildManifest(FROZEN).tools['ping']?.d).toBe(EXPECTED_SIGS.ping.d);
    expect(buildManifest(FROZEN).tools['archive']?.d).toBe(EXPECTED_SIGS.archive.d);
  });

  it('a missing inputSchema hashes as null, not as {}', () => {
    // 74234e98… is sha256('null').
    expect(buildManifest([{ name: 'ping' }]).tools['ping']?.s).toBe(EXPECTED_SIGS.ping.s);
  });

  it('tool ORDER does not move the hash — the map is name-sorted', () => {
    const reversed = [...FROZEN].reverse();
    expect(buildManifest(reversed).hash).toBe(EXPECTED_HASH);
  });

  it('object key order does not move the hash', () => {
    const reordered: ToolDef[] = [
      {
        name: 'send',
        description: 'Send a message to the channel.',
        inputSchema: {
          required: ['body'],
          properties: { to: { type: 'string' }, body: { type: 'string' } },
          type: 'object',
        },
      },
      FROZEN[1]!,
      FROZEN[2]!,
    ];
    expect(buildManifest(reordered).hash).toBe(EXPECTED_HASH);
  });

  it('array order DOES move the hash — an enum is a contract', () => {
    const a = buildManifest([{ name: 't', inputSchema: { enum: ['x', 'y'] } }]);
    const b = buildManifest([{ name: 't', inputSchema: { enum: ['y', 'x'] } }]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('canonicalize sorts keys and preserves array order', () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: [3, 1, 2] }))).toBe('{"a":[3,1,2],"b":1}');
  });

  it('toolShape collects nested property and required names, sorted and deduped', () => {
    expect(
      toolShape({
        name: 't',
        inputSchema: {
          properties: { z: {}, a: {} },
          required: ['z'],
          anyOf: [{ properties: { a: {}, m: {} }, required: ['m'] }],
        },
      }),
    ).toEqual({ p: ['a', 'm', 'z'], r: ['m', 'z'] });
  });
});
