/**
 * JSONL logger for the budget governor.
 *
 * Every line is one JSON object: { ts, level, event, ...fields }.
 * Events never contain the API key; as defense in depth the serialized line is
 * scanned for the value of RUNPOD_API_KEY and any occurrence is redacted.
 */

import { appendFileSync } from 'node:fs';

export type LogLevel = 'info' | 'warn' | 'error';

export class JsonlLogger {
  private readonly filePath: string | null;
  private readonly secret: string | undefined;
  private readonly consoleOutput: boolean;

  constructor(options: { filePath?: string | null; consoleOutput?: boolean } = {}) {
    this.filePath = options.filePath ?? null;
    this.consoleOutput = options.consoleOutput ?? true;
    // Never hold more than the env-var value itself, and never log it.
    this.secret = process.env['RUNPOD_API_KEY'];
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    const safe = this.secret && this.secret.length > 0 ? line.split(this.secret).join('[REDACTED]') : line;
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, `${safe}\n`, 'utf8');
      } catch (err) {
        this.writeConsole(`governor: failed to append log: ${String(err)}`);
      }
    }
    if (this.consoleOutput) this.writeConsole(safe);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log('info', event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log('error', event, fields);
  }

  private writeConsole(text: string): void {
    process.stdout.write(`${text}\n`);
  }
}
