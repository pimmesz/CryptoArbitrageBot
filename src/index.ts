import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { PumpDetector } from './detector';
import { BinanceMiniTickerClient, type MiniTicker } from './binance';
import { createTelegramSender, formatAlertMessage } from './telegram';
import { BloxDirectory } from './blox';
import { createAlertEmitter } from './alert-emitter';

const DEFAULT_BINANCE_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
// Anchor the data dir to the compiled file location (dist/ at runtime) rather
// than process.cwd(). PM2 respects cwd today but this decouples us from that
// assumption — launching the bot from any directory now writes to the same
// spot next to the code.
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.jsonl');

/** How long to wait on shutdown for pending appends/fetches to drain. */
const SHUTDOWN_DRAIN_MS = 2_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info('boot', {
    thresholdPct: cfg.pumpThresholdPct,
    windowSeconds: cfg.windowSeconds,
    cooldownMinutes: cfg.cooldownMinutes,
    minElapsedSeconds: cfg.minElapsedSeconds,
    quote: cfg.quoteCurrency,
    excludeSuffixes: cfg.excludeSuffixes,
    bloxRefreshHours: cfg.bloxRefreshHours,
    telegramRateLimitPerSec: cfg.telegramRateLimitPerSec,
    silenceTimeoutSeconds: cfg.silenceTimeoutSeconds,
    escalationTiersPct: cfg.escalationTiersPct,
    escalationWindowMinutes: cfg.escalationWindowMinutes,
    nodeVersion: process.version,
  });

  // Ensure data/ exists so alerts.jsonl writes don't fail.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    logger.error('bootstrap.mkdir_failed', { error: (err as Error).message });
    process.exit(1);
  }

  const detector = new PumpDetector({
    windowMs: cfg.windowSeconds * 1_000,
    thresholdPct: cfg.pumpThresholdPct,
    cooldownMs: cfg.cooldownMinutes * 60_000,
    // ~1 tick/s × 60s = 60 entries; cap at 2x headroom to stay safe.
    maxBufferEntries: 120,
    minElapsedMs: cfg.minElapsedSeconds * 1_000,
    escalationTiersPct: cfg.escalationTiersPct,
    escalationWindowMs: cfg.escalationWindowMinutes * 60_000,
  });

  const sendTelegram = createTelegramSender({
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    logger,
    rateLimitPerSec: cfg.telegramRateLimitPerSec,
  });

  const blox = new BloxDirectory({
    url: cfg.bloxCoinsUrl,
    logger,
    refreshIntervalMs: cfg.bloxRefreshHours * 60 * 60 * 1_000,
  });
  // Await initial refresh so the first few seconds of alerts can already
  // use the live Blox map. If it fails, start() doesn't throw — we fall
  // back to the bundled static snapshot.
  await blox.start();
  logger.info('blox.ready', { size: blox.size() });

  // Counters for the heartbeat; reset every tick.
  let ticksSinceHeartbeat = 0;
  let alertsSinceHeartbeat = 0;
  let escalationsSinceHeartbeat = 0;
  let suppressedSinceHeartbeat = 0;

  // Track in-flight alert appends so graceful shutdown can wait for them to
  // flush before the process exits. Without this, PM2 restarts can silently
  // drop the last line of alerts.jsonl.
  let pendingAppends = 0;
  const appendAlertRecord = (line: string): Promise<void> => {
    pendingAppends++;
    return fs.promises.appendFile(ALERTS_FILE, line, 'utf8').finally(() => {
      pendingAppends--;
    });
  };

  const emitAlert = createAlertEmitter({
    blox,
    quoteCurrency: cfg.quoteCurrency,
    sendTelegram,
    formatAlertMessage,
    appendAlertRecord,
    logger,
    onEmitted: (alert) => {
      if (alert.kind === 'escalation') escalationsSinceHeartbeat++;
      else alertsSinceHeartbeat++;
    },
    onSuppressed: () => {
      suppressedSinceHeartbeat++;
    },
  });

  // Heartbeat so pm2 logs show signs of life even when no alerts fire.
  const heartbeat = setInterval(() => {
    logger.info('heartbeat', {
      trackedSymbols: detector.trackedSymbols(),
      activePumps: detector.activePumpCount(),
      ticksLast60s: ticksSinceHeartbeat,
      bloxCoins: blox.size(),
      alertsLast60s: alertsSinceHeartbeat,
      escalationsLast60s: escalationsSinceHeartbeat,
      suppressedLast60s: suppressedSinceHeartbeat,
      telegramConsecutiveFailures: sendTelegram.consecutiveFailures(),
    });
    ticksSinceHeartbeat = 0;
    alertsSinceHeartbeat = 0;
    escalationsSinceHeartbeat = 0;
    suppressedSinceHeartbeat = 0;
  }, 60_000);
  heartbeat.unref();

  const quote = cfg.quoteCurrency;
  const excludes = cfg.excludeSuffixes;

  function shouldInclude(symbol: string): boolean {
    if (!symbol.endsWith(quote)) return false;
    for (const suffix of excludes) {
      if (symbol.endsWith(suffix)) return false;
    }
    return true;
  }

  function handleTicker(t: MiniTicker): void {
    ticksSinceHeartbeat++;
    if (!shouldInclude(t.s)) return;

    const price = Number(t.c);
    if (!Number.isFinite(price) || price <= 0) return;

    // Use event time from Binance (`E`) as the tick timestamp — more
    // accurate than local wall clock and stable across minor clock drift.
    const alert = detector.observe(t.s, price, t.E);
    if (alert) emitAlert(alert);
  }

  const client = new BinanceMiniTickerClient({
    url: cfg.binanceWsUrl ?? DEFAULT_BINANCE_STREAM_URL,
    logger,
    onTicker: handleTicker,
    silenceTimeoutMs: cfg.silenceTimeoutSeconds * 1_000,
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error('uncaught_exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // second signal — ignore, we're already on it
    shuttingDown = true;
    logger.info('shutdown', { signal, pendingAppends });
    clearInterval(heartbeat);
    blox.stop();
    client.stop();

    // Give in-flight appends and fetches a chance to flush. We cap the wait
    // at SHUTDOWN_DRAIN_MS so PM2 doesn't force-kill us after its own
    // timeout; whatever hasn't drained by then is lost.
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (pendingAppends > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (pendingAppends > 0) {
      logger.warn('shutdown.drain_timeout', { pendingAppends });
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

  client.start();
}

main().catch((err: Error) => {
  // Last-resort guard. `main` should only throw on config errors because
  // blox.start() and client.start() are designed to never reject.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'main.fatal',
    error: err.message,
    stack: err.stack,
  }));
  process.exit(1);
});
