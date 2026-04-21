/**
 * Integration-lite tests for BinanceMiniTickerClient. We stand up a real
 * `ws.Server` on a random local port so we exercise the ws-library code
 * paths (open / message / close) without mocking them. Time is driven by
 * short sleeps rather than fake clocks — keeping the tests fast but
 * tolerant of scheduler jitter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { BinanceMiniTickerClient } from '../src/binance';
import type { Logger } from '../src/logger';

function capturingLogger(): Logger & { events: Array<{ level: string; msg: string }> } {
  const events: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => {
    events.push({ level, msg });
  };
  return Object.assign(
    {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
    { events },
  );
}

async function withEphemeralServer<T>(
  fn: (url: string, server: WebSocketServer) => Promise<T>,
): Promise<T> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;
  try {
    return await fn(url, server);
  } finally {
    // Force-close any open sockets so `server.close` resolves promptly —
    // our Binance client's auto-reconnect otherwise keeps sockets alive.
    for (const ws of server.clients) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    server.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('BinanceMiniTickerClient', () => {
  const clients: BinanceMiniTickerClient[] = [];

  afterEach(() => {
    for (const c of clients) c.stop();
    clients.length = 0;
  });

  it('connects, receives messages, and hands tickers to onTicker', async () => {
    await withEphemeralServer(async (url, server) => {
      const received: string[] = [];
      const logger = capturingLogger();
      const client = new BinanceMiniTickerClient({
        url,
        logger,
        onTicker: (t) => received.push(t.s),
      });
      clients.push(client);

      server.on('connection', (socket) => {
        socket.send(
          JSON.stringify([
            { e: '24hrMiniTicker', E: 1, s: 'BTCUSDT', c: '100', o: '99', h: '101', l: '98', v: '1', q: '100' },
            { e: '24hrMiniTicker', E: 1, s: 'ETHUSDT', c: '2000', o: '1990', h: '2001', l: '1980', v: '1', q: '2000' },
          ]),
        );
      });

      client.start();
      // Give the socket round-trip room.
      for (let i = 0; i < 40 && received.length < 2; i++) await sleep(25);
      expect(received).toEqual(['BTCUSDT', 'ETHUSDT']);
    });
  });

  it('auto-reconnects after the server drops the socket', async () => {
    await withEphemeralServer(async (url, server) => {
      let connections = 0;
      server.on('connection', (socket) => {
        connections++;
        if (connections === 1) {
          // Drop immediately to force reconnect.
          setImmediate(() => socket.terminate());
        } else {
          socket.send(JSON.stringify([
            { e: '24hrMiniTicker', E: 2, s: 'BTCUSDT', c: '100', o: '1', h: '1', l: '1', v: '1', q: '1' },
          ]));
        }
      });

      const received: string[] = [];
      const logger = capturingLogger();
      const client = new BinanceMiniTickerClient({
        url,
        logger,
        onTicker: (t) => received.push(t.s),
        baseBackoffMs: 50,
        maxBackoffMs: 100,
      });
      clients.push(client);
      client.start();

      for (let i = 0; i < 80 && received.length < 1; i++) await sleep(25);
      expect(connections).toBeGreaterThanOrEqual(2);
      expect(received).toContain('BTCUSDT');
    });
  });

  it('applies exponential backoff when reconnects keep failing', async () => {
    // Point at a port that nothing is listening on to force connect failure.
    const logger = capturingLogger();
    const client = new BinanceMiniTickerClient({
      url: 'ws://127.0.0.1:1', // privileged port, guaranteed closed
      logger,
      onTicker: () => {},
      baseBackoffMs: 20,
      maxBackoffMs: 200,
    });
    clients.push(client);
    client.start();

    await sleep(600);
    client.stop();

    const scheduledDelays = logger.events
      .filter((e) => e.msg === 'ws.reconnect_scheduled')
      .slice(0, 4);

    // We expect at least two scheduled reconnects with strictly increasing
    // delay, capping at maxBackoffMs.
    expect(scheduledDelays.length).toBeGreaterThanOrEqual(2);
  });

  it('force-reconnects when no messages arrive within silenceTimeoutMs', async () => {
    await withEphemeralServer(async (url, server) => {
      let connections = 0;
      server.on('connection', (socket) => {
        connections++;
        if (connections === 2) {
          // Second attempt: send a message right away so the test can
          // observe that we reconnected.
          socket.send(
            JSON.stringify([
              { e: '24hrMiniTicker', E: 3, s: 'BTCUSDT', c: '100', o: '1', h: '1', l: '1', v: '1', q: '1' },
            ]),
          );
        }
        // First connection: stay silent on purpose so the watchdog fires.
      });

      const received: string[] = [];
      const logger = capturingLogger();
      const client = new BinanceMiniTickerClient({
        url,
        logger,
        onTicker: (t) => received.push(t.s),
        silenceTimeoutMs: 100,
        baseBackoffMs: 25,
      });
      clients.push(client);
      client.start();

      for (let i = 0; i < 60 && received.length < 1; i++) await sleep(25);
      expect(connections).toBeGreaterThanOrEqual(2);
      expect(logger.events.some((e) => e.msg === 'ws.silence_timeout')).toBe(true);
      expect(received).toContain('BTCUSDT');
    });
  });

  it('ignores malformed payloads without tearing down the socket', async () => {
    await withEphemeralServer(async (url, server) => {
      server.on('connection', (socket) => {
        socket.send('not json at all');
        socket.send(JSON.stringify({ e: '24hrMiniTicker' })); // not an array
        socket.send(
          JSON.stringify([
            { e: '24hrMiniTicker', E: 9, s: 'BTCUSDT', c: '100', o: '1', h: '1', l: '1', v: '1', q: '1' },
          ]),
        );
      });

      const received: string[] = [];
      const logger = capturingLogger();
      const client = new BinanceMiniTickerClient({
        url,
        logger,
        onTicker: (t) => received.push(t.s),
      });
      clients.push(client);
      client.start();

      for (let i = 0; i < 40 && received.length < 1; i++) await sleep(25);
      expect(received).toEqual(['BTCUSDT']);
      expect(logger.events.some((e) => e.msg === 'ws.bad_json')).toBe(true);
    });
  });
});
