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
   * error so ops see a sustained Telegram outage. Default 5. Must be > 0.
   */
  failureAlarmThreshold?: number;
  /**
   * Once an outage alarm has been raised, require this many consecutive
   * successes before we declare recovery. This guards against flaky
   * partial-outage scenarios where a single success resolving inbetween
   * failing sends would otherwise ping-pong the alarm. Default 3.
   */
  recoverySuccessThreshold?: number;
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
  if (failureThreshold <= 0) {
    throw new Error('failureAlarmThreshold must be > 0');
  }
  const recoveryThreshold = opts.recoverySuccessThreshold ?? 3;
  if (recoveryThreshold <= 0) {
    throw new Error('recoverySuccessThreshold must be > 0');
  }

  let nextSlotTs = 0;
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
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
    // Any failure resets the recovery run — we need N successes IN A ROW.
    consecutiveSuccesses = 0;
    if (!alarmRaised && consecutiveFailures >= failureThreshold) {
      alarmRaised = true;
      opts.logger.error('telegram.outage_suspected', {
        consecutiveFailures,
      });
    }
  }

  function onSendSuccess(): void {
    consecutiveSuccesses++;
    // When the alarm isn't raised, any success immediately zeroes the
    // failure counter — same as before. When the alarm IS raised, only a
    // run of `recoveryThreshold` consecutive successes clears it, so a
    // lucky retry landing between failing sends can't silence the alarm.
    if (!alarmRaised) {
      consecutiveFailures = 0;
      return;
    }
    if (consecutiveSuccesses >= recoveryThreshold) {
      opts.logger.info('telegram.outage_recovered', {
        afterFailures: consecutiveFailures,
        consecutiveSuccesses,
      });
      consecutiveFailures = 0;
      consecutiveSuccesses = 0;
      alarmRaised = false;
    }
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

/**
 * Format an alert for Telegram. Plain text — no MarkdownV2 escaping pain.
 *
 * Two flavours, distinguished by the `kind` field:
 *  - 'initial'    — first-time threshold trip. 🚀 with seconds since min.
 *  - 'escalation' — follow-up while a pump is active. 📈 with the tier
 *                    label so the reader sees "this is the +5% checkpoint
 *                    of the same pump", not a brand-new alert.
 *
 * When `kind` is omitted, formatter falls back to the 'initial' shape so
 * older callers that still pass a bare alert keep working.
 */
export function formatAlertMessage(alert: {
  kind?: 'initial' | 'escalation';
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  elapsedMs: number;
  /** Only meaningful when kind === 'escalation'. */
  tierPct?: number;
  /** URL that opens the coin's Blox trading page (taps into the app via universal link on mobile). */
  tradeUrl: string;
}): string {
  const seconds = Math.max(1, Math.round(alert.elapsedMs / 1000));
  if (alert.kind === 'escalation' && alert.tierPct !== undefined) {
    const elapsedLabel = formatElapsed(alert.elapsedMs);
    return [
      `📈 ${alert.symbol} now +${alert.changePct.toFixed(2)}% (passed +${alert.tierPct}%)`,
      `${formatPrice(alert.fromPrice)} → ${formatPrice(alert.toPrice)} (${elapsedLabel} since first alert)`,
      alert.tradeUrl,
    ].join('\n');
  }
  return [
    `🚀 ${alert.symbol} +${alert.changePct.toFixed(2)}% in ${seconds}s`,
    `${formatPrice(alert.fromPrice)} → ${formatPrice(alert.toPrice)}`,
    alert.tradeUrl,
  ].join('\n');
}

/**
 * Render an elapsed-since-initial-alert label as "Ns" / "N min Ms" / "N min".
 * Escalations are typically minutes-out, where seconds-only would feel clunky.
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (sec === 0) return `${min} min`;
  return `${min} min ${sec}s`;
}

function formatPrice(p: number): string {
  // Keep up to 8 sig figs but avoid scientific notation for normal ranges.
  if (p >= 1) return p.toFixed(Math.max(2, 6 - Math.floor(Math.log10(p))));
  // sub-1 assets: show more decimals
  return p.toPrecision(6);
}
