// How a source and a Claude Code tool are named on screen — shared by the
// renderer (cells, chips) and the main process (search), so what you read and
// what you can search for are computed by the same code.

import { CLAUDE_CODE_SOURCE, type SourceKind } from './types.js';

/**
 * Display names for the connectors in the Add source catalog, keyed by the
 * name they are wrapped under. The catalog in AddConnectorModal.tsx keeps its
 * own `label` per card; a test pins the two together, so a renamed card cannot
 * leave the SOURCE column saying the old name.
 */
export const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  notion: 'Notion',
  linear: 'Linear',
  atlassian: 'Atlassian',
  github: 'GitHub',
  stripe: 'Stripe',
  apollo: 'Apollo',
  slack: 'Slack',
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  asana: 'Asana',
  hubspot: 'HubSpot',
};

/** The catalog name for a connector, or undefined for one it does not list —
 *  a hand-wrapped local server keeps the name it was wrapped with. */
export function connectorLabel(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_LABELS, name) ? CONNECTOR_LABELS[name] : undefined;
}

/** A source as the Source chip and the SOURCE column name it. */
export function sourceLabel(name: string): string {
  if (name === CLAUDE_CODE_SOURCE) return 'Claude Code';
  return connectorLabel(name) ?? name;
}

// mcp__<server>__<tool>. Split at the FIRST "__" after the prefix, never at a
// single "_": server names carry underscores (claude_ai_Notion), and a tool
// name may carry "__" of its own. Same rule as the ingest's splitToolName.
const RAW_MCP_TOOL = /^mcp__(.+?)__(.+)$/s;

export function splitRawToolName(raw: string): { server: string; tool: string } | null {
  const m = RAW_MCP_TOOL.exec(raw);
  return m === null ? null : { server: m[1]!, tool: m[2]! };
}

interface ToolRow {
  source: SourceKind;
  mcp: string;
  toolName?: string | undefined;
}

/** Server and tool of a Claude Code call to an MCP tool, or null for anything
 *  else (a native tool, a Desktop connector's own traffic). The ingest has
 *  already split the name into `mcp` + `toolName`; a name that still arrives
 *  raw is split here by the same rule. */
function ccMcpParts(row: ToolRow): { server: string; tool: string } | null {
  if (row.source !== 'claude-code' || row.toolName === undefined) return null;
  const raw = splitRawToolName(row.toolName);
  if (raw !== null) return raw;
  if (row.mcp === CLAUDE_CODE_SOURCE) return null;
  return { server: row.mcp, tool: row.toolName };
}

// Claude.ai's own connectors reach Claude Code as claude_ai_<Service>. The
// prefix says where the connector is brokered, not what it is, so the visible
// name drops it — and takes the catalog's name when the service is one
// ("claude_ai_Linear" → "Linear", "claude_ai_Google_Drive" → "Google Drive").
const CLAUDE_AI_PREFIX = 'claude_ai_';

/** A server as the product names it: "via Notion" in the Claude Code view,
 *  "server: Notion" in the Detections panel. */
export function serverLabel(server: string): string {
  const known = connectorLabel(server);
  if (known !== undefined) return known;
  if (!server.startsWith(CLAUDE_AI_PREFIX) || server.length === CLAUDE_AI_PREFIX.length) return server;
  const service = server.slice(CLAUDE_AI_PREFIX.length);
  const spoken = service.replace(/_/g, ' ').toLowerCase();
  const byName = connectorLabel(service.toLowerCase());
  if (byName !== undefined) return byName;
  const byLabel = Object.values(CONNECTOR_LABELS).find((l) => l.toLowerCase() === spoken);
  return byLabel ?? service;
}

/** The TOOL cell: the tool's own name — "notion-fetch", never the server.
 *  Only a name that still arrives raw (mcp__…) changes, to its tool part. */
export function displayToolName(row: ToolRow): string | undefined {
  const parts = ccMcpParts(row);
  return parts === null ? row.toolName : parts.tool;
}

/** The connector a Claude Code MCP call went to, by its visible name
 *  ("Notion", "Linear"), or null for anything else. */
export function calledServerLabel(row: ToolRow): string | null {
  const parts = ccMcpParts(row);
  return parts === null ? null : serverLabel(parts.server);
}

/** The name Claude Code itself uses — mcp__notion__notion-fetch — for the
 *  panel and the cell's tooltip. The tool name untouched for everything else. */
export function rawToolName(row: ToolRow): string | undefined {
  const parts = ccMcpParts(row);
  if (parts === null) return row.toolName;
  return `mcp__${parts.server}__${parts.tool}`;
}
