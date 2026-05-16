// Contrato compartido del monorepo (type-only, sin runtime).
// Direction es una propiedad fundamental de cualquier frame MCP, no un tipo
// de detección: vive aquí para que proxy y desktop compartan una sola fuente.
export type Direction = 'client_to_server' | 'server_to_client';
