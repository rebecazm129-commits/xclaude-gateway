// Whole-word matching for sensitive parameter names. The substring version of
// this test would pass with `author` matching `auth` — which is exactly the
// bug this module exists to avoid.

import { describe, expect, it } from 'vitest';

import {
  SENSITIVE_COMPOUNDS,
  SENSITIVE_TOKENS,
  isSensitiveParamName,
  tokenizeParamName,
} from '../src/detection/detectors/sensitive-params.js';

describe('tokenizeParamName', () => {
  it('snake_case', () => {
    expect(tokenizeParamName('source_url')).toEqual(['source', 'url']);
    expect(tokenizeParamName('days_to_wait_before_mark_as_response')).toContain('to');
  });

  it('camelCase', () => {
    expect(tokenizeParamName('bccEmails')).toEqual(['bcc', 'emails']);
    expect(tokenizeParamName('replyToMessageId')).toEqual(['reply', 'to', 'message', 'id']);
  });

  it('PascalCase and consecutive capitals', () => {
    expect(tokenizeParamName('HTTPHeaders')).toEqual(['http', 'headers']);
    expect(tokenizeParamName('URLOrId')).toEqual(['url', 'or', 'id']);
  });

  it('kebab-case', () => {
    expect(tokenizeParamName('x-api-key')).toEqual(['x', 'api', 'key']);
  });

  it('digits split words and never survive as tokens', () => {
    expect(tokenizeParamName('oauth2Token')).toEqual(['oauth', 'token']);
    expect(tokenizeParamName('addr1')).toEqual(['addr']);
  });

  it('mixed separators and empty segments', () => {
    expect(tokenizeParamName('__file__upload__')).toEqual(['file', 'upload']);
    expect(tokenizeParamName('')).toEqual([]);
  });
});

describe('isSensitiveParamName', () => {
  it('"author" does NOT match "auth" — the whole point of tokenising', () => {
    expect(tokenizeParamName('author')).toEqual(['author']);
    expect(isSensitiveParamName('author')).toBe(false);
  });

  it('the Jira/Linear key identifiers stay clean — bare `key` is not a token', () => {
    // Tokenising alone does NOT fix these: projectKey splits to [project, key].
    // That is why `key` only matches as a PAIR (api key, access key, …).
    for (const n of ['projectKey', 'issueIdOrKey', 'descriptionKey', 'project_key', 'issue_key']) {
      expect(isSensitiveParamName(n), n).toBe(false);
    }
  });

  it('but the key PAIRS do match', () => {
    for (const n of ['api_key', 'x-api-key', 'apiKey', 'access_key', 'privateKey', 'secret_key']) {
      expect(isSensitiveParamName(n), n).toBe(true);
    }
  });

  it('separator-less compounds match as whole tokens', () => {
    for (const n of ['apikey', 'accesstoken', 'authtoken', 'privatekey', 'secretkey', 'myApikey']) {
      expect(isSensitiveParamName(n), n).toBe(true);
    }
    for (const c of SENSITIVE_COMPOUNDS) expect(isSensitiveParamName(c), c).toBe(true);
  });

  it('`to` and `cc` match as the whole name or the FIRST token only', () => {
    for (const n of ['to', 'cc', 'to_address', 'cc_list', 'toNumber', 'ccEmails']) {
      expect(isSensitiveParamName(n), n).toBe(true);
    }
    for (const n of [
      'path_to_file', 'convert_to_markdown', 'days_to_wait_before_mark_as_response',
      'replyToMessageId', 'call_to_action', 'relatedTo', 'exfil_to',
    ]) {
      expect(isSensitiveParamName(n), n).toBe(false);
    }
  });

  it('other substring traps from the real corpus stay clean', () => {
    // 838 distinct parameter names in four months of production traffic.
    for (const n of ['author', 'unfurl_app_links', 'source_file_id', 'run_waterfall_email']) {
      expect(isSensitiveParamName(n), n).toBe(false);
    }
  });

  it('matches on a whole token wherever it sits', () => {
    for (const n of ['url', 'source_url', 'data_source_url', 'fileUrl', 'bcc_emails', 'file_upload']) {
      expect(isSensitiveParamName(n), n).toBe(true);
    }
  });

  it('every any-position token is reachable through the tokeniser', () => {
    for (const t of SENSITIVE_TOKENS) {
      expect(isSensitiveParamName(t), t).toBe(true);
      expect(isSensitiveParamName(`prefix_${t}_suffix`), t).toBe(true);
    }
  });

  it('`links` is not `link`, and `email` singular is out of the list', () => {
    expect(isSensitiveParamName('links')).toBe(false);
    expect(isSensitiveParamName('email')).toBe(false);
    expect(isSensitiveParamName('emails')).toBe(true);
    expect(isSensitiveParamName('file')).toBe(false);
    expect(isSensitiveParamName('file_upload')).toBe(true);
  });
});
