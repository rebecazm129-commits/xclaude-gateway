// Launch-argument redaction (launch-redaction.ts): what proxy.started and
// proxy.http_started record about how a server was launched. One block per
// rule, each with the values that must NOT be covered next to the ones that
// must — the rule set is evidence-only, so a UUID, a commit sha, a project id,
// a Content-Type or a path passes untouched.

import { describe, expect, it } from 'vitest';

import type { Envelope, Writer } from '../src/audit.js';
import { isCredentialName } from '../src/detection/detectors/sensitive-params.js';
import {
  canonicalizeUrl,
  isSecretName,
  isSecretQueryParam,
  redactLaunchArgs,
} from '../src/detection/launch-redaction.js';
import { fingerprint } from '../src/detection/masking.js';
import { EventSink } from '../src/events.js';
import { stderrEvent } from '../src/main.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const mask = (value: string, type: string): string => `[credential:${type} fp:${fingerprint(KEY, value)}]`;
const redact = (...args: string[]): string[] => redactLaunchArgs(args, KEY);

// Synthetic values, never real secrets.
const ANT = `sk-ant-api03-${'A'.repeat(40)}`;
const GH = `ghp_${'B'.repeat(40)}`;
const OPAQUE = 'x9Qm2Lz7Pw4Kd8Rt'; // no known format: only structure can find it
const UUID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const SHA = 'd3a44df1e164da5433018f638cfecd88a30b1c2d';
const PROJECT_ID = 'proj_01HXTESTPROJECT';

