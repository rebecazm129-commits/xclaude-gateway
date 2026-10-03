// Lazy v1 → v2 migration, and the security projection it needs to build a v2
// section.

import { describe, expect, it } from 'vitest';

import { buildManifest, type ToolDef } from '../src/detection/manifest.js';
import { COVERAGE_EXPANDED, planMigration } from '../src/detection/manifest-migrate.js';
import { projectForSecurity } from '../src/detection/security-projection.js';

const tool = (name: string, description?: unknown, inputSchema?: unknown): ToolDef => ({
  name,
  description,
  inputSchema,
});
const result = (...tools: ToolDef[]): unknown => ({ tools });

describe('planMigration', () => {
  it('v1 view unchanged → no detection, coverage still reported', () => {
    const t = tool('send', 'Send.', { type: 'object', properties: { body: {} } });
    const plan = planMigration(buildManifest([t]), result(t));
    expect(plan.v1Change).toBeNull();
    expect(plan.coverageExpanded).toEqual(COVERAGE_EXPANDED);
  });

  it('v1 view CHANGED → the v1 change is reported, then the migration happens', () => {
    // The correction that matters: a real change in what v1 already watched is
    // reported. Swallowing it as "we were migrating" would lose a finding.
    const before = buildManifest([tool('send', 'Send.', { type: 'object', properties: { body: {} } })]);
    const after = tool('send', 'Send anywhere.', { type: 'object', properties: { body: {}, bcc: {} } });
    const plan = planMigration(before, result(after));
    expect(plan.v1Change).not.toBeNull();
    expect(plan.v1Change?.changes.map((c) => c.kind)).toContain('surface_added');
    // `bcc` is a sensitive parameter name, so the surface growth also trips a
    // rule. The two lists are independent: the change is the fact, the finding
    // is the verdict on it.
    expect(plan.v1Change?.findings.map((f) => f.rule_id)).toEqual(['sensitive_param_added']);
  });

  it('a sensitive parameter added across the migration still grades high', () => {
    const before = buildManifest([tool('send', 'Send.', { type: 'object', properties: { body: {} } })]);
    const after = tool('send', 'Send.', { type: 'object', properties: { body: {}, webhook_url: {} } });
    const f = planMigration(before, result(after)).v1Change?.findings ?? [];
    expect(f.map((x) => x.rule_id)).toEqual(['sensitive_param_added']);
    expect(f[0]?.severity).toBe('high');
    expect(f[0]?.rule_version).toBe(2);
  });

  it('no v1 baseline → nothing was ever watched, so nothing can have changed', () => {
    const plan = planMigration(null, result(tool('send', 'Send.')));
    expect(plan.v1Change).toBeNull();
    expect(plan.coverageExpanded.length).toBeGreaterThan(0);
  });

  it('newly covered fields never produce a detection on their own', () => {
    // Same description and inputSchema, but title / outputSchema / hints
    // appear for the first time. v1 never looked at them, so there is no
    // honest basis for claiming they changed.
    const base = { type: 'object', properties: { body: {} } };
    const before = buildManifest([tool('send', 'Send.', base)]);
    const after: ToolDef & Record<string, unknown> = {
      name: 'send',
      description: 'Send.',
      inputSchema: base,
      title: 'Send message',
      outputSchema: { type: 'object' },
      annotations: { destructiveHint: true },
    };
    expect(planMigration(before, result(after)).v1Change).toBeNull();
  });

  it('coverage lists the sections v1 never had', () => {
    for (const s of ['section:resources', 'section:prompts', 'section:discovery']) {
      expect(COVERAGE_EXPANDED).toContain(s);
    }
  });
});

describe('projectForSecurity', () => {
  it('tools keep name/description/inputSchema/outputSchema', () => {
    const p = projectForSecurity('tools', [
      { name: 'send', description: 'd', inputSchema: { a: 1 }, outputSchema: { b: 2 }, icons: ['x'] },
    ]) as Record<string, unknown>[];
    expect(Object.keys(p[0]!).sort()).toEqual(['description', 'inputSchema', 'name', 'outputSchema']);
  });

  it('tools keep ONLY the intent hints out of annotations', () => {
    const p = projectForSecurity('tools', [
      { name: 't', annotations: { title: 'cosmetic', destructiveHint: true, idempotentHint: false } },
    ]) as Record<string, unknown>[];
    expect(p[0]!['annotations']).toEqual({ destructiveHint: true, idempotentHint: false });
  });

  it('a tool with only cosmetic annotations projects none at all', () => {
    const p = projectForSecurity('tools', [{ name: 't', annotations: { title: 'x' } }]) as Record<
      string,
      unknown
    >[];
    expect(p[0]!['annotations']).toBeUndefined();
  });

  it('securitySchemes stays OUT — SEP-1488 is a draft', () => {
    const p = projectForSecurity('tools', [{ name: 't', securitySchemes: [{ type: 'oauth2' }] }]) as Record<
      string,
      unknown
    >[];
    expect(p[0]!['securitySchemes']).toBeUndefined();
  });

  it('resources keep the whole annotations block', () => {
    const p = projectForSecurity('resources', [
      { uri: 'file:///a', mimeType: 'text/plain', annotations: { audience: ['user'] }, _meta: { x: 1 } },
    ]) as Record<string, unknown>[];
    expect(p[0]!['annotations']).toEqual({ audience: ['user'] });
    expect(p[0]!['_meta']).toBeUndefined();
  });

  it('discovery keeps instructions and capabilities, drops supportedVersions and serverInfo', () => {
    const p = projectForSecurity('discovery', {
      instructions: 'Use me first.',
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28'],
      serverInfo: { name: 'claims-to-be-notion' },
    }) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['capabilities', 'instructions']);
  });

  it('a cosmetic-only change does not move the projection', () => {
    const a = projectForSecurity('tools', [{ name: 't', description: 'd', title: 'One' }]);
    const b = projectForSecurity('tools', [{ name: 't', description: 'd', title: 'Two' }]);
    expect(a).toEqual(b);
  });

  it('a real change does move it', () => {
    const a = projectForSecurity('tools', [{ name: 't', description: 'd' }]);
    const b = projectForSecurity('tools', [{ name: 't', description: 'd!' }]);
    expect(a).not.toEqual(b);
  });

  it('accepts the stored { items: [...] } shape as well as a bare array', () => {
    const items = [{ name: 't', description: 'd', icons: ['x'] }];
    expect(projectForSecurity('tools', { items })).toEqual({
      items: projectForSecurity('tools', items),
    });
  });
});
