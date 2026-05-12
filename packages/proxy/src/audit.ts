// JsonlWriter: append-only ndjson persistence for one wrapper session.
// Each line is a complete envelope; durability is page-cache backed (no fsync
// per write — decisión diferida del Hito 2). Failures during write are
// surfaced as exceptions to the caller, which decides if they're recoverable.
// fsync() expone flush manual del fd para el shutdown limpio (Fase 6).

import { closeSync, fsync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const fsyncAsync = promisify(fsync);

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

export interface SyncableWriter extends Writer {
  fsync(): Promise<void>;
}

export class JsonlWriter implements SyncableWriter {
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

  // fsync sobre el fd, no sobre el directorio: garantiza que los bytes
  // del JSONL llegan a disco antes de salir del proceso (Fase 6). Usamos
  // fsync (no fdatasync) porque queremos size persistido como metadata.
  async fsync(): Promise<void> {
    if (this.closed) return;
    await fsyncAsync(this.fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
