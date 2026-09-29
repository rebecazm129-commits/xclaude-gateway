// @vitest-environment jsdom
// Component tests for the DetailDrawer findings section: duplicated
// (type, location) findings collapse into one row with a ×N counter, while
// distinct types never merge (the deliberate nl_bsn/pt_nif multi-label).
// window.xcg.detectionDetail is stubbed per test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DetailDrawer, groupFindings } from '../../src/renderer/components/DetailDrawer.js';
import type { DetectionDetail, DetectionRowSlim } from '../../src/shared/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW: DetectionRowSlim = {
  id: 'e1',
  ts: '2026-07-07T19:09:05.838Z',
  mcp: 'drive',
  type: 'mcp.detection_enrichment',
  category: 'pii_structured',
  severity: 'medium',
  source: 'gateway',
};

function detail(findings: DetectionDetail['findings']): DetectionDetail {
  return {
    id: 'e1',
    ts: '2026-07-07T19:09:05.838Z',
    session: '01HXTESTSESSION',
    mcp: 'drive',
    type: 'mcp.detection_enrichment',
    rpcId: 2,
    direction: 'server_to_client',
    category: 'pii_structured',
    severity: 'medium',
    source: 'gateway',
    findings,
  };
}

function stubDetail(d: DetectionDetail): void {
  vi.stubGlobal('xcg', { detectionDetail: vi.fn(async () => d) });
}

describe('DetailDrawer — findings grouping', () => {
  it('collapses identical (type, location) findings into one row with a counter', async () => {
    stubDetail(detail(Array.from({ length: 20 }, () => ({ type: 'email', location: 'result' }))));
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('×20')).toBeTruthy();
    // One collapsed row, not twenty.
    expect(screen.getAllByText('email')).toHaveLength(1);
    expect(screen.getAllByText('result')).toHaveLength(1);
  });

  it('never merges across types: nl_bsn/pt_nif multi-label stays two rows, no counter', async () => {
    stubDetail(
      detail([
        { type: 'nl_bsn', location: 'result' },
        { type: 'pt_nif', location: 'result' },
      ]),
    );
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('nl_bsn')).toBeTruthy();
    expect(screen.getByText('pt_nif')).toBeTruthy();
    // ×N counter pattern — /×\d/, not /×/, which would match the drawer's own close button.
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it('same type on different locations stays two rows (grouping key is type AND location)', async () => {
    stubDetail(
      detail([
        { type: 'email', location: 'params' },
        { type: 'email', location: 'result' },
        { type: 'email', location: 'result' },
      ]),
    );
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('×2')).toBeTruthy();
    expect(screen.getAllByText('email')).toHaveLength(2);
  });
});

describe('DetailDrawer — correlation line (frente 3)', () => {
  it('shows the Correlation line under Technical details when row.pairedSource is set', async () => {
    stubDetail(detail([]));
    render(
      <DetailDrawer row={{ ...ROW, pairedSource: 'cc-hook' }} onClose={vi.fn()} />,
    );
    // The kv list lives in the collapsed Technical details section.
    fireEvent.click(await screen.findByText('Technical details'));
    expect(screen.getByText('correlation:')).toBeTruthy();
    expect(screen.getByText('Also recorded by the Claude Code hook')).toBeTruthy();
  });

  it('no Correlation line without pairedSource', async () => {
    stubDetail(detail([]));
    render(<DetailDrawer row={ROW} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('Technical details'));
    expect(screen.queryByText('correlation:')).toBeNull();
  });
});

describe('groupFindings', () => {
  it('preserves first-seen order and counts per (type, location)', () => {
    expect(
      groupFindings([
        { type: 'email', location: 'result' },
        { type: 'iban', location: 'result' },
        { type: 'email', location: 'result' },
      ]),
    ).toEqual([
      { type: 'email', location: 'result', count: 2 },
      { type: 'iban', location: 'result', count: 1 },
    ]);
  });

  it('treats a missing location as its own group', () => {
    expect(groupFindings([{ type: 'email' }, { type: 'email', location: 'params' }])).toEqual([
      { type: 'email', count: 1 },
      { type: 'email', location: 'params', count: 1 },
    ]);
  });
});

