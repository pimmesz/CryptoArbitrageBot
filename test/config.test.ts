/**
 * Config validation tests. Each test snapshots process.env, sets a specific
 * combination, loads the module fresh (so dotenv doesn't cache), and asserts
 * on the shape of loadConfig()'s output or on the thrown ConfigError message.
 *
 * Rationale: loadConfig is the first thing that runs in prod — if it accepts
 * bad inputs, the bot runs with wrong config; if it rejects good inputs, the
 * bot won't boot. Both silent failures, both expensive to notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Short-circuit dotenv so it doesn't repopulate process.env from the real
// on-disk `.env` between tests. We're driving the config module purely
// through process.env here; letting dotenv read from disk would give
// developer-local .env files a chance to make these tests flaky.
vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
  default: { config: () => ({ parsed: {} }) },
}));

/**
 * Load a fresh copy of the config module. Each test gets its own module
 * instance so previous `process.env` state doesn't leak in via closed-over
 * values.
 */
async function loadConfigFresh(): Promise<typeof import('../src/config')> {
  vi.resetModules();
  return await import('../src/config');
}

const REQUIRED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'PUMP_THRESHOLD_PCT',
  'WINDOW_SECONDS',
  'COOLDOWN_MINUTES',
  'QUOTE_CURRENCY',
  'EXCLUDE_SUFFIXES',
  'LOG_LEVEL',
];

const OPTIONAL_VARS = [
  'BLOX_COINS_URL',
  'BLOX_REFRESH_HOURS',
  'MIN_ELAPSED_SECONDS',
  'TELEGRAM_RATE_LIMIT_PER_SEC',
  'SILENCE_TIMEOUT_SECONDS',
  'BINANCE_WS_URL',
  'ESCALATION_TIERS_PCT',
  'ESCALATION_WINDOW_MINUTES',
];

const ALL_VARS = [...REQUIRED_VARS, ...OPTIONAL_VARS];

/** Minimal set of env values that make loadConfig happy. */
function validEnv(): Record<string, string> {
  return {
    TELEGRAM_BOT_TOKEN: 'tok',
    TELEGRAM_CHAT_ID: '-100123',
    PUMP_THRESHOLD_PCT: '2.0',
    WINDOW_SECONDS: '60',
    COOLDOWN_MINUTES: '15',
    QUOTE_CURRENCY: 'USDT',
    EXCLUDE_SUFFIXES: 'UPUSDT,DOWNUSDT',
    LOG_LEVEL: 'info',
  };
}

