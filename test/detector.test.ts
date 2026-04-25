import { describe, it, expect } from 'vitest';
import { PumpDetector } from '../src/detector';

const baseOpts = {
  windowMs: 60_000,
  thresholdPct: 2,
  cooldownMs: 15 * 60_000,
  maxBufferEntries: 120,
};

describe('PumpDetector', () => {
  describe('threshold detection', () => {
    it('returns null until the move crosses threshold', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      expect(d.observe('BTCUSDT', 100, now)).toBeNull();
      now += 1000;
      expect(d.observe('BTCUSDT', 101, now)).toBeNull(); // +1%
      now += 1000;
      expect(d.observe('BTCUSDT', 101.9, now)).toBeNull(); // +1.9%
    });

    it('fires an alert exactly at threshold', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 5000;
      const alert = d.observe('BTCUSDT', 102, now);
      expect(alert).not.toBeNull();
      expect(alert?.symbol).toBe('BTCUSDT');
      expect(alert?.fromPrice).toBe(100);
      expect(alert?.toPrice).toBe(102);
      expect(alert?.changePct).toBeCloseTo(2.0, 6);
      expect(alert?.elapsedMs).toBe(5000);
    });

    it('uses the min price in the window as the reference, not the first entry', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('ETHUSDT', 2000, now);
      now += 10_000;
      d.observe('ETHUSDT', 1950, now); // dipped
      now += 10_000;
      // From 1950 → 1989.50 is just +2.02%. Should fire.
      const alert = d.observe('ETHUSDT', 1989.5, now);
      expect(alert).not.toBeNull();
      expect(alert?.fromPrice).toBe(1950);
    });
  });

  describe('window eviction', () => {
    it('evicts entries older than windowMs so old highs do not suppress future alerts', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      // Start way up
      d.observe('FOOUSDT', 100, now);
      // Crash to 50
      now += 10_000;
      d.observe('FOOUSDT', 50, now);

      // Walk time forward past the window so 100 falls off
      now += 70_000;
      // This is within window of the 50 having fallen off too actually —
      // just re-enter a price near the bottom, no alert yet.
      d.observe('FOOUSDT', 50, now);
      now += 1_000;
      // +2% from fresh baseline of 50
      const alert = d.observe('FOOUSDT', 51, now);
      expect(alert).not.toBeNull();
      expect(alert?.fromPrice).toBe(50);
    });

    it('does not fire when the only low is outside the window', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('BARUSDT', 10, now); // very low, but will age out
      now += 120_000; // 2 minutes — way past windowMs
      d.observe('BARUSDT', 10.19, now);
      expect(d.bufferSize('BARUSDT')).toBe(1);
      now += 1000;
      expect(d.observe('BARUSDT', 10.2, now)).toBeNull();
    });
  });

  describe('cooldown', () => {
    it('suppresses further alerts on the same symbol for cooldownMs', () => {
      const d = new PumpDetector({ ...baseOpts, cooldownMs: 60_000 });
      let now = 1_000_000;
      d.observe('XYZUSDT', 100, now);
      now += 1000;
      const first = d.observe('XYZUSDT', 103, now);
      expect(first).not.toBeNull();

      // 30s later, another 5% spike — should be suppressed.
      now += 30_000;
      const suppressed = d.observe('XYZUSDT', 110, now);
      expect(suppressed).toBeNull();
      expect(d.isOnCooldown('XYZUSDT', now)).toBe(true);

      // Past cooldown — buffer now holds only the suppressed 110 tick
      // (older entries aged out). A small tick near 110 must not fire;
      // then a +3% move from there should re-alert.
      now += 35_000; // 65s after first, > cooldown
      expect(d.isOnCooldown('XYZUSDT', now)).toBe(false);
      const noAlert = d.observe('XYZUSDT', 111, now); // +0.9% — below threshold
      expect(noAlert).toBeNull();
      now += 1000;
      const second = d.observe('XYZUSDT', 113.3, now); // +3% from 110
      expect(second).not.toBeNull();
      expect(second?.fromPrice).toBe(110);
    });

    it('does not leak cooldown across symbols', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('AAAUSDT', 100, now);
      now += 1000;
      expect(d.observe('AAAUSDT', 103, now)).not.toBeNull();

      d.observe('BBBUSDT', 50, now);
      now += 1000;
      expect(d.observe('BBBUSDT', 52, now)).not.toBeNull();
    });
  });

  describe('hard ring-buffer cap', () => {
    it('never grows beyond maxBufferEntries even under a flood', () => {
      const d = new PumpDetector({ ...baseOpts, maxBufferEntries: 10 });
      let now = 1_000_000;
      for (let i = 0; i < 1000; i++) {
        // Same timestamp on purpose — simulate bug flooding within one ms.
        d.observe('BUGUSDT', 100 + (i % 3), now);
      }
      expect(d.bufferSize('BUGUSDT')).toBeLessThanOrEqual(10);
    });
  });

  describe('minElapsedMs gate', () => {
    it('suppresses alerts where the min→current elapsed is below the floor', () => {
      const d = new PumpDetector({ ...baseOpts, minElapsedMs: 15_000 });
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 5_000; // 5s — below floor
      expect(d.observe('BTCUSDT', 103, now)).toBeNull();
    });

    it('fires once the elapsed floor is crossed', () => {
      const d = new PumpDetector({ ...baseOpts, minElapsedMs: 15_000 });
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 20_000; // 20s — above floor
      const alert = d.observe('BTCUSDT', 103, now);
      expect(alert).not.toBeNull();
      expect(alert?.elapsedMs).toBe(20_000);
    });
  });

  describe('bad input handling', () => {
    it('ignores non-finite or non-positive prices', () => {
      const d = new PumpDetector(baseOpts);
      const now = 1_000_000;
      expect(d.observe('BTCUSDT', NaN, now)).toBeNull();
      expect(d.observe('BTCUSDT', 0, now)).toBeNull();
      expect(d.observe('BTCUSDT', -5, now)).toBeNull();
      expect(d.bufferSize('BTCUSDT')).toBe(0);
    });

    it('does not fire on a falling market', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('DOWNUSDT', 100, now);
      now += 5000;
      expect(d.observe('DOWNUSDT', 80, now)).toBeNull(); // -20% is not a pump
    });
  });

  describe('escalation alerts', () => {
    /**
     * The escalation feature: after an initial 2% alert, we keep watching
     * the symbol for tier-crossings (5/10/20/50% above the initial
     * fromPrice) for a fixed window (default 15 min) and emit follow-up
     * alerts so the user isn't silenced through the bulk of the move.
     */
    const escalationOpts = {
      ...baseOpts,
      cooldownMs: 15 * 60_000,
      escalationTiersPct: [5, 10, 20, 50],
      escalationWindowMs: 15 * 60_000,
    };

    it('marks the initial alert with kind=initial', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      const alert = d.observe('BTCUSDT', 102, now);
      expect(alert?.kind).toBe('initial');
      expect(d.hasActivePump('BTCUSDT')).toBe(true);
    });

    it('fires an escalation alert at +5% during cooldown', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      const initial = d.observe('BTCUSDT', 102, now);
      expect(initial?.kind).toBe('initial');

      // Climbs to +5% — escalation should fire even though we're in cooldown.
      now += 30_000;
      const esc = d.observe('BTCUSDT', 105, now);
      expect(esc).not.toBeNull();
      expect(esc?.kind).toBe('escalation');
      if (esc?.kind !== 'escalation') throw new Error('unreachable');
      expect(esc.tierPct).toBe(5);
      expect(esc.fromPrice).toBe(100); // reference is the initial fromPrice
      expect(esc.toPrice).toBe(105);
      expect(esc.changePct).toBeCloseTo(5, 6);
      expect(esc.elapsedMs).toBe(30_000); // since the initial alert
      expect(d.isOnCooldown('BTCUSDT', now)).toBe(true);
    });

    it('does not fire the same tier twice', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now); // initial

      now += 10_000;
      const first = d.observe('BTCUSDT', 105, now); // +5%
      expect(first?.kind).toBe('escalation');

      now += 1000;
      const dup = d.observe('BTCUSDT', 105.5, now); // still in 5% tier
      expect(dup).toBeNull();
    });

    it('fires only the highest tier when a single tick crosses several', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now); // initial @ from=100

      // Single tick from +2% to +25% — should fire only the 20% tier.
      now += 30_000;
      const esc = d.observe('BTCUSDT', 125, now);
      expect(esc?.kind).toBe('escalation');
      if (esc?.kind !== 'escalation') throw new Error('unreachable');
      expect(esc.tierPct).toBe(20);

      // A subsequent tick at +30% must not re-fire 5/10 tiers — they are
      // marked as already-fired alongside 20%.
      now += 1000;
      const next = d.observe('BTCUSDT', 130, now);
      expect(next).toBeNull();
    });

    it('ends the active-pump series when the top tier fires', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now);
      expect(d.hasActivePump('BTCUSDT')).toBe(true);

      now += 60_000;
      const esc = d.observe('BTCUSDT', 160, now); // +60% → top tier (50%) fires
      expect(esc?.kind).toBe('escalation');
      if (esc?.kind !== 'escalation') throw new Error('unreachable');
      expect(esc.tierPct).toBe(50);
      expect(d.hasActivePump('BTCUSDT')).toBe(false);

      // No further escalation alerts even if it keeps climbing.
      now += 1000;
      expect(d.observe('BTCUSDT', 200, now)).toBeNull();
    });

    it('expires the active-pump series after the escalation window', () => {
      const d = new PumpDetector({ ...escalationOpts, escalationWindowMs: 60_000 });
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now);
      expect(d.hasActivePump('BTCUSDT')).toBe(true);

      now += 70_000; // past the escalation window
      const esc = d.observe('BTCUSDT', 110, now); // would be +10% if window were open
      expect(esc).toBeNull();
      expect(d.hasActivePump('BTCUSDT')).toBe(false);
    });

    it('does not fire escalation when price has fallen back below fromPrice', () => {
      const d = new PumpDetector(escalationOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now);

      now += 10_000;
      // Pump fizzled — we shouldn't crash or fire an escalation. Series
      // stays open in case price recovers within the window.
      const esc = d.observe('BTCUSDT', 95, now);
      expect(esc).toBeNull();
      expect(d.hasActivePump('BTCUSDT')).toBe(true);
    });

    it('does nothing extra when escalation is disabled (default)', () => {
      const d = new PumpDetector(baseOpts);
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      const initial = d.observe('BTCUSDT', 102, now);
      expect(initial?.kind).toBe('initial');
      expect(d.hasActivePump('BTCUSDT')).toBe(false);

      now += 30_000;
      // No escalation tiers configured → cooldown gates everything.
      expect(d.observe('BTCUSDT', 110, now)).toBeNull();
    });

    it('rejects negative or zero tier values in the constructor', () => {
      expect(
        () =>
          new PumpDetector({ ...baseOpts, escalationTiersPct: [5, 0, 10], escalationWindowMs: 1000 }),
      ).toThrow(/escalationTiersPct/);
      expect(
        () =>
          new PumpDetector({ ...baseOpts, escalationTiersPct: [-5], escalationWindowMs: 1000 }),
      ).toThrow(/escalationTiersPct/);
    });

    it('normalises tiers (sort + dedupe) so callers do not have to', () => {
      const d = new PumpDetector({
        ...baseOpts,
        escalationTiersPct: [10, 5, 10, 50, 20],
        escalationWindowMs: 60_000,
      });
      let now = 1_000_000;
      d.observe('BTCUSDT', 100, now);
      now += 1000;
      d.observe('BTCUSDT', 102, now);

      now += 5000;
      const esc = d.observe('BTCUSDT', 105.1, now); // +5.1% → tier 5
      expect(esc?.kind).toBe('escalation');
      if (esc?.kind !== 'escalation') throw new Error('unreachable');
      expect(esc.tierPct).toBe(5);
    });
  });
});