describe('DetailDrawer — Claude Code elicitation', () => {
  const ELICIT_ROW: DetectionRowSlim = {
    id: 'el1',
    ts: '2026-09-28T10:00:00.000Z',
    mcp: 'spike-elicit',
    type: 'mcp.request',
    category: 'protocol_tripwire',
    severity: 'high',
    source: 'claude-code',
    method: 'elicitation/create',
  };
  const elicitDetail = (over: Partial<DetectionDetail> = {}): DetectionDetail => ({
    id: 'el1',
    ts: '2026-09-28T10:00:00.000Z',
    session: '01HXTESTSESSION',
    mcp: 'spike-elicit',
    type: 'mcp.request',
    rpcId: null,
    direction: 'server_to_client',
    category: 'protocol_tripwire',
    severity: 'high',
    source: 'claude-code',
    findings: [{ type: 'server_request', location: 'elicitation', rule: 'secret_field' }],
    method: 'elicitation/create',
    elicitation: {
      server: 'spike-elicit',
      mode: 'form',
      message: 'Sign in at https://evil.example/login',
      fields: [{ name: 'password', type: 'string', title: 'Password', required: true }],
    },
    ...over,
  });

  it('shows server, MCP method, mode, the message as plain text (no link), the fields and the user action', async () => {
    stubDetail(elicitDetail({ elicitationAction: 'accept' }));
    const { container } = render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('Server request')).toBeTruthy();
    expect(screen.getByText('spike-elicit')).toBeTruthy();
    expect(screen.getByText('MCP method:')).toBeTruthy();
    expect(screen.getByText('elicitation/create')).toBeTruthy();
    expect(screen.getByText('form')).toBeTruthy();
    expect(screen.getByTestId('elicitation-message').textContent).toBe('Sign in at https://evil.example/login');
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('password:')).toBeTruthy();
    expect(screen.getByText('Password · string · required')).toBeTruthy();
    expect(screen.getByText('User action:')).toBeTruthy();
    expect(screen.getByTestId('elicitation-action').textContent).toBe('Accepted');
    expect(screen.getByText('xCLAUDE does not store the values entered by the user.')).toBeTruthy();
    expect(screen.queryByText('Tool call')).toBeNull();
  });

  it('HIGH by a secret field: the note that MCP does not allow credentials in form mode', async () => {
    stubDetail(elicitDetail());
    render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
    expect((await screen.findByTestId('elicitation-secret-note')).textContent).toBe(
      'This form appears to request a secret. MCP does not allow sensitive credentials in form elicitation; they should be requested via URL mode.',
    );
  });

  it('the message and the fields sit under their own headings', async () => {
    stubDetail(elicitDetail());
    render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
    const message = await screen.findByText('Message');
    expect(message.parentElement?.contains(screen.getByTestId('elicitation-message'))).toBe(true);
    const fields = screen.getByText('Requested fields');
    expect(fields.parentElement?.contains(screen.getByText('password:'))).toBe(true);
  });

  it('url mode without a message or fields: no empty Message / Requested fields headings', async () => {
    stubDetail(elicitDetail({ elicitation: { server: 'spike-elicit', mode: 'url', fields: [], url: { scheme: 'https', host: 'example.com', path: '/' } } }));
    render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('Server request')).toBeTruthy();
    expect(screen.queryByText('Message')).toBeNull();
    expect(screen.queryByText('Requested fields')).toBeNull();
  });

  it('no secret field: no secret note', async () => {
    stubDetail(elicitDetail({ severity: 'medium', findings: [{ type: 'server_request', location: 'elicitation' }] }));
    render(<DetailDrawer row={{ ...ELICIT_ROW, severity: 'medium' }} onClose={vi.fn()} />);
    expect(await screen.findByText('Server request')).toBeTruthy();
    expect(screen.queryByTestId('elicitation-secret-note')).toBeNull();
  });

  it('Declined / Cancelled / no result — never "completed"; the not-stored line always', async () => {
    for (const [action, text] of [
      ['decline', 'Declined'],
      ['cancel', 'Cancelled'],
      [undefined, 'No user response was observed by xCLAUDE.'],
    ] as const) {
      stubDetail(elicitDetail(action !== undefined ? { elicitationAction: action } : {}));
      render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
      expect((await screen.findByTestId('elicitation-action')).textContent).toBe(text);
      expect(screen.getByText('xCLAUDE does not store the values entered by the user.')).toBeTruthy();
      expect(screen.queryByText(/completed/i)).toBeNull();
      cleanup();
    }
  });

  it('url mode: the URL without userinfo or fragment, and its flags', async () => {
    stubDetail(
      elicitDetail({
        elicitation: {
          server: 'spike-elicit',
          mode: 'url',
          fields: [],
          url: { scheme: 'http', host: 'xn--pple-43d.com', path: '/login', hadUserinfo: true, nonHttps: true, punycodeHost: true },
        },
      }),
    );
    render(<DetailDrawer row={ELICIT_ROW} onClose={vi.fn()} />);
    expect(await screen.findByText('http://xn--pple-43d.com/login')).toBeTruthy();
    expect(screen.getByText('Not HTTPS')).toBeTruthy();
    expect(screen.getByText('The URL carried a username or password (not kept)')).toBeTruthy();
    expect(screen.getByText('The host uses internationalized characters (punycode)')).toBeTruthy();
  });
});
