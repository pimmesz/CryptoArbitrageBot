import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { PumpDetector, type PumpAlert } from './detector';
import { BinanceMiniTickerClient, type MiniTicker } from './binance';
import { createTelegramSender, formatAlertMessage } from './telegram';
import { BloxDirectory } from './blox';

const DEFAULT_BINANCE_STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const ALERTS_FILE = path.resolve(process.cwd(), 'data', 'alerts.jsonl');

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  logger.info('boot', {
    thresholdPct: cfg.pumpThresholdPct,
    windowSeconds: cfg.windowSeconds,
    cooldownMinutes: cfg.cooldownMinutes,
    quote: cfg.quoteCurrency,
    excludeSuffixes: cfg.excludeSuffixes,
    bloxRefreshHours: cfg.bloxRefreshHours,
    nodeVersion: process.version,
  });

  // Ensure data/ exists so alerts.jsonl writes don't fail.
  try {
    fs.mkdirSync(path.dirname(ALERTS_FILE), { recursive: true });
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
  });

  const sendTelegram = createTelegramSender({
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    logger,
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

  // Heartbeat so pm2 logs show signs of life even when no alerts fire.
  let ticksSinceHeartbeat = 0;
  const heartbeat = setInterval(() => {
    logger.info('heartbeat', {
      trackedSymbols: detector.trackedSymbols(),
      ticksLast60s: ticksSinceHeartbeat,
      bloxCoins: blox.size(),
    });
    ticksSinceHeartbeat = 0;
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

  function emitAlert(alert: PumpAlert): void {
    // Base ticker: 'BTCUSDT' → 'BTC'. We use it to look up the Blox entry.
    const base = alert.symbol.endsWith(cfg.quoteCurrency)
      ? alert.symbol.slice(0, -cfg.quoteCurrency.length)
      : alert.symbol;
    const tradeUrl = blox.getTradeUrl(base);
    const onBlox = tradeUrl !== null;

    const record = {
      ts: new Date(alert.ts).toISOString(),
      event: 'pump_alert',
      symbol: alert.symbol,
      base,
      fromPrice: alert.fromPrice,
      toPrice: alert.toPrice,
      changePct: Number(alert.changePct.toFixed(4)),
      elapsedMs: alert.elapsedMs,
      onBlox,
      tradeUrl: tradeUrl ?? undefined,
    };
    logger.info('pump_alert', record);

    // Append to JSONL on disk. Sync write keeps ordering simple; file is tiny.
    try {
      fs.appendFileSync(ALERTS_FILE, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      logger.error('alerts_file.write_failed', {
        error: (err as Error).message,
      });
    }

    // Gate Telegram sends to coins actually available on Blox, so every
    // alert that lands on the phone is immediately actionable.
    if (!onBlox || !tradeUrl) {
      logger.debug('pump_alert.suppressed_not_on_blox', { symbol: alert.symbol });
      return;
    }

    const text = formatAlertMessage({
      symbol: alert.symbol,
      fromPrice: alert.fromPrice,
      toPrice: alert.toPrice,
      changePct: alert.changePct,
      elapsedMs: alert.elapsedMs,
      tradeUrl,
    });
    // Don't await — we must not block the read loop on Telegram latency.
    sendTelegram(text).catch((err: Error) => {
      logger.warn('telegram.send_failed', {
        symbol: alert.symbol,
        error: err.message,
      });
    });
  }

  const client = new BinanceMiniTickerClient({
    url: cfg.binanceWsUrl ?? DEFAULT_BINANCE_STREAM_URL,
    logger,
    onTicker: handleTicker,
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

  process.on('SIGTERM', () => {
    logger.info('shutdown', { signal: 'SIGTERM' });
    blox.stop();
    client.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('shutdown', { signal: 'SIGINT' });
    blox.stop();
    client.stop();
    process.exit(0);
  });

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
