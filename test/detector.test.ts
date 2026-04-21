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
});
