/**
 * Alert emitter: the glue between a raw detector alert and the outputs
 * (JSONL file, stdout log, Telegram message). Extracted from main() so it
 * can be unit-tested without spinning up a WS client.
 *
 * Lookup and Telegram gating both happen here. Callers pass in injectable
 * dependencies (Blox directory, telegram sender, append function, logger)
 * so tests can assert on side effects without touching the network or disk.
 *
 * The detector emits two alert kinds (initial + escalation). The emitter
 * routes them to the same destinations but with distinct formatting and
 * record shapes so downstream consumers (JSONL readers, Telegram users)
 * can tell them apart at a glance.
 */

import type { DetectorAlert } from './detector';
import type { Logger } from './logger';

export interface BloxLookup {
  getTradeUrl(ticker: string): string | null;
}

export interface AlertEmitterOptions {
  /** Blox directory-like thing: only needs getTradeUrl. */
  blox: BloxLookup;
  /** Quote currency we strip off the symbol to get the base ticker. */
  quoteCurrency: string;
  /** Send a Telegram message. Rejections are logged-and-swallowed. */
  sendTelegram: (text: string) => Promise<void>;
  /**
   * Build the Telegram message text from an alert + tradeUrl. Receives
   * `kind` and (for escalations) `tierPct` so it can render a distinct
   * format. Initial alerts pass `kind: 'initial'`.
   */
  formatAlertMessage: (alert: {
    kind: 'initial' | 'escalation';
    symbol: string;
    fromPrice: number;
    toPrice: number;
    changePct: number;
    elapsedMs: number;
    tradeUrl: string;
    tierPct?: number;
  }) => string;
  /** Append a single JSONL record. Rejections are logged-and-swallowed. */
  appendAlertRecord: (line: string) => Promise<void>;
  logger: Logger;
  /** Track counts — called once per alert so the heartbeat can surface them. */
  onEmitted?: (alert: DetectorAlert) => void;
  onSuppressed?: (alert: DetectorAlert) => void;
}

export interface AlertRecord {
  ts: string;
  event: 'pump_alert';
  /** 'initial' for the threshold trip; 'escalation' for tier-cross follow-ups. */
  kind: 'initial' | 'escalation';
  symbol: string;
  base: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  elapsedMs: number;
  /** Only present for escalation alerts. */
  tierPct?: number;
  onBlox: boolean;
  tradeUrl?: string;
}

export function createAlertEmitter(
  opts: AlertEmitterOptions,
): (alert: DetectorAlert) => void {
  const { blox, quoteCurrency, sendTelegram, formatAlertMessage, appendAlertRecord, logger } = opts;

  return function emitAlert(alert: DetectorAlert): void {
    // Base ticker: 'BTCUSDT' → 'BTC'. Look up Blox by base symbol.
    const base = alert.symbol.endsWith(quoteCurrency)
      ? alert.symbol.slice(0, -quoteCurrency.length)
      : alert.symbol;
    const tradeUrl = blox.getTradeUrl(base);
    const onBlox = tradeUrl !== null;

    const record: AlertRecord = {
      ts: new Date(alert.ts).toISOString(),
      event: 'pump_alert',
      kind: alert.kind,
      symbol: alert.symbol,
      base,
      fromPrice: alert.fromPrice,
      toPrice: alert.toPrice,
      changePct: Number(alert.changePct.toFixed(4)),
      elapsedMs: alert.elapsedMs,
      onBlox,
      ...(alert.kind === 'escalation' ? { tierPct: alert.tierPct } : {}),
      ...(tradeUrl ? { tradeUrl } : {}),
    };
    logger.info('pump_alert', record as unknown as Record<string, unknown>);

    // Append to JSONL — async. Don't await the caller; just log failures.
    // Ordering is preserved as long as callers don't reorder alerts.
    appendAlertRecord(JSON.stringify(record) + '\n').catch((err: Error) => {
      logger.error('alerts_file.write_failed', { error: err.message });
    });

    // Gate Telegram sends to coins actually available on Blox, so every
    // alert that lands on the phone is immediately actionable.
    if (!onBlox || !tradeUrl) {
      logger.debug('pump_alert.suppressed_not_on_blox', {
        symbol: alert.symbol,
        kind: alert.kind,
      });
      opts.onSuppressed?.(alert);
      return;
    }

    const text = formatAlertMessage({
      kind: alert.kind,
      symbol: alert.symbol,
      fromPrice: alert.fromPrice,
      toPrice: alert.toPrice,
      changePct: alert.changePct,
      elapsedMs: alert.elapsedMs,
      tradeUrl,
      ...(alert.kind === 'escalation' ? { tierPct: alert.tierPct } : {}),
    });
    // Don't await — the rate limiter already absorbs burst latency and we
    // must not block the WS read loop on Telegram round-trips.
    sendTelegram(text).catch((err: Error) => {
      logger.warn('telegram.send_failed', {
        symbol: alert.symbol,
        kind: alert.kind,
        error: err.message,
      });
    });
    opts.onEmitted?.(alert);
  };
}
