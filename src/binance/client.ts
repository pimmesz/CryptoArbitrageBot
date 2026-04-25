import WebSocket, { type RawData } from 'ws';
import type { Logger } from '../logger';

/**
 * Binance combined mini-ticker payload shape. One object per symbol, one
 * array per message; emitted roughly once per second.
 * Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 */
export interface MiniTicker {
  /** Event type, always "24hrMiniTicker". */
  e: string;
  /** Event time (ms). */
  E: number;
  /** Symbol, e.g. "BTCUSDT". */
  s: string;
  /** Close price (last price) as a string. */
  c: string;
  /** Open price. */
  o: string;
  /** High. */
  h: string;
  /** Low. */
  l: string;
  /** Base asset volume. */
  v: string;
  /** Quote asset volume. */
  q: string;
}

export interface BinanceClientOptions {
  url: string;
  logger: Logger;
  /** Called for each payload tick. Errors thrown from the handler are logged but don't tear down the socket. */
  onTicker: (t: MiniTicker) => void;
  /** If no message arrives within this many ms, force-reconnect. */
  silenceTimeoutMs?: number;
  /** Initial backoff. Doubles each failure up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** After this long connected without issue, reset the backoff ladder. */
  resetBackoffAfterMs?: number;
}

/**
 * Resilient WebSocket client for Binance mini-ticker stream.
 *
 * - Auto-reconnects on close/error with exponential backoff (capped).
 * - Silence watchdog: if no message received within N seconds, force-reconnect.
 * - Resets backoff ladder after a stable connection.
 *
 * Lifetime: call `start()` once. `stop()` fully disables auto-reconnect and
 * closes the socket — only used for graceful shutdown / tests.
 */
export class BinanceMiniTickerClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private currentBackoffMs: number;

  private readonly silenceTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly resetBackoffAfterMs: number;

  constructor(private readonly opts: BinanceClientOptions) {
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 30_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.resetBackoffAfterMs = opts.resetBackoffAfterMs ?? 5 * 60_000;
    this.currentBackoffMs = this.baseBackoffMs;
  }

  start(): void {
    if (this.stopped) throw new Error('client already stopped');
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();

    this.opts.logger.info('ws.connecting', { url: this.opts.url });
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      this.opts.logger.info('ws.open', {});
      this.armSilenceWatchdog();
      // After a period of stable connection, reset backoff so a burst of
      // reconnects later doesn't inherit a long wait from hours ago.
      this.stabilityTimer = setTimeout(() => {
        if (this.currentBackoffMs !== this.baseBackoffMs) {
          this.opts.logger.debug('ws.backoff_reset', {});
        }
        this.currentBackoffMs = this.baseBackoffMs;
      }, this.resetBackoffAfterMs);
    });

    ws.on('message', (data: RawData) => {
      this.armSilenceWatchdog();
      this.handleMessage(data);
    });

    ws.on('error', (err: Error) => {
      this.opts.logger.warn('ws.error', { error: err.message });
      // 'error' is typically followed by 'close'; don't double-reconnect here.
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.opts.logger.warn('ws.close', {
        code,
        reason: reason.toString('utf8').slice(0, 200),
      });
      this.scheduleReconnect();
    });
  }

  private handleMessage(data: RawData): void {
    // `ws` can deliver Buffer | ArrayBuffer | Buffer[] depending on framing.
    // Normalise to a single utf-8 string before parsing so fragmented frames
    // don't silently fail JSON.parse.
    let text: string;
    try {
      text = rawToUtf8(data);
    } catch (err) {
      this.opts.logger.warn('ws.bad_frame', { error: (err as Error).message });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.opts.logger.warn('ws.bad_json', { error: (err as Error).message });
      return;
    }

    if (!Array.isArray(parsed)) {
      // miniTicker@arr always gives an array; anything else is a surprise.
      this.opts.logger.debug('ws.unexpected_payload', {
        type: typeof parsed,
      });
      return;
    }

    for (const item of parsed) {
      if (!isMiniTicker(item)) continue;
      try {
        this.opts.onTicker(item);
      } catch (err) {
        this.opts.logger.error('ticker_handler_error', {
          symbol: item.s,
          error: (err as Error).message,
        });
      }
    }
  }

  private armSilenceWatchdog(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.opts.logger.warn('ws.silence_timeout', {
        timeoutMs: this.silenceTimeoutMs,
      });
      // Force close — the 'close' handler will reconnect.
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
      }
    }, this.silenceTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();

    const delay = this.currentBackoffMs;
    this.opts.logger.info('ws.reconnect_scheduled', { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      // Ramp up for next time (capped).
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs);
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }
}

function isMiniTicker(x: unknown): x is MiniTicker {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    // Strict event-type match: if Binance ever multiplexes a different
    // event onto this stream URL, drop it rather than silently mishandle.
    o.e === '24hrMiniTicker' &&
    typeof o.s === 'string' &&
    typeof o.c === 'string' &&
    typeof o.E === 'number'
  );
}

/** Normalise a ws `RawData` payload to a utf-8 string. */
function rawToUtf8(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  throw new Error('unknown ws frame type');
}
