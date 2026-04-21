import type { Logger } from '../logger';
import { STATIC_BLOX_COINS } from './coins';

export interface BloxDirectoryOptions {
  /** URL of the Blox all-coins page. */
  url: string;
  logger: Logger;
  /** Refresh cadence in ms. Pass 0 or a negative number to disable. */
  refreshIntervalMs: number;
  /** Per-request timeout. */
  fetchTimeoutMs?: number;
}

const BASE_BLOX_URL = 'https://weareblox.com/nl-nl/';

/** Sanity floor — if the parser finds fewer entries than this we reject its output. */
const MIN_PLAUSIBLE_ENTRIES = 50;

/** Canonical tickers that must be present for a parse to be considered valid. */
const CANARY_TICKERS = ['BTC', 'ETH', 'SOL'];

/**
 * In-memory registry of Blox-supported coins. Backed by a static snapshot
 * (guaranteed correct at build time), upgraded at runtime by fetching the
 * live Blox page on a schedule.
 *
 * If the live fetch fails or looks implausible, we keep the previous map —
 * the bot never silently transitions to an empty directory.
 */
export class BloxDirectory {
  private map: Map<string, string>;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: BloxDirectoryOptions) {
    // Seed from the static snapshot so `has()` works before first fetch.
    this.map = new Map(Object.entries(STATIC_BLOX_COINS));
  }

  /**
   * Kick off an initial refresh (awaited) then schedule periodic updates.
   * Never throws — an initial failure just means we keep running on the
   * static snapshot. Schedule timing errors are logged, not surfaced.
   */
  async start(): Promise<void> {
    await this.refreshSafely('initial');
    if (this.opts.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refreshSafely('scheduled');
      }, this.opts.refreshIntervalMs);
      // Don't let the refresh timer keep the process alive on its own.
      this.refreshTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** How many coins are currently known. Useful for boot logs. */
  size(): number {
    return this.map.size;
  }

  has(ticker: string): boolean {
    return this.map.has(ticker.toUpperCase());
  }

  getSlug(ticker: string): string | null {
    return this.map.get(ticker.toUpperCase()) ?? null;
  }

  /** Blox web URL for this ticker, or null if not supported. Opens the Blox app via universal link on mobile. */
  getTradeUrl(ticker: string): string | null {
    const slug = this.getSlug(ticker);
    return slug ? BASE_BLOX_URL + slug : null;
  }

  private async refreshSafely(reason: 'initial' | 'scheduled'): Promise<void> {
    if (this.stopped) return;
    try {
      const parsed = await this.fetchAndParse();
      if (this.isPlausible(parsed)) {
        // Merge live parse on top of the static snapshot rather than
        // replacing wholesale. Reason: the HTML parser misses a handful
        // of legit coins (e.g. lowercased names like "pepe" / "bonk") —
        // wholesale replacement would silently suppress valid alerts.
        // Merging keeps the static floor AND picks up new Blox listings.
        const merged = new Map<string, string>(Object.entries(STATIC_BLOX_COINS));
        let addedOrUpdated = 0;
        for (const [ticker, slug] of parsed) {
          if (merged.get(ticker) !== slug) addedOrUpdated++;
          merged.set(ticker, slug);
        }
        const before = this.map.size;
        this.map = merged;
        this.opts.logger.info('blox.refresh_ok', {
          reason,
          before,
          after: this.map.size,
          parsedSize: parsed.size,
          addedOrUpdated,
        });
      } else {
        this.opts.logger.warn('blox.refresh_rejected', {
          reason,
          parsedSize: parsed.size,
          keepingSize: this.map.size,
        });
      }
    } catch (err) {
      this.opts.logger.warn('blox.refresh_failed', {
        reason,
        error: (err as Error).message,
        keepingSize: this.map.size,
      });
    }
  }

  private isPlausible(m: Map<string, string>): boolean {
    if (m.size < MIN_PLAUSIBLE_ENTRIES) return false;
    for (const t of CANARY_TICKERS) {
      if (!m.has(t)) return false;
    }
    // Extra guard: make sure BTC points at 'bitcoin' (a broken parse
    // sometimes pairs BTC with an unrelated slug from elsewhere on the page).
    if (m.get('BTC') !== 'bitcoin') return false;
    if (m.get('ETH') !== 'ethereum') return false;
    return true;
  }

  private async fetchAndParse(): Promise<Map<string, string>> {
    const timeoutMs = this.opts.fetchTimeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(this.opts.url, {
        signal: controller.signal,
        headers: {
          // A vanilla UA is fine for public marketing pages.
          'user-agent': 'pricebot/1.0 (+https://github.com/pimmesz/CryptoArbitrageBot)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      return parseBloxCoinsHtml(html);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parse the Blox cryptocurrency-coins HTML and return a ticker → slug map.
 *
 * The page renders each coin as a card with a link like
 *   <a href="/nl-nl/bitcoin">...</a>
 * closely followed by text such as
 *   <span>Bitcoin</span><span>Bitcoin (BTC) is ...</span>
 *
 * Strategy:
 *   - Collect every `/nl-nl/<slug>` href in the document, in order, skipping
 *     variant suffixes (-kopen, -koers, -voor-dummies, etc) and a small
 *     hand-maintained blocklist of non-coin pages that tend to show up first
 *     inside the card markup.
 *   - Collect every `(TICKER)` occurrence, in order, where TICKER looks like
 *     a coin symbol.
 *   - For each ticker, the nearest preceding slug href (by document
 *     position) is its match. First-seen ticker wins if the same ticker
 *     appears again later in body copy.
 *
 * Exported for unit testing.
 */
export function parseBloxCoinsHtml(html: string): Map<string, string> {
  const bannedSlugSuffixes = [
    '-kopen',
    '-koers',
    '-voor-dummies',
    '-vs-',
    '-uitleg',
    '-minen',
    '-wallet',
  ];
  const bannedSlugs = new Set([
    'cryptocurrency-coins',
    'cryptocurrency-kopen',
    'cryptocurrency-koers',
    'bitvavo-alternatief',
    'klachtenregeling',
    'cryptopedia',
    'over-blox',
    'privacybeleid',
    'voorwaarden',
    'veelgestelde-vragen',
    'contact',
    'nieuws',
    'blog',
  ]);

  // 1. All candidate slug hrefs with their document positions.
  const slugPositions: Array<{ pos: number; slug: string }> = [];
  const hrefRe = /href="\/nl-nl\/([a-z0-9][a-z0-9.-]*?)"/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const slug = m[1]!;
    if (bannedSlugs.has(slug)) continue;
    if (bannedSlugSuffixes.some((s) => slug.endsWith(s))) continue;
    slugPositions.push({ pos: m.index, slug });
  }

  // 2. All `(TICKER)` occurrences. Require a preceding capital-letter word
  // (name like "Bitcoin") to avoid matching things like "(DEX)" inside prose.
  const tickerRe = /(?:[A-Z][A-Za-z][A-Za-z .'-]{1,40}?) \(([A-Z][A-Z0-9]{1,9})\)/g;
  const tickerPositions: Array<{ pos: number; ticker: string }> = [];
  while ((m = tickerRe.exec(html)) !== null) {
    tickerPositions.push({ pos: m.index, ticker: m[1]! });
  }

  // 3. Pair each ticker with the nearest preceding slug (first-seen wins).
  const out = new Map<string, string>();
  let slugCursor = 0;
  let lastSlug: string | null = null;
  for (const t of tickerPositions) {
    while (slugCursor < slugPositions.length && slugPositions[slugCursor]!.pos < t.pos) {
      lastSlug = slugPositions[slugCursor]!.slug;
      slugCursor++;
    }
    if (!lastSlug) continue;
    if (!out.has(t.ticker)) {
      out.set(t.ticker, lastSlug);
    }
  }

  return out;
}
