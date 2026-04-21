/**
 * Pump detector: rolling-window price buffer per symbol with threshold check
 * and per-symbol cooldown. Pure logic — no I/O, no timers. All "now" values
 * are injected so tests can advance time deterministically.
 */

export interface DetectorOptions {
  /** Size of the rolling window in milliseconds. */
  windowMs: number;
  /** Fire alert when (current / min) - 1 >= thresholdPct / 100. */
  thresholdPct: number;
  /** After an alert, suppress further alerts for this symbol for this long. */
  cooldownMs: number;
  /** Hard cap on entries per symbol buffer — defense against OOM bugs. */
  maxBufferEntries: number;
}

interface PricePoint {
  ts: number;
  price: number;
}

export interface PumpAlert {
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  /** Milliseconds between the minimum price in the window and the current tick. */
  elapsedMs: number;
  ts: number;
}

/**
 * Tracks prices per symbol and decides whether a pump alert should fire.
 *
 * Usage:
 *   const d = new PumpDetector({ windowMs: 60_000, thresholdPct: 2, ... });
 *   const alert = d.observe('BTCUSDT', 67420.15, Date.now());
 *   if (alert) { send(alert); }
 */
export class PumpDetector {
  private readonly buffers = new Map<string, PricePoint[]>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(private readonly opts: DetectorOptions) {
    if (opts.windowMs <= 0) throw new Error('windowMs must be > 0');
    if (opts.thresholdPct <= 0) throw new Error('thresholdPct must be > 0');
    if (opts.cooldownMs < 0) throw new Error('cooldownMs must be >= 0');
    if (opts.maxBufferEntries < 2) throw new Error('maxBufferEntries must be >= 2');
  }

  /**
   * Record a price tick and return an alert if the threshold just tripped.
   * Returns null otherwise (including during cooldown).
   */
  observe(symbol: string, price: number, now: number): PumpAlert | null {
    if (!Number.isFinite(price) || price <= 0) {
      // Bad tick — ignore but don't crash.
      return null;
    }

    // Cooldown: short-circuit before any buffer work so a pumping symbol
    // doesn't keep pushing us into recompute territory.
    const suppressedUntil = this.cooldownUntil.get(symbol);
    if (suppressedUntil !== undefined && now < suppressedUntil) {
      // We still want the buffer to keep flowing so that once cooldown
      // ends, the window reflects recent reality. Drop oldest if needed.
      this.pushAndTrim(symbol, price, now);
      return null;
    }

    const buf = this.pushAndTrim(symbol, price, now);

    // Need at least two points to measure a move.
    if (buf.length < 2) return null;

    let minPoint = buf[0]!;
    for (let i = 1; i < buf.length; i++) {
      const p = buf[i]!;
      if (p.price < minPoint.price) minPoint = p;
    }

    // Only fire on an upward move — minPoint must precede the current tick
    // in time. If the minimum IS the current tick (price is falling), skip.
    if (minPoint.ts >= now) return null;

    const changeRatio = price / minPoint.price - 1;
    const threshold = this.opts.thresholdPct / 100;

    if (changeRatio >= threshold) {
      this.cooldownUntil.set(symbol, now + this.opts.cooldownMs);
      return {
        symbol,
        fromPrice: minPoint.price,
        toPrice: price,
        changePct: changeRatio * 100,
        elapsedMs: now - minPoint.ts,
        ts: now,
      };
    }

    return null;
  }

  /**
   * Append a point, evict anything older than the window, enforce hard cap.
   * Returns the (possibly new) buffer for the symbol.
   */
  private pushAndTrim(symbol: string, price: number, now: number): PricePoint[] {
    let buf = this.buffers.get(symbol);
    if (!buf) {
      buf = [];
      this.buffers.set(symbol, buf);
    }
    buf.push({ ts: now, price });

    const cutoff = now - this.opts.windowMs;
    // Shift off expired front entries. `miniTicker` is ~1/s so this is cheap.
    while (buf.length > 0 && buf[0]!.ts < cutoff) {
      buf.shift();
    }

    // Hard cap — drop the oldest entries if someone (or a bug) floods us.
    while (buf.length > this.opts.maxBufferEntries) {
      buf.shift();
    }

    return buf;
  }

  /** Number of symbols currently being tracked. Exposed for stats/logging. */
  trackedSymbols(): number {
    return this.buffers.size;
  }

  /** For tests / introspection. */
  bufferSize(symbol: string): number {
    return this.buffers.get(symbol)?.length ?? 0;
  }

  /** For tests / introspection. */
  isOnCooldown(symbol: string, now: number): boolean {
    const until = this.cooldownUntil.get(symbol);
    return until !== undefined && now < until;
  }
}
