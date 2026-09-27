// launchReference: what a local connector's launch command pins. Real launch
// lines from MCP server READMEs and from a real claude_desktop_config.json,
// plus the flag shapes that could make the parser pick the wrong argument.

import { describe, expect, it } from 'vitest';

import { launchReference } from '../../src/config/launch-reference.js';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('launchReference — npx', () => {
  it('the real config: npx -y @modelcontextprotocol/server-filesystem <path> is mutable', () => {
    expect(
      launchReference('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents']),
    ).toEqual({
      launcher: 'npx',
      package: '@modelcontextprotocol/server-filesystem',
      spec: '@modelcontextprotocol/server-filesystem',
      mutable: true,
    });
  });

  it('by basename: an absolute npx path counts', () => {
    expect(launchReference('/opt/homebrew/bin/npx', ['-y', 'mcp-remote', 'https://x.example/sse'])?.spec).toBe(
      'mcp-remote',
    );
  });

  it('an exact version is pinned — scoped and unscoped', () => {
    expect(launchReference('npx', ['-y', '@playwright/mcp@0.0.41'])).toEqual({
      launcher: 'npx',
      package: '@playwright/mcp',
      spec: '@playwright/mcp@0.0.41',
      mutable: false,
      pinned: '0.0.41',
    });
    expect(launchReference('npx', ['mcp-remote@0.1.29', 'https://x.example'])).toMatchObject({
      package: 'mcp-remote',
      mutable: false,
      pinned: '0.1.29',
    });
    expect(launchReference('npx', ['--yes', 'pkg@1.2.3-beta.1'])?.pinned).toBe('1.2.3-beta.1');
  });

  it('@latest, tags, ranges and partial versions are mutable', () => {
    for (const spec of ['@upstash/context7-mcp@latest', 'pkg@next', 'pkg@^1.2.3', 'pkg@~1.2.3', 'pkg@1.2', 'pkg@1.x', 'pkg@>=1.0.0']) {
      expect(launchReference('npx', ['-y', spec]), spec).toMatchObject({ mutable: true, spec });
    }
  });

  it('-p/--package names the package, not the first positional', () => {
    expect(launchReference('npx', ['-p', '@scope/tool@2.0.0', 'tool-bin', '--flag'])).toMatchObject({
      package: '@scope/tool',
      mutable: false,
      pinned: '2.0.0',
    });
    expect(launchReference('npx', ['--package=@scope/tool', 'tool-bin'])).toMatchObject({
      package: '@scope/tool',
      mutable: true,
    });
  });

  it('server args after the package are not mistaken for it', () => {
    expect(launchReference('npx', ['-y', '@modelcontextprotocol/server-github', '--token', 'x@1.2.3'])?.package).toBe(
      '@modelcontextprotocol/server-github',
    );
  });

  it('no package at all: null', () => {
    expect(launchReference('npx', ['-y'])).toBeNull();
    expect(launchReference('npx', [])).toBeNull();
  });
});

describe('launchReference — uvx', () => {
  it('a bare package is mutable', () => {
    expect(launchReference('uvx', ['mcp-server-fetch'])).toEqual({
      launcher: 'uvx',
      package: 'mcp-server-fetch',
      spec: 'mcp-server-fetch',
      mutable: true,
    });
  });

  it('pkg==X.Y.Z is pinned', () => {
    expect(launchReference('uvx', ['mcp-server-git==2025.1.14', '--repository', '/r'])).toEqual({
      launcher: 'uvx',
      package: 'mcp-server-git',
      spec: 'mcp-server-git==2025.1.14',
      mutable: false,
      pinned: '2025.1.14',
    });
  });

  it('--from pkg==X.Y.Z is pinned; the positional is only the command', () => {
    expect(launchReference('uvx', ['--from', 'awslabs.core-mcp-server==1.0.2', 'awslabs.core-mcp-server'])).toMatchObject({
      package: 'awslabs.core-mcp-server',
      mutable: false,
      pinned: '1.0.2',
    });
    expect(launchReference('uvx', ['--from=git+https://github.com/o/r', 'srv'])).toMatchObject({ mutable: true });
  });

  it('value-taking options are skipped (--python 3.12 is not the package)', () => {
    expect(launchReference('/Users/me/.local/bin/uvx', ['--python', '3.12', 'mcp-server-time'])?.package).toBe(
      'mcp-server-time',
    );
  });

  it('pkg@X.Y.Z is pinned; ranges, wildcards and @latest are not', () => {
    expect(launchReference('uvx', ['ruff@0.6.0'])).toMatchObject({ mutable: false, pinned: '0.6.0' });
    for (const spec of ['pkg>=1.0', 'pkg==1.*', 'pkg@latest', 'pkg[extra]']) {
      expect(launchReference('uvx', [spec]), spec).toMatchObject({ mutable: true });
    }
    expect(launchReference('uvx', ['pkg[cli]==1.4.0'])).toMatchObject({ package: 'pkg', mutable: false });
  });
});