describe('names — which flag/variable names carry a secret', () => {
  it('credential names', () => {
    for (const n of ['--api-key', '--token', '--access-token', 'API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD',
      'figmaApiKey', '--client-secret', 'OPENAI_APIKEY', '--auth', '-Dfoo.password']) {
      expect(isSecretName(n), n).toBe(true);
    }
  });

  it('destinations, transports and switches are not (unlike isSensitiveParamName)', () => {
    for (const n of ['DATABASE_URL', '--base-url', '--endpoint', '--header', '--key', '--project-id',
      '--no-auth', '--token-file', '--auth-url', 'GITHUB_TOKEN_ENV', '--password-stdin', '--secret-id',
      '--author', 'AUTHOR_NAME', '--sort-key']) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it('isCredentialName is the credential subset of isSensitiveParamName rule 1', () => {
    expect(isCredentialName('source_url')).toBe(false);
    expect(isCredentialName('headers')).toBe(false);
    expect(isCredentialName('private_key')).toBe(true);
    expect(isCredentialName('authtoken')).toBe(true);
  });
});

describe('rule: value of a flag with a credential name', () => {
  it('--flag=value', () => {
    expect(redact(`--api-key=${OPAQUE}`)).toEqual([`--api-key=${mask(OPAQUE, 'cli_secret')}`]);
  });

  it('--flag value', () => {
    expect(redact('--token', OPAQUE, 'serve')).toEqual(['--token', mask(OPAQUE, 'cli_secret'), 'serve']);
  });

  it('a whole known credential takes its format as the type', () => {
    expect(redact('--api-key', ANT)).toEqual(['--api-key', mask(ANT, 'anthropic_api_key')]);
  });

  it('the next flag is never taken as the value', () => {
    expect(redact('--token', '--verbose')).toEqual(['--token', '--verbose']);
  });

  it('an empty inline value stays as is', () => {
    expect(redact('--api-key=')).toEqual(['--api-key=']);
  });

  it('non-secret flags keep UUIDs, shas, project ids and paths', () => {
    const args = ['--project-id', PROJECT_ID, `--workspace=${UUID}`, '--ref', SHA, '--token-file',
      '/Users/me/.config/tok', '--root', '/Users/me/code/repo', '-y', '@scope/server-auth'];
    expect(redact(...args)).toEqual(args);
  });
});

describe('rule: credential headers only', () => {
  it('Authorization keeps its scheme, masks the credential', () => {
    expect(redact('--header', `Authorization: Bearer ${OPAQUE}`)).toEqual([
      '--header',
      `Authorization: Bearer ${mask(OPAQUE, 'header_secret')}`,
    ]);
  });

  it('-H and a whole known credential', () => {
    expect(redact('-H', `Authorization:Bearer ${GH}`)).toEqual(['-H', `Authorization:Bearer ${mask(GH, 'github_token')}`]);
  });

  it('--header=, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key (any case)', () => {
    expect(redact(`--header=proxy-authorization: Basic ${OPAQUE}`)).toEqual([
      `--header=proxy-authorization: Basic ${mask(OPAQUE, 'header_secret')}`,
    ]);
    expect(redact('-H', `Cookie: sid=${OPAQUE}`)).toEqual(['-H', `Cookie: ${mask(`sid=${OPAQUE}`, 'header_secret')}`]);
    expect(redact('-H', `Set-Cookie: sid=${OPAQUE}`)).toEqual(['-H', `Set-Cookie: ${mask(`sid=${OPAQUE}`, 'header_secret')}`]);
    expect(redact('--http-header', `X-API-Key: ${OPAQUE}`)).toEqual(['--http-header', `X-API-Key: ${mask(OPAQUE, 'header_secret')}`]);
  });

  it('Content-Type, Accept and other known headers are kept', () => {
    const args = ['-H', 'Content-Type: application/json', '--header', 'Accept: text/event-stream',
      '--header', `X-Request-Id: ${UUID}`];
    expect(redact(...args)).toEqual(args);
  });

  it('an unknown header still goes through the credential formats', () => {
    expect(redact('-H', `X-Custom: ${ANT}`)).toEqual(['-H', `X-Custom: ${mask(ANT, 'anthropic_api_key')}`]);
    expect(redact('-H', `X-Custom: ${OPAQUE}`)).toEqual(['-H', `X-Custom: ${OPAQUE}`]);
  });
});

describe('rule: NAME=value', () => {
  it('bare, after -e, after --env, and --env=', () => {
    expect(redact(`API_KEY=${OPAQUE}`)).toEqual([`API_KEY=${mask(OPAQUE, 'env_secret')}`]);
    expect(redact('-e', `GITHUB_TOKEN=${GH}`)).toEqual(['-e', `GITHUB_TOKEN=${mask(GH, 'github_token')}`]);
    expect(redact('--env', `DB_PASSWORD=${OPAQUE}`)).toEqual(['--env', `DB_PASSWORD=${mask(OPAQUE, 'env_secret')}`]);
    expect(redact(`--env=DB_PASSWORD=${OPAQUE}`)).toEqual([`--env=DB_PASSWORD=${mask(OPAQUE, 'env_secret')}`]);
  });

  it('non-secret names keep their values; -e NAME without a value is untouched', () => {
    const args = [`PROJECT_ID=${PROJECT_ID}`, '-e', `COMMIT=${SHA}`, '-e', 'GITHUB_TOKEN',
      `SESSION_UUID=${UUID}`, 'CONFIG_PATH=/etc/app/config.json', 'GITHUB_TOKEN_FILE=/run/secrets/gh'];
    expect(redact(...args)).toEqual(args);
  });

  it('a non-secret name with a credential-format value is masked by format', () => {
    expect(redact(`FOO=${ANT}`)).toEqual([`FOO=${mask(ANT, 'anthropic_api_key')}`]);
  });
});

describe('rule: URL userinfo and credential query values', () => {
  it('user and password are masked separately; host and path are kept', () => {
    expect(redact('postgres://admin:hunter2@db.internal:5432/app')).toEqual([
      `postgres://${mask('admin', 'url_userinfo')}:${mask('hunter2', 'url_userinfo')}@db.internal:5432/app`,
    ]);
  });

  it('a user without a password', () => {
    expect(redact('https://deploy@git.example.com/repo.git')).toEqual([
      `https://${mask('deploy', 'url_userinfo')}@git.example.com/repo.git`,
    ]);
  });

  it('credential query values are masked, the rest of the query is kept', () => {
    expect(redact(`https://api.example.com/mcp?workspace=${UUID}&token=${OPAQUE}&sig=abc123`)).toEqual([
      `https://api.example.com/mcp?workspace=${UUID}&token=${mask(OPAQUE, 'url_query_secret')}&sig=${mask('abc123', 'url_query_secret')}`,
    ]);
  });

  it('inside a flag value and inside NAME=value', () => {
    expect(redact('--url', 'https://u:p@h.example/x')).toEqual([
      '--url',
      `https://${mask('u', 'url_userinfo')}:${mask('p', 'url_userinfo')}@h.example/x`,
    ]);
    expect(redact(`DATABASE_URL=postgres://u:${OPAQUE}@db/x`)).toEqual([
      `DATABASE_URL=postgres://${mask('u', 'url_userinfo')}:${mask(OPAQUE, 'url_userinfo')}@db/x`,
    ]);
  });

  it('the query parameter list', () => {
    for (const p of ['token', 'access_token', 'accessToken', 'api_key', 'api-key', 'apiKey', 'apikey', 'key',
      'secret', 'password', 'signature', 'sig', 'credential', 'auth', 'id_token', 'X-Amz-Signature', 'X-Amz-Credential']) {
      expect(isSecretQueryParam(p), p).toBe(true);
    }
    for (const p of ['workspace', 'project_id', 'ref', 'sort_key', 'author', 'redirect_uri', 'page']) {
      expect(isSecretQueryParam(p), p).toBe(false);
    }
  });

  it('URLs without secrets are untouched', () => {
    const args = [`https://github.com/org/repo/commit/${SHA}`, `https://api.example.com/v1/projects/${PROJECT_ID}?page=2`];
    expect(redact(...args)).toEqual(args);
  });
});

describe('rule: any known credential format, anywhere', () => {
  it('a positional, and inside a JSON argument', () => {
    expect(redact(ANT)).toEqual([mask(ANT, 'anthropic_api_key')]);
    expect(redact('--config', `{"github":"${GH}","region":"eu"}`)).toEqual([
      '--config',
      `{"github":"${mask(GH, 'github_token')}","region":"eu"}`,
    ]);
  });

  it('no entropy rule: opaque positionals, UUIDs, shas and paths pass', () => {
    const args = ['node', '/Users/me/server/dist/index.js', OPAQUE, UUID, SHA, PROJECT_ID, '--', '-'];
    expect(redact(...args)).toEqual(args);
  });

  it('same secret, same fingerprint as masking.ts', () => {
    const [out] = redact(ANT);
    expect(out).toBe(`[credential:anthropic_api_key fp:${fingerprint(KEY, ANT)}]`);
  });
});

describe('canonicalizeUrl — the http startup URL', () => {
  const canon = (u: string): string => canonicalizeUrl(u, KEY);

  it('lowercases scheme and host, drops the default port, userinfo and fragment', () => {
    expect(canon('HTTPS://User:Pass@MCP.Example.COM:443/Path/To?x=1#frag')).toBe('https://mcp.example.com/Path/To?x=1');
    expect(canon('http://Host.example:80/mcp')).toBe('http://host.example/mcp');
  });

  it('keeps a non-default port and the path case', () => {
    expect(canon('https://mcp.example.com:8443/MCP')).toBe('https://mcp.example.com:8443/MCP');
  });

  it('masks credential query values the same way as the args', () => {
    expect(canon(`https://mcp.example.com/sse?api_key=${OPAQUE}&team=${UUID}`)).toBe(
      `https://mcp.example.com/sse?api_key=${mask(OPAQUE, 'url_query_secret')}&team=${UUID}`,
    );
  });

  it('an unparseable URL still loses its fragment and secrets', () => {
    expect(canon(`not a url ${ANT}#frag`)).toBe(`not a url ${mask(ANT, 'anthropic_api_key')}`);
  });
});

describe('mcp.stderr — masked like a tool call', () => {
  class CaptureWriter implements Writer {
    readonly lines: Envelope[] = [];
    write(e: Envelope): void {
      this.lines.push(e);
    }
    close(): void {}
  }

  it('a stderr line with sk-ant-… is written masked', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('test-mcp', [w], '01HXTESTSESSION', KEY);
    sink.emit(stderrEvent(`auth failed for key ${ANT}`, 80, 1));
    const written = JSON.stringify(w.lines[0]);
    expect(written).not.toContain(ANT);
    expect(written).not.toContain('sk-ant-');
    expect(w.lines[0]).toMatchObject({ type: 'mcp.stderr', text: `auth failed for key ${mask(ANT, 'anthropic_api_key')}` });
  });

  it('a clean stderr line is written as is', () => {
    const w = new CaptureWriter();
    const sink = new EventSink('test-mcp', [w], '01HXTESTSESSION', KEY);
    sink.emit(stderrEvent(`listening on /tmp/sock ${UUID}`, 40, 1));
    expect(w.lines[0]).toMatchObject({ type: 'mcp.stderr', text: `listening on /tmp/sock ${UUID}` });
  });
});
