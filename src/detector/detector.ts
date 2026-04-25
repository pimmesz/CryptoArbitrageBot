/**
 * Pump detector: rolling-window price buffer per symbol with threshold check
 * and per-symbol cooldown. Pure logic — no I/O, no timers. All "now" values
 * are injected so tests can advance time deterministically.
 *
 * Two alert kinds are emitted (discriminated union via `kind`):
 *
 *  - 'initial'      — fires the first time a symbol's rolling window hits
 *                      `thresholdPct`. Identical semantics to the original
 *                      detector.
 *
 *  - 'escalation'   — fires while a pump is still active (within
 *                      `escalationWindowMs` after an initial alert) when the
 *                      total move from the initial alert's `fromPrice`
 *                      first crosses one of `escalationTiersPct`. Each tier
 *                      fires at most once per active pump. On a single tick
 *                      that crosses multiple tiers, only the highest fires
 *                      (the lower ones are also marked-fired so we don't
 *                      backfill them on the next tick). When the top tier
 *                      fires, the active-pump series ends. Reaching the
 *                      window deadline also ends the series.
 *
 * Escalation alerts intentionally bypass the cooldown gate: cooldown
 * protects against duplicate INITIAL alerts on the same pump; escalations
 * are the supported way to keep getting notified as that same pump grows.
 */

export interface DetectorOptions {
  /** Size of the rolling window in milliseconds. */
  windowMs: number;
  /** Fire alert when (current / min) - 1 >= thresholdPct / 100. */
  thresholdPct: number;
  /** After an alert, suppress further INITIAL alerts for this symbol for this long. */
  cooldownMs: number;
  /** Hard cap on entries per symbol buffer — defense against OOM bugs. */
  maxBufferEntries: number;
  /**
   * Optional floor on how long the pump must have been building. Prevents
   * a single spiky tick from tripping the threshold on its first recorded
   * comparison. Default 0 (no floor).
   *
   * Concretely: the min→current elapsed must be >= minElapsedMs.
   */
  minElapsedMs?: number;
  /**
   * Tiers (in %, measured from the initial alert's fromPrice) at which to
   * emit escalation alerts. Default [] = escalation disabled. Values must
   * be > 0; duplicates and order are normalised (sorted ascending,
   * deduplicated) inside the constructor.
   *
   * Example: [5, 10, 20, 50] fires when the total move from the initial
   * alert's fromPrice first reaches +5%, +10%, +20%, +50%. After +50% the
   * series ends.
   */
  escalationTiersPct?: number[];
  /**
   * How long after an initial alert we keep tracking the pump for
   * escalation alerts. Default 0 = disabled (no escalation regardless of
   * tiers).
   */
  escalationWindowMs?: number;
}

interface PricePoint {
  ts: number;
  price: number;
}

/** State per symbol while we're actively watching for escalation crossings. */
interface ActivePump {
  /** Reference price for tier calculations — the initial alert's fromPrice. */
  startPrice: number;
  /** When the initial alert fired. */
  startTs: number;
  /** Tier values that have already fired (or been skipped over). */
  firedTiers: Set<number>;
  /** Wall clock at which the active-pump series expires. */
  expiresAt: number;
}

/** First-time pump alert. Same shape as before, plus a `kind` discriminator. */
export interface PumpAlert {
  kind: 'initial';
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  /** Milliseconds between the minimum price in the window and the current tick. */
  elapsedMs: number;
  ts: number;
}

/**
 * Follow-up alert emitted while a pump is still active (within
 * `escalationWindowMs` after the initial alert).
 *
 * `changePct` is measured against the ORIGINAL `fromPrice`, not the
 * window minimum, so the tier-crossing semantics are unambiguous.
 */
export interface EscalationAlert {
  kind: 'escalation';
  symbol: string;
  /** The initial alert's fromPrice — fixed for the duration of the pump. */
  fromPrice: number;
  toPrice: number;
  /** Total move from `fromPrice` to `toPrice`, in percent. */
  changePct: number;
  /** The tier (in %) that was just crossed. Always one of `escalationTiersPct`. */
  tierPct: number;
  /** Milliseconds since the initial alert fired. */
  elapsedMs: number;
  ts: number;
}