describe('launchReference — docker', () => {
  it('the GitHub MCP README line: no digest → mutable, env flags skipped', () => {
    expect(
      launchReference('docker', ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server']),
    ).toEqual({
      launcher: 'docker',
      package: 'ghcr.io/github/github-mcp-server',
      spec: 'ghcr.io/github/github-mcp-server',
      mutable: true,
    });
  });

  it('a digest is pinned, abbreviated to sha256:<12 hex>', () => {
    expect(launchReference('docker', ['run', '-i', '--rm', `mcp/fetch@${DIGEST}`])).toEqual({
      launcher: 'docker',
      package: 'mcp/fetch',
      spec: `mcp/fetch@${DIGEST}`,
      mutable: false,
      pinned: 'sha256:aaaaaaaaaaaa',
    });
  });

  it('a tag without a digest is still mutable', () => {
    expect(launchReference('docker', ['run', '-i', 'mcp/fetch:1.0.0'])).toMatchObject({ mutable: true });
  });

  it('docker container run, and value flags in every form', () => {
    const args = ['container', 'run', '-i', '--rm', '--name', 'srv', '-v', '/a:/b', '--mount=type=bind,src=/x,dst=/y',
      '-p8080:80', '-it', '-e', 'A=1', '--network', 'host', 'img/name', '--server-flag', 'value'];
    expect(launchReference('docker', args)?.spec).toBe('img/name');
  });

  it('global options before run are skipped', () => {
    expect(launchReference('docker', ['--context', 'colima', 'run', '-i', 'img'])?.spec).toBe('img');
  });

  it('anything but run: null', () => {
    expect(launchReference('docker', ['exec', '-i', 'box', 'srv'])).toBeNull();
    expect(launchReference('docker', ['run', '--rm'])).toBeNull();
  });
});

describe('launchReference — never carries URL credentials', () => {
  it('userinfo in a --from or npx URL spec is dropped', () => {
    const uv = launchReference('uvx', ['--from', 'git+https://user:tok3n@github.com/o/r', 'srv']);
    expect(uv?.spec).toBe('git+https://github.com/o/r');
    expect(JSON.stringify(uv)).not.toContain('tok3n');
    const np = launchReference('npx', ['-y', 'https://tok3n@registry.example.com/pkg.tgz']);
    expect(np?.spec).toBe('https://registry.example.com/pkg.tgz');
    expect(JSON.stringify(np)).not.toContain('tok3n');
  });
});

describe('launchReference — other launchers', () => {
  it('node, python, a binary, bunx, pnpm dlx, xcg-proxy: null', () => {
    expect(launchReference('node', ['/Users/me/srv/index.js'])).toBeNull();
    expect(launchReference('python3', ['-m', 'srv'])).toBeNull();
    expect(launchReference('/usr/local/bin/my-mcp', [])).toBeNull();
    expect(launchReference('bunx', ['pkg'])).toBeNull();
    expect(launchReference('pnpm', ['dlx', 'pkg'])).toBeNull();
    expect(launchReference('/x/xcg-proxy', ['http', '--url', 'https://x', '--name', 'n'])).toBeNull();
  });
});
