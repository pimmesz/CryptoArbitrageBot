/**
 * JSON-line logger. Writes one JSON object per line to stdout.
 *
 * Kept dependency-free so the whole runtime stack is just `ws` + `dotenv`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export function createLogger(minLevel: LogLevel): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ?? {}),
    };
    // Use a single write so lines don't interleave under load.
    process.stdout.write(JSON.stringify(line) + '\n');
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
