// The MCP protocol surface xCLAUDE knows: every JSON-RPC method the spec
// defines, per direction and kind, and the protocol versions it names.
//
// Copied VERBATIM from @modelcontextprotocol/sdk 1.29.0 (dist/esm/types.js):
//   ClientRequestSchema       types.js:1956-1974
//   ServerRequestSchema       types.js:1993-2002
//   ClientNotificationSchema  types.js:1975-1981
//   ServerNotificationSchema  types.js:2003-2013
//   LATEST_PROTOCOL_VERSION / SUPPORTED_PROTOCOL_VERSIONS  types.js:2, :4
//
// COPIED, NOT IMPORTED. Importing the SDK's lists at runtime would let an SDK
// upgrade change what the protocol tripwire considers normal without anyone
// deciding it. tests/detection/protocol-spec.test.ts fails the moment these
// lists and the installed SDK diverge, so the update is a deliberate edit here.
//
// DELIBERATELY ABSENT:
//   - `server/discover`, the discovery RPC of the 2026-07-28 spec. The SDK does
//     not define it, and the connector-surface store already watches it as the
//     `discovery` section (manifest-sections.ts). It stays unknown on purpose:
//     the first connector that answers it trips unknown_method, and that is
//     the signal that the 2026-07-28 migration has reached this install.
//   - `2026-07-28` as a protocol version, for the same reason: its first
//     appearance in an initialize or a request's _meta is the migration alarm.
// Add both here, in one reviewed change, when the migration is planned.

/** Requests a client sends to a server. */
export const CLIENT_REQUEST_METHODS: readonly string[] = [
  'ping',
  'initialize',
  'completion/complete',
  'logging/setLevel',
  'prompts/get',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'tools/call',
  'tools/list',
  'tasks/get',
  'tasks/result',
  'tasks/list',
  'tasks/cancel',
];

/** Requests a server sends to a client. */
export const SERVER_REQUEST_METHODS: readonly string[] = [
  'ping',
  'sampling/createMessage',
  'elicitation/create',
  'roots/list',
  'tasks/get',
  'tasks/result',
  'tasks/list',
  'tasks/cancel',
];

/** Notifications a client sends to a server. */
export const CLIENT_NOTIFICATION_METHODS: readonly string[] = [
  'notifications/cancelled',
  'notifications/progress',
  'notifications/initialized',
  'notifications/roots/list_changed',
  'notifications/tasks/status',
];

/** Notifications a server sends to a client. */
export const SERVER_NOTIFICATION_METHODS: readonly string[] = [
  'notifications/cancelled',
  'notifications/progress',
  'notifications/message',
  'notifications/resources/updated',
  'notifications/resources/list_changed',
  'notifications/tools/list_changed',
  'notifications/prompts/list_changed',
  'notifications/tasks/status',
  'notifications/elicitation/complete',
];

export const LATEST_PROTOCOL_VERSION = '2025-11-25';

/** In the SDK's own order, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** Where a request can declare its protocol version outside initialize. */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
