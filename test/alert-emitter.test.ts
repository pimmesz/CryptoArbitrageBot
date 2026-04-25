import { describe, expect, it, vi } from 'vitest';
import { createAlertEmitter } from '../src/alert-emitter';
import type { EscalationAlert, PumpAlert } from '../src/detector';
import type { Logger } from '../src/logger';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeAlert(over: Partial<PumpAlert> = {}): PumpAlert {
  return {
    kind: 'initial',
    symbol: 'BTCUSDT',
    fromPrice: 100,
    toPrice: 102,
    changePct: 2,
    elapsedMs: 50_000,
    ts: Date.UTC(2026, 3, 21, 12, 0, 0),
    ...over,
  };
}

function makeEscalationAlert(over: Partial<EscalationAlert> = {}): EscalationAlert {
  return {
    kind: 'escalation',
    symbol: 'BTCUSDT',
    fromPrice: 100,
    toPrice: 105,
    changePct: 5,
    tierPct: 5,
    elapsedMs: 90_000,
    ts: Date.UTC(2026, 3, 21, 12, 1, 30),
    ...over,
  };
}

function makeDeps(bloxMap: Record<string, string>) {
  const sendTelegram = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const appendAlertRecord = vi.fn<(line: string) => Promise<void>>().mockResolvedValue(undefined);
  const formatAlertMessage = vi.fn(
    (a: { kind: 'initial' | 'escalation'; symbol: string; tradeUrl: string; tierPct?: number }) =>
      a.kind === 'escalation'
        ? `escalation msg for ${a.symbol} tier=${a.tierPct} @ ${a.tradeUrl}`
        : `msg for ${a.symbol} @ ${a.tradeUrl}`,
  );
  const blox = {
    getTradeUrl: (t: string) => (bloxMap[t] ? `https://app.weareblox.com/markets/${t.toUpperCase()}` : null),
  };
  const onEmitted = vi.fn();
  const onSuppressed = vi.fn();
  return { sendTelegram, appendAlertRecord, formatAlertMessage, blox, onEmitted, onSuppressed };
}

describe('createAlertEmitter', () => {
  it('sends a Telegram message and writes JSONL when the coin is on Blox', () => {
    const deps = makeDeps({ BTC: 'bitcoin' });
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeAlert());

    expect(deps.sendTelegram).toHaveBeenCalledTimes(1);
    expect(deps.sendTelegram.mock.calls[0]![0]).toContain('https://app.weareblox.com/markets/BTC');
    expect(deps.appendAlertRecord).toHaveBeenCalledTimes(1);

    const line = deps.appendAlertRecord.mock.calls[0]![0];
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      event: 'pump_alert',
      symbol: 'BTCUSDT',
      base: 'BTC',
      onBlox: true,
      tradeUrl: 'https://app.weareblox.com/markets/BTC',
    });
    expect(deps.onEmitted).toHaveBeenCalledTimes(1);
    expect(deps.onSuppressed).not.toHaveBeenCalled();
  });

  it('still writes JSONL but does NOT call Telegram when the coin is not on Blox', () => {
    const deps = makeDeps({}); // empty → nothing is on Blox
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeAlert({ symbol: 'SHELLUSDT' }));

    expect(deps.sendTelegram).not.toHaveBeenCalled();
    expect(deps.appendAlertRecord).toHaveBeenCalledTimes(1);
    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record.onBlox).toBe(false);
    expect(record.tradeUrl).toBeUndefined();
    expect(record.base).toBe('SHELL');
    expect(deps.onSuppressed).toHaveBeenCalledTimes(1);
    expect(deps.onEmitted).not.toHaveBeenCalled();
  });

  it('strips the configured quoteCurrency to derive the base ticker', () => {
    const deps = makeDeps({ ETH: 'ethereum' });
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeAlert({ symbol: 'ETHUSDT' }));
    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record.base).toBe('ETH');
  });

  it('handles symbols that do not end in quoteCurrency by keeping the raw symbol as base', () => {
    const deps = makeDeps({});
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeAlert({ symbol: 'WEIRD' }));
    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record.base).toBe('WEIRD');
  });

  it('swallows Telegram send rejections rather than throwing', () => {
    const deps = makeDeps({ BTC: 'bitcoin' });
    deps.sendTelegram.mockRejectedValueOnce(new Error('boom'));

    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    // Must not throw.
    expect(() => emit(makeAlert())).not.toThrow();
  });

  it('swallows append failures rather than throwing', () => {
    const deps = makeDeps({ BTC: 'bitcoin' });
    deps.appendAlertRecord.mockRejectedValueOnce(new Error('disk full'));

    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    expect(() => emit(makeAlert())).not.toThrow();
  });

  it('writes kind=initial in the JSONL record for initial alerts', () => {
    const deps = makeDeps({ BTC: 'bitcoin' });
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeAlert());
    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record.kind).toBe('initial');
    // No tierPct on initial alerts.
    expect(record.tierPct).toBeUndefined();
  });

  it('routes escalation alerts through the escalation telegram format and JSONL kind', () => {
    const deps = makeDeps({ BTC: 'bitcoin' });
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeEscalationAlert({ tierPct: 10, changePct: 11.2, toPrice: 111.2 }));

    expect(deps.formatAlertMessage).toHaveBeenCalledTimes(1);
    const [arg] = deps.formatAlertMessage.mock.calls[0]!;
    expect(arg.kind).toBe('escalation');
    expect(arg.tierPct).toBe(10);

    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record).toMatchObject({
      kind: 'escalation',
      symbol: 'BTCUSDT',
      base: 'BTC',
      tierPct: 10,
      onBlox: true,
      tradeUrl: 'https://app.weareblox.com/markets/BTC',
    });

    expect(deps.sendTelegram).toHaveBeenCalledTimes(1);
    expect(deps.sendTelegram.mock.calls[0]![0]).toContain('escalation msg');
    expect(deps.onEmitted).toHaveBeenCalledTimes(1);
    expect(deps.onEmitted.mock.calls[0]![0]).toMatchObject({ kind: 'escalation' });
  });

  it('still suppresses Telegram when an escalation symbol is not on Blox', () => {
    const deps = makeDeps({}); // empty
    const emit = createAlertEmitter({
      ...deps,
      quoteCurrency: 'USDT',
      logger: silentLogger,
    });

    emit(makeEscalationAlert({ symbol: 'NOTREALUSDT' }));

    expect(deps.sendTelegram).not.toHaveBeenCalled();
    expect(deps.appendAlertRecord).toHaveBeenCalledTimes(1);
    const record = JSON.parse(deps.appendAlertRecord.mock.calls[0]![0]);
    expect(record.kind).toBe('escalation');
    expect(record.onBlox).toBe(false);
    expect(deps.onSuppressed).toHaveBeenCalledTimes(1);
    expect(deps.onSuppressed.mock.calls[0]![0]).toMatchObject({ kind: 'escalation' });
  });
});
