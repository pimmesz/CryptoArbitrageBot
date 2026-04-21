import * as cheerio from 'cheerio';
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
 * Strategy:
 *   - Parse with cheerio; walk the DOM in document order.
 *   - For each element:
 *       - If it's `<a href="/nl-nl/<slug>">` and the slug looks coin-ish
 *         (not a `-kopen` variant, not a known editorial page), emit a
 *         'link' event.
 *       - For every text node, scan for the coin-marker pattern
 *         `Name (TICKER)` — we require a capital-leading word before the
 *         parenthesized ticker so parenthetical abbreviations in body
 *         copy (e.g. "exchange (DEX)", "intelligence (AI)") don't match.
 *   - Pair each ticker with the nearest preceding link. First-seen ticker
 *     wins so body-copy `(BTC)` mentions further down the page don't
 *     reassign. This mirrors the previous regex parser's semantics — the
 *     DOM walk just makes it resilient to HTML formatting changes that
 *     would have shifted string offsets.
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
  const slugShape = /^[a-z0-9][a-z0-9.-]*$/;
  // Name (TICKER) — capital-leading preceding name avoids common false
  // positives like "(DEX)" / "(AI)" in body prose.
  const tickerRe = /(?:[A-Z][A-Za-z][A-Za-z .'-]{1,40}?) \(([A-Z][A-Z0-9]{1,9})\)/g;

  type Event = { kind: 'link'; slug: string } | { kind: 'ticker'; symbol: string };
  const events: Event[] = [];

  function isSlugAcceptable(slug: string): boolean {
    if (!slug) return false;
    if (bannedSlugs.has(slug)) return false;
    if (bannedSlugSuffixes.some((s) => slug.endsWith(s))) return false;
    return slugShape.test(slug);
  }

  type Node = {
    type?: string;
    name?: string;
    data?: string;
    attribs?: Record<string, string>;
    children?: Node[];
  };

  function walk(node: Node): void {
    if (node.type === 'tag' && node.name === 'a') {
      const href = node.attribs?.href;
      if (href && href.startsWith('/nl-nl/')) {
        const slug = href.replace(/^\/nl-nl\//, '').replace(/[/#?].*$/, '');
        if (isSlugAcceptable(slug)) {
          events.push({ kind: 'link', slug });
        }
      }
    } else if (node.type === 'text' && typeof node.data === 'string') {
      tickerRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = tickerRe.exec(node.data)) !== null) {
        events.push({ kind: 'ticker', symbol: m[1]! });
      }
    }
    const children = node.children;
    if (children) {
      for (const c of children) walk(c);
    }
  }

  const $ = cheerio.load(html);
  const root = $.root()[0] as unknown as Node | undefined;
  if (root) walk(root);

  const out = new Map<string, string>();
  let lastSlug: string | null = null;
  for (const e of events) {
    if (e.kind === 'link') {
      lastSlug = e.slug;
    } else if (lastSlug && !out.has(e.symbol)) {
      out.set(e.symbol, lastSlug);
    }
  }
  return out;
}