export type DetectorAlert = PumpAlert | EscalationAlert;

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
  private readonly activePumps = new Map<string, ActivePump>();

  private readonly minElapsedMs: number;
  /** Sorted ascending, deduplicated. Empty if escalation is disabled. */
  private readonly escalationTiers: readonly number[];
  private readonly escalationWindowMs: number;

  constructor(private readonly opts: DetectorOptions) {
    if (opts.windowMs <= 0) throw new Error('windowMs must be > 0');
    if (opts.thresholdPct <= 0) throw new Error('thresholdPct must be > 0');
    if (opts.cooldownMs < 0) throw new Error('cooldownMs must be >= 0');
    if (opts.maxBufferEntries < 2) throw new Error('maxBufferEntries must be >= 2');
    if (opts.minElapsedMs !== undefined && opts.minElapsedMs < 0) {
      throw new Error('minElapsedMs must be >= 0');
    }
    if (opts.escalationWindowMs !== undefined && opts.escalationWindowMs < 0) {
      throw new Error('escalationWindowMs must be >= 0');
    }
    if (opts.escalationTiersPct !== undefined) {
      for (const t of opts.escalationTiersPct) {
        if (!Number.isFinite(t) || t <= 0) {
          throw new Error(`escalationTiersPct entries must be > 0 (got ${t})`);
        }
      }
    }
    this.minElapsedMs = opts.minElapsedMs ?? 0;
    // Normalise tiers: sort ascending and dedupe so callers don't have to.
    const rawTiers = opts.escalationTiersPct ?? [];
    this.escalationTiers = Array.from(new Set(rawTiers)).sort((a, b) => a - b);
    this.escalationWindowMs = opts.escalationWindowMs ?? 0;
  }

  /**
   * Record a price tick and return an alert if the threshold just tripped
   * or an escalation tier was just crossed. Returns null otherwise
   * (including during cooldown when no escalation tier was reached).
   */
  observe(symbol: string, price: number, now: number): DetectorAlert | null {
    if (!Number.isFinite(price) || price <= 0) {
      // Bad tick — ignore but don't crash.
      return null;
    }

    // Escalation check goes BEFORE the cooldown gate: an active pump should
    // keep delivering tier-crossing alerts even though cooldown is
    // blocking a duplicate INITIAL alert.
    const escalation = this.maybeEscalate(symbol, price, now);
    if (escalation) {
      // Still want the price to enter the rolling buffer so post-cooldown
      // detection has up-to-date data.
      this.pushAndTrim(symbol, price, now);
      return escalation;
    }

    // Cooldown: short-circuit before any buffer work so a pumping symbol
    // doesn't keep pushing us into recompute territory.
    const suppressedUntil = this.cooldownUntil.get(symbol);
    if (suppressedUntil !== undefined) {
      if (now < suppressedUntil) {
        // We still want the buffer to keep flowing so that once cooldown
        // ends, the window reflects recent reality. Drop oldest if needed.
        this.pushAndTrim(symbol, price, now);
        return null;
      }
      // Cooldown expired — clear the entry so the map doesn't grow
      // unboundedly over long uptimes as one-time pumpers accumulate.
      this.cooldownUntil.delete(symbol);
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
    const elapsedMs = now - minPoint.ts;

    if (changeRatio >= threshold && elapsedMs >= this.minElapsedMs) {
      this.cooldownUntil.set(symbol, now + this.opts.cooldownMs);
      // Register an active pump if escalation is enabled. The reference
      // price is the window min that just tripped, so escalation tiers
      // measure the same move the user just got an alert about.
      if (this.escalationTiers.length > 0 && this.escalationWindowMs > 0) {
        this.activePumps.set(symbol, {
          startPrice: minPoint.price,
          startTs: now,
          firedTiers: new Set(),
          expiresAt: now + this.escalationWindowMs,
        });
      }
      return {
        kind: 'initial',
        symbol,
        fromPrice: minPoint.price,
        toPrice: price,
        changePct: changeRatio * 100,
        elapsedMs,
        ts: now,
      };
    }

    return null;
  }

  /**
   * If `symbol` has an active pump and `price` just crossed an unfired
   * tier, mutate the pump state and return an EscalationAlert. Otherwise
   * return null. Also lazily clears expired active pumps.
   */
  private maybeEscalate(
    symbol: string,
    price: number,
    now: number,
  ): EscalationAlert | null {
    const active = this.activePumps.get(symbol);
    if (!active) return null;

    if (now >= active.expiresAt) {
      // Window closed — drop and let the next initial alert re-arm.
      this.activePumps.delete(symbol);
      return null;
    }

    if (price <= active.startPrice) {
      // Price dropped to or below the initial reference — measuring tiers
      // off it would be meaningless. Don't fire here, but DO keep the
      // active pump in case the price recovers within the window. We
      // simply have nothing to say about a coin that's no longer up.
      return null;
    }

    const totalChangePct = (price / active.startPrice - 1) * 100;

    // Find the highest unfired tier whose threshold the current price
    // already meets. By only firing the highest, a single jumpy tick
    // from +4% to +12% emits one alert (10%), not two.
    let tierToFire: number | null = null;
    for (const tier of this.escalationTiers) {
      if (totalChangePct >= tier && !active.firedTiers.has(tier)) {
        tierToFire = tier; // tiers are sorted asc — last hit wins
      }
    }
    if (tierToFire === null) return null;

    // Mark this tier and any lower ones as fired — we don't want to
    // backfill the lower tiers on subsequent ticks.
    for (const tier of this.escalationTiers) {
      if (tier <= tierToFire) active.firedTiers.add(tier);
    }

    // If the highest tier just fired, end the series — there's nothing
    // bigger we can say about this pump.
    const topTier = this.escalationTiers[this.escalationTiers.length - 1]!;
    if (tierToFire === topTier) {
      this.activePumps.delete(symbol);
    }

    return {
      kind: 'escalation',
      symbol,
      fromPrice: active.startPrice,
      toPrice: price,
      changePct: totalChangePct,
      tierPct: tierToFire,
      elapsedMs: now - active.startTs,
      ts: now,
    };
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

  /** Number of pumps currently in escalation tracking. Exposed for heartbeat. */
  activePumpCount(): number {
    return this.activePumps.size;
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

  /** For tests / introspection. */
  hasActivePump(symbol: string): boolean {
    return this.activePumps.has(symbol);
  }
}
