// The launch reference crosses IPC as a computed result only: runConfigStatus
// returns it per entry, and nothing of the raw args (which may carry secrets)
// reaches the renderer's payload.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConfigStatus } from '../../src/main/config-handlers.js';

describe('runConfigStatus — launch reference over IPC', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(osTmpdir(), 'xcg-ipc-launch-test-'));
    configPath = join(tmp, 'claude_desktop_config.json');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('wrapped and unwrapped entries carry the result, never the args', () => {
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        filesystem: {
          command: '/x/xcg-proxy',
          args: ['stdio', '--wrap', 'npx', '--name', 'filesystem', '--', '-y', '@modelcontextprotocol/server-filesystem', '/Users/me/private'],
        },
        github: {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_notarealtokenvalue', 'ghcr.io/github/github-mcp-server'],
        },
        local: { command: 'node', args: ['/Users/me/srv.js', '--api-key', 'k-secret'] },
      },
    }));
    const result = runConfigStatus({ configPath, xcgPath: '/fake/xcg-proxy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
    expect(byName['filesystem']?.launch).toEqual({
      launcher: 'npx',
      package: '@modelcontextprotocol/server-filesystem',
      spec: '@modelcontextprotocol/server-filesystem',
      mutable: true,
    });
    expect(byName['github']?.launch).toMatchObject({ launcher: 'docker', mutable: true });
    expect(byName['local'] !== undefined && 'launch' in byName['local']).toBe(false);

    const payload = JSON.stringify(result);
    for (const raw of ['/Users/me/private', 'ghp_notarealtokenvalue', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'k-secret', '--api-key', 'args']) {
      expect(payload).not.toContain(raw);
    }
  });
});
