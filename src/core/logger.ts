import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.name;
  if (typeof error === 'object' && error !== null) {
    const { message, type } = error as { message?: unknown; type?: unknown };
    if (typeof message === 'string' && message.length > 0) return message.split('\n')[0] ?? message;
    if (typeof type === 'string') return `${type} event (no message)`;
  }
  return String(error);
}

function serialize(level: LogLevel, msg: string, fields: LogFields): string {
  const replacer = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value);
  return JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, replacer);
}

/** JSON-lines logger: stdout plus a daily file in logDir. File write failures go to stderr. */
export function createLogger(minLevel: LogLevel, logDir: string | null, bindings: LogFields = {}): Logger {
  const ready = logDir ? mkdir(logDir, { recursive: true }) : Promise.resolve(undefined);

  const write = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const line = serialize(level, msg, { ...bindings, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    if (!logDir) return;
    const file = join(logDir, `radar-${new Date().toISOString().slice(0, 10)}.log`);
    ready
      .then(() => appendFile(file, line + '\n'))
      .catch((error: unknown) => process.stderr.write(`log file write failed: ${errorMessage(error)}\n`));
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger(minLevel, logDir, { ...bindings, ...extra }),
  };
}

/** Logger that discards everything; for tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
