import { describe, expect, it, vi } from 'vitest';
import { createTelegramSender, formatAlertMessage } from '../src/telegram';
import type { Logger } from '../src/logger';

function makeLogger(): Logger & { events: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    events.push({ level, msg, fields });
  };
  return Object.assign(
    { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    { events },
  );
}

function okResponse(): Response {
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}

function errorResponse(status: number, body = 'bad'): Response {
  return new Response(body, { status });
}

describe('createTelegramSender', () => {
  it('posts JSON to the Telegram bot URL with disable_web_page_preview', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const send = createTelegramSender({
      botToken: 'TOK',
      chatId: '-100',
      logger,
      fetchImpl,
    });

    await send('hello');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/botTOK/sendMessage');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body).toEqual({ chat_id: '-100', text: 'hello', disable_web_page_preview: true });
  });

  it('throws and logs on HTTP errors without incrementing success counters past failures', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(500, 'boom'));
    const send = createTelegramSender({
      botToken: 'TOK',
      chatId: '-100',
      logger,
      fetchImpl,
    });

    await expect(send('x')).rejects.toThrow(/Telegram HTTP 500/);
    expect(send.consecutiveFailures()).toBe(1);
  });

  it('raises a single outage_suspected error after N consecutive failures and clears on success', async () => {
    const logger = makeLogger();
    const responses = [
      errorResponse(502),
      errorResponse(502),
      errorResponse(502),
      errorResponse(502),
      errorResponse(502),
      errorResponse(502),
      okResponse(),
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(responses.shift()!));
    const send = createTelegramSender({
      botToken: 'T',
      chatId: 'C',
      logger,
      fetchImpl,
      failureAlarmThreshold: 3,
    });

    for (let i = 0; i < 6; i++) {
      await expect(send('x')).rejects.toThrow();
    }
    // Exactly one outage_suspected should have been logged even across 6 fails.
    const outageEvents = logger.events.filter((e) => e.msg === 'telegram.outage_suspected');
    expect(outageEvents).toHaveLength(1);

    await send('y');
    expect(send.consecutiveFailures()).toBe(0);
    const recovered = logger.events.filter((e) => e.msg === 'telegram.outage_recovered');
    expect(recovered).toHaveLength(1);
  });

  it('spaces out calls when rateLimitPerSec is set', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const send = createTelegramSender({
      botToken: 'T',
      chatId: 'C',
      logger,
      fetchImpl,
      rateLimitPerSec: 20, // ~50ms apart
    });

    const started = Date.now();
    await Promise.all([send('a'), send('b'), send('c')]);
    const elapsed = Date.now() - started;
    // 3 messages at 20/s should take at least ~100ms (2 gaps of 50ms each).
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('formatAlertMessage', () => {
  it('renders symbol, % to 2 decimals, elapsed seconds, price arrow, and tradeUrl on separate lines', () => {
    const msg = formatAlertMessage({
      symbol: 'BTCUSDT',
      fromPrice: 67420.15,
      toPrice: 69000,
      changePct: 2.342,
      elapsedMs: 58_000,
      tradeUrl: 'https://weareblox.com/nl-nl/bitcoin',
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe('🚀 BTCUSDT +2.34% in 58s');
    expect(lines[1]).toContain('→');
    expect(lines[2]).toBe('https://weareblox.com/nl-nl/bitcoin');
  });

  it('floors elapsed at 1 second', () => {
    const msg = formatAlertMessage({
      symbol: 'XUSDT',
      fromPrice: 1,
      toPrice: 1.02,
      changePct: 2,
      elapsedMs: 0,
      tradeUrl: 'http://example',
    });
    expect(msg.split('\n')[0]).toBe('🚀 XUSDT +2.00% in 1s');
  });
});
