import type { Logger } from '../logger';

export interface TelegramSenderOptions {
  botToken: string;
  chatId: string;
  logger: Logger;
  /**
   * Max messages per second to send. Telegram's documented limit is 30/s to
   * one chat. We default to something a bit under. 0 or undefined = no cap.
   */
  rateLimitPerSec?: number;
  /**
   * After this many consecutive send failures we bump the log level to
   * error so ops see a sustained Telegram outage. Default 5.
   */
  failureAlarmThreshold?: number;
  /** Overridable for tests. Defaults to fetch + setTimeout. */
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/**
 * Minimal Telegram sender with a token-bucket rate limiter and a
 * consecutive-failure counter.
 *
 * - Rate limit: evenly-spaced slots (1000 / rateLimitPerSec ms apart) using
 *   an internal FIFO queue. Callers don't have to care — they await the
 *   returned promise and it resolves when the message is actually sent.
 * - Failure counter: every send failure increments; every success resets.
 *   Crossing `failureAlarmThreshold` emits `telegram.outage_suspected` at
 *   error level so PM2/logs surface it.
 *
 * The returned promise rejects on network or non-2xx HTTP (so callers can
 * still log-and-continue); we just never block the WS read loop.
 */
export function createTelegramSender(opts: TelegramSenderOptions) {
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.nowMs ?? (() => Date.now());

  const minSpacingMs = opts.rateLimitPerSec && opts.rateLimitPerSec > 0
    ? Math.floor(1000 / opts.rateLimitPerSec)
    : 0;

  const failureThreshold = opts.failureAlarmThreshold ?? 5;

  let nextSlotTs = 0;
  let consecutiveFailures = 0;
  let alarmRaised = false;

  /** Wait until we're within the rate-limit schedule, then claim the slot. */
  async function waitForSlot(): Promise<void> {
    if (minSpacingMs <= 0) return;
    const t = now();
    if (t < nextSlotTs) {
      const delay = nextSlotTs - t;
      nextSlotTs = nextSlotTs + minSpacingMs;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return;
    }
    nextSlotTs = t + minSpacingMs;
  }

  function onSendFailure(): void {
    consecutiveFailures++;
    if (!alarmRaised && consecutiveFailures >= failureThreshold) {
      alarmRaised = true;
      opts.logger.error('telegram.outage_suspected', {
        consecutiveFailures,
      });
    }
  }

  function onSendSuccess(): void {
    if (alarmRaised) {
      opts.logger.info('telegram.outage_recovered', {
        afterFailures: consecutiveFailures,
      });
    }
    consecutiveFailures = 0;
    alarmRaised = false;
  }

  async function sendMessage(text: string): Promise<void> {
    await waitForSlot();

    const body = {
      chat_id: opts.chatId,
      text,
      disable_web_page_preview: true,
    };

    let resp: Response;
    try {
      resp = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      onSendFailure();
      opts.logger.error('telegram.network_error', {
        error: (err as Error).message,
      });
      throw err;
    }

    if (!resp.ok) {
      onSendFailure();
      const bodyText = await resp.text().catch(() => '<unreadable>');
      opts.logger.error('telegram.http_error', {
        status: resp.status,
        body: bodyText.slice(0, 400),
      });
      throw new Error(`Telegram HTTP ${resp.status}`);
    }

    onSendSuccess();
  }

  // Expose some internals for heartbeat observability / tests.
  (sendMessage as SenderWithStats).consecutiveFailures = () => consecutiveFailures;
  return sendMessage as SenderWithStats;
}

interface SenderWithStats {
  (text: string): Promise<void>;
  consecutiveFailures(): number;
}

export type TelegramSender = ReturnType<typeof createTelegramSender>;

/** Format a pump alert for Telegram. Plain text — no MarkdownV2 escaping pain. */
export function formatAlertMessage(alert: {
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  elapsedMs: number;
  /** URL that opens the coin's Blox trading page (taps into the app via universal link on mobile). */
  tradeUrl: string;
}): string {
  const seconds = Math.max(1, Math.round(alert.elapsedMs / 1000));
  return [
    `🚀 ${alert.symbol} +${alert.changePct.toFixed(2)}% in ${seconds}s`,
    `${formatPrice(alert.fromPrice)} → ${formatPrice(alert.toPrice)}`,
    alert.tradeUrl,
  ].join('\n');
}

function formatPrice(p: number): string {
  // Keep up to 8 sig figs but avoid scientific notation for normal ranges.
  if (p >= 1) return p.toFixed(Math.max(2, 6 - Math.floor(Math.log10(p))));
  // sub-1 assets: show more decimals
  return p.toPrecision(6);
}
