export interface ParsedSseEvent { event?: string; id?: string; data: string; }

/** Incremental SSE parser that is safe across arbitrary network chunks. */
export class SseParser {
  private buffer = '';
  private eventType: string | undefined;
  private eventId: string | undefined;
  private dataLines: string[] = [];

  constructor(private readonly onEvent: (event: ParsedSseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.processLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  finish(): void {
    if (this.buffer.length) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.processLine(line);
    }
    this.dispatch();
  }

  private processLine(line: string): void {
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventType = value;
    else if (field === 'id' && !value.includes('\0')) this.eventId = value;
  }

  private dispatch(): void {
    if (!this.dataLines.length) { this.eventType = undefined; return; }
    this.onEvent({ event: this.eventType, id: this.eventId, data: this.dataLines.join('\n') });
    this.dataLines = [];
    this.eventType = undefined;
  }
}
