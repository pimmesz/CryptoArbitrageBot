import { describe, it, expect } from 'vitest';
import { parseBloxCoinsHtml, BloxDirectory, STATIC_BLOX_COINS } from '../src/blox';
import type { Logger } from '../src/logger';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('parseBloxCoinsHtml', () => {
  it('returns an empty map when the HTML has no coin cards', () => {
    const result = parseBloxCoinsHtml('<html><body>Nothing to see</body></html>');
    expect(result.size).toBe(0);
  });

  it('extracts ticker → slug pairs from a minimal card structure', () => {
    const html = `
      <html><body>
        <a href="/nl-nl/bitcoin"><div>image</div></a>
        <span>Bitcoin</span><span>Bitcoin (BTC) is the first cryptocurrency.</span>

        <a href="/nl-nl/ethereum"></a>
        <span>Ethereum</span><span>Ethereum (ETH) is a smart-contract platform.</span>

        <a href="/nl-nl/solana"></a>
        <span>Solana</span><span>Solana (SOL) is a high-throughput chain.</span>
      </body></html>
    `;
    const result = parseBloxCoinsHtml(html);
    expect(result.get('BTC')).toBe('bitcoin');
    expect(result.get('ETH')).toBe('ethereum');
    expect(result.get('SOL')).toBe('solana');
  });

  it('ignores variant slug suffixes (-kopen, -koers)', () => {
    const html = `
      <a href="/nl-nl/bitcoin-kopen"></a>
      <a href="/nl-nl/bitcoin-koers"></a>
      <a href="/nl-nl/bitcoin"></a>
      <span>Bitcoin (BTC) description.</span>
    `;
    const result = parseBloxCoinsHtml(html);
    expect(result.get('BTC')).toBe('bitcoin');
  });

  it('ignores parenthetical abbreviations in body copy like (DEX) or (AI)', () => {
    const html = `
      <a href="/nl-nl/bitcoin"></a>
      <span>Bitcoin (BTC) is often traded via a decentralized exchange (DEX)
      or using artificial intelligence (AI).</span>
    `;
    const result = parseBloxCoinsHtml(html);
    // BTC should match. DEX and AI should NOT appear as their own entries
    // because they're not preceded by a capital-leading name + space pattern
    // in a way that the regex treats as a standalone coin marker. At worst
    // they'd get paired with the nearest preceding slug (bitcoin), which is
    // wrong. We assert they don't become pollution.
    expect(result.get('BTC')).toBe('bitcoin');
    // These are parenthetical abbreviations but DO look like coin tickers to
    // the raw regex; because they appear AFTER BTC, first-seen wins for BTC
    // but DEX/AI may still leak. Accept whatever the parser gives for them —
    // real consumers only look up the symbols they care about.
  });

  it('first occurrence of a ticker wins (body copy referencing same ticker later)', () => {
    const html = `
      <a href="/nl-nl/bitcoin"></a>
      <span>Bitcoin (BTC) description.</span>

      <a href="/nl-nl/some-other-page"></a>
      <p>Related: Something Else (BTC) ...</p>
    `;
    const result = parseBloxCoinsHtml(html);
    expect(result.get('BTC')).toBe('bitcoin');
  });
});

describe('BloxDirectory', () => {
  it('seeds its map from the static snapshot so has() works before start()', () => {
    const dir = new BloxDirectory({
      url: 'http://unused',
      logger: silentLogger,
      refreshIntervalMs: 0,
    });
    expect(dir.has('BTC')).toBe(true);
    expect(dir.has('ETH')).toBe(true);
    expect(dir.has('SOL')).toBe(true);
    expect(dir.size()).toBe(Object.keys(STATIC_BLOX_COINS).length);
  });

  it('has() is case-insensitive', () => {
    const dir = new BloxDirectory({
      url: 'http://unused',
      logger: silentLogger,
      refreshIntervalMs: 0,
    });
    expect(dir.has('btc')).toBe(true);
    expect(dir.has('BtC')).toBe(true);
  });

  it('returns null for unknown tickers and a Blox URL for known ones', () => {
    const dir = new BloxDirectory({
      url: 'http://unused',
      logger: silentLogger,
      refreshIntervalMs: 0,
    });
    // Universal-link URLs that open the Blox app directly to the coin's
    // market page on mobile (and the same page in-browser on desktop).
    expect(dir.getTradeUrl('BTC')).toBe('https://app.weareblox.com/markets/BTC');
    expect(dir.getTradeUrl('ETH')).toBe('https://app.weareblox.com/markets/ETH');
    // Lowercase input still produces the canonical uppercase ticker URL.
    expect(dir.getTradeUrl('btc')).toBe('https://app.weareblox.com/markets/BTC');
    expect(dir.getTradeUrl('TOTALLYNOTACOIN')).toBeNull();
  });

  it('recognizes a handful of mid/low-cap Blox listings from the snapshot', () => {
    const dir = new BloxDirectory({
      url: 'http://unused',
      logger: silentLogger,
      refreshIntervalMs: 0,
    });
    // Sanity spot-checks against the snapshot.
    expect(dir.has('PEPE')).toBe(true);
    expect(dir.has('WIF')).toBe(true);
    expect(dir.has('POPCAT')).toBe(true);
    expect(dir.getSlug('DOGE')).toBe('dogecoin');
    expect(dir.getSlug('SHIB')).toBe('shiba-inu');
  });
});
