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

  it('raises a single outage_suspected error after N consecutive failures and clears on sustained recovery', async () => {
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
      recoverySuccessThreshold: 1, // simplest shape for this test
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

  it('requires a run of consecutive successes to clear the alarm — a single success does not', async () => {
    const logger = makeLogger();
    // 3 fails → alarm raised. Then success/fail/success/success/success pattern:
    //   success #1 (alarm still raised — needs 3 in a row)
    //   fail     (recovery run reset)
    //   success #1 (alarm still raised)
    //   success #2 (alarm still raised)
    //   success #3 (alarm clears)
    const responses = [
      errorResponse(502),
      errorResponse(502),
      errorResponse(502),
      okResponse(),
      errorResponse(502),
      okResponse(),
      okResponse(),
      okResponse(),
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(responses.shift()!));
    const send = createTelegramSender({
      botToken: 'T',
      chatId: 'C',
      logger,
      fetchImpl,
      failureAlarmThreshold: 3,
      recoverySuccessThreshold: 3,
    });

    // 3 failures trip the alarm
    for (let i = 0; i < 3; i++) {
      await expect(send('x')).rejects.toThrow();
    }
    expect(logger.events.filter((e) => e.msg === 'telegram.outage_suspected')).toHaveLength(1);

    // Single success does not clear it
    await send('y');
    expect(logger.events.filter((e) => e.msg === 'telegram.outage_recovered')).toHaveLength(0);

    // A failure in the middle resets the recovery run
    await expect(send('x')).rejects.toThrow();

    // Three successes in a row finally clears the alarm
    await send('y');
    await send('y');
    await send('y');
    expect(logger.events.filter((e) => e.msg === 'telegram.outage_recovered')).toHaveLength(1);
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

  it('renders escalation alerts with 📈, the tier label, and "since first alert"', () => {
    const msg = formatAlertMessage({
      kind: 'escalation',
      symbol: 'BTCUSDT',
      fromPrice: 100,
      toPrice: 112,
      changePct: 12.0,
      tierPct: 10,
      // 4 minutes 30 seconds since the initial alert
      elapsedMs: 4 * 60_000 + 30_000,
      tradeUrl: 'https://weareblox.com/nl-nl/bitcoin',
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe('📈 BTCUSDT now +12.00% (passed +10%)');
    expect(lines[1]).toContain('→');
    expect(lines[1]).toContain('4 min 30s since first alert');
    expect(lines[2]).toBe('https://weareblox.com/nl-nl/bitcoin');
  });

  it('uses second-only elapsed for sub-minute escalations and clean minutes for whole-minute deltas', () => {
    const subMin = formatAlertMessage({
      kind: 'escalation',
      symbol: 'XUSDT',
      fromPrice: 1,
      toPrice: 1.05,
      changePct: 5,
      tierPct: 5,
      elapsedMs: 45_000,
      tradeUrl: 'http://example',
    });
    expect(subMin.split('\n')[1]).toContain('45s since first alert');

    const whole = formatAlertMessage({
      kind: 'escalation',
      symbol: 'XUSDT',
      fromPrice: 1,
      toPrice: 1.1,
      changePct: 10,
      tierPct: 10,
      elapsedMs: 3 * 60_000,
      tradeUrl: 'http://example',
    });
    expect(whole.split('\n')[1]).toContain('3 min since first alert');
  });
});
