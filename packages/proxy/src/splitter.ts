// LineSplitter: decodifica UTF-8 streaming y separa por '\n'.
// Observación pura — no escribe, no emite eventos. El forwarding de bytes lo
// hace el .pipe() en main.ts; este splitter solo cuenta y expone líneas.
//
// El spec MCP stdio garantiza que cada frame JSON-RPC termina en '\n' y NO
// contiene '\n' embebidos. Frames vacíos no están en spec → no se cuentan.

export class LineSplitter {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  feed(chunk: Buffer): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        lines.push(line);
      }
      idx = this.buffer.indexOf('\n');
    }
    return lines;
  }

  incompleteBytes(): number {
    return Buffer.byteLength(this.buffer, 'utf8');
  }
}
