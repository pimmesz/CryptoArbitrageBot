import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  pumpThresholdPct: number;
  windowSeconds: number;
  cooldownMinutes: number;
  quoteCurrency: string;
  excludeSuffixes: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Optional override of the Binance WS URL. Useful for testing reconnect paths. */
  binanceWsUrl?: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = 'ConfigError';
  }
}

function requireString(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${key} is required but not set`);
  }
  return value.trim();
}

function requireNumber(key: string, predicate: (n: number) => boolean, constraintMsg: string): number {
  const raw = requireString(key);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${key} must be a number, got "${raw}"`);
  }
  if (!predicate(n)) {
    throw new ConfigError(`${key}=${n} ${constraintMsg}`);
  }
  return n;
}

function parseLogLevel(raw: string): Config['logLevel'] {
  const allowed = ['debug', 'info', 'warn', 'error'] as const;
  const lowered = raw.toLowerCase();
  if ((allowed as readonly string[]).includes(lowered)) {
    return lowered as Config['logLevel'];
  }
  throw new ConfigError(`LOG_LEVEL must be one of ${allowed.join(', ')}, got "${raw}"`);
}

export function loadConfig(): Config {
  const cfg: Config = {
    telegramBotToken: requireString('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireString('TELEGRAM_CHAT_ID'),
    pumpThresholdPct: requireNumber('PUMP_THRESHOLD_PCT', (n) => n > 0, 'must be > 0'),
    windowSeconds: requireNumber('WINDOW_SECONDS', (n) => n >= 5 && n <= 3600, 'must be between 5 and 3600'),
    cooldownMinutes: requireNumber('COOLDOWN_MINUTES', (n) => n >= 0, 'must be >= 0'),
    quoteCurrency: requireString('QUOTE_CURRENCY').toUpperCase(),
    excludeSuffixes: requireString('EXCLUDE_SUFFIXES')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0),
    logLevel: parseLogLevel(requireString('LOG_LEVEL')),
    binanceWsUrl: process.env.BINANCE_WS_URL?.trim() || undefined,
  };
  return cfg;
}

export { ConfigError };
