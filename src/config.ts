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
  /** URL of the Blox all-coins page (scraped for the supported-asset list). */
  bloxCoinsUrl: string;
  /** How often to refresh the Blox coin list, in hours. */
  bloxRefreshHours: number;
  /**
   * Minimum sustained elapsed time (seconds) between the window's min price
   * and the alert-firing tick. Guards against single-tick spikes. Default 0.
   */
  minElapsedSeconds: number;
  /** Max Telegram messages per second we'll fire. Default 20 (well under Telegram's 30/s limit). */
  telegramRateLimitPerSec: number;
  /** WS silence watchdog timeout, in seconds. Default 30. */
  silenceTimeoutSeconds: number;
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
    bloxCoinsUrl:
      process.env.BLOX_COINS_URL?.trim() ||
      'https://weareblox.com/nl-nl/cryptocurrency-coins',
    bloxRefreshHours: optionalNumber('BLOX_REFRESH_HOURS', 6, (n) => n > 0, 'must be > 0'),
    minElapsedSeconds: optionalNumber(
      'MIN_ELAPSED_SECONDS',
      0,
      (n) => n >= 0 && n <= 3600,
      'must be between 0 and 3600',
    ),
    telegramRateLimitPerSec: optionalNumber(
      'TELEGRAM_RATE_LIMIT_PER_SEC',
      20,
      (n) => n > 0 && n <= 30,
      'must be between 1 and 30',
    ),
    silenceTimeoutSeconds: optionalNumber(
      'SILENCE_TIMEOUT_SECONDS',
      30,
      (n) => n >= 5 && n <= 600,
      'must be between 5 and 600',
    ),
  };
  return cfg;
}

function optionalNumber(
  key: string,
  fallback: number,
  predicate: (n: number) => boolean,
  constraintMsg: string,
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${key} must be a number, got "${raw}"`);
  }
  if (!predicate(n)) {
    throw new ConfigError(`${key}=${n} ${constraintMsg}`);
  }
  return n;
}

export { ConfigError };
