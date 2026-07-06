// Per-connector advisory format checks for config:seed-client. The dogfood
// bug this guards against: seeding a Slack client must never trigger the
// Google shape warnings (and vice versa).

import { describe, expect, it } from 'vitest';

import { seedClientWarnings } from '../../src/main/seed-client-warnings.js';

describe('seedClientWarnings', () => {
  it('google: well-formed id + secret → no warnings', () => {
    expect(
      seedClientWarnings(
        ['gmail', 'calendar', 'drive'],
        '487230222406-abc.apps.googleusercontent.com',
        'GOCSPX-s3cr3t',
      ),
    ).toEqual([]);
  });

  it('google: wrong-looking id and secret → both warnings, never blocking values echoed', () => {
    const warnings = seedClientWarnings(['gmail', 'calendar', 'drive'], 'not-a-google-id', 'nope');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/\.apps\.googleusercontent\.com/);
    expect(warnings[1]).toMatch(/GOCSPX-/);
    // Messages describe the expected shape, never the pasted values.
    expect(warnings.join(' ')).not.toMatch(/not-a-google-id|nope/);
  });

  it('slack: digits.digits id → no warnings (the dogfood regression)', () => {
    expect(seedClientWarnings(['slack'], '11360289141252.11360391564484', undefined)).toEqual([]);
  });

  it('slack: google-shaped id → the SLACK warning, not the Google one', () => {
    const warnings = seedClientWarnings(['slack'], 'x.apps.googleusercontent.com', undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Slack Client ID/);
    expect(warnings[0]).not.toMatch(/googleusercontent/);
  });

  it('slack: no secret hint → a present secret is never warned about', () => {
    expect(seedClientWarnings(['slack'], '1111.2222', 'whatever')).toEqual([]);
  });

  it('unknown connector → no checks at all', () => {
    expect(seedClientWarnings(['notion'], 'anything', 'anything')).toEqual([]);
  });

  it('mixed names: the first name with a known shape decides', () => {
    const warnings = seedClientWarnings(['unknown-first', 'slack'], 'bad id', undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Slack Client ID/);
  });
});