function applyEnv(env: Record<string, string | undefined>): void {
  // Clear every variable we might care about first — tests shouldn't leak.
  for (const k of ALL_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe('loadConfig', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('loads a minimal valid config with defaults for optional fields', async () => {
    applyEnv(validEnv());
    const { loadConfig } = await loadConfigFresh();
    const cfg = loadConfig();
    expect(cfg.telegramBotToken).toBe('tok');
    expect(cfg.telegramChatId).toBe('-100123');
    expect(cfg.pumpThresholdPct).toBe(2.0);
    expect(cfg.windowSeconds).toBe(60);
    expect(cfg.cooldownMinutes).toBe(15);
    expect(cfg.quoteCurrency).toBe('USDT');
    expect(cfg.excludeSuffixes).toEqual(['UPUSDT', 'DOWNUSDT']);
    expect(cfg.logLevel).toBe('info');
    // Defaults
    expect(cfg.bloxRefreshHours).toBe(6);
    expect(cfg.minElapsedSeconds).toBe(0);
    expect(cfg.telegramRateLimitPerSec).toBe(20);
    expect(cfg.silenceTimeoutSeconds).toBe(30);
    expect(cfg.binanceWsUrl).toBeUndefined();
    expect(cfg.escalationTiersPct).toEqual([5, 10, 20, 50]);
    expect(cfg.escalationWindowMinutes).toBe(15);
  });

  it('uppercases the quote currency', async () => {
    applyEnv({ ...validEnv(), QUOTE_CURRENCY: 'usdt' });
    const { loadConfig } = await loadConfigFresh();
    expect(loadConfig().quoteCurrency).toBe('USDT');
  });

  it('trims and uppercases exclude suffixes and drops empty entries', async () => {
    applyEnv({ ...validEnv(), EXCLUDE_SUFFIXES: ' upusdt , , BullUsdt,' });
    const { loadConfig } = await loadConfigFresh();
    expect(loadConfig().excludeSuffixes).toEqual(['UPUSDT', 'BULLUSDT']);
  });

  it('throws ConfigError when a required string is missing', async () => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>).TELEGRAM_BOT_TOKEN;
    applyEnv(env);
    const { loadConfig, ConfigError } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(ConfigError);
    expect(() => loadConfig()).toThrowError(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws ConfigError for an unparseable number', async () => {
    applyEnv({ ...validEnv(), PUMP_THRESHOLD_PCT: 'not-a-number' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/PUMP_THRESHOLD_PCT/);
  });

  it('rejects out-of-range WINDOW_SECONDS', async () => {
    applyEnv({ ...validEnv(), WINDOW_SECONDS: '4' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/WINDOW_SECONDS/);
  });

  it('rejects an unknown LOG_LEVEL', async () => {
    applyEnv({ ...validEnv(), LOG_LEVEL: 'verbose' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/LOG_LEVEL/);
  });

  it('accepts LOG_LEVEL case-insensitively', async () => {
    applyEnv({ ...validEnv(), LOG_LEVEL: 'DEBUG' });
    const { loadConfig } = await loadConfigFresh();
    expect(loadConfig().logLevel).toBe('debug');
  });

  it('rejects MIN_ELAPSED_SECONDS above the cap', async () => {
    applyEnv({ ...validEnv(), MIN_ELAPSED_SECONDS: '99999' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/MIN_ELAPSED_SECONDS/);
  });

  it('rejects TELEGRAM_RATE_LIMIT_PER_SEC outside 1..30', async () => {
    applyEnv({ ...validEnv(), TELEGRAM_RATE_LIMIT_PER_SEC: '31' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/TELEGRAM_RATE_LIMIT_PER_SEC/);
  });

  it('honours optional overrides when set', async () => {
    applyEnv({
      ...validEnv(),
      MIN_ELAPSED_SECONDS: '10',
      TELEGRAM_RATE_LIMIT_PER_SEC: '5',
      SILENCE_TIMEOUT_SECONDS: '45',
      BLOX_REFRESH_HOURS: '1',
      BINANCE_WS_URL: 'ws://localhost:1234',
    });
    const { loadConfig } = await loadConfigFresh();
    const cfg = loadConfig();
    expect(cfg.minElapsedSeconds).toBe(10);
    expect(cfg.telegramRateLimitPerSec).toBe(5);
    expect(cfg.silenceTimeoutSeconds).toBe(45);
    expect(cfg.bloxRefreshHours).toBe(1);
    expect(cfg.binanceWsUrl).toBe('ws://localhost:1234');
  });

  it('parses ESCALATION_TIERS_PCT, sorting and deduplicating', async () => {
    applyEnv({
      ...validEnv(),
      ESCALATION_TIERS_PCT: '10, 5, 5, 50,20 ',
      ESCALATION_WINDOW_MINUTES: '30',
    });
    const { loadConfig } = await loadConfigFresh();
    const cfg = loadConfig();
    expect(cfg.escalationTiersPct).toEqual([5, 10, 20, 50]);
    expect(cfg.escalationWindowMinutes).toBe(30);
  });

  it('treats an explicit empty ESCALATION_TIERS_PCT as "disabled"', async () => {
    applyEnv({ ...validEnv(), ESCALATION_TIERS_PCT: '' });
    const { loadConfig } = await loadConfigFresh();
    expect(loadConfig().escalationTiersPct).toEqual([]);
  });

  it('rejects non-numeric or non-positive ESCALATION_TIERS_PCT entries', async () => {
    applyEnv({ ...validEnv(), ESCALATION_TIERS_PCT: '5,abc,10' });
    let { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/ESCALATION_TIERS_PCT/);

    applyEnv({ ...validEnv(), ESCALATION_TIERS_PCT: '5,0,10' });
    ({ loadConfig } = await loadConfigFresh());
    expect(() => loadConfig()).toThrowError(/ESCALATION_TIERS_PCT/);
  });

  it('rejects ESCALATION_WINDOW_MINUTES outside 0..240', async () => {
    applyEnv({ ...validEnv(), ESCALATION_WINDOW_MINUTES: '500' });
    const { loadConfig } = await loadConfigFresh();
    expect(() => loadConfig()).toThrowError(/ESCALATION_WINDOW_MINUTES/);
  });

  it('accepts ESCALATION_WINDOW_MINUTES=0 (disabled)', async () => {
    applyEnv({ ...validEnv(), ESCALATION_WINDOW_MINUTES: '0' });
    const { loadConfig } = await loadConfigFresh();
    expect(loadConfig().escalationWindowMinutes).toBe(0);
  });
});
