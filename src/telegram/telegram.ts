import type { Logger } from '../logger';

export interface TelegramSenderOptions {
  botToken: string;
  chatId: string;
  logger: Logger;
}

/**
 * Minimal Telegram sender. Fire-and-forget — returns a promise that resolves
 * on success and rejects on HTTP/network failure. Callers may log-and-continue
 * without awaiting (alerts must not block the WS read loop).
 */
export function createTelegramSender(opts: TelegramSenderOptions) {
  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;

  return async function sendMessage(text: string): Promise<void> {
    const body = {
      chat_id: opts.chatId,
      text,
      disable_web_page_preview: true,
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      opts.logger.error('telegram.network_error', {
        error: (err as Error).message,
      });
      throw err;
    }

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '<unreadable>');
      opts.logger.error('telegram.http_error', {
        status: resp.status,
        body: bodyText.slice(0, 400),
      });
      throw new Error(`Telegram HTTP ${resp.status}`);
    }
  };
}

export type TelegramSender = ReturnType<typeof createTelegramSender>;

/** Format a pump alert for Telegram. Plain text — no MarkdownV2 escaping pain. */
export function formatAlertMessage(alert: {
  symbol: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
  elapsedMs: number;
}): string {
  const seconds = Math.max(1, Math.round(alert.elapsedMs / 1000));
  const tradeUrl = buildTradeUrl(alert.symbol);
  return [
    `🚀 ${alert.symbol} +${alert.changePct.toFixed(2)}% in ${seconds}s`,
    `${formatPrice(alert.fromPrice)} → ${formatPrice(alert.toPrice)}`,
    tradeUrl,
  ].join('\n');
}

function formatPrice(p: number): string {
  // Keep up to 8 sig figs but avoid scientific notation for normal ranges.
  if (p >= 1) return p.toFixed(Math.max(2, 6 - Math.floor(Math.log10(p))));
  // sub-1 assets: show more decimals
  return p.toPrecision(6);
}

function buildTradeUrl(symbol: string): string {
  // `XYZUSDT` → `XYZ_USDT`. We assume USDT quote; if ever generalized, pass
  // the quote currency from config.
  if (symbol.endsWith('USDT')) {
    const base = symbol.slice(0, -4);
    return `https://www.binance.com/en/trade/${base}_USDT`;
  }
  return `https://www.binance.com/en/trade/${symbol}`;
}
