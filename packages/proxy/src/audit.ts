// JsonlWriter: append-only ndjson persistence for one wrapper session.
// Each line is a complete envelope; durability is page-cache backed (no fsync
// per write — decisión diferida del Hito 2). Failures during write are
// surfaced as exceptions to the caller, which decides if they're recoverable.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Envelope {
  v: number;
  id: string;
  ts: string;
  session: string;
  mcp: string;
  type: string;
  [key: string]: unknown;
}

export interface Writer {
  write(envelope: Envelope): void;
  close(): void;
}

export class JsonlWriter implements Writer {
  private readonly fd: number;
  private closed = false;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.fd = openSync(filePath, 'a', 0o600);
  }

  write(envelope: Envelope): void {
    if (this.closed) {
      throw new Error('JsonlWriter.write called after close');
    }
    writeSync(this.fd, `${JSON.stringify(envelope)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
